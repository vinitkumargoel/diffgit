import { DEFAULT_PREFS, type StorePersistence } from "./types";

const NOOP_PERSISTENCE: StorePersistence = {
  loadViewed: async () => new Set(),
  saveViewed: async () => {},
  touchRepo: async () => {},
  loadPrefs: () => DEFAULT_PREFS,
  savePrefs: () => {},
};

let persistence: StorePersistence = NOOP_PERSISTENCE;

export function getPersistence(): StorePersistence {
  return persistence;
}

export function setPersistence(p: Partial<StorePersistence>): StorePersistence {
  persistence = { ...NOOP_PERSISTENCE, ...p };
  return persistence;
}
