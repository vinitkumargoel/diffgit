/**
 * FsaFs — read-only fs adapter for isomorphic-git over `DirHandleLike` (T1.1, Plan §5.1, D16).
 *
 * `createFsaFs(root)` returns an object whose `promises` member satisfies the promise API
 * isomorphic-git binds (`readFile`, `readdir`, `stat`, `lstat`, `readlink`, and the write methods,
 * which **always throw `EROFS` before any I/O** — this is the disk-safety invariant), plus an
 * engine-facing API used by the scanner and ignore walker (`openFile`, `readdirWithKinds`,
 * `getDirHandle`, `invalidatePath`, `invalidateAll`).
 *
 * Paths: isomorphic-git is always given `dir: "/"` (so `gitdir` is `/.git`); every path is
 * normalised to a repo-relative POSIX path (`/.git/HEAD` → `.git/HEAD`, `""`/`.` = root, `..`
 * segments are rejected with `EINVAL`). Errors are Node-shaped (`code`, `errno`, `path`, `syscall`)
 * via `fsError` because isomorphic-git branches on `code`.
 *
 * Handle cache: resolved handles are memoised per path (cap 20k entries, whole cache dropped when
 * exceeded). `invalidatePath(p)` drops `p` and its descendants (refresh uses this for
 * observer-reported paths); `invalidateAll()` is for repo switch / force refresh. Any
 * NotFound/TypeMismatch on a cached handle evicts that path and retries once.
 */
import { type FsCode, fsError } from "../errors";
import type { DirHandleLike, FileHandleLike, FileLike, HandleLike } from "./dirHandleLike";

export interface FsStats {
  type: "file" | "dir";
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
  uid: number;
  gid: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export type ReadFileOptions = "utf8" | { encoding?: "utf8" | null } | undefined;

/** The subset of Node's `fs.promises` that isomorphic-git binds. */
export interface FsPromises {
  readFile(path: string, opts?: ReadFileOptions): Promise<Uint8Array | string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStats>;
  lstat(path: string): Promise<FsStats>;
  readlink(path: string, opts?: unknown): Promise<never>;
  writeFile(path: string, data?: unknown, opts?: unknown): Promise<never>;
  unlink(path: string): Promise<never>;
  mkdir(path: string, opts?: unknown): Promise<never>;
  rmdir(path: string, opts?: unknown): Promise<never>;
  rm(path: string, opts?: unknown): Promise<never>;
  symlink(target: string, path: string): Promise<never>;
  chmod(path: string, mode: number): Promise<never>;
  rename(from: string, to: string): Promise<never>;
}

export interface DirEntryKind {
  name: string;
  kind: "file" | "directory";
}

export interface FsaFs {
  /** What isomorphic-git consumes (`{ promises }` shape). */
  readonly promises: FsPromises;
  readonly root: DirHandleLike;
  // ---- engine-facing API (T1.1 amendments) ----
  openFile(path: string): Promise<FileLike>;
  readdirWithKinds(path: string): Promise<DirEntryKind[]>;
  getDirHandle(path: string): Promise<DirHandleLike>;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  stat(path: string): Promise<FsStats>;
  /** True when the path exists (any kind). Rethrows non-ENOENT errors. */
  exists(path: string): Promise<boolean>;
  invalidatePath(path: string): void;
  invalidateAll(): void;
  /** Number of cached handles (tests / debug panel). */
  cacheSize(): number;
}

export const MAX_HANDLE_CACHE = 20_000;

/** Normalises to a repo-relative POSIX path. Throws EINVAL on `..` segments. */
export function normalizePath(path: string): string {
  if (typeof path !== "string") throw fsError("EINVAL", String(path), "open");
  const segs: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw fsError("EINVAL", path, "open");
    segs.push(seg);
  }
  return segs.join("/");
}

function errName(e: unknown): string {
  return typeof e === "object" && e !== null ? String((e as { name?: unknown }).name ?? "") : "";
}

function makeStats(type: "file" | "dir", size: number, mtimeMs: number): FsStats {
  return {
    type,
    mode: type === "dir" ? 0o40000 : 0o100644,
    size,
    mtimeMs,
    ctimeMs: 0,
    ino: 0,
    dev: 0,
    uid: 0,
    gid: 0,
    isFile: () => type === "file",
    isDirectory: () => type === "dir",
    isSymbolicLink: () => false,
  };
}

type Expect = "file" | "dir" | "any";

export function createFsaFs(root: DirHandleLike): FsaFs {
  const cache = new Map<string, HandleLike>();
  const pending = new Map<string, Promise<HandleLike>>();
  cache.set("", root);

  function remember(path: string, h: HandleLike): HandleLike {
    if (cache.size >= MAX_HANDLE_CACHE) {
      cache.clear();
      cache.set("", root);
    }
    cache.set(path, h);
    return h;
  }

  function invalidatePath(path: string): void {
    const p = normalizePath(path);
    if (p === "") {
      invalidateAll();
      return;
    }
    const prefix = `${p}/`;
    for (const key of [...cache.keys()]) {
      if (key === p || key.startsWith(prefix)) cache.delete(key);
    }
    for (const key of [...pending.keys()]) {
      if (key === p || key.startsWith(prefix)) pending.delete(key);
    }
  }

  function invalidateAll(): void {
    cache.clear();
    pending.clear();
    cache.set("", root);
  }

  /** Errors raised while resolving an intermediate (parent) segment: always ENOTDIR on mismatch. */
  const parentFailures = new WeakSet<object>();

  /** Maps a DOM-style handle error to a Node-shaped fs error for `path`. */
  function mapError(e: unknown, path: string, expect: Expect, syscall: string): Error {
    const name = errName(e);
    if (name === "NotFoundError") return fsError("ENOENT", path, syscall, e);
    if (name === "TypeMismatchError") {
      const fromParent = typeof e === "object" && e !== null && parentFailures.has(e);
      return fsError(fromParent || expect === "dir" ? "ENOTDIR" : "EISDIR", path, syscall, e);
    }
    if (name === "NotAllowedError" || name === "SecurityError") {
      return fsError("EACCES", path, syscall, e);
    }
    if (e instanceof TypeError) return fsError("EINVAL", path, syscall, e);
    const code = (e as { code?: unknown } | null)?.code;
    if (
      typeof code === "string" &&
      (["ENOENT", "EISDIR", "ENOTDIR", "EINVAL", "EROFS", "EACCES", "EIO"] as string[]).includes(
        code,
      )
    ) {
      return e as Error;
    }
    return fsError("EIO", path, syscall, e);
  }

  function isEvictable(e: unknown): boolean {
    const name = errName(e);
    return name === "NotFoundError" || name === "TypeMismatchError";
  }

  /** Resolves the parent directory handle of `segs` (all but the last segment). */
  async function resolveDir(path: string): Promise<DirHandleLike> {
    const h = await resolve(path, "dir");
    return h as DirHandleLike;
  }

  async function lookupChild(
    parent: DirHandleLike,
    name: string,
    expect: Expect,
  ): Promise<HandleLike> {
    if (expect === "dir") return parent.getDirectoryHandle(name);
    if (expect === "file") return parent.getFileHandle(name);
    try {
      return await parent.getFileHandle(name);
    } catch (e) {
      if (errName(e) !== "TypeMismatchError") throw e;
      return parent.getDirectoryHandle(name);
    }
  }

  /**
   * Resolves a normalised path to a handle, using the cache for every prefix. `expect` controls
   * which lookup is used for the last segment and how TypeMismatchError is mapped.
   */
  async function resolve(path: string, expect: Expect): Promise<HandleLike> {
    if (path === "") return root;
    const cached = cache.get(path);
    if (cached) {
      if (expect === "any" || (expect === "dir") === (cached.kind === "directory")) return cached;
      // cached kind contradicts the expectation → the entry was replaced on disk; re-resolve
      cache.delete(path);
    }
    const inflight = pending.get(path);
    if (inflight) return inflight;
    const p = (async () => {
      const slash = path.lastIndexOf("/");
      const parentPath = slash === -1 ? "" : path.slice(0, slash);
      const name = slash === -1 ? path : path.slice(slash + 1);
      let parent: DirHandleLike;
      try {
        parent = await resolveDir(parentPath);
      } catch (e) {
        if (typeof e === "object" && e !== null) parentFailures.add(e);
        throw e;
      }
      const h = await lookupChild(parent, name, expect);
      return remember(path, h);
    })();
    pending.set(path, p);
    try {
      return await p;
    } finally {
      pending.delete(path);
    }
  }

  /**
   * Runs `fn` against the resolved handle. On NotFound/TypeMismatch from a cached handle, evicts
   * the path (and its ancestors' cached kinds are left alone: directory handles stay valid) and
   * retries once from a fresh resolution. Errors are then mapped to Node codes.
   */
  async function withHandle<T>(
    rawPath: string,
    expect: Expect,
    syscall: string,
    fn: (h: HandleLike) => Promise<T>,
  ): Promise<T> {
    const path = normalizePath(rawPath);
    let attempt = 0;
    for (;;) {
      let h: HandleLike;
      try {
        h = await resolve(path, expect);
      } catch (e) {
        if (attempt === 0 && isEvictable(e) && cacheHasPrefix(path)) {
          // a cached ancestor may be stale (e.g. dir replaced); drop it and retry once
          invalidatePath(path);
          attempt++;
          continue;
        }
        throw mapError(e, rawPath, expect, syscall);
      }
      try {
        return await fn(h);
      } catch (e) {
        if (attempt === 0 && isEvictable(e)) {
          invalidatePath(path);
          attempt++;
          continue;
        }
        throw mapError(e, rawPath, expect, syscall);
      }
    }
  }

  function cacheHasPrefix(path: string): boolean {
    let p = path;
    for (;;) {
      if (cache.has(p) && p !== "") return true;
      const slash = p.lastIndexOf("/");
      if (slash === -1) return false;
      p = p.slice(0, slash);
    }
  }

  function requireFile(h: HandleLike, path: string, syscall: string): FileHandleLike {
    if (h.kind !== "file") throw fsError("EISDIR", path, syscall);
    return h;
  }
  function requireDir(h: HandleLike, path: string, syscall: string): DirHandleLike {
    if (h.kind !== "directory") throw fsError("ENOTDIR", path, syscall);
    return h;
  }

  async function openFile(path: string): Promise<FileLike> {
    return withHandle(path, "file", "open", async (h) => requireFile(h, path, "open").getFile());
  }

  async function readFile(path: string): Promise<Uint8Array> {
    const f = await openFile(path);
    return new Uint8Array(await f.arrayBuffer());
  }

  async function readText(path: string): Promise<string> {
    return new TextDecoder().decode(await readFile(path));
  }

  async function readdirWithKinds(path: string): Promise<DirEntryKind[]> {
    const dirPath = normalizePath(path);
    return withHandle(path, "dir", "scandir", async (h) => {
      const dir = requireDir(h, path, "scandir");
      const out: DirEntryKind[] = [];
      for await (const [name, child] of dir.entries()) {
        out.push({ name, kind: child.kind });
        // the iteration already produced the child handle: remember it so later per-file
        // lookups (scanner, content loads) skip a getFileHandle round-trip
        remember(dirPath === "" ? name : `${dirPath}/${name}`, child);
      }
      return out;
    });
  }

  async function getDirHandle(path: string): Promise<DirHandleLike> {
    return withHandle(path, "dir", "opendir", async (h) => requireDir(h, path, "opendir"));
  }

  async function stat(path: string): Promise<FsStats> {
    return withHandle(path, "any", "stat", async (h) => {
      if (h.kind === "directory") return makeStats("dir", 0, 0);
      const f = await h.getFile();
      return makeStats("file", f.size, f.lastModified);
    });
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw e;
    }
  }

  const readOnly =
    (syscall: string) =>
    async (path?: unknown): Promise<never> => {
      // Never touches a handle: the throw happens before any I/O (D16).
      throw fsError("EROFS", typeof path === "string" ? path : "", syscall);
    };

  const promises: FsPromises = {
    async readFile(path, opts) {
      const bytes = await readFile(path);
      const enc = typeof opts === "string" ? opts : opts?.encoding;
      if (enc === "utf8") return new TextDecoder().decode(bytes);
      return bytes;
    },
    async readdir(path) {
      return (await readdirWithKinds(path)).map((e) => e.name);
    },
    stat,
    lstat: stat,
    async readlink(path) {
      throw fsError("EINVAL", path, "readlink");
    },
    writeFile: readOnly("open"),
    unlink: readOnly("unlink"),
    mkdir: readOnly("mkdir"),
    rmdir: readOnly("rmdir"),
    rm: readOnly("rm"),
    symlink: async (_target: string, path: string) => readOnly("symlink")(path),
    chmod: readOnly("chmod"),
    rename: readOnly("rename"),
  };

  return {
    promises,
    root,
    openFile,
    readdirWithKinds,
    getDirHandle,
    readFile,
    readText,
    stat,
    exists,
    invalidatePath,
    invalidateAll,
    cacheSize: () => cache.size,
  };
}

/** Node-style code of an fs error thrown by this adapter (or undefined). */
export function fsCode(e: unknown): FsCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? (code as FsCode) : undefined;
}
