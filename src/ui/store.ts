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
  ConflictKind,
  ConflictPayload,
  EngineMetrics,
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
  BranchesSource,
  DiffResult,
  DiffSource,
  FileDiff,
  Oid,
  ReflogEntry,
  RepoInfo,
  RepoOperation,
  RepoRef,
  RepoWarning,
  ResolvedRevision,
  StashInfo,
  TagInfo,
} from "../engine/types";
import type { CompareSpec } from "./compareHash";
import { buildSource, labelOf, revToSide, type SideRev, sideOf } from "./compareSource";
import { getWorkerClient } from "./engineClient";
import { LOADING_INLINE_CODES, toUiError, type UiError } from "./errors";
import { Lru } from "./lru";
import { revisionOfRef } from "./refGroups";
import {
  buildTree,
  type FileGroup,
  GROUP_ORDER,
  groupFiles,
  groupOf,
  makeFileFilter,
  type SidebarGroupId,
  type TreeNode,
} from "./treeModel";
import { viewedKey } from "./viewedKey";
import type { ClientMetrics, WorkerClient } from "./workerClient";

export type { ClientMetrics } from "./workerClient";

export type Screen = "home" | "loading" | "repo" | "error";
export type ViewMode = "unified" | "split";
export type Theme = "system" | "light" | "dark";
export type SidebarLayout = "tree" | "flat";
/** D2: group the sidebar by change layer, or keep the plain path tree. */
export type SidebarGroup = "layer" | "path";
export type RefreshMode = "live" | "polling" | "manual";
/** The four pages of v2 (Design §14.1); Files is the default and the only one with the file tree. */
export type AppMode = "files" | "history" | "branches" | "insights";
/** `Diff | Blame | History` on a FileCard header (Design §14.1, filled by T11.6). */
export type CardMode = "diff" | "blame" | "history";
/** Sub-tab of the History mode sidebar (Design §14.5, filled by T11.5). */
export type HistoryTab = "commits" | "stack" | "reflog";
/** Period of the Insights header (Design §14.6, filled by T11.12). */
export type InsightsPeriod = "90d" | "1y" | "all";
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
  sidebarGroup: SidebarGroup;
  /**
   * v2 (docs/v2-contracts.md § Store). `mode` is validated and defaulted like every other key but
   * deliberately never carried across a session: `StoreState.mode` is the live value and always
   * starts at "files", so opening a repository never lands somewhere unexpected.
   */
  mode: AppMode;
  /** Sidebar "Show hidden files" toggle (Design §14.1 / §14.4; the group itself is T11.4). */
  showHidden: boolean;
  /** Apply diffgit's built-in excludes on top of the repository's ignore rules (T10.4). */
  builtinExcludes: boolean;
  insightsPeriod: InsightsPeriod;
  /** Picker footer `three-dot … | two-dot ..` (Design §14.1; the pickers are T11.2). */
  twoDot: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  viewMode: "unified",
  ignoreWhitespace: false,
  theme: "system",
  sidebarWidth: 300,
  sidebarLayout: "tree",
  sidebarGroup: "layer",
  mode: "files",
  showHidden: false,
  builtinExcludes: true,
  insightsPeriod: "90d",
  twoDot: false,
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

/** What a finished step reports (L1: "412 refs · 0.3 s"). */
export interface StepResult {
  durationMs: number;
  /** Items processed when the engine reported a total (index entries, worktree files). */
  count?: number;
}

export interface LoadingState {
  step: LoadingStep | null;
  done?: number;
  total?: number;
  completed: LoadingStep[];
  /** `Date.now()` when this open started; drives the elapsed counter and the slow callout (L3). */
  startedAt: number | null;
  /** Results of completed steps. */
  phases: Partial<Record<LoadingStep, StepResult>>;
  /** Engine sub-phases already finished inside the current step ("layout ok · config ok"). */
  subPhases: ProgressPhase[];
  /** 1-based open attempt; > 1 after the engine restarted mid-open (L5). */
  attempt: number;
  /** Set when the open failed with a phase-attachable code (L4); the screen stays "loading". */
  failed: UiError | null;
  failedStep: LoadingStep | null;
  /** `lastOpenMs` of the stored repo, when known ("usually ~6 s"). */
  expectedMs: number | null;
}

export const MAX_OPEN_ATTEMPTS = 3;
/** Engine restarts within this window before the store gives up (E4.3). */
export const RESTART_WINDOW_MS = 60_000;
export const MAX_RESTARTS = 3;

export function initialLoading(patch: Partial<LoadingState> = {}): LoadingState {
  return {
    step: null,
    completed: [],
    startedAt: null,
    phases: {},
    subPhases: [],
    attempt: 1,
    failed: null,
    failedStep: null,
    expectedMs: null,
    ...patch,
  };
}

/** Why a Recent row could not be opened (H4); shown on the row after the store returns Home. */
export interface RecentNotice {
  repoId: string;
  code: "HANDLE_GONE" | "NOT_A_REPO" | "PERMISSION";
}

/** Why the browser gate is up although `showDirectoryPicker` exists (B6: refused on first click). */
export type GateCause =
  | "firefox"
  | "safari"
  | "mobile"
  | "insecure"
  | "iframe"
  | "old"
  | "policy"
  | "unknown";

export type FileDiffEntry =
  | { status: "loading"; controller: AbortController }
  | { status: "ready"; data: FileDiffPayload }
  | { status: "error"; error: UiError };

/** T11.3: the three-way payload of one conflicted file, keyed by file id in `conflicts`. */
export type ConflictEntry =
  | { status: "loading" }
  | { status: "ready"; data: ConflictPayload }
  | { status: "error"; error: UiError };

/** How many conflicted files are pre-loaded after a compute (the sidebar needs their XY code). */
export const CONFLICT_PRELOAD_LIMIT = 100;
/** Rows `loadReflog` asks the engine for (Design §14.5; T11.5 will page beyond this). */
export const REFLOG_LIMIT = 200;
/** `markReachable` is called in batches of this size (task T11.3), once T10.5 ships it. */
export const REACHABLE_BATCH = 50;

/**
 * T10.5 ships `markReachable`; until then the client simply does not have it, so the reflog's
 * `unreachable` badge stays unrendered instead of guessing. Feature check, not a contract change.
 */
type MaybeReachable = {
  markReachable?(oids: Oid[]): Promise<Record<Oid, boolean>>;
};

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
  /** Engine phase in flight during a recompute (T6.4 progress in the refresh control). */
  phase?: ProgressPhase | null;
  /** Engine restarts seen in the last `RESTART_WINDOW_MS` (E4.3 gives up at `MAX_RESTARTS`). */
  restarts?: number;
}

/** Storage adapters injected by T4.3 (`persistence/index.ts`); defaults are no-ops. */
/** Debug-panel timings (T7.2): engine phase durations from the last compute + wall time. */
export interface PerfState {
  phases: Partial<Record<ProgressPhase, number>>;
  lastComputeMs: number | null;
  computeStartedAt: number | null;
}

export interface StorePersistence {
  loadViewed(keys: string[]): Promise<Set<string>>;
  saveViewed(key: string, viewed: boolean): Promise<void>;
  touchRepo(
    id: string,
    patch: { lastSource?: string; lastTarget?: string; lastOpenedAt?: number; lastOpenMs?: number },
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
  /** Wall time of the previous open of this repo (L1 "usually ~6 s"). */
  expectedMs?: number;
  /** Open without the working tree layers (L3 "Skip uncommitted changes"). */
  skipWorktree?: boolean;
}

/**
 * Stands in for an engine type that `docs/v2-contracts.md` names but a later phase-10 task still
 * has to add to `src/engine/types.ts` (`SecretFinding` T10.7, `HiddenEntry` T10.4, `CommitSummary`
 * T10.5, `BisectState & BisectStep` T10.11 — `RepoOperation` was widened by T11.3). `never` keeps the
 * field honest: it exists and the shell can switch on it, but nothing can put data in it until the
 * task that owns the type widens this one annotation.
 */
type PendingEngineType = never;

/** History-mode state (Design §14.5); T11.5 fills it. */
export interface HistoryState {
  commits: PendingEngineType[];
  cursor: string | null;
  loading: boolean;
  selected: Oid | null;
  rangeStart: Oid | null;
  query: string;
  firstParent: boolean;
  all: boolean;
  capped: boolean;
}

export const INITIAL_HISTORY: HistoryState = {
  commits: [],
  cursor: null,
  loading: false,
  selected: null,
  rangeStart: null,
  query: "",
  firstParent: false,
  all: false,
  capped: false,
};

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
  /** `Date.now()` of the last stats batch for the current diff; null once complete or before any (S8). */
  statsLastAt: number | null;
  warnings: RepoWarning[];
  dismissedWarnings: ReadonlySet<WarningCode>;
  prefs: Prefs;
  viewed: ReadonlySet<string>; // viewed keys
  filter: string;
  activeFileId: string | null;
  collapsed: ReadonlySet<string>; // file ids collapsed in the diff pane
  refresh: RefreshState;
  perf: PerfState;
  fileDiffs: Lru<string, FileDiffEntry>;
  toasts: Toast[];
  announcement: string; // aria-live text
  /** Bumped with every announcement so the live region re-renders even for identical text. */
  announcementSeq: number;
  /** Inline outcome for a Recent row after an open from history failed (H4). */
  recentNotice: RecentNotice | null;
  /** Set when IndexedDB is blocked or full: Home says so in the facts table instead of toasting (H6). */
  storageUnavailable: boolean;
  /** Set when the picker itself is refused (policy / SecurityError): the gate takes over (B6). */
  gateCause: GateCause | null;

  // ---- v2 shell (docs/v2-contracts.md § Store; T11.1 creates them, later tasks fill behaviour) ----
  /** Which page the body shows (Design §14.1). Session state: always "files" on open. */
  mode: AppMode;
  /** History sidebar sub-tab (T11.5). */
  historyTab: HistoryTab;
  /** `Diff | Blame | History` per file id (T11.6). */
  cardModes: Record<string, CardMode>;
  /**
   * The merge / rebase / cherry-pick / revert / bisect in progress (T11.3, Design §14.3). Mirrors
   * `repo.operation`, which `reloadRefs()` refreshes on every git-side refresh tick, so the banner
   * follows git live.
   */
  operation: RepoOperation | null;
  /** `HEAD`'s reflog for the Reflog list (T11.3); null = not read yet. */
  reflog: ReflogEntry[] | null;
  /** Three-way payloads of the conflicted files of the current diff, keyed by file id (T11.3). */
  conflicts: Record<string, ConflictEntry>;
  /** Secret-scan findings for the current diff; null = not scanned (T11.9). */
  secrets: PendingEngineType[] | null;
  /** Hidden paths behind the "Show hidden files" toggle; null = not listed (T11.4). */
  hidden: PendingEngineType[] | null;
  history: HistoryState;
  /** Running bisect (T11.13). */
  bisect: PendingEngineType | null;
  /** Command palette open (Design §14.1). */
  palette: boolean;
  /** Firefox/Safari read-once mode: the folder was read once and cannot refresh (T11.15). */
  snapshotMode: boolean;
  /** A `.patch` / `.diff` file is open, not a repository (T11.14). */
  patchOnly: boolean;
  /** Tags for the picker's `Tags` group; null = not listed yet (T11.2, lazy on first open). */
  tags: TagInfo[] | null;
  /** Stashes for the picker's `Stashes` group; null = not listed yet (T11.2). */
  stashes: StashInfo[] | null;

  // actions
  openRepo(handle: unknown, opts?: OpenOptions): Promise<void>;
  closeRepo(): Promise<void>;
  setSource(ref: RepoRef | string): void;
  setTarget(ref: RepoRef | string): void;
  /**
   * T11.2: the general form of `setSource`/`setTarget`. Puts any resolved revision on one side and
   * rebuilds the source — a `BranchesSource` while both sides are plain refs compared three-dot, a
   * `RangeSource` otherwise (`docs/v2-contracts.md`, `src/ui/compareSource.ts`).
   */
  setRevision(rev: ResolvedRevision, side: "source" | "target"): void;
  /**
   * The picker's `Special` group (Design §14.1). Both rows compare the checked-out commit with the
   * working tree on top of it, i.e. "my uncommitted work"; `"staged"` additionally narrows the file
   * filter to `layer:staged`, because `DiffSource` has no index-as-a-side kind to select.
   */
  setSpecialSource(kind: "worktree" | "staged"): void;
  /** Picker footer `three-dot … | two-dot ..`: writes the pref and rebuilds the source (T11.2). */
  setTwoDot(on: boolean): void;
  /** Free-text row in the picker; rejects with a `UiError` (`REV_NOT_FOUND`, `REV_AMBIGUOUS`). */
  resolveRevision(expr: string): Promise<ResolvedRevision>;
  /** Fills `tags` / `stashes` once per open; called when a picker is opened for the first time. */
  loadPickerSources(): Promise<void>;
  /** Applies a `#compare=<from>...<to>` spec to the open repository (T11.2). */
  applyCompare(spec: CompareSpec): Promise<void>;
  swapBranches(): void;
  setIncludeWorktree(on: boolean): void;
  /** Executor: calls the engine once. Everything else goes through `requestRefresh`. */
  recompute(reason: RefreshReason): Promise<void>;
  /** Entry point for "something may have changed" — routed to the scheduler (T6.1) when present. */
  requestRefresh(reason: RefreshReason, paths?: string[]): void;
  /** Debug panel snapshot (T7.2). */
  debugMetrics(): Promise<{
    engine: EngineMetrics | null;
    client: ClientMetrics;
  }>;
  loadFileDiff(id: string, opts?: { loadLarge?: boolean }): Promise<void>;
  /** T11.3: the three-way payload of one conflicted file; `STALE`/`CANCELLED` drop silently. */
  loadConflict(id: string): Promise<void>;
  /** T11.3: reads `HEAD`'s reflog once per open and fills `reachable` when the engine can. */
  loadReflog(): Promise<void>;
  cancelFileDiff(id: string): void;
  toggleViewed(id: string): void;
  /** Batch form of `toggleViewed` (T9.1: the group header's "mark all viewed"). */
  setViewed(ids: string[], viewed: boolean): void;
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
  setRecentNotice(notice: RecentNotice | null): void;
  setStorageUnavailable(on: boolean): void;
  setGateCause(cause: GateCause | null): void;
  /** Switches the body page (ModeSwitch, keys `1`–`4`, palette). */
  setMode(mode: AppMode): void;
  /** Opens or closes the command palette (`⌘K` / `Ctrl+K`, the row 1 icon button). */
  setPalette(open: boolean): void;
}

let toastSeq = 0;
/** The refresh scheduler (T6.1) registers here; the store never imports it (no cycle). */
export interface RefreshHooks {
  start(handle: unknown): void;
  stop(): void;
  request(reason: RefreshReason, paths?: string[]): void;
}
let refreshHooks: RefreshHooks | null = null;
export function setRefreshHooks(hooks: RefreshHooks | null): void {
  refreshHooks = hooks;
}

let clientOverride: WorkerClient | null = null;
/** Test hook: use a specific client instead of `getWorkerClient()`. */
export function setStoreClient(client: WorkerClient | null): void {
  clientOverride = client;
  restartUnsub?.();
  restartUnsub = null;
}
let restartUnsub: (() => void) | null = null;
/**
 * Stats batches that arrive over the sink before `recompute()` has committed the matching
 * `DiffResult` (the worker streams them while `computeDiff` is still resolving and while we await
 * `loadViewed`). Keyed by generation; merged into `stats` when the result lands.
 */
const pendingStats = new Map<number, Record<string, FileStats>>();
/** Timestamps of engine restarts (E4.3 give-up window). */
const restartTimes: number[] = [];
function client(): WorkerClient {
  const c = clientOverride ?? getWorkerClient();
  if (!restartUnsub) {
    restartUnsub = c.onRestart((info, error) => {
      const s = useStore.getState();
      if (error) {
        useStore.setState({ screen: "error", error });
        return;
      }
      const now = Date.now();
      restartTimes.push(now);
      while (restartTimes.length > 0 && now - (restartTimes[0] as number) > RESTART_WINDOW_MS)
        restartTimes.shift();
      const restarts = restartTimes.length;
      if (s.screen === "loading") {
        // openRepo's attempt loop owns the retry and the counter (L5)
        useStore.setState({ refresh: { ...s.refresh, restarts } });
        return;
      }
      if (restarts >= MAX_RESTARTS) {
        // E4.3: the engine keeps stopping; stop retrying and say so
        restartTimes.length = 0;
        useStore.setState({
          screen: "error",
          error: {
            code: "WORKER_CRASHED",
            message: `The diff engine stopped ${restarts} times in a minute while this repository was open.`,
          },
          refresh: { ...s.refresh, busy: false, restarts },
        });
        return;
      }
      if (info) useStore.setState({ repo: info, operation: info.operation });
      useStore.setState({ refresh: { ...s.refresh, restarted: true, restarts } });
      s.addToast({
        level: "warning",
        message: "Engine restarted, refreshing the diff. Your viewed marks are kept.",
      });
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

/** The `listTags` + `listStashes` pass for the pickers; one per open (T11.2). */
let pickerSources: Promise<void> | null = null;

/** Only a v1 branch pair is remembered for the next open; a range is deep-linked by hash instead. */
function withRef(src: BranchesSource, side: "source" | "target", ref: RepoRef): BranchesSource {
  return side === "source"
    ? { ...src, source: ref.name, sourceRef: ref.fullName }
    : { ...src, target: ref.name, targetRef: ref.fullName };
}

/** Enforces D6: the toggle can only be on when the source is the checked-out state. */
function guardWorktree<T extends DiffSource>(src: T, repo: RepoInfo): T {
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
      if (p.durationMs !== undefined && p.phase !== "probe") {
        set((s) => ({
          perf: { ...s.perf, phases: { ...s.perf.phases, [p.phase]: p.durationMs } },
        }));
      }
      if (p.phase !== "probe") {
        const done = p.durationMs !== undefined && p.phase !== "stats";
        set((s) => ({ refresh: { ...s.refresh, phase: done ? null : p.phase } }));
      }
      const step = stepForPhase(p.phase);
      if (!step) return;
      set((s) => {
        const completed = new Set(s.loading.completed);
        // every step before the current one is complete; the current one when it reports a duration
        for (const earlier of LOADING_STEPS) {
          if (earlier === step) break;
          completed.add(earlier);
        }
        const phases = { ...s.loading.phases };
        // finished sub-phases are kept for the whole open so done rows keep "layout ok · config ok"
        const subPhases = [...s.loading.subPhases];
        if (p.durationMs !== undefined) {
          // a sub-phase (layout / config) finishing inside "refs"; the step itself finishes on its own phase
          if (p.phase === step) {
            completed.add(step);
            const prev = phases[step];
            const count = p.total ?? p.done ?? prev?.count;
            phases[step] = {
              durationMs: (prev?.durationMs ?? 0) + p.durationMs,
              ...(count !== undefined ? { count } : {}),
            };
          } else {
            if (!subPhases.includes(p.phase)) subPhases.push(p.phase);
            const prev = phases[step];
            phases[step] = { ...(prev ?? {}), durationMs: (prev?.durationMs ?? 0) + p.durationMs };
          }
        }
        return {
          loading: {
            ...s.loading,
            step,
            done: p.done,
            total: p.total,
            completed: [...completed],
            phases,
            subPhases,
          },
        };
      });
    },
    onStats(batch: StatsBatch) {
      const s = get();
      if (s.diff && batch.generation === s.diff.generation) {
        set({ stats: { ...s.stats, ...batch.stats }, statsLastAt: Date.now() });
        return;
      }
      if (s.diff && batch.generation < s.diff.generation) return; // stale generation
      pendingStats.set(batch.generation, {
        ...(pendingStats.get(batch.generation) ?? {}),
        ...batch.stats,
      });
    },
    onWarning(w: RepoWarning) {
      set((s) =>
        s.warnings.some((x) => x.code === w.code) ? {} : { warnings: [...s.warnings, w] },
      );
    },
  };

  /**
   * The one place a new `DiffSource` is committed (T11.2): build → D6 worktree guard → remember the
   * pair when it is still a v1 branch pair → recompute. Every picker action funnels through it, so
   * ranges, branches, the two-dot toggle and swap can never drift apart.
   */
  function applySides(from: SideRev, to: SideRev, includeWorktree?: boolean): void {
    const { repo, prefs } = get();
    if (!repo) return;
    const worktree = includeWorktree ?? get().diffSource?.includeWorktree ?? true;
    const built = buildSource(from, to, !prefs.twoDot, worktree);
    if (!built) {
      get().addToast({
        level: "warning",
        message: `Cannot compare ${from.display} … ${to.display}: the compare side has no commit.`,
      });
      return;
    }
    const src = guardWorktree(built, repo);
    set({ diffSource: src });
    if (src.kind === "branches") {
      void persistence.touchRepo(get().repoId ?? "", {
        lastSource: src.sourceRef,
        lastTarget: src.targetRef,
      });
    }
    get().requestRefresh("branch-change");
  }

  return {
    screen: "home",
    repo: null,
    repoId: null,
    handle: null,
    loading: initialLoading(),
    error: null,
    diffSource: null,
    diff: null,
    stats: {},
    statsLastAt: null,
    warnings: [],
    dismissedWarnings: new Set(),
    prefs: persistence.loadPrefs(),
    viewed: new Set(),
    filter: "",
    activeFileId: null,
    collapsed: new Set(),
    refresh: { mode: "manual", lastAt: null, busy: false, lastError: null, restarted: false },
    fileDiffs: new Lru(200),
    perf: { phases: {}, lastComputeMs: null, computeStartedAt: null },
    toasts: [],
    announcement: "",
    announcementSeq: 0,
    recentNotice: null,
    storageUnavailable: false,
    gateCause: null,
    mode: "files",
    historyTab: "commits",
    cardModes: {},
    operation: null,
    reflog: null,
    conflicts: {},
    secrets: null,
    hidden: null,
    history: INITIAL_HISTORY,
    bisect: null,
    palette: false,
    snapshotMode: false,
    patchOnly: false,
    tags: null,
    stashes: null,

    async openRepo(handle, opts = {}) {
      await get().closeRepo();
      const name =
        typeof handle === "object" &&
        handle !== null &&
        typeof (handle as { name?: unknown }).name === "string"
          ? (handle as { name: string }).name
          : "repository";
      refreshHooks?.stop();
      const startedAt = Date.now();
      set({
        screen: "loading",
        handle,
        repoId: opts.id ?? name,
        loading: initialLoading({
          step: "refs",
          startedAt,
          expectedMs: opts.expectedMs ?? null,
        }),
        error: null,
        warnings: [],
        dismissedWarnings: new Set(),
        diff: null,
        stats: {},
        statsLastAt: null,
        viewed: new Set(),
        filter: "",
        activeFileId: null,
        collapsed: new Set(),
        fileDiffs: new Lru(200),
        recentNotice: null,
      });
      for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          set((s) => ({
            loading: initialLoading({
              step: "refs",
              startedAt: s.loading.startedAt,
              expectedMs: s.loading.expectedMs,
              attempt,
            }),
          }));
        }
        try {
          const info = await client().open(handle, sink);
          let src = defaultDiffSource(info);
          let missingBranch: string | null = null;
          if (opts.lastTarget) {
            const t = findRef(info, opts.lastTarget);
            if (t) src = withRef(src, "target", t);
            else missingBranch = opts.lastTarget;
          }
          if (opts.lastSource) {
            const sref = findRef(info, opts.lastSource);
            if (sref) src = withRef(src, "source", sref);
            else missingBranch = opts.lastSource;
          }
          if (opts.skipWorktree) src = { ...src, includeWorktree: false };
          src = guardWorktree(src, info);
          set((s) => ({
            repo: info,
            diffSource: src,
            // Design §14.3: the operation banner is driven by `RepoInfo.operation`, which the
            // scheduler refreshes through `reloadRefs()` on every git-side tick.
            operation: info.operation,
            warnings: [...info.warnings],
            loading: {
              ...s.loading,
              phases: {
                ...s.loading.phases,
                refs: { ...(s.loading.phases.refs ?? { durationMs: 0 }), count: info.refs.length },
              },
            },
          }));
          await get().recompute("initial");
          if (get().screen === "loading") set({ screen: "repo" });
          if (get().screen === "repo") {
            refreshHooks?.start(handle);
            void persistence.touchRepo(get().repoId ?? "", {
              lastOpenMs: Date.now() - startedAt,
              lastSource: src.sourceRef,
              lastTarget: src.targetRef,
            });
            if (missingBranch) {
              const short = missingBranch.replace(/^refs\/(heads|remotes)\//, "");
              get().addToast({
                level: "info",
                message: `Branch ${short} no longer exists here; comparing ${src.target} … ${src.source}.`,
              });
            }
          }
          return;
        } catch (e) {
          const err = toUiError(e);
          if (err.code === "WORKER_CRASHED" && attempt < MAX_OPEN_ATTEMPTS) continue; // L5
          if (err.code === "CANCELLED" && get().screen !== "loading") return; // closed meanwhile
          const cur = get();
          if (cur.screen === "loading" && cur.loading.step && LOADING_INLINE_CODES.has(err.code)) {
            // L4: the failure stays on the phase it happened in
            set((s) => ({
              loading: { ...s.loading, failed: err, failedStep: s.loading.step },
              error: err,
            }));
            return;
          }
          set({ screen: "error", error: err });
          return;
        }
      }
    },

    async closeRepo() {
      refreshHooks?.stop();
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
        loading: initialLoading(),
        statsLastAt: null,
        // v2 shell: a new repository always starts on Files with nothing carried over.
        mode: "files",
        historyTab: "commits",
        cardModes: {},
        operation: null,
        reflog: null,
        conflicts: {},
        secrets: null,
        hidden: null,
        history: INITIAL_HISTORY,
        bisect: null,
        palette: false,
        snapshotMode: false,
        patchOnly: false,
        tags: null,
        stashes: null,
      });
      pickerSources = null;
    },

    setSource(refOrName) {
      const { repo } = get();
      if (!repo) return;
      const ref = typeof refOrName === "string" ? findRef(repo, refOrName) : refOrName;
      if (ref) get().setRevision(revisionOfRef(ref), "source");
    },

    setTarget(refOrName) {
      const { repo } = get();
      if (!repo) return;
      const ref = typeof refOrName === "string" ? findRef(repo, refOrName) : refOrName;
      if (ref) get().setRevision(revisionOfRef(ref), "target");
    },

    setRevision(rev, side) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const from = side === "target" ? revToSide(rev) : sideOf(diffSource, "target", repo);
      const to = side === "source" ? revToSide(rev) : sideOf(diffSource, "source", repo);
      applySides(from, to);
    },

    setSpecialSource(kind) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      if (repo.headOid === null) {
        get().addToast({ level: "warning", message: "This branch has no commits yet." });
        return;
      }
      const head: SideRev = {
        expr: "HEAD",
        display: repo.headDisplay,
        oid: repo.headOid,
        branchRef: "HEAD",
      };
      applySides(head, head, true);
      // `Staged only` is the staged layer of that comparison; `Working tree` undoes just that,
      // never a filter the user typed.
      if (kind === "staged") get().setFilter("layer:staged");
      else if (get().filter === "layer:staged") get().setFilter("");
    },

    setTwoDot(on) {
      get().setPref("twoDot", on);
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const already = diffSource.kind === "range" ? !diffSource.threeDot : false;
      if (already === on) return;
      applySides(sideOf(diffSource, "target", repo), sideOf(diffSource, "source", repo));
    },

    resolveRevision(expr) {
      return client().resolveRevision(expr);
    },

    async loadPickerSources() {
      if (!get().repo) return;
      if (pickerSources) {
        await pickerSources;
        return;
      }
      pickerSources = (async () => {
        try {
          // One in-flight call per method (T4.1), so the two listings go one after the other.
          const tags = await client().listTags();
          const stashes = await client().listStashes();
          set({ tags, stashes });
        } catch (e) {
          // Not fatal: the picker keeps its branch groups and says the others are empty.
          ignoreStale(e);
          set((s) => ({ tags: s.tags ?? [], stashes: s.stashes ?? [] }));
        }
      })();
      await pickerSources;
    },

    async applyCompare(spec) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      try {
        const to = await client().resolveRevision(spec.to);
        const from = await client().resolveRevision(spec.from);
        // The link carries the dot mode, so `#compare=a..b` really shows a two-dot diff.
        get().setPref("twoDot", !spec.threeDot);
        applySides(revToSide(from), revToSide(to));
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "STALE" || err.code === "CANCELLED") return;
        get().addToast({
          level: "warning",
          message: `Cannot compare ${spec.from} … ${spec.to}: ${err.message} Showing ${labelOf(diffSource)} instead.`,
        });
      }
    },

    swapBranches() {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const from = sideOf(diffSource, "source", repo);
      const to = sideOf(diffSource, "target", repo);
      if (from.expr === to.expr) return;
      applySides(from, to);
    },

    setIncludeWorktree(on) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      if (on && !isWorktreeSource(diffSource, repo)) return;
      if (diffSource.includeWorktree === on) return;
      set({ diffSource: { ...diffSource, includeWorktree: on } });
      get().requestRefresh("branch-change");
    },

    async debugMetrics() {
      const c = client();
      let engine: EngineMetrics | null = null;
      if (get().repo) {
        try {
          engine = await c.metrics();
        } catch {
          engine = null; // no session / worker restarting: the panel shows dashes
        }
      }
      return { engine, client: c.clientMetrics() };
    },

    requestRefresh(reason, paths) {
      if (refreshHooks) refreshHooks.request(reason, paths);
      else void get().recompute(reason);
    },

    async recompute(_reason) {
      const { diffSource, repo } = get();
      if (!diffSource || !repo) return;
      const startedAt = performance.now();
      performance.mark?.("diffgit:compute-start");
      set((s) => ({
        refresh: { ...s.refresh, busy: true, phase: s.refresh.phase ?? null },
        perf: { ...s.perf, computeStartedAt: startedAt },
      }));
      try {
        const result = await client().computeDiff(diffSource);
        performance.mark?.("diffgit:compute-result");
        const current = get();
        // a newer compute may have started meanwhile; comlink resolves in order, but be defensive
        if (current.diff && result.generation < current.diff.generation) return;
        const stats: Record<string, FileStats> = {};
        for (const f of result.files) if (f.stats) stats[f.id] = f.stats;
        const keys = result.files.map((f) => viewedKey(current.repoId ?? "", result.source, f));
        const viewed = await persistence.loadViewed(keys);
        // batches streamed before this point were parked by the sink
        Object.assign(stats, pendingStats.get(result.generation));
        for (const g of pendingStats.keys()) if (g <= result.generation) pendingStats.delete(g);
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
        const complete = result.files.every((f) => stats[f.id] !== undefined);
        set((s) => ({
          diff: result,
          stats,
          statsLastAt: complete ? null : Date.now(),
          viewed,
          activeFileId,
          collapsed,
          warnings: merged,
          fileDiffs: new Lru(200),
          conflicts: {},
          screen: s.screen === "loading" || s.screen === "repo" ? "repo" : s.screen,
          refresh: {
            ...s.refresh,
            busy: false,
            lastAt: Date.now(),
            lastError: null,
            restarted: false,
            phase: null,
          },
          announcement: `Diff updated: ${result.files.length} ${result.files.length === 1 ? "file" : "files"}`,
          announcementSeq: s.announcementSeq + 1,
          perf: { ...s.perf, lastComputeMs: performance.now() - startedAt, computeStartedAt: null },
        }));
        performance.mark?.("diffgit:compute-committed");
        // T11.3: the sidebar prints git's real XY (UU / AA / UD / DU / DD), which only the payload
        // knows, so the conflicted rows — never many — are fetched as soon as the diff lands.
        const conflicted = result.files
          .filter((f) => f.layers.includes("conflict"))
          .slice(0, CONFLICT_PRELOAD_LIMIT);
        for (const f of conflicted) void get().loadConflict(f.id);
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "CANCELLED" || err.code === "STALE" || err.code === "WORKER_CRASHED") {
          // superseded, or the worker died: the restart listener toasts and recomputes (T7.5 review)
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
          action: { label: "Retry", onClick: () => get().requestRefresh("manual") },
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
        if (
          err.code === "STALE" ||
          err.code === "CANCELLED" ||
          err.code === "WORKER_CRASHED" ||
          controller.signal.aborted
        ) {
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

    async loadConflict(id) {
      const s = get();
      if (!s.diff) return;
      const existing = s.conflicts[id];
      if (existing && existing.status !== "error") return;
      const generation = s.diff.generation;
      set((cur) => ({ conflicts: { ...cur.conflicts, [id]: { status: "loading" } } }));
      try {
        const data = await client().conflict(generation, id);
        const cur = get();
        if (!cur.diff || cur.diff.generation !== generation) return;
        set((c) => ({ conflicts: { ...c.conflicts, [id]: { status: "ready", data } } }));
      } catch (e) {
        const err = toUiError(e);
        const cur = get();
        if (err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED") {
          if (cur.conflicts[id]?.status === "loading") {
            const { [id]: _dropped, ...rest } = cur.conflicts;
            set({ conflicts: rest });
          }
          return;
        }
        set((c) => ({ conflicts: { ...c.conflicts, [id]: { status: "error", error: err } } }));
      }
    },

    async loadReflog() {
      if (!get().repo) return;
      try {
        const entries = await client().reflog("HEAD", REFLOG_LIMIT);
        if (!get().repo) return;
        set({ reflog: entries });
        // T10.5 ships `markReachable`; until then every row's `reachable` stays null and the
        // `unreachable` badge is simply not rendered (feature check, never a guess).
        const withReach = client() as WorkerClient & MaybeReachable;
        if (typeof withReach.markReachable !== "function") return;
        for (let i = 0; i < entries.length; i += REACHABLE_BATCH) {
          const batch = entries.slice(i, i + REACHABLE_BATCH);
          const map = await withReach.markReachable(batch.map((e) => e.newOid));
          const cur = get().reflog;
          if (cur === null) return;
          set({
            reflog: cur.map((e) =>
              map[e.newOid] === undefined ? e : { ...e, reachable: map[e.newOid] as boolean },
            ),
          });
        }
      } catch (e) {
        // A repository that keeps no reflog answers `[]` plus a NO_REFLOG warning (T10.2); a real
        // failure leaves the list empty and says so through the usual warning banner.
        ignoreStale(e);
        if (get().reflog === null) set({ reflog: [] });
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

    setViewed(ids, nowViewed) {
      const s = get();
      if (!s.diff) return;
      const byId = new Map(s.diff.files.map((f) => [f.id, f]));
      const viewed = new Set(s.viewed);
      const collapsed = new Set(s.collapsed);
      const keys: string[] = [];
      for (const id of ids) {
        const file = byId.get(id);
        if (!file) continue;
        const key = viewedKey(s.repoId ?? "", s.diff.source, file);
        if (nowViewed) {
          viewed.add(key);
          collapsed.add(id);
        } else {
          viewed.delete(key);
          collapsed.delete(id);
        }
        keys.push(key);
      }
      if (keys.length === 0) return;
      set({ viewed, collapsed });
      for (const key of keys) void persistence.saveViewed(key, nowViewed);
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

    setRecentNotice(notice) {
      set({ recentNotice: notice });
    },

    setStorageUnavailable(on) {
      set({ storageUnavailable: on });
    },

    setGateCause(cause) {
      set({ gateCause: cause });
    },

    setMode(mode) {
      if (get().mode === mode) return;
      set({ mode, palette: false });
    },

    setPalette(open) {
      set({ palette: open });
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
  const match = makeFileFilter(s.filter);
  const result = s.filter.trim() === "" ? files : files.filter(match);
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

/** Stats-row breakdowns (S1): per-status and per-layer counts over the given files. */
export interface Breakdown {
  status: { M: number; A: number; D: number; R: number; T: number };
  layers: { staged: number; unstaged: number; untracked: number; conflict: number };
}
export function breakdownOf(files: readonly FileDiff[]): Breakdown {
  const b: Breakdown = {
    status: { M: 0, A: 0, D: 0, R: 0, T: 0 },
    layers: { staged: 0, unstaged: 0, untracked: 0, conflict: 0 },
  };
  for (const f of files) {
    switch (f.status) {
      case "modified":
        b.status.M++;
        break;
      case "added":
        b.status.A++;
        break;
      case "deleted":
        b.status.D++;
        break;
      case "renamed":
      case "copied":
        b.status.R++;
        break;
      case "typechange":
        b.status.T++;
        break;
    }
    for (const l of f.layers) if (l !== "committed") b.layers[l]++;
  }
  return b;
}

/**
 * How far the streamed stats are (S2/S3/S8): `counted` files have stats, `pending` are still
 * streaming, `notCounted` splits the files that will never get a `+n −m`.
 */
export interface StatsProgress {
  total: number;
  counted: number;
  pending: number;
  notCounted: { tooLarge: number; binary: number; failed: number };
  complete: boolean;
}
export function statsProgressOf(
  files: readonly FileDiff[],
  stats: Record<string, FileStats>,
  failed: ReadonlySet<string>,
): StatsProgress {
  const p: StatsProgress = {
    total: files.length,
    counted: 0,
    pending: 0,
    notCounted: { tooLarge: 0, binary: 0, failed: 0 },
    complete: true,
  };
  for (const f of files) {
    if (failed.has(f.id)) p.notCounted.failed++;
    else if (f.binary) p.notCounted.binary++;
    else if (f.tooLarge) p.notCounted.tooLarge++;
    else {
      const st = stats[f.id] ?? f.stats;
      if (st) p.counted++;
      else {
        p.pending++;
        p.complete = false;
      }
    }
  }
  return p;
}

/** Files whose per-file diff request failed (the red "retry" mark in S3). */
export function selectFailedFiles(
  s: Pick<StoreState, "diff" | "fileDiffs" | "prefs">,
): Set<string> {
  const out = new Set<string>();
  for (const f of s.diff?.files ?? []) {
    if (s.fileDiffs.peek(cacheKey(f.id, s.prefs.ignoreWhitespace))?.status === "error")
      out.add(f.id);
  }
  return out;
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

/**
 * What is being compared, in one string: `v2.3.0 … stash@{0}` (three-dot) or `main .. feature`
 * (two-dot). The StatsRow prints it for a range — a branch pair is already spelled out by the two
 * pickers, and Design §14 rule 1 keeps the bars looking like v1 while nothing unusual is going on.
 */
export function selectSourceLabel(s: Pick<StoreState, "diffSource">): string {
  return s.diffSource ? labelOf(s.diffSource) : "";
}

let treeCache: { files: FileDiff[]; result: TreeNode[] } | null = null;
export function selectTreeModel(s: Pick<StoreState, "diff" | "filter">): TreeNode[] {
  const files = selectVisibleFiles(s);
  if (treeCache && treeCache.files === files) return treeCache.result;
  const result = buildTree(files);
  treeCache = { files, result };
  return result;
}

const NO_FILES: readonly FileDiff[] = [];

/** D2: grouping is possible only when some file touches a layer other than `committed`. */
export function selectHasLayers(s: Pick<StoreState, "diff">): boolean {
  for (const f of s.diff?.files ?? NO_FILES) {
    if (f.layers.some((l) => l !== "committed")) return true;
  }
  return false;
}

let groupedCache: { files: FileDiff[]; result: FileGroup[] } | null = null;
export function selectGroupedModel(s: Pick<StoreState, "diff" | "filter">): FileGroup[] {
  const files = selectVisibleFiles(s);
  if (groupedCache && groupedCache.files === files) return groupedCache.result;
  const result = groupFiles(files);
  groupedCache = { files, result };
  return result;
}

/** D5: counts over the *unfiltered* diff, so a header can read `k of n` while filtering. */
let groupTotalsCache: {
  files: readonly FileDiff[];
  result: Record<SidebarGroupId, number>;
} | null = null;
export function selectGroupTotals(s: Pick<StoreState, "diff">): Record<SidebarGroupId, number> {
  const files = s.diff?.files ?? NO_FILES;
  if (groupTotalsCache && groupTotalsCache.files === files) return groupTotalsCache.result;
  const result = Object.fromEntries(GROUP_ORDER.map((id) => [id, 0])) as Record<
    SidebarGroupId,
    number
  >;
  for (const f of files) result[groupOf(f)]++;
  groupTotalsCache = { files, result };
  return result;
}

export function selectFileDiff(
  s: Pick<StoreState, "fileDiffs" | "prefs">,
  id: string,
): FileDiffEntry | undefined {
  return s.fileDiffs.peek(cacheKey(id, s.prefs.ignoreWhitespace));
}

/** T11.3: the kind of a conflicted file once its payload is in, so `layerCode` can print git's XY. */
export function selectConflictKind(
  s: Pick<StoreState, "conflicts">,
  id: string,
): ConflictKind | undefined {
  const entry = s.conflicts[id];
  return entry?.status === "ready" ? entry.data.kind : undefined;
}

/** File id → conflict kind for every payload that has arrived (shallow-compared by the sidebar). */
export function selectConflictKinds(
  s: Pick<StoreState, "conflicts">,
): Record<string, ConflictKind> {
  const out: Record<string, ConflictKind> = {};
  for (const [id, entry] of Object.entries(s.conflicts))
    if (entry.status === "ready") out[id] = entry.data.kind;
  return out;
}
