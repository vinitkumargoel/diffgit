/**
 * ObjectDb (T1.3, Plan §5.2): the only place that calls isomorphic-git. Pure reads, one shared
 * `cache` object per session, memoised flattened trees, stale-pack retry.
 *
 * Allowed isomorphic-git calls: resolveRef, listBranches, listTags, readObject, readCommit,
 * readTree, readBlob, readTag, readNote, expandOid, findMergeBase (and walk(TREE) / listRemotes if
 * ever needed). Nothing here may write.
 */
import git from "isomorphic-git";
import { EngineError, errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { Oid, RepoWarning } from "../types";

export type FlatTree = Record<string, { oid: Oid; mode: number }>;

/** A git identity line as isomorphic-git reports it: `timestamp` is epoch **seconds**. */
export interface RawSignature {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

export interface CommitInfo {
  oid: Oid;
  tree: Oid;
  parents: Oid[];
  message: string;
  /** T10.5: the identity lines and the signature header, for `CommitSummary`/`CommitDetails`. */
  author: RawSignature;
  committer: RawSignature;
  /** The `gpgsig` header, when the commit is signed. */
  gpgsig?: string;
}

export interface MergeBaseResult {
  oid: Oid | null; // all[0]; null when unrelated or history is missing (shallow)
  all: Oid[];
}

/** An annotated tag object (T10.1); `object` is what it points at, possibly another tag. */
export interface TagObjectInfo {
  oid: Oid;
  object: Oid;
  type: "blob" | "tree" | "commit" | "tag";
  tag: string;
  message: string;
  tagger?: { name: string; email: string; timestamp: number; timezoneOffset: number };
}

const DIR = "/";
const OID_RE = /^[0-9a-f]{40}$/;

/** isomorphic-git reports a vanished/unreadable pack as an InternalError with this text. */
function isStalePackError(e: unknown): boolean {
  const msg = String((e as { message?: unknown } | null)?.message ?? "");
  return (
    /Could not read packfile/i.test(msg) ||
    /Packfile trailer mismatch/i.test(msg) ||
    /Packfile payload corrupted/i.test(msg) ||
    ((errorCode(e) === "ENOENT" || errorCode(e) === "EIO") && /\.(pack|idx)\b/.test(msg))
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
      if (errorCode(e) === "NotFoundError") throw this.notFound(ref, e);
      throw e;
    }
  }

  async tryResolveRef(ref: string): Promise<Oid | null> {
    try {
      return await this.resolveRef(ref);
    } catch (e) {
      if (errorCode(e) === "REF_NOT_FOUND") return null;
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
      if (errorCode(e) === "ENOENT" || errorCode(e) === "ENOTDIR" || errorCode(e) === "EISDIR")
        return null;
      throw e;
    }
    const line = text.trim();
    return line.startsWith("ref: ") ? line.slice(5).trim() : null;
  }

  /**
   * Raw text of a file under `.git/` (e.g. `logs/refs/stash`); null when it does not exist.
   * `readSymref` is the ref-shaped cousin of this.
   */
  async readGitText(path: string): Promise<string | null> {
    try {
      return await this.fs.readText(`.git/${path}`);
    } catch (e) {
      const code = errorCode(e);
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
      throw e;
    }
  }

  async listLocalBranches(): Promise<string[]> {
    return git.listBranches({ fs: this.fs, dir: DIR });
  }

  /** Tag names (loose + packed-refs), without the `refs/tags/` prefix, sorted bytewise. */
  async listTagNames(): Promise<string[]> {
    const names = await git.listTags({ fs: this.fs, dir: DIR });
    return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Reads an annotated tag object; null when `oid` is not a tag (a lightweight tag's target). */
  async readTag(oid: Oid): Promise<TagObjectInfo | null> {
    return this.withStalePackRetry(async () => {
      try {
        const r = await git.readTag({ fs: this.fs, dir: DIR, oid, cache: this.cache });
        const out: TagObjectInfo = {
          oid: r.oid,
          object: r.tag.object,
          type: r.tag.type,
          tag: r.tag.tag,
          message: r.tag.message,
        };
        if (r.tag.tagger) out.tagger = r.tag.tagger;
        return out;
      } catch (e) {
        if (errorCode(e) === "ObjectTypeError") return null;
        throw e;
      }
    });
  }

  /**
   * Objects whose oid starts with `prefix` (loose + every pack index). Returns every candidate so
   * the caller can raise `REV_AMBIGUOUS` with the list; empty when nothing matches.
   */
  async expandOid(prefix: string): Promise<Oid[]> {
    return this.withStalePackRetry(async () => {
      try {
        return [await git.expandOid({ fs: this.fs, dir: DIR, oid: prefix, cache: this.cache })];
      } catch (e) {
        const code = errorCode(e);
        if (code === "NotFoundError") return [];
        if (code === "AmbiguousError") {
          const matches = (e as { data?: { matches?: unknown } }).data?.matches;
          return (Array.isArray(matches) ? (matches as Oid[]) : []).slice().sort();
        }
        throw e;
      }
    });
  }

  /** Branch names under `refs/remotes/<remote>/`, without the `HEAD` pseudo-entry. */
  async listRemoteBranches(remote: string): Promise<string[]> {
    const names = await git.listBranches({ fs: this.fs, dir: DIR, remote });
    return names.filter((n) => n !== "HEAD");
  }

  /**
   * The git object type of `oid`, or null when the database does not have it (T10.5b B1). A ref
   * can name a blob or a tree — git.git ships `refs/tags/junio-gpg-pub`, a blob — and everything
   * that walks history has to skip those instead of failing with an `ObjectTypeError`.
   */
  async objectType(oid: Oid): Promise<"blob" | "tree" | "commit" | "tag" | null> {
    return this.withStalePackRetry(async () => {
      try {
        const r = await git.readObject({
          fs: this.fs,
          dir: DIR,
          oid,
          format: "content",
          cache: this.cache,
        });
        return r.type as "blob" | "tree" | "commit" | "tag";
      } catch (e) {
        if (errorCode(e) === "NotFoundError") return null;
        throw e;
      }
    });
  }

  async readCommit(oid: Oid): Promise<CommitInfo> {
    return this.withStalePackRetry(async () => {
      const r = await git.readCommit({ fs: this.fs, dir: DIR, oid, cache: this.cache });
      const out: CommitInfo = {
        oid: r.oid,
        tree: r.commit.tree,
        parents: r.commit.parent,
        message: r.commit.message,
        author: r.commit.author,
        committer: r.commit.committer,
      };
      if (r.commit.gpgsig !== undefined) out.gpgsig = r.commit.gpgsig;
      return out;
    });
  }

  /**
   * The note `refs/notes/commits` attaches to `oid`, or null when there is none (T10.5). git's
   * notes trees are fanned out (`ab/cdef…`), which is why this goes through isomorphic-git rather
   * than a flat tree lookup.
   */
  async readNote(oid: Oid, ref = "refs/notes/commits"): Promise<string | null> {
    return this.withStalePackRetry(async () => {
      try {
        const bytes = await git.readNote({ fs: this.fs, dir: DIR, ref, oid, cache: this.cache });
        return new TextDecoder().decode(bytes);
      } catch (e) {
        const code = errorCode(e);
        // No notes ref at all, or no note for this commit: both are "there is no note".
        if (code === "NotFoundError" || code === "ENOENT") return null;
        throw e;
      }
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
      if (errorCode(e) === "NotFoundError") return { oid: null, all: [] };
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
