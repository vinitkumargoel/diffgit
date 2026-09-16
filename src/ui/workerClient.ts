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
  EngineApi,
  FileDiffOptions,
  FileDiffPayload,
  FileStats,
  InvalidateScope,
  ProbeTier,
  ProgressSink,
} from "../engine/api";
import type { DiffResult, DiffSource, RepoInfo } from "../engine/types";
import { toUiError, type UiError } from "./errors";

export type RestartListener = (info: RepoInfo | null, error: UiError | null) => void;

/** What the store sees. Same methods as `EngineApi` plus lifecycle helpers. */
export interface WorkerClient {
  open(handle: unknown, sink: ProgressSink): Promise<RepoInfo>;
  info(): Promise<RepoInfo>;
  reloadRefs(): Promise<RepoInfo>;
  computeDiff(src: DiffSource): Promise<DiffResult>;
  fileStats(generation: number, ids: string[]): Promise<Record<string, FileStats>>;
  fileDiff(generation: number, id: string, opts: FileDiffOptions): Promise<FileDiffPayload>;
  cancelFileDiff(id: string): Promise<void>;
  fileBytes(generation: number, id: string, side: "old" | "new"): Promise<Uint8Array | null>;
  prioritise(ids: string[]): Promise<void>;
  probe(tier: ProbeTier): Promise<string>;
  invalidate(scope: InvalidateScope, paths?: string[]): Promise<void>;
  forceRehash(): Promise<void>;
  close(): Promise<void>;
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
  let proxiedSink: (ProgressSink & Comlink.ProxyMarked) | null = null;
  let lastSrc: DiffSource | null = null;

  function boot(): void {
    worker = factory();
    remote = Comlink.wrap<EngineApi>(worker);
    dead = false;
    worker.addEventListener("error", (ev) => onCrash((ev as ErrorEvent).message ?? "worker error"));
    worker.addEventListener("messageerror", () =>
      onCrash("worker message could not be deserialised"),
    );
  }

  function ensure(): Comlink.Remote<EngineApi> {
    if (closed) throw { code: "INTERNAL", message: "worker client is terminated" };
    if (!remote || dead) boot();
    return remote as Comlink.Remote<EngineApi>;
  }

  async function call<T>(fn: (r: Comlink.Remote<EngineApi>) => Promise<T>): Promise<T> {
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

  function onCrash(reason: string): void {
    if (dead || closed) return;
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
      proxiedSink = Comlink.proxy(retainedSink);
      const info = await (remote as Comlink.Remote<EngineApi>).open(retainedHandle, proxiedSink);
      for (const l of restartListeners) l(info, null);
    } catch (e) {
      for (const l of restartListeners) l(null, toUiError(e));
    }
  }

  const client: WorkerClient = {
    isMock: false,
    async open(handle, sink) {
      retainedHandle = handle;
      retainedSink = sink;
      lastSrc = null;
      proxiedSink = Comlink.proxy(sink);
      return call((r) => r.open(handle, proxiedSink as ProgressSink));
    },
    info: () => call((r) => r.info()),
    reloadRefs: () => call((r) => r.reloadRefs()),
    computeDiff(src) {
      lastSrc = src;
      return call((r) => r.computeDiff(src));
    },
    fileStats: (generation, ids) => call((r) => r.fileStats(generation, ids)),
    fileDiff: (generation, id, opts) => call((r) => r.fileDiff(generation, id, opts)),
    cancelFileDiff: (id) => call((r) => r.cancelFileDiff(id)),
    fileBytes: (generation, id, side) => call((r) => r.fileBytes(generation, id, side)),
    prioritise: (ids) => call((r) => r.prioritise(ids)),
    probe: (tier) => call((r) => r.probe(tier)),
    invalidate: (scope, paths) => call((r) => r.invalidate(scope, paths)),
    forceRehash: () => call((r) => r.forceRehash()),
    async close() {
      retainedHandle = null;
      retainedSink = null;
      lastSrc = null;
      if (remote && !dead) await call((r) => r.close());
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
