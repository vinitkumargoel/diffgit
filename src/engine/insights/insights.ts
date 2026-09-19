/**
 * Repository insights (T10.9, atlas tab 13; Design §14): activity, contributors, hotspots.
 *
 * One first-parent walk from `HEAD` does all three. Per commit the only object work is a
 * **path-level** tree diff against the first parent — no blob reads — which is what makes a
 * whole-history pass affordable (atlas tab 13, "How it works offline"). Blobs are read once at the
 * end, for the current size of the paths that are candidates for the hotspot ranking.
 *
 * What the numbers mean, exactly (and what `scripts/fixture-expectations.sh` records as the
 * oracle for each one):
 *
 * | field      | definition                                                        | oracle |
 * |------------|-------------------------------------------------------------------|--------|
 * | `walked`   | first-parent commits visited, before `sinceMs`                     | `git rev-list --count --first-parent HEAD` |
 * | `commits`  | of those, the ones with `author date >= sinceMs`                   | same, `--since` applied by the test |
 * | `authors`  | per author **name** after `.mailmap`, bots excluded                | `git log --first-parent --format='%aN <%aE>'` |
 * | `bots`     | in-window commits whose author is a bot (`isBotIdentity`)          | the same list, filtered |
 * | `hotspots` | per-path commit counts × `log2` of the blob size at the walk tip   | `git log --first-parent --no-renames --name-only` |
 * | `activity` | commits per local day, bucketed into weeks                        | `git log --first-parent --date=format-local:%Y-%m-%d` |
 *
 * Deliberate choices, all of them deviations worth knowing about:
 *
 * - **Author date** throughout — the brief fixes it for `activity`, and using the same clock for
 *   the `sinceMs` filter is what makes `activity` sum to `commits`. (In the `history` fixture the
 *   two dates are equal anyway.)
 * - **Merges count.** A first-parent walk shows a merge commit, and its first-parent tree diff is
 *   everything the merge brought in — exactly what `git log --first-parent --name-only` prints.
 * - **No rename detection** in the per-commit diff: pairing a rename costs blob reads per commit,
 *   which is the one cost this walk exists to avoid. A `git mv` therefore counts against both
 *   names, as `git log --no-renames --name-only` reports it.
 * - **The activity window ends at the newest commit in range**, not at the wall clock. The engine
 *   has no clock input here (`InsightsRequest` carries only `sinceMs` and `limit`), and a result
 *   that depends on `Date.now()` could not be asserted against git. A repository that has been
 *   idle for two years shows its last 52 active weeks instead of 52 empty ones.
 * - **Manifests are ranked separately**, not dropped: they are returned with `manifest: true` after
 *   the real hotspots, so the UI can grey them out (atlas tab 13 shows exactly that).
 */
import { treeDiff } from "../diff/treeDiff";
import { EngineError } from "../errors";
import type { Mailmap } from "../git/mailmap";
import type { FlatTree, ObjectDb } from "../git/objectDb";
import { type CommitReader, MAX_WALK, type WalkState, walkCommits } from "../git/walk";
import {
  type CommitSummary,
  type InsightsRequest,
  type InsightsResult,
  MODE_GITLINK,
  type Oid,
  type RepoWarning,
} from "../types";
import { throwIfAborted } from "../util/concurrency";

/** First-parent commits an insights pass will look at (`INSIGHTS_CAPPED` beyond it, atlas tab 13). */
export const INSIGHTS_WALK_CAP = MAX_WALK;

/** How many commits `walkCommits` hands over per page; the walk itself is resumed, not restarted. */
export const INSIGHTS_PAGE = 500;

/** Commits processed between two `{ phase: "insights" }` progress messages (T10.5b S5's rule). */
export const INSIGHTS_PROGRESS_EVERY = 500;

/** Weeks of `activity`, ending with the week of the newest commit in range (GitHub's strip). */
export const ACTIVITY_WEEKS = 52;

/** Days per `activity` row; index 0 is the local Sunday named by `weekStart`. */
export const ACTIVITY_DAYS = 7;

/** Blobs read for `hotspots.size`; beyond it a path keeps `size: 0` (and so `score === commits`). */
export const HOTSPOT_SIZE_READS = 2000;

/** Largest `InsightsRequest.limit` worth serving; the UI shows a handful of rows. */
export const HOTSPOT_LIMIT_MAX = 1000;

/**
 * Manifests and lockfiles: they change on every dependency bump and would own every ranking, so
 * they get their own list (atlas tab 13: "Grey: manifests and lockfiles, excluded from the ranking
 * by default"). Matched on the **basename**, so `frontend/package.json` counts too.
 */
export const MANIFEST_FILES: readonly string[] = [
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "cargo.toml",
  "composer.json",
  "composer.lock",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "gradle.lockfile",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "packages.lock.json",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "podfile.lock",
  "poetry.lock",
  "pom.xml",
  "pubspec.lock",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "yarn.lock",
];
const MANIFEST_SET = new Set(MANIFEST_FILES);

/** True for `package.json`, `go.sum`, `Cargo.lock`, … — case-insensitive, basename only. */
export function isManifestPath(path: string): boolean {
  const slash = path.lastIndexOf("/");
  return MANIFEST_SET.has(path.slice(slash + 1).toLowerCase());
}

/**
 * The two shapes the brief names: a trailing `[bot]` (GitHub's own convention —
 * `renovate[bot]`, `github-actions[bot]`) and a leading `dependabot` / `renovate`. Both are tested
 * against the author **name** and against the local part of the author **email**, because a bot is
 * spelled one way in one and another way in the other.
 *
 * The brief writes the second rule as `/^dependabot|renovate/i`, which in JavaScript means
 * "starts with dependabot, or contains renovate anywhere" — that would flag a person called
 * *Renata Renovate-Smith*. The alternation is anchored here, which is plainly what was meant.
 */
export const BOT_SUFFIX_RE = /\[bot\]$/i;
export const BOT_PREFIX_RE = /^(?:dependabot|renovate)/i;

/** True when this identity is a bot: counted in `InsightsResult.bots`, kept out of `authors`. */
export function isBotIdentity(name: string, email: string): boolean {
  const at = email.indexOf("@");
  const local = at < 0 ? email : email.slice(0, at);
  return (
    BOT_SUFFIX_RE.test(name) ||
    BOT_PREFIX_RE.test(name) ||
    BOT_SUFFIX_RE.test(local) ||
    BOT_PREFIX_RE.test(local)
  );
}

/**
 * `commits × log2(size)` — the atlas's "commits touching the file × current size". `size` is
 * floored at 2 so that a one-byte file (and a path that no longer exists at the tip, `size: 0`)
 * scores its commit count rather than zero or `-Infinity`. Rounded to three decimals so the number
 * is stable across engines and byte-identical in `bun run record`.
 */
export function hotspotScore(commits: number, size: number): number {
  return Math.round(commits * Math.log2(Math.max(size, 2)) * 1000) / 1000;
}

/** Local midnight of the day `ms` falls in (the bucket boundary the brief asks for). */
export function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `n` days after a local midnight, still a local midnight (DST-safe: `Date` does the arithmetic). */
export function addDays(midnightMs: number, n: number): number {
  const d = new Date(midnightMs);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight of the Sunday on or before `ms` — `activity[i].weekStart`. */
export function weekStartOf(ms: number): number {
  const d = new Date(localMidnight(ms));
  return addDays(d.getTime(), -d.getDay());
}

/**
 * Per-day counts → at most `ACTIVITY_WEEKS` rows of seven, oldest week first, ending with the week
 * of the newest counted day. Days with no commits are zeros, so every row has seven entries and
 * the UI can index it directly.
 */
export function buildActivity(dayCounts: ReadonlyMap<number, number>): InsightsResult["activity"] {
  if (dayCounts.size === 0) return [];
  let newest = Number.NEGATIVE_INFINITY;
  let oldest = Number.POSITIVE_INFINITY;
  for (const day of dayCounts.keys()) {
    if (day > newest) newest = day;
    if (day < oldest) oldest = day;
  }
  const firstWeek = weekStartOf(oldest);
  const weeks: number[] = [];
  let week = weekStartOf(newest);
  while (weeks.length < ACTIVITY_WEEKS) {
    weeks.unshift(week);
    if (week <= firstWeek) break;
    week = addDays(week, -ACTIVITY_DAYS);
  }
  return weeks.map((weekStart) => {
    const days: number[] = [];
    for (let i = 0; i < ACTIVITY_DAYS; i++) days.push(dayCounts.get(addDays(weekStart, i)) ?? 0);
    return { weekStart, days };
  });
}

/** One mapped identity and how many in-window commits it authored. */
export interface AuthorTally {
  name: string;
  email: string;
  commits: number;
  bot: boolean;
}

/** What `RepoSession.insights` needs; `signal` is `single()`'s, checked in every loop. */
export interface InsightsDeps {
  db: ObjectDb;
  reader: CommitReader;
  /** The repository's `.mailmap`, already read and parsed (`Mailmap.empty()` when there is none). */
  mailmap: Mailmap;
  /** oid → ref labels; `walkCommits` needs it and insights ignores what it produces. */
  refsByCommit: Map<Oid, string[]>;
  signal?: AbortSignal;
  /** Called with the running count of commits walked, so a 50,000-commit pass is not silent. */
  onProgress?: (walked: number) => void;
}

/**
 * `InsightsResult` plus the intermediate tallies, which is what the parity tests assert against
 * git: the contract only carries author *names*, but `git shortlog -sne` and `git log '%aN <%aE>'`
 * are keyed by name **and** email, and the per-path counts are compared before the hotspot ranking
 * turns them into scores.
 */
export interface InsightsDetail {
  result: InsightsResult;
  /** Every mapped identity, bots included, sorted by commits desc then name then email. */
  identities: AuthorTally[];
  /** Commits that touched each path, in the window; the pre-ranking hotspot input. */
  pathCommits: Record<string, number>;
  /** Local-midnight day → commits, the pre-bucketing `activity` input. */
  dayCounts: Record<number, number>;
  warnings: RepoWarning[];
}

/** `INSIGHTS_CAPPED`, emitted once when the walk stopped at `INSIGHTS_WALK_CAP`. */
export function insightsCappedWarning(walked: number): RepoWarning {
  return {
    code: "INSIGHTS_CAPPED",
    message: `Insights cover the newest ${walked.toLocaleString("en-US")} commits of this branch.`,
    detail: `the first-parent walk stopped at the ${INSIGHTS_WALK_CAP.toLocaleString("en-US")}-commit cap`,
  };
}

function checkedLimit(limit: number): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
    throw new EngineError("INTERNAL", "insights: limit must be a positive integer.", {
      detail: String(limit),
    });
  return Math.min(limit, HOTSPOT_LIMIT_MAX);
}

/**
 * The whole pass. `seeds` is the already-resolved tip (the session resolves `HEAD`); an empty
 * `seeds` — an unborn branch — answers an empty result rather than failing.
 */
export async function computeInsights(
  deps: InsightsDeps,
  seeds: Oid[],
  req: InsightsRequest,
): Promise<InsightsDetail> {
  const limit = checkedLimit(req.limit);
  const since = req.sinceMs;
  const warnings: RepoWarning[] = [];

  const identities = new Map<string, AuthorTally>();
  const pathCommits = new Map<string, number>();
  const dayCounts = new Map<number, number>();
  let walked = 0;
  let inWindow = 0;
  let bots = 0;
  let capped = false;
  let tip: Oid | null = null;

  if (seeds.length > 0) {
    let state: WalkState | null = null;
    do {
      throwIfAborted(deps.signal, "insights");
      const out = await walkCommits(
        {
          db: deps.db,
          reader: deps.reader,
          refsByCommit: deps.refsByCommit,
          ...(deps.signal ? { signal: deps.signal } : {}),
        },
        { from: [], firstParent: true, limit: INSIGHTS_PAGE },
        seeds,
        state,
      );
      warnings.push(...out.warnings);
      capped = capped || out.page.capped;
      for (const commit of out.page.commits) {
        throwIfAborted(deps.signal, "insights");
        tip ??= commit.oid;
        walked++;
        if (walked % INSIGHTS_PROGRESS_EVERY === 0) deps.onProgress?.(walked);
        const when = commit.author.timestamp;
        if (since !== undefined && when < since) continue;
        inWindow++;
        tallyAuthor(identities, deps.mailmap, commit);
        const day = localMidnight(when);
        dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
        await tallyPaths(deps, commit, pathCommits);
      }
      state = out.state;
    } while (state !== null);
  }

  for (const tally of identities.values()) if (tally.bot) bots += tally.commits;
  if (capped) warnings.push(insightsCappedWarning(walked));

  const headTree = tip === null ? null : await deps.db.flattenTree(tip);
  const hotspots = await rankHotspots(deps, pathCommits, headTree, limit);

  return {
    result: {
      commits: inWindow,
      authors: foldAuthors(identities),
      hotspots,
      activity: buildActivity(dayCounts),
      walked,
      capped,
      bots,
    },
    identities: [...identities.values()].sort(
      (a, b) =>
        b.commits - a.commits || a.name.localeCompare(b.name) || a.email.localeCompare(b.email),
    ),
    pathCommits: Object.fromEntries(
      [...pathCommits.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    dayCounts: Object.fromEntries([...dayCounts.entries()].sort(([a], [b]) => a - b)),
    warnings,
  };
}

function tallyAuthor(
  into: Map<string, AuthorTally>,
  mailmap: Mailmap,
  commit: CommitSummary,
): void {
  const mapped = mailmap.map(commit.author.name, commit.author.email);
  const key = `${mapped.name}\u0000${mapped.email}`;
  const existing = into.get(key);
  if (existing) existing.commits++;
  else
    into.set(key, {
      name: mapped.name,
      email: mapped.email,
      commits: 1,
      bot: isBotIdentity(mapped.name, mapped.email),
    });
}

/**
 * `git shortlog -sn` groups by author name, and so does the contract (`authors[].name`). Bots are
 * left out entirely; `InsightsResult.bots` carries their commits instead. Ties break on the name so
 * the list is stable.
 */
function foldAuthors(identities: ReadonlyMap<string, AuthorTally>): InsightsResult["authors"] {
  const byName = new Map<string, number>();
  for (const tally of identities.values()) {
    if (tally.bot) continue;
    byName.set(tally.name, (byName.get(tally.name) ?? 0) + tally.commits);
  }
  return [...byName.entries()]
    .map(([name, commits]) => ({ name, commits }))
    .sort((a, b) => b.commits - a.commits || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Path-level tree diff against the first parent; a root commit diffs against the empty tree. */
async function tallyPaths(
  deps: InsightsDeps,
  commit: CommitSummary,
  into: Map<string, number>,
): Promise<void> {
  const parent = commit.parents[0];
  const before: FlatTree | null = parent === undefined ? null : await deps.db.flattenTree(parent);
  const after = await deps.db.flattenTree(commit.oid);
  for (const path of Object.keys(treeDiff(before, after))) {
    into.set(path, (into.get(path) ?? 0) + 1);
  }
}

/**
 * Top `limit` by score among the real files, then top `limit` among the manifests, each ordered by
 * score desc and path asc. Sizes are read only for the paths that can still make either list
 * (`HOTSPOT_SIZE_READS` blobs at most, in commit-count order), because `score` needs the current
 * size and nothing else in this module reads a blob.
 */
async function rankHotspots(
  deps: InsightsDeps,
  pathCommits: ReadonlyMap<string, number>,
  headTree: FlatTree | null,
  limit: number,
): Promise<InsightsResult["hotspots"]> {
  const byCount = [...pathCommits.entries()].sort(
    ([pa, ca], [pb, cb]) => cb - ca || (pa < pb ? -1 : pa > pb ? 1 : 0),
  );
  const sizes = new Map<string, number>();
  let reads = 0;
  for (const [path] of byCount) {
    throwIfAborted(deps.signal, "insights");
    const entry = headTree?.[path];
    if (entry === undefined || entry.mode === MODE_GITLINK) continue;
    if (reads >= HOTSPOT_SIZE_READS) break;
    reads++;
    try {
      sizes.set(path, (await deps.db.readBlob(entry.oid)).byteLength);
    } catch {
      // A blob the pack cannot produce is a missing size, not a failed insights pass: the path
      // keeps `size: 0` and ranks on its commit count alone.
    }
  }

  const rows = byCount.map(([path, commits]) => {
    const size = sizes.get(path) ?? 0;
    return {
      path,
      commits,
      size,
      score: hotspotScore(commits, size),
      manifest: isManifestPath(path),
    };
  });
  const rank = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return [
    ...rows
      .filter((r) => !r.manifest)
      .sort(rank)
      .slice(0, limit),
    ...rows
      .filter((r) => r.manifest)
      .sort(rank)
      .slice(0, limit),
  ];
}
