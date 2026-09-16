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

// What are we comparing? Designed so v2 can add {kind:"commit"} and {kind:"range"}.
// Amendment: carries full ref names ("refs/heads/x", "refs/remotes/o/x" or the literal "HEAD").
export type DiffSource = {
  kind: "branches";
  source: string; // display name, e.g. "feature" or "origin/main"
  target: string;
  sourceRef: string; // full ref name or "HEAD"
  targetRef: string;
  includeWorktree: boolean;
};

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
