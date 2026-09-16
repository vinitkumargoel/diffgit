/**
 * Viewed-file marks in IndexedDB (T4.3): `viewedKey → lastTouched`, pruned to 5,000 entries (LRU by
 * timestamp). Keys embed repo, refs, file id and oids (see `viewedKey.ts`), so a content change
 * naturally produces a new, unmarked key.
 */
import { createStore, del, delMany, entries, getMany, set } from "idb-keyval";
import { guarded } from "./storage";

export const MAX_VIEWED = 5000;
const PRUNE_EVERY = 50;

type Store = ReturnType<typeof createStore>;
let store: Store | null = null;
let writes = 0;
function viewedStore(): Store {
  if (!store) store = createStore("diffgoel-viewed", "viewed");
  return store;
}
export function resetViewedStore(name = "diffgoel-viewed"): void {
  store = createStore(name, "viewed");
  writes = 0;
}

/** Returns the subset of `keys` that are marked viewed. */
export async function loadViewed(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  return guarded(async () => {
    const values = await getMany<number | undefined>(keys, viewedStore());
    const out = new Set<string>();
    values.forEach((v, i) => {
      if (v !== undefined) out.add(keys[i] as string);
    });
    return out;
  }, new Set<string>());
}

export async function saveViewed(key: string, viewed: boolean): Promise<void> {
  await guarded(async () => {
    if (!viewed) {
      await del(key, viewedStore());
      return;
    }
    await set(key, Date.now(), viewedStore());
    if (++writes % PRUNE_EVERY === 0) await pruneViewed();
  }, undefined);
}

/** Drops the oldest marks beyond `MAX_VIEWED`. */
export async function pruneViewed(max = MAX_VIEWED): Promise<number> {
  return guarded(async () => {
    const all = await entries<string, number>(viewedStore());
    if (all.length <= max) return 0;
    all.sort((a, b) => a[1] - b[1]);
    const stale = all.slice(0, all.length - max).map(([k]) => k);
    await delMany(stale, viewedStore());
    return stale.length;
  }, 0);
}
