/**
 * Polling fallback (T6.3, Plan §5.7): runs when the observer is unavailable or failed. Three
 * probe tiers with their own intervals — `git` 3 s, `index` 10 s (backing off to 30 s while a
 * sweep takes > 500 ms), `untracked` 30 s — all ×3 while the tab is hidden; nothing is probed
 * while a compute is running; a `git` probe fires immediately when the tab becomes visible.
 * A changed signature asks the scheduler for `poll:git` / `poll:worktree`.
 */
import type { ProbeTier } from "../../engine/api";
import type { UiError } from "../errors";
import { toUiError } from "../errors";
import { useStore } from "../store";
import type { WorkerClient } from "../workerClient";
import type { PollerStarter } from "./scheduler";

/** What the poller needs from `document` (kept narrow so tests can fake it). */
export interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface PollerOptions {
  gitMs?: number;
  indexMs?: number;
  indexMaxMs?: number;
  untrackedMs?: number;
  /** Multiply every interval by this while hidden (default 3). */
  hiddenFactor?: number;
  /** An index sweep slower than this backs the tier off (default 500 ms). */
  slowSweepMs?: number;
  /** True while a compute is running (default: the store's refresh.busy). */
  isBusy?: () => boolean;
  /** Visibility source (default `document`). */
  doc?: VisibilityDoc | null;
  /** Diagnostics sink. */
  onProbe?: (tier: ProbeTier, durationMs: number, changed: boolean) => void;
}

export const POLL_DEFAULTS = {
  gitMs: 3000,
  indexMs: 10_000,
  indexMaxMs: 30_000,
  untrackedMs: 30_000,
  hiddenFactor: 3,
  slowSweepMs: 500,
} as const;

const REASON: Record<ProbeTier, "poll:git" | "poll:worktree"> = {
  git: "poll:git",
  index: "poll:worktree",
  untracked: "poll:worktree",
};

export function startPoller(
  client: Pick<WorkerClient, "probe">,
  onChange: (reason: "poll:git" | "poll:worktree") => void,
  onError: (error: UiError) => void,
  opts: PollerOptions = {},
): () => void {
  const o = { ...POLL_DEFAULTS, ...opts };
  const isBusy = opts.isBusy ?? (() => useStore.getState().refresh.busy);
  const doc =
    opts.doc === undefined ? (typeof document === "undefined" ? null : document) : opts.doc;
  const last: Partial<Record<ProbeTier, string>> = {};
  const timers: Partial<Record<ProbeTier, ReturnType<typeof setTimeout>>> = {};
  const inflight = new Set<ProbeTier>();
  let indexInterval: number = o.indexMs;
  let stopped = false;

  const hidden = () => Boolean(doc?.hidden);
  const baseInterval = (tier: ProbeTier): number =>
    tier === "git" ? o.gitMs : tier === "index" ? indexInterval : o.untrackedMs;
  const interval = (tier: ProbeTier): number =>
    baseInterval(tier) * (hidden() ? o.hiddenFactor : 1);

  const schedule = (tier: ProbeTier, delay = interval(tier)) => {
    if (stopped) return;
    if (timers[tier]) clearTimeout(timers[tier]);
    timers[tier] = setTimeout(() => void probe(tier), delay);
  };

  async function probe(tier: ProbeTier): Promise<void> {
    if (stopped) return;
    if (isBusy() || inflight.has(tier)) {
      // never probe under a running compute; try again shortly
      schedule(tier, Math.min(interval(tier), 500));
      return;
    }
    inflight.add(tier);
    const t0 = performance.now();
    try {
      const sig = await client.probe(tier);
      const ms = performance.now() - t0;
      if (tier === "index") {
        indexInterval =
          ms > o.slowSweepMs
            ? Math.min(o.indexMaxMs, Math.max(indexInterval * 2, o.indexMs))
            : o.indexMs;
      }
      const prev = last[tier];
      last[tier] = sig;
      const changed = prev !== undefined && prev !== sig;
      opts.onProbe?.(tier, ms, changed);
      if (changed && !stopped) onChange(REASON[tier]);
    } catch (e) {
      if (!stopped) onError(toUiError(e));
    } finally {
      inflight.delete(tier);
      schedule(tier);
    }
  }

  const onVisibility = () => {
    if (stopped) return;
    if (!hidden()) schedule("git", 0);
    // re-arm the others so the new factor applies
    schedule("index");
    schedule("untracked");
  };
  doc?.addEventListener("visibilitychange", onVisibility);

  // take baselines right away so the first change is detected within one interval
  void probe("git");
  schedule("index", 0);
  schedule("untracked", 0);

  return () => {
    stopped = true;
    for (const t of Object.values(timers)) if (t) clearTimeout(t);
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
}

/** The starter the scheduler expects. */
export const pollerStarter: PollerStarter = (client, onChange, onError) =>
  startPoller(client, onChange, onError);
