/**
 * Records RepoInfo + DiffResult (with stats) for the UI mock (T3.5 AC): bun run scripts/record-fixtures.ts
 * Output: src/test/recorded/<fixture>.{repoinfo,diffresult}.json — deterministic (fixed id/timestamps).
 *
 * T10.1 also records `<fixture>.v2.json` for the v2 fixtures: the tag list, the stash stack, every
 * revision expression `expected/rev-parse.txt` asks about, and a few range diffs (two-dot, three-dot,
 * a single commit, a stash). `workerClient.mock.ts` serves `resolveRevision` / `listTags` /
 * `listStashes` / range `computeDiff` straight out of it.
 *
 * T10.3 adds `conflicts`: the `ConflictPayload` of every file in the `conflict` layer, so the mock
 * can serve a real three-way card for `rebase-conflict`, `merge-conflict` and
 * `cherry-pick-conflict` without a repository on disk.
 *
 * T10.4 adds the `hidden` fixture with `hidden` (the whole Hidden group) and `explanations` (one
 * `PathExplanation` per interesting path), so T11.4 can build the popover against real data.
 *
 * T10.6 adds `pathHistories` and `blames` for the three `history` files the blame oracles cover, so
 * T11.6 can build the Blame and History card modes against real attributions.
 *
 * T10.7 adds `secrets`: every `SecretFinding` of the recorded working tree, so T11.9 can build the
 * banner and the popover against real (fake-credential) findings.
 *
 * T10.8 adds `searches`: the `worktree` and `pickaxe` answers for a few queries per fixture, keyed
 * by `searchKey`, so T11.8 can build the palette's result list against real hits. The commit scope
 * is not recorded — the mock runs it live against the recorded walk. `durationMs` is pinned to 0
 * so re-recording is byte-stable.
 * `bun run record` pins `TZ=UTC` (T10.9): `InsightsResult.activity` buckets at **local** midnight,
 * so without it the recording would differ between machines in different zones.
 *
 * T10.9 adds `insights`: the whole-history (`sinceMs` unset) pass, so T11.12 can build the Insights
 * mode against real activity, contributors and hotspots.
 *
 * T10.10 adds `summary`: the `RepoSummary` the multi-repo dashboard draws a card from, with
 * `indexMtimeMs` and the operation's `startedAt` pinned so re-recording is byte-stable. The patch text is not recorded — the
 * mock renders it with the engine's own writer off the recorded rows.
 *
 * T10.5 adds `walks` (the whole history per variant — default, first-parent, all, per path — which
 * the mock pages itself), `commits` (`CommitDetails`), `commitStats`, `branches` (the Branches
 * table with its cells filled), `aheadBehind` and `reachable`, plus the `octopus` fixture so the
 * lane column has a three-parent merge to draw.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { ConflictPayload } from "../src/engine/api";
import { defaultDiffSource } from "../src/engine/diffSource";
import { NodeDirHandle } from "../src/engine/fs/nodeDirHandle";
import { searchKey } from "../src/engine/search/query";
import { RepoSession } from "../src/engine/session";
import type {
  AheadBehind,
  BlamePayload,
  BranchRow,
  CommitDetails,
  CommitSummary,
  DiffResult,
  InsightsResult,
  Oid,
  PathExplanation,
  PathHistoryEntry,
  RangeSource,
  RepoOperation,
  RepoSummary,
  ResolvedRevision,
  SearchRequest,
  SearchResult,
  SecretFinding,
  WalkRequest,
} from "../src/engine/types";
import { fixturePath, HISTORY_FIXTURE, hasExpected, loadExpectedLines } from "../src/test/fixtures";

const OUT = new URL("../src/test/recorded/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const FIXED_COMPUTED_AT = 1704067200000; // 2024-01-01T00:00:00Z

/** Hotspot rows recorded per fixture (T10.9); the mock re-slices them to the caller's `limit`. */
const RECORDED_HOTSPOTS = 25;

/** Ranges worth having in the mock, by fixture. `from`/`to` are revision expressions. */
const RANGES: Record<string, { from: string; to: string; threeDot: boolean }[]> = {
  tags: [
    { from: "v0.1.0", to: "v1.0.0", threeDot: true },
    { from: "v0.1.0", to: "v1.0.0", threeDot: false },
  ],
  stash: [{ from: "HEAD", to: "stash@{0}", threeDot: false }],
  history: [
    { from: "main~5", to: "main", threeDot: true },
    { from: "main~1", to: "main", threeDot: false },
  ],
};

/** Paths worth an `explainPath` recording, by fixture (T10.4: one per reason, plus two shown ones). */
const EXPLAIN_PATHS: Record<string, string[]> = {
  hidden: [
    "dist",
    "dist/bundle.js",
    ".env.local",
    ".DS_Store",
    "src/skipped.txt",
    "src/assumed.txt",
    "big.txt",
    "src/app.txt",
    "README.md",
    "notes.txt",
  ],
};

/**
 * T10.5: the walks the mock replays. The key is derived from the request the same way
 * `workerClient.mock.ts` derives it, so the UI's own `WalkRequest` finds its recording. The limit
 * is deliberately huge — the whole history is recorded once and the mock pages it itself, so
 * T11.5 can scroll a real list without a repository on disk.
 */
const WALK_LIMIT = 5000;

function walkVariants(name: string): { key: string; req: WalkRequest }[] {
  const out: { key: string; req: WalkRequest }[] = [
    { key: "default", req: { from: ["HEAD"], firstParent: false, limit: WALK_LIMIT } },
    { key: "first-parent", req: { from: ["HEAD"], firstParent: true, limit: WALK_LIMIT } },
    { key: "all", req: { from: [], firstParent: false, all: true, limit: WALK_LIMIT } },
  ];
  if (name === HISTORY_FIXTURE.name) {
    for (const path of [HISTORY_FIXTURE.hotPath, HISTORY_FIXTURE.renamedTo]) {
      out.push({
        key: `path:${path}`,
        req: { from: ["HEAD"], firstParent: false, limit: WALK_LIMIT, path },
      });
    }
  }
  return out;
}

/**
 * T10.6: the paths whose file history and blame the mock serves. These are exactly the three files
 * `fixtures/history/expected/blame-src-*.txt` records `git blame --porcelain` for — a hot file, a
 * whitespace-only-touched file and one that was renamed.
 */
const BLAME_PATHS: Record<string, string[]> = {
  history: [HISTORY_FIXTURE.hotPath, HISTORY_FIXTURE.indentPath, HISTORY_FIXTURE.renamedTo],
};

/**
 * T10.8: the searches the mock replays. Only the two scopes that need a repository on disk; the
 * commit scope is matched live against the recorded walk.
 */
const SEARCHES: Record<string, SearchRequest[]> = {
  history: [
    { scope: "worktree", query: "guide note", limit: 200 },
    { scope: "worktree", query: "module", limit: 200 },
    { scope: "worktree", query: "hot", path: "src", limit: 200 },
    { scope: "pickaxe", query: "module", commits: 200, limit: 200 },
    { scope: "pickaxe", query: "hot-main", commits: 200, limit: 200 },
  ],
  secrets: [{ scope: "worktree", query: "aws", limit: 200 }],
};

/** Ahead/behind pairs worth recording, by fixture (the ones T10.0 recorded git's counts for). */
const AHEAD_BEHIND: Record<string, [string, string][]> = {
  history: [
    ["main", "topic"],
    ["main", "preflight/a"],
    ["preflight/a", "main"],
  ],
};

/** Replaces the operation's real mtime with the fixed clock so re-recording is a no-op. */
function pinStartedAt(op: RepoOperation | null): RepoOperation | null {
  return op && op.startedAt !== undefined ? { ...op, startedAt: FIXED_COMPUTED_AT } : op;
}

async function record(name: string, v2: boolean): Promise<void> {
  const session = await RepoSession.open(
    await NodeDirHandle.open(fixturePath(name)),
    { onProgress() {}, onStats() {}, onWarning() {} },
    { id: `recorded-${name}` },
  );
  const info = await session.info();
  info.operation = pinStartedAt(info.operation);
  const result = await session.computeDiff(defaultDiffSource(info));
  const stats = await session.fileStats(
    result.generation,
    result.files.map((f) => f.id),
  );
  let additions = 0;
  let deletions = 0;
  for (const f of result.files) {
    f.stats = stats[f.id] ?? null;
    additions += f.stats?.additions ?? 0;
    deletions += f.stats?.deletions ?? 0;
  }
  result.totals = { files: result.files.length, additions, deletions };
  result.computedAt = FIXED_COMPUTED_AT;
  result.durationMs = 0;
  writeFileSync(`${OUT}${name}.repoinfo.json`, `${JSON.stringify(info, null, 2)}\n`);
  writeFileSync(`${OUT}${name}.diffresult.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${name}: ${result.files.length} files, +${additions} -${deletions}`);

  if (v2) {
    // Recorded before any further computeDiff, while `result.generation` is still the current one.
    const conflicts: Record<string, ConflictPayload> = {};
    for (const f of result.files) {
      if (!f.layers.includes("conflict")) continue;
      conflicts[f.id] = await session.conflict(result.generation, f.id);
    }
    // T10.7: also before any further computeDiff — the scan takes the current generation.
    const secrets: SecretFinding[] = await session.scanSecrets(result.generation);
    const insights: InsightsResult = await session.insights({ limit: RECORDED_HOTSPOTS });
    const revisions: Record<string, ResolvedRevision> = {};
    for (const line of hasExpected(name, "rev-parse") ? loadExpectedLines(name, "rev-parse") : []) {
      const expr = line.split("\t")[0] as string;
      try {
        revisions[expr] = await session.resolveRevision(expr);
      } catch {
        // git recorded `<unresolved>` for this expression; the mock answers REV_NOT_FOUND too.
      }
    }
    const ranges: { source: RangeSource; result: DiffResult }[] = [];
    for (const spec of RANGES[name] ?? []) {
      const from = await session.resolveRevision(spec.from);
      const to = await session.resolveRevision(spec.to);
      if (to.oid === null) continue;
      const source: RangeSource = {
        kind: "range",
        from: from.display,
        to: to.display,
        fromRef: spec.from,
        toRef: spec.to,
        fromOid: from.oid,
        toOid: to.oid,
        threeDot: spec.threeDot,
        includeWorktree: false,
      };
      const r = await session.computeDiff(source);
      const s = await session.fileStats(
        r.generation,
        r.files.map((f) => f.id),
      );
      let a = 0;
      let d = 0;
      for (const f of r.files) {
        f.stats = s[f.id] ?? null;
        a += f.stats?.additions ?? 0;
        d += f.stats?.deletions ?? 0;
      }
      r.totals = { files: r.files.length, additions: a, deletions: d };
      r.computedAt = FIXED_COMPUTED_AT;
      r.durationMs = 0;
      ranges.push({ source, result: r });
    }
    const explanations: Record<string, PathExplanation> = {};
    for (const p of EXPLAIN_PATHS[name] ?? []) explanations[p] = await session.explainPath(p);

    // ---- T10.5: history pages, commit payloads and the Branches table ------------------------
    const walks: Record<
      string,
      { commits: CommitSummary[]; graphAvailable: boolean; laneOverflow: boolean }
    > = {};
    for (const variant of walkVariants(name)) {
      const page = await session.walkCommits(variant.req);
      walks[variant.key] = {
        commits: page.commits,
        graphAvailable: page.graphAvailable,
        laneOverflow: page.laneOverflow,
      };
    }
    const walkedOids = [
      ...new Set(Object.values(walks).flatMap((w) => w.commits.map((c) => c.oid))),
    ];
    const commits: Record<Oid, CommitDetails> = {};
    for (const oid of walkedOids.slice(0, 12)) commits[oid] = await session.commitDetails(oid);
    const commitStats = await session.commitStats(walkedOids);
    const branches: BranchRow[] = await session.branchOverview();
    const cells = await session.branchCells(branches.map((b) => b.ref.fullName));
    for (const row of branches) Object.assign(row, cells[row.ref.fullName] ?? {});
    const aheadBehind: Record<string, AheadBehind> = {};
    for (const [a, b] of AHEAD_BEHIND[name] ?? []) {
      aheadBehind[`${a}...${b}`] = await session.aheadBehind(a, b);
    }
    // ---- T10.6: file history and blame for the card's Blame / History modes -------------------
    const pathHistories: Record<string, PathHistoryEntry[]> = {};
    const blames: Record<string, BlamePayload> = {};
    for (const path of BLAME_PATHS[name] ?? []) {
      pathHistories[path] = (
        await session.pathHistory("HEAD", path, { follow: true, limit: WALK_LIMIT })
      ).entries;
      for (const ignoreWhitespace of [false, true]) {
        blames[ignoreWhitespace ? `w:${path}` : path] = await session.blame("HEAD", path, {
          ignoreWhitespace,
          includeWorktree: false,
          maxRevisions: 500,
        });
      }
    }

    // ---- T10.8: the two search scopes that need a repository on disk --------------------------
    const searches: Record<string, SearchResult> = {};
    for (const req of SEARCHES[name] ?? []) {
      searches[searchKey(req)] = { ...(await session.search(req)), durationMs: 0 };
    }

    const summary: RepoSummary = await session.summarise();

    const reachable = await session.markReachable([
      ...new Set([...walkedOids, ...(await session.reflog("HEAD", 200)).map((e) => e.newOid)]),
    ]);

    const payload = {
      tags: await session.listTags(),
      stashes: await session.listStashes(),
      // T10.2: the reflog panel and the operation banner replay these in the mock. `startedAt` is
      // the state file's mtime, so it is pinned here to keep the recording byte-stable.
      reflog: await session.reflog("HEAD", 200),
      operation: pinStartedAt(await session.operation()),
      // T10.3: the conflict card replays these; `generation` is rewritten by the mock on serve.
      conflicts,
      // T10.4: the Hidden group and the "why hidden" popover replay these.
      hidden: await session.listHidden(),
      explanations,
      revisions,
      ranges,
      // T10.5: the history list, the CommitCard payloads, the Branches table and reachability.
      walks,
      commits,
      commitStats,
      branches,
      aheadBehind,
      reachable,
      // T10.6: `git log --follow` per path and one blame per path and `-w` setting.
      pathHistories,
      blames,
      // T10.7: the secret scan of the recorded working tree.
      secrets,
      // T10.8: the recorded `worktree` / `pickaxe` answers, keyed by `searchKey`.
      searches,
      // T10.9: the whole-history insights pass. `limit` is generous so the mock can re-slice it;
      // `sinceMs` is left out because a wall-clock period would break `bun run record`'s
      // byte-idempotency (the result is otherwise a pure function of the repository).
      insights,
      // T10.10: the dashboard card. `indexMtimeMs` is the file's mtime, so it is pinned here.
      summary: { ...summary, operation: pinStartedAt(summary.operation), indexMtimeMs: 0 },
    };
    writeFileSync(`${OUT}${name}.v2.json`, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(
      `${name}: ${payload.tags.length} tags, ${payload.stashes.length} stashes, ` +
        `${payload.reflog.length} reflog entries, operation ${payload.operation?.kind ?? "none"}, ` +
        `${Object.keys(revisions).length} revisions, ${ranges.length} ranges, ` +
        `${Object.keys(conflicts).length} conflicts, ${payload.hidden.length} hidden, ` +
        `${Object.keys(explanations).length} explanations, ` +
        `${walks.all?.commits.length ?? 0} commits (graph ${walks.all?.graphAvailable ?? false}), ` +
        `${branches.length} branches, ${Object.keys(pathHistories).length} path histories, ` +
        `${Object.keys(blames).length} blames, ${secrets.length} secret findings, ` +
        `${Object.keys(searches).length} searches`,
      `insights: ${insights.commits} commits / ${insights.authors.length} authors / ` +
        `${insights.hotspots.length} hotspots / ${insights.activity.length} weeks, ` +
        `${Object.keys(searches).length} searches, ` +
        `summary ${summary.counts.staged}/${summary.counts.unstaged}/${summary.counts.untracked}` +
        `/${summary.counts.conflict}`,
    );
  }
  await session.close();
}

for (const name of ["basic", "worktree"]) await record(name, false);
// T10.2 adds the interrupted-operation fixtures so the mock can serve a real banner + reflog;
// T10.3 adds `cherry-pick-conflict` and the conflict payloads for all three.
for (const name of [
  "tags",
  "stash",
  "history",
  "rebase-conflict",
  "merge-conflict",
  "cherry-pick-conflict",
  // T10.4: the Hidden group, the rule attribution and the index flags.
  "hidden",
  // T10.5: the three-parent merge, so the lane column has an octopus to draw.
  "octopus",
  // T10.7: the planted fake credentials, for the secret banner and popover.
  "secrets",
])
  await record(name, true);
