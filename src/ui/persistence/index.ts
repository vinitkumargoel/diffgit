/**
 * Wires the persistence modules into the store (T4.3). Called once from `main.tsx`.
 * Storage failures never crash: on Home they are a fact in the hero's facts table (H6), and only
 * inside the app do they still surface as one warning toast (`STORAGE_UNAVAILABLE` copy).
 */
import { describeError } from "../errors";
import { configurePersistence, useStore } from "../store";
import { loadPrefs, savePrefs } from "./prefs";
import { touchRepo } from "./repos";
import { onStorageError } from "./storage";
import { loadViewed, saveViewed } from "./viewed";

export function installPersistence(): void {
  onStorageError(() => {
    const s = useStore.getState();
    s.setStorageUnavailable(true);
    // H6: the landing page states it in the facts table instead; a toast there would be noise.
    if (s.screen !== "home") {
      s.addToast({ level: "warning", message: describeError("STORAGE_UNAVAILABLE").message });
    }
  });
  configurePersistence({ loadViewed, saveViewed, touchRepo, loadPrefs, savePrefs });
}

export type { PermissionAnswer, StoredRepo } from "./repos";
export { ensurePermission, listRepos, queryPermission, removeRepo, upsertRepo } from "./repos";
