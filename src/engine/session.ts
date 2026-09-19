/**
 * RepoSession (T3.5): one object per open repository that exposes the whole engine to the UI.
 * Owns the FsaFs, ObjectDb, refs, ignore/attribute rules, scanner, DiffEngine; stamps every
 * DiffResult with a generation so results computed from an old side table are never served (STALE);
 * runs the background stats queue (LIFO, `prioritise()` moves visible rows to the front) and the
 * three probe tiers for the polling fallback. Every error leaving the session is translated to a
 * public code by `toPublicError` (used by the worker boundary).
 */
import type {
  BlameRequest,
  ConflictPayload,
  EngineApi,
  EngineMetrics,
  FileDiffOptions,
  FileDiffPayload,
  FileStats,
  InvalidateScope,
  PathHistoryOptions,
  ProbeTier,
  Progress,
  ProgressSink,
  PublicError,
} from "./api";
import { isImagePath } from "./diff/binary";
import { blame as runBlame } from "./diff/blame";
import { buildConflictPayload } from "./diff/conflict";
import { loadSide, loadSides } from "./diff/contentLoader";
import { type DiffComputation, DiffEngine } from "./diff/diffEngine";
import { detectRenames } from "./diff/renames";
import { describeFile, HUGE_FILE_BYTES, LARGE_FILE_BYTES, toPayload } from "./diff/textDiff";
import { sourceRefs } from "./diffSource";
import { EngineError, type EngineErrorJSON, errorCode, isPublicCode } from "./errors";
import type { DirHandleLike } from "./fs/dirHandleLike";
import { createFsaFs, type FsaFs } from "./fs/fsaFs";
import { GitAttributes } from "./git/attributes";
import { branchCells, branchOverview } from "./git/branches";
import { CommitGraph } from "./git/commitGraph";
import { commitDetails, commitStats } from "./git/commits";
import { type GitConfig, loadGitConfig } from "./git/config";
import { explainPath } from "./git/explain";
import { sha1, toHex } from "./git/hash";
import { IgnoreRules } from "./git/ignoreRules";
import { emptySnapshot, type IndexSnapshot, readIndex } from "./git/indexReader";
import { checkLayout } from "./git/layoutChecks";
import { ObjectDb } from "./git/objectDb";
import { detectOperation, OPERATION_FILES } from "./git/operation";
import { pathHistory as runPathHistory } from "./git/pathHistory";
import { readReflog } from "./git/reflog";
import { loadRefs } from "./git/refStore";
import { resolveRevision } from "./git/revisions";
import { countStashFiles, listStashes } from "./git/stash";
import { listTags } from "./git/tags";
import {
  CommitReader,
  aheadBehind as computeAheadBehind,
  MAX_WALK,
  type ReachableResult,
  reachableFrom,
  walkCommits as runWalk,
} from "./git/walk";
import { type ScannerOptions, WorktreeScanner } from "./git/worktree";
import type {
  AheadBehind,
  BlamePayload,
  BranchRow,
  CommitDetails,
  DiffResult,
  DiffSource,
  FileDiff,
  HiddenEntry,
  Oid,
  PathExplanation,
  PathHistoryEntry,
  ReflogEntry,
  RefSnapshot,
  RepoCapabilities,
  RepoInfo,
  RepoOperation,
  RepoWarning,
  ResolvedRevision,
  StashInfo,
  TagInfo,
  WalkPage,
  WalkRequest,
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
  /**
   * T10.4: apply the built-in excludes (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) in
   * `IgnoreRules`. Default true; `OpenOptions.builtinExcludes` is how the page sets it (B10).
   */
  builtinExcludes?: boolean;
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
const MEMORY_WARN_BYTES = 300 * 1024 * 1024;
/** How many stashes get a file count eagerly (T10.1); the rest keep `files: null`. */
const STASH_FILE_COUNT_LIMIT = 50;

/** Translate anything thrown inside the engine into the plain object that crosses the worker boundary. */
export function toPublicError(e: unknown): PublicError {
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
    const detail = (e as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string") (json as EngineErrorJSON).detail = detail;
    return json;
  };
  if (code !== undefined && isPublicCode(code)) return out(code);
  switch (code) {
    case "EACCES":
      return out("PERMISSION", message, "Grant read access to the folder and try again.");
    case "ENOENT":
      return out("IO_ERROR"); // a vanished root is detected earlier by RepoSession.withRootCheck
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
  /** T10.3: one in-flight `conflict()` per file id; a newer call cancels the older. */
  private readonly conflictAborts = new Map<string, AbortController>();
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
  /** T10.2: what git is in the middle of; refreshed on open and `reloadRefs()`. */
  private operationState: RepoOperation | null = null;
  /** T10.2: `.jj/` beside `.git/` (a colocated jujutsu repository). */
  private jj = false;
  /** T10.2: a commit-graph file or chain exists; T10.5's `CommitReader` decides whether it is used. */
  private hasCommitGraph = false;
  /** T10.5: parents + commit time, from the commit-graph when there is a usable one. */
  private reader: CommitReader | null = null;
  /** T10.5: oid → ref/tag/stash labels for the history badges; rebuilt when refs move. */
  private refsIndex: Promise<Map<Oid, string[]>> | null = null;
  /** T10.5: "reachable from any ref", cached per refs snapshot (`markReachable`). */
  private reachable: { key: string; result: ReachableResult } | null = null;
  /** method name → token of the newest call (one in-flight per method, T10.1). */
  private readonly singleFlight = new Map<string, symbol>();
  /** T10.6: the abort controller of the in-flight call per method name (see `single`). */
  private readonly singleAborts = new Map<string, AbortController>();
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
    const ignore = await IgnoreRules.load(fs, {
      config: cfg,
      ...(opts.builtinExcludes !== undefined ? { builtinExcludes: opts.builtinExcludes } : {}),
    });
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
    session.jj = await fs.exists("/.jj");
    session.hasCommitGraph =
      (await fs.exists("/.git/objects/info/commit-graph")) ||
      (await fs.exists("/.git/objects/info/commit-graphs/commit-graph-chain"));
    session.operationState = await detectOperation(fs, db, refs.refs);
    if (session.operationState) warnings.push(operationWarning(session.operationState));
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
      operation: this.operationState,
      jj: this.jj,
      hasCommitGraph: this.hasCommitGraph,
    };
  }

  async reloadRefs(): Promise<RepoInfo> {
    this.assertOpen();
    const t0 = performance.now();
    this.db.dropCaches(true);
    this.fs.invalidatePath("/.git");
    this.refs = await this.withRootCheck(() => loadRefs(this.db, this.cfg));
    this.engine.updateRefs(this.refs);
    this.dropHistoryCaches();
    await this.refreshOperation();
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

  // ---- revisions, tags, stashes (T10.1) --------------------------------------------------------

  /**
   * One in-flight call per method name (phase-10 convention): a newer call of the same method makes
   * the older one reject with `CANCELLED` instead of resolving with data the UI no longer wants.
   *
   * T10.6: the superseded call also gets its `AbortSignal` fired, so a long walk (`blame` on a hot
   * file) stops reading objects the moment the user moves on, instead of finishing and throwing.
   * Methods that ignore the signal behave exactly as before.
   */
  private async single<T>(method: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const token = Symbol(method);
    this.singleAborts.get(method)?.abort();
    const ac = new AbortController();
    this.singleAborts.set(method, ac);
    this.singleFlight.set(method, token);
    try {
      const out = await this.withRootCheck(() => fn(ac.signal));
      if (this.singleFlight.get(method) !== token) throw new CancelledError(method);
      return out;
    } catch (e) {
      if (ac.signal.aborted && !(e instanceof CancelledError)) throw new CancelledError(method);
      throw e;
    } finally {
      if (this.singleFlight.get(method) === token) this.singleFlight.delete(method);
      if (this.singleAborts.get(method) === ac) this.singleAborts.delete(method);
    }
  }

  async resolveRevision(expr: string): Promise<ResolvedRevision> {
    this.assertOpen();
    return this.single("resolveRevision", () => resolveRevision(this.db, this.refs, expr));
  }

  async listTags(): Promise<TagInfo[]> {
    this.assertOpen();
    return this.single("listTags", () => listTags(this.db));
  }

  async listStashes(): Promise<StashInfo[]> {
    this.assertOpen();
    return this.single("listStashes", async () => {
      const stashes = await listStashes(this.fs, this.db);
      // The picker shows a file count per stash (Design §14.1); it costs two tree flattens each,
      // so only the stack a human would scroll gets one.
      for (const s of stashes.slice(0, STASH_FILE_COUNT_LIMIT)) {
        s.files = await countStashFiles(this.db, s);
      }
      return stashes;
    });
  }

  /**
   * The reflog of `expr`, newest first (T10.2). A repository that keeps none answers with `[]` and
   * a `NO_REFLOG` warning on the sink rather than an error.
   */
  async reflog(expr: string, limit: number): Promise<ReflogEntry[]> {
    this.assertOpen();
    return this.single("reflog", async () => {
      const out = await readReflog(this.fs, expr, { limit });
      for (const w of out.warnings) RepoSession.emitWarning(this.sink, w);
      // T10.5: one batched reachability walk fills every `reachable`, which is what marks the
      // commit a `git reset` orphaned (Design §14.5: the `unreachable` badge).
      if (out.entries.length > 0) {
        const set = await this.reachableSet();
        for (const e of out.entries) e.reachable = set.oids.has(e.newOid);
      }
      return out.entries;
    });
  }

  /** What git is in the middle of, or null (T10.2). Also refreshes `RepoInfo.operation`. */
  async operation(): Promise<RepoOperation | null> {
    this.assertOpen();
    return this.single("operation", () => this.refreshOperation());
  }

  /**
   * Re-reads the state files and keeps `RepoInfo.operation` current. `OPERATION_IN_PROGRESS` is a
   * repo warning, so it is recorded (and pushed to the sink) the first time it becomes true in this
   * session — the banner itself is driven by `RepoInfo.operation`, not by the warning.
   */
  private async refreshOperation(): Promise<RepoOperation | null> {
    const op = await this.withRootCheck(() => detectOperation(this.fs, this.db, this.refs.refs));
    this.operationState = op;
    if (op && !this.repoWarnings.some((w) => w.code === "OPERATION_IN_PROGRESS")) {
      const w = operationWarning(op);
      this.repoWarnings.push(w);
      RepoSession.emitWarning(this.sink, w);
    }
    return op;
  }

  // ---- history, lanes, branches (T10.5) --------------------------------------------------------

  /**
   * The commit reader, built once per session. A usable commit-graph makes the walk read one static
   * file instead of inflating every commit object (atlas tab 20); anything wrong with the file is a
   * `COMMIT_GRAPH_STALE` warning and an object-read fallback, never an error.
   */
  private async commitReader(): Promise<CommitReader> {
    if (this.reader) return this.reader;
    const load = await this.withRootCheck(() => CommitGraph.load(this.fs));
    for (const w of load.warnings) {
      if (!this.repoWarnings.some((x) => x.code === w.code)) this.repoWarnings.push(w);
      RepoSession.emitWarning(this.sink, w);
    }
    this.reader = new CommitReader(this.db, load.graph);
    return this.reader;
  }

  /** Everything cached off the refs snapshot; dropped whenever refs or objects may have moved. */
  private dropHistoryCaches(): void {
    this.reader = null;
    this.refsIndex = null;
    this.reachable = null;
  }

  /**
   * oid → the labels the history rows wear, in badge order: `HEAD`, then branch and remote names in
   * RefStore's order, then tags, then stash selectors (Design §14.5).
   */
  private refsByCommit(): Promise<Map<Oid, string[]>> {
    this.refsIndex ??= (async () => {
      const map = new Map<Oid, string[]>();
      const add = (oid: Oid | null | undefined, label: string) => {
        if (!oid) return;
        const list = map.get(oid) ?? [];
        if (!list.includes(label)) list.push(label);
        map.set(oid, list);
      };
      add(this.refs.headOid, "HEAD");
      for (const r of this.refs.refs) if (!r.synthetic) add(r.oid, r.name);
      for (const t of await listTags(this.db)) add(t.targetOid, t.name);
      for (const s of await listStashes(this.fs, this.db)) add(s.oid, s.expr);
      return map;
    })().catch((e) => {
      this.refsIndex = null;
      throw e;
    });
    return this.refsIndex;
  }

  /**
   * The commits `walkCommits` starts from: the request's expressions, then — for `all` — every ref
   * in the repository followed by HEAD, which is the order `git log --all` seeds its walk in
   * (`for_each_ref` is ref-name sorted, and `handle_refs(head_ref)` comes after it). The order only
   * decides ties between commits of the same date, but a fixture built with a fixed
   * `GIT_COMMITTER_DATE` is nothing but ties.
   */
  private async walkSeeds(req: WalkRequest): Promise<Oid[]> {
    const seeds: Oid[] = [];
    const add = (oid: Oid | null | undefined) => {
      if (oid && !seeds.includes(oid)) seeds.push(oid);
    };
    for (const expr of req.from) add((await resolveRevision(this.db, this.refs, expr)).oid);
    if (req.all === true) {
      const named: { fullName: string; oid: Oid }[] = [];
      for (const r of this.refs.refs) if (!r.synthetic) named.push(r);
      for (const t of await listTags(this.db))
        named.push({ fullName: t.fullName, oid: t.targetOid });
      for (const s of await listStashes(this.fs, this.db)) {
        named.push({ fullName: `refs/stash@{${s.index}}`, oid: s.oid });
      }
      named.sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
      for (const r of named) add(r.oid);
      add(this.refs.headOid);
    }
    if (seeds.length === 0) add(this.refs.headOid); // an unborn branch simply has no history
    return seeds;
  }

  async walkCommits(req: WalkRequest): Promise<WalkPage> {
    this.assertOpen();
    return this.single("walkCommits", async () => {
      const t0 = performance.now();
      const reader = await this.commitReader();
      const seeds = await this.walkSeeds(req);
      const refsByCommit = await this.refsByCommit();
      const out = await runWalk({ db: this.db, reader, refsByCommit }, req, seeds);
      for (const w of out.warnings) RepoSession.emitWarning(this.sink, w);
      this.progress({
        phase: "history",
        done: out.page.commits.length,
        durationMs: performance.now() - t0,
      });
      return out.page;
    });
  }

  /** Shared by `commitStats`, `commitDetails` and the history rows' `+n −m`. */
  private async statsDeps() {
    return {
      db: this.db,
      reader: await this.commitReader(),
      limit: this.statsLimit,
      ...(this.cfg.diff.renames !== undefined ? { renames: this.cfg.diff.renames } : {}),
      ...(this.cfg.diff.renameLimit !== undefined
        ? { renameLimit: this.cfg.diff.renameLimit }
        : {}),
    };
  }

  async commitDetails(oid: Oid): Promise<CommitDetails> {
    this.assertOpen();
    return this.single("commitDetails", async () =>
      commitDetails(
        { ...(await this.statsDeps()), refsByCommit: await this.refsByCommit() },
        (await resolveRevision(this.db, this.refs, oid)).oid ?? oid,
      ),
    );
  }

  async commitStats(oids: Oid[]): Promise<Record<Oid, CommitDetails["stats"]>> {
    this.assertOpen();
    return this.single("commitStats", async () => commitStats(await this.statsDeps(), oids));
  }

  async aheadBehind(a: string, b: string): Promise<AheadBehind> {
    this.assertOpen();
    return this.single("aheadBehind", async () => {
      const left = await resolveRevision(this.db, this.refs, a);
      const right = await resolveRevision(this.db, this.refs, b);
      if (left.oid === null || right.oid === null)
        throw new EngineError("REV_NOT_FOUND", `Cannot compare "${a}" with "${b}".`, {
          hint: "Both sides must be commits.",
        });
      return computeAheadBehind(this.db, await this.commitReader(), left.oid, right.oid);
    });
  }

  async branchOverview(): Promise<BranchRow[]> {
    this.assertOpen();
    return this.single("branchOverview", async () =>
      branchOverview(
        { db: this.db, reader: await this.commitReader(), cfg: this.cfg, refs: this.refs },
        await listTags(this.db),
      ),
    );
  }

  async branchCells(
    fullNames: string[],
  ): Promise<Record<string, Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">>> {
    this.assertOpen();
    return this.single("branchCells", async () =>
      branchCells(
        { db: this.db, reader: await this.commitReader(), cfg: this.cfg, refs: this.refs },
        fullNames,
      ),
    );
  }

  async markReachable(oids: Oid[]): Promise<Record<Oid, boolean>> {
    this.assertOpen();
    return this.single("markReachable", async () => {
      const set = await this.reachableSet();
      const out: Record<Oid, boolean> = {};
      for (const oid of oids) out[oid] = set.oids.has(oid);
      return out;
    });
  }

  /** One walk from every ref (`git rev-list --all`), cached until the refs snapshot changes. */
  private async reachableSet(): Promise<ReachableResult> {
    const key = `${this.refs.headOid ?? "-"}|${this.refs.refs.map((r) => `${r.fullName}=${r.oid}`).join(",")}`;
    if (this.reachable?.key === key) return this.reachable.result;
    const reader = await this.commitReader();
    const tips: Oid[] = [];
    const add = (oid: Oid | null | undefined) => {
      if (oid && !tips.includes(oid)) tips.push(oid);
    };
    add(this.refs.headOid);
    for (const r of this.refs.refs) if (!r.synthetic) add(r.oid);
    for (const t of await listTags(this.db)) add(t.targetOid);
    for (const s of await listStashes(this.fs, this.db)) add(s.oid);
    const result = await reachableFrom(reader, tips, MAX_WALK);
    if (result.capped) {
      RepoSession.emitWarning(this.sink, {
        code: "HISTORY_CAPPED",
        message: `Reachability was computed from the newest ${MAX_WALK.toLocaleString("en")} commits only; older entries may be marked unreachable.`,
      });
    }
    this.reachable = { key, result };
    return result;
  }

  // ---- file history and blame (T10.6) ----------------------------------------------------------

  /** What `pathHistory` and the rename-follow step need; the rename limit is git's own config. */
  private async historyDeps(signal: AbortSignal) {
    return {
      db: this.db,
      reader: await this.commitReader(),
      ...(this.cfg.diff.renameLimit !== undefined
        ? { renameLimit: this.cfg.diff.renameLimit }
        : {}),
      signal,
    };
  }

  private async resolveCommit(ref: string): Promise<Oid> {
    const resolved = await resolveRevision(this.db, this.refs, ref);
    if (resolved.oid === null)
      throw new EngineError("REV_NOT_FOUND", `"${ref}" does not name a commit.`, {
        hint: "Pick a branch, tag or commit",
      });
    return resolved.oid;
  }

  /** `git log [--follow] -- <path>` for one path, newest first (T10.6). */
  async pathHistory(
    ref: string,
    path: string,
    opts: PathHistoryOptions,
  ): Promise<{ entries: PathHistoryEntry[]; cursor: string | null }> {
    this.assertOpen();
    return this.single("pathHistory", async (signal) =>
      runPathHistory(await this.historyDeps(signal), await this.resolveCommit(ref), path, opts),
    );
  }

  /**
   * Who wrote each line of `path` at `ref` (T10.6). The path history is resolved first (renames
   * followed) so the reverse-diff has both the revision list and the rename hops; `maxRevisions + 1`
   * entries are asked for so the cut can be told apart from a history that simply ended.
   */
  async blame(ref: string, path: string, opts: BlameRequest): Promise<BlamePayload> {
    this.assertOpen();
    return this.single("blame", async (signal) => {
      const t0 = performance.now();
      const maxRevisions = Math.max(1, opts.maxRevisions);
      const deps = await this.historyDeps(signal);
      const history = await runPathHistory(deps, await this.resolveCommit(ref), path, {
        follow: true,
        limit: maxRevisions + 1,
      });
      if (history.entries.length === 0)
        throw new EngineError("REF_NOT_FOUND", `${path} does not exist in ${ref}.`, {
          hint: "Check the path and the branch",
        });
      const historyCapped = history.entries.length > maxRevisions;
      const out = await runBlame(
        {
          db: this.db,
          entries: history.entries.slice(0, maxRevisions),
          historyCapped,
          readWorktree: (p) => this.readWorktreeBytes(p),
          onProgress: (done, total) => this.progress({ phase: "blame", done, total }),
          signal,
        },
        ref,
        path,
        opts,
      );
      for (const w of out.warnings) RepoSession.emitWarning(this.sink, w);
      this.progress({
        phase: "blame",
        done: out.payload.revisions,
        total: out.payload.revisions,
        durationMs: performance.now() - t0,
      });
      return out.payload;
    });
  }

  /** The working-tree bytes of a tracked path, or null when it is gone or unreadable. */
  private async readWorktreeBytes(path: string): Promise<Uint8Array | null> {
    try {
      return await this.fs.readFile(`/${path}`);
    } catch (e) {
      const code = errorCode(e);
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
      throw e;
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

  /**
   * Refines the shared FileDiff row in place. `fileDiff()` and the stats pump may both describe the
   * same file; both run under the same `Current`, so whichever finishes last wins — the fields they
   * write (sizes, binary/image/tooLarge, stats) do not depend on `ignoreWhitespace` except `stats`,
   * which the pump computes with the default and the UI reads from the payload, not the row.
   */
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
          try {
            out[id] = await this.statsFor(cur, f);
          } catch (e) {
            // one unreadable file must not blank the whole batch (T7.5 review); same as pumpStats
            if (errorCode(e) === "CANCELLED" || errorCode(e) === "STALE") throw e;
            out[id] = null;
            cur.stats.set(id, null);
            RepoSession.emitWarning(this.sink, {
              code: "FILE_TOO_LARGE",
              message: `Could not compute stats for ${id}: ${(e as Error)?.message ?? String(e)}`,
              detail: id,
            });
          }
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

  /**
   * The three-way view of one conflicted file (T10.3): index stages 1/2/3, the base→ours and
   * base→theirs hunks, and the working-tree file with its conflict markers located. `STALE` and
   * `CANCELLED` behave exactly as for `fileDiff` — the generation must be current, and a newer
   * `conflict()` for the same id supersedes this one.
   *
   * The index is re-read on every call rather than reused from the diff computation: the point of
   * the card is to follow the file while the user resolves it in their editor.
   */
  async conflict(generation: number, id: string): Promise<ConflictPayload> {
    const cur = this.requireGeneration(generation);
    const f = this.requireFile(cur, id);
    this.conflictAborts.get(id)?.abort();
    const ac = new AbortController();
    this.conflictAborts.set(id, ac);
    try {
      const path = (f.newPath ?? f.oldPath ?? id) as string;
      const index = await this.withRootCheck(() => readIndex(this.fs));
      throwIfAborted(ac.signal, "conflict");
      const stages = index.conflicts[path];
      if (!stages || stages.length === 0) {
        throw new EngineError(
          "INTERNAL",
          `"${id}" has no conflict stages in the index (nothing to compare three ways).`,
          { path },
        );
      }
      const operation = this.operationState ?? (await this.refreshOperation());
      throwIfAborted(ac.signal, "conflict");
      return await this.withRootCheck(() =>
        buildConflictPayload(
          { db: this.db, fs: this.fs },
          {
            id,
            path,
            generation,
            stages,
            refs: this.refs,
            operation,
            signal: ac.signal,
          },
        ),
      );
    } catch (e) {
      if (ac.signal.aborted && !(e instanceof CancelledError)) throw new CancelledError("conflict");
      throw e;
    } finally {
      if (this.conflictAborts.get(id) === ac) this.conflictAborts.delete(id);
    }
  }

  // ---- why hidden (T10.4) ---------------------------------------------------------------------

  /** The index as it is right now, or an empty one for a repository with no `.git/index` yet. */
  private async currentIndex(): Promise<IndexSnapshot> {
    try {
      return await this.withRootCheck(() => readIndex(this.fs));
    } catch (e) {
      if (errorCode(e) === "ENOENT") return emptySnapshot(0);
      throw e;
    }
  }

  /**
   * Why `path` is not in the diff (T10.4): the ignore rule that matched, the index flags, the
   * sparse checkout, the 10 MB gate, `linguist-generated`, or `clean`. The index is re-read per
   * call for the same reason `conflict()` does it — the answer must follow the file.
   */
  async explainPath(path: string): Promise<PathExplanation> {
    this.assertOpen();
    return this.single("explainPath", async () =>
      explainPath(
        {
          fs: this.fs,
          ignore: this.ignore,
          attrs: this.attrs,
          index: await this.currentIndex(),
          files: this.current?.byId ?? null,
        },
        path,
      ),
    );
  }

  /**
   * The sidebar's Hidden group (T10.4). Opt-in: it is its own pruned walk, so a normal refresh
   * never pays for it. `too-large` comes from the rows of the current diff — the classification
   * that made the UI gate them in the first place.
   */
  async listHidden(): Promise<HiddenEntry[]> {
    this.assertOpen();
    return this.single("listHidden", async () => {
      const index = await this.currentIndex();
      const tooLarge: string[] = [];
      for (const f of this.current?.byId.values() ?? []) {
        if (Math.max(f.oldSize, f.newSize) > HUGE_FILE_BYTES)
          tooLarge.push(f.newPath ?? f.oldPath ?? f.id);
      }
      const { entries, warnings } = await this.withRootCheck(() =>
        this.scanner.listHidden(index, { tooLarge }),
      );
      for (const w of warnings) RepoSession.emitWarning(this.sink, w);
      return entries;
    });
  }

  /** Raw bytes of one side (image viewer, "View as text"). Sides over 10 MB are refused with TOO_LARGE. */
  async fileBytes(generation: number, id: string, side: "old" | "new"): Promise<Uint8Array | null> {
    const cur = this.requireGeneration(generation);
    const f = this.requireFile(cur, id);
    const bytes = await loadSide(f, side, cur.comp.sides, { db: this.db, fs: this.fs });
    if (bytes && bytes.byteLength > HUGE_FILE_BYTES) {
      throw new EngineError("TOO_LARGE", `${id} (${side}) is ${bytes.byteLength} bytes.`, {
        hint: "Files over 10 MB are never transferred to the page.",
        path: f.newPath ?? f.oldPath ?? id,
      });
    }
    return bytes;
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
    // A running pump belongs to an older generation once `this.current` moves on; its workers exit
    // after their in-flight read and the `finally` below re-launches for the new generation
    // (T7.5 review: previously the new generation's stats never started in that window).
    if (this.statsActive > 0) return;
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
      const now = this.current;
      if (
        this.statsActive === 0 &&
        now &&
        now !== cur &&
        !this.closed &&
        this.statsGen === now.generation &&
        this.statsQueue.length > 0
      ) {
        void this.pumpStats(now);
      }
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
      // T10.2: the banner must follow git live, so every operation state file is in the signature
      ...OPERATION_FILES.map((f) => `/.git/${f}`),
    ]);
    if (this.refs.headBranch) paths.add(`/.git/refs/heads/${this.refs.headBranch}`);
    const last = this.lastSource ? sourceRefs(this.lastSource) : null;
    for (const ref of [last?.sourceRef, last?.targetRef]) {
      // only full ref names are files under .git; a range may name a SHA or `stash@{0}`
      if (ref?.startsWith("refs/")) paths.add(`/.git/${ref}`);
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
      this.dropHistoryCaches();
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
    this.dropHistoryCaches();
  }

  async forceRehash(): Promise<void> {
    this.assertOpen();
    this.scanner.forgetStatCache();
    this.fs.invalidateAll();
    this.db.dropCaches(true);
    this.ignore.invalidate();
    this.attrs.invalidate();
    this.dropHistoryCaches();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.inflight?.abort();
    for (const ac of this.fileDiffAborts.values()) ac.abort();
    this.fileDiffAborts.clear();
    for (const ac of this.conflictAborts.values()) ac.abort();
    this.conflictAborts.clear();
    this.singleFlight.clear();
    for (const ac of this.singleAborts.values()) ac.abort();
    this.singleAborts.clear();
    this.stopStats();
    this.current = null;
    this.db.dropCaches(true);
    this.fs.invalidateAll();
    this.dropHistoryCaches();
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

/** The one `OPERATION_IN_PROGRESS` warning a session records (docs/errors.md owns the UI copy). */
function operationWarning(op: RepoOperation): RepoWarning {
  const where = op.step && op.total ? ` (step ${op.step} of ${op.total})` : "";
  return {
    code: "OPERATION_IN_PROGRESS",
    message: `A ${op.kind} is in progress in this repository${where}.`,
    ...(op.conflicts > 0
      ? { detail: `${op.conflicts} path${op.conflicts === 1 ? "" : "s"} still conflict.` }
      : {}),
  };
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
