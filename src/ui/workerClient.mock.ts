/**
 * Recorded-JSON mock of the engine (T4.1), selected by `VITE_MOCK_ENGINE=1`. Serves the real engine
 * recordings `src/test/recorded/{basic,worktree}.*.json` (T3.5, `bun run record`) plus the
 * hand-written `showcase` / `showcase-worktree` sets (renames, binary, image, submodule, large file,
 * remote refs) under those handle names, computes hunks from deterministic texts, pushes stats over
 * the sink in batches, and exposes `mutate()` so `probe()` signatures change.
 */
import type { ConflictPayload, FileStats, OpenOptions, ProgressSink } from "../engine/api";
import { isWorktreeSource, sourceRefs } from "../engine/diffSource";
import type {
  AheadBehind,
  BranchRow,
  CommitDetails,
  CommitSummary,
  DiffResult,
  DiffSource,
  FileDiff,
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
import realBasicDiff from "../test/recorded/basic.diffresult.json";
import realBasicInfo from "../test/recorded/basic.repoinfo.json";
import cherryDiff from "../test/recorded/cherry-pick-conflict.diffresult.json";
import cherryInfo from "../test/recorded/cherry-pick-conflict.repoinfo.json";
import cherryV2 from "../test/recorded/cherry-pick-conflict.v2.json";
import hiddenDiff from "../test/recorded/hidden.diffresult.json";
import hiddenInfo from "../test/recorded/hidden.repoinfo.json";
import hiddenV2 from "../test/recorded/hidden.v2.json";
import historyDiff from "../test/recorded/history.diffresult.json";
import historyInfo from "../test/recorded/history.repoinfo.json";
import historyV2 from "../test/recorded/history.v2.json";
import mergeDiff from "../test/recorded/merge-conflict.diffresult.json";
import mergeInfo from "../test/recorded/merge-conflict.repoinfo.json";
import mergeV2 from "../test/recorded/merge-conflict.v2.json";
import octopusDiff from "../test/recorded/octopus.diffresult.json";
import octopusInfo from "../test/recorded/octopus.repoinfo.json";
import octopusV2 from "../test/recorded/octopus.v2.json";
import rebaseDiff from "../test/recorded/rebase-conflict.diffresult.json";
import rebaseInfo from "../test/recorded/rebase-conflict.repoinfo.json";
import rebaseV2 from "../test/recorded/rebase-conflict.v2.json";
import orphanDiff from "../test/recorded/reflog-orphan.diffresult.json";
import orphanInfo from "../test/recorded/reflog-orphan.repoinfo.json";
import orphanV2 from "../test/recorded/reflog-orphan.v2.json";
import basicDiff from "../test/recorded/showcase.diffresult.json";
import basicInfo from "../test/recorded/showcase.repoinfo.json";
import worktreeDiff from "../test/recorded/showcase-worktree.diffresult.json";
import worktreeInfo from "../test/recorded/showcase-worktree.repoinfo.json";
import stashDiff from "../test/recorded/stash.diffresult.json";
import stashInfo from "../test/recorded/stash.repoinfo.json";
import stashV2 from "../test/recorded/stash.v2.json";
import tagsDiff from "../test/recorded/tags.diffresult.json";
import tagsInfo from "../test/recorded/tags.repoinfo.json";
import tagsV2 from "../test/recorded/tags.v2.json";
import realWorktreeDiff from "../test/recorded/worktree.diffresult.json";
import realWorktreeInfo from "../test/recorded/worktree.repoinfo.json";
import type { UiError } from "./errors";
import { mockPayload, mockTexts } from "./mock/mockContents";
import { syntheticLarge } from "./mock/syntheticLarge";
import {
  approxBytes,
  type ClientMetrics,
  newClientMetrics,
  type RestartListener,
  type WorkerClient,
} from "./workerClient";

/** What `bun run record` writes to `src/test/recorded/<fixture>.v2.json` (T10.1). */
interface RecordedV2 {
  tags: TagInfo[];
  stashes: StashInfo[];
  /** T10.2: `HEAD`'s reflog, newest first. */
  reflog: ReflogEntry[];
  /** T10.2: what git was in the middle of when the fixture was recorded. */
  operation: RepoOperation | null;
  /** T10.3: file id → the three-way payload of that conflicted file. */
  conflicts: Record<string, ConflictPayload>;
  /** T10.4: the whole Hidden group, and one explanation per recorded path. */
  hidden: HiddenEntry[];
  explanations: Record<string, PathExplanation>;
  revisions: Record<string, ResolvedRevision>;
  ranges: { source: DiffSource; result: DiffResult }[];
  /** T10.5: the whole history per walk variant; the mock pages it with an index cursor. */
  walks: Record<string, { commits: CommitSummary[]; graphAvailable: boolean }>;
  commits: Record<Oid, CommitDetails>;
  commitStats: Record<Oid, CommitDetails["stats"]>;
  branches: BranchRow[];
  aheadBehind: Record<string, AheadBehind>;
  reachable: Record<Oid, boolean>;
}

/**
 * Which recorded walk answers this request. Mirrors `walkVariants` in `scripts/record-fixtures.ts`:
 * a path filter wins, then `--all`, then `--first-parent`, else the plain walk from HEAD.
 */
function walkKey(req: WalkRequest): string {
  if (req.path) return `path:${req.path}`;
  if (req.all === true) return "all";
  return req.firstParent ? "first-parent" : "default";
}

export interface MockWorkerClient extends WorkerClient {
  isMock: true;
  /** What the last `open()` was given (T11.4 asserts the `builtinExcludes` preference travels). */
  lastOpenOptions: OpenOptions | undefined;
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

const RECORDED: Record<string, { info: RepoInfo; diff: DiffResult; v2?: RecordedV2 }> = {
  basic: { info: realBasicInfo as RepoInfo, diff: realBasicDiff as DiffResult },
  worktree: { info: realWorktreeInfo as RepoInfo, diff: realWorktreeDiff as DiffResult },
  // v2 fixtures (T10.1): tags, stashes and range diffs recorded from the real engine
  tags: {
    info: tagsInfo as RepoInfo,
    diff: tagsDiff as DiffResult,
    v2: tagsV2 as unknown as RecordedV2,
  },
  stash: {
    info: stashInfo as RepoInfo,
    diff: stashDiff as DiffResult,
    v2: stashV2 as unknown as RecordedV2,
  },
  history: {
    info: historyInfo as RepoInfo,
    diff: historyDiff as DiffResult,
    v2: historyV2 as unknown as RecordedV2,
  },
  // T10.2: the two fixtures that are genuinely mid-operation (banner + reflog panel)
  "rebase-conflict": {
    info: rebaseInfo as RepoInfo,
    diff: rebaseDiff as DiffResult,
    v2: rebaseV2 as unknown as RecordedV2,
  },
  "merge-conflict": {
    info: mergeInfo as RepoInfo,
    diff: mergeDiff as DiffResult,
    v2: mergeV2 as unknown as RecordedV2,
  },
  // T10.3: the third interrupted fixture, so the conflict card has a cherry-pick to render too
  "cherry-pick-conflict": {
    info: cherryInfo as RepoInfo,
    diff: cherryDiff as DiffResult,
    v2: cherryV2 as unknown as RecordedV2,
  },
  // T10.5: the three-parent merge, so the lane column has an octopus to draw (T11.5)
  octopus: {
    info: octopusInfo as RepoInfo,
    diff: octopusDiff as DiffResult,
    v2: octopusV2 as unknown as RecordedV2,
  },
  // T11.5: the reset that orphaned two commits, so the Reflog tab has a real `unreachable` row
  "reflog-orphan": {
    info: orphanInfo as RepoInfo,
    diff: orphanDiff as DiffResult,
    v2: orphanV2 as unknown as RecordedV2,
  },
  // T10.4: the ignored dir / ignored file / index flags / 11 MB file, for the Hidden group (T11.4)
  hidden: {
    info: hiddenInfo as RepoInfo,
    diff: hiddenDiff as DiffResult,
    v2: hiddenV2 as unknown as RecordedV2,
  },
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
  let current: { info: RepoInfo; diff: DiffResult; v2?: RecordedV2 } | null = null;
  let sink: ProgressSink | null = null;
  let generation = 0;
  let mutations = 0;
  let lastSrc: DiffSource | null = null;
  let lastResult: DiffResult | null = null;
  const restartListeners = new Set<RestartListener>();
  let statsTimer: ReturnType<typeof setTimeout> | null = null;
  const clientMetricsState: ClientMetrics = newClientMetrics();
  const client: MockWorkerClient = {
    isMock: true,
    lastOpenOptions: undefined,
    latency: opts.latency ?? 0,
    async open(handle, s, openOpts) {
      client.lastOpenOptions = openOpts;
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
      // A range the recorder captured is replayed verbatim (T10.1); anything else is derived from
      // the default recording the same way v1 always did.
      const recordedRange = findRange(src);
      if (recordedRange) {
        const result: DiffResult = {
          ...recordedRange,
          source: src,
          files: recordedRange.files.map((f) => ({ ...f, stats: null })),
          generation: gen,
          computedAt: 1758000000000 + mutations * 1000,
          durationMs: 5 + mutations,
        };
        lastResult = result;
        scheduleStats(recordedRange.files, gen);
        sink?.onProgress({ phase: "diff", durationMs: result.durationMs });
        return result;
      }
      const { sourceRef, targetRef } = sourceRefs(src);
      let files: FileDiff[] = current.diff.files;
      if (!src.includeWorktree || !isWorktreeSource(src, current.info)) {
        files = files
          .filter((f) => f.layers.includes("committed"))
          .map((f) => ({ ...f, layers: ["committed"] as FileDiff["layers"] }));
      }
      if (sourceRef === targetRef && files.every((f) => f.layers.every((l) => l === "committed"))) {
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
    async resolveRevision(expr) {
      const v2 = requireV2();
      await wait(client.latency);
      const found = v2.revisions[expr.trim()];
      if (!found) throw err("REV_NOT_FOUND", `Cannot resolve "${expr}".`);
      return found;
    },
    async listTags() {
      const v2 = requireV2();
      await wait(client.latency);
      return v2.tags;
    },
    async listStashes() {
      const v2 = requireV2();
      await wait(client.latency);
      return v2.stashes;
    },
    async reflog(expr, limit) {
      const v2 = requireV2();
      await wait(client.latency);
      // Only HEAD's reflog is recorded; any other ref behaves like a repository that keeps none.
      const all = expr.trim() === "HEAD" || expr.trim() === "" ? v2.reflog : [];
      if (all.length === 0)
        sink?.onWarning({ code: "NO_REFLOG", message: `No reflog is kept for ${expr}.` });
      return all.slice(0, limit);
    },
    async operation() {
      const v2 = requireV2();
      await wait(client.latency);
      return v2.operation ?? current?.info.operation ?? null;
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
    async conflict(gen, id) {
      const files = requireGen(gen);
      if (!files.some((x) => x.id === id)) throw err("INTERNAL", `unknown file ${id}`);
      const recorded = requireV2().conflicts[id];
      if (!recorded) throw err("INTERNAL", `${id} has no conflict stages in the index`);
      await wait(client.latency);
      return { ...recorded, generation: gen };
    },
    async explainPath(path) {
      const v2 = requireV2();
      await wait(client.latency);
      const p = path.replace(/^\/+|\/+$/g, "");
      // Anything the recorder did not ask about is a file the mock repository simply shows.
      return v2.explanations[p] ?? { path: p, shown: true, reasons: [] };
    },
    async listHidden() {
      const v2 = requireV2();
      await wait(client.latency);
      return v2.hidden;
    },
    async walkCommits(req) {
      const v2 = requireV2();
      await wait(client.latency);
      const recorded = v2.walks[walkKey(req)] ?? { commits: [], graphAvailable: false };
      // The recording is the whole history; the cursor is just how far the UI has scrolled.
      const from = req.cursor ? Number.parseInt(req.cursor, 10) : 0;
      const start = Number.isFinite(from) && from > 0 ? from : 0;
      const end = Math.min(start + Math.max(1, req.limit), recorded.commits.length);
      const page: WalkPage = {
        commits: recorded.commits.slice(start, end),
        cursor: end < recorded.commits.length ? String(end) : null,
        graphAvailable: recorded.graphAvailable,
        capped: false,
      };
      sink?.onProgress({ phase: "history", done: page.commits.length, durationMs: 1 });
      return page;
    },
    async commitDetails(oid) {
      const v2 = requireV2();
      await wait(client.latency);
      const found = v2.commits[oid];
      if (!found) throw err("REV_NOT_FOUND", `No recorded details for ${oid}.`);
      return found;
    },
    async commitStats(oids) {
      const v2 = requireV2();
      await wait(client.latency);
      const out: Record<Oid, CommitDetails["stats"]> = {};
      for (const oid of oids) out[oid] = v2.commitStats[oid] ?? null;
      return out;
    },
    async aheadBehind(a, b) {
      const v2 = requireV2();
      await wait(client.latency);
      const found = v2.aheadBehind[`${a}...${b}`];
      if (!found) throw err("REV_NOT_FOUND", `No recorded counts for ${a}...${b}.`);
      return found;
    },
    async branchOverview() {
      const v2 = requireV2();
      await wait(client.latency);
      // The recording has the cells filled; the overview hands them back empty, as the engine does.
      return v2.branches.map((b) => ({ ...b, vsUpstream: null, vsDefault: null, merged: null }));
    },
    async branchCells(fullNames) {
      const v2 = requireV2();
      await wait(client.latency);
      const out: Record<string, Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">> = {};
      for (const name of fullNames) {
        const row = v2.branches.find((b) => b.ref.fullName === name);
        if (row)
          out[name] = { vsUpstream: row.vsUpstream, vsDefault: row.vsDefault, merged: row.merged };
      }
      return out;
    },
    async markReachable(oids) {
      const v2 = requireV2();
      await wait(client.latency);
      const out: Record<Oid, boolean> = {};
      for (const oid of oids) out[oid] = v2.reachable[oid] ?? false;
      return out;
    },
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
    async metrics() {
      return {
        generation,
        computes: generation,
        handleCache: 0,
        io: { reads: 0, bytes: 0, packBytes: 0, packFiles: 0 },
        memoryEstimate: 0,
        lastCompute: lastResult
          ? { files: lastResult.files.length, durationMs: 1, statsMs: 1 }
          : null,
      };
    },
    clientMetrics() {
      return {
        ...clientMetricsState,
        lastResultBytes: lastResult ? approxBytes(lastResult) : null,
      };
    },
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

  /** The v2 recording of the open handle; fixtures without one behave as an empty repository. */
  function requireV2(): RecordedV2 {
    if (!current) throw err("INTERNAL", "no repo open");
    return (
      current.v2 ?? {
        tags: [],
        stashes: [],
        reflog: [],
        operation: null,
        conflicts: {},
        hidden: [],
        explanations: {},
        revisions: {},
        ranges: [],
        walks: {},
        commits: {},
        commitStats: {},
        branches: [],
        aheadBehind: {},
        reachable: {},
      }
    );
  }

  /** The recorded result for this exact range, if `bun run record` captured it. */
  function findRange(src: DiffSource): DiffResult | null {
    if (src.kind !== "range" || !current?.v2) return null;
    const hit = current.v2.ranges.find(
      (r) =>
        r.source.kind === "range" &&
        r.source.fromOid === src.fromOid &&
        r.source.toOid === src.toOid &&
        r.source.threeDot === src.threeDot,
    );
    return hit ? hit.result : null;
  }

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
