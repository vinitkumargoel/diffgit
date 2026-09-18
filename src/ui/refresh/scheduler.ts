/**
 * Refresh scheduler (T6.1, Plan §5.7, §6.1): the single entry point for "something may have
 * changed". Coalesces requests (trailing 300 ms, never more than 2 s after the first request of a
 * burst; user-initiated reasons fire at once when idle), merges reasons into the right engine
 * invalidation, reloads refs when `.git` changed (resetting the source when the checked-out branch
 * moved), then runs the store's `recompute` — the only place `computeDiff` is called. Owns the
 * observer (T6.2) and poller (T6.3) lifetimes and the degradation ladder live → polling → manual.
 */

import { defaultDiffSource, isWorktreeSource } from "../../engine/diffSource";
import type { RepoWarning } from "../../engine/types";
import type { UiError } from "../errors";
import { toUiError } from "../errors";
import { type RefreshMode, type RefreshReason, setRefreshHooks, useStore } from "../store";
import type { WorkerClient } from "../workerClient";

export type SchedulerReason = Exclude<RefreshReason, "initial" | "restart">;

export interface Scheduler {
  request(reason: SchedulerReason, paths?: string[]): void;
  setMode(mode: RefreshMode): void;
  /** Begin live/polling detection for an open repo (called by the store after the first compute). */
  start(handle: unknown): void;
  /** Stop observer + poller and drop pending requests (repo switch / close). */
  stop(): void;
  /** Move down the ladder; `reason` becomes the REFRESH_DEGRADED detail. */
  degrade(to: "polling" | "manual", reason: string, error?: UiError): void;
  /** Test hook: run whatever is pending now and wait for it. */
  flush(): Promise<void>;
  /** Unregister from the store (tests). */
  dispose(): void;
  readonly mode: RefreshMode;
}

export type ObserverStarter = (
  handle: unknown,
  onRecords: (git: boolean, worktree: string[], config: boolean) => void,
  onError: (error: UiError) => void,
) => (() => void) | null;

export type PollerStarter = (
  client: WorkerClient,
  onChange: (reason: "poll:git" | "poll:worktree") => void,
  onError: (error: UiError) => void,
) => () => void;

export interface SchedulerDeps {
  client: WorkerClient;
  store?: typeof useStore;
  startObserver?: ObserverStarter;
  startPoller?: PollerStarter;
  /** Re-request read permission on the handle (the "Grant access" toast action). */
  requestPermission?: (handle: unknown) => Promise<boolean>;
  debounceMs?: number;
  maxWaitMs?: number;
  debug?: (msg: string, ...rest: unknown[]) => void;
}

/** E5.4 "Pick branch": opens the compare BranchPicker in the top bar (aria-label "compare branch: …"). */
function focusComparePicker(): void {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="compare branch"]');
  if (!trigger) return; // the top bar is not mounted (error screen); nothing to focus
  trigger.focus();
  trigger.click();
}

/** Files whose edits change ignore rules, attributes, refs or remotes: everything is invalidated. */
export const CONFIG_PATH = /^(\.git\/config|\.git\/info\/exclude)$|(^|\/)\.git(ignore|attributes)$/;

const PRIORITY: SchedulerReason[] = [
  "force",
  "manual",
  "branch-change",
  "observer:git",
  "poll:git",
  "observer:worktree",
  "poll:worktree",
];
const IMMEDIATE = new Set<SchedulerReason>(["force", "manual", "branch-change"]);

interface Pending {
  reasons: Set<SchedulerReason>;
  paths: Set<string>;
  firstAt: number;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const store = deps.store ?? useStore;
  const debounceMs = deps.debounceMs ?? 300;
  const maxWaitMs = deps.maxWaitMs ?? 2000;
  const debug = deps.debug ?? (() => {});
  let pending: Pending | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let handle: unknown = null;
  let stopObserver: (() => void) | null = null;
  let stopPoller: (() => void) | null = null;
  let permissionToastShown = false;
  let disposed = false;

  const setMode = (mode: RefreshMode) => {
    if (store.getState().refresh.mode !== mode) store.getState().setRefreshMode(mode);
  };

  const clearTimers = () => {
    if (timer) clearTimeout(timer);
    if (maxTimer) clearTimeout(maxTimer);
    timer = null;
    maxTimer = null;
  };

  const addWarning = (w: RepoWarning) => {
    const s = store.getState();
    if (s.warnings.some((x) => x.code === w.code && x.detail === w.detail)) return;
    store.setState({ warnings: [...s.warnings, w] });
  };

  function request(reason: SchedulerReason, paths: string[] = []): void {
    if (disposed) return;
    const state = store.getState();
    if (!state.repo || !state.diffSource) return;
    if (!pending) pending = { reasons: new Set(), paths: new Set(), firstAt: Date.now() };
    pending.reasons.add(reason);
    for (const p of paths) pending.paths.add(p);
    if (IMMEDIATE.has(reason) && !running && !timer) {
      void fire();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void fire(), debounceMs);
    if (!maxTimer) {
      maxTimer = setTimeout(() => void fire(), maxWaitMs);
    }
  }

  async function fire(): Promise<void> {
    clearTimers();
    if (running) {
      // a run is in progress; it re-arms itself from `pending` when it finishes
      return;
    }
    const batch = pending;
    pending = null;
    if (!batch) return;
    running = run(batch).finally(() => {
      running = null;
      if (pending && !disposed) timer = setTimeout(() => void fire(), 0);
    });
    await running;
  }

  async function run(batch: Pending): Promise<void> {
    const s = store.getState();
    if (!s.repo || !s.diffSource) return;
    const reasons = batch.reasons;
    const paths = [...batch.paths];
    const top = PRIORITY.find((r) => reasons.has(r)) ?? "manual";
    const force = reasons.has("force");
    const gitReason = reasons.has("observer:git") || reasons.has("poll:git");
    const worktreeReason = reasons.has("observer:worktree") || reasons.has("poll:worktree");
    const configEdit = paths.some((p) => CONFIG_PATH.test(p));
    debug("refresh", top, [...reasons], paths);
    try {
      if (force) {
        await deps.client.forceRehash();
        await deps.client.invalidate("all");
      } else if (configEdit) {
        await deps.client.invalidate("all");
      } else {
        if (gitReason) await deps.client.invalidate("refs");
        if (worktreeReason) {
          const wt = paths.filter((p) => !p.startsWith(".git/"));
          if (wt.length > 0) await deps.client.invalidate("worktree", wt);
          else await deps.client.invalidate("worktree");
        }
      }
      if (force || gitReason || configEdit || reasons.has("manual")) await reloadRefs();
    } catch (e) {
      handleError(toUiError(e));
      return;
    }
    await store.getState().recompute(top);
    if (store.getState().screen === "error") stop();
  }

  /** Refs may have moved: reload, and follow the checked-out branch (Plan D5) if it changed. */
  async function reloadRefs(): Promise<void> {
    const before = store.getState();
    const info = await deps.client.reloadRefs();
    const cur = store.getState();
    if (!cur.repo || !cur.diffSource) return;
    let src = cur.diffSource;
    const headMoved =
      info.headBranch !== before.repo?.headBranch || info.unborn !== before.repo?.unborn;
    const sourceGone = !info.refs.some((r) => r.fullName === src.sourceRef);
    const targetGone = !info.refs.some((r) => r.fullName === src.targetRef);
    if (headMoved || sourceGone) {
      const def = defaultDiffSource(info);
      src = {
        ...src,
        source: def.source,
        sourceRef: def.sourceRef,
        includeWorktree: cur.diffSource.includeWorktree || headMoved,
      };
    }
    if (targetGone) {
      const def = defaultDiffSource(info);
      src = { ...src, target: def.target, targetRef: def.targetRef };
    }
    if (src.includeWorktree && !isWorktreeSource(src, info))
      src = { ...src, includeWorktree: false };
    store.setState({ repo: info, diffSource: src });
    // E5.4: the selected branch was deleted; the fallback is silent otherwise.
    const gone = sourceGone ? cur.diffSource.source : targetGone ? cur.diffSource.target : null;
    if (gone !== null)
      store.getState().addToast({
        level: "info",
        message: `${gone} was deleted. Now comparing ${src.target} … ${src.source}.`,
        action: { label: "Pick branch", onClick: focusComparePicker },
      });
  }

  function handleError(err: UiError): void {
    if (err.code === "CANCELLED" || err.code === "STALE") {
      debug("refresh superseded", err.code);
      return;
    }
    if (err.code === "HANDLE_GONE") {
      stop();
      store.setState({ screen: "error", error: err });
      return;
    }
    if (err.code === "PERMISSION") {
      degrade("manual", "permission", err);
      return;
    }
    const s = store.getState();
    store.setState({ refresh: { ...s.refresh, lastError: err } });
    s.addToast({ level: "error", message: `Refresh failed: ${err.message}` });
  }

  function degrade(to: "polling" | "manual", reason: string, error?: UiError): void {
    debug("refresh degrade", to, reason);
    if (to === "polling") {
      stopObserver?.();
      stopObserver = null;
      addWarning({
        code: "REFRESH_DEGRADED",
        message: "Live updates stopped; polling for changes instead.",
        detail: reason,
      });
      startPolling();
      return;
    }
    stopObserver?.();
    stopObserver = null;
    stopPoller?.();
    stopPoller = null;
    setMode("manual");
    addWarning({
      code: "REFRESH_DEGRADED",
      message: "Automatic refresh is off; use the Refresh button.",
      detail: reason,
    });
    if (error?.code === "PERMISSION" && !permissionToastShown) {
      permissionToastShown = true;
      const s = store.getState();
      const h = handle;
      const name = s.repo?.name ?? (h as { name?: string } | null)?.name ?? "the folder";
      s.addToast({
        level: "warning",
        message: `Read access to ${name} was revoked. Live refresh paused.`,
        action: {
          label: "Grant access",
          onClick: () => {
            void (async () => {
              const ok = deps.requestPermission ? await deps.requestPermission(h) : false;
              if (ok) {
                permissionToastShown = false;
                start(h);
                request("manual");
              }
            })();
          },
        },
      });
    }
  }

  function startPolling(): void {
    if (!deps.startPoller || stopPoller) {
      if (!deps.startPoller) setMode("manual");
      return;
    }
    stopPoller = deps.startPoller(
      deps.client,
      (reason) => request(reason),
      (err) => {
        if (err.code === "PERMISSION" || err.code === "HANDLE_GONE") {
          if (err.code === "HANDLE_GONE") {
            stop();
            store.setState({ screen: "error", error: err });
          } else degrade("manual", "poller", err);
        } else handleError(err);
      },
    );
    setMode("polling");
  }

  function start(h: unknown): void {
    if (disposed) return;
    stopDetection();
    handle = h;
    if (deps.startObserver) {
      stopObserver = deps.startObserver(
        h,
        (git, worktree, config) => {
          if (config) request("observer:git", worktree);
          if (git) request("observer:git");
          if (worktree.length > 0) request("observer:worktree", worktree);
        },
        (err) => degrade("polling", err.code === "PERMISSION" ? "permission" : "observer"),
      );
      if (stopObserver) {
        setMode("live");
        return;
      }
    }
    startPolling();
  }

  function stopDetection(): void {
    stopObserver?.();
    stopObserver = null;
    stopPoller?.();
    stopPoller = null;
  }

  function stop(): void {
    stopDetection();
    clearTimers();
    pending = null;
    permissionToastShown = false;
    if (!disposed) setMode("manual");
  }

  const scheduler: Scheduler = {
    request,
    setMode,
    start,
    stop,
    degrade,
    async flush() {
      clearTimers();
      if (pending) await fire();
      while (running) await running;
    },
    dispose() {
      stop();
      disposed = true;
      setRefreshHooks(null);
    },
    get mode() {
      return store.getState().refresh.mode;
    },
  };
  setRefreshHooks({ start, stop, request });
  return scheduler;
}
