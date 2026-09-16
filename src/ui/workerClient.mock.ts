/**
 * Recorded-JSON mock of the engine (T4.1), selected by `VITE_MOCK_ENGINE=1`. Serves the real engine
 * recordings `src/test/recorded/{basic,worktree}.*.json` (T3.5, `bun run record`) plus the
 * hand-written `showcase` / `showcase-worktree` sets (renames, binary, image, submodule, large file,
 * remote refs) under those handle names, computes hunks from deterministic texts, pushes stats over
 * the sink in batches, and exposes `mutate()` so `probe()` signatures change.
 */
import type { FileStats, ProgressSink } from "../engine/api";
import type { DiffResult, DiffSource, FileDiff, RepoInfo } from "../engine/types";
import realBasicDiff from "../test/recorded/basic.diffresult.json";
import realBasicInfo from "../test/recorded/basic.repoinfo.json";
import basicDiff from "../test/recorded/showcase.diffresult.json";
import basicInfo from "../test/recorded/showcase.repoinfo.json";
import worktreeDiff from "../test/recorded/showcase-worktree.diffresult.json";
import worktreeInfo from "../test/recorded/showcase-worktree.repoinfo.json";
import realWorktreeDiff from "../test/recorded/worktree.diffresult.json";
import realWorktreeInfo from "../test/recorded/worktree.repoinfo.json";
import type { UiError } from "./errors";
import { mockPayload, mockTexts } from "./mock/mockContents";
import { syntheticLarge } from "./mock/syntheticLarge";
import type { RestartListener, WorkerClient } from "./workerClient";

export interface MockWorkerClient extends WorkerClient {
  isMock: true;
  /** Simulates a change on disk: probe signatures change and the next compute bumps `computedAt`. */
  mutate(): void;
  /** Trigger crash-recovery listeners as the real client would. */
  simulateRestart(): void;
  /** Delay (ms) before async responses resolve; 0 in tests. */
  latency: number;
}

const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167WwAAAABJRU5ErkJggg==";
const PNG_BLUE =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAD0lEQVR42mNgYPgPQ5gsAH2gCPimIH9kAAAAAElFTkSuQmCC";

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const RECORDED: Record<string, { info: RepoInfo; diff: DiffResult }> = {
  basic: { info: realBasicInfo as RepoInfo, diff: realBasicDiff as DiffResult },
  worktree: { info: realWorktreeInfo as RepoInfo, diff: realWorktreeDiff as DiffResult },
  showcase: { info: basicInfo as RepoInfo, diff: basicDiff as DiffResult },
  "showcase-worktree": { info: worktreeInfo as RepoInfo, diff: worktreeDiff as DiffResult },
  // synthetic 5,000-file repo (Plan §6.7) for virtualisation checks; handle name "large"
  large: syntheticLarge({ info: basicInfo as RepoInfo, diff: basicDiff as DiffResult }),
  // T5.5 demo recordings: empty diff (Plan D7) and warning banners; handle names "empty" / "warned"
  empty: {
    info: basicInfo as RepoInfo,
    diff: {
      ...(basicDiff as DiffResult),
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
    },
  },
  warned: {
    info: {
      ...(basicInfo as RepoInfo),
      warnings: [
        { code: "AUTOCRLF", message: "core.autocrlf is true" },
        { code: "WORKTREE_NOT_APPLICABLE", message: "source is not checked out" },
      ],
    },
    diff: {
      ...(basicDiff as DiffResult),
      warnings: [
        { code: "UNRELATED_HISTORIES", message: "no merge base" },
        {
          code: "SPLIT_INDEX",
          message: "index has a link extension",
          detail: "Run git update-index --no-split-index to restore uncommitted changes.",
        },
      ],
    },
  },
};

/** Handle names that make `open()` fail with a public error (ErrorScreen demos). */
const FAILING_HANDLES: Record<string, UiError> = {
  notarepo: { code: "NOT_A_REPO", message: "No .git directory in notarepo" },
  gone: { code: "HANDLE_GONE", message: "NotFoundError: the directory was moved" },
  denied: { code: "PERMISSION", message: "NotAllowedError: read permission not granted" },
  broken: { code: "IO_ERROR", message: "EIO: i/o error, open '.git/index'" },
};

function err(code: UiError["code"], message: string): UiError {
  return { code, message };
}

export function createMockWorkerClient(opts: { latency?: number } = {}): MockWorkerClient {
  let current: { info: RepoInfo; diff: DiffResult } | null = null;
  let sink: ProgressSink | null = null;
  let generation = 0;
  let mutations = 0;
  let lastSrc: DiffSource | null = null;
  let lastResult: DiffResult | null = null;
  const restartListeners = new Set<RestartListener>();
  let statsTimer: ReturnType<typeof setTimeout> | null = null;
  const client: MockWorkerClient = {
    isMock: true,
    latency: opts.latency ?? 0,
    async open(handle, s) {
      const name =
        typeof handle === "object" &&
        handle !== null &&
        typeof (handle as { name?: unknown }).name === "string"
          ? (handle as { name: string }).name
          : "basic";
      const failure = FAILING_HANDLES[name];
      if (failure) {
        await wait(client.latency);
        throw failure;
      }
      const rec = RECORDED[name] ?? RECORDED.basic;
      if (!rec) throw err("INTERNAL", "no recording");
      sink = s;
      current = rec;
      generation = 0;
      lastSrc = null;
      lastResult = null;
      for (const phase of ["layout", "config", "refs", "index"] as const) {
        s.onProgress({ phase, durationMs: 1 });
        await wait(client.latency);
      }
      for (const w of rec.info.warnings) s.onWarning(w);
      return { ...rec.info, name };
    },
    async info() {
      if (!current) throw err("INTERNAL", "no repo open");
      return current.info;
    },
    async reloadRefs() {
      if (!current) throw err("INTERNAL", "no repo open");
      await wait(client.latency);
      return current.info;
    },
    async computeDiff(src) {
      if (!current) throw err("INTERNAL", "no repo open");
      if (statsTimer) clearTimeout(statsTimer);
      lastSrc = src;
      const gen = ++generation;
      sink?.onProgress({ phase: "diff" });
      await wait(client.latency);
      if (gen !== generation) throw err("CANCELLED", "superseded");
      let files: FileDiff[] = current.diff.files;
      if (!src.includeWorktree || src.sourceRef !== `refs/heads/${current.info.headBranch}`) {
        files = files
          .filter((f) => f.layers.includes("committed"))
          .map((f) => ({ ...f, layers: ["committed"] as FileDiff["layers"] }));
      }
      if (
        src.sourceRef === src.targetRef &&
        files.every((f) => f.layers.every((l) => l === "committed"))
      ) {
        files = [];
      }
      const totals = files.reduce(
        (t, f) => ({
          files: t.files + 1,
          additions: t.additions + (f.stats?.additions ?? 0),
          deletions: t.deletions + (f.stats?.deletions ?? 0),
        }),
        { files: 0, additions: 0, deletions: 0 },
      );
      // stats arrive later over the sink, like the real worker
      const result: DiffResult = {
        ...current.diff,
        source: src,
        files: files.map((f) => ({ ...f, stats: null })),
        totals,
        generation: gen,
        computedAt: 1758000000000 + mutations * 1000,
        durationMs: 5 + mutations,
        warnings:
          src.includeWorktree && files.some((f) => f.layers.length > 0)
            ? current.diff.warnings
            : [],
      };
      lastResult = result;
      scheduleStats(files, gen);
      sink?.onProgress({ phase: "diff", durationMs: result.durationMs });
      return result;
    },
    async fileStats(gen, ids) {
      const files = requireGen(gen);
      const out: Record<string, FileStats> = {};
      for (const id of ids) {
        const f = files.find((x) => x.id === id);
        if (f) out[id] = mockPayload(f, gen, false, true).stats;
      }
      return out;
    },
    async fileDiff(gen, id, o) {
      const files = requireGen(gen);
      const f = files.find((x) => x.id === id);
      if (!f) throw err("INTERNAL", `unknown file ${id}`);
      await wait(client.latency);
      return mockPayload(f, gen, o.ignoreWhitespace, o.loadLarge === true);
    },
    async cancelFileDiff() {},
    async fileBytes(gen, id, side) {
      const files = requireGen(gen);
      const f = files.find((x) => x.id === id);
      if (!f) throw err("INTERNAL", `unknown file ${id}`);
      if (side === "old" && f.oldOid === null) return null;
      if (side === "new" && f.newOid === null) return null;
      if (f.image) return b64(side === "old" ? PNG_RED : PNG_BLUE);
      const text = mockTexts(f)[side === "old" ? 0 : 1];
      if (text !== null) return new TextEncoder().encode(text);
      // opaque binary: deterministic bytes of the recorded size (BinaryNotice "View as text")
      const size = side === "old" ? f.oldSize : f.newSize;
      return Uint8Array.from({ length: size }, (_, i) => (i * 37 + 11) & 0xff);
    },
    async prioritise() {},
    async probe(tier) {
      return `${tier}:${mutations}`;
    },
    async invalidate() {},
    async forceRehash() {},
    async close() {
      if (statsTimer) clearTimeout(statsTimer);
      current = null;
      sink = null;
      lastSrc = null;
      lastResult = null;
    },
    onRestart(listener) {
      restartListeners.add(listener);
      return () => {
        restartListeners.delete(listener);
      };
    },
    lastSource: () => lastSrc,
    terminate() {
      if (statsTimer) clearTimeout(statsTimer);
      current = null;
    },
    mutate() {
      mutations++;
    },
    simulateRestart() {
      for (const l of restartListeners) l(current?.info ?? null, null);
    },
  };

  function requireGen(gen: number): FileDiff[] {
    if (!lastResult || gen !== lastResult.generation)
      throw err("STALE", `generation ${gen} is not current`);
    return lastResult.files;
  }

  function scheduleStats(files: FileDiff[], gen: number): void {
    const queue = [...files];
    const tick = () => {
      if (gen !== generation || !sink) return;
      const batch = queue.splice(0, 5);
      if (batch.length === 0) return;
      const stats: Record<string, FileStats> = {};
      // Recorded stats win (they match the real engine's numbers); synthesise only when missing.
      for (const f of batch) stats[f.id] = f.stats ?? mockPayload(f, gen, false, true).stats;
      sink.onStats({ generation: gen, stats });
      sink.onProgress({ phase: "stats", done: files.length - queue.length, total: files.length });
      if (queue.length) statsTimer = setTimeout(tick, client.latency);
    };
    statsTimer = setTimeout(tick, 0);
  }

  return client;
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
