/**
 * Every string the Worktrees dialog shows (T11.16, Design §14.1, atlas tab 19).
 *
 * The list is `git worktree list` as far as a browser can see it, and two of its columns are
 * honest gaps rather than facts (`docs/v2-contracts.md` `<!-- T10.12 -->`): `path` is null for the
 * main checkout, because a directory handle carries a name and not a path, and for a linked entry
 * it is what the `gitdir` file records — never verified, because verifying it would mean leaving
 * the folder the user granted. `prunable` is therefore only the one case that *is* visible from
 * inside the repository: a `.git/worktrees/<name>/` whose `gitdir` file cannot be read.
 */
import type { WorktreeInfo } from "../engine/types";

export const WORKTREES_TITLE = "Worktrees";
export const WORKTREES_ACTION = "Worktrees of this repository";
export const WORKTREES_SOURCE = "from .git/worktrees";

export const THIS_FOLDER = "this folder";
export const THIS_FOLDER_TITLE = "The checkout you opened.";
export const PRUNABLE = "prunable";
export const PRUNABLE_TITLE =
  "Its gitdir file could not be read, so git would offer to prune it. Run git worktree prune to check.";
export const DETACHED = "detached";
export const OPEN_IT_NOTE = "open it to view";
export const OPEN_IT_TITLE =
  "Permission is scoped to the folder you picked, so another checkout needs its own pick — and a linked worktree, whose .git is a pointer file, is refused on open (WORKTREE_GITDIR).";
export const UNKNOWN_PATH = "path not recorded";
export const PATH_TITLE =
  "The path the gitdir file records. It is never verified: reading it would mean leaving the folder you granted.";

export const EMPTY_LINE = "This repository has no linked worktrees.";
export const LOADING_LINE = "Reading .git/worktrees…";

/** `3 worktrees` / `1 worktree`, for the dialog heading and the palette row hint. */
export function worktreeCount(n: number): string {
  return `${n} ${n === 1 ? "worktree" : "worktrees"}`;
}

/** The branch cell: a short branch name, or `detached` when `HEAD` names no ref. */
export function branchLabel(w: WorktreeInfo): string {
  if (w.branch === null) return DETACHED;
  return w.branch.replace(/^refs\/heads\//, "");
}

/** The path cell: what the entry records, or the folder's own name for the main checkout. */
export function pathLabel(w: WorktreeInfo): string {
  if (w.path !== null) return w.path;
  return w.isThis ? w.name : UNKNOWN_PATH;
}
