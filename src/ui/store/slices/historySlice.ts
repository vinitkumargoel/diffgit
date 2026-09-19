import { sourceLabels, sourceRefs } from "../../../engine/diffSource";
import type {
  BisectState,
  CommitSummary,
  Oid,
  RangeSource,
  WalkRequest,
} from "../../../engine/types";
import {
  type BisectSlice,
  bisectState,
  isArmed,
  pickingSlice,
  withBad,
  withGood,
  withSkip,
} from "../../bisect";
import { isRefExpr, labelOf } from "../../compareSource";
import { toUiError } from "../../errors";
import {
  COMMIT_STATS_BATCH,
  commitRange,
  HISTORY_PAGE,
  STACK_LIMIT,
  shortOid,
  spanRange,
} from "../../history";
import { clearDerived, derivedKey, getDerived, setDerived } from "../../persistence/derived";
import type { WorkerClient } from "../../workerClient";
import { findRef, guardWorktree, ignoreStale } from "../helpers";
import {
  INITIAL_HISTORY,
  INITIAL_STACK,
  type MaybeSearch,
  REACHABLE_BATCH,
  REFLOG_LIMIT,
  type StoreGet,
  type StoreSet,
  type StoreState,
} from "../types";

/**
 * T11.5: `commitStats` is single-in-flight in the engine like every other method, so a second call
 * would cancel the first. The visible rows queue here and one drain loop serialises the batches.
 */
const commitStatsQueue = new Set<Oid>();
let commitStatsDraining = false;

export function clearCommitStatsQueue(): void {
  commitStatsQueue.clear();
}

export type HistorySlice = Pick<
  StoreState,
  | "historyTab"
  | "history"
  | "commitDetails"
  | "commitStats"
  | "stack"
  | "reflog"
  | "bisect"
  | "setHistoryTab"
  | "loadHistory"
  | "setHistoryQuery"
  | "setHistoryOption"
  | "showCommit"
  | "loadCommitDetails"
  | "requestCommitStats"
  | "searchCommits"
  | "loadStack"
  | "compareCommitWithBase"
  | "loadReflog"
  | "startBisect"
  | "markBisect"
  | "stopBisect"
  | "restoreBisect"
>;

export function createHistorySlice(
  set: StoreSet,
  get: StoreGet,
  client: () => WorkerClient,
): HistorySlice {
  /**
   * T11.5: commits the History list picks. Unlike `applySides` it never touches the remembered
   * branch pair (a range is deep-linked by hash, not persisted) and never invalidates the stack.
   */
  function applyRange(src: RangeSource): void {
    const { repo } = get();
    if (!repo) return;
    set({ diffSource: guardWorktree(src, repo) });
    get().requestRefresh("branch-change");
  }

  /**
   * Which ref the History list walks: the compare side while it is a plain branch (Design §14.1,
   * "in History mode the pickers still define the branch that is walked"), and `HEAD` once picking
   * a commit has turned the source into a range — a list that truncated itself at the row you just
   * clicked would be unusable.
   */
  function walkTip(): string {
    const src = get().diffSource;
    if (!src) return "HEAD";
    const { sourceRef } = sourceRefs(src);
    return isRefExpr(sourceRef) ? sourceRef : "HEAD";
  }

  /**
   * T11.13: one `bisectStep(state)` for the marks the strip currently holds, then the answer.
   *
   * Module-level rather than a closure helper so the whole slice stays one contiguous block. It is
   * the only place that calls the engine for a bisect, so every entry point — the strip's buttons,
   * `g` / `x`, the CommitCard menu, the restore from `diffgit-derived` — narrows the same way:
   *
   * - the marks are written to `diffgit-derived` before the call, because they are the user's work
   *   and survive a reload whatever the engine answers;
   * - an answer whose marks are no longer the ones on screen is dropped (the user can press `g`
   *   twice faster than the worker replies), and `STALE` / `CANCELLED` go through `ignoreStale`;
   * - a candidate is *selected*, which makes the source `parent…candidate`, so the commit under
   *   test is the diff on screen — the atlas's "you can often answer without running anything".
   */
  async function bisectStepNow(): Promise<void> {
    const { bisect: slice, repoId } = get();
    if (!isArmed(slice)) return;
    const asked = bisectState(slice);
    const key = JSON.stringify(asked);
    set({ bisect: { ...slice, loading: true, error: null } });
    if (repoId !== null) void setDerived(derivedKey.bisect(repoId), asked);
    /** The marks this call answers; a mark made while it was in flight makes it stale. */
    const current = (): BisectSlice | null => {
      const cur = get().bisect;
      return cur !== null && JSON.stringify(bisectState(cur)) === key ? cur : null;
    };
    try {
      const step = await client().bisectStep(asked);
      const cur = current();
      if (!cur) return;
      set({ bisect: { ...cur, ...step, loading: false, error: null } });
      if (step.candidate !== null) void get().showCommit(step.candidate);
    } catch (e) {
      const err = toUiError(e);
      const stale = err.code === "STALE" || err.code === "CANCELLED";
      if (stale) ignoreStale(e);
      const cur = current();
      if (!cur) return;
      set({ bisect: { ...cur, loading: false, error: stale ? null : err } });
    }
  }

  return {
    historyTab: "commits",
    history: INITIAL_HISTORY,
    commitDetails: {},
    commitStats: {},
    stack: INITIAL_STACK,
    reflog: null,
    bisect: null,

    // ---- History mode (T11.5, Design §14.5) ----
    setHistoryTab(tab) {
      set({ historyTab: tab });
    },

    async loadHistory(reset = false) {
      const { repo, history } = get();
      if (!repo || history.loading) return;
      if (!reset && history.cursor === null && history.commits.length > 0) return;
      const cursor = reset ? undefined : (history.cursor ?? undefined);
      set((s) => ({
        history: reset
          ? {
              ...s.history,
              commits: [],
              cursor: null,
              capped: false,
              laneOverflow: false,
              loading: true,
            }
          : { ...s.history, loading: true },
      }));
      try {
        const req: WalkRequest = {
          from: [walkTip()],
          firstParent: history.firstParent,
          limit: HISTORY_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
          ...(history.all ? { all: true } : {}),
        };
        const page = await client().walkCommits(req);
        if (!get().repo) return;
        // T10.5b: `WalkPage.laneOverflow` is not in the type yet; read it forward-compatibly.
        const overflow = (page as { laneOverflow?: boolean }).laneOverflow === true;
        set((s) => {
          const seen = new Set(s.history.commits.map((c) => c.oid));
          const added = page.commits.filter((c) => !seen.has(c.oid));
          return {
            history: {
              ...s.history,
              commits: [...s.history.commits, ...added],
              cursor: page.cursor,
              capped: s.history.capped || page.capped,
              laneOverflow: s.history.laneOverflow || overflow,
              loading: false,
            },
          };
        });
        get().requestCommitStats(page.commits.map((c) => c.oid));
      } catch (e) {
        const err = toUiError(e);
        set((s) => ({ history: { ...s.history, loading: false } }));
        // T10.5b: a cursor goes STALE when the refs moved under the walk. The pages either side of
        // that move do not line up, so the list is thrown away and walked again from the tip —
        // appending would duplicate rows.
        if (err.code === "STALE" && cursor !== undefined) {
          await get().loadHistory(true);
          return;
        }
        // A superseded walk is normal (one in flight per method); the list keeps what it has.
        ignoreStale(e);
      }
    },

    setHistoryQuery(query) {
      set((s) => ({ history: { ...s.history, query } }));
    },

    setHistoryOption(key, on) {
      if (get().history[key] === on) return;
      set((s) => ({ history: { ...s.history, [key]: on } }));
      void get().loadHistory(true);
    },

    async showCommit(oid, opts = {}) {
      const { repo, history } = get();
      if (!repo) return;
      const commits = history.commits;
      const anchor = opts.extend ? (history.rangeStart ?? history.selected) : null;
      if (anchor !== null && anchor !== oid) {
        // The list is newest first, so the higher index is the older commit.
        const ai = commits.findIndex((c) => c.oid === anchor);
        const bi = commits.findIndex((c) => c.oid === oid);
        const [older, newer] = ai > bi ? [anchor, oid] : [oid, anchor];
        set((s) => ({ history: { ...s.history, selected: newer, rangeStart: older } }));
        applyRange(spanRange(older, newer));
        return;
      }
      set((s) => ({ history: { ...s.history, selected: oid, rangeStart: null } }));
      let parent = commits.find((c) => c.oid === oid)?.parents[0] ?? null;
      if (!commits.some((c) => c.oid === oid)) {
        // A commit that is not in the walk (a Reflog row, an orphan): its parent comes from
        // `commitDetails`, which the card needs anyway.
        await get().loadCommitDetails(oid);
        const entry = get().commitDetails[oid];
        if (entry?.status === "error") return;
        parent = entry?.status === "ready" ? (entry.data.parents[0] ?? null) : null;
        if (get().history.selected !== oid) return;
      }
      applyRange(commitRange(oid, parent));
      void get().loadCommitDetails(oid);
    },

    async loadCommitDetails(oid) {
      const existing = get().commitDetails[oid];
      if (existing && existing.status !== "error") return;
      if (!get().repo) return;
      set((s) => ({ commitDetails: { ...s.commitDetails, [oid]: { status: "loading" } } }));
      try {
        const data = await client().commitDetails(oid);
        if (!get().repo) return;
        set((s) => ({ commitDetails: { ...s.commitDetails, [oid]: { status: "ready", data } } }));
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED") {
          set((s) => {
            const { [oid]: dropped, ...rest } = s.commitDetails;
            return dropped?.status === "loading" ? { commitDetails: rest } : {};
          });
          return;
        }
        set((s) => ({
          commitDetails: { ...s.commitDetails, [oid]: { status: "error", error: err } },
        }));
      }
    },

    requestCommitStats(oids) {
      const have = get().commitStats;
      for (const oid of oids) if (!(oid in have)) commitStatsQueue.add(oid);
      if (commitStatsDraining || commitStatsQueue.size === 0 || !get().repo) return;
      commitStatsDraining = true;
      void (async () => {
        try {
          while (commitStatsQueue.size > 0 && get().repo) {
            const batch = [...commitStatsQueue].slice(0, COMMIT_STATS_BATCH);
            for (const name of batch) commitStatsQueue.delete(name);
            const map = await client().commitStats(batch);
            if (!get().repo) return;
            set((s) => ({ commitStats: { ...s.commitStats, ...map } }));
          }
        } catch (e) {
          // Superseded or stale: the rows keep their skeletons and the next window asks again.
          ignoreStale(e);
        } finally {
          commitStatsDraining = false;
        }
      })();
    },

    async searchCommits(query) {
      const c = client() as WorkerClient & MaybeSearch;
      if (typeof c.search !== "function") return null;
      try {
        const res = await c.search({ scope: "commits", query, limit: HISTORY_PAGE });
        return res.hits.flatMap((h) => (h.oid ? [h.oid] : []));
      } catch (e) {
        ignoreStale(e);
        return [];
      }
    },

    async loadStack() {
      const { repo, diffSource, diff, stack } = get();
      if (!repo || !diffSource || stack.loading) return;
      const { sourceRef } = sourceRefs(diffSource);
      const base = diff?.mergeBase ?? (diffSource.kind === "range" ? diffSource.fromOid : null);
      const label = labelOf(diffSource);
      set((s) => ({ stack: { ...s.stack, loading: true, tip: sourceRef, label } }));
      try {
        let commits: CommitSummary[] = [];
        let cursor: string | undefined;
        let capped = false;
        let reachedBase = false;
        /** T10.5b: one restart from the tip when a cursor goes STALE under a moving ref. */
        let restarts = 0;
        while (!reachedBase && commits.length < STACK_LIMIT) {
          let page: Awaited<ReturnType<WorkerClient["walkCommits"]>>;
          try {
            page = await client().walkCommits({
              from: [sourceRef],
              firstParent: true,
              limit: HISTORY_PAGE,
              ...(cursor === undefined ? {} : { cursor }),
            });
          } catch (e) {
            if (toUiError(e).code !== "STALE" || cursor === undefined || restarts >= 1) throw e;
            restarts++;
            commits = [];
            cursor = undefined;
            continue;
          }
          for (const c of page.commits) {
            if (c.oid === base) {
              reachedBase = true;
              break;
            }
            if (commits.length >= STACK_LIMIT) break;
            commits.push(c);
          }
          if (page.cursor === null) {
            // The whole branch was walked; with no merge base every commit belongs to the stack.
            reachedBase = true;
            break;
          }
          cursor = page.cursor;
        }
        if (!reachedBase && commits.length >= STACK_LIMIT) capped = true;
        if (!get().repo) return;
        set({
          stack: {
            commits,
            base,
            tip: sourceRef,
            label,
            loading: false,
            ready: true,
            capped,
          },
        });
        get().requestCommitStats(commits.map((c) => c.oid));
      } catch (e) {
        ignoreStale(e);
        set((s) => ({ stack: { ...s.stack, loading: false, ready: true } }));
      }
    },

    compareCommitWithBase(oid) {
      const { repo, diffSource, compareBase, prefs } = get();
      if (!repo || !diffSource) return;
      const base = compareBase ?? {
        expr: sourceRefs(diffSource).targetRef,
        display: sourceLabels(diffSource).target,
      };
      const baseOid = base.expr === "HEAD" ? repo.headOid : (findRef(repo, base.expr)?.oid ?? null);
      applyRange({
        kind: "range",
        from: base.display,
        to: shortOid(oid),
        fromRef: base.expr,
        toRef: oid,
        fromOid: baseOid,
        toOid: oid,
        threeDot: !prefs.twoDot,
        includeWorktree: false,
      });
      set((s) => ({ history: { ...s.history, selected: oid, rangeStart: null } }));
      void get().loadCommitDetails(oid);
    },

    async loadReflog() {
      if (!get().repo) return;
      try {
        const entries = await client().reflog("HEAD", REFLOG_LIMIT);
        if (!get().repo) return;
        set({ reflog: entries });
        // T10.5's `reflog()` already fills `reachable` from one batched walk; the batches below
        // re-confirm it for a recording (or a future reader) that left the field unknown.
        if (entries.every((e) => e.reachable !== null)) return;
        for (let i = 0; i < entries.length; i += REACHABLE_BATCH) {
          const batch = entries.slice(i, i + REACHABLE_BATCH);
          const map = await client().markReachable(batch.map((e) => e.newOid));
          const cur = get().reflog;
          if (cur === null) return;
          set({
            reflog: cur.map((e) =>
              map[e.newOid] === undefined ? e : { ...e, reachable: map[e.newOid] as boolean },
            ),
          });
        }
      } catch (e) {
        // A repository that keeps no reflog answers `[]` plus a NO_REFLOG warning (T10.2); a real
        // failure leaves the list empty and says so through the usual warning banner.
        ignoreStale(e);
        if (get().reflog === null) set({ reflog: [] });
      }
    },

    async startBisect(ends) {
      const { repo } = get();
      if (!repo) return;
      get().setMode("history");
      if (!ends) {
        // Design §14.5: `Start bisect…` is a prompt, and the next two clicks in the list are the ends.
        set({ bisect: pickingSlice("good") });
        return;
      }
      set({ bisect: withBad(withGood(pickingSlice(null), ends.good), ends.bad) });
      await bisectStepNow();
    },

    async markBisect(mark, oid) {
      const current = get().bisect;
      const target = oid ?? current?.candidate ?? null;
      if (target === null) return;
      // No bisect yet (the CommitCard menu's `Bisect: mark good` / `mark bad`): this mark is one
      // end and the strip asks for the other. `skip` on its own means nothing, so it is ignored.
      if (current === null) {
        if (mark === "skip") return;
        get().setMode("history");
        const seeded =
          mark === "good"
            ? withGood(pickingSlice("bad"), target)
            : withBad(pickingSlice("good"), target);
        set({ bisect: seeded });
        return;
      }
      if (current.picking !== null) {
        if (mark === "skip") return;
        const marked = mark === "good" ? withGood(current, target) : withBad(current, target);
        const other = mark === "good" ? "bad" : "good";
        const complete = marked.good.length > 0 && marked.bad !== "";
        set({ bisect: { ...marked, picking: complete ? null : other } });
        if (complete) await bisectStepNow();
        return;
      }
      const next =
        mark === "good"
          ? withGood(current, target)
          : mark === "bad"
            ? withBad(current, target)
            : withSkip(current, target);
      set({ bisect: next });
      await bisectStepNow();
    },

    async stopBisect() {
      const { repoId } = get();
      if (get().bisect === null) return;
      set({ bisect: null });
      if (repoId !== null) await clearDerived(derivedKey.bisect(repoId));
    },

    async restoreBisect() {
      const { repoId, bisect } = get();
      if (repoId === null || bisect !== null) return;
      const saved = await getDerived<BisectState>(derivedKey.bisect(repoId));
      if (!saved || saved.bad === "" || get().bisect !== null) return;
      set({
        bisect: {
          ...saved,
          candidate: null,
          remaining: 0,
          steps: 0,
          firstBad: null,
          picking: null,
          loading: false,
          error: null,
        },
      });
      await bisectStepNow();
    },
  };
}
