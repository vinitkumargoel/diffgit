import type { FileStats, Progress, ProgressSink } from "../api";
import { loadSides } from "../diff/contentLoader";
import { describeFile } from "../diff/textDiff";
import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { GitAttributes } from "../git/attributes";
import type { ObjectDb } from "../git/objectDb";
import type { FileDiff, RepoWarning } from "../types";
import { type Current, requireFile, requireGeneration, type SessionOptions } from "./types";

export function applyDescription(f: FileDiff, d: ReturnType<typeof describeFile>): void {
  f.stats = d.stats;
  f.binary = d.classification.binary;
  f.image = d.classification.image;
  f.tooLarge = d.classification.tooLarge;
  f.oldSize = d.classification.oldSize;
  f.newSize = d.classification.newSize;
  if (d.classification.generated) f.generated = true;
}

export interface StatsQueueDeps {
  db: ObjectDb;
  fs: FsaFs;
  attrs: GitAttributes;
  sink: ProgressSink;
  statsLimit: <T>(fn: () => Promise<T>) => Promise<T>;
  opts: SessionOptions;
  getCurrent: () => Current | null;
  isClosed: () => boolean;
  emitWarning: (w: RepoWarning) => void;
  progress: (p: Progress) => void;
  onStatsComplete?: (durationMs: number) => void;
  statsFor?: (cur: Current, f: FileDiff, signal?: AbortSignal) => Promise<FileStats>;
}

export class StatsQueue {
  private queue: string[] = []; // LIFO: pop() serves the most recently prioritised id
  private statsGen = 0;
  private statsActive = 0;
  private statsStartedAt = 0;

  constructor(private readonly deps: StatsQueueDeps) {}

  start(generation: number): void {
    const cur = this.deps.getCurrent();
    if (!cur) return;
    this.statsGen = generation;
    this.statsStartedAt = performance.now();
    // LIFO: push in path order so the top of the list (first rows) is served first.
    this.queue = cur.result.files.map((f) => f.id).reverse();
    void this.pumpStats(cur);
  }

  stop(): void {
    this.queue = [];
    this.statsGen = -1;
  }

  get startedAt(): number {
    return this.statsStartedAt;
  }

  setStartedAt(time: number): void {
    this.statsStartedAt = time;
  }

  async prioritise(ids: string[]): Promise<void> {
    const cur = this.deps.getCurrent();
    if (!cur || this.statsGen !== cur.generation) return;
    const wanted = new Set(ids);
    this.queue = this.queue.filter((id) => !wanted.has(id));
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i] as string;
      if (cur.byId.has(id) && !cur.stats.has(id)) this.queue.push(id);
    }
  }

  async statsFor(cur: Current, f: FileDiff, signal?: AbortSignal): Promise<FileStats> {
    const cached = cur.stats.get(f.id);
    if (cached !== undefined) return cached;
    const loaded = await loadSides(
      f,
      cur.comp.sides,
      { db: this.deps.db, fs: this.deps.fs },
      signal,
    );
    const path = (f.newPath ?? f.oldPath) as string;
    const d = describeFile(f, loaded, {
      ignoreWhitespace: false,
      statsOnly: true,
      attrBinary: await this.deps.attrs.isBinary(path),
      attrGenerated: await this.deps.attrs.isGenerated(path),
    });
    applyDescription(f, d);
    cur.stats.set(f.id, d.stats);
    return d.stats;
  }

  private async computeStatsFor(
    cur: Current,
    f: FileDiff,
    signal?: AbortSignal,
  ): Promise<FileStats> {
    if (this.deps.statsFor) {
      return this.deps.statsFor(cur, f, signal);
    }
    return this.statsFor(cur, f, signal);
  }

  async fileStats(generation: number, ids: string[]): Promise<Record<string, FileStats>> {
    const cur = requireGeneration(this.deps.getCurrent(), generation);
    const out: Record<string, FileStats> = {};
    await Promise.all(
      ids.map((id) =>
        this.deps.statsLimit(async () => {
          const f = requireFile(cur, id);
          try {
            out[id] = await this.computeStatsFor(cur, f);
          } catch (e) {
            // one unreadable file must not blank the whole batch (T7.5 review); same as pumpStats
            if (errorCode(e) === "CANCELLED" || errorCode(e) === "STALE") throw e;
            out[id] = null;
            cur.stats.set(id, null);
            this.deps.emitWarning({
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

  private async pumpStats(cur: Current): Promise<void> {
    // A running pump belongs to an older generation once `this.current` moves on; its workers exit
    // after their in-flight read and the `finally` below re-launches for the new generation
    // (T7.5 review: previously the new generation's stats never started in that window).
    if (this.statsActive > 0) return;
    this.statsActive++;
    const batchSize = this.deps.opts.statsBatchSize ?? 32;
    const batchMs = this.deps.opts.statsBatchMs ?? 100;
    let batch: Record<string, FileStats> = {};
    let batchCount = 0;
    let batchStarted = performance.now();
    let done = 0;
    const total = cur.result.files.length;
    const flush = () => {
      if (batchCount === 0) return;
      try {
        void this.deps.sink.onStats({ generation: cur.generation, stats: batch });
      } catch {
        /* dead sink */
      }
      batch = {};
      batchCount = 0;
      batchStarted = performance.now();
      this.deps.progress({ phase: "stats", done, total });
    };
    try {
      const workers: Promise<void>[] = [];
      const concurrency = this.deps.opts.statsConcurrency ?? 4;
      for (let w = 0; w < concurrency; w++) {
        workers.push(
          (async () => {
            while (
              this.statsGen === cur.generation &&
              this.deps.getCurrent() === cur &&
              !this.deps.isClosed()
            ) {
              const id = this.queue.pop();
              if (id === undefined) return;
              const f = cur.byId.get(id);
              if (!f || cur.stats.has(id)) continue;
              try {
                const s = await this.computeStatsFor(cur, f);
                if (this.deps.getCurrent() !== cur) return;
                batch[id] = s;
                batchCount++;
                done++;
                if (batchCount >= batchSize || performance.now() - batchStarted > batchMs) flush();
              } catch (e) {
                if (this.deps.getCurrent() !== cur) return;
                cur.stats.set(id, null);
                batch[id] = null;
                batchCount++;
                done++;
                this.deps.emitWarning({
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
      if (this.deps.getCurrent() === cur) {
        flush();
        const durationMs = performance.now() - this.statsStartedAt;
        this.deps.onStatsComplete?.(durationMs);
      }
    } finally {
      this.statsActive--;
      const now = this.deps.getCurrent();
      if (
        this.statsActive === 0 &&
        now &&
        now !== cur &&
        !this.deps.isClosed() &&
        this.statsGen === now.generation &&
        this.queue.length > 0
      ) {
        void this.pumpStats(now);
      }
    }
  }
}
