import { toUiError } from "../../errors";
import { nextWiden, PICKAXE_COMMITS, SEARCH_HIT_LIMIT } from "../../search";
import { parseFilter } from "../../treeModel";
import type { WorkerClient } from "../../workerClient";
import { ignoreStale } from "../helpers";
import { INITIAL_SEARCH, type StoreGet, type StoreSet, type StoreState } from "../types";

let searchTicket = 0;

export function bumpSearchTicket(): void {
  searchTicket++;
}

export type SearchSlice = Pick<StoreState, "search" | "runSearch" | "widenSearch" | "cancelSearch">;

export function createSearchSlice(
  set: StoreSet,
  get: StoreGet,
  client: () => WorkerClient,
): SearchSlice {
  return {
    search: INITIAL_SEARCH,

    async runSearch(req) {
      const ticket = ++searchTicket;
      const query = req.query.trim();
      const commits = req.scope === "pickaxe" ? (req.commits ?? PICKAXE_COMMITS) : undefined;
      if (!get().repo || query === "") {
        set({
          search: {
            ...INITIAL_SEARCH,
            scope: req.scope,
            query,
            regex: req.regex,
            commits: commits ?? PICKAXE_COMMITS,
          },
        });
        return;
      }
      // Only the path part: `status:` / `layer:` are the sidebar's vocabulary, not the engine's.
      const path = parseFilter(get().filter).path.trim();
      set({
        search: {
          scope: req.scope,
          query,
          regex: req.regex,
          path: path === "" ? null : path,
          commits: commits ?? PICKAXE_COMMITS,
          loading: true,
          result: null,
          error: null,
        },
      });
      try {
        const result = await client().search({
          scope: req.scope,
          query,
          limit: SEARCH_HIT_LIMIT,
          ...(req.regex ? { regex: true } : {}),
          ...(path === "" ? {} : { path }),
          ...(commits === undefined ? {} : { commits }),
        });
        if (ticket !== searchTicket) return; // a newer query, or Escape, got there first
        set((s) => ({ search: { ...s.search, loading: false, result } }));
      } catch (e) {
        if (ticket !== searchTicket) return;
        const err = toUiError(e);
        ignoreStale(e);
        if (err.code === "STALE" || err.code === "CANCELLED") {
          set((s) => ({ search: { ...s.search, loading: false } }));
          return;
        }
        set((s) => ({ search: { ...s.search, loading: false, error: err } }));
      }
    },

    async widenSearch() {
      const s = get().search;
      const next = s.scope === "pickaxe" ? nextWiden(s.commits) : null;
      if (s.scope === null || next === null) return;
      await get().runSearch({
        scope: s.scope,
        query: s.query,
        regex: s.regex,
        commits: next,
      });
    },

    cancelSearch() {
      // The engine exposes no `cancelSearch`, so the running call is abandoned rather than aborted:
      // the ticket makes its answer land nowhere (T11.8 deliverables, "else ignore result").
      searchTicket++;
      if (get().search === INITIAL_SEARCH) return;
      set({ search: INITIAL_SEARCH });
    },
  };
}
