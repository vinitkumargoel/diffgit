/**
 * Canonical error registry (tasks/README.md "Review round 1 amendments").
 *
 * Two tiers:
 *  - fs-tier codes are Node-shaped because isomorphic-git branches on them; they never leave the engine.
 *  - public-tier codes are the only ones that cross the worker boundary; RepoSession translates
 *    fs-tier → public-tier (EACCES→PERMISSION, ENOENT on the root→HANDLE_GONE, EIO→IO_ERROR, EROFS→INTERNAL).
 *
 * No task may invent a code outside this file.
 */

export const FS_CODES = [
  "ENOENT",
  "EISDIR",
  "ENOTDIR",
  "EINVAL",
  "EROFS",
  "EACCES",
  "EIO",
] as const;
export type FsCode = (typeof FS_CODES)[number];

export const PUBLIC_CODES = [
  "NOT_A_REPO",
  "WORKTREE_GITDIR",
  "BARE_REPO",
  "REFTABLE",
  "OBJECT_FORMAT_SHA256",
  "ALTERNATES",
  "PARTIAL_CLONE",
  "PACK_TOO_LARGE",
  "INDEX_UNSUPPORTED",
  "PERMISSION",
  "HANDLE_GONE",
  "IO_ERROR",
  "REF_NOT_FOUND",
  "CANCELLED",
  "STALE",
  "TOO_LARGE",
  "WORKER_CRASHED",
  "STORAGE_UNAVAILABLE",
  "INTERNAL",
] as const;
export type PublicCode = (typeof PUBLIC_CODES)[number];

/**
 * Engine-internal codes that are thrown by one engine module and caught by another (never cross
 * the worker boundary; the catcher converts them into a warning). Listed here so `EngineError`
 * stays closed over a known set.
 */
export const INTERNAL_CODES = ["SPLIT_INDEX", "INDEX_TOO_LARGE"] as const;
export type InternalCode = (typeof INTERNAL_CODES)[number];

export const WARNING_CODES = [
  "MULTI_PACK_INDEX",
  "SHALLOW",
  "LFS_PRESENT",
  "AUTOCRLF",
  "PACK_LARGE",
  "INDEX_CHECKSUM",
  "SPLIT_INDEX",
  "SPARSE_INDEX",
  "INDEX_TOO_LARGE",
  "UNTRACKED_CAPPED",
  "RENAME_LIMIT",
  "FILE_TOO_LARGE",
  "EMBEDDED_REPO",
  "UNRELATED_HISTORIES",
  "MULTIPLE_MERGE_BASES",
  "WORKTREE_NOT_APPLICABLE",
  "GLOBAL_EXCLUDES_UNAVAILABLE",
  "CONFIG_INCLUDE_SKIPPED",
  "STALE_PACK_RETRIED",
  "REFRESH_DEGRADED",
  "PATH_TYPE_CHANGED",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export type EngineErrorCode = FsCode | PublicCode | InternalCode;

/** Backwards-compatible alias used by T4.1's `describeError` exhaustiveness test. */
export const KNOWN_CODES: readonly PublicCode[] = PUBLIC_CODES;

export interface EngineErrorJSON {
  name: "EngineError";
  code: EngineErrorCode;
  message: string;
  hint?: string;
  path?: string;
}

export interface EngineErrorOptions {
  hint?: string;
  cause?: unknown;
  path?: string;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly hint?: string;
  readonly path?: string;

  constructor(code: EngineErrorCode, message?: string, opts: EngineErrorOptions = {}) {
    super(message ?? code, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "EngineError";
    this.code = code;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.path !== undefined) this.path = opts.path;
  }

  /** Plain, structured-cloneable shape for crossing the worker boundary (comlink loses prototypes). */
  toJSON(): EngineErrorJSON {
    const json: EngineErrorJSON = { name: "EngineError", code: this.code, message: this.message };
    if (this.hint !== undefined) json.hint = this.hint;
    if (this.path !== undefined) json.path = this.path;
    return json;
  }
}

/** Node-shaped fs error, as isomorphic-git expects (`code`, `errno`, `path`, `syscall`). */
export interface FsError extends EngineError {
  readonly code: FsCode;
  readonly errno: number;
  readonly syscall: string;
  readonly path: string;
}

const ERRNO: Record<FsCode, number> = {
  ENOENT: -2,
  EIO: -5,
  EACCES: -13,
  EISDIR: -21,
  ENOTDIR: -20,
  EINVAL: -22,
  EROFS: -30,
};

const FS_MESSAGES: Record<FsCode, string> = {
  ENOENT: "no such file or directory",
  EIO: "i/o error",
  EACCES: "permission denied",
  EISDIR: "illegal operation on a directory",
  ENOTDIR: "not a directory",
  EINVAL: "invalid argument",
  EROFS: "read-only file system",
};

export function fsError(code: FsCode, path: string, syscall = "open", cause?: unknown): FsError {
  const err = new EngineError(code, `${code}: ${FS_MESSAGES[code]}, ${syscall} '${path}'`, {
    path,
    cause,
  }) as EngineError & { errno: number; syscall: string };
  Object.defineProperty(err, "errno", { value: ERRNO[code], enumerable: true });
  Object.defineProperty(err, "syscall", { value: syscall, enumerable: true });
  return err as FsError;
}

export function isEngineError(e: unknown): e is EngineError {
  return (
    e instanceof EngineError ||
    (typeof e === "object" &&
      e !== null &&
      (e as { name?: unknown }).name === "EngineError" &&
      typeof (e as { code?: unknown }).code === "string")
  );
}

export function isFsCode(code: string): code is FsCode {
  return (FS_CODES as readonly string[]).includes(code);
}

export function isPublicCode(code: string): code is PublicCode {
  return (PUBLIC_CODES as readonly string[]).includes(code);
}

export function isWarningCode(code: string): code is WarningCode {
  return (WARNING_CODES as readonly string[]).includes(code);
}

/** Reads a `code` off any thrown value (EngineError, Node error, serialised JSON). */
export function errorCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return undefined;
}
