/**
 * Zustand store (T4.2). Root coordinator merging domain slices.
 * Actions are thin wrappers over the worker client.
 *
 * Generation rule (amendment): every response is checked against `diff.generation`; stale ones are
 * dropped and `STALE` rejections ignored. Refresh orchestration moves to the scheduler in T6.1; until
 * then `recompute()` calls the client directly.
 */
import { create } from "zustand";
import { toUiError } from "./errors";
import { Lru } from "./lru";
import { client, initClientStore, pendingStats, refreshHooks } from "./store/client";
import { collectDiffStats, mergeWarnings } from "./store/helpers";
import { getPersistence } from "./store/persistence";
import { createBranchesSlice } from "./store/slices/branchesSlice";
import { createDashboardSlice } from "./store/slices/dashboardSlice";
import { createDiffSlice, maybeScanSecrets, setSecretsAfterStats } from "./store/slices/diffSlice";
import { createExportSlice } from "./store/slices/exportSlice";
import { createHistorySlice } from "./store/slices/historySlice";
import { createInsightsSlice } from "./store/slices/insightsSlice";
import { createPatchSessionSlice } from "./store/slices/patchSessionSlice";
import { createRepoSlice } from "./store/slices/repoSlice";
import { createSearchSlice } from "./store/slices/searchSlice";
import { createUiSlice } from "./store/slices/uiSlice";
import { CONFLICT_PRELOAD_LIMIT, INITIAL_EXPORT, type StoreState } from "./store/types";
import { viewedKey } from "./viewedKey";

export { setRefreshHooks, setStoreClient } from "./store/client";
export * from "./store/selectors";
export { setSummaryClientFactory } from "./store/slices/dashboardSlice";
export { configurePersistence } from "./store/slices/uiSlice";
export * from "./store/types";

export const useStore = create<StoreState>()((set, get) => {
  const searchSlice = createSearchSlice(set, get, client);
  const insightsSlice = createInsightsSlice(set, get, client);
  const exportSlice = createExportSlice(set, get, client);
  const dashboardSlice = createDashboardSlice(set, get);
  const patchSessionSlice = createPatchSessionSlice(set, get, client);
  const branchesSlice = createBranchesSlice(set, get, client);
  const historySlice = createHistorySlice(set, get, client);
  const diffSlice = createDiffSlice(set, get, client);
  const uiSlice = createUiSlice(set, get);
  const repoSlice = createRepoSlice(set, get, client, (reason) => get().recompute(reason));

  return {
    ...searchSlice,
    ...insightsSlice,
    ...exportSlice,
    ...dashboardSlice,
    ...patchSessionSlice,
    ...branchesSlice,
    ...historySlice,
    ...diffSlice,
    ...uiSlice,
    ...repoSlice,

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
        if (current.diff && result.generation < current.diff.generation) return;
        const keys = result.files.map((f) => viewedKey(current.repoId ?? "", result.source, f));
        const viewed = await getPersistence().loadViewed(keys);
        const { stats, complete } = collectDiffStats(result.files, result.generation, pendingStats);
        const stillThere = new Set(result.files.map((f) => f.id));
        const activeFileId =
          current.activeFileId && stillThere.has(current.activeFileId)
            ? current.activeFileId
            : null;
        const collapsed = new Set([...current.collapsed].filter((id) => stillThere.has(id)));
        set((s) => ({
          diff: result,
          stats,
          statsLastAt: complete ? null : Date.now(),
          viewed,
          activeFileId,
          collapsed,
          warnings: mergeWarnings(current, result.warnings),
          fileDiffs: new Lru(200),
          conflicts: {},
          secrets: null,
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
        const conflicted = result.files
          .filter((f) => f.layers.includes("conflict"))
          .slice(0, CONFLICT_PRELOAD_LIMIT);
        for (const f of conflicted) void get().loadConflict(f.id);
        if (get().prefs.showHidden) void get().loadHidden();
        setSecretsAfterStats(result.generation);
        maybeScanSecrets(result.files, stats, result.generation, get);
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "CANCELLED" || err.code === "STALE" || err.code === "WORKER_CRASHED") {
          set((s) => ({ refresh: { ...s.refresh, busy: false } }));
          return;
        }
        if (err.code === "HANDLE_GONE" || err.code === "PERMISSION" || get().screen === "loading") {
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
  };
});

initClientStore(useStore, () => {
  void useStore.getState().recompute("restart");
});
