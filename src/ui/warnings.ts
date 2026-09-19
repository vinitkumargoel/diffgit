/**
 * User-facing copy and banner level for every engine warning code (T5.5, Design §3.4 / §7.3).
 * `WARNING_CODES` in `src/engine/errors.ts` is the closed set; the test iterates it so no raw
 * code can ever reach a banner.
 */
import { isWarningCode, type WarningCode } from "../engine/errors";

export type BannerLevel = "info" | "warning" | "error";

/** The one-word action link a banner may offer (review E7); resolved by `WarningBanners`. */
export interface WarningAction {
  label: string;
  kind: "refresh" | "ignore-whitespace" | "compare-head" | "show-large" | "why";
}

export interface WarningCopy {
  level: BannerLevel;
  /** Bold subject shown before the message. */
  subject: string;
  message: string;
  /** Optional accent link at the end of the row; omitted when there is nothing useful to do. */
  action?: WarningAction;
}

export const WARNING_COPY: Record<WarningCode, WarningCopy> = {
  MULTI_PACK_INDEX: {
    level: "warning",
    subject: "Multi-pack index",
    message: "This repository uses a multi-pack index; object reads may be slower.",
  },
  SHALLOW: {
    level: "warning",
    subject: "Shallow clone",
    message: "History is truncated, so the merge base may differ from what git would pick.",
  },
  LFS_PRESENT: {
    level: "warning",
    subject: "Git LFS",
    message: "LFS pointer files are compared, not the large files they stand for.",
  },
  AUTOCRLF: {
    level: "warning",
    subject: "Line endings",
    message: "core.autocrlf is set; line-ending-only changes may appear.",
    action: { label: "Ignore whitespace", kind: "ignore-whitespace" },
  },
  PACK_LARGE: {
    level: "warning",
    subject: "Large pack files",
    message: "Pack files are large; the first read of each object may take a moment.",
  },
  INDEX_CHECKSUM: {
    level: "warning",
    subject: "Index checksum mismatch",
    message: "Index was being written; showing last good read.",
    action: { label: "Refresh", kind: "refresh" },
  },
  SPLIT_INDEX: {
    level: "error",
    subject: "Split index",
    message: "Split index is not supported; uncommitted changes hidden.",
  },
  SPARSE_INDEX: {
    level: "warning",
    subject: "Sparse checkout",
    message: "Untracked file detection is partial.",
  },
  INDEX_TOO_LARGE: {
    level: "error",
    subject: "Index too large",
    message: "The index is bigger than the browser can read; uncommitted changes hidden.",
  },
  UNTRACKED_CAPPED: {
    level: "warning",
    subject: "Untracked files capped",
    message: "Only the first 5,000 untracked files are listed; the rest are omitted.",
  },
  RENAME_LIMIT: {
    level: "warning",
    subject: "Rename detection limited",
    message: "Too many changed files to pair every rename; some show as added + deleted.",
  },
  FILE_TOO_LARGE: {
    level: "warning",
    subject: "Large file skipped",
    message: "Files over the size limit were not compared.",
    action: { label: "Show them", kind: "show-large" },
  },
  EMBEDDED_REPO: {
    level: "warning",
    subject: "Embedded repository",
    message: "A nested repository that is not a submodule was skipped.",
  },
  UNRELATED_HISTORIES: {
    level: "warning",
    subject: "Unrelated histories",
    message: "Branches share no history; showing a direct comparison.",
  },
  MULTIPLE_MERGE_BASES: {
    level: "warning",
    subject: "Multiple merge bases",
    message: "The branches have more than one merge base; the first is used, as git does.",
  },
  WORKTREE_NOT_APPLICABLE: {
    level: "info",
    subject: "Uncommitted changes hidden",
    message:
      "Uncommitted changes are only shown when the compare branch is the checked-out one (HEAD).",
    action: { label: "Compare HEAD", kind: "compare-head" },
  },
  GLOBAL_EXCLUDES_UNAVAILABLE: {
    level: "warning",
    subject: "Global ignores unavailable",
    message:
      "core.excludesFile lives outside this folder; some ignored files may appear as untracked.",
  },
  CONFIG_INCLUDE_SKIPPED: {
    level: "warning",
    subject: "Config include skipped",
    message: "An include in .git/config points outside this folder and was ignored.",
  },
  STALE_PACK_RETRIED: {
    level: "warning",
    subject: "Repository changed while reading",
    message: "A pack file changed mid-read; the read was retried.",
  },
  REFRESH_DEGRADED: {
    level: "warning",
    subject: "Live refresh unavailable",
    message: "Change detection fell back to polling every 2 s.",
    action: { label: "Why?", kind: "why" },
  },
  PATH_TYPE_CHANGED: {
    level: "warning",
    subject: "Path type changed",
    message: "A path switched between file and directory; its diff may be incomplete.",
  },
  // ---- v2 codes (T10.1 registered them, T11.1 owns this copy; docs/v2-contracts.md § Codes) ----
  HISTORY_CAPPED: {
    level: "warning",
    subject: "History capped",
    message: "Only part of the history was walked; older commits are not listed.",
  },
  NO_REFLOG: {
    level: "warning",
    subject: "No reflog",
    message:
      "This repository keeps no reflog, so recent operations and orphaned commits cannot be listed.",
  },
  SEARCH_CAPPED: {
    level: "warning",
    subject: "Search capped",
    message: "The search stopped at its limit; there may be more matches than are listed.",
  },
  BLAME_CAPPED: {
    level: "warning",
    subject: "Blame capped",
    message:
      "Blame stopped at its revision limit; older lines are attributed to the oldest commit it reached.",
  },
  INSIGHTS_CAPPED: {
    level: "warning",
    subject: "Insights capped",
    message: "Insights were computed from part of the history, so the numbers are a sample.",
  },
  HIDDEN_CAPPED: {
    level: "warning",
    subject: "Hidden files capped",
    message: "Only the first 2,000 hidden paths are listed.",
  },
  COMMIT_GRAPH_STALE: {
    level: "warning",
    subject: "Commit graph out of date",
    message: "The commit-graph file is older than the refs, so history was walked without it.",
  },
  SECRETS_FOUND: {
    level: "error",
    subject: "Possible secret",
    message:
      "Uncommitted changes contain something that looks like a credential. It stays masked until you reveal it.",
  },
  // Design §14.3: the banner is a warning while the operation has conflicts, info otherwise; the
  // registry carries the calm case and T11.3 raises the level when `operation.conflicts > 0`.
  OPERATION_IN_PROGRESS: {
    level: "info",
    subject: "Operation in progress",
    message: "A merge, rebase, cherry-pick, revert or bisect is running in this repository.",
  },
  SNAPSHOT_MODE: {
    level: "warning",
    subject: "Snapshot mode",
    message:
      "This browser can only read the folder once, so the diff cannot refresh itself. Re-open the folder to see newer changes.",
  },
  JJ_COLOCATED: {
    level: "info",
    subject: "Colocated jj repository",
    message: "This is also a jj workspace; git refs can lag behind jj's own view of the change.",
  },
  // Design §14.6 asks for an info banner on a patch-only diff, so this one is not a warning.
  PATCH_ONLY: {
    level: "info",
    subject: "Patch only",
    message:
      "A patch file is open, not a repository: there is no working tree, history or branch to compare.",
  },
};

const UNKNOWN: WarningCopy = {
  level: "warning",
  subject: "Warning",
  message: "The engine reported a condition it could not fully handle.",
};

/** Copy for a warning code; anything unknown gets generic copy rather than the raw code. */
export function describeWarning(code: string): WarningCopy {
  return isWarningCode(code) ? WARNING_COPY[code] : UNKNOWN;
}
