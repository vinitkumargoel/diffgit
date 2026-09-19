import type { InsightsResult } from "../../../engine/types";
import { toUiError } from "../../errors";
import { EMPTY_RESULT, INSIGHTS_LIMIT, sinceMsFor } from "../../insights";
import { derivedKey, getDerived, setDerived } from "../../persistence/derived";
import type { WorkerClient } from "../../workerClient";
import { ignoreStale } from "../helpers";
import { selectInsightsAnchor } from "../selectors";
import { INITIAL_INSIGHTS, type StoreGet, type StoreSet, type StoreState } from "../types";

export type InsightsSlice = Pick<
  StoreState,
  "insights" | "loadInsights" | "setInsightsPeriod" | "showHotspot"
>;

export function createInsightsSlice(
  set: StoreSet,
  get: StoreGet,
  client: () => WorkerClient,
): InsightsSlice {
  return {
    insights: INITIAL_INSIGHTS,

    async loadInsights(opts = {}) {
      const s = get();
      const { repo, repoId } = s;
      if (!repo || repoId === null) return;
      const period = s.prefs.insightsPeriod;
      const tip = repo.headOid;
      const { insights } = s;
      if (insights.loading) return;
      if (
        !opts.force &&
        insights.result !== null &&
        insights.tip === tip &&
        insights.period === period
      )
        return;
      // A repository with no commits: nothing to walk, and no oid to key a cache entry by.
      if (tip === null) {
        set({ insights: { ...INITIAL_INSIGHTS, result: EMPTY_RESULT, tip: null, period } });
        return;
      }
      set({ insights: { ...INITIAL_INSIGHTS, loading: true, tip, period } });
      /** The request this call is the answer to; a later chip click makes it stale. */
      const current = () => {
        const cur = get().insights;
        return cur.loading && cur.tip === tip && cur.period === period;
      };
      const key = derivedKey.insights(repoId, tip, period);
      if (!opts.force) {
        const hit = await getDerived<InsightsResult>(key);
        if (hit) {
          if (!current()) return;
          set({ insights: { ...INITIAL_INSIGHTS, result: hit, tip, period, cached: true } });
          if (hit.capped) get().dismissWarning("INSIGHTS_CAPPED");
          return;
        }
      }
      try {
        const sinceMs = sinceMsFor(period, selectInsightsAnchor(get()));
        const result = await client().insights({
          limit: INSIGHTS_LIMIT,
          ...(sinceMs === undefined ? {} : { sinceMs }),
        });
        if (!current()) return;
        set({ insights: { ...INITIAL_INSIGHTS, result, tip, period } });
        void setDerived(key, result);
        // The page prints the cap as one inline line (Design §14, rule 2), so the engine's one-shot
        // `INSIGHTS_CAPPED` never also gets a banner of its own.
        if (result.capped) get().dismissWarning("INSIGHTS_CAPPED");
      } catch (e) {
        const err = toUiError(e);
        const stale = err.code === "STALE" || err.code === "CANCELLED";
        if (stale) ignoreStale(e);
        if (!current()) return;
        set({
          insights: { ...INITIAL_INSIGHTS, tip, period, error: stale ? null : err },
        });
      }
    },

    setInsightsPeriod(period) {
      if (get().prefs.insightsPeriod === period) return;
      get().setPref("insightsPeriod", period);
      void get().loadInsights();
    },

    showHotspot(path) {
      get().setFilter(path);
      get().setMode("files");
    },
  };
}
