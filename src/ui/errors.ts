/**
 * User-facing copy for every public engine error code (T4.1, redesigned 2026-09-18 per the approved
 * review E1–E4). `describeError` covers exactly `PUBLIC_CODES` from `src/engine/errors.ts`; the test
 * iterates that array.
 *
 * Every entry has the same anatomy (Design §7.8): a `tone` for the icon tile, a `title`, one
 * `message` sentence on what happened, and a `fix` box ("What to do", plus an optional second row)
 * whose text may carry `backtick` spans that the screens render as <code>.
 */
import { errorCode, isPublicCode as isRegistered, type PublicCode } from "../engine/errors";

export type ErrorAction = "choose-folder" | "retry" | "reopen-permission";

/** Tile colour (Design §7.8): red = repo unusable here, yellow = access / environment, blue = transient, grey = informational. */
export type ErrorTone = "red" | "yellow" | "blue" | "grey";

export interface ErrorFixRow {
  /** Upper-case mono label, e.g. "What to do", "Looked in", "Found". */
  label: string;
  /** Text; `backtick` spans render as <code>. */
  text: string;
}

export interface ErrorDescription {
  title: string;
  message: string;
  action?: ErrorAction;
  tone: ErrorTone;
  /** The "What to do" box. Empty for codes that never reach a screen. */
  fix: ErrorFixRow[];
  /** Icon name for the tile (a `lucide-react` export name, resolved by the screen). */
  icon:
    | "FolderGit2"
    | "GitBranch"
    | "Database"
    | "KeyRound"
    | "Link"
    | "HardDrive"
    | "FileText"
    | "Lock"
    | "Folder"
    | "Cpu"
    | "Zap"
    | "RefreshCw"
    | "Scale";
}

const COPY: Record<PublicCode, ErrorDescription> = {
  NOT_A_REPO: {
    title: "Not a git repository",
    message: "The folder you picked has no `.git` directory.",
    action: "choose-folder",
    tone: "red",
    icon: "FolderGit2",
    fix: [
      {
        label: "What to do",
        text: "Choose the folder that contains `.git` — usually the one you `cd` into before running `git status`.",
      },
      { label: "Looked in", text: "`<folder>/.git` — not found; parent folders are not searched." },
    ],
  },
  WORKTREE_GITDIR: {
    title: "Linked worktree",
    message:
      "This folder is a linked git worktree: its `.git` is a file pointing to another repository.",
    action: "choose-folder",
    tone: "red",
    icon: "GitBranch",
    fix: [
      {
        label: "What to do",
        text: "Open the main repository folder instead — the path after `gitdir:` in that file.",
      },
    ],
  },
  BARE_REPO: {
    title: "Bare repository",
    message:
      "This is a bare repository. It has objects and refs but no working tree, so there is nothing uncommitted to show.",
    action: "choose-folder",
    tone: "red",
    icon: "Database",
    fix: [
      {
        label: "What to do",
        text: "Open a normal clone with a working tree, e.g. `git clone <folder>.git <folder>`.",
      },
    ],
  },
  REFTABLE: {
    title: "Reftable refs are not supported",
    message: "This repository stores refs in the reftable format, which diffgit cannot read yet.",
    action: "choose-folder",
    tone: "red",
    icon: "Database",
    fix: [
      {
        label: "What to do",
        text: "Open a repository that uses the files ref format, or re-clone: `git clone --ref-format=files …`",
      },
    ],
  },
  OBJECT_FORMAT_SHA256: {
    title: "SHA-256 repository",
    message: "Repositories using the SHA-256 object format are not supported.",
    action: "choose-folder",
    tone: "red",
    icon: "KeyRound",
    fix: [
      {
        label: "What to do",
        text: "Open a SHA-1 repository. Git cannot convert between formats in place; this needs a separate clone.",
      },
    ],
  },
  ALTERNATES: {
    title: "Objects live outside this folder",
    message:
      "This repository borrows objects from another path via `.git/objects/info/alternates`, so its history cannot be read from this folder alone.",
    action: "choose-folder",
    tone: "red",
    icon: "Link",
    fix: [
      {
        label: "What to do",
        text: "Open a repository whose objects are self-contained, or run `git repack -a -d` then delete the alternates file.",
      },
    ],
  },
  PARTIAL_CLONE: {
    title: "Partial clone",
    message:
      "This is a partial (promisor) clone. Some objects only exist on the remote and the browser cannot fetch them, so diffs would be incomplete.",
    action: "choose-folder",
    tone: "red",
    icon: "Database",
    fix: [
      {
        label: "What to do",
        text: "Run `git fetch --refetch` in this checkout, or open a full clone.",
      },
    ],
  },
  PACK_TOO_LARGE: {
    title: "Repository too large",
    message: "Pack files exceed 1 GB; the limit for reading inside a browser tab is 1 GB.",
    action: "choose-folder",
    tone: "red",
    icon: "HardDrive",
    fix: [
      {
        label: "What to do",
        text: "Open a smaller repository, or a shallow clone: `git clone --depth 50 …` (history will be truncated; a banner will say so).",
      },
    ],
  },
  INDEX_UNSUPPORTED: {
    title: "Unsupported index format",
    message: "The `.git/index` file uses a format version diffgit cannot parse.",
    action: "retry",
    tone: "red",
    icon: "FileText",
    fix: [
      {
        label: "What to do",
        text: "Run `git update-index --index-version 4` in this checkout, then retry. Nothing else about the repository changes.",
      },
      { label: "Found", text: "a version other than 2–4, or an unknown mandatory extension" },
    ],
  },
  PERMISSION: {
    title: "Permission needed",
    message: "The browser did not grant read access to this folder. Nothing was read.",
    action: "reopen-permission",
    tone: "yellow",
    icon: "Lock",
    fix: [
      {
        label: "What to do",
        text: "Click Grant access and choose View files in the browser prompt. Access is read-only and lasts for this tab.",
      },
      {
        label: "If no prompt",
        text: "Site settings → File editing → allow, or reopen the folder from the picker.",
      },
    ],
  },
  HANDLE_GONE: {
    title: "Folder not found",
    message:
      "The repository folder was moved, renamed, deleted, or is on a drive that is no longer mounted.",
    action: "choose-folder",
    tone: "yellow",
    icon: "Folder",
    fix: [
      {
        label: "What to do",
        text: "Choose it again from its new location. Viewed marks and the last branch pair are kept if it is the same repository.",
      },
    ],
  },
  IO_ERROR: {
    title: "Read error",
    message: "A file could not be read.",
    action: "retry",
    tone: "blue",
    icon: "HardDrive",
    fix: [
      {
        label: "What to do",
        text: "Check the folder is still accessible (network drive, cloud sync, antivirus) and retry. If it keeps failing, `git fsck` will say whether the file is damaged.",
      },
    ],
  },
  REF_NOT_FOUND: {
    title: "Branch not found",
    message:
      "One of the selected branches no longer exists — it was deleted or renamed while it was selected.",
    action: "retry",
    tone: "blue",
    icon: "GitBranch",
    fix: [
      { label: "What to do", text: "Retry compares the default branches. Or pick another branch." },
    ],
  },
  CANCELLED: {
    title: "Cancelled",
    message: "The operation was superseded by a newer request.",
    tone: "grey",
    icon: "RefreshCw",
    fix: [],
  },
  STALE: {
    title: "Outdated result",
    message: "The diff changed while this was loading. It will refresh automatically.",
    action: "retry",
    tone: "grey",
    icon: "RefreshCw",
    fix: [],
  },
  TOO_LARGE: {
    title: "Too large",
    message: "This content exceeds the size diffgit can display.",
    tone: "grey",
    icon: "Scale",
    fix: [],
  },
  WORKER_CRASHED: {
    title: "Engine restarted",
    message: "The diff engine stopped unexpectedly. That usually means the tab ran out of memory.",
    action: "retry",
    tone: "blue",
    icon: "Cpu",
    fix: [
      {
        label: "What to do",
        text: "Close other tabs and retry, or open without uncommitted changes (the working tree scan is the biggest allocation).",
      },
    ],
  },
  STORAGE_UNAVAILABLE: {
    title: "Storage unavailable",
    message:
      "Storage is blocked or full. This repo won't be listed in Recent and viewed marks won't persist.",
    tone: "yellow",
    icon: "Database",
    fix: [],
  },
  INTERNAL: {
    title: "Something went wrong",
    message: "An internal error occurred. This is a bug in diffgit, not in your repository.",
    action: "retry",
    tone: "blue",
    icon: "Zap",
    fix: [
      {
        label: "What to do",
        text: "Retry. If it happens again, copy the details and open an issue — the report contains no file contents.",
      },
    ],
  },
  REV_NOT_FOUND: {
    title: "Revision not found",
    message: "Nothing in this repository matches that revision.",
    tone: "grey",
    icon: "GitBranch",
    fix: [
      {
        label: "What to do",
        text: "Use a branch, tag or stash name, or a SHA of at least 7 characters. `~n`, `^` and `^n` are supported; other gitrevisions syntax is not.",
      },
    ],
  },
  REV_AMBIGUOUS: {
    title: "Ambiguous revision",
    message: "That short SHA matches more than one object.",
    tone: "grey",
    icon: "GitBranch",
    fix: [{ label: "What to do", text: "Type more characters of the SHA." }],
  },
  NOT_A_PATCH: {
    title: "Not a patch file",
    message: "The file is not a unified diff that diffgit can read.",
    tone: "grey",
    icon: "FileText",
    fix: [
      {
        label: "What to do",
        text: "Open a `.patch` or `.diff` produced by `git format-patch` or `git diff`.",
      },
    ],
  },
};

/** Codes that, when thrown while a repository is opening, stay on the loading screen attached to the phase (L4). */
export const LOADING_INLINE_CODES: ReadonlySet<PublicCode> = new Set<PublicCode>([
  "IO_ERROR",
  "INDEX_UNSUPPORTED",
  "REF_NOT_FOUND",
  "PERMISSION",
]);

function isPublicCode(code: string | undefined): code is PublicCode {
  return code !== undefined && isRegistered(code);
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
  /** Machine-readable extra (T10.1): `REV_AMBIGUOUS` carries the candidate oids, comma-separated. */
  detail?: string;
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
  const detail =
    typeof e === "object" && e !== null && typeof (e as { detail?: unknown }).detail === "string"
      ? (e as { detail: string }).detail
      : undefined;
  const ui: UiError = { code: isPublicCode(code) ? code : "INTERNAL", message };
  if (hint !== undefined) ui.hint = hint;
  if (detail !== undefined) ui.detail = detail;
  return ui;
}

/**
 * Plain-text bug report for the "Copy details" / "Copy report" buttons: code, engine message, hint,
 * build id and browser — never file contents or paths beyond what the engine message already says.
 */
export function errorReport(error: UiError | null, extra: Record<string, string> = {}): string {
  const lines = [
    `code: ${error?.code ?? "INTERNAL"}`,
    `message: ${error?.message ?? ""}`,
    ...(error?.hint ? [`hint: ${error.hint}`] : []),
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    `build: ${typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev"}`,
    `browser: ${typeof navigator === "undefined" ? "unknown" : navigator.userAgent}`,
    `at: ${new Date().toISOString()}`,
  ];
  return lines.join("\n");
}
