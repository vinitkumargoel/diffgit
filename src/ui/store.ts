/**
 * Zustand store (T4.2). Shape from Plan §6.3; actions are thin wrappers over the worker client.
 * This is the only module that imports the worker client (guard in scripts/check-guards.sh).
 *
 * Generation rule (amendment): every response is checked against `diff.generation`; stale ones are
 * dropped and `STALE` rejections ignored. Refresh orchestration moves to the scheduler in T6.1; until
 * then `recompute()` calls the client directly.
 */
import { create } from "zustand";
import type { EngineMetrics, FileStats, Progress, ProgressSink, StatsBatch } from "../engine/api";
import { defaultDiffSource } from "../engine/diffSource";
import { isFileSnapshot } from "../engine/fs/fileSnapshot";
import type { FileDiff, RepoWarning } from "../engine/types";
import { BLAME_REVISIONS, blameCacheKey, PATH_HISTORY_PAGE, pathHistoryCacheKey } from "./blame";
import { getWorkerClient } from "./engineClient";
import { LOADING_INLINE_CODES, toUiError } from "./errors";
import { Lru } from "./lru";
import { derivedKey, getDerived, setDerived } from "./persistence/derived";
import { foundNote, hasUncommittedLayer, NO_FINDINGS_NOTE, NOTHING_TO_SCAN_NOTE } from "./secrets";
import {
  cacheKey,
  findRef,
  guardWorktree,
  ignoreStale,
  statsSettled,
  withRef,
} from "./store/helpers";
import { getPersistence, setPersistence } from "./store/persistence";
import { blameTarget } from "./store/selectors";
import { createBranchesSlice, resetBranchesState } from "./store/slices/branchesSlice";
import { bumpSummaryTicket, createDashboardSlice } from "./store/slices/dashboardSlice";
import { createExportSlice } from "./store/slices/exportSlice";
import { clearCommitStatsQueue, createHistorySlice } from "./store/slices/historySlice";
import { createInsightsSlice } from "./store/slices/insightsSlice";
import { createPatchSessionSlice } from "./store/slices/patchSessionSlice";
import { bumpSearchTicket, createSearchSlice } from "./store/slices/searchSlice";
import {
  CONFLICT_PRELOAD_LIMIT,
  INITIAL_EXPORT,
  initialLoading,
  LOADING_STEPS,
  MAX_OPEN_ATTEMPTS,
  MAX_RESTARTS,
  RESTART_WINDOW_MS,
  type RefreshHooks,
  SNAPSHOT_WARNING,
  type StorePersistence,
  type StoreState,
  stepForPhase,
} from "./store/types";
import { viewedKey } from "./viewedKey";
import type { WorkerClient } from "./workerClient";

export * from "./store/selectors";
export { setSummaryClientFactory } from "./store/slices/dashboardSlice";
export * from "./store/types";

export function configurePersistence(p: Partial<StorePersistence>): void {
  const pers = setPersistence(p);
  useStore.setState({ prefs: pers.loadPrefs() });
}

let refreshHooks: RefreshHooks | null = null;
export function setRefreshHooks(hooks: RefreshHooks | null): void {
  refreshHooks = hooks;
}

let clientOverride: WorkerClient | null = null;
/** Test hook: use a specific client instead of `getWorkerClient()`. */
export function setStoreClient(client: WorkerClient | null): void {
  clientOverride = client;
  restartUnsub?.();
  restartUnsub = null;
}
let restartUnsub: (() => void) | null = null;
/**
 * Stats batches that arrive over the sink before `recompute()` has committed the matching
 * `DiffResult` (the worker streams them while `computeDiff` is still resolving and while we await
 * `loadViewed`). Keyed by generation; merged into `stats` when the result lands.
 */
const pendingStats = new Map<number, Record<string, FileStats>>();
/** Timestamps of engine restarts (E4.3 give-up window). */
const restartTimes: number[] = [];

function client(): WorkerClient {
  const c = clientOverride ?? getWorkerClient();
  if (!restartUnsub) {
    restartUnsub = c.onRestart((info, error) => {
      const s = useStore.getState();
      if (error) {
        useStore.setState({ screen: "error", error });
        return;
      }
      const now = Date.now();
      restartTimes.push(now);
      while (restartTimes.length > 0 && now - (restartTimes[0] as number) > RESTART_WINDOW_MS)
        restartTimes.shift();
      const restarts = restartTimes.length;
      if (s.screen === "loading") {
        // openRepo's attempt loop owns the retry and the counter (L5)
        useStore.setState({ refresh: { ...s.refresh, restarts } });
        return;
      }
      if (restarts >= MAX_RESTARTS) {
        // E4.3: the engine keeps stopping; stop retrying and say so
        restartTimes.length = 0;
        useStore.setState({
          screen: "error",
          error: {
            code: "WORKER_CRASHED",
            message: `The diff engine stopped ${restarts} times in a minute while this repository was open.`,
          },
          refresh: { ...s.refresh, busy: false, restarts },
        });
        return;
      }
      if (info) useStore.setState({ repo: info, operation: info.operation });
      useStore.setState({ refresh: { ...s.refresh, restarted: true, restarts } });
      s.addToast({
        level: "warning",
        message: "Engine restarted, refreshing the diff. Your viewed marks are kept.",
      });
      void s.recompute("restart");
    });
  }
  return c;
}

export const useStore = create<StoreState>()((set, get) => {
  /**
   * T11.9: the generation whose secret scan is still waiting for its stats, or null. The scan and
   * the stats pump both read file content in the engine, so the banner waits for the counts rather
   * than racing them (the brief: "after stats complete").
   */
  let secretsAfterStats: number | null = null;
  function maybeScanSecrets(
    files: readonly FileDiff[],
    stats: Record<string, FileStats>,
    generation: number,
  ): void {
    if (secretsAfterStats !== generation) return;
    if (!statsSettled(files, stats)) return;
    secretsAfterStats = null;
    void get().scanSecrets();
  }

  const sink: ProgressSink = {
    onProgress(p: Progress) {
      // T11.12: the insights walk reports every 500 commits and the skeleton counts them up.
      if (p.phase === "insights" && p.done !== undefined) {
        const done = p.done;
        set((s) => (s.insights.loading ? { insights: { ...s.insights, walked: done } } : {}));
      }
      if (p.durationMs !== undefined && p.phase !== "probe") {
        set((s) => ({
          perf: { ...s.perf, phases: { ...s.perf.phases, [p.phase]: p.durationMs } },
        }));
      }
      if (p.phase !== "probe") {
        const done = p.durationMs !== undefined && p.phase !== "stats";
        set((s) => ({ refresh: { ...s.refresh, phase: done ? null : p.phase } }));
      }
      const step = stepForPhase(p.phase);
      if (!step) return;
      set((s) => {
        const completed = new Set(s.loading.completed);
        // every step before the current one is complete; the current one when it reports a duration
        for (const earlier of LOADING_STEPS) {
          if (earlier === step) break;
          completed.add(earlier);
        }
        const phases = { ...s.loading.phases };
        // finished sub-phases are kept for the whole open so done rows keep "layout ok · config ok"
        const subPhases = [...s.loading.subPhases];
        if (p.durationMs !== undefined) {
          // a sub-phase (layout / config) finishing inside "refs"; the step itself finishes on its own phase
          if (p.phase === step) {
            completed.add(step);
            const prev = phases[step];
            const count = p.total ?? p.done ?? prev?.count;
            phases[step] = {
              durationMs: (prev?.durationMs ?? 0) + p.durationMs,
              ...(count !== undefined ? { count } : {}),
            };
          } else {
            if (!subPhases.includes(p.phase)) subPhases.push(p.phase);
            const prev = phases[step];
            phases[step] = { ...(prev ?? {}), durationMs: (prev?.durationMs ?? 0) + p.durationMs };
          }
        }
        return {
          loading: {
            ...s.loading,
            step,
            done: p.done,
            total: p.total,
            completed: [...completed],
            phases,
            subPhases,
          },
        };
      });
    },
    onStats(batch: StatsBatch) {
      const s = get();
      if (s.diff && batch.generation === s.diff.generation) {
        const stats = { ...s.stats, ...batch.stats };
        set({ stats, statsLastAt: Date.now() });
        maybeScanSecrets(s.diff.files, stats, batch.generation);
        return;
      }
      if (s.diff && batch.generation < s.diff.generation) return; // stale generation
      pendingStats.set(batch.generation, {
        ...(pendingStats.get(batch.generation) ?? {}),
        ...batch.stats,
      });
    },
    onWarning(w: RepoWarning) {
      set((s) =>
        s.warnings.some((x) => x.code === w.code) ? {} : { warnings: [...s.warnings, w] },
      );
    },
  };

  const searchSlice = createSearchSlice(set, get, client);
  const insightsSlice = createInsightsSlice(set, get, client);
  const exportSlice = createExportSlice(set, get, client);
  const dashboardSlice = createDashboardSlice(set, get);
  const patchSessionSlice = createPatchSessionSlice(set, get, client);
  const branchesSlice = createBranchesSlice(set, get, client);
  const historySlice = createHistorySlice(set, get, client);

  return {
    screen: "home",
    repo: null,
    repoId: null,
    handle: null,
    loading: initialLoading(),
    error: null,
    diffSource: null,
    diff: null,
    stats: {},
    statsLastAt: null,
    warnings: [],
    dismissedWarnings: new Set(),
    prefs: getPersistence().loadPrefs(),
    viewed: new Set(),
    filter: "",
    activeFileId: null,
    collapsed: new Set(),
    refresh: { mode: "manual", lastAt: null, busy: false, lastError: null, restarted: false },
    fileDiffs: new Lru(200),
    perf: { phases: {}, lastComputeMs: null, computeStartedAt: null },
    announcement: "",
    announcementSeq: 0,
    recentNotice: null,
    storageUnavailable: false,
    gateCause: null,
    mode: "files",
    cardModes: {},
    blames: {},
    pathHistories: {},
    operation: null,
    conflicts: {},
    secrets: null,
    hidden: null,
    palette: false,
    snapshotMode: false,
    snapshotReadAt: null,

    ...searchSlice,
    ...insightsSlice,
    ...exportSlice,
    ...dashboardSlice,
    ...patchSessionSlice,
    ...branchesSlice,
    ...historySlice,

    async openRepo(handle, opts = {}) {
      await get().closeRepo();
      // T11.15: a read-once `FileSnapshot` instead of a directory handle — the folder was handed
      // over whole and cannot be read again, so nothing here may schedule, remember or poll it.
      const snapshot = isFileSnapshot(handle) ? handle : null;
      const name =
        typeof handle === "object" &&
        handle !== null &&
        typeof (handle as { name?: unknown }).name === "string"
          ? (handle as { name: string }).name
          : "repository";
      refreshHooks?.stop();
      const startedAt = Date.now();
      set({
        screen: "loading",
        handle,
        repoId: opts.id ?? name,
        snapshotMode: snapshot !== null,
        snapshotReadAt: snapshot?.readAt ?? null,
        loading: initialLoading({
          step: "refs",
          startedAt,
          expectedMs: opts.expectedMs ?? null,
        }),
        error: null,
        warnings: [],
        dismissedWarnings: new Set(),
        diff: null,
        stats: {},
        statsLastAt: null,
        viewed: new Set(),
        filter: "",
        activeFileId: null,
        collapsed: new Set(),
        fileDiffs: new Lru(200),
        recentNotice: null,
      });
      for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          set((s) => ({
            loading: initialLoading({
              step: "refs",
              startedAt: s.loading.startedAt,
              expectedMs: s.loading.expectedMs,
              attempt,
            }),
          }));
        }
        try {
          // B10 / T10.4: the only page preference the engine needs at open time.
          const info = await client().open(handle, sink, {
            builtinExcludes: get().prefs.builtinExcludes,
          });
          let src = defaultDiffSource(info);
          let missingBranch: string | null = null;
          if (opts.lastTarget) {
            const t = findRef(info, opts.lastTarget);
            if (t) src = withRef(src, "target", t);
            else missingBranch = opts.lastTarget;
          }
          if (opts.lastSource) {
            const sref = findRef(info, opts.lastSource);
            if (sref) src = withRef(src, "source", sref);
            else missingBranch = opts.lastSource;
          }
          if (opts.skipWorktree) src = { ...src, includeWorktree: false };
          src = guardWorktree(src, info);
          // T11.15: the banner belongs to the repository for as long as it is open, so it rides on
          // `RepoInfo.warnings`, which every `recompute()` merges back into `warnings`.
          const shown = snapshot
            ? { ...info, warnings: [...info.warnings, SNAPSHOT_WARNING] }
            : info;
          set((s) => ({
            repo: shown,
            diffSource: src,
            // T11.5: the base picker's side, remembered for `Compare with base…`.
            compareBase: { expr: src.targetRef, display: src.target },
            // Design §14.3: the operation banner is driven by `RepoInfo.operation`, which the
            // scheduler refreshes through `reloadRefs()` on every git-side tick.
            operation: info.operation,
            warnings: [...shown.warnings],
            loading: {
              ...s.loading,
              phases: {
                ...s.loading.phases,
                refs: { ...(s.loading.phases.refs ?? { durationMs: 0 }), count: info.refs.length },
              },
            },
          }));
          await get().recompute("initial");
          if (get().screen === "loading") set({ screen: "repo" });
          if (get().screen === "repo") {
            // T11.15: snapshot mode has no handle to observe, poll or store, so neither the
            // scheduler nor Recent hears about it. Re-opening the folder is the only refresh.
            if (!snapshot) {
              refreshHooks?.start(handle);
              void getPersistence().touchRepo(get().repoId ?? "", {
                lastOpenMs: Date.now() - startedAt,
                lastSource: src.sourceRef,
                lastTarget: src.targetRef,
              });
            }
            if (missingBranch) {
              const short = missingBranch.replace(/^refs\/(heads|remotes)\//, "");
              get().addToast({
                level: "info",
                message: `Branch ${short} no longer exists here; comparing ${src.target} … ${src.source}.`,
              });
            }
          }
          return;
        } catch (e) {
          const err = toUiError(e);
          if (err.code === "WORKER_CRASHED" && attempt < MAX_OPEN_ATTEMPTS) continue; // L5
          if (err.code === "CANCELLED" && get().screen !== "loading") return; // closed meanwhile
          const cur = get();
          if (cur.screen === "loading" && cur.loading.step && LOADING_INLINE_CODES.has(err.code)) {
            // L4: the failure stays on the phase it happened in
            set((s) => ({
              loading: { ...s.loading, failed: err, failedStep: s.loading.step },
              error: err,
            }));
            return;
          }
          set({ screen: "error", error: err });
          return;
        }
      }
    },

    async closeRepo() {
      refreshHooks?.stop();
      const s = get();
      if (s.repo || s.screen === "loading") {
        try {
          await client().close();
        } catch (e) {
          // not user-actionable: the session is being discarded anyway; keep a trace for debugging
          console.warn("closeRepo: engine close failed", e);
        }
      }
      set({
        screen: "home",
        repo: null,
        repoId: null,
        handle: null,
        diffSource: null,
        diff: null,
        stats: {},
        warnings: [],
        error: null,
        activeFileId: null,
        fileDiffs: new Lru(200),
        refresh: { mode: "manual", lastAt: null, busy: false, lastError: null, restarted: false },
        loading: initialLoading(),
        statsLastAt: null,
        // v2 shell: a new repository always starts on Files with nothing carried over.
        mode: "files",
        cardModes: {},
        blames: {},
        pathHistories: {},
        operation: null,
        conflicts: {},
        secrets: null,
        hidden: null,
        palette: false,
        snapshotMode: false,
        snapshotReadAt: null,
        ...createSearchSlice(set, get, client),
        ...createInsightsSlice(set, get, client),
        ...createExportSlice(set, get, client),
        ...createDashboardSlice(set, get),
        ...createPatchSessionSlice(set, get, client),
        ...createBranchesSlice(set, get, client),
        ...createHistorySlice(set, get, client),
      });
      resetBranchesState();
      clearCommitStatsQueue();
      secretsAfterStats = null;
      bumpSearchTicket();
      bumpSummaryTicket(); // T11.11: a sweep started on Home must not write into the next visit
    },

    async debugMetrics() {
      const c = client();
      let engine: EngineMetrics | null = null;
      if (get().repo) {
        try {
          engine = await c.metrics();
        } catch {
          engine = null; // no session / worker restarting: the panel shows dashes
        }
      }
      return { engine, client: c.clientMetrics() };
    },

    requestRefresh(reason, paths) {
      if (refreshHooks) refreshHooks.request(reason, paths);
      else void get().recompute(reason);
    },

    async recompute(_reason) {
      const { diffSource, repo } = get();
      if (!diffSource || !repo) return;
      const startedAt = performance.now();
      performance.mark?.("diffgit:compute-start");
      set((s) => ({
        refresh: { ...s.refresh, busy: true, phase: s.refresh.phase ?? null },
        perf: { ...s.perf, computeStartedAt: startedAt },
      }));
      try {
        const result = await client().computeDiff(diffSource);
        performance.mark?.("diffgit:compute-result");
        const current = get();
        // a newer compute may have started meanwhile; comlink resolves in order, but be defensive
        if (current.diff && result.generation < current.diff.generation) return;
        const stats: Record<string, FileStats> = {};
        for (const f of result.files) if (f.stats) stats[f.id] = f.stats;
        const keys = result.files.map((f) => viewedKey(current.repoId ?? "", result.source, f));
        const viewed = await getPersistence().loadViewed(keys);
        // batches streamed before this point were parked by the sink
        Object.assign(stats, pendingStats.get(result.generation));
        for (const g of pendingStats.keys()) if (g <= result.generation) pendingStats.delete(g);
        const stillThere = new Set(result.files.map((f) => f.id));
        const activeFileId =
          current.activeFileId && stillThere.has(current.activeFileId)
            ? current.activeFileId
            : null;
        const collapsed = new Set([...current.collapsed].filter((id) => stillThere.has(id)));
        // engine warnings are per-result; keep repo-level ones and merge
        const repoWarnings = current.repo?.warnings ?? [];
        const merged: RepoWarning[] = [...repoWarnings];
        // T11.15: snapshot mode's banner outlives every refresh — the scheduler's `reloadRefs()`
        // and the restart listener both replace `repo` with a RepoInfo that cannot know about it.
        if (current.snapshotMode && !merged.some((w) => w.code === "SNAPSHOT_MODE"))
          merged.push(SNAPSHOT_WARNING);
        for (const w of result.warnings) if (!merged.some((x) => x.code === w.code)) merged.push(w);
        const complete = result.files.every((f) => stats[f.id] !== undefined);
        set((s) => ({
          diff: result,
          stats,
          statsLastAt: complete ? null : Date.now(),
          viewed,
          activeFileId,
          collapsed,
          warnings: merged,
          fileDiffs: new Lru(200),
          conflicts: {},
          // T11.9: findings belong to one generation; the new diff is unscanned until the scan
          // below answers, so the banner can never describe a diff that is no longer on screen.
          secrets: null,
          // T11.10: the prepared patch and the secret-gate override belong to the old generation.
          export: { ...INITIAL_EXPORT, open: s.export.open },
          screen: s.screen === "loading" || s.screen === "repo" ? "repo" : s.screen,
          refresh: {
            ...s.refresh,
            busy: false,
            lastAt: Date.now(),
            lastError: null,
            restarted: false,
            phase: null,
          },
          announcement: `Diff updated: ${result.files.length} ${result.files.length === 1 ? "file" : "files"}`,
          announcementSeq: s.announcementSeq + 1,
          perf: { ...s.perf, lastComputeMs: performance.now() - startedAt, computeStartedAt: null },
        }));
        performance.mark?.("diffgit:compute-committed");
        // T11.3: the sidebar prints git's real XY (UU / AA / UD / DU / DD), which only the payload
        // knows, so the conflicted rows — never many — are fetched as soon as the diff lands.
        const conflicted = result.files
          .filter((f) => f.layers.includes("conflict"))
          .slice(0, CONFLICT_PRELOAD_LIMIT);
        for (const f of conflicted) void get().loadConflict(f.id);
        // T11.4: while the Hidden group is up it follows the working tree, like every other group.
        if (get().prefs.showHidden) void get().loadHidden();
        // T11.9: arm the scan for this generation; it runs as soon as the stats of that diff are
        // in — immediately when the result already carried them all.
        secretsAfterStats = result.generation;
        maybeScanSecrets(result.files, stats, result.generation);
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "CANCELLED" || err.code === "STALE" || err.code === "WORKER_CRASHED") {
          // superseded, or the worker died: the restart listener toasts and recomputes (T7.5 review)
          set((s) => ({ refresh: { ...s.refresh, busy: false } }));
          return;
        }
        if (err.code === "HANDLE_GONE" || err.code === "PERMISSION") {
          set((s) => ({
            screen: "error",
            error: err,
            refresh: { ...s.refresh, busy: false, lastError: err },
          }));
          return;
        }
        if (get().screen === "loading") {
          set((s) => ({
            screen: "error",
            error: err,
            refresh: { ...s.refresh, busy: false, lastError: err },
          }));
          return;
        }
        set((s) => ({ refresh: { ...s.refresh, busy: false, lastError: err } }));
        get().addToast({
          level: "error",
          message: `Refresh failed: ${err.message}`,
          action: { label: "Retry", onClick: () => get().requestRefresh("manual") },
        });
      }
    },

    async loadFileDiff(id, opts = {}) {
      const s = get();
      if (!s.diff) return;
      const key = cacheKey(id, s.prefs.ignoreWhitespace);
      const existing = s.fileDiffs.get(key);
      if (existing && existing.status !== "error") {
        if (
          existing.status === "ready" &&
          opts.loadLarge &&
          existing.data.hunks === null &&
          existing.data.classification.tooLarge
        ) {
          // fall through: user asked to load a gated diff
        } else return;
      }
      const controller = new AbortController();
      const generation = s.diff.generation;
      const next = s.fileDiffs.clone();
      next.set(key, { status: "loading", controller });
      set({ fileDiffs: next });
      try {
        const data = await client().fileDiff(generation, id, {
          ignoreWhitespace: s.prefs.ignoreWhitespace,
          loadLarge: opts.loadLarge === true,
        });
        const cur = get();
        if (!cur.diff || cur.diff.generation !== generation || controller.signal.aborted) return;
        const updated = cur.fileDiffs.clone();
        updated.set(key, { status: "ready", data });
        set({ fileDiffs: updated });
      } catch (e) {
        const err = toUiError(e);
        const cur = get();
        if (
          err.code === "STALE" ||
          err.code === "CANCELLED" ||
          err.code === "WORKER_CRASHED" ||
          controller.signal.aborted
        ) {
          if (cur.fileDiffs.get(key)?.status === "loading") {
            const updated = cur.fileDiffs.clone();
            updated.delete(key);
            set({ fileDiffs: updated });
          }
          return;
        }
        const updated = cur.fileDiffs.clone();
        updated.set(key, { status: "error", error: err });
        set({ fileDiffs: updated });
      }
    },

    async loadConflict(id) {
      const s = get();
      if (!s.diff) return;
      const existing = s.conflicts[id];
      if (existing && existing.status !== "error") return;
      const generation = s.diff.generation;
      set((cur) => ({ conflicts: { ...cur.conflicts, [id]: { status: "loading" } } }));
      try {
        const data = await client().conflict(generation, id);
        const cur = get();
        if (!cur.diff || cur.diff.generation !== generation) return;
        set((c) => ({ conflicts: { ...c.conflicts, [id]: { status: "ready", data } } }));
      } catch (e) {
        const err = toUiError(e);
        const cur = get();
        if (err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED") {
          if (cur.conflicts[id]?.status === "loading") {
            const { [id]: _dropped, ...rest } = cur.conflicts;
            set({ conflicts: rest });
          }
          return;
        }
        set((c) => ({ conflicts: { ...c.conflicts, [id]: { status: "error", error: err } } }));
      }
    },

    async loadHidden() {
      if (!get().repo) return;
      try {
        const entries = await client().listHidden();
        // The toggle may have gone off (or the repo closed) while the walk was running.
        if (!get().repo || !get().prefs.showHidden) return;
        set({ hidden: entries });
      } catch (e) {
        // A superseded or stale call is normal (one in-flight per method); anything else leaves the
        // group empty rather than blocking the sidebar — the toggle can be pressed again.
        ignoreStale(e);
        if (get().prefs.showHidden && get().hidden === null) set({ hidden: [] });
      }
    },

    explainPath(path) {
      return client().explainPath(path);
    },

    async reopenSession() {
      const { handle, repoId, diffSource } = get();
      if (!handle) return;
      const pair =
        diffSource?.kind === "branches"
          ? { lastSource: diffSource.sourceRef, lastTarget: diffSource.targetRef }
          : {};
      await get().openRepo(handle, {
        ...(repoId === null ? {} : { id: repoId }),
        ...pair,
        ...(diffSource && !diffSource.includeWorktree ? { skipWorktree: true } : {}),
      });
    },

    cancelFileDiff(id) {
      const s = get();
      const key = cacheKey(id, s.prefs.ignoreWhitespace);
      const entry = s.fileDiffs.get(key);
      if (entry?.status === "loading") {
        entry.controller.abort();
        const updated = s.fileDiffs.clone();
        updated.delete(key);
        set({ fileDiffs: updated });
        void client().cancelFileDiff(id).catch(ignoreStale);
      }
    },

    toggleViewed(id) {
      const s = get();
      const file = s.diff?.files.find((f) => f.id === id);
      if (!file || !s.diff) return;
      const key = viewedKey(s.repoId ?? "", s.diff.source, file);
      const viewed = new Set(s.viewed);
      const collapsed = new Set(s.collapsed);
      const nowViewed = !viewed.has(key);
      if (nowViewed) {
        viewed.add(key);
        collapsed.add(id);
      } else {
        viewed.delete(key);
        collapsed.delete(id);
      }
      set({ viewed, collapsed });
      void getPersistence().saveViewed(key, nowViewed);
    },

    setViewed(ids, nowViewed) {
      const s = get();
      if (!s.diff) return;
      const byId = new Map(s.diff.files.map((f) => [f.id, f]));
      const viewed = new Set(s.viewed);
      const collapsed = new Set(s.collapsed);
      const keys: string[] = [];
      for (const id of ids) {
        const file = byId.get(id);
        if (!file) continue;
        const key = viewedKey(s.repoId ?? "", s.diff.source, file);
        if (nowViewed) {
          viewed.add(key);
          collapsed.add(id);
        } else {
          viewed.delete(key);
          collapsed.delete(id);
        }
        keys.push(key);
      }
      if (keys.length === 0) return;
      set({ viewed, collapsed });
      for (const key of keys) void getPersistence().saveViewed(key, nowViewed);
    },

    setFilter(text) {
      set({ filter: text });
    },

    setPref(key, value) {
      const previous = get().prefs;
      const prefs = { ...previous, [key]: value };
      set({ prefs });
      getPersistence().savePrefs(prefs);
      if (key === "showHidden" && value !== previous.showHidden) {
        // T11.4: the listing is its own walk in the engine, so it runs only while the group is up.
        if (value) {
          if (get().hidden === null) void get().loadHidden();
        } else set({ hidden: null });
      }
      if (key === "builtinExcludes" && value !== previous.builtinExcludes) {
        // B10: the excludes are baked into `IgnoreRules` at open time; the session has to be rebuilt.
        void get().reopenSession();
      }
    },

    setActiveFile(id) {
      set({ activeFileId: id });
    },

    setCollapsed(id, isCollapsed) {
      const collapsed = new Set(get().collapsed);
      if (isCollapsed) collapsed.add(id);
      else collapsed.delete(id);
      set({ collapsed });
    },

    dismissWarning(code) {
      set((s) => ({ dismissedWarnings: new Set([...s.dismissedWarnings, code]) }));
    },

    prioritise(ids) {
      if (!get().diff) return;
      void client().prioritise(ids).catch(ignoreStale);
    },

    setRefreshMode(mode) {
      set((s) => ({ refresh: { ...s.refresh, mode } }));
    },

    async fileBytes(id, side) {
      const s = get();
      if (!s.diff) return null;
      return client().fileBytes(s.diff.generation, id, side);
    },

    setRecentNotice(notice) {
      set({ recentNotice: notice });
    },

    setStorageUnavailable(on) {
      set({ storageUnavailable: on });
    },

    setGateCause(cause) {
      set({ gateCause: cause });
    },

    setMode(mode) {
      const s = get();
      // T11.14: History, Branches and Insights all walk a repository; a patch file has none, so
      // the keys and the palette rows are as inert as the disabled ModeSwitch buttons.
      if (s.patchOnly && mode !== "files") return;
      if (s.mode === mode) return;
      set({ mode, palette: false });
    },

    setPalette(open) {
      set({ palette: open });
    },

    setCardMode(id, cardMode) {
      set((s) =>
        s.cardModes[id] === cardMode ? {} : { cardModes: { ...s.cardModes, [id]: cardMode } },
      );
    },

    async loadBlame(path, opts) {
      const s = get();
      const target = blameTarget(s, opts.at);
      if (!target || !s.repo) return;
      const max = opts.maxRevisions ?? BLAME_REVISIONS;
      const key = blameCacheKey(target.oid, path, opts.ignoreWhitespace);
      const existing = s.blames[key];
      if (existing?.status === "loading") return;
      if (existing?.status === "ready" && existing.maxRevisions >= max) return;
      set((cur) => ({ blames: { ...cur.blames, [key]: { status: "loading" } } }));
      // The derived cache is keyed by a commit oid, so it may only hold answers that a commit fully
      // determines: a blame that carries working-tree lines is not one of those.
      const cacheable = !target.includeWorktree && s.repoId !== null;
      const derived = cacheable
        ? derivedKey.blame(s.repoId as string, target.oid, path, opts.ignoreWhitespace)
        : null;
      if (derived !== null) {
        const hit = await getDerived<{
          data: import("../engine/types").BlamePayload;
          maxRevisions: number;
        }>(derived);
        if (hit && hit.maxRevisions >= max) {
          if (get().blames[key]?.status !== "loading") return;
          set((cur) => ({
            blames: {
              ...cur.blames,
              [key]: { status: "ready", data: hit.data, maxRevisions: hit.maxRevisions },
            },
          }));
          return;
        }
      }
      try {
        const data = await client().blame(target.ref, path, {
          ignoreWhitespace: opts.ignoreWhitespace,
          includeWorktree: target.includeWorktree,
          maxRevisions: max,
        });
        if (!get().repo) return;
        set((cur) => ({
          blames: { ...cur.blames, [key]: { status: "ready", data, maxRevisions: max } },
        }));
        if (derived !== null) void setDerived(derived, { data, maxRevisions: max });
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED") {
          // A superseded blame is normal (one in flight per method): drop the placeholder and let
          // the card ask again rather than showing a failure the user did not cause.
          set((cur) => {
            const { [key]: dropped, ...rest } = cur.blames;
            return dropped?.status === "loading" ? { blames: rest } : {};
          });
          return;
        }
        set((cur) => ({ blames: { ...cur.blames, [key]: { status: "error", error: err } } }));
      }
    },

    async loadPathHistory(path, opts) {
      const s = get();
      const target = blameTarget(s, opts.at);
      if (!target || !s.repo) return;
      const key = pathHistoryCacheKey(target.oid, path, opts.follow);
      const existing = s.pathHistories[key];
      if (existing?.loading) return;
      if (!opts.more && existing && existing.entries.length > 0) return;
      if (opts.more && existing && existing.cursor === null) return;
      const cursor = opts.more ? (existing?.cursor ?? undefined) : undefined;
      set((cur) => ({
        pathHistories: {
          ...cur.pathHistories,
          [key]: {
            ...(cur.pathHistories[key] ?? {
              entries: [],
              cursor: null,
              loading: false,
              error: null,
            }),
            loading: true,
            error: null,
          },
        },
      }));
      try {
        const page = await client().pathHistory(target.ref, path, {
          follow: opts.follow,
          limit: PATH_HISTORY_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!get().repo) return;
        set((cur) => {
          const before = cur.pathHistories[key] ?? {
            entries: [],
            cursor: null,
            loading: false,
            error: null,
          };
          return {
            pathHistories: {
              ...cur.pathHistories,
              [key]: {
                entries: cursor === undefined ? page.entries : [...before.entries, ...page.entries],
                cursor: page.cursor,
                loading: false,
                error: null,
              },
            },
          };
        });
      } catch (e) {
        const err = toUiError(e);
        const stale =
          err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED";
        set((cur) => {
          const before = cur.pathHistories[key] ?? {
            entries: [],
            cursor: null,
            loading: false,
            error: null,
          };
          return {
            pathHistories: {
              ...cur.pathHistories,
              [key]: { ...before, loading: false, error: stale ? null : err },
            },
          };
        });
        if (stale) ignoreStale(e);
      }
    },

    async scanSecrets(opts = {}) {
      const s = get();
      if (!s.diff) return;
      const generation = s.diff.generation;
      // T10.7 skips these rows without reading a byte; the store skips the round trip as well, so
      // a committed-only diff never wakes the scanner (the task's "scan is not called" case).
      if (!s.diff.files.some(hasUncommittedLayer)) {
        secretsAfterStats = null;
        set({ secrets: [] });
        if (opts.announce) get().addToast({ level: "info", message: NOTHING_TO_SCAN_NOTE });
        return;
      }
      try {
        const found = await client().scanSecrets(generation);
        const cur = get();
        if (!cur.diff || cur.diff.generation !== generation) return;
        set({ secrets: found });
        if (opts.announce) {
          get().addToast(
            found.length === 0
              ? { level: "info", message: NO_FINDINGS_NOTE }
              : { level: "warning", message: foundNote(found.length) },
          );
        }
      } catch (e) {
        const err = toUiError(e);
        // A superseded or stale scan is normal (one call in flight per method): the next compute
        // asks again and the banner keeps whatever it had.
        ignoreStale(e);
        if (opts.announce && err.code !== "STALE" && err.code !== "CANCELLED") {
          get().addToast({ level: "warning", message: `Secret scan failed: ${err.message}` });
        }
      }
    },
  };
});
