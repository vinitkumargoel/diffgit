/**
 * Shared domain model (Plan §4, verbatim, extended by the review-round-1 amendments noted inline).
 * Later tasks extend this file; they never fork it. Everything here must be structured-cloneable.
 */

import type { WarningCode } from "./errors";

export type Oid = string; // 40-hex SHA-1
export type RepoId = string; // uuid stored with the handle in IndexedDB

export interface RepoRef {
  name: string; // "main", "origin/main"
  fullName: string; // "refs/heads/main", "refs/remotes/origin/main", or "HEAD" for the synthetic entry
  kind: "local" | "remote";
  oid: Oid;
  isDefault: boolean; // resolved per D8
  isCheckedOut: boolean; // == HEAD's branch
  synthetic?: boolean; // amendment (T1.4): `HEAD (detached @ sha)` / `HEAD (no commits)` entry
}

export interface RepoWarning {
  code: WarningCode;
  message: string;
  detail?: string;
}

export interface RepoCapabilities {
  indexVersion: 2 | 3 | 4;
  hasSplitIndex: boolean;
  hasSparseIndex: boolean;
  isWorktreeGitdir: boolean;
  hasReftable: boolean;
}

export interface RepoInfo {
  id: RepoId;
  name: string; // folder name
  headBranch: string | null; // null when detached
  headOid: Oid | null; // null for unborn repo
  detached: boolean; // amendment (T1.4): HEAD is a bare oid
  unborn: boolean; // amendment (T1.4): HEAD points at a branch with no commits
  headDisplay: string; // amendment (T1.4): "main" | "HEAD (detached @ ab12cd3)" | "HEAD (no commits)"
  refs: RepoRef[];
  defaultRef: RepoRef | null;
  capabilities: RepoCapabilities;
  warnings: RepoWarning[]; // non-fatal: e.g. "sparse index: untracked detection disabled"
  /** T10.2: what git is in the middle of (Design §14.3 banner); refreshed by `reloadRefs()`. */
  operation: RepoOperation | null;
  /** T10.2: a colocated jj repository (`.jj/` beside `.git/`). */
  jj: boolean;
  /** T10.2: `.git/objects/info/commit-graph` or a `commit-graphs/commit-graph-chain` exists. */
  hasCommitGraph: boolean;
}

/**
 * Snapshot of HEAD + branches produced by RefStore (T1.4). Shared here because
 * `diffSource.ts` (engine + UI store) needs it.
 */
export interface RefSnapshot {
  headBranch: string | null;
  headOid: Oid | null;
  detached: boolean;
  unborn: boolean;
  headDisplay: string; // "main" | "HEAD (detached @ ab12cd3)" | "HEAD (no commits)"
  refs: RepoRef[];
  defaultRef: RepoRef | null;
}

// What are we comparing? A union (docs/v2-contracts.md): branches (v1) or an arbitrary range (T10.1).
// Amendment: carries full ref names ("refs/heads/x", "refs/remotes/o/x" or the literal "HEAD").
export interface BranchesSource {
  kind: "branches";
  source: string; // display name, e.g. "feature" or "origin/main"
  target: string;
  sourceRef: string; // full ref name or "HEAD"
  targetRef: string;
  includeWorktree: boolean;
}

/**
 * Any two points in the repository (T10.1): tags, stashes, SHAs, `HEAD~3`, the empty tree.
 * `from` is the base (old side), `to` is the compare side (new side) — the same orientation as
 * `target`/`source` on `BranchesSource`. The UI resolves both sides with `resolveRevision` before
 * calling `computeDiff`, so the engine never has to re-parse the expression.
 */
export interface RangeSource {
  kind: "range";
  from: string; // display names ("v2.3.0", "stash@{0}", "a1b2c3d", "main")
  to: string;
  fromRef: string; // resolvable expressions (see resolveRevision)
  toRef: string;
  fromOid: Oid | null; // null = the empty tree (EMPTY_TREE_OID)
  toOid: Oid;
  threeDot: boolean; // true → merge-base(from,to)…to ; false → from..to (plain tree diff)
  includeWorktree: boolean; // honoured only when toOid === HEAD oid (isWorktreeSource)
  commit?: Oid; // set when this range is "show one commit" (from = first parent)
}

export type DiffSource = BranchesSource | RangeSource;

export type ChangeLayer = "committed" | "staged" | "unstaged" | "untracked" | "conflict";
export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";

export interface FileDiff {
  id: string; // stable key: newPath ?? oldPath
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  layers: ChangeLayer[]; // which layers contributed (D6 badges)
  similarity?: number; // renames, 0..100
  oldOid: Oid | null; // null = absent
  newOid: Oid | null; // null = absent or worktree content not hashed yet
  oldMode: number | null;
  newMode: number | null;
  binary: boolean;
  image: boolean; // by extension
  oldSize: number;
  newSize: number;
  stats: { additions: number; deletions: number } | null; // null until content diffed
  tooLarge: boolean; // guard, see §6.7
  generated?: boolean; // amendment (T3.4): linguist-generated / -diff attribute
}

export interface DiffResult {
  source: DiffSource;
  mergeBase: Oid | null; // null when no common ancestor
  files: FileDiff[]; // sorted by path
  totals: { files: number; additions: number; deletions: number };
  computedAt: number;
  durationMs: number;
  generation: number; // amendment: stale-result rejection (STALE)
  warnings: RepoWarning[];
}

export interface FileContents {
  old: Uint8Array | null;
  new: Uint8Array | null;
} // fetched lazily per file

/** Tree entry mode of a submodule (gitlink). */
export const MODE_GITLINK = 0o160000;

// ---- v2 revision model (T10.1, docs/v2-contracts.md) ------------------------------------------

/**
 * A git author/committer/tagger line. `timestamp` is epoch **milliseconds** (every timestamp that
 * crosses the worker boundary is, like `DiffResult.computedAt`); `tzOffsetMin` is the recorded zone
 * offset in minutes, as isomorphic-git reports it (`Date.getTimezoneOffset()` convention).
 */
export interface Signature {
  name: string;
  email: string;
  timestamp: number;
  tzOffsetMin: number;
}

/** What `resolveRevision(expr)` made of one revision expression. */
export interface ResolvedRevision {
  expr: string;
  /** null only for `<root>^` → the empty tree. */
  oid: Oid | null;
  kind: "branch" | "remote" | "tag" | "stash" | "commit" | "head" | "empty-tree";
  /** "main", "v2.3.0", "stash@{0}", "a1b2c3d" — what the picker shows. */
  display: string;
  /** refs/heads/main, refs/tags/v2.3.0 — only when the expression named a ref outright. */
  fullRef?: string;
  /** The annotated tag object the commit in `oid` was peeled from. */
  peeledFrom?: Oid;
}

export interface TagInfo {
  name: string; // "v2.3.0"
  fullName: string; // "refs/tags/v2.3.0"
  oid: Oid; // what the ref points at (the tag object for an annotated tag)
  targetOid: Oid; // the peeled object (a commit for every tag the history views use)
  /**
   * T10.5b B1: what `targetOid` actually is. `git tag` can name a blob or a tree (git.git's own
   * `refs/tags/junio-gpg-pub` is a blob); everything that seeds a walk skips anything but
   * `"commit"`, exactly as `git log --all` does.
   */
  targetType: "commit" | "tree" | "blob";
  annotated: boolean;
  message?: string;
  tagger?: Signature;
  timestamp?: number; // epoch ms of the tagger line
}

export interface StashInfo {
  index: number; // 0 = newest
  expr: string; // "stash@{0}"
  oid: Oid; // the stash commit
  message: string; // reflog message, e.g. "On main: wip: tracked only"
  timestamp: number; // epoch ms of the reflog entry
  baseOid: Oid; // first parent: HEAD when the stash was made
  indexOid: Oid; // second parent: the staged state
  untrackedOid: Oid | null; // third parent (`git stash -u`), else null
  /** Files the stash touches; null when not computed (see `countStashFiles`). */
  files: number | null;
}

// ---- v2 reflog and in-progress operations (T10.2, docs/v2-contracts.md) ------------------------

/**
 * One line of `.git/logs/HEAD` or `.git/logs/<fullRef>`, newest first.
 *
 * `message` is git's `%gs` verbatim (`"rebase (pick): t1: clean commit"`), so the list is byte-equal
 * to `git reflog --format='%H %gs'`; `action` is the part before the first `:` of that same string
 * (`"rebase (pick)"`, `"commit"`, `"commit (initial)"`, `"checkout"`, `"reset"`), which is what the
 * panel groups and filters by. `oldOid` is null for the entry that created the ref (git writes all
 * zeroes). `reachable` is null until `markReachable` (T10.5) fills it in.
 */
export interface ReflogEntry {
  index: number; // 0 = newest
  expr: string; // "HEAD@{0}", "main@{3}"
  oldOid: Oid | null;
  newOid: Oid;
  action: string;
  message: string;
  who: Signature;
  reachable: boolean | null;
}

export type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

/**
 * What git is in the middle of, read from the state files in `.git/` (T10.2). Every field beyond
 * `kind` and `conflicts` is optional because a layout diffgit does not recognise must still say
 * "a rebase is in progress" rather than nothing (atlas tab 07, "Risks").
 */
export interface RepoOperation {
  kind: OperationKind;
  step?: number; // 1-based: `rebase-merge/msgnum` or `rebase-apply/next`
  total?: number; // `rebase-merge/end` or `rebase-apply/last`
  onto?: Oid;
  ontoDisplay?: string; // a ref name pointing at `onto`, else its short oid
  headName?: string; // the ref being replayed, e.g. "refs/heads/topic"
  current?: Oid; // the commit being applied (stopped-sha / MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD)
  remaining?: Oid[]; // still in `git-rebase-todo`
  done?: Oid[]; // already in `done`
  conflicts: number; // paths with a stage > 0 entry in the index
  startedAt?: number; // epoch ms: mtime of the state file that named the operation
  interactive?: boolean;
}

// ---- v2 "why is this file hidden" (T10.4, docs/v2-contracts.md, Design §14.3/§14.4) ------------

/**
 * Why a path is (or is not) in the diff, for the popover behind a Hidden row.
 *
 * `shown` is true only when the path has a row in the current diff *and* nothing hides its content;
 * everything `listHidden` returns therefore answers `shown: false`. `reasons` is ordered most
 * decisive first (`ignored`, `sparse`, `skip-worktree`, `assume-unchanged`, `too-large`), with the
 * explanatory `generated` last and `clean` (tracked, unchanged, nothing hiding it) on its own.
 * `source` / `line` / `pattern` are filled for `ignored` and read exactly like `git check-ignore -v`;
 * `command` is the copyable command that undoes the reason, where one exists.
 */
export interface PathExplanation {
  path: string;
  shown: boolean;
  reasons: {
    kind:
      | "ignored"
      | "skip-worktree"
      | "assume-unchanged"
      | "sparse"
      | "too-large"
      | "generated"
      | "clean";
    source?: string;
    line?: number;
    pattern?: string;
    command?: string;
  }[];
}

/**
 * One row of the sidebar's Hidden group (`listHidden`). An ignored directory is a single
 * `ignored-dir` row carrying `count` — the number of entries directly inside it — and is never
 * descended into, so `node_modules` costs one row rather than a hundred thousand.
 */
export interface HiddenEntry {
  path: string;
  kind: "ignored-dir" | "ignored" | "skip-worktree" | "assume-unchanged" | "too-large" | "sparse";
  count?: number;
}

// ---- v2 history: commits, lanes, ahead/behind, branches (T10.5, docs/v2-contracts.md) ----------

/** One lane-to-lane line in a row's band of the history graph (see `CommitSummary.edges`). */
export interface CommitEdge {
  /** Lane index at this row. */
  from: number;
  /** Lane index at the next row. */
  to: number;
  /**
   * `straight` — the line stays in its lane (a pass-through, or the commit continuing into its
   * first parent); `merge` — the line moves to a lane another commit already reserved for that
   * parent, which is what two branches converging looks like; `fork` — a new lane opened for a
   * second or later parent of a merge.
   */
  kind: "straight" | "merge" | "fork";
}

/**
 * One row of the history list (`walkCommits`). `lane`, `laneCount` and `edges` are everything the
 * SVG column needs: the node sits at `lane`, the row is `laneCount` lanes wide, and `edges`
 * describes the band **below** the node, so drawing rows `i` and `i+1` never needs a third row.
 *
 * `refs` are display names — `HEAD` first when this is HEAD, then branch (`main`), remote
 * (`origin/main`), tag (`v1.0.0`) and stash (`stash@{0}`) names, in that order; the UI matches them
 * against `RepoInfo.refs` / `listTags()` to pick a badge palette (Design §14.5).
 */
export interface CommitSummary {
  oid: Oid;
  parents: Oid[];
  author: Signature;
  committer: Signature;
  /** First line of the commit message. */
  subject: string;
  refs: string[];
  lane?: number;
  laneCount?: number;
  edges?: CommitEdge[];
}

/** The CommitCard payload (Design §14.5): a summary plus everything the header shows. */
export interface CommitDetails extends CommitSummary {
  /** The message after the subject line, with the blank separator removed. */
  body: string;
  tree: Oid;
  /** A `gpgsig` header is present (the signature itself is not verified in the browser). */
  signed: boolean;
  /** `refs/notes/commits` for this commit, or null. */
  note: string | null;
  /** Against the first parent (a root commit against the empty tree); null when unavailable. */
  stats: { files: number; additions: number; deletions: number } | null;
}

/** One page of `walkCommits`. `from` holds revision expressions; `cursor` continues a walk. */
export interface WalkRequest {
  from: string[];
  firstParent: boolean;
  cursor?: string;
  limit: number;
  /** Repo-relative path; only commits that change it are returned (git's default simplification). */
  path?: string;
  /** Seed from every ref, tag and stash as well as `from` (git's `--all`). */
  all?: boolean;
}

export interface WalkPage {
  commits: CommitSummary[];
  /** Opaque continuation token; null when the history is exhausted or capped. */
  cursor: string | null;
  /** The commit-graph file was parsed and used for this walk. */
  graphAvailable: boolean;
  /** The 50,000-commit cap was reached (`HISTORY_CAPPED`). */
  capped: boolean;
  /**
   * T10.5b: a row in this page needed more than `MAX_LANES` lanes and was folded into the last
   * one, so the graph column is no longer faithful — the UI offers `first-parent` instead.
   */
  laneOverflow: boolean;
}

/** `git rev-list --left-right --count a...b`: `ahead` is the left count, `behind` the right one. */
export interface AheadBehind {
  ahead: number;
  behind: number;
  mergeBase: Oid | null;
  /** One side hit the 10,000-commit cap, so the counts are lower bounds. */
  capped: boolean;
}

/** One row of the Branches table (Design §14.6). The three cells are null until `branchCells`. */
export interface BranchRow {
  ref: RepoRef;
  /** `origin/main` from `branch.<name>.remote` + `.merge`; null when the branch tracks nothing. */
  upstream: string | null;
  lastCommit: { oid: Oid; subject: string; author: string; timestamp: number } | null;
  vsUpstream: AheadBehind | null;
  vsDefault: AheadBehind | null;
  /** Fully contained in the default branch (`vsDefault.ahead === 0`). */
  merged: boolean | null;
  /** Tags pointing at the tip. */
  tags: string[];
}

// ---- v2 file history and blame (T10.6, docs/v2-contracts.md) -----------------------------------

/**
 * One commit that changed a path, as `git log --follow -- <path>` lists them (newest first).
 *
 * `path` is the name the file had **at this commit**; `renamedFrom` is the name it had at the
 * commit's first parent, so a rename hop can be shown explicitly (atlas tab 02: "renamed from … in
 * …"). `whitespaceOnly` is true when the `-w` diff against the parent is empty — a reindent that
 * would otherwise steal the blame for every line.
 */
export interface PathHistoryEntry {
  oid: Oid;
  subject: string;
  author: Signature;
  path: string;
  renamedFrom: string | null;
  whitespaceOnly: boolean;
  status: FileStatus;
}

/**
 * Who last touched one line. `oid` is null for a line that only exists in the working tree
 * ("you, uncommitted"); `origLine` is the 1-based line number in that commit's version of the file
 * and `origPath` the name it had there — the two fields `git blame --porcelain` prints as the
 * header's second number and its `filename` line.
 */
export interface BlameLine {
  line: number;
  oid: Oid | null;
  origLine: number;
  origPath: string;
}

/** The Blame card's payload (`EngineApi.blame`, Design §14.1 `Diff | Blame | History`). */
export interface BlamePayload {
  path: string;
  ref: string;
  lines: BlameLine[];
  /** Every commit named in `lines`, so the gutter needs no second call. */
  commits: Record<Oid, { author: Signature; subject: string }>;
  /** How many revisions were examined before every line had an origin. */
  revisions: number;
  /** `maxRevisions` was reached; the remaining lines carry the oldest revision seen (`BLAME_CAPPED`). */
  capped: boolean;
}

// ---- v2 secret scan (T10.7, docs/v2-contracts.md) ---------------------------------------------

/**
 * One rule match on one added line of the uncommitted work (`EngineApi.scanSecrets`, atlas tab 14).
 *
 * `masked` is the redacted preview the UI shows by default (first 8 characters, an ellipsis, the
 * last 4 — never the middle of the token) so a screen share does not leak the credential; `full` is
 * the matched value itself, which the card's explicit **Reveal** click shows and nothing else ever
 * renders. `entropy` is the Shannon entropy of the matched value in bits/char, rounded to two
 * decimals — the "why flagged" second signal, present for every finding even when its rule did not
 * gate on it. `layer` is `unstaged` whenever the file has unstaged work, because that is where the
 * line is right now.
 */
export interface SecretFinding {
  fileId: string;
  path: string;
  line: number;
  rule: string;
  entropy: number;
  masked: string;
  full: string;
  layer: "staged" | "unstaged";
}

// ---- v2 search (T10.8, docs/v2-contracts.md, atlas tab 05) -------------------------------------

/**
 * One search, in one of the palette's three scopes (atlas tab 05):
 *
 * - `commits` — `git log --grep` / `--author` / a SHA prefix, over a capped walk from `from`.
 * - `worktree` — `git grep -n` over the tracked and untracked text files.
 * - `pickaxe` — `git log -S` over the last `commits` commits of the first-parent chain.
 *
 * `query` is a **literal substring** unless `regex` is set (`REGEX_MAX_LENGTH`, the `u` flag, and a
 * per-file time budget; see `src/engine/search/query.ts`). Matching is case-insensitive in both
 * modes. `path` scopes the two content scopes to a file or a directory prefix and is what keeps
 * the pickaxe affordable. `limit` bounds the hits, `commits` the commits walked.
 */
export interface SearchRequest {
  scope: "commits" | "worktree" | "pickaxe";
  query: string;
  regex?: boolean;
  path?: string;
  limit: number;
  /** Commits to walk: the pickaxe's range size (default 200) and the commit scope's cap. */
  commits?: number;
}

/**
 * One result row. `kind: "commit"` carries `oid`, `subject` and — for the pickaxe — `delta`, how
 * many more (or fewer) occurrences of the query the commit left behind. The pickaxe's working-tree
 * row is a commit hit with **no** `oid`: uncommitted work has no commit to point at.
 * `kind: "file"` carries `path`, the 1-based `line` and the line's `text`, trimmed to
 * `HIT_TEXT_MAX` characters.
 */
export interface SearchHit {
  kind: "commit" | "file";
  oid?: Oid;
  subject?: string;
  path?: string;
  line?: number;
  text?: string;
  delta?: number;
}

/**
 * `hits` are in a deterministic order (walk order for commits, path then line for files).
 * `scanned` is what the scope counts: commits for `commits`/`pickaxe`, files read for `worktree`.
 * `capped` means the answer is **incomplete** — `limit` was reached, the commit cap bit, or a file
 * was abandoned on its regex budget — and is what raises `SEARCH_CAPPED`.
 */
export interface SearchResult {
  hits: SearchHit[];
  scanned: number;
  capped: boolean;
  durationMs: number;
}

// ---- v2 insights (T10.9, docs/v2-contracts.md) ------------------------------------------------

/**
 * What the Insights mode asks for (`EngineApi.insights`, atlas tab 13).
 *
 * `sinceMs` is the period chip (`Prefs.insightsPeriod`: `90d` / `1y` / `all`) resolved to an epoch
 * millisecond by the UI; leaving it out means the whole first-parent history. `limit` is how many
 * hotspot rows to rank — manifests are ranked separately and get up to `limit` rows of their own.
 */
export interface InsightsRequest {
  sinceMs?: number;
  limit: number;
}

/**
 * Everything the Insights page draws, from one first-parent walk (`src/engine/insights`).
 *
 * `commits` counts the in-window commits, `walked` every first-parent commit the walk visited
 * (`capped` when that hit the 50,000 cap and `INSIGHTS_CAPPED` went to the sink). `bots` is how
 * many of the in-window commits a bot authored; those are **not** in `authors`, which is keyed by
 * the author name after `.mailmap`, newest-heavy first. `hotspots` is the top `limit` real files by
 * `commits × log2(size)` followed by the top `limit` manifests, which the UI greys out. `activity`
 * is at most 52 weeks of per-day commit counts, oldest week first, `weekStart` the local midnight
 * of that week's Sunday and `days[0]` that Sunday.
 */
export interface InsightsResult {
  commits: number;
  authors: { name: string; commits: number }[];
  hotspots: { path: string; commits: number; size: number; score: number; manifest: boolean }[];
  activity: { weekStart: number; days: number[] }[];
  walked: number;
  capped: boolean;
  bots: number;
}

// ---- v2 bisect and rebase preflight (T10.11, docs/v2-contracts.md) -----------------------------

/**
 * What the bisect strip has marked so far (atlas tab 15). Nothing is written to the repository:
 * the user checks the candidate out with the command the UI shows and answers good / bad / skip.
 *
 * `good` is every commit known to be good (git allows several), `bad` the one known-bad tip, and
 * `skipped` the commits the user could not test. All three are commit oids.
 */
export interface BisectState {
  good: Oid[];
  bad: Oid;
  skipped: Oid[];
}

/**
 * The answer to one round: `candidate` is the commit to test next (git's `rev-list --bisect`
 * midpoint), `remaining` how many commits are still suspects, and `steps` the `ceil(log2)` bound
 * on the rounds left. `candidate` is null and `firstBad` set once at most one suspect is left —
 * that commit is the first bad one.
 */
export interface BisectStep {
  candidate: Oid | null;
  remaining: number;
  steps: number;
  firstBad: Oid | null;
}

/**
 * One commit a rebase would replay (atlas tab 16). `files` is the number of paths it changes
 * against its first parent, `merge` whether it has more than one parent (the command then needs
 * `--rebase-merges`) and `signed` whether it carries a `gpgsig` header — rebasing drops it.
 *
 * `overlaps` has one entry per path this commit and the onto side both changed, `theirs` naming
 * the onto-side commit that changed it; `prediction` is the worst of them (`clean` with none).
 */
export interface PreflightRow {
  oid: Oid;
  subject: string;
  files: number;
  merge: boolean;
  signed: boolean;
  overlaps: { path: string; prediction: "likely" | "possible"; theirs: Oid }[];
  prediction: "clean" | "possible" | "likely";
}

/**
 * "Will this rebase conflict?" for `branch` onto `onto` — a report, never a write. `rows` are the
 * commits since `mergeBase`, oldest first (the order they would be replayed in), `ontoAdvanced`
 * how many commits the onto side gained since the same base, `command` the exact `git rebase -i`
 * to run and `todo` the `pick <sha7> <subject>` list to paste into the editor it opens.
 */
export interface PreflightResult {
  branch: string;
  onto: string;
  mergeBase: Oid | null;
  ontoAdvanced: number;
  rows: PreflightRow[];
  command: string;
  todo: string;
}
