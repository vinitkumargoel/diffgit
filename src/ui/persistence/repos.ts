/**
 * Recent repositories in IndexedDB (T4.3). Handles are structured-cloneable, so the real
 * `FileSystemDirectoryHandle` (or an E2E marker) is stored as-is. Store name `diffgoel-repos`.
 */
import { createStore, del, entries, get, set } from "idb-keyval";
import { isMemoryHandleMarker } from "../../engine/fs/memoryDirHandle";
import { guarded } from "./storage";

export interface StoredRepo {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  lastOpenedAt: number;
  lastSource?: string;
  lastTarget?: string;
}

export const MAX_RECENTS = 20;

type Store = ReturnType<typeof createStore>;
let store: Store | null = null;
function repoStore(): Store {
  if (!store) store = createStore("diffgoel-repos", "repos");
  return store;
}
/** Test hook: use a fresh database. */
export function resetRepoStore(name = "diffgoel-repos"): void {
  store = createStore(name, "repos");
}

/** Handle equality: FSA `isSameEntry`, or `snapshotId` for E2E markers. */
async function sameHandle(a: unknown, b: unknown): Promise<boolean> {
  if (isMemoryHandleMarker(a) || isMemoryHandleMarker(b)) {
    return isMemoryHandleMarker(a) && isMemoryHandleMarker(b) && a.snapshotId === b.snapshotId;
  }
  // Either side may be a stored copy; ask whichever one still has the method.
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    const h = x as { isSameEntry?: (other: unknown) => Promise<boolean> };
    if (typeof h?.isSameEntry === "function") {
      try {
        return await h.isSameEntry(y);
      } catch {
        return false;
      }
    }
  }
  return a === b;
}

export async function listRepos(): Promise<StoredRepo[]> {
  return guarded(async () => {
    const all = (await entries<string, StoredRepo>(repoStore())).map(([, v]) => v);
    return all.sort((x, y) => y.lastOpenedAt - x.lastOpenedAt).slice(0, MAX_RECENTS);
  }, []);
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Adds or refreshes a repo (deduped by handle identity), pruning to `MAX_RECENTS`. */
export async function upsertRepo(handle: FileSystemDirectoryHandle): Promise<StoredRepo> {
  const name = (handle as { name?: string }).name ?? "repository";
  const fallback: StoredRepo = { id: newId(), name, handle, lastOpenedAt: Date.now() };
  return guarded(async () => {
    const all = (await entries<string, StoredRepo>(repoStore())).map(([, v]) => v);
    let existing: StoredRepo | undefined;
    for (const r of all) {
      if (await sameHandle(r.handle, handle)) {
        existing = r;
        break;
      }
    }
    const repo: StoredRepo = existing
      ? { ...existing, name, handle, lastOpenedAt: Date.now() }
      : fallback;
    await set(repo.id, repo, repoStore());
    const sorted = [...all.filter((r) => r.id !== repo.id), repo].sort(
      (x, y) => y.lastOpenedAt - x.lastOpenedAt,
    );
    for (const stale of sorted.slice(MAX_RECENTS)) await del(stale.id, repoStore());
    return repo;
  }, fallback);
}

export async function touchRepo(
  id: string,
  patch: { lastOpenedAt?: number; lastSource?: string; lastTarget?: string },
): Promise<void> {
  await guarded(async () => {
    const existing = await get<StoredRepo>(id, repoStore());
    if (!existing) return;
    await set(id, { ...existing, ...patch }, repoStore());
  }, undefined);
}

export async function removeRepo(id: string): Promise<void> {
  await guarded(() => del(id, repoStore()), undefined);
}

/**
 * Restores read permission on a persisted handle. Must be called from a user gesture
 * (`requestPermission` is gated on activation). Markers are always granted (E2E).
 */
export async function ensurePermission(handle: unknown): Promise<"granted" | "denied"> {
  if (isMemoryHandleMarker(handle)) return "granted";
  const h = handle as {
    queryPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
  };
  if (typeof h?.queryPermission !== "function" || typeof h.requestPermission !== "function") {
    return "denied";
  }
  try {
    if ((await h.queryPermission({ mode: "read" })) === "granted") return "granted";
    return (await h.requestPermission({ mode: "read" })) === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}
