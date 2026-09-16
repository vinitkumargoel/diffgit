/**
 * User-facing copy and banner level for every engine warning code (T5.5, Design §3.4 / §7.3).
 * `WARNING_CODES` in `src/engine/errors.ts` is the closed set; the test iterates it so no raw
 * code can ever reach a banner.
 */
import { isWarningCode, type WarningCode } from "../engine/errors";

export type BannerLevel = "info" | "warning" | "error";

export interface WarningCopy {
  level: BannerLevel;
  /** Bold subject shown before the message. */
  subject: string;
  message: string;
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
    message: "Only the first untracked files are listed; the rest are omitted.",
  },
  RENAME_LIMIT: {
    level: "warning",
    subject: "Rename detection limited",
    message: "Too many changed files to pair every rename; some show as added + deleted.",
  },
  FILE_TOO_LARGE: {
    level: "warning",
    subject: "Large file skipped",
    message: "A file over the size limit was not compared.",
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
    message: "Uncommitted changes are only shown when the source is the checked-out branch.",
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
    message: "Change detection fell back to polling or manual refresh.",
  },
  PATH_TYPE_CHANGED: {
    level: "warning",
    subject: "Path type changed",
    message: "A path switched between file and directory; its diff may be incomplete.",
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
