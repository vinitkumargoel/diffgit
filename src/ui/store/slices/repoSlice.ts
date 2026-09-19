import type { EngineMetrics, Progress, ProgressSink, StatsBatch } from "../../../engine/api";
import { defaultDiffSource } from "../../../engine/diffSource";
import { isFileSnapshot } from "../../../engine/fs/fileSnapshot";
import type { RepoWarning } from "../../../engine/types";
import { LOADING_INLINE_CODES, toUiError } from "../../errors";
import { Lru } from "../../lru";
import type { WorkerClient } from "../../workerClient";
import { pendingStats, refreshHooks } from "../client";
import { findRef, guardWorktree, withRef } from "../helpers";
import { getPersistence } from "../persistence";
import {
  initialLoading,
  LOADING_STEPS,
  MAX_OPEN_ATTEMPTS,
  type RefreshReason,
  SNAPSHOT_WARNING,
  type StoreGet,
  type StoreSet,
  type StoreState,
  stepForPhase,
} from "../types";
import { createBranchesSlice, resetBranchesState } from "./branchesSlice";
import { bumpSummaryTicket, createDashboardSlice } from "./dashboardSlice";
import { maybeScanSecrets, setSecretsAfterStats } from "./diffSlice";
import { createExportSlice } from "./exportSlice";
import { clearCommitStatsQueue, createHistorySlice } from "./historySlice";
import { createInsightsSlice } from "./insightsSlice";
import { createPatchSessionSlice } from "./patchSessionSlice";
import { bumpSearchTicket, createSearchSlice } from "./searchSlice";

export type RepoSlice = Pick<
  StoreState,
  | "screen"
  | "repo"
  | "repoId"
  | "handle"
  | "loading"
  | "error"
  | "diffSource"
  | "diff"
  | "stats"
  | "statsLastAt"
  | "warnings"
  | "operation"
  | "refresh"
  | "perf"
  | "announcement"
  | "announcementSeq"
  | "snapshotMode"
  | "snapshotReadAt"
  | "openRepo"
  | "closeRepo"
  | "reopenSession"
  | "debugMetrics"
>;

export function createRepoSlice(
  set: StoreSet,
  get: StoreGet,
  client: () => WorkerClient,
  recomputeInitial: (reason: RefreshReason) => Promise<void>,
): RepoSlice {
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
        maybeScanSecrets(s.diff.files, stats, batch.generation, get);
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
    operation: null,
    refresh: { mode: "manual", lastAt: null, busy: false, lastError: null, restarted: false },
    perf: { phases: {}, lastComputeMs: null, computeStartedAt: null },
    announcement: "",
    announcementSeq: 0,
    snapshotMode: false,
    snapshotReadAt: null,

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
          await recomputeInitial("initial");
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
      setSecretsAfterStats(null);
      bumpSearchTicket();
      bumpSummaryTicket(); // T11.11: a sweep started on Home must not write into the next visit
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
  };
}
