/**
 * Wires the persistence modules into the store (T4.3). Called once from `main.tsx`.
 * Storage failures surface as one warning toast (`STORAGE_UNAVAILABLE` copy), never as a crash.
 */
import { describeError } from "../errors";
import { configurePersistence, useStore } from "../store";
import { loadPrefs, savePrefs } from "./prefs";
import { touchRepo } from "./repos";
import { onStorageError } from "./storage";
import { loadViewed, saveViewed } from "./viewed";

export function installPersistence(): void {
  onStorageError(() => {
    const d = describeError("STORAGE_UNAVAILABLE");
    useStore.getState().addToast({ level: "warning", message: d.message });
  });
  configurePersistence({ loadViewed, saveViewed, touchRepo, loadPrefs, savePrefs });
}

export type { StoredRepo } from "./repos";
export { ensurePermission, getRepo, listRepos, removeRepo, upsertRepo } from "./repos";
