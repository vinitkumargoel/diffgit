/**
 * RepoSession (T3.5): one object per open repository that exposes the whole engine to the UI.
 * Owns the FsaFs, ObjectDb, refs, ignore/attribute rules, scanner, DiffEngine; stamps every
 * DiffResult with a generation so results computed from an old side table are never served (STALE);
 * runs the background stats queue (LIFO, `prioritise()` moves visible rows to the front) and the
 * three probe tiers for the polling fallback. Every error leaving the session is translated to a
 * public code by `toPublicError` (used by the worker boundary).
 */
import type {
  EngineApi,
  EngineMetrics,
  FileDiffOptions,
  FileDiffPayload,
  FileStats,
  InvalidateScope,
  ProbeTier,
  Progress,
  ProgressSink,
  PublicError,
} from "./api";
import { isImagePath } from "./diff/binary";
import { loadSide, loadSides } from "./diff/contentLoader";
import { type DiffComputation, DiffEngine } from "./diff/diffEngine";
import { detectRenames } from "./diff/renames";
import { describeFile, LARGE_FILE_BYTES, toPayload } from "./diff/textDiff";
import { EngineError, type EngineErrorJSON, errorCode, isPublicCode } from "./errors";
import type { DirHandleLike } from "./fs/dirHandleLike";
import { createFsaFs, type FsaFs } from "./fs/fsaFs";
import { GitAttributes } from "./git/attributes";
import { type GitConfig, loadGitConfig } from "./git/config";
import { sha1, toHex } from "./git/hash";
import { IgnoreRules } from "./git/ignoreRules";
import { type IndexSnapshot, readIndex } from "./git/indexReader";
import { checkLayout } from "./git/layoutChecks";
import { ObjectDb } from "./git/objectDb";
import { loadRefs } from "./git/refStore";
import { type ScannerOptions, WorktreeScanner } from "./git/worktree";
import type {
  DiffResult,
  DiffSource,
  FileDiff,
  RefSnapshot,
  RepoCapabilities,
  RepoInfo,
  RepoWarning,
} from "./types";
import { CancelledError, pLimit, throwIfAborted } from "./util/concurrency";

export interface SessionOptions {
  scanner?: ScannerOptions;
  /** Background stats concurrency (default 4). */
  statsConcurrency?: number;
  /** Flush a stats batch after this many files or this many ms, whichever first. */
  statsBatchSize?: number;
  statsBatchMs?: number;
  /** Fixed repo id (tests/recordings); default `crypto.randomUUID()`. */
  id?: string;
}

interface Current {
  generation: number;
  source: DiffSource;
  comp: DiffComputation;
  result: DiffResult;
  byId: Map<string, FileDiff>;
  stats: Map<string, FileStats>;
}

const NO_SESSION = () => new EngineError("INTERNAL", "No repository is open.");
/** Plan §11 R3: warn when the packs read so far exceed this. */
export const MEMORY_WARN_BYTES = 300 * 1024 * 1024;

/** Translate anything thrown inside the engine into the plain object that crosses the worker boundary. */
export function toPublicError(e: unknown, rootGone = false): PublicError {
  const code = errorCode(e);
  const message =
    e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown engine error";
  const hint = (e as { hint?: unknown } | null)?.hint;
  const out = (c: PublicError["code"], msg = message, h?: string): PublicError => {
    const json: PublicError = { name: "EngineError", code: c, message: msg };
    const finalHint = h ?? (typeof hint === "string" ? hint : undefined);
    if (finalHint !== undefined) json.hint = finalHint;
    const path = (e as { path?: unknown } | null)?.path;
    if (typeof path === "string") (json as EngineErrorJSON).path = path;
    return json;
  };
  if (code !== undefined && isPublicCode(code)) return out(code);
  switch (code) {
    case "EACCES":
      return out("PERMISSION", message, "Grant read access to the folder and try again.");
    case "ENOENT":
      return rootGone
        ? out("HANDLE_GONE", "The repository folder is no longer reachable.", "Re-open the folder.")
        : out("IO_ERROR");
    case "EIO":
    case "EISDIR":
    case "ENOTDIR":
    case "EINVAL":
      return out("IO_ERROR");
    default:
      break;
  }
  if (e instanceof DOMException || (e as { name?: string } | null)?.name?.endsWith("Error")) {
    const name = (e as { name: string }).name;
    if (name === "NotAllowedError" || name === "SecurityError")
      return out("PERMISSION", message, "Grant read access to the folder and try again.");
    if (name === "NotFoundError")
      return out(
        "HANDLE_GONE",
        "The repository folder is no longer reachable.",
        "Re-open the folder.",
      );
  }
  return out("INTERNAL");
}

export class RepoSession implements Omit<EngineApi, "open"> {
  private gen = 0;
  private current: Current | null = null;
  private inflight: AbortController | null = null;
  private readonly fileDiffAborts = new Map<string, AbortController>();
  private statsQueue: string[] = []; // LIFO: pop() serves the most recently prioritised id
  private statsGen = 0;
  private statsActive = 0;
  private lastSource: DiffSource | null = null;
  private closed = false;
  private computes = 0;
  private lastCompute: EngineMetrics["lastCompute"] = null;
  private statsStartedAt = 0;
  private memoryWarned = false;
  private readonly repoWarnings: RepoWarning[] = [];
  private readonly statsLimit: <T>(fn: () => Promise<T>) => Promise<T>;

  private constructor(
    readonly root: DirHandleLike,
    readonly fs: FsaFs,
    readonly cfg: GitConfig,
    readonly db: ObjectDb,
    private refs: RefSnapshot,
    readonly ignore: IgnoreRules,
    readonly attrs: GitAttributes,
    readonly scanner: WorktreeScanner,
    readonly engine: DiffEngine,
    private capabilities: RepoCapabilities,
    private readonly sink: ProgressSink,
    private readonly id: string,
    private readonly opts: SessionOptions,
  ) {
    this.statsLimit = pLimit(opts.statsConcurrency ?? 4);
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  static async open(
    root: DirHandleLike,
    sink: ProgressSink,
    opts: SessionOptions = {},
  ): Promise<RepoSession> {
    const fs = createFsaFs(root);
    const t0 = performance.now();
    const cfg = await loadGitConfig(fs);
    RepoSession.emit(sink, { phase: "config", durationMs: performance.now() - t0 });
    const t1 = performance.now();
    const layout = await checkLayout(fs, cfg);
    RepoSession.emit(sink, { phase: "layout", durationMs: performance.now() - t1 });
    if (!layout.ok || layout.fatal) {
      const f = layout.fatal ?? {
        code: "NOT_A_REPO" as const,
        message: "The folder is not a git repository.",
        hint: "Pick the folder that contains .git",
      };
      throw new EngineError(f.code, f.message, { hint: f.hint });
    }
    const warnings: RepoWarning[] = [...cfg.warnings, ...layout.warnings];
    const db = new ObjectDb(fs, (w) => {
      warnings.push(w);
      RepoSession.emitWarning(sink, w);
    });
    const t2 = performance.now();
    const refs = await loadRefs(db, cfg);
    RepoSession.emit(sink, { phase: "refs", durationMs: performance.now() - t2 });
    const t3 = performance.now();
    const capabilities = { ...layout.capabilities };
    try {
      const index = await readIndex(fs);
      capabilities.indexVersion = index.version as RepoCapabilities["indexVersion"];
      capabilities.hasSplitIndex = index.hasSplitIndex;
      capabilities.hasSparseIndex = index.hasSparseIndex;
      if (!index.checksumOk)
        warnings.push({
          code: "INDEX_CHECKSUM",
          message: "The git index checksum does not match; it may be mid-write.",
        });
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e; // unborn repos have no index yet
    }
    RepoSession.emit(sink, { phase: "index", durationMs: performance.now() - t3 });
    const ignore = await IgnoreRules.load(fs, { config: cfg });
    warnings.push(...ignore.warnings);
    const attrs = await GitAttributes.load(fs);
    const scanner = new WorktreeScanner(fs, db, cfg, ignore, opts.scanner);
    const engine = new DiffEngine(db, refs, scanner, () => readIndex(fs), {
      shallow: warnings.some((w) => w.code === "SHALLOW"),
    });
    const session = new RepoSession(
      root,
      fs,
      cfg,
      db,
      refs,
      ignore,
      attrs,
      scanner,
      engine,
      capabilities,
      sink,
      opts.id ?? crypto.randomUUID(),
      opts,
    );
    session.repoWarnings.push(...dedupe(warnings));
    return session;
  }

  private static emit(sink: ProgressSink, p: Progress): void {
    try {
      void sink.onProgress(p);
    } catch {
      /* a dead sink must never break the engine */
    }
  }

  private static emitWarning(sink: ProgressSink, w: RepoWarning): void {
    try {
      void sink.onWarning(w);
    } catch {
      /* see above */
    }
  }

  private progress(p: Progress): void {
    RepoSession.emit(this.sink, p);
  }

  async info(): Promise<RepoInfo> {
    return this.buildInfo();
  }

  private buildInfo(): RepoInfo {
    return {
      id: this.id,
      name: this.root.name,
      headBranch: this.refs.headBranch,
      headOid: this.refs.headOid,
      detached: this.refs.detached,
      unborn: this.refs.unborn,
      headDisplay: this.refs.headDisplay,
      refs: this.refs.refs,
      defaultRef: this.refs.defaultRef,
      capabilities: this.capabilities,
      warnings: this.repoWarnings.slice(),
    };
  }

  async reloadRefs(): Promise<RepoInfo> {
    this.assertOpen();
    const t0 = performance.now();
    this.db.dropCaches(true);
    this.fs.invalidatePath("/.git");
    this.refs = await this.withRootCheck(() => loadRefs(this.db, this.cfg));
    this.engine.updateRefs(this.refs);
    this.progress({ phase: "refs", durationMs: performance.now() - t0 });
    return this.buildInfo();
  }

  // ---- diff -----------------------------------------------------------------------------------

  async computeDiff(src: DiffSource): Promise<DiffResult> {
    this.assertOpen();
    this.inflight?.abort();
    const ac = new AbortController();
    this.inflight = ac;
    const generation = ++this.gen;
    this.stopStats();
    this.lastSource = src;
    const started = performance.now();
    try {
      const comp = await this.withStaleRetry(() => this.engine.compute(src, ac.signal), ac.signal);
      throwIfAborted(ac.signal, "diff");
      this.progress({
        phase: "diff",
        durationMs: performance.now() - started,
        total: comp.files.length,
      });
      const files = await this.applyRenames(comp, ac.signal);
      throwIfAborted(ac.signal, "diff");
      const result: DiffResult = {
        source: { ...src, includeWorktree: comp.includeWorktree },
        mergeBase: comp.mergeBase,
        files,
        totals: { files: files.length, additions: 0, deletions: 0 },
        computedAt: Date.now(),
        durationMs: performance.now() - started,
        generation,
        warnings: comp.warnings,
      };
      this.current = {
        generation,
        source: src,
        comp,
        result,
        byId: new Map(files.map((f) => [f.id, f])),
        stats: new Map(),
      };
      this.computes++;
      this.lastCompute = { files: files.length, durationMs: result.durationMs, statsMs: null };
      this.statsStartedAt = performance.now();
      this.checkMemory();
      this.startStats(generation);
      return result;
    } catch (e) {
      if (ac.signal.aborted && !(e instanceof CancelledError)) throw new CancelledError("diff");
      throw e;
    } finally {
      if (this.inflight === ac) this.inflight = null;
    }
  }

  private async applyRenames(comp: DiffComputation, signal: AbortSignal): Promise<FileDiff[]> {
    const t0 = performance.now();
    let files = comp.files;
    if (this.cfg.diff.renames !== false) {
      const src = { db: this.db, fs: this.fs };
      const res = await detectRenames(
        files,
        async (f, side) => (await loadSide(f, side, comp.sides, src, signal)) ?? new Uint8Array(),
        { limit: this.cfg.diff.renameLimit, signal },
      );
      files = res.files;
      for (const w of res.warnings) comp.warnings.push(w);
    }
    for (const f of files) {
      f.image = isImagePath(f.id);
      if (f.oldSize > LARGE_FILE_BYTES || f.newSize > LARGE_FILE_BYTES) f.tooLarge = true;
    }
    this.progress({ phase: "renames", durationMs: performance.now() - t0 });
    return files;
  }

  /** Object reads that hit a pack renamed by `git gc` → drop caches and retry once (amendment). */
  private async withStaleRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await this.withRootCheck(fn);
    } catch (e) {
      const code = errorCode(e);
      if (signal.aborted || (code !== "ENOENT" && code !== "IO_ERROR")) throw e;
      this.db.dropCaches(true);
      this.fs.invalidateAll();
      this.ignore.invalidate();
      this.attrs.invalidate();
      const w: RepoWarning = {
        code: "STALE_PACK_RETRIED",
        message: "Repository files changed while reading; the computation was retried.",
      };
      const out = await this.withRootCheck(fn);
      if (isDiffComputation(out) && !out.warnings.some((x) => x.code === w.code))
        out.warnings.push(w);
      return out;
    }
  }

  /** Any failure while the root itself is unreachable → HANDLE_GONE (a missing ref file or object
   *  would otherwise surface as REF_NOT_FOUND / IO_ERROR). */
  private async withRootCheck<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const code = errorCode(e);
      if (code !== "CANCELLED" && code !== "STALE" && !(await this.rootReachable())) {
        throw new EngineError("HANDLE_GONE", "The repository folder is no longer reachable.", {
          hint: "Re-open the folder.",
          cause: e,
        });
      }
      throw e;
    }
  }

  private async rootReachable(): Promise<boolean> {
    try {
      await this.root.getDirectoryHandle(".git");
      return true;
    } catch {
      try {
        await this.root.getFileHandle(".git"); // worktree-gitdir layout
        return true;
      } catch {
        return false;
      }
    }
  }

  private requireGeneration(generation: number): Current {
    this.assertOpen();
    const cur = this.current;
    if (!cur || cur.generation !== generation) {
      throw new EngineError(
        "STALE",
        `Diff generation ${generation} is no longer current${cur ? ` (now ${cur.generation})` : ""}.`,
      );
    }
    return cur;
  }

  private requireFile(cur: Current, id: string): FileDiff {
    const f = cur.byId.get(id);
    if (!f)
      throw new EngineError("INTERNAL", `Unknown file id "${id}" in generation ${cur.generation}.`);
    return f;
  }

  // ---- per-file -------------------------------------------------------------------------------

  private async statsFor(cur: Current, f: FileDiff, signal?: AbortSignal): Promise<FileStats> {
    const cached = cur.stats.get(f.id);
    if (cached !== undefined) return cached;
    const loaded = await loadSides(f, cur.comp.sides, { db: this.db, fs: this.fs }, signal);
    const path = (f.newPath ?? f.oldPath) as string;
    const d = describeFile(f, loaded, {
      ignoreWhitespace: false,
      statsOnly: true,
      attrBinary: await this.attrs.isBinary(path),
      attrGenerated: await this.attrs.isGenerated(path),
    });
    this.applyDescription(f, d);
    cur.stats.set(f.id, d.stats);
    return d.stats;
  }

  private applyDescription(f: FileDiff, d: ReturnType<typeof describeFile>): void {
    f.stats = d.stats;
    f.binary = d.classification.binary;
    f.image = d.classification.image;
    f.tooLarge = d.classification.tooLarge;
    f.oldSize = d.classification.oldSize;
    f.newSize = d.classification.newSize;
    if (d.classification.generated) f.generated = true;
  }

  async fileStats(generation: number, ids: string[]): Promise<Record<string, FileStats>> {
    const cur = this.requireGeneration(generation);
    const out: Record<string, FileStats> = {};
    await Promise.all(
      ids.map((id) =>
        this.statsLimit(async () => {
          const f = this.requireFile(cur, id);
          out[id] = await this.statsFor(cur, f);
        }),
      ),
    );
    return out;
  }

  async fileDiff(generation: number, id: string, opts: FileDiffOptions): Promise<FileDiffPayload> {
    const cur = this.requireGeneration(generation);
    const f = this.requireFile(cur, id);
    this.fileDiffAborts.get(id)?.abort();
    const ac = new AbortController();
    this.fileDiffAborts.set(id, ac);
    try {
      const loaded = await loadSides(f, cur.comp.sides, { db: this.db, fs: this.fs }, ac.signal);
      throwIfAborted(ac.signal, "file diff");
      const path = (f.newPath ?? f.oldPath) as string;
      const d = describeFile(f, loaded, {
        ignoreWhitespace: opts.ignoreWhitespace,
        loadLarge: opts.loadLarge,
        attrBinary: await this.attrs.isBinary(path),
        attrGenerated: await this.attrs.isGenerated(path),
      });
      if (this.current === cur) {
        this.applyDescription(f, d);
        if (!cur.stats.has(f.id)) cur.stats.set(f.id, d.stats);
      }
      if (d.warning) RepoSession.emitWarning(this.sink, d.warning);
      return toPayload(f, d, generation);
    } catch (e) {
      if (ac.signal.aborted && !(e instanceof CancelledError))
        throw new CancelledError("file diff");
      throw e;
    } finally {
      if (this.fileDiffAborts.get(id) === ac) this.fileDiffAborts.delete(id);
    }
  }

  async cancelFileDiff(id: string): Promise<void> {
    this.fileDiffAborts.get(id)?.abort();
    this.fileDiffAborts.delete(id);
  }

  async fileBytes(generation: number, id: string, side: "old" | "new"): Promise<Uint8Array | null> {
    const cur = this.requireGeneration(generation);
    const f = this.requireFile(cur, id);
    return loadSide(f, side, cur.comp.sides, { db: this.db, fs: this.fs });
  }

  // ---- background stats -----------------------------------------------------------------------

  private startStats(generation: number): void {
    const cur = this.current;
    if (!cur) return;
    this.statsGen = generation;
    // LIFO: push in path order so the top of the list (first rows) is served first.
    this.statsQueue = cur.result.files.map((f) => f.id).reverse();
    void this.pumpStats(cur);
  }

  private stopStats(): void {
    this.statsQueue = [];
    this.statsGen = -1;
  }

  async prioritise(ids: string[]): Promise<void> {
    if (!this.current || this.statsGen !== this.current.generation) return;
    const wanted = new Set(ids);
    this.statsQueue = this.statsQueue.filter((id) => !wanted.has(id));
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i] as string;
      if (this.current.byId.has(id) && !this.current.stats.has(id)) this.statsQueue.push(id);
    }
  }

  private async pumpStats(cur: Current): Promise<void> {
    if (this.statsActive > 0) return; // the running pump picks up the new queue
    this.statsActive++;
    const batchSize = this.opts.statsBatchSize ?? 32;
    const batchMs = this.opts.statsBatchMs ?? 100;
    let batch: Record<string, FileStats> = {};
    let batchCount = 0;
    let batchStarted = performance.now();
    let done = 0;
    const total = cur.result.files.length;
    const flush = () => {
      if (batchCount === 0) return;
      try {
        void this.sink.onStats({ generation: cur.generation, stats: batch });
      } catch {
        /* dead sink */
      }
      batch = {};
      batchCount = 0;
      batchStarted = performance.now();
      this.progress({ phase: "stats", done, total });
    };
    try {
      const workers: Promise<void>[] = [];
      const concurrency = this.opts.statsConcurrency ?? 4;
      for (let w = 0; w < concurrency; w++) {
        workers.push(
          (async () => {
            while (this.statsGen === cur.generation && this.current === cur && !this.closed) {
              const id = this.statsQueue.pop();
              if (id === undefined) return;
              const f = cur.byId.get(id);
              if (!f || cur.stats.has(id)) continue;
              try {
                const s = await this.statsFor(cur, f);
                if (this.current !== cur) return;
                batch[id] = s;
                batchCount++;
                done++;
                if (batchCount >= batchSize || performance.now() - batchStarted > batchMs) flush();
              } catch (e) {
                if (this.current !== cur) return;
                cur.stats.set(id, null);
                batch[id] = null;
                batchCount++;
                done++;
                RepoSession.emitWarning(this.sink, {
                  code: "FILE_TOO_LARGE",
                  message: `Could not compute stats for ${id}: ${(e as Error).message}`,
                  detail: id,
                });
              }
            }
          })(),
        );
      }
      await Promise.all(workers);
      if (this.current === cur) {
        flush();
        if (this.lastCompute) this.lastCompute.statsMs = performance.now() - this.statsStartedAt;
      }
    } finally {
      this.statsActive--;
    }
  }

  // ---- metrics (T7.2) -------------------------------------------------------------------------

  /** R3 memory guard: isomorphic-git keeps every pack it has read; warn once above 300 MB. */
  private checkMemory(): void {
    if (this.memoryWarned) return;
    const { packBytes } = this.fs.ioStats();
    if (packBytes > MEMORY_WARN_BYTES) {
      this.memoryWarned = true;
      RepoSession.emitWarning(this.sink, {
        code: "PACK_LARGE",
        message: `About ${Math.round(packBytes / (1024 * 1024))} MB of pack data is held in memory; reload the tab if it becomes sluggish.`,
        detail: "memory",
      });
    }
  }

  async metrics(): Promise<EngineMetrics> {
    const io = this.fs.ioStats();
    return {
      generation: this.gen,
      computes: this.computes,
      handleCache: this.fs.cacheSize(),
      io,
      memoryEstimate: io.packBytes,
      lastCompute: this.lastCompute ? { ...this.lastCompute } : null,
    };
  }

  // ---- probes (polling fallback, T6.3) --------------------------------------------------------

  async probe(tier: ProbeTier): Promise<string> {
    this.assertOpen();
    const t0 = performance.now();
    let sig: string;
    if (tier === "git") sig = await this.probeGit();
    else if (tier === "index") sig = await this.probeIndex();
    else sig = await this.probeUntracked();
    this.progress({ phase: "probe", tier, durationMs: performance.now() - t0 });
    return sig;
  }

  private async statSig(path: string): Promise<string> {
    try {
      const s = await this.fs.stat(path);
      return `${path}=${s.mtimeMs}:${s.size}`;
    } catch (e) {
      if (errorCode(e) === "ENOENT" || errorCode(e) === "ENOTDIR") return `${path}=-`;
      throw e;
    }
  }

  private async probeGit(): Promise<string> {
    const paths = new Set<string>([
      "/.git/HEAD",
      "/.git/index",
      "/.git/packed-refs",
      "/.git/config",
      "/.git/info/exclude",
      "/.git/ORIG_HEAD",
    ]);
    if (this.refs.headBranch) paths.add(`/.git/refs/heads/${this.refs.headBranch}`);
    for (const ref of [this.lastSource?.sourceRef, this.lastSource?.targetRef]) {
      if (ref && ref !== "HEAD") paths.add(`/.git/${ref}`);
    }
    try {
      for (const remote of await this.fs.readdirWithKinds("/.git/refs/remotes")) {
        if (remote.kind === "directory") paths.add(`/.git/refs/remotes/${remote.name}/HEAD`);
      }
    } catch (e) {
      if (errorCode(e) !== "ENOENT" && errorCode(e) !== "ENOTDIR") throw e;
    }
    const parts = await Promise.all([...paths].sort().map((p) => this.statSig(p)));
    return `git:${await digest(parts.join("\n"))}`;
  }

  private async probeIndex(): Promise<string> {
    let index: IndexSnapshot;
    try {
      index = await readIndex(this.fs);
    } catch (e) {
      if (errorCode(e) === "ENOENT") return "index:none";
      throw e;
    }
    const parts: string[] = [];
    for (const e of index.entries) {
      if (e.stage !== 0) continue;
      parts.push(`${e.path}\t${e.size}\t${e.mtimeSec}.${e.mtimeNsec}\t${e.oid}`);
    }
    return `index:${index.entries.length}:${await digest(parts.join("\n"))}`;
  }

  /** Ignore-pruned walk of untracked paths straight off the handles (no FsaFs cache), count + hash. */
  private async probeUntracked(): Promise<string> {
    let tracked = new Set<string>();
    try {
      const index = await readIndex(this.fs);
      tracked = new Set(index.entries.map((e) => e.path));
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
    const found: string[] = [];
    const walk = async (dir: DirHandleLike, prefix: string): Promise<void> => {
      if (prefix) await this.ignore.enterDir(prefix);
      for await (const [name, h] of dir.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (h.kind === "directory") {
          if (path === ".git" || this.ignore.isDirIgnored(path)) continue;
          await walk(h, path);
        } else if (!tracked.has(path) && !this.ignore.isFileIgnored(path)) found.push(path);
      }
    };
    await this.ignore.enterDir("");
    await walk(this.root, "");
    found.sort();
    return `untracked:${found.length}:${await digest(found.join("\n"))}`;
  }

  // ---- invalidation ---------------------------------------------------------------------------

  async invalidate(scope: InvalidateScope, paths?: string[]): Promise<void> {
    this.assertOpen();
    if (scope === "refs") {
      this.db.dropCaches(true);
      this.fs.invalidatePath("/.git");
      return;
    }
    if (scope === "worktree") {
      if (paths && paths.length > 0) {
        for (const p of paths) this.fs.invalidatePath(`/${p.replace(/^\/+/, "")}`);
        this.scanner.forgetPaths(paths);
        if (paths.some((p) => /(^|\/)\.gitignore$/.test(p))) this.ignore.invalidate();
        if (paths.some((p) => /(^|\/)\.gitattributes$/.test(p))) this.attrs.invalidate();
      } else {
        this.fs.invalidateAll();
        this.ignore.invalidate();
        this.attrs.invalidate();
      }
      return;
    }
    this.fs.invalidateAll();
    this.db.dropCaches(true);
    this.ignore.invalidate();
    this.attrs.invalidate();
  }

  async forceRehash(): Promise<void> {
    this.assertOpen();
    this.scanner.forgetStatCache();
    this.fs.invalidateAll();
    this.db.dropCaches(true);
    this.ignore.invalidate();
    this.attrs.invalidate();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.inflight?.abort();
    for (const ac of this.fileDiffAborts.values()) ac.abort();
    this.fileDiffAborts.clear();
    this.stopStats();
    this.current = null;
    this.db.dropCaches(true);
    this.fs.invalidateAll();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw NO_SESSION();
  }
}

function isDiffComputation(v: unknown): v is DiffComputation {
  return typeof v === "object" && v !== null && Array.isArray((v as DiffComputation).warnings);
}

function dedupe(ws: RepoWarning[]): RepoWarning[] {
  const seen = new Set<string>();
  return ws.filter((w) => {
    const k = `${w.code}:${w.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function digest(s: string): Promise<string> {
  return toHex(await sha1(new TextEncoder().encode(s))).slice(0, 16);
}
