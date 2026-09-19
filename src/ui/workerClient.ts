/**
 * Typed comlink proxy to the engine worker (T4.1). The UI talks to the engine only through this
 * module (the store is the sole importer — grep guard in scripts/check-guards.sh).
 *
 * Crash recovery (amendment): `worker.onerror` / `messageerror` marks the client dead, rejects every
 * in-flight call with `WORKER_CRASHED`, recreates the worker and re-opens the retained handle with the
 * retained sink, then notifies `onRestart` listeners so the store can recompute the last DiffSource.
 */
import * as Comlink from "comlink";
import type {
  ConflictPayload,
  EngineApi,
  EngineMetrics,
  FileDiffOptions,
  FileDiffPayload,
  FileStats,
  InvalidateScope,
  OpenOptions,
  ProbeTier,
  ProgressSink,
} from "../engine/api";
import type {
  AheadBehind,
  BranchRow,
  CommitDetails,
  DiffResult,
  DiffSource,
  HiddenEntry,
  Oid,
  PathExplanation,
  ReflogEntry,
  RepoInfo,
  RepoOperation,
  ResolvedRevision,
  StashInfo,
  TagInfo,
  WalkPage,
  WalkRequest,
} from "../engine/types";
import { toUiError, type UiError } from "./errors";

export type RestartListener = (info: RepoInfo | null, error: UiError | null) => void;

export interface ClientMetrics {
  calls: Record<string, number>;
  sink: { progress: number; stats: number; warnings: number };
  /** Approximate JSON size of the last DiffResult received (bytes). */
  lastResultBytes: number | null;
}

export function newClientMetrics(): ClientMetrics {
  return { calls: {}, sink: { progress: 0, stats: 0, warnings: 0 }, lastResultBytes: null };
}

/** Rough structured-clone size of a result: JSON length is a fair proxy for the debug panel. */
export function approxBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** Wraps a sink so the client can count what the worker sends back. */
function countingSink(sink: ProgressSink, m: ClientMetrics): ProgressSink {
  return {
    onProgress: (p) => {
      m.sink.progress++;
      sink.onProgress(p);
    },
    onStats: (b) => {
      m.sink.stats++;
      sink.onStats(b);
    },
    onWarning: (w) => {
      m.sink.warnings++;
      sink.onWarning(w);
    },
  };
}

/** What the store sees. Same methods as `EngineApi` plus lifecycle helpers. */
export interface WorkerClient {
  /** `opts` carries the page's preferences (T10.4: `builtinExcludes`, backlog B10). */
  open(handle: unknown, sink: ProgressSink, opts?: OpenOptions): Promise<RepoInfo>;
  info(): Promise<RepoInfo>;
  reloadRefs(): Promise<RepoInfo>;
  computeDiff(src: DiffSource): Promise<DiffResult>;
  resolveRevision(expr: string): Promise<ResolvedRevision>;
  listTags(): Promise<TagInfo[]>;
  listStashes(): Promise<StashInfo[]>;
  reflog(expr: string, limit: number): Promise<ReflogEntry[]>;
  operation(): Promise<RepoOperation | null>;
  fileStats(generation: number, ids: string[]): Promise<Record<string, FileStats>>;
  fileDiff(generation: number, id: string, opts: FileDiffOptions): Promise<FileDiffPayload>;
  cancelFileDiff(id: string): Promise<void>;
  /** Three-way view of one conflicted file (T10.3); `STALE`/`CANCELLED` as `fileDiff`. */
  conflict(generation: number, id: string): Promise<ConflictPayload>;
  /** Why one path is not in the diff (T10.4). */
  explainPath(path: string): Promise<PathExplanation>;
  /** The sidebar's Hidden group, on demand (T10.4); capped at 2,000 (`HIDDEN_CAPPED`). */
  listHidden(): Promise<HiddenEntry[]>;
  /** One page of `git log --date-order` with lanes and refs per row (T10.5). */
  walkCommits(req: WalkRequest): Promise<WalkPage>;
  /** The CommitCard payload for one commit (T10.5). */
  commitDetails(oid: Oid): Promise<CommitDetails>;
  /** `+n −m` per commit against its first parent, batched (T10.5). */
  commitStats(oids: Oid[]): Promise<Record<Oid, CommitDetails["stats"]>>;
  /** `git rev-list --left-right --count a...b` (T10.5). */
  aheadBehind(a: string, b: string): Promise<AheadBehind>;
  /** The Branches table, with the expensive cells null until `branchCells` (T10.5). */
  branchOverview(): Promise<BranchRow[]>;
  branchCells(
    fullNames: string[],
  ): Promise<Record<string, Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">>>;
  /** Which commits are reachable from any ref — the reflog's `unreachable` badge (T10.5). */
  markReachable(oids: Oid[]): Promise<Record<Oid, boolean>>;
  fileBytes(generation: number, id: string, side: "old" | "new"): Promise<Uint8Array | null>;
  prioritise(ids: string[]): Promise<void>;
  probe(tier: ProbeTier): Promise<string>;
  invalidate(scope: InvalidateScope, paths?: string[]): Promise<void>;
  forceRehash(): Promise<void>;
  metrics(): Promise<EngineMetrics>;
  close(): Promise<void>;
  /** Client-side counters for the debug panel (T7.2): calls per method and sink events received. */
  clientMetrics(): ClientMetrics;
  /** Called after a crash once the worker has been recreated and re-opened. Returns unsubscribe. */
  onRestart(listener: RestartListener): () => void;
  /** The DiffSource last passed to computeDiff (for the store to recompute after a restart). */
  lastSource(): DiffSource | null;
  /** Tear down the worker for good (repo switch to nothing / tests). */
  terminate(): void;
  /** True for the recorded-JSON mock. */
  readonly isMock: boolean;
}

type Pending = { reject: (e: unknown) => void };

function createWorker(): Worker {
  return new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
}

export function createWorkerClient(factory: () => Worker = createWorker): WorkerClient {
  let worker: Worker | null = null;
  let remote: Comlink.Remote<EngineApi> | null = null;
  let dead = false;
  let closed = false;
  const inflight = new Set<Pending>();
  const restartListeners = new Set<RestartListener>();
  let retainedHandle: unknown = null;
  let retainedSink: ProgressSink | null = null;
  let retainedOpen: OpenOptions | undefined;
  let proxiedSink: (ProgressSink & Comlink.ProxyMarked) | null = null;
  let lastSrc: DiffSource | null = null;
  const metrics = newClientMetrics();
  const count = (name: string) => {
    metrics.calls[name] = (metrics.calls[name] ?? 0) + 1;
  };

  function boot(): void {
    const w = factory();
    worker = w;
    remote = Comlink.wrap<EngineApi>(w);
    dead = false;
    // Bound to `w`: a late event from a worker that was already replaced must not restart again
    // (amendment: exactly one restart per crash).
    w.addEventListener("error", (ev) => onCrash(w, (ev as ErrorEvent).message ?? "worker error"));
    w.addEventListener("messageerror", () =>
      onCrash(w, "worker message could not be deserialised"),
    );
  }

  function ensure(): Comlink.Remote<EngineApi> {
    if (closed) throw { code: "INTERNAL", message: "worker client is terminated" };
    if (!remote || dead) boot();
    return remote as Comlink.Remote<EngineApi>;
  }

  async function call<T>(
    fn: (r: Comlink.Remote<EngineApi>) => Promise<T>,
    name = "call",
  ): Promise<T> {
    count(name);
    const r = ensure();
    const pending: Pending = { reject: () => {} };
    const crashed = new Promise<never>((_, reject) => {
      pending.reject = reject;
    });
    inflight.add(pending);
    try {
      return await Promise.race([fn(r), crashed]);
    } catch (e) {
      throw toUiError(e);
    } finally {
      inflight.delete(pending);
    }
  }

  function onCrash(source: Worker, reason: string): void {
    if (dead || closed || source !== worker) return;
    dead = true;
    const err: UiError = { code: "WORKER_CRASHED", message: `Engine worker crashed: ${reason}` };
    for (const p of inflight) p.reject(err);
    inflight.clear();
    worker?.terminate();
    worker = null;
    remote = null;
    void restart();
  }

  async function restart(): Promise<void> {
    boot();
    if (retainedHandle === null || retainedSink === null) {
      for (const l of restartListeners) l(null, null);
      return;
    }
    try {
      proxiedSink = Comlink.proxy(countingSink(retainedSink, metrics));
      const info = await (remote as Comlink.Remote<EngineApi>).open(
        retainedHandle,
        proxiedSink,
        retainedOpen,
      );
      for (const l of restartListeners) l(info, null);
    } catch (e) {
      for (const l of restartListeners) l(null, toUiError(e));
    }
  }

  const client: WorkerClient = {
    isMock: false,
    async open(handle, sink, openOpts) {
      retainedHandle = handle;
      retainedSink = sink;
      retainedOpen = openOpts;
      lastSrc = null;
      proxiedSink = Comlink.proxy(countingSink(sink, metrics));
      return call((r) => r.open(handle, proxiedSink as ProgressSink, openOpts), "open");
    },
    info: () => call((r) => r.info(), "info"),
    reloadRefs: () => call((r) => r.reloadRefs(), "reloadRefs"),
    async computeDiff(src) {
      lastSrc = src;
      const result = await call((r) => r.computeDiff(src), "computeDiff");
      metrics.lastResultBytes = approxBytes(result);
      return result;
    },
    resolveRevision: (expr) => call((r) => r.resolveRevision(expr), "resolveRevision"),
    listTags: () => call((r) => r.listTags(), "listTags"),
    listStashes: () => call((r) => r.listStashes(), "listStashes"),
    reflog: (expr, limit) => call((r) => r.reflog(expr, limit), "reflog"),
    operation: () => call((r) => r.operation(), "operation"),
    fileStats: (generation, ids) => call((r) => r.fileStats(generation, ids), "fileStats"),
    fileDiff: (generation, id, opts) => call((r) => r.fileDiff(generation, id, opts), "fileDiff"),
    cancelFileDiff: (id) => call((r) => r.cancelFileDiff(id), "cancelFileDiff"),
    conflict: (generation, id) => call((r) => r.conflict(generation, id), "conflict"),
    explainPath: (path) => call((r) => r.explainPath(path), "explainPath"),
    listHidden: () => call((r) => r.listHidden(), "listHidden"),
    walkCommits: (req) => call((r) => r.walkCommits(req), "walkCommits"),
    commitDetails: (oid) => call((r) => r.commitDetails(oid), "commitDetails"),
    commitStats: (oids) => call((r) => r.commitStats(oids), "commitStats"),
    aheadBehind: (a, b) => call((r) => r.aheadBehind(a, b), "aheadBehind"),
    branchOverview: () => call((r) => r.branchOverview(), "branchOverview"),
    branchCells: (fullNames) => call((r) => r.branchCells(fullNames), "branchCells"),
    markReachable: (oids) => call((r) => r.markReachable(oids), "markReachable"),
    fileBytes: (generation, id, side) =>
      call((r) => r.fileBytes(generation, id, side), "fileBytes"),
    prioritise: (ids) => call((r) => r.prioritise(ids), "prioritise"),
    probe: (tier) => call((r) => r.probe(tier), "probe"),
    invalidate: (scope, paths) => call((r) => r.invalidate(scope, paths), "invalidate"),
    forceRehash: () => call((r) => r.forceRehash(), "forceRehash"),
    metrics: () => call((r) => r.metrics(), "metrics"),
    clientMetrics: () => ({
      calls: { ...metrics.calls },
      sink: { ...metrics.sink },
      lastResultBytes: metrics.lastResultBytes,
    }),
    async close() {
      retainedHandle = null;
      retainedSink = null;
      retainedOpen = undefined;
      lastSrc = null;
      if (remote && !dead) await call((r) => r.close(), "close");
    },
    onRestart(listener) {
      restartListeners.add(listener);
      return () => {
        restartListeners.delete(listener);
      };
    },
    lastSource: () => lastSrc,
    terminate() {
      closed = true;
      worker?.terminate();
      worker = null;
      remote = null;
      for (const p of inflight) p.reject({ code: "CANCELLED", message: "client terminated" });
      inflight.clear();
    },
  };
  return client;
}
