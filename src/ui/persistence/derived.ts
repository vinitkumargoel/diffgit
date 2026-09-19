/**
 * Derived-data cache in IndexedDB (T11.1, docs/v2-contracts.md § Persistence). Everything in here
 * is *recomputable* from the repository — blame, path history, insights, the repository summary and
 * a bisect state — so a miss, a blocked database or a cleared store is never an error: the caller
 * asks the engine again. Store name `diffgit-derived`; every access goes through `guarded()`, so a
 * private window or a full quota reports `STORAGE_UNAVAILABLE` once and returns the fallback.
 *
 * Keys are built by the helpers below and always carry the inputs the value depends on (repo id,
 * commit oid, path, period), so a stale value cannot be read back under a new one.
 */
import { clear, createStore, del, entries, get, set } from "idb-keyval";
import type { Oid } from "../../engine/types";
import { guarded } from "./storage";

type Store = ReturnType<typeof createStore>;
let store: Store | null = null;
let storeName = "diffgit-derived";
/**
 * The store is created lazily *inside* `guarded`: `createStore` opens the database immediately, and
 * where IndexedDB is missing or blocked that throw must be reported, not escape.
 */
function derivedStore(): Store {
  if (!store) store = createStore(storeName, "derived");
  return store;
}
/** Test hook: use a fresh database. */
export function resetDerivedStore(name = "diffgit-derived"): void {
  storeName = name;
  store = createStore(name, "derived");
}

/** Key builders — the only place the key format is written down. */
export const derivedKey = {
  /**
   * T11.6 added the `-w` flag: `blame -w` is a different question with a different answer
   * (contracts `<!-- T10.6 -->`), so the two must not share a key.
   */
  blame: (repoId: string, oid: Oid, path: string, ignoreWhitespace: boolean) =>
    `blame:${repoId}:${oid}:${path}:${ignoreWhitespace ? "w" : "x"}`,
  history: (repoId: string, oid: Oid, path: string) => `history:${repoId}:${oid}:${path}`,
  insights: (repoId: string, tipOid: Oid, period: string) =>
    `insights:${repoId}:${tipOid}:${period}`,
  summary: (repoId: string) => `summary:${repoId}`,
  bisect: (repoId: string) => `bisect:${repoId}`,
};

/** A cached value, or `null` when it was never written / the store is unavailable. */
export async function getDerived<T>(key: string): Promise<T | null> {
  return guarded(async () => (await get<T>(key, derivedStore())) ?? null, null);
}

export async function setDerived<T>(key: string, value: T): Promise<void> {
  await guarded(async () => set(key, value, derivedStore()), undefined);
}

/** Clears one key, or the whole cache when no key is given (HelpDialog footer, palette action). */
export async function clearDerived(key?: string): Promise<void> {
  await guarded(async () => {
    if (key === undefined) await clear(derivedStore());
    else await del(key, derivedStore());
  }, undefined);
}

export interface DerivedSize {
  entries: number;
  /** Approximate stored bytes: the JSON length of every value, 0 for anything unserialisable. */
  bytes: number;
}

const EMPTY_SIZE: DerivedSize = { entries: 0, bytes: 0 };

export async function derivedSize(): Promise<DerivedSize> {
  return guarded(async () => {
    const all = await entries<string, unknown>(derivedStore());
    let bytes = 0;
    for (const [key, value] of all) {
      bytes += key.length;
      try {
        bytes += JSON.stringify(value)?.length ?? 0;
      } catch {
        // an unserialisable value still exists; it just cannot be measured (the total is "approximate")
      }
    }
    return { entries: all.length, bytes };
  }, EMPTY_SIZE);
}
