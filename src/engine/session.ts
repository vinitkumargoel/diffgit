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
import { loadSides } from "./diff/contentLoader";
import { DiffEngine } from "./diff/diffEngine";
import { parsePatch } from "./diff/parsePatch";
import { describeFile, HUGE_FILE_BYTES } from "./diff/textDiff";
import { EngineError, errorCode } from "./errors";
import type { DirHandleLike } from "./fs/dirHandleLike";
import { createFsaFs, type FsaFs } from "./fs/fsaFs";
import { GitAttributes } from "./git/attributes";
import { upstreamOf } from "./git/branches";
import { type GitConfig, loadGitConfig } from "./git/config";
import { explainPath } from "./git/explain";
import { IgnoreRules } from "./git/ignoreRules";
import { emptySnapshot, type IndexSnapshot, readIndex } from "./git/indexReader";
import { checkLayout } from "./git/layoutChecks";
import { ObjectDb } from "./git/objectDb";
import { detectOperation } from "./git/operation";
import { loadRefs } from "./git/refStore";
import { listSubmodules } from "./git/submodules";
import { subjectOf } from "./git/walk";
import { WorktreeScanner } from "./git/worktree";
import { listWorktrees } from "./git/worktrees";
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
import { HistoryCoordinator } from "./session/historyCoordinator";
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
  /** method name → token of the newest call (one in-flight per method, T10.1). */
  private readonly singleFlight = new Map<string, symbol>();
  /** T10.6: the abort controller of the in-flight call per method name (see `single`). */
  private readonly singleAborts = new Map<string, AbortController>();
  private readonly statsLimit: <T>(fn: () => Promise<T>) => Promise<T>;

  private readonly statsQueue: StatsQueue;
  private readonly diffRunner: DiffRunner;
  private readonly searchRunner: SearchRunner;
  private readonly watchOrchestrator: WatchOrchestrator;
  private readonly historyCoordinator: HistoryCoordinator;

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

    this.historyCoordinator = new HistoryCoordinator({
      fs: this.fs,
      db: this.db,
      cfg: this.cfg,
      getRefs: () => this.refs,
      statsLimit: this.statsLimit,
      progress: (p) => this.progress(p),
      emitWarning: (w) => RepoSession.emitWarning(this.sink, w),
      onRepoWarning: (w) => {
        if (!this.repoWarnings.some((x) => x.code === w.code)) this.repoWarnings.push(w);
        RepoSession.emitWarning(this.sink, w);
      },
      withRootCheck: (fn) => this.withRootCheck(fn),
      assertOpen: () => this.assertOpen(),
      single: (method, fn) => this.single(method, fn),
      readWorktreeBytes: (path) => this.readWorktreeBytes(path),
      readTextOrNull: (path) => this.readTextOrNull(path),
    });

    this.searchRunner = new SearchRunner({
      db: this.db,
      attrs: this.attrs,
      scanner: this.scanner,
      statsLimit: this.statsLimit,
      commitReader: () => this.historyCoordinator.commitReader(),
      refsByCommit: () => this.historyCoordinator.refsByCommit(),
      walkSeeds: (req, reader) => this.historyCoordinator.walkSeeds(req, reader),
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
      dropHistoryCaches: () => this.historyCoordinator.dropHistoryCaches(),
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
    this.historyCoordinator.dropHistoryCaches();
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
    return this.historyCoordinator.resolveRevision(expr);
  }

  async listTags(): Promise<TagInfo[]> {
    return this.historyCoordinator.listTags();
  }

  async listStashes(): Promise<StashInfo[]> {
    return this.historyCoordinator.listStashes();
  }

  async reflog(expr: string, limit: number): Promise<ReflogEntry[]> {
    return this.historyCoordinator.reflog(expr, limit);
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

  async walkCommits(req: WalkRequest): Promise<WalkPage> {
    return this.historyCoordinator.walkCommits(req);
  }

  async commitDetails(oid: Oid): Promise<CommitDetails> {
    return this.historyCoordinator.commitDetails(oid);
  }

  async commitStats(oids: Oid[]): Promise<Record<Oid, CommitDetails["stats"]>> {
    return this.historyCoordinator.commitStats(oids);
  }

  async aheadBehind(a: string, b: string): Promise<AheadBehind> {
    return this.historyCoordinator.aheadBehind(a, b);
  }

  async branchOverview(): Promise<BranchRow[]> {
    return this.historyCoordinator.branchOverview();
  }

  async branchCells(
    fullNames: string[],
  ): Promise<Record<string, Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">>> {
    return this.historyCoordinator.branchCells(fullNames);
  }

  async markReachable(oids: Oid[]): Promise<Record<Oid, boolean>> {
    return this.historyCoordinator.markReachable(oids);
  }

  // ---- file history and blame (T10.6) ----------------------------------------------------------

  async pathHistory(
    ref: string,
    path: string,
    opts: PathHistoryOptions,
  ): Promise<{ entries: PathHistoryEntry[]; cursor: string | null }> {
    return this.historyCoordinator.pathHistory(ref, path, opts);
  }

  async blame(ref: string, path: string, opts: BlameRequest): Promise<BlamePayload> {
    return this.historyCoordinator.blame(ref, path, opts);
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

  async insights(req: InsightsRequest): Promise<InsightsResult> {
    return this.historyCoordinator.insights(req);
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
          ? await this.historyCoordinator.memoisedAheadBehind(refs.headOid, tracked.oid, signal)
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

  async bisectStep(state: BisectState): Promise<BisectStep> {
    return this.historyCoordinator.bisectStep(state);
  }

  async rebasePreflight(branchRef: string, ontoRef: string): Promise<PreflightResult> {
    return this.historyCoordinator.rebasePreflight(branchRef, ontoRef);
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
    this.historyCoordinator.dropHistoryCaches();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw NO_SESSION();
  }
}
