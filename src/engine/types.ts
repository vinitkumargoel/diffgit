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
  targetOid: Oid; // the peeled commit
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
