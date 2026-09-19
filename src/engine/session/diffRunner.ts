import type { ConflictPayload, FileDiffOptions, FileDiffPayload, Progress } from "../api";
import { isImagePath } from "../diff/binary";
import { buildConflictPayload } from "../diff/conflict";
import { loadSide, loadSides } from "../diff/contentLoader";
import type { DiffComputation, DiffEngine } from "../diff/diffEngine";
import { type PatchRow, patchText as renderPatch } from "../diff/patchText";
import { detectRenames } from "../diff/renames";
import { describeFile, HUGE_FILE_BYTES, LARGE_FILE_BYTES, toPayload } from "../diff/textDiff";
import { EngineError, errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { GitAttributes } from "../git/attributes";
import type { GitConfig } from "../git/config";
import { hashBlob } from "../git/hash";
import type { IgnoreRules } from "../git/ignoreRules";
import { readIndex } from "../git/indexReader";
import type { ObjectDb } from "../git/objectDb";
import type {
  DiffResult,
  DiffSource,
  FileDiff,
  RefSnapshot,
  RepoOperation,
  RepoWarning,
} from "../types";
import { CancelledError, throwIfAborted } from "../util/concurrency";
import { applyDescription } from "./statsQueue";
import { type Current, isDiffComputation, requireFile, requireGeneration } from "./types";

export interface DiffRunnerDeps {
  fs: FsaFs;
  db: ObjectDb;
  cfg: GitConfig;
  attrs: GitAttributes;
  ignore: IgnoreRules;
  engine: DiffEngine;
  getCurrent: () => Current | null;
  setCurrent: (cur: Current) => void;
  nextGeneration: () => number;
  setLastSource: (src: DiffSource) => void;
  assertOpen: () => void;
  progress: (p: Progress) => void;
  emitWarning: (w: RepoWarning) => void;
  withRootCheck: <T>(fn: () => Promise<T>) => Promise<T>;
  single: <T>(method: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  stopStats: () => void;
  startStats: (gen: number) => void;
  checkMemory: () => void;
  onComputeSuccess: (result: DiffResult) => void;
  getOperationState: () => RepoOperation | null;
  refreshOperation: () => Promise<RepoOperation | null>;
  getRefs: () => RefSnapshot;
}

export class DiffRunner {
  private inflight: AbortController | null = null;
  private readonly fileDiffAborts = new Map<string, AbortController>();
  /** T10.3: one in-flight `conflict()` per file id; a newer call cancels the older. */
  private readonly conflictAborts = new Map<string, AbortController>();

  constructor(private readonly deps: DiffRunnerDeps) {}

  abortAll(): void {
    this.inflight?.abort();
    this.inflight = null;
    for (const ac of this.fileDiffAborts.values()) ac.abort();
    this.fileDiffAborts.clear();
    for (const ac of this.conflictAborts.values()) ac.abort();
    this.conflictAborts.clear();
  }

  async computeDiff(src: DiffSource): Promise<DiffResult> {
    this.deps.assertOpen();
    this.inflight?.abort();
    const ac = new AbortController();
    this.inflight = ac;
    const generation = this.deps.nextGeneration();
    this.deps.stopStats();
    this.deps.setLastSource(src);
    const started = performance.now();
    try {
      const comp = await this.withStaleRetry(
        () => this.deps.engine.compute(src, ac.signal),
        ac.signal,
      );
      throwIfAborted(ac.signal, "diff");
      this.deps.progress({
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
      const current: Current = {
        generation,
        source: src,
        comp,
        result,
        byId: new Map(files.map((f) => [f.id, f])),
        stats: new Map(),
      };
      this.deps.setCurrent(current);
      this.deps.onComputeSuccess(result);
      this.deps.checkMemory();
      this.deps.startStats(generation);
      return result;
    } catch (e) {
      if (ac.signal.aborted && !(e instanceof CancelledError)) throw new CancelledError("diff");
      throw e;
    } finally {
      if (this.inflight === ac) this.inflight = null;
    }
  }

  async applyRenames(comp: DiffComputation, signal: AbortSignal): Promise<FileDiff[]> {
    const t0 = performance.now();
    let files = comp.files;
    if (this.deps.cfg.diff.renames !== false) {
      const src = { db: this.deps.db, fs: this.deps.fs };
      const res = await detectRenames(
        files,
        async (f, side) => (await loadSide(f, side, comp.sides, src, signal)) ?? new Uint8Array(),
        { limit: this.deps.cfg.diff.renameLimit, signal },
      );
      files = res.files;
      for (const w of res.warnings) comp.warnings.push(w);
    }
    for (const f of files) {
      f.image = isImagePath(f.id);
      if (f.oldSize > LARGE_FILE_BYTES || f.newSize > LARGE_FILE_BYTES) f.tooLarge = true;
    }
    this.deps.progress({ phase: "renames", durationMs: performance.now() - t0 });
    return files;
  }

  async fileDiff(generation: number, id: string, opts: FileDiffOptions): Promise<FileDiffPayload> {
    const cur = requireGeneration(this.deps.getCurrent(), generation);
    const f = requireFile(cur, id);
    this.fileDiffAborts.get(id)?.abort();
    const ac = new AbortController();
    this.fileDiffAborts.set(id, ac);
    try {
      const loaded = await loadSides(
        f,
        cur.comp.sides,
        { db: this.deps.db, fs: this.deps.fs },
        ac.signal,
      );
      throwIfAborted(ac.signal, "file diff");
      const path = (f.newPath ?? f.oldPath) as string;
      const d = describeFile(f, loaded, {
        ignoreWhitespace: opts.ignoreWhitespace,
        loadLarge: opts.loadLarge,
        attrBinary: await this.deps.attrs.isBinary(path),
        attrGenerated: await this.deps.attrs.isGenerated(path),
      });
      if (this.deps.getCurrent() === cur) {
        applyDescription(f, d);
        if (!cur.stats.has(f.id)) cur.stats.set(f.id, d.stats);
      }
      if (d.warning) this.deps.emitWarning(d.warning);
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

  async conflict(generation: number, id: string): Promise<ConflictPayload> {
    const cur = requireGeneration(this.deps.getCurrent(), generation);
    const f = requireFile(cur, id);
    this.conflictAborts.get(id)?.abort();
    const ac = new AbortController();
    this.conflictAborts.set(id, ac);
    try {
      const path = (f.newPath ?? f.oldPath ?? id) as string;
      const index = await this.deps.withRootCheck(() => readIndex(this.deps.fs));
      throwIfAborted(ac.signal, "conflict");
      const stages = index.conflicts[path];
      if (!stages || stages.length === 0) {
        throw new EngineError(
          "INTERNAL",
          `"${id}" has no conflict stages in the index (nothing to compare three ways).`,
          { path },
        );
      }
      const operation = this.deps.getOperationState() ?? (await this.deps.refreshOperation());
      throwIfAborted(ac.signal, "conflict");
      return await this.deps.withRootCheck(() =>
        buildConflictPayload(
          { db: this.deps.db, fs: this.deps.fs },
          {
            id,
            path,
            generation,
            stages,
            refs: this.deps.getRefs(),
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

  async fileBytes(generation: number, id: string, side: "old" | "new"): Promise<Uint8Array | null> {
    const cur = requireGeneration(this.deps.getCurrent(), generation);
    const f = requireFile(cur, id);
    const bytes = await loadSide(f, side, cur.comp.sides, { db: this.deps.db, fs: this.deps.fs });
    if (bytes && bytes.byteLength > HUGE_FILE_BYTES) {
      throw new EngineError("TOO_LARGE", `${id} (${side}) is ${bytes.byteLength} bytes.`, {
        hint: "Files over 10 MB are never transferred to the page.",
        path: f.newPath ?? f.oldPath ?? id,
      });
    }
    return bytes;
  }

  async patchText(generation: number, ids: string[] | null): Promise<string> {
    requireGeneration(this.deps.getCurrent(), generation);
    return this.deps.single("patchText", async (signal) => {
      const cur = requireGeneration(this.deps.getCurrent(), generation);
      const wanted = new Set(ids ?? []);
      if (ids !== null) for (const id of ids) requireFile(cur, id);
      const files =
        ids === null ? cur.result.files : cur.result.files.filter((f) => wanted.has(f.id));
      const rows: PatchRow[] = [];
      for (const f of files) {
        throwIfAborted(signal, "patch");
        const path = (f.newPath ?? f.oldPath) as string;
        const loaded = await loadSides(
          f,
          cur.comp.sides,
          { db: this.deps.db, fs: this.deps.fs },
          signal,
        );
        const description = describeFile(f, loaded, {
          ignoreWhitespace: false,
          loadLarge: true,
          attrBinary: await this.deps.attrs.isBinary(path),
          attrGenerated: await this.deps.attrs.isGenerated(path),
        });
        rows.push({
          file: f,
          description,
          oldOid: f.oldOid,
          newOid: f.newOid ?? (loaded.new ? await hashBlob(loaded.new) : null),
        });
      }
      return renderPatch(rows);
    });
  }

  /** Object reads that hit a pack renamed by `git gc` → drop caches and retry once (amendment). */
  private async withStaleRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await this.deps.withRootCheck(fn);
    } catch (e) {
      const code = errorCode(e);
      if (signal.aborted || (code !== "ENOENT" && code !== "IO_ERROR")) throw e;
      this.deps.db.dropCaches(true);
      this.deps.fs.invalidateAll();
      this.deps.ignore.invalidate();
      this.deps.attrs.invalidate();
      const w: RepoWarning = {
        code: "STALE_PACK_RETRIED",
        message: "Repository files changed while reading; the computation was retried.",
      };
      const out = await this.deps.withRootCheck(fn);
      if (isDiffComputation(out) && !out.warnings.some((x) => x.code === w.code))
        out.warnings.push(w);
      return out;
    }
  }
}
