import { getPersistence, setPersistence } from "../persistence";
import type {
  GateCause,
  RecentNotice,
  RefreshMode,
  StoreGet,
  StorePersistence,
  StoreSet,
  StoreState,
} from "../types";

let uiSet: StoreSet | null = null;

export function configurePersistence(p: Partial<StorePersistence>): void {
  const pers = setPersistence(p);
  uiSet?.({ prefs: pers.loadPrefs() });
}

export type UiSlice = Pick<
  StoreState,
  | "mode"
  | "prefs"
  | "filter"
  | "activeFileId"
  | "collapsed"
  | "recentNotice"
  | "storageUnavailable"
  | "gateCause"
  | "palette"
  | "dismissedWarnings"
  | "setMode"
  | "setPalette"
  | "setGateCause"
  | "setRecentNotice"
  | "setStorageUnavailable"
  | "setFilter"
  | "setActiveFile"
  | "setCollapsed"
  | "dismissWarning"
  | "setPref"
  | "setRefreshMode"
>;

export function createUiSlice(set: StoreSet, get: StoreGet): UiSlice {
  uiSet = set;

  return {
    mode: "files",
    prefs: getPersistence().loadPrefs(),
    filter: "",
    activeFileId: null,
    collapsed: new Set(),
    recentNotice: null,
    storageUnavailable: false,
    gateCause: null,
    palette: false,
    dismissedWarnings: new Set(),

    setMode(mode) {
      const s = get();
      // T11.14: History, Branches and Insights all walk a repository; a patch file has none, so
      // the keys and the palette rows are as inert as the disabled ModeSwitch buttons.
      if (s.patchOnly && mode !== "files") return;
      if (s.mode === mode) return;
      set({ mode, palette: false });
    },

    setPalette(open) {
      set({ palette: open });
    },

    setGateCause(cause: GateCause | null) {
      set({ gateCause: cause });
    },

    setRecentNotice(notice: RecentNotice | null) {
      set({ recentNotice: notice });
    },

    setStorageUnavailable(on: boolean) {
      set({ storageUnavailable: on });
    },

    setFilter(text: string) {
      set({ filter: text });
    },

    setActiveFile(id: string | null) {
      set({ activeFileId: id });
    },

    setCollapsed(id: string, isCollapsed: boolean) {
      const collapsed = new Set(get().collapsed);
      if (isCollapsed) collapsed.add(id);
      else collapsed.delete(id);
      set({ collapsed });
    },

    dismissWarning(code) {
      set((s) => ({ dismissedWarnings: new Set([...s.dismissedWarnings, code]) }));
    },

    setPref(key, value) {
      const previous = get().prefs;
      const prefs = { ...previous, [key]: value };
      set({ prefs });
      getPersistence().savePrefs(prefs);
      if (key === "showHidden" && value !== previous.showHidden) {
        // T11.4: the listing is its own walk in the engine, so it runs only while the group is up.
        if (value) {
          if (get().hidden === null) void get().loadHidden();
        } else set({ hidden: null });
      }
      if (key === "builtinExcludes" && value !== previous.builtinExcludes) {
        // B10: the excludes are baked into `IgnoreRules` at open time; the session has to be rebuilt.
        void get().reopenSession();
      }
    },

    setRefreshMode(mode: RefreshMode) {
      set((s) => ({ refresh: { ...s.refresh, mode } }));
    },
  };
}
