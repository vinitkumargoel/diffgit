import type { FileStats } from "../../engine/api";
import { getWorkerClient } from "../engineClient";
import type { WorkerClient } from "../workerClient";
import {
  MAX_RESTARTS,
  RESTART_WINDOW_MS,
  type RefreshHooks,
  type StoreSet,
  type StoreState,
} from "./types";

export let refreshHooks: RefreshHooks | null = null;
export function setRefreshHooks(hooks: RefreshHooks | null): void {
  refreshHooks = hooks;
}

export let clientOverride: WorkerClient | null = null;
export let restartUnsub: (() => void) | null = null;

/** Test hook: use a specific client instead of `getWorkerClient()`. */
export function setStoreClient(c: WorkerClient | null): void {
  clientOverride = c;
  restartUnsub?.();
  restartUnsub = null;
}

/**
 * Stats batches that arrive over the sink before `recompute()` has committed the matching
 * `DiffResult` (the worker streams them while `computeDiff` is still resolving and while we await
 * `loadViewed`). Keyed by generation; merged into `stats` when the result lands.
 */
export const pendingStats = new Map<number, Record<string, FileStats>>();

/** Timestamps of engine restarts (E4.3 give-up window). */
export const restartTimes: number[] = [];

let storeRef: { getState: () => StoreState; setState: StoreSet } | null = null;
let restartAction: (() => void) | null = null;

export function initClientStore(
  store: { getState: () => StoreState; setState: StoreSet },
  onRestart: () => void,
): void {
  storeRef = store;
  restartAction = onRestart;
}

export function client(): WorkerClient {
  const c = clientOverride ?? getWorkerClient();
  if (!restartUnsub) {
    restartUnsub = c.onRestart((info, error) => {
      if (!storeRef) return;
      const s = storeRef.getState();
      if (error) {
        storeRef.setState({ screen: "error", error });
        return;
      }
      const now = Date.now();
      restartTimes.push(now);
      while (restartTimes.length > 0 && now - (restartTimes[0] as number) > RESTART_WINDOW_MS)
        restartTimes.shift();
      const restarts = restartTimes.length;
      if (s.screen === "loading") {
        // openRepo's attempt loop owns the retry and the counter (L5)
        storeRef.setState({ refresh: { ...s.refresh, restarts } });
        return;
      }
      if (restarts >= MAX_RESTARTS) {
        // E4.3: the engine keeps stopping; stop retrying and say so
        restartTimes.length = 0;
        storeRef.setState({
          screen: "error",
          error: {
            code: "WORKER_CRASHED",
            message: `The diff engine stopped ${restarts} times in a minute while this repository was open.`,
          },
          refresh: { ...s.refresh, busy: false, restarts },
        });
        return;
      }
      if (info) storeRef.setState({ repo: info, operation: info.operation });
      storeRef.setState({ refresh: { ...s.refresh, restarted: true, restarts } });
      s.addToast({
        level: "warning",
        message: "Engine restarted, refreshing the diff. Your viewed marks are kept.",
      });
      restartAction?.();
    });
  }
  return c;
}
