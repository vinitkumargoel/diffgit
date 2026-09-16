/**
 * Minimal structural view of the File System Access API handles (T0.4).
 * The real `FileSystemDirectoryHandle` / `FileSystemFileHandle` satisfy these interfaces, and so do
 * `NodeDirHandle` (bun tests) and `MemoryDirHandle` (E2E / unit tests).
 *
 * Rules: engine code checks `.kind`, never the browser handle classes via `instanceof` (enforced by
 * scripts/check-guards.sh).
 * Missing entries throw an error whose `name` is `"NotFoundError"`; kind mismatches throw
 * `"TypeMismatchError"`; permission problems throw `"NotAllowedError"` — the same names the browser uses.
 */

export interface FileLike {
  size: number;
  lastModified: number; // integer milliseconds since epoch, like `File.lastModified`
  arrayBuffer(): Promise<ArrayBuffer>;
  stream(): ReadableStream<Uint8Array>;
}

export interface FileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<FileLike>;
}

export interface DirHandleLike {
  kind: "directory";
  name: string;
  getDirectoryHandle(name: string): Promise<DirHandleLike>;
  getFileHandle(name: string): Promise<FileHandleLike>;
  entries(): AsyncIterable<[string, DirHandleLike | FileHandleLike]>;
}

export type HandleLike = DirHandleLike | FileHandleLike;

export type HandleErrorName = "NotFoundError" | "TypeMismatchError" | "NotAllowedError";

/** Creates a DOMException-shaped error with the given browser error name. */
export function handleError(name: HandleErrorName, message: string): Error {
  if (typeof DOMException === "function") return new DOMException(message, name);
  const e = new Error(message);
  e.name = name;
  return e;
}

export function isHandleError(e: unknown, name: HandleErrorName): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === name;
}
