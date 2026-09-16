/**
 * ObjectDb (T1.3, Plan §5.2): the only place that calls isomorphic-git. Pure reads, one shared
 * `cache` object per session, memoised flattened trees, stale-pack retry.
 *
 * Allowed isomorphic-git calls: resolveRef, listBranches, readCommit, readTree, readBlob,
 * findMergeBase (and walk(TREE) / listRemotes if ever needed). Nothing here may write.
 */
import git from "isomorphic-git";
import { EngineError } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { Oid, RepoWarning } from "../types";

export type FlatTree = Record<string, { oid: Oid; mode: number }>;

export interface CommitInfo {
  oid: Oid;
  tree: Oid;
  parents: Oid[];
  message: string;
}

export interface MergeBaseResult {
  oid: Oid | null; // all[0]; null when unrelated or history is missing (shallow)
  all: Oid[];
}

const DIR = "/";
const OID_RE = /^[0-9a-f]{40}$/;

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

/** isomorphic-git reports a vanished/unreadable pack as an InternalError with this text. */
function isStalePackError(e: unknown): boolean {
  const msg = String((e as { message?: unknown } | null)?.message ?? "");
  return (
    /Could not read packfile/i.test(msg) ||
    /Packfile trailer mismatch/i.test(msg) ||
    /Packfile payload corrupted/i.test(msg) ||
    ((errCode(e) === "ENOENT" || errCode(e) === "EIO") && /\.(pack|idx)\b/.test(msg))
  );
}

export class ObjectDb {
  private cache: object = {};
  private trees = new Map<Oid, Promise<FlatTree>>();
  private readonly warnings: RepoWarning[] = [];

  constructor(
    private readonly fs: FsaFs,
    private readonly onWarning?: (w: RepoWarning) => void,
  ) {}

  /** Warnings emitted so far by this instance (e.g. STALE_PACK_RETRIED). */
  get emittedWarnings(): readonly RepoWarning[] {
    return this.warnings;
  }

  private warn(w: RepoWarning): void {
    this.warnings.push(w);
    this.onWarning?.(w);
  }

  /**
   * Drops memoised trees. With `includePacks` also replaces the isomorphic-git cache object (pack
   * indexes, loaded packs, packed-refs) — used after `git gc` renamed packs or on force refresh.
   */
  dropCaches(includePacks = false): void {
    this.trees.clear();
    if (includePacks) this.cache = {};
  }

  /** Runs an object read; on a stale-pack failure drops the pack cache and retries once. */
  private async withStalePackRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!isStalePackError(e)) throw e;
      this.dropCaches(true);
      this.fs.invalidatePath(".git/objects");
      this.warn({
        code: "STALE_PACK_RETRIED",
        message:
          "Pack files changed while reading (git gc?); caches were dropped and the read retried.",
      });
      return fn();
    }
  }

  private notFound(ref: string, cause: unknown): EngineError {
    return new EngineError("REF_NOT_FOUND", `Reference not found: ${ref}`, {
      cause,
      hint: "Pick another branch",
    });
  }

  /** Always an oid. Accepts "HEAD", "main", "origin/main", "refs/heads/x", or a 40-hex oid. */
  async resolveRef(ref: string): Promise<Oid> {
    if (OID_RE.test(ref)) return ref;
    try {
      return await git.resolveRef({ fs: this.fs, dir: DIR, ref });
    } catch (e) {
      if (errCode(e) === "NotFoundError") throw this.notFound(ref, e);
      throw e;
    }
  }

  async tryResolveRef(ref: string): Promise<Oid | null> {
    try {
      return await this.resolveRef(ref);
    } catch (e) {
      if (errCode(e) === "REF_NOT_FOUND") return null;
      throw e;
    }
  }

  /**
   * Raw read of a loose ref file (`.git/<ref>`). Returns the target ref when the file is a symref
   * (`ref: refs/remotes/origin/main`), otherwise null (absent, or a plain oid). `packed-refs`
   * never holds symrefs, so `origin/HEAD` is always found here or not at all.
   */
  async readSymref(ref: string): Promise<string | null> {
    let text: string;
    try {
      text = await this.fs.readText(`.git/${ref}`);
    } catch (e) {
      if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR" || errCode(e) === "EISDIR")
        return null;
      throw e;
    }
    const line = text.trim();
    return line.startsWith("ref: ") ? line.slice(5).trim() : null;
  }

  async listLocalBranches(): Promise<string[]> {
    return git.listBranches({ fs: this.fs, dir: DIR });
  }

  /** Branch names under `refs/remotes/<remote>/`, without the `HEAD` pseudo-entry. */
  async listRemoteBranches(remote: string): Promise<string[]> {
    const names = await git.listBranches({ fs: this.fs, dir: DIR, remote });
    return names.filter((n) => n !== "HEAD");
  }

  async readCommit(oid: Oid): Promise<CommitInfo> {
    return this.withStalePackRetry(async () => {
      const r = await git.readCommit({ fs: this.fs, dir: DIR, oid, cache: this.cache });
      return {
        oid: r.oid,
        tree: r.commit.tree,
        parents: r.commit.parent,
        message: r.commit.message,
      };
    });
  }

  async readBlob(oid: Oid): Promise<Uint8Array> {
    return this.withStalePackRetry(async () => {
      const r = await git.readBlob({ fs: this.fs, dir: DIR, oid, cache: this.cache });
      return r.blob;
    });
  }

  /**
   * Merge bases of `a` and `b` (git's `--all` set). `oid` is `all[0]`. Unrelated histories or missing
   * ancestors (shallow clone) yield `{ oid: null, all: [] }` — never throws for those.
   */
  async findMergeBase(a: Oid, b: Oid): Promise<MergeBaseResult> {
    if (a === b) return { oid: a, all: [a] };
    try {
      const all = (await this.withStalePackRetry(() =>
        git.findMergeBase({ fs: this.fs, dir: DIR, oids: [a, b], cache: this.cache }),
      )) as Oid[];
      return { oid: all[0] ?? null, all };
    } catch (e) {
      if (errCode(e) === "NotFoundError") return { oid: null, all: [] };
      throw e;
    }
  }

  /**
   * Flattens a commit's or tree's contents to `path → {oid, mode}` (blobs and gitlinks only;
   * directories are recursed, not listed). Memoised per oid for the session.
   */
  flattenTree(commitOrTreeOid: Oid): Promise<FlatTree> {
    const cached = this.trees.get(commitOrTreeOid);
    if (cached) return cached;
    const p = this.withStalePackRetry(() => this.flattenUncached(commitOrTreeOid)).catch((e) => {
      this.trees.delete(commitOrTreeOid);
      throw e;
    });
    this.trees.set(commitOrTreeOid, p);
    return p;
  }

  private async flattenUncached(oid: Oid): Promise<FlatTree> {
    const out: FlatTree = {};
    const visit = async (treeOid: Oid, prefix: string): Promise<void> => {
      const { tree } = await git.readTree({
        fs: this.fs,
        dir: DIR,
        oid: treeOid,
        cache: this.cache,
      });
      const subdirs: Promise<void>[] = [];
      for (const entry of tree) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === "tree") subdirs.push(visit(entry.oid, path));
        else out[path] = { oid: entry.oid, mode: Number.parseInt(entry.mode, 8) };
      }
      await Promise.all(subdirs);
    };
    // readTree resolves a commit oid to its tree itself.
    await visit(oid, "");
    // git orders paths bytewise; consumers rely on sorted iteration
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}
