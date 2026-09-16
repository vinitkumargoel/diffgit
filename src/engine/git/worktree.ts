/**
 * WorktreeScanner (T2.4, Plan §5.5 + review amendments): reproduces `git status --porcelain=v2
 * --untracked-files=all` from the index, the HEAD tree and the working directory. Read-only, never
 * descends into ignored or embedded-repo directories, cheap on re-scan thanks to a stat cache.
 *
 * Documented limitations: symlinks (120000) and gitlinks (160000) are always clean in the unstaged
 * pass (FSA cannot see link text or submodule state); mode changes are invisible in the worktree
 * (FSA has no mode) and show only once staged; no autocrlf normalisation; sparse subtrees are opaque.
 */
import { EngineError } from "../errors";
import type { FileLike } from "../fs/dirHandleLike";
import type { FsaFs } from "../fs/fsaFs";
import type { Oid, RepoWarning } from "../types";
import { pLimit, throwIfAborted } from "../util/concurrency";
import type { GitConfig } from "./config";
import { hashBlob, hashBlobStream } from "./hash";
import type { IgnoreRules } from "./ignoreRules";
import type { IndexEntry, IndexSnapshot } from "./indexReader";
import type { FlatTree, ObjectDb } from "./objectDb";

export interface Change {
  oldOid: Oid | null;
  newOid: Oid | null;
  oldMode: number | null;
  newMode: number | null;
  /** Worktree side only (unstaged / untracked): for viewed keys and lazy loading. */
  newSize?: number;
  newLastModified?: number;
}

export interface UntrackedInfo {
  oid: Oid | null; // hashed when size ≤ hashUntrackedUpTo
  size: number;
  lastModified: number;
}

export interface WorktreeStatus {
  staged: Record<string, Change>; // index vs HEAD tree
  unstaged: Record<string, Change>; // worktree vs index (newOid null = deleted)
  untracked: string[]; // sorted
  untrackedInfo: Record<string, UntrackedInfo>;
  conflicts: string[];
  warnings: RepoWarning[];
  stats: {
    indexEntries: number;
    hashed: number;
    statOnly: number;
    cacheHits: number;
    walkedDirs: number;
    durationMs: number;
  };
}

export interface ScannerOptions {
  maxUntracked?: number; // default 5000
  concurrency?: number; // default 32
  hashUntrackedUpTo?: number; // default 1 MB
  streamAbove?: number; // default 8 MB
}

const MODE_SYMLINK = 0o120000;
const MODE_GITLINK = 0o160000;

interface StatCacheEntry {
  size: number;
  lastModified: number;
  oid: Oid;
}

function code(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

export function entryMtimeMs(e: IndexEntry): number {
  return e.mtimeSec * 1000 + Math.floor(e.mtimeNsec / 1e6);
}

function sortPaths(paths: string[]): string[] {
  return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export class WorktreeScanner {
  private readonly statCache = new Map<string, StatCacheEntry>();
  private hashAll = false;
  private readonly opts: Required<ScannerOptions>;

  constructor(
    private readonly fs: FsaFs,
    _db: ObjectDb, // reserved: content reads for future incremental scans go through the same db
    private readonly cfg: GitConfig,
    private readonly ignore: IgnoreRules,
    opts: ScannerOptions = {},
  ) {
    this.opts = {
      maxUntracked: opts.maxUntracked ?? 5000,
      concurrency: opts.concurrency ?? 32,
      hashUntrackedUpTo: opts.hashUntrackedUpTo ?? 1024 * 1024,
      streamAbove: opts.streamAbove ?? 8 * 1024 * 1024,
    };
  }

  /** Force refresh (T6.4): clear the stat cache and hash every entry on the next scan. */
  forgetStatCache(): void {
    this.statCache.clear();
    this.hashAll = true;
  }

  /** Drop cached stat data for specific paths (observer-reported edits). */
  forgetPaths(paths: string[]): void {
    for (const p of paths) this.statCache.delete(p);
  }

  private async hashFile(path: string, f: FileLike): Promise<Oid> {
    const oid =
      f.size > this.opts.streamAbove
        ? await hashBlobStream(f.stream(), f.size)
        : await hashBlob(new Uint8Array(await f.arrayBuffer()));
    this.statCache.set(path, { size: f.size, lastModified: f.lastModified, oid });
    return oid;
  }

  async scan(
    index: IndexSnapshot,
    headTree: FlatTree | null,
    signal?: AbortSignal,
  ): Promise<WorktreeStatus> {
    const t0 = performance.now();
    if (index.hasSplitIndex) {
      throw new EngineError(
        "SPLIT_INDEX",
        "Split index (.git/sharedindex.*) is not supported; the index is incomplete.",
        {
          hint: "Run `git update-index --no-split-index`",
        },
      );
    }
    if (index.tooLarge) {
      throw new EngineError(
        "INDEX_TOO_LARGE",
        `The index has ${index.entries.length} entries (limit 200,000); working-tree status is disabled.`,
      );
    }
    throwIfAborted(signal, "Working tree scan");

    const warnings: RepoWarning[] = [];
    const warnOnce = (w: RepoWarning) => {
      if (!warnings.some((x) => x.code === w.code)) warnings.push(w);
    };
    if (!index.checksumOk) {
      warnOnce({
        code: "INDEX_CHECKSUM",
        message: "The index was being written while it was read; showing the last good read.",
      });
    }
    if (index.hasSparseIndex) {
      warnOnce({
        code: "SPARSE_INDEX",
        message:
          "Sparse checkout: files inside sparse directories are not scanned, so untracked detection is partial.",
      });
    }
    if (this.cfg.core.autocrlf === "true" || this.cfg.core.autocrlf === "input") {
      warnOnce({
        code: "AUTOCRLF",
        message: `core.autocrlf is ${this.cfg.core.autocrlf}; line-ending-only changes may appear (no normalisation in v1).`,
      });
    }

    const sparseDirs = index.entries.filter((e) => e.isSparseDir).map((e) => e.path);
    const underSparse = (path: string) => sparseDirs.some((d) => path.startsWith(`${d}/`));
    const conflictSet = new Set(Object.keys(index.conflicts));

    // ---- staged: stage-0 index ∪ HEAD tree, minus conflicts and sparse subtrees ----
    const staged: Record<string, Change> = {};
    const paths = new Set<string>([...Object.keys(index.byPath), ...Object.keys(headTree ?? {})]);
    for (const path of paths) {
      if (conflictSet.has(path) || underSparse(path)) continue;
      const e = index.byPath[path];
      if (e?.isSparseDir) continue; // opaque subtree: compared as a whole is not possible; documented
      const inIndex = e !== undefined && !e.intentToAdd; // intent-to-add is not staged
      const h = headTree?.[path];
      if (inIndex && !h)
        staged[path] = { oldOid: null, newOid: e.oid, oldMode: null, newMode: e.mode };
      else if (!inIndex && h)
        staged[path] = { oldOid: h.oid, newOid: null, oldMode: h.mode, newMode: null };
      else if (inIndex && h && (e.oid !== h.oid || e.mode !== h.mode)) {
        staged[path] = { oldOid: h.oid, newOid: e.oid, oldMode: h.mode, newMode: e.mode };
      }
    }
    throwIfAborted(signal, "Working tree scan");

    const stats = {
      indexEntries: 0,
      hashed: 0,
      statOnly: 0,
      cacheHits: 0,
      walkedDirs: 0,
      durationMs: 0,
    };
    const limit = pLimit(this.opts.concurrency);

    // ---- untracked: pruned DFS (runs first: iterating directories warms the handle cache) ----
    const untracked: string[] = [];
    const untrackedInfo: Record<string, UntrackedInfo> = {};
    const tracked = (p: string) => index.byPath[p] !== undefined || conflictSet.has(p);
    const gitlinkDirs = new Set(
      index.entries.filter((e) => e.mode === MODE_GITLINK).map((e) => e.path),
    );
    const sparseSet = new Set(sparseDirs);
    let capped = false;
    const hashTasks: Promise<void>[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (capped) return;
      throwIfAborted(signal, "Working tree scan");
      let entries: { name: string; kind: "file" | "directory" }[];
      try {
        entries = await this.fs.readdirWithKinds(dir);
      } catch (err) {
        if (code(err) === "ENOENT" || code(err) === "ENOTDIR") return;
        throw err;
      }
      stats.walkedDirs++;
      if (dir !== "" && entries.some((en) => en.name === ".git")) {
        warnOnce({
          code: "EMBEDDED_REPO",
          message: `${dir}/ contains its own .git and was skipped (embedded repository).`,
        });
        return;
      }
      await this.ignore.enterDir(dir);
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const en of entries) {
        if (capped) return;
        const path = dir === "" ? en.name : `${dir}/${en.name}`;
        if (dir === "" && en.name === ".git") continue;
        if (en.kind === "directory") {
          if (sparseSet.has(path) || gitlinkDirs.has(path)) continue;
          if (this.ignore.isDirIgnored(path)) continue;
          await walk(path);
        } else {
          if (tracked(path)) continue;
          if (this.ignore.isFileIgnored(path)) continue;
          if (untracked.length >= this.opts.maxUntracked) {
            capped = true;
            warnOnce({
              code: "UNTRACKED_CAPPED",
              message: `More than ${this.opts.maxUntracked} untracked files; the list was cut off.`,
            });
            return;
          }
          untracked.push(path);
          hashTasks.push(
            limit(async () => {
              try {
                const f = await this.fs.openFile(path);
                const oid =
                  f.size <= this.opts.hashUntrackedUpTo
                    ? await hashBlob(new Uint8Array(await f.arrayBuffer()))
                    : null;
                if (oid) stats.hashed++;
                untrackedInfo[path] = { oid, size: f.size, lastModified: f.lastModified };
              } catch (err) {
                if (code(err) === "ENOENT" || code(err) === "EISDIR") return; // vanished mid-scan
                throw err;
              }
            }),
          );
        }
      }
    };
    await walk("");
    await Promise.all(hashTasks);
    // a file that vanished while hashing is dropped from the list
    const finalUntracked = sortPaths(untracked.filter((p) => untrackedInfo[p] !== undefined));

    // ---- unstaged: worktree vs index, per stage-0 entry ----
    const unstaged: Record<string, Change> = {};
    const hashAll = this.hashAll;
    this.hashAll = false;
    const tasks: Promise<void>[] = [];
    for (const e of index.entries) {
      if (e.stage !== 0 || e.isSparseDir || underSparse(e.path)) continue;
      stats.indexEntries++;
      if (e.assumeValid || e.skipWorktree) continue;
      if (e.mode === MODE_SYMLINK || e.mode === MODE_GITLINK) continue; // documented: always clean
      tasks.push(
        limit(async () => {
          throwIfAborted(signal, "Working tree scan");
          let f: FileLike;
          try {
            f = await this.fs.openFile(e.path);
          } catch (err) {
            const c = code(err);
            if (c === "ENOENT" || c === "ENOTDIR") {
              unstaged[e.path] = { oldOid: e.oid, newOid: null, oldMode: e.mode, newMode: null };
              return;
            }
            if (c === "EISDIR") {
              unstaged[e.path] = { oldOid: e.oid, newOid: null, oldMode: e.mode, newMode: null };
              warnOnce({
                code: "PATH_TYPE_CHANGED",
                message: `${e.path} is now a directory; it is shown as deleted.`,
              });
              return;
            }
            throw err;
          }
          if (e.intentToAdd) {
            const oid = await this.hashFile(e.path, f);
            stats.hashed++;
            unstaged[e.path] = {
              oldOid: null,
              newOid: oid,
              oldMode: null,
              newMode: e.mode,
              newSize: f.size,
              newLastModified: f.lastModified,
            };
            return;
          }
          let oid: Oid;
          const cached = this.statCache.get(e.path);
          if (
            !hashAll &&
            cached &&
            cached.size === f.size &&
            cached.lastModified === f.lastModified
          ) {
            oid = cached.oid;
            stats.cacheHits++;
          } else if (
            !hashAll &&
            f.lastModified < index.indexMtimeMs && // git's racy-clean rule: stat data newer than the index cannot be trusted
            f.size === e.size &&
            f.lastModified === entryMtimeMs(e)
          ) {
            stats.statOnly++;
            return; // clean by stat
          } else {
            oid = await this.hashFile(e.path, f);
            stats.hashed++;
          }
          if (oid !== e.oid) {
            unstaged[e.path] = {
              oldOid: e.oid,
              newOid: oid,
              oldMode: e.mode,
              newMode: e.mode,
              newSize: f.size,
              newLastModified: f.lastModified,
            };
          }
        }),
      );
    }
    await Promise.all(tasks);
    throwIfAborted(signal, "Working tree scan");

    stats.durationMs = performance.now() - t0;
    return {
      staged,
      unstaged,
      untracked: finalUntracked,
      untrackedInfo,
      conflicts: sortPaths([...conflictSet]),
      warnings,
      stats,
    };
  }
}
