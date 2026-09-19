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
  PatchResult,
  PathHistoryOptions,
  ProbeTier,
  Progress,
  ProgressSink,
} from "./api";
import { blame as runBlame } from "./diff/blame";
import { loadSides } from "./diff/contentLoader";
import { DiffEngine } from "./diff/diffEngine";
import { parsePatch } from "./diff/parsePatch";
import { describeFile, HUGE_FILE_BYTES } from "./diff/textDiff";
import { EngineError, errorCode } from "./errors";
import type { DirHandleLike } from "./fs/dirHandleLike";
import { createFsaFs, type FsaFs } from "./fs/fsaFs";
import { GitAttributes } from "./git/attributes";
import { bisectStep as computeBisectStep } from "./git/bisect";
import { branchCells, branchOverview, upstreamOf } from "./git/branches";
import { CommitGraph } from "./git/commitGraph";
import { commitDetails, commitStats } from "./git/commits";
import { type GitConfig, loadGitConfig } from "./git/config";
import { explainPath } from "./git/explain";
import { IgnoreRules } from "./git/ignoreRules";
import { emptySnapshot, type IndexSnapshot, readIndex } from "./git/indexReader";
import { checkLayout } from "./git/layoutChecks";
import { MAILMAP_FILE, Mailmap } from "./git/mailmap";
import { ObjectDb } from "./git/objectDb";
import { detectOperation } from "./git/operation";
import { pathHistory as runPathHistory } from "./git/pathHistory";
import { rebasePreflight as computePreflight } from "./git/preflight";
import { readReflog } from "./git/reflog";
import { loadRefs } from "./git/refStore";
import { resolveRevision } from "./git/revisions";
import { countStashFiles, listStashes } from "./git/stash";
import { listSubmodules } from "./git/submodules";
import { listTags } from "./git/tags";
import {
  CommitReader,
  aheadBehind as computeAheadBehind,
  MAX_WALK,
  type ReachableResult,
  reachableFrom,
  walkCommits as runWalk,
  subjectOf,
  type WalkState,
  walkRequestKey,
} from "./git/walk";
import { WorktreeScanner } from "./git/worktree";
import { listWorktrees } from "./git/worktrees";
import { computeInsights } from "./insights/insights";
import { SECRET_ALLOWLIST_FILE } from "./scan/secretRules";
import {
  addedLines,
  type ScanTarget,
  SECRET_FINDING_CAP,
  scanTarget,
  secretAllowlist,
  secretsWarning,
  sortFindings,
} from "./scan/secrets";
import { DiffRunner } from "./session/diffRunner";
import { toPublicError } from "./session/errorTranslation";
import { SearchRunner } from "./session/searchRunner";
import { StatsQueue } from "./session/statsQueue";
import {
  type Current,
  dedupe,
  MEMORY_WARN_BYTES,
  NO_SESSION,
  operationWarning,
  requireGeneration,
  type SessionOptions,
  STASH_FILE_COUNT_LIMIT,
} from "./session/types";
import { WatchOrchestrator } from "./session/watchOrchestrator";
import type {
  AheadBehind,
  BisectState,
  BisectStep,
  BlamePayload,
  BranchRow,
  CommitDetails,
  DiffResult,
  DiffSource,
  FileDiff,
  HiddenEntry,
  InsightsRequest,
  InsightsResult,
  Oid,
  PathExplanation,
  PathHistoryEntry,
  PreflightResult,
  ReflogEntry,
  RefSnapshot,
  RepoCapabilities,
  RepoInfo,
  RepoOperation,
  RepoSummary,
  RepoWarning,
  ResolvedRevision,
  SearchRequest,
  SearchResult,
  SecretFinding,
  StashInfo,
  SubmoduleInfo,
  TagInfo,
  WalkPage,
  WalkRequest,
  WorktreeInfo,
} from "./types";
import { CancelledError, pLimit, throwIfAborted } from "./util/concurrency";

export type { SessionOptions };
export { toPublicError };

export class RepoSession implements Omit<EngineApi, "open"> {
  private gen = 0;
  private current: Current | null = null;
  private lastSource: DiffSource | null = null;
  private closed = false;
  private computes = 0;
  private lastCompute: EngineMetrics["lastCompute"] = null;
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
  /**
   * T10.5b S4: the walk state a `WalkPage.cursor` names. The cursor is an opaque token into this
   * map rather than a serialised frontier (which was ~47 B per commit walked, per page); a token
   * this session does not hold — a worker restart, a refs change, an evicted older page — answers
   * `STALE` and the UI restarts the list.
   */
  private readonly walkStates = new Map<string, WalkState>();
  private walkTokens = 0;
  private readonly walkPrefix = `w${Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0")}`;
  /** T10.5b S3: `aheadBehind` memoised per ordered pair; dropped with the other history caches. */
  private readonly aheadBehindCache = new Map<string, AheadBehind>();
  /** method name → token of the newest call (one in-flight per method, T10.1). */
  private readonly singleFlight = new Map<string, symbol>();
  /** T10.6: the abort controller of the in-flight call per method name (see `single`). */
  private readonly singleAborts = new Map<string, AbortController>();
  private readonly statsLimit: <T>(fn: () => Promise<T>) => Promise<T>;

  private readonly statsQueue: StatsQueue;
  private readonly diffRunner: DiffRunner;
  private readonly searchRunner: SearchRunner;
  private readonly watchOrchestrator: WatchOrchestrator;

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

    this.statsQueue = new StatsQueue({
      db: this.db,
      fs: this.fs,
      attrs: this.attrs,
      sink: this.sink,
      statsLimit: this.statsLimit,
      opts: this.opts,
      getCurrent: () => this.current,
      isClosed: () => this.closed,
      emitWarning: (w) => RepoSession.emitWarning(this.sink, w),
      progress: (p) => this.progress(p),
      onStatsComplete: (statsMs) => {
        if (this.lastCompute) this.lastCompute.statsMs = statsMs;
      },
      statsFor: (cur, f, signal) => this.statsFor(cur, f, signal),
    });

    this.diffRunner = new DiffRunner({
      fs: this.fs,
      db: this.db,
      cfg: this.cfg,
      attrs: this.attrs,
      ignore: this.ignore,
      engine: this.engine,
      getCurrent: () => this.current,
      setCurrent: (cur) => {
        this.current = cur;
      },
      nextGeneration: () => ++this.gen,
      setLastSource: (src) => {
        this.lastSource = src;
      },
      assertOpen: () => this.assertOpen(),
      progress: (p) => this.progress(p),
      emitWarning: (w) => RepoSession.emitWarning(this.sink, w),
      withRootCheck: (fn) => this.withRootCheck(fn),
      single: (method, fn) => this.single(method, fn),
      stopStats: () => this.statsQueue.stop(),
      startStats: (gen) => {
        this.checkMemory();
        this.statsQueue.start(gen);
      },
      checkMemory: () => this.checkMemory(),
      onComputeSuccess: (result) => {
        this.computes++;
        this.lastCompute = {
          files: result.files.length,
          durationMs: result.durationMs,
          statsMs: null,
        };
      },
      getOperationState: () => this.operationState,
      refreshOperation: () => this.refreshOperation(),
      getRefs: () => this.refs,
    });

    this.searchRunner = new SearchRunner({
      db: this.db,
      attrs: this.attrs,
      scanner: this.scanner,
      statsLimit: this.statsLimit,
      commitReader: () => this.commitReader(),
      refsByCommit: () => this.refsByCommit(),
      walkSeeds: (req, reader) => this.walkSeeds(req, reader),
      currentIndex: () => this.currentIndex(),
      readWorktreeBytes: (path) => this.readWorktreeBytes(path),
      getHeadOid: () => this.refs.headOid,
      progress: (p) => this.progress(p),
      emitWarning: (w) => RepoSession.emitWarning(this.sink, w),
      withRootCheck: (fn) => this.withRootCheck(fn),
      assertOpen: () => this.assertOpen(),
      single: (method, fn) => this.single(method, fn),
    });

    this.watchOrchestrator = new WatchOrchestrator({
      root: this.root,
      fs: this.fs,
      db: this.db,
      ignore: this.ignore,
      attrs: this.attrs,
      scanner: this.scanner,
      getHeadBranch: () => this.refs.headBranch,
      getLastSource: () => this.lastSource,
      progress: (p) => this.progress(p),
      dropHistoryCaches: () => this.dropHistoryCaches(),
      assertOpen: () => this.assertOpen(),
    });
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
    // T10.12: `.jj/` is detected by `checkLayout` (it also raises the `JJ_COLOCATED` banner), and
    // `loadRefs` needs it *before* it builds `headDisplay` — jj's detached HEAD is its working copy.
    const refs = await loadRefs(db, cfg, { jj: layout.jj });
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
      /* unborn repos have no index yet */
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
    session.jj = layout.jj;
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
    this.refs = await this.withRootCheck(() => loadRefs(this.db, this.cfg, { jj: this.jj }));
    this.engine.updateRefs(this.refs);
    this.dropHistoryCaches();
    await this.refreshOperation();
    this.progress({ phase: "refs", durationMs: performance.now() - t0 });
    return this.buildInfo();
  }

  // ---- diff -----------------------------------------------------------------------------------

  async computeDiff(src: DiffSource): Promise<DiffResult> {
    return this.diffRunner.computeDiff(src);
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
    // Every outstanding cursor described a walk of refs that have since moved (T10.5b S2/S4).
    this.walkStates.clear();
    this.aheadBehindCache.clear();
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
  private async walkSeeds(req: WalkRequest, reader: CommitReader): Promise<Oid[]> {
    const seeds: Oid[] = [];
    const taken = new Set<Oid>(); // T10.5b nit 6: O(1) dedup, not `includes` per ref
    const add = async (oid: Oid | null | undefined): Promise<void> => {
      if (!oid || taken.has(oid)) return;
      taken.add(oid);
      // T10.5b B1: a tag can name a blob or a tree; `git log --all` leaves such a ref out.
      if (!(await reader.isCommit(oid))) return;
      seeds.push(oid);
    };
    for (const expr of req.from) await add((await resolveRevision(this.db, this.refs, expr)).oid);
    if (req.all === true) {
      const named: { fullName: string; oid: Oid }[] = [];
      for (const r of this.refs.refs) if (!r.synthetic) named.push(r);
      for (const t of await listTags(this.db)) {
        if (t.targetType !== "commit") continue;
        named.push({ fullName: t.fullName, oid: t.targetOid });
      }
      for (const s of await listStashes(this.fs, this.db)) {
        named.push({ fullName: `refs/stash@{${s.index}}`, oid: s.oid });
      }
      named.sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
      for (const r of named) await add(r.oid);
      await add(this.refs.headOid);
    }
    if (seeds.length === 0) await add(this.refs.headOid); // an unborn branch has no history
    return seeds;
  }

  /** The number of walk cursors the session keeps alive; older ones answer `STALE`. */
  private static readonly WALK_STATES = 8;
  private static readonly WALK_TOKEN = /^w[0-9a-f]{8}\.[1-9][0-9]*$/;

  /**
   * T10.5b S2/S4: the cursor is a token this session issued. A token it never issued, or one it
   * has dropped (refs moved, worker restarted, eight pages ago), is `STALE` — the UI restarts the
   * list, which is the only safe answer while refs move. Anything that is not a token at all is a
   * caller bug and answers `INTERNAL`.
   */
  private resumeWalk(cursor: string, key: string): WalkState {
    if (!RepoSession.WALK_TOKEN.test(cursor))
      throw new EngineError("INTERNAL", "The history cursor is not a cursor this engine issued.", {
        detail: cursor.slice(0, 64),
      });
    const state = this.walkStates.get(cursor);
    if (!state)
      throw new EngineError("STALE", "The history cursor is no longer valid.", {
        hint: "Reload the history list",
        detail: cursor,
      });
    if (state.key !== key) {
      this.walkStates.delete(cursor);
      throw new EngineError("STALE", "The history cursor belongs to a different query.", {
        hint: "Reload the history list",
        detail: cursor,
      });
    }
    return state;
  }

  private issueWalkToken(state: WalkState): string {
    this.walkTokens += 1;
    const token = `${this.walkPrefix}.${this.walkTokens}`;
    this.walkStates.set(token, state);
    while (this.walkStates.size > RepoSession.WALK_STATES) {
      const oldest = this.walkStates.keys().next().value as string;
      this.walkStates.delete(oldest);
    }
    return token;
  }

  async walkCommits(req: WalkRequest): Promise<WalkPage> {
    this.assertOpen();
    return this.single("walkCommits", async (signal) => {
      const t0 = performance.now();
      const reader = await this.commitReader();
      const seeds = await this.walkSeeds(req, reader);
      const refsByCommit = await this.refsByCommit();
      const key = walkRequestKey(req, seeds);
      const resume = req.cursor === undefined ? null : this.resumeWalk(req.cursor, key);
      if (req.cursor !== undefined) this.walkStates.delete(req.cursor);
      const out = await runWalk(
        {
          db: this.db,
          reader,
          refsByCommit,
          signal,
          // T10.5b S5: a long walk reports as it goes instead of once, at the end.
          onProgress: (walked) => this.progress({ phase: "history", done: walked }),
        },
        req,
        seeds,
        resume,
      );
      for (const w of out.warnings) RepoSession.emitWarning(this.sink, w);
      const page: WalkPage = {
        ...out.page,
        cursor: out.state === null ? null : this.issueWalkToken(out.state),
      };
      this.progress({
        phase: "history",
        done: page.commits.length,
        durationMs: performance.now() - t0,
      });
      return page;
    });
  }

  /** Shared by `commitStats`, `commitDetails` and the history rows' `+n −m`. */
  private async statsDeps(signal?: AbortSignal) {
    return {
      db: this.db,
      reader: await this.commitReader(),
      limit: this.statsLimit,
      warn: (w: RepoWarning) => RepoSession.emitWarning(this.sink, w),
      ...(signal ? { signal } : {}),
      ...(this.cfg.diff.renames !== undefined ? { renames: this.cfg.diff.renames } : {}),
      ...(this.cfg.diff.renameLimit !== undefined
        ? { renameLimit: this.cfg.diff.renameLimit }
        : {}),
    };
  }

  async commitDetails(oid: Oid): Promise<CommitDetails> {
    this.assertOpen();
    return this.single("commitDetails", async (signal) =>
      commitDetails(
        { ...(await this.statsDeps(signal)), refsByCommit: await this.refsByCommit() },
        (await resolveRevision(this.db, this.refs, oid)).oid ?? oid,
      ),
    );
  }

  async commitStats(oids: Oid[]): Promise<Record<Oid, CommitDetails["stats"]>> {
    this.assertOpen();
    return this.single("commitStats", async (signal) =>
      commitStats(await this.statsDeps(signal), oids),
    );
  }

  async aheadBehind(a: string, b: string): Promise<AheadBehind> {
    this.assertOpen();
    return this.single("aheadBehind", async (signal) => {
      const left = await resolveRevision(this.db, this.refs, a);
      const right = await resolveRevision(this.db, this.refs, b);
      if (left.oid === null || right.oid === null)
        throw new EngineError("REV_NOT_FOUND", `Cannot compare "${a}" with "${b}".`, {
          hint: "Both sides must be commits.",
        });
      return this.memoisedAheadBehind(left.oid, right.oid, signal);
    });
  }

  /**
   * T10.5b S3: one `(a, b)` pair is walked once per refs generation. `branchCells` asks for two
   * comparisons per row and a 50-branch table shares almost all of that work.
   */
  private async memoisedAheadBehind(a: Oid, b: Oid, signal?: AbortSignal): Promise<AheadBehind> {
    const key = `${a}|${b}`;
    const hit = this.aheadBehindCache.get(key);
    if (hit) return hit;
    const out = await computeAheadBehind(
      this.db,
      await this.commitReader(),
      a,
      b,
      signal ? { signal } : {},
    );
    this.aheadBehindCache.set(key, out);
    // The mirror image is free, and `branchCells` asks for it whenever two branches track each other.
    this.aheadBehindCache.set(`${b}|${a}`, {
      ahead: out.behind,
      behind: out.ahead,
      mergeBase: out.mergeBase,
      capped: out.capped,
    });
    return out;
  }

  /** The shared `BranchDeps`: refs, config, the memoised comparison and the warning sink. */
  private async branchDeps(signal?: AbortSignal) {
    return {
      db: this.db,
      reader: await this.commitReader(),
      cfg: this.cfg,
      refs: this.refs,
      warn: (w: RepoWarning) => RepoSession.emitWarning(this.sink, w),
      aheadBehind: (a: Oid, b: Oid) => this.memoisedAheadBehind(a, b, signal),
      ...(signal ? { signal } : {}),
    };
  }

  async branchOverview(): Promise<BranchRow[]> {
    this.assertOpen();
    return this.single("branchOverview", async (signal) =>
      branchOverview(await this.branchDeps(signal), await listTags(this.db)),
    );
  }

  async branchCells(
    fullNames: string[],
  ): Promise<Record<string, Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">>> {
    this.assertOpen();
    return this.single("branchCells", async (signal) =>
      branchCells(await this.branchDeps(signal), fullNames),
    );
  }

  async markReachable(oids: Oid[]): Promise<Record<Oid, boolean>> {
    this.assertOpen();
    return this.single("markReachable", async (signal) => {
      const set = await this.reachableSet(signal);
      const out: Record<Oid, boolean> = {};
      for (const oid of oids) out[oid] = set.oids.has(oid);
      return out;
    });
  }

  /** One walk from every ref (`git rev-list --all`), cached until the refs snapshot changes. */
  private async reachableSet(signal?: AbortSignal): Promise<ReachableResult> {
    const key = `${this.refs.headOid ?? "-"}|${this.refs.refs.map((r) => `${r.fullName}=${r.oid}`).join(",")}`;
    if (this.reachable?.key === key) return this.reachable.result;
    const reader = await this.commitReader();
    const tips: Oid[] = [];
    const taken = new Set<Oid>(); // T10.5b nit 6
    const add = (oid: Oid | null | undefined) => {
      if (!oid || taken.has(oid)) return;
      taken.add(oid);
      tips.push(oid);
    };
    add(this.refs.headOid);
    for (const r of this.refs.refs) if (!r.synthetic) add(r.oid);
    // T10.5b B1: a tag on a blob or a tree is not a tip `rev-list --all` would ever walk.
    for (const t of await listTags(this.db)) if (t.targetType === "commit") add(t.targetOid);
    for (const s of await listStashes(this.fs, this.db)) add(s.oid);
    const result = await reachableFrom(reader, tips, MAX_WALK, signal);
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

  // ---- secret scan (T10.7, atlas tab 14) -------------------------------------------------------

  /**
   * Token shapes and high-entropy strings in the **added** lines of the staged and unstaged layers
   * of `generation`. Reuses `describeFile`, so the scan looks at exactly the hunks the diff pane
   * renders and costs what the change costs, not what the repository costs.
   *
   * Skipped without reading a byte: rows with no uncommitted layer, `generated` files (lockfiles,
   * minified bundles), and paths listed in `.diffgitignore-secrets`. Skipped after loading: binary
   * files and files the UI already gates as `tooLarge`. Allowlisted lines
   * (`# diffgit:allow-secret`) and bare sha1/sha256 digests are dropped by the scanner itself.
   */
  async scanSecrets(generation: number): Promise<SecretFinding[]> {
    this.requireGeneration(generation);
    return this.single("scanSecrets", async (signal) => {
      const t0 = performance.now();
      const cur = this.requireGeneration(generation);
      const allowed = secretAllowlist(await this.readTextOrNull(SECRET_ALLOWLIST_FILE));
      const candidates = cur.result.files.filter((f) => {
        if (f.generated === true) return false;
        if (!f.layers.includes("staged") && !f.layers.includes("unstaged")) return false;
        return !allowed((f.newPath ?? f.oldPath ?? f.id) as string);
      });
      this.progress({ phase: "secrets", done: 0, total: candidates.length });
      const findings: SecretFinding[] = [];
      let done = 0;
      for (const f of candidates) {
        throwIfAborted(signal, "secret scan");
        const path = (f.newPath ?? f.oldPath) as string;
        const loaded = await loadSides(f, cur.comp.sides, { db: this.db, fs: this.fs }, signal);
        const d = describeFile(f, loaded, {
          ignoreWhitespace: false,
          attrBinary: await this.attrs.isBinary(path),
          attrGenerated: await this.attrs.isGenerated(path),
        });
        done++;
        this.progress({ phase: "secrets", done, total: candidates.length });
        if (d.classification.binary || d.classification.generated || d.classification.tooLarge)
          continue;
        const target: ScanTarget = {
          fileId: f.id,
          path,
          // A row with unstaged work is reported as `unstaged`: that is where the line is now.
          layer: f.layers.includes("unstaged") ? "unstaged" : "staged",
          lines: addedLines(d.hunks),
        };
        findings.push(...scanTarget(target));
      }
      const sorted = sortFindings(findings);
      const shown = sorted.slice(0, SECRET_FINDING_CAP);
      if (sorted.length > 0)
        RepoSession.emitWarning(this.sink, secretsWarning(sorted.length, shown.length));
      this.progress({
        phase: "secrets",
        done: candidates.length,
        total: candidates.length,
        durationMs: performance.now() - t0,
      });
      return shown;
    });
  }

  // ---- search (T10.8, atlas tab 05) ------------------------------------------------------------

  async search(req: SearchRequest): Promise<SearchResult> {
    return this.searchRunner.search(req);
  }

  // ---- insights (T10.9, atlas tab 13) ----------------------------------------------------------

  /**
   * Activity, contributors and hotspots from one first-parent walk of `HEAD` (`src/engine/insights`).
   *
   * `.mailmap` is re-read on every call, as `scanSecrets` re-reads its allowlist: it is a
   * working-tree file the user may be editing, and it costs one small read. The walk itself goes
   * through `walkCommits`, so it shares the commit-graph reader, the cap and the cancellation the
   * history list already has; only the per-commit path-level tree diff is new work.
   */
  async insights(req: InsightsRequest): Promise<InsightsResult> {
    this.assertOpen();
    return this.single("insights", async (signal) => {
      const t0 = performance.now();
      const reader = await this.commitReader();
      const seeds = await this.walkSeeds({ from: ["HEAD"], firstParent: true, limit: 1 }, reader);
      const mailmap = Mailmap.parse(await this.readTextOrNull(MAILMAP_FILE));
      this.progress({ phase: "insights", done: 0 });
      const out = await computeInsights(
        {
          db: this.db,
          reader,
          mailmap,
          refsByCommit: await this.refsByCommit(),
          signal,
          onProgress: (walked) => this.progress({ phase: "insights", done: walked }),
        },
        seeds,
        req,
      );
      for (const w of out.warnings) RepoSession.emitWarning(this.sink, w);
      this.progress({
        phase: "insights",
        done: out.result.walked,
        total: out.result.walked,
        durationMs: performance.now() - t0,
      });
      return out.result;
    });
  }

  // ---- patch text and repository summary (T10.10, atlas tabs 12 and 11) -----------------------

  async patchText(generation: number, ids: string[] | null): Promise<string> {
    return this.diffRunner.patchText(generation, ids);
  }

  /**
   * The dashboard card for this repository (atlas tab 11): refs, what git is in the middle of, the
   * index, a counts-only working-tree scan and ahead/behind for the checked-out branch.
   *
   * It deliberately touches **no** diff state: no `computeDiff`, no generation change, no
   * reassignment of `this.refs`. An open diff keeps resolving its ids while this runs, which is
   * what lets the dashboard summarise the repository the user already has open.
   */
  async summarise(): Promise<RepoSummary> {
    this.assertOpen();
    return this.single("summarise", async (signal) => {
      const refs = await loadRefs(this.db, this.cfg, { jj: this.jj });
      const operation = await detectOperation(this.fs, this.db, refs.refs);
      const index = await this.currentIndex();
      const headTree = refs.headOid ? await this.db.flattenTree(refs.headOid) : null;
      const status = await this.withRootCheck(() =>
        this.scanner.scan(index, headTree, signal, { hashes: false }),
      );
      for (const w of status.warnings) RepoSession.emitWarning(this.sink, w);
      throwIfAborted(signal, "summary");

      const upstream =
        refs.headBranch !== null ? upstreamOf(this.cfg, refs, refs.headBranch) : null;
      const tracked =
        upstream !== null ? refs.refs.find((r) => r.name === upstream && !r.synthetic) : undefined;
      const vsUpstream =
        refs.headOid !== null && tracked
          ? await this.memoisedAheadBehind(refs.headOid, tracked.oid, signal)
          : null;

      let lastCommit: RepoSummary["lastCommit"] = null;
      if (refs.headOid !== null) {
        try {
          const commit = await this.db.readCommit(refs.headOid);
          lastCommit = {
            oid: commit.oid,
            subject: subjectOf(commit.message),
            timestamp: commit.committer.timestamp * 1000,
          };
        } catch (e) {
          RepoSession.emitWarning(this.sink, {
            code: "HISTORY_DEGRADED",
            message: "HEAD points at a commit that could not be read; the card has no last commit.",
            detail: `IO_ERROR: HEAD ${refs.headOid} (${e instanceof Error ? e.message : String(e)})`,
          });
        }
      }

      return {
        headBranch: refs.headBranch,
        headDisplay: refs.headDisplay,
        counts: {
          staged: Object.keys(status.staged).length,
          unstaged: Object.keys(status.unstaged).length,
          untracked: status.untracked.length,
          conflict: status.conflicts.length,
        },
        vsUpstream,
        lastCommit,
        operation,
        indexMtimeMs: index.indexMtimeMs,
      };
    });
  }

  // ---- bisect and rebase preflight (T10.11) ----------------------------------------------------

  /**
   * The next commit to test (atlas tab 15). The marks arrive as oids, but any revision expression
   * resolves too, so the UI may hand over what the user typed. Nothing is written (D16).
   */
  async bisectStep(state: BisectState): Promise<BisectStep> {
    this.assertOpen();
    return this.single("bisectStep", async (signal) => {
      const deps = {
        reader: await this.commitReader(),
        warn: (w: RepoWarning) => RepoSession.emitWarning(this.sink, w),
        signal,
      };
      return computeBisectStep(deps, {
        bad: await this.resolveCommit(state.bad),
        good: await Promise.all(state.good.map((g) => this.resolveCommit(g))),
        skipped: await Promise.all(state.skipped.map((s) => this.resolveCommit(s))),
      });
    });
  }

  /** What a `git rebase branchRef onto ontoRef` would replay, and where it would stop (tab 16). */
  async rebasePreflight(branchRef: string, ontoRef: string): Promise<PreflightResult> {
    this.assertOpen();
    return this.single("rebasePreflight", async (signal) => {
      const branch = await resolveRevision(this.db, this.refs, branchRef);
      const onto = await resolveRevision(this.db, this.refs, ontoRef);
      if (branch.oid === null || onto.oid === null)
        throw new EngineError(
          "REV_NOT_FOUND",
          `Cannot plan a rebase of "${branchRef}" onto "${ontoRef}".`,
          { hint: "Both sides must be commits." },
        );
      return computePreflight(
        {
          db: this.db,
          reader: await this.commitReader(),
          warn: (w: RepoWarning) => RepoSession.emitWarning(this.sink, w),
          signal,
          ...(this.cfg.diff.renames !== undefined ? { renames: this.cfg.diff.renames } : {}),
          ...(this.cfg.diff.renameLimit !== undefined
            ? { renameLimit: this.cfg.diff.renameLimit }
            : {}),
        },
        { oid: branch.oid, display: branch.display },
        { oid: onto.oid, display: onto.display },
      );
    });
  }

  // ---- submodules, worktrees and patch parsing (T10.12) ---------------------------------------

  /**
   * Every gitlink at HEAD with its `.gitmodules` URL and the commit checked out under the picked
   * folder (atlas tab 19). `dirty` is null — see `SubmoduleInfo`.
   */
  async listSubmodules(): Promise<SubmoduleInfo[]> {
    this.assertOpen();
    return this.single("listSubmodules", () =>
      listSubmodules({ fs: this.fs, db: this.db }, this.refs.headOid),
    );
  }

  /**
   * `git worktree list`: the main checkout (`isThis`) followed by one entry per
   * `.git/worktrees/<name>/`. Paths of linked checkouts are reported as recorded and never
   * verified — they are outside the folder the File System Access API granted (atlas tab 19).
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    this.assertOpen();
    return this.single("listWorktrees", () =>
      listWorktrees({ fs: this.fs, db: this.db }, this.refs, this.root.name),
    );
  }

  /**
   * One unified diff as diff rows (T10.12, Design §14.6). Nothing here touches the repository —
   * the same call answers without one through `PatchSession` — so an open diff is undisturbed and
   * no generation changes. `NOT_A_PATCH` when the text is not a unified diff.
   */
  async parsePatch(text: string): Promise<PatchResult> {
    this.assertOpen();
    return this.single("parsePatch", async () => parsePatch(text));
  }

  /** A repo-root text file, or null when it does not exist (`.diffgitignore-secrets`). */
  private async readTextOrNull(path: string): Promise<string | null> {
    try {
      return await this.fs.readText(`/${path}`);
    } catch (e) {
      const code = errorCode(e);
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
      throw e;
    }
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
      /* try file handle */
      try {
        await this.root.getFileHandle(".git"); // worktree-gitdir layout
        return true;
      } catch {
        /* root unreachable */
        return false;
      }
    }
  }

  private requireGeneration(generation: number): Current {
    this.assertOpen();
    return requireGeneration(this.current, generation);
  }

  // ---- per-file -------------------------------------------------------------------------------

  private async statsFor(cur: Current, f: FileDiff, signal?: AbortSignal): Promise<FileStats> {
    return this.statsQueue.statsFor(cur, f, signal);
  }

  async fileStats(generation: number, ids: string[]): Promise<Record<string, FileStats>> {
    return this.statsQueue.fileStats(generation, ids);
  }

  async fileDiff(generation: number, id: string, opts: FileDiffOptions): Promise<FileDiffPayload> {
    return this.diffRunner.fileDiff(generation, id, opts);
  }

  async cancelFileDiff(id: string): Promise<void> {
    return this.diffRunner.cancelFileDiff(id);
  }

  async conflict(generation: number, id: string): Promise<ConflictPayload> {
    return this.diffRunner.conflict(generation, id);
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
    return this.diffRunner.fileBytes(generation, id, side);
  }

  // ---- background stats -----------------------------------------------------------------------

  async prioritise(ids: string[]): Promise<void> {
    return this.statsQueue.prioritise(ids);
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
    return this.watchOrchestrator.probe(tier);
  }

  // ---- invalidation ---------------------------------------------------------------------------

  async invalidate(scope: InvalidateScope, paths?: string[]): Promise<void> {
    return this.watchOrchestrator.invalidate(scope, paths);
  }

  async forceRehash(): Promise<void> {
    return this.watchOrchestrator.forceRehash();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.diffRunner.abortAll();
    this.singleFlight.clear();
    for (const ac of this.singleAborts.values()) ac.abort();
    this.singleAborts.clear();
    this.statsQueue.stop();
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
