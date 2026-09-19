import type { ConflictKind, FileStats } from "../../engine/api";
import { isWorktreeSource, sourceRefs } from "../../engine/diffSource";
import type {
  CommitSummary,
  FileDiff,
  HiddenEntry,
  Oid,
  RepoWarning,
  SecretFinding,
  SubmoduleInfo,
} from "../../engine/types";
import { labelOf } from "../compareSource";
import { matchesCommit } from "../history";
import {
  buildTree,
  type FileGroup,
  GROUP_ORDER,
  groupFiles,
  groupOf,
  makeFileFilter,
  makePathFilter,
  parseFilter,
  type SidebarGroupId,
  type TreeNode,
} from "../treeModel";
import { viewedKey } from "../viewedKey";
import { baseRefOf, cacheKey, findRef } from "./helpers";
import type { BlameTarget, FileDiffEntry, StoreState } from "./types";

/**
 * T11.6: what `blame` / `pathHistory` are asked at. With `at` set (the History-mode "Blame here"
 * action, or the popover's "Blame at parent") it is that commit and the working tree is out of the
 * picture; otherwise it is the compare side of the current source, which is also the side whose
 * text the card already shows.
 */
export function blameTarget(
  s: Pick<StoreState, "diffSource" | "repo">,
  at: Oid | null = null,
): BlameTarget | null {
  const { diffSource, repo } = s;
  if (at !== null) return { ref: at, oid: at, includeWorktree: false };
  if (!diffSource || !repo) return null;
  const includeWorktree = diffSource.includeWorktree && isWorktreeSource(diffSource, repo);
  if (diffSource.kind === "range") {
    return { ref: diffSource.toRef, oid: diffSource.toOid, includeWorktree };
  }
  const { sourceRef } = sourceRefs(diffSource);
  const oid = sourceRef === "HEAD" ? repo.headOid : (findRef(repo, sourceRef)?.oid ?? repo.headOid);
  // An unborn HEAD has no commit to blame or to key a cache entry by.
  return oid === null ? null : { ref: sourceRef, oid, includeWorktree };
}

/** The base branch, for the page header and the row menu's label. */
export function selectBranchBase(
  s: Pick<StoreState, "repo" | "compareBase">,
): { fullName: string; display: string } | null {
  const ref = baseRefOf(s);
  return ref ? { fullName: ref.fullName, display: ref.name } : null;
}

/**
 * The instant the period chips count back from (T11.12): the newest commit date the store already
 * knows — the tip of the commit list, or the newest branch tip the overview carries — and the wall
 * clock only when it knows none. The engine has no clock of its own (contracts `<!-- T10.9 -->`:
 * `activity` ends at the week of the newest commit), and the derived cache is keyed by tip oid and
 * period, so anchoring on a commit keeps `90 d` meaning the same window for as long as that key is
 * valid, and gives a repository whose last commit is a year old something to show.
 */
export function selectInsightsAnchor(
  s: Pick<StoreState, "history" | "branches">,
  now = Date.now(),
): number {
  let newest = 0;
  for (const c of s.history.commits) newest = Math.max(newest, c.author.timestamp);
  for (const r of s.branches.rows ?? []) newest = Math.max(newest, r.lastCommit?.timestamp ?? 0);
  return newest > 0 ? newest : now;
}

/**
 * T11.13: the pair the palette's `Preflight rebase of compare onto base` would ask about — the
 * compare side while it is a plain branch, and `selectBranchBase`'s base. Null when the compare
 * side is a range, a tag or a stash (there is no branch to rebase), or when the two are the same
 * branch. Both sides are the **display** names, because they are also what the engine puts into
 * `git rebase -i <onto>`: `refs/heads/main` there would be a command nobody types.
 */
export function selectPreflightPair(
  s: Pick<StoreState, "repo" | "compareBase" | "diffSource">,
): { branch: string; onto: string } | null {
  const base = selectBranchBase(s);
  const src = s.diffSource;
  if (base === null || src === null || src.kind !== "branches") return null;
  return src.source === base.display ? null : { branch: src.source, onto: base.display };
}

// ---- Selectors (memoised on input identity) ----

let visibleCache: { files: FileDiff[]; filter: string; result: FileDiff[] } | null = null;
export function selectVisibleFiles(s: Pick<StoreState, "diff" | "filter">): FileDiff[] {
  const files = s.diff?.files ?? [];
  if (visibleCache && visibleCache.files === files && visibleCache.filter === s.filter)
    return visibleCache.result;
  const match = makeFileFilter(s.filter);
  const result = s.filter.trim() === "" ? files : files.filter(match);
  visibleCache = { files, filter: s.filter, result };
  return result;
}

export function selectTotals(s: Pick<StoreState, "diff" | "stats">): {
  files: number;
  additions: number;
  deletions: number;
} {
  const files = s.diff?.files ?? [];
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    const st = s.stats[f.id] ?? f.stats;
    if (st) {
      additions += st.additions;
      deletions += st.deletions;
    }
  }
  return { files: files.length, additions, deletions };
}

/** Stats-row breakdowns (S1): per-status and per-layer counts over the given files. */
export interface Breakdown {
  status: { M: number; A: number; D: number; R: number; T: number };
  layers: { staged: number; unstaged: number; untracked: number; conflict: number };
}
export function breakdownOf(files: readonly FileDiff[]): Breakdown {
  const b: Breakdown = {
    status: { M: 0, A: 0, D: 0, R: 0, T: 0 },
    layers: { staged: 0, unstaged: 0, untracked: 0, conflict: 0 },
  };
  for (const f of files) {
    switch (f.status) {
      case "modified":
        b.status.M++;
        break;
      case "added":
        b.status.A++;
        break;
      case "deleted":
        b.status.D++;
        break;
      case "renamed":
      case "copied":
        b.status.R++;
        break;
      case "typechange":
        b.status.T++;
        break;
    }
    for (const l of f.layers) if (l !== "committed") b.layers[l]++;
  }
  return b;
}

/**
 * How far the streamed stats are (S2/S3/S8): `counted` files have stats, `pending` are still
 * streaming, `notCounted` splits the files that will never get a `+n −m`.
 */
export interface StatsProgress {
  total: number;
  counted: number;
  pending: number;
  notCounted: { tooLarge: number; binary: number; failed: number };
  complete: boolean;
}
export function statsProgressOf(
  files: readonly FileDiff[],
  stats: Record<string, FileStats>,
  failed: ReadonlySet<string>,
): StatsProgress {
  const p: StatsProgress = {
    total: files.length,
    counted: 0,
    pending: 0,
    notCounted: { tooLarge: 0, binary: 0, failed: 0 },
    complete: true,
  };
  for (const f of files) {
    if (failed.has(f.id)) p.notCounted.failed++;
    else if (f.binary) p.notCounted.binary++;
    else if (f.tooLarge) p.notCounted.tooLarge++;
    else {
      const st = stats[f.id] ?? f.stats;
      if (st) p.counted++;
      else {
        p.pending++;
        p.complete = false;
      }
    }
  }
  return p;
}

/** Files whose per-file diff request failed (the red "retry" mark in S3). */
export function selectFailedFiles(
  s: Pick<StoreState, "diff" | "fileDiffs" | "prefs">,
): Set<string> {
  const out = new Set<string>();
  for (const f of s.diff?.files ?? []) {
    if (s.fileDiffs.peek(cacheKey(f.id, s.prefs.ignoreWhitespace))?.status === "error")
      out.add(f.id);
  }
  return out;
}

export function isViewed(
  s: Pick<StoreState, "diff" | "viewed" | "repoId">,
  file: FileDiff,
): boolean {
  if (!s.diff) return false;
  return s.viewed.has(viewedKey(s.repoId ?? "", s.diff.source, file));
}

export function selectViewedCount(s: Pick<StoreState, "diff" | "viewed" | "repoId">): number {
  if (!s.diff) return 0;
  let n = 0;
  for (const f of s.diff.files) if (isViewed(s, f)) n++;
  return n;
}

export function selectCanIncludeWorktree(s: Pick<StoreState, "diffSource" | "repo">): boolean {
  return !!s.diffSource && !!s.repo && isWorktreeSource(s.diffSource, s.repo);
}

/**
 * What is being compared, in one string: `v2.3.0 … stash@{0}` (three-dot) or `main .. feature`
 * (two-dot). The StatsRow prints it for a range — a branch pair is already spelled out by the two
 * pickers, and Design §14 rule 1 keeps the bars looking like v1 while nothing unusual is going on.
 */
export function selectSourceLabel(s: Pick<StoreState, "diffSource">): string {
  return s.diffSource ? labelOf(s.diffSource) : "";
}

let treeCache: { files: FileDiff[]; result: TreeNode[] } | null = null;
export function selectTreeModel(s: Pick<StoreState, "diff" | "filter">): TreeNode[] {
  const files = selectVisibleFiles(s);
  if (treeCache && treeCache.files === files) return treeCache.result;
  const result = buildTree(files);
  treeCache = { files, result };
  return result;
}

const NO_FILES: readonly FileDiff[] = [];

/** D2: grouping is possible only when some file touches a layer other than `committed`. */
export function selectHasLayers(s: Pick<StoreState, "diff">): boolean {
  for (const f of s.diff?.files ?? NO_FILES) {
    if (f.layers.some((l) => l !== "committed")) return true;
  }
  return false;
}

let groupedCache: { files: FileDiff[]; result: FileGroup[] } | null = null;
export function selectGroupedModel(s: Pick<StoreState, "diff" | "filter">): FileGroup[] {
  const files = selectVisibleFiles(s);
  if (groupedCache && groupedCache.files === files) return groupedCache.result;
  const result = groupFiles(files);
  groupedCache = { files, result };
  return result;
}

/** D5: counts over the *unfiltered* diff, so a header can read `k of n` while filtering. */
let groupTotalsCache: {
  files: readonly FileDiff[];
  result: Record<SidebarGroupId, number>;
} | null = null;
export function selectGroupTotals(s: Pick<StoreState, "diff">): Record<SidebarGroupId, number> {
  const files = s.diff?.files ?? NO_FILES;
  if (groupTotalsCache && groupTotalsCache.files === files) return groupTotalsCache.result;
  const result = Object.fromEntries(GROUP_ORDER.map((id) => [id, 0])) as Record<
    SidebarGroupId,
    number
  >;
  for (const f of files) result[groupOf(f)]++;
  groupTotalsCache = { files, result };
  return result;
}

/**
 * T11.4: the rows of the Hidden group, or null while the group is not up (toggle off, or the
 * listing walk has not answered yet). The path part of the file filter applies, so filtering
 * narrows the Hidden group the same way it narrows the layer groups; the `status:` / `layer:`
 * tokens do not, because a hidden path has neither.
 */
let hiddenCache: { entries: HiddenEntry[]; path: string; result: HiddenEntry[] } | null = null;
export function selectHiddenEntries(
  s: Pick<StoreState, "hidden" | "prefs" | "filter">,
): HiddenEntry[] | null {
  if (!s.prefs.showHidden || s.hidden === null) return null;
  const path = parseFilter(s.filter).path;
  if (hiddenCache && hiddenCache.entries === s.hidden && hiddenCache.path === path)
    return hiddenCache.result;
  const match = makePathFilter(path);
  const result = path === "" ? s.hidden : s.hidden.filter((e) => match(e.path));
  hiddenCache = { entries: s.hidden, path, result };
  return result;
}

export function selectFileDiff(
  s: Pick<StoreState, "fileDiffs" | "prefs">,
  id: string,
): FileDiffEntry | undefined {
  return s.fileDiffs.peek(cacheKey(id, s.prefs.ignoreWhitespace));
}

/**
 * T11.16: what `listSubmodules()` says about one gitlink path, or undefined while the list is not
 * in yet (or when this path is a gitlink the superproject's HEAD does not record — a submodule
 * added in the working tree, which `git submodule status` does not list either).
 */
export function selectSubmodule(
  s: Pick<StoreState, "submodules">,
  path: string,
): SubmoduleInfo | undefined {
  return s.submodules?.find((m) => m.path === path);
}

/** T11.3: the kind of a conflicted file once its payload is in, so `layerCode` can print git's XY. */
export function selectConflictKind(
  s: Pick<StoreState, "conflicts">,
  id: string,
): ConflictKind | undefined {
  const entry = s.conflicts[id];
  return entry?.status === "ready" ? entry.data.kind : undefined;
}

/**
 * T11.5: the commit rows the History list shows — everything walked so far, narrowed by the search
 * box (subject, author, email, oid prefix or a ref name). Memoised on the list and the query, like
 * `selectVisibleFiles`, so scrolling never re-filters.
 */
let historyCache: { commits: CommitSummary[]; query: string; result: CommitSummary[] } | null =
  null;
export function selectHistoryRows(s: Pick<StoreState, "history">): CommitSummary[] {
  const { commits, query } = s.history;
  if (historyCache && historyCache.commits === commits && historyCache.query === query)
    return historyCache.result;
  const result = query.trim() === "" ? commits : commits.filter((c) => matchesCommit(c, query));
  historyCache = { commits, query, result };
  return result;
}

/** File id → conflict kind for every payload that has arrived (shallow-compared by the sidebar). */
export function selectConflictKinds(
  s: Pick<StoreState, "conflicts">,
): Record<string, ConflictKind> {
  const out: Record<string, ConflictKind> = {};
  for (const [id, entry] of Object.entries(s.conflicts))
    if (entry.status === "ready") out[id] = entry.data.kind;
  return out;
}

// ---- Secret scan selectors (T11.9, Design §14.3) ----

const NO_SECRETS: readonly SecretFinding[] = [];

/** Findings of the current diff, in the engine's order; empty while nothing has been scanned. */
export function selectSecrets(s: Pick<StoreState, "secrets">): readonly SecretFinding[] {
  return s.secrets ?? NO_SECRETS;
}

/** File id → number of findings in it, for the sidebar's `secret` chip (shallow-compared). */
let secretCountCache: {
  findings: readonly SecretFinding[];
  result: Record<string, number>;
} | null = null;
export function selectSecretCounts(s: Pick<StoreState, "secrets">): Record<string, number> {
  const findings = selectSecrets(s);
  if (secretCountCache && secretCountCache.findings === findings) return secretCountCache.result;
  const result: Record<string, number> = {};
  for (const f of findings) result[f.fileId] = (result[f.fileId] ?? 0) + 1;
  secretCountCache = { findings, result };
  return result;
}

/** Findings of one file card, memoised on the list so a re-render never re-filters. */
let secretByFileCache: {
  findings: readonly SecretFinding[];
  result: Map<string, SecretFinding[]>;
} | null = null;
export function selectFileSecrets(
  s: Pick<StoreState, "secrets">,
  id: string,
): readonly SecretFinding[] {
  const findings = selectSecrets(s);
  if (!secretByFileCache || secretByFileCache.findings !== findings) {
    const result = new Map<string, SecretFinding[]>();
    for (const f of findings) {
      const bucket = result.get(f.fileId);
      if (bucket) bucket.push(f);
      else result.set(f.fileId, [f]);
    }
    secretByFileCache = { findings, result };
  }
  return secretByFileCache.result.get(id) ?? NO_SECRETS;
}

/**
 * The gate T11.10's export flow asks before it writes anything ("there are N secrets in this diff
 * — export anyway?"). `total` is `SECRETS_FOUND.detail`, which counts past the 500-finding cap, so
 * the dialog can say how many exist and how many it can list. `scanned` is false while the current
 * diff has not been scanned at all, which an export must treat as "unknown", not as "clean".
 */
export interface SecretGate {
  scanned: boolean;
  findings: readonly SecretFinding[];
  /** Findings listed (capped at `SECRET_FINDING_CAP`). */
  count: number;
  /** Findings the engine actually saw; equals `count` unless the list was cut. */
  total: number;
}
let gateCache: {
  secrets: SecretFinding[] | null;
  warnings: RepoWarning[];
  result: SecretGate;
} | null = null;
export function selectSecretGate(s: Pick<StoreState, "secrets" | "warnings">): SecretGate {
  // Memoised on identity like `selectVisibleFiles`: the banner subscribes to it, and a fresh
  // object every render is an infinite `useSyncExternalStore` loop.
  if (gateCache && gateCache.secrets === s.secrets && gateCache.warnings === s.warnings)
    return gateCache.result;
  const findings = selectSecrets(s);
  const detail = s.warnings.find((w) => w.code === "SECRETS_FOUND")?.detail;
  const reported = detail === undefined ? Number.NaN : Number.parseInt(detail, 10);
  const result: SecretGate = {
    scanned: s.secrets !== null,
    findings,
    count: findings.length,
    total: Number.isFinite(reported) ? Math.max(reported, findings.length) : findings.length,
  };
  gateCache = { secrets: s.secrets, warnings: s.warnings, result };
  return result;
}
