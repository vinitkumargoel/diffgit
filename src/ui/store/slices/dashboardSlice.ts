import type { ProgressSink } from "../../../engine/api";
import type { RepoSummary } from "../../../engine/types";
import { type DashboardRepo, indexMtimeOf, SUMMARY_CONCURRENCY } from "../../dashboard";
import { summaryClient } from "../../engineClient";
import { toUiError } from "../../errors";
import { derivedKey, getDerived, setDerived } from "../../persistence/derived";
import type { WorkerClient } from "../../workerClient";
import { ignoreStale } from "../helpers";
import {
  type DashboardEntry,
  EMPTY_DASHBOARD_ENTRY,
  INITIAL_DASHBOARD,
  type StoreGet,
  type StoreSet,
  type StoreState,
} from "../types";

/** Nothing on the dashboard's sessions is worth a progress bar; the cards say "Reading…" instead. */
const SILENT_SINK: ProgressSink = {
  onProgress() {},
  onStats() {},
  onWarning() {},
};

/**
 * The ticket of the newest dashboard sweep. Leaving Home, opening a repository and starting a new
 * sweep all bump it, and every step of the walk checks it, so a summary that was already in flight
 * lands nowhere instead of writing into a screen the user has left (the task: "cancel on
 * navigation", the atlas: "only while the dashboard is visible").
 */
let summaryTicket = 0;

export function bumpSummaryTicket(): void {
  summaryTicket++;
}

/** Test hook (T11.11): where the throw-away summary sessions come from. */
let summaryClientFactory: (() => WorkerClient) | null = null;

export function setSummaryClientFactory(factory: (() => WorkerClient) | null): void {
  summaryClientFactory = factory;
}

function newSummaryClient(): WorkerClient {
  return summaryClientFactory ? summaryClientFactory() : summaryClient();
}

export type DashboardSlice = Pick<StoreState, "dashboard" | "loadSummaries" | "cancelSummaries">;

export function createDashboardSlice(set: StoreSet, get: StoreGet): DashboardSlice {
  return {
    dashboard: INITIAL_DASHBOARD,

    async loadSummaries(repos, opts = {}) {
      summaryTicket++;
      const ticket = summaryTicket;
      const alive = () => summaryTicket === ticket;
      const patch = (id: string, next: Partial<DashboardEntry>) => {
        set((s) => ({
          dashboard: {
            summaries: {
              ...s.dashboard.summaries,
              [id]: { ...(s.dashboard.summaries[id] ?? EMPTY_DASHBOARD_ENTRY), ...next },
            },
          },
        }));
      };

      // 1. Every card shows what is already known before anything is computed (the atlas's first
      //    mitigation: "show cards from cache immediately"). The derived store is only asked for
      //    the cards this session has not filled yet.
      for (const repo of repos) {
        if (!alive()) return;
        if (get().dashboard.summaries[repo.id]?.summary) continue;
        const hit = await getDerived<RepoSummary>(derivedKey.summary(repo.id));
        if (!alive()) return;
        if (hit) patch(repo.id, { summary: hit, mtime: hit.indexMtimeMs });
      }

      // 2. …then the repositories themselves, one session at a time, granted handles only.
      const runOne = async (repo: DashboardRepo) => {
        const mtime = await indexMtimeOf(repo.handle);
        if (!alive()) return;
        if (mtime !== null) patch(repo.id, { mtime });
        const cached = get().dashboard.summaries[repo.id]?.summary ?? null;
        // Design §14.6 / atlas tab 11: revalidate only when the index moved under the cache.
        if (!opts.force && cached && mtime !== null && cached.indexMtimeMs === mtime) return;
        patch(repo.id, { loading: true, error: null });
        let session: WorkerClient | null = null;
        try {
          session = newSummaryClient();
          await session.open(repo.handle, SILENT_SINK);
          const summary = await session.summarise();
          if (!alive()) return;
          // The engine's own reading of `.git/index` is the authority on how fresh this card is.
          patch(repo.id, { summary, mtime: summary.indexMtimeMs, loading: false, error: null });
          void setDerived(derivedKey.summary(repo.id), summary);
        } catch (e) {
          const err = toUiError(e);
          const stale = err.code === "STALE" || err.code === "CANCELLED";
          if (stale) ignoreStale(e);
          if (!alive()) return;
          patch(repo.id, { loading: false, error: stale ? null : err });
        } finally {
          try {
            await session?.close();
          } catch (e) {
            // the session is being discarded anyway; a failed close is not the user's problem
            console.warn("loadSummaries: closing the summary session failed", e);
          }
          session?.terminate();
        }
      };

      const queue = repos.filter((r) => r.access === "granted");
      const lanes = Math.max(1, Math.min(SUMMARY_CONCURRENCY, queue.length));
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          while (alive()) {
            const next = queue.shift();
            if (!next) return;
            await runOne(next);
          }
        }),
      );
    },

    cancelSummaries() {
      summaryTicket++;
      const { summaries } = get().dashboard;
      const entries = Object.entries(summaries);
      if (!entries.some(([, e]) => e.loading)) return;
      set({
        dashboard: {
          summaries: Object.fromEntries(
            entries.map(([id, e]) => [id, e.loading ? { ...e, loading: false } : e]),
          ),
        },
      });
    },
  };
}
