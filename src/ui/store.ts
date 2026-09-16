/**
 * Zustand store (T4.2). Shape from Plan §6.3; actions are thin wrappers over the worker client.
 * This is the only module that imports the worker client (guard in scripts/check-guards.sh).
 *
 * Generation rule (amendment): every response is checked against `diff.generation`; stale ones are
 * dropped and `STALE` rejections ignored. Refresh orchestration moves to the scheduler in T6.1; until
 * then `recompute()` calls the client directly.
 */
import { create } from "zustand";
import type {
  FileDiffPayload,
  FileStats,
  Progress,
  ProgressPhase,
  ProgressSink,
  StatsBatch,
} from "../engine/api";
import { defaultDiffSource, isWorktreeSource } from "../engine/diffSource";
import type { WarningCode } from "../engine/errors";
import type {
  DiffResult,
  DiffSource,
  FileDiff,
  RepoInfo,
  RepoRef,
  RepoWarning,
} from "../engine/types";
import { getWorkerClient } from "./engineClient";
import { toUiError, type UiError } from "./errors";
import { Lru } from "./lru";
import { buildTree, filePathOf, makePathFilter, type TreeNode } from "./treeModel";
import { viewedKey } from "./viewedKey";
import type { WorkerClient } from "./workerClient";

export type Screen = "home" | "loading" | "repo" | "error";
export type ViewMode = "unified" | "split";
export type Theme = "system" | "light" | "dark";
export type SidebarLayout = "tree" | "flat";
export type RefreshMode = "live" | "polling" | "manual";
export type RefreshReason =
  | "manual"
  | "force"
  | "observer:git"
  | "observer:worktree"
  | "poll:git"
  | "poll:worktree"
  | "branch-change"
  | "initial"
  | "restart";

export interface Prefs {
  viewMode: ViewMode;
  ignoreWhitespace: boolean;
  theme: Theme;
  sidebarWidth: number;
  sidebarLayout: SidebarLayout;
}

export const DEFAULT_PREFS: Prefs = {
  viewMode: "unified",
  ignoreWhitespace: false,
  theme: "system",
  sidebarWidth: 300,
  sidebarLayout: "tree",
};

/** The four user-visible loading steps (Plan §6.1 screen 3) and how engine phases map onto them. */
export const LOADING_STEPS = ["refs", "index", "worktree", "diff"] as const;
export type LoadingStep = (typeof LOADING_STEPS)[number];
export const LOADING_LABELS: Record<LoadingStep, string> = {
  refs: "Reading refs",
  index: "Parsing index",
  worktree: "Scanning working tree",
  diff: "Computing diff",
};
export function stepForPhase(phase: ProgressPhase): LoadingStep | null {
  switch (phase) {
    case "layout":
    case "config":
    case "refs":
      return "refs";
    case "index":
      return "index";
    case "worktree":
      return "worktree";
    case "diff":
    case "renames":
      return "diff";
    default:
      return null;
  }
}

export interface LoadingState {
  step: LoadingStep | null;
  done?: number;
  total?: number;
  completed: LoadingStep[];
}

export type FileDiffEntry =
  | { status: "loading"; controller: AbortController }
  | { status: "ready"; data: FileDiffPayload }
  | { status: "error"; error: UiError };

export interface Toast {
  id: number;
  level: "error" | "warning" | "info";
  message: string;
  action?: { label: string; onClick: () => void };
}

export interface RefreshState {
  mode: RefreshMode;
  lastAt: number | null;
  busy: boolean;
  lastError: UiError | null;
  /** Set when the worker was recreated after a crash (UI shows "Engine restarted, refreshing"). */
  restarted: boolean;
}

/** Storage adapters injected by T4.3 (`persistence/index.ts`); defaults are no-ops. */
export interface StorePersistence {
  loadViewed(keys: string[]): Promise<Set<string>>;
  saveViewed(key: string, viewed: boolean): Promise<void>;
  touchRepo(
    id: string,
    patch: { lastSource?: string; lastTarget?: string; lastOpenedAt?: number },
  ): Promise<void>;
  loadPrefs(): Prefs;
  savePrefs(prefs: Prefs): void;
}
const NOOP_PERSISTENCE: StorePersistence = {
  loadViewed: async () => new Set(),
  saveViewed: async () => {},
  touchRepo: async () => {},
  loadPrefs: () => DEFAULT_PREFS,
  savePrefs: () => {},
};
let persistence: StorePersistence = NOOP_PERSISTENCE;
export function configurePersistence(p: Partial<StorePersistence>): void {
  persistence = { ...NOOP_PERSISTENCE, ...p };
  useStore.setState({ prefs: persistence.loadPrefs() });
}

export interface OpenOptions {
  /** Persisted repo id (T4.3). Falls back to the handle name. */
  id?: string;
  /** Remembered branches (display names or full refs); applied when they still exist. */
  lastSource?: string;
  lastTarget?: string;
}

export interface StoreState {
  screen: Screen;
  repo: RepoInfo | null;
  repoId: string | null;
  handle: unknown;
  loading: LoadingState;
  error: UiError | null;
  diffSource: DiffSource | null;
  diff: DiffResult | null;
  stats: Record<string, FileStats>;
  warnings: RepoWarning[];
  dismissedWarnings: ReadonlySet<WarningCode>;
  prefs: Prefs;
  viewed: ReadonlySet<string>; // viewed keys
  filter: string;
  activeFileId: string | null;
  collapsed: ReadonlySet<string>; // file ids collapsed in the diff pane
  refresh: RefreshState;
  fileDiffs: Lru<string, FileDiffEntry>;
  toasts: Toast[];
  announcement: string; // aria-live text

  // actions
  openRepo(handle: unknown, opts?: OpenOptions): Promise<void>;
  closeRepo(): Promise<void>;
  setSource(ref: RepoRef | string): void;
  setTarget(ref: RepoRef | string): void;
  swapBranches(): void;
  setIncludeWorktree(on: boolean): void;
  recompute(reason: RefreshReason): Promise<void>;
  loadFileDiff(id: string, opts?: { loadLarge?: boolean }): Promise<void>;
  cancelFileDiff(id: string): void;
  toggleViewed(id: string): void;
  setFilter(text: string): void;
  setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void;
  setActiveFile(id: string | null): void;
  setCollapsed(id: string, collapsed: boolean): void;
  dismissWarning(code: WarningCode): void;
  prioritise(ids: string[]): void;
  addToast(toast: Omit<Toast, "id">): number;
  dismissToast(id: number): void;
  setRefreshMode(mode: RefreshMode): void;
  fileBytes(id: string, side: "old" | "new"): Promise<Uint8Array | null>;
}

let toastSeq = 0;
let clientOverride: WorkerClient | null = null;
/** Test hook: use a specific client instead of `getWorkerClient()`. */
export function setStoreClient(client: WorkerClient | null): void {
  clientOverride = client;
  restartUnsub?.();
  restartUnsub = null;
}
let restartUnsub: (() => void) | null = null;
function client(): WorkerClient {
  const c = clientOverride ?? getWorkerClient();
  if (!restartUnsub) {
    restartUnsub = c.onRestart((info, error) => {
      const s = useStore.getState();
      if (error) {
        useStore.setState({ screen: "error", error });
        return;
      }
      if (info) useStore.setState({ repo: info });
      useStore.setState({ refresh: { ...s.refresh, restarted: true } });
      s.addToast({ level: "warning", message: "Engine restarted, refreshing" });
      void s.recompute("restart");
    });
  }
  return c;
}

function findRef(repo: RepoInfo, nameOrRef: string): RepoRef | null {
  return (
    repo.refs.find((r) => r.fullName === nameOrRef) ??
    repo.refs.find((r) => r.kind === "local" && r.name === nameOrRef) ??
    repo.refs.find((r) => r.name === nameOrRef) ??
    null
  );
}

function withRef(src: DiffSource, side: "source" | "target", ref: RepoRef): DiffSource {
  return side === "source"
    ? { ...src, source: ref.name, sourceRef: ref.fullName }
    : { ...src, target: ref.name, targetRef: ref.fullName };
}

/** Enforces D6: the toggle can only be on when the source is the checked-out state. */
function guardWorktree(src: DiffSource, repo: RepoInfo): DiffSource {
  if (src.includeWorktree && !isWorktreeSource(src, repo))
    return { ...src, includeWorktree: false };
  return src;
}

/** Rejections that are expected during recompute races; anything else is logged. */
function ignoreStale(e: unknown): void {
  const err = toUiError(e);
  if (err.code !== "STALE" && err.code !== "CANCELLED") console.warn("engine call failed", err);
}

function cacheKey(id: string, ignoreWhitespace: boolean): string {
  return `${id}|${ignoreWhitespace ? "w" : "x"}`;
}

export const useStore = create<StoreState>()((set, get) => {
  const sink: ProgressSink = {
    onProgress(p: Progress) {
      const step = stepForPhase(p.phase);
      if (!step) return;
      set((s) => {
        const completed = new Set(s.loading.completed);
        // every step before the current one is complete; the current one when it reports a duration
        for (const earlier of LOADING_STEPS) {
          if (earlier === step) break;
          completed.add(earlier);
        }
        if (p.durationMs !== undefined) completed.add(step);
        return {
          loading: { step, done: p.done, total: p.total, completed: [...completed] },
        };
      });
    },
    onStats(batch: StatsBatch) {
      const s = get();
      if (!s.diff || batch.generation !== s.diff.generation) return;
      set({ stats: { ...s.stats, ...batch.stats } });
    },
    onWarning(w: RepoWarning) {
      set((s) =>
        s.warnings.some((x) => x.code === w.code) ? {} : { warnings: [...s.warnings, w] },
      );
    },
  };

  return {
    screen: "home",
    repo: null,
    repoId: null,
    handle: null,
    loading: { step: null, completed: [] },
    error: null,
    diffSource: null,
    diff: null,
    stats: {},
    warnings: [],
    dismissedWarnings: new Set(),
    prefs: persistence.loadPrefs(),
    viewed: new Set(),
    filter: "",
    activeFileId: null,
    collapsed: new Set(),
    refresh: { mode: "manual", lastAt: null, busy: false, lastError: null, restarted: false },
    fileDiffs: new Lru(200),
    toasts: [],
    announcement: "",

    async openRepo(handle, opts = {}) {
      await get().closeRepo();
      const name =
        typeof handle === "object" &&
        handle !== null &&
        typeof (handle as { name?: unknown }).name === "string"
          ? (handle as { name: string }).name
          : "repository";
      set({
        screen: "loading",
        handle,
        repoId: opts.id ?? name,
        loading: { step: "refs", completed: [] },
        error: null,
        warnings: [],
        dismissedWarnings: new Set(),
        diff: null,
        stats: {},
        viewed: new Set(),
        filter: "",
        activeFileId: null,
        collapsed: new Set(),
        fileDiffs: new Lru(200),
      });
      try {
        const info = await client().open(handle, sink);
        let src = defaultDiffSource(info);
        if (opts.lastTarget) {
          const t = findRef(info, opts.lastTarget);
          if (t) src = withRef(src, "target", t);
        }
        if (opts.lastSource) {
          const sref = findRef(info, opts.lastSource);
          if (sref) src = withRef(src, "source", sref);
        }
        src = guardWorktree(src, info);
        set({ repo: info, diffSource: src, warnings: [...info.warnings] });
        await get().recompute("initial");
        if (get().screen === "loading") set({ screen: "repo" });
      } catch (e) {
        set({ screen: "error", error: toUiError(e) });
      }
    },

    async closeRepo() {
      const s = get();
      if (s.repo || s.screen === "loading") {
        try {
          await client().close();
        } catch (e) {
          // not user-actionable: the session is being discarded anyway; keep a trace for debugging
          console.warn("closeRepo: engine close failed", e);
        }
      }
      set({
        screen: "home",
        repo: null,
        repoId: null,
        handle: null,
        diffSource: null,
        diff: null,
        stats: {},
        warnings: [],
        error: null,
        activeFileId: null,
        fileDiffs: new Lru(200),
        refresh: { mode: "manual", lastAt: null, busy: false, lastError: null, restarted: false },
      });
    },

    setSource(refOrName) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const ref = typeof refOrName === "string" ? findRef(repo, refOrName) : refOrName;
      if (!ref) return;
      const src = guardWorktree(withRef(diffSource, "source", ref), repo);
      set({ diffSource: src });
      void persistence.touchRepo(get().repoId ?? "", { lastSource: ref.fullName });
      void get().recompute("branch-change");
    },

    setTarget(refOrName) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const ref = typeof refOrName === "string" ? findRef(repo, refOrName) : refOrName;
      if (!ref) return;
      set({ diffSource: withRef(diffSource, "target", ref) });
      void persistence.touchRepo(get().repoId ?? "", { lastTarget: ref.fullName });
      void get().recompute("branch-change");
    },

    swapBranches() {
      const { repo, diffSource } = get();
      if (!repo || !diffSource || diffSource.sourceRef === diffSource.targetRef) return;
      const swapped: DiffSource = {
        ...diffSource,
        source: diffSource.target,
        sourceRef: diffSource.targetRef,
        target: diffSource.source,
        targetRef: diffSource.sourceRef,
      };
      set({ diffSource: guardWorktree(swapped, repo) });
      void persistence.touchRepo(get().repoId ?? "", {
        lastSource: swapped.sourceRef,
        lastTarget: swapped.targetRef,
      });
      void get().recompute("branch-change");
    },

    setIncludeWorktree(on) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      if (on && !isWorktreeSource(diffSource, repo)) return;
      if (diffSource.includeWorktree === on) return;
      set({ diffSource: { ...diffSource, includeWorktree: on } });
      void get().recompute("branch-change");
    },

    async recompute(_reason) {
      const { diffSource, repo } = get();
      if (!diffSource || !repo) return;
      set((s) => ({ refresh: { ...s.refresh, busy: true } }));
      try {
        const result = await client().computeDiff(diffSource);
        const current = get();
        // a newer compute may have started meanwhile; comlink resolves in order, but be defensive
        if (current.diff && result.generation < current.diff.generation) return;
        const stats: Record<string, FileStats> = {};
        for (const f of result.files) if (f.stats) stats[f.id] = f.stats;
        const keys = result.files.map((f) => viewedKey(current.repoId ?? "", result.source, f));
        const viewed = await persistence.loadViewed(keys);
        const stillThere = new Set(result.files.map((f) => f.id));
        const activeFileId =
          current.activeFileId && stillThere.has(current.activeFileId)
            ? current.activeFileId
            : null;
        const collapsed = new Set([...current.collapsed].filter((id) => stillThere.has(id)));
        // engine warnings are per-result; keep repo-level ones and merge
        const repoWarnings = current.repo?.warnings ?? [];
        const merged: RepoWarning[] = [...repoWarnings];
        for (const w of result.warnings) if (!merged.some((x) => x.code === w.code)) merged.push(w);
        set((s) => ({
          diff: result,
          stats,
          viewed,
          activeFileId,
          collapsed,
          warnings: merged,
          fileDiffs: new Lru(200),
          screen: s.screen === "loading" || s.screen === "repo" ? "repo" : s.screen,
          refresh: {
            ...s.refresh,
            busy: false,
            lastAt: Date.now(),
            lastError: null,
            restarted: false,
          },
          announcement: `Diff updated: ${result.files.length} ${result.files.length === 1 ? "file" : "files"}`,
        }));
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "CANCELLED" || err.code === "STALE") {
          set((s) => ({ refresh: { ...s.refresh, busy: false } }));
          return;
        }
        if (err.code === "HANDLE_GONE" || err.code === "PERMISSION") {
          set((s) => ({
            screen: "error",
            error: err,
            refresh: { ...s.refresh, busy: false, lastError: err },
          }));
          return;
        }
        if (get().screen === "loading") {
          set((s) => ({
            screen: "error",
            error: err,
            refresh: { ...s.refresh, busy: false, lastError: err },
          }));
          return;
        }
        set((s) => ({ refresh: { ...s.refresh, busy: false, lastError: err } }));
        get().addToast({
          level: "error",
          message: `Refresh failed: ${err.message}`,
          action: { label: "Retry", onClick: () => void get().recompute("manual") },
        });
      }
    },

    async loadFileDiff(id, opts = {}) {
      const s = get();
      if (!s.diff) return;
      const key = cacheKey(id, s.prefs.ignoreWhitespace);
      const existing = s.fileDiffs.get(key);
      if (existing && existing.status !== "error") {
        if (
          existing.status === "ready" &&
          opts.loadLarge &&
          existing.data.hunks === null &&
          existing.data.classification.tooLarge
        ) {
          // fall through: user asked to load a gated diff
        } else return;
      }
      const controller = new AbortController();
      const generation = s.diff.generation;
      const next = s.fileDiffs.clone();
      next.set(key, { status: "loading", controller });
      set({ fileDiffs: next });
      try {
        const data = await client().fileDiff(generation, id, {
          ignoreWhitespace: s.prefs.ignoreWhitespace,
          loadLarge: opts.loadLarge === true,
        });
        const cur = get();
        if (!cur.diff || cur.diff.generation !== generation || controller.signal.aborted) return;
        const updated = cur.fileDiffs.clone();
        updated.set(key, { status: "ready", data });
        set({ fileDiffs: updated });
      } catch (e) {
        const err = toUiError(e);
        const cur = get();
        if (err.code === "STALE" || err.code === "CANCELLED" || controller.signal.aborted) {
          if (cur.fileDiffs.get(key)?.status === "loading") {
            const updated = cur.fileDiffs.clone();
            updated.delete(key);
            set({ fileDiffs: updated });
          }
          return;
        }
        const updated = cur.fileDiffs.clone();
        updated.set(key, { status: "error", error: err });
        set({ fileDiffs: updated });
      }
    },

    cancelFileDiff(id) {
      const s = get();
      const key = cacheKey(id, s.prefs.ignoreWhitespace);
      const entry = s.fileDiffs.get(key);
      if (entry?.status === "loading") {
        entry.controller.abort();
        const updated = s.fileDiffs.clone();
        updated.delete(key);
        set({ fileDiffs: updated });
        void client().cancelFileDiff(id).catch(ignoreStale);
      }
    },

    toggleViewed(id) {
      const s = get();
      const file = s.diff?.files.find((f) => f.id === id);
      if (!file || !s.diff) return;
      const key = viewedKey(s.repoId ?? "", s.diff.source, file);
      const viewed = new Set(s.viewed);
      const collapsed = new Set(s.collapsed);
      const nowViewed = !viewed.has(key);
      if (nowViewed) {
        viewed.add(key);
        collapsed.add(id);
      } else {
        viewed.delete(key);
        collapsed.delete(id);
      }
      set({ viewed, collapsed });
      void persistence.saveViewed(key, nowViewed);
    },

    setFilter(text) {
      set({ filter: text });
    },

    setPref(key, value) {
      const prefs = { ...get().prefs, [key]: value };
      set({ prefs });
      persistence.savePrefs(prefs);
    },

    setActiveFile(id) {
      set({ activeFileId: id });
    },

    setCollapsed(id, isCollapsed) {
      const collapsed = new Set(get().collapsed);
      if (isCollapsed) collapsed.add(id);
      else collapsed.delete(id);
      set({ collapsed });
    },

    dismissWarning(code) {
      set((s) => ({ dismissedWarnings: new Set([...s.dismissedWarnings, code]) }));
    },

    prioritise(ids) {
      if (!get().diff) return;
      void client().prioritise(ids).catch(ignoreStale);
    },

    addToast(toast) {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
      return id;
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    setRefreshMode(mode) {
      set((s) => ({ refresh: { ...s.refresh, mode } }));
    },

    async fileBytes(id, side) {
      const s = get();
      if (!s.diff) return null;
      return client().fileBytes(s.diff.generation, id, side);
    },
  };
});

// ---- Selectors (memoised on input identity) ----

let visibleCache: { files: FileDiff[]; filter: string; result: FileDiff[] } | null = null;
export function selectVisibleFiles(s: Pick<StoreState, "diff" | "filter">): FileDiff[] {
  const files = s.diff?.files ?? [];
  if (visibleCache && visibleCache.files === files && visibleCache.filter === s.filter)
    return visibleCache.result;
  const match = makePathFilter(s.filter);
  const result = s.filter.trim() === "" ? files : files.filter((f) => match(filePathOf(f)));
  visibleCache = { files, filter: s.filter, result };
  return result;
}

export function selectTotals(s: Pick<StoreState, "diff" | "stats">): {
  files: number;
  additions: number;
  deletions: number;
} {
  const files = s.diff?.files ?? [];
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    const st = s.stats[f.id] ?? f.stats;
    if (st) {
      additions += st.additions;
      deletions += st.deletions;
    }
  }
  return { files: files.length, additions, deletions };
}

export function isViewed(
  s: Pick<StoreState, "diff" | "viewed" | "repoId">,
  file: FileDiff,
): boolean {
  if (!s.diff) return false;
  return s.viewed.has(viewedKey(s.repoId ?? "", s.diff.source, file));
}

export function selectViewedCount(s: Pick<StoreState, "diff" | "viewed" | "repoId">): number {
  if (!s.diff) return 0;
  let n = 0;
  for (const f of s.diff.files) if (isViewed(s, f)) n++;
  return n;
}

export function selectCanIncludeWorktree(s: Pick<StoreState, "diffSource" | "repo">): boolean {
  return !!s.diffSource && !!s.repo && isWorktreeSource(s.diffSource, s.repo);
}

let treeCache: { files: FileDiff[]; result: TreeNode[] } | null = null;
export function selectTreeModel(s: Pick<StoreState, "diff" | "filter">): TreeNode[] {
  const files = selectVisibleFiles(s);
  if (treeCache && treeCache.files === files) return treeCache.result;
  const result = buildTree(files);
  treeCache = { files, result };
  return result;
}

export function selectActiveWarnings(
  s: Pick<StoreState, "warnings" | "dismissedWarnings">,
): RepoWarning[] {
  return s.warnings.filter((w) => !s.dismissedWarnings.has(w.code));
}

export function selectFileDiff(
  s: Pick<StoreState, "fileDiffs" | "prefs">,
  id: string,
): FileDiffEntry | undefined {
  return s.fileDiffs.get(cacheKey(id, s.prefs.ignoreWhitespace));
}
