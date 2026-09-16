/**
 * User-facing copy for every public engine error code (T4.1). `describeError` covers exactly
 * `PUBLIC_CODES` from `src/engine/errors.ts`; the test iterates that array.
 */
import { errorCode, PUBLIC_CODES, type PublicCode } from "../engine/errors";

export type ErrorAction = "choose-folder" | "retry" | "reopen-permission";

export interface ErrorDescription {
  title: string;
  message: string;
  action?: ErrorAction;
}

const COPY: Record<PublicCode, ErrorDescription> = {
  NOT_A_REPO: {
    title: "Not a git repository",
    message: "The folder you picked has no .git directory. Choose the folder that contains .git.",
    action: "choose-folder",
  },
  WORKTREE_GITDIR: {
    title: "Linked worktree",
    message:
      "This folder is a linked git worktree (.git is a file). Open the main repository folder instead.",
    action: "choose-folder",
  },
  BARE_REPO: {
    title: "Bare repository",
    message: "This is a bare repository without a working tree. Open a normal checkout.",
    action: "choose-folder",
  },
  REFTABLE: {
    title: "Reftable refs are not supported",
    message: "This repository stores refs in reftable format, which diffgoel cannot read yet.",
    action: "choose-folder",
  },
  OBJECT_FORMAT_SHA256: {
    title: "SHA-256 repository",
    message: "Repositories using the SHA-256 object format are not supported.",
    action: "choose-folder",
  },
  ALTERNATES: {
    title: "Objects live outside this folder",
    message:
      "This repository uses .git/objects/info/alternates, so its objects cannot be read from this folder alone.",
    action: "choose-folder",
  },
  PARTIAL_CLONE: {
    title: "Partial clone",
    message:
      "This is a partial (promisor) clone; some objects only exist on the remote, so diffs would be incomplete.",
    action: "choose-folder",
  },
  PACK_TOO_LARGE: {
    title: "Repository too large",
    message: "Pack files exceed 1 GB. Reading them in the browser is not attempted.",
    action: "choose-folder",
  },
  INDEX_UNSUPPORTED: {
    title: "Unsupported index format",
    message: "The .git/index file uses a format version diffgoel cannot parse.",
    action: "choose-folder",
  },
  PERMISSION: {
    title: "Permission denied",
    message: "The browser did not grant read access to this folder. Grant access and try again.",
    action: "reopen-permission",
  },
  HANDLE_GONE: {
    title: "Folder not found",
    message: "The repository folder was moved or deleted. Choose it again.",
    action: "choose-folder",
  },
  IO_ERROR: {
    title: "Read error",
    message: "A file could not be read. Check that the folder is still accessible and retry.",
    action: "retry",
  },
  REF_NOT_FOUND: {
    title: "Branch not found",
    message: "One of the selected branches no longer exists. Pick another branch.",
    action: "retry",
  },
  CANCELLED: {
    title: "Cancelled",
    message: "The operation was superseded by a newer request.",
  },
  STALE: {
    title: "Outdated result",
    message: "The diff changed while this was loading. It will refresh automatically.",
    action: "retry",
  },
  TOO_LARGE: {
    title: "Too large",
    message: "This content exceeds the size diffgoel can display.",
  },
  WORKER_CRASHED: {
    title: "Engine restarted",
    message: "The diff engine stopped unexpectedly and was restarted. Refreshing.",
    action: "retry",
  },
  STORAGE_UNAVAILABLE: {
    title: "Storage unavailable",
    message: "Recent repos won't be remembered in this browser (storage is blocked or full).",
  },
  INTERNAL: {
    title: "Something went wrong",
    message:
      "An internal error occurred. Please retry; if it persists, report it with the details.",
    action: "retry",
  },
};

export function isPublicCode(code: string | undefined): code is PublicCode {
  return code !== undefined && (PUBLIC_CODES as readonly string[]).includes(code);
}

/** Copy for a public code; unknown codes fall back to INTERNAL so no raw code is ever shown. */
export function describeError(code: string | undefined): ErrorDescription {
  return isPublicCode(code) ? COPY[code] : COPY.INTERNAL;
}

/** Shape of any error after crossing the worker boundary (see `PublicError` in engine/api.ts). */
export interface UiError {
  code: PublicCode;
  message: string;
  hint?: string;
}

/** Normalises anything thrown by the client into a `UiError`. */
export function toUiError(e: unknown): UiError {
  const code = errorCode(e);
  const message =
    typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string"
      ? (e as { message: string }).message
      : String(e);
  const hint =
    typeof e === "object" && e !== null && typeof (e as { hint?: unknown }).hint === "string"
      ? (e as { hint: string }).hint
      : undefined;
  const ui: UiError = { code: isPublicCode(code) ? code : "INTERNAL", message };
  if (hint !== undefined) ui.hint = hint;
  return ui;
}
