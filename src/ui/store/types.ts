import type {
  ConflictPayload,
  EngineMetrics,
  FileDiffPayload,
  FileStats,
  ProgressPhase,
} from "../../engine/api";
import type { WarningCode } from "../../engine/errors";
import type {
  BlamePayload,
  BranchRow,
  CommitDetails,
  CommitSummary,
  DiffResult,
  DiffSource,
  HiddenEntry,
  InsightsResult,
  Oid,
  PathExplanation,
  PathHistoryEntry,
  PreflightResult,
  ReflogEntry,
  RepoInfo,
  RepoOperation,
  RepoRef,
  RepoSummary,
  RepoWarning,
  ResolvedRevision,
  SearchResult,
  SecretFinding,
  StashInfo,
  SubmoduleInfo,
  TagInfo,
  WorktreeInfo,
} from "../../engine/types";
import type { BisectAction, BisectSlice } from "../bisect";
import type { BranchCells, BranchFilter } from "../branches";
import type { CompareSpec } from "../compareHash";
import type { DashboardRepo } from "../dashboard";
import type { UiError } from "../errors";
import type { ExportKind } from "../export/exportModel";
import type { Lru } from "../lru";
import { PICKAXE_COMMITS, type SearchScope } from "../search";
import type { ClientMetrics } from "../workerClient";

export type { ClientMetrics } from "../workerClient";

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
/** `markReachable` is called in batches of this size (T11.3; T10.5 ships the method). */
export const REACHABLE_BATCH = 50;

/**
 * T10.8 ships `search`; until then the client simply does not have it, so the History search box
 * says the list loads more as you scroll instead of guessing. Feature check, not a contract change.
 */
export type MaybeSearch = {
  search?(req: {
    scope: "commits";
    query: string;
    limit: number;
  }): Promise<{ hits: { oid?: Oid }[] }>;
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

/** History-mode state (Design §14.5). */
export interface HistoryState {
  commits: CommitSummary[];
  cursor: string | null;
  loading: boolean;
  selected: Oid | null;
  rangeStart: Oid | null;
  query: string;
  firstParent: boolean;
  all: boolean;
  capped: boolean;
  /**
   * T10.5b will add `WalkPage.laneOverflow`: the graph needed more lanes than the column can show.
   * The header then offers the `first-parent` toggle and nothing else (atlas tab 03 risk row).
   */
  laneOverflow: boolean;
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
  laneOverflow: false,
};

/** T11.5: the CommitCard payload of one commit, keyed by oid in `commitDetails`. */
export type CommitDetailsEntry =
  | { status: "loading" }
  | { status: "ready"; data: CommitDetails }
  | { status: "error"; error: UiError };

/**
 * The Stack sub-tab (Design §14.5): the commits compare has since the merge base, newest first.
 * `tip` / `label` are the branch pair the list was computed for, so picking a commit — which turns
 * the source into a range — never makes the stack recompute itself into "the stack of one commit".
 */
export interface StackState {
  commits: CommitSummary[];
  /** Merge base the walk stopped at; null when the pair has none (unrelated histories). */
  base: Oid | null;
  /** Compare-side expression the walk started from, and the `base … compare` label to print. */
  tip: string | null;
  label: string;
  loading: boolean;
  /** False until a walk for the current branch pair has finished (a picker change resets it). */
  ready: boolean;
  /** The walk stopped at `STACK_LIMIT` without reaching the merge base. */
  capped: boolean;
}

export const INITIAL_STACK: StackState = {
  commits: [],
  base: null,
  tip: null,
  label: "",
  loading: false,
  ready: false,
  capped: false,
};

/**
 * T11.6: one blame, keyed by `blameCacheKey(oid, path, -w)`. `maxRevisions` is what the answer was
 * asked for, so `Continue` can tell "capped at 200" from "already re-asked for 600".
 */
export type BlameEntry =
  | { status: "loading" }
  | { status: "ready"; data: BlamePayload; maxRevisions: number }
  | { status: "error"; error: UiError };

/** T11.6: one file history, keyed by `pathHistoryCacheKey(oid, path, follow)`. */
export interface PathHistoryState {
  entries: PathHistoryEntry[];
  /** Opaque continuation token; null = the whole history is listed. */
  cursor: string | null;
  loading: boolean;
  error: UiError | null;
}

export const INITIAL_PATH_HISTORY: PathHistoryState = {
  entries: [],
  cursor: null,
  loading: false,
  error: null,
};

/** What `blame` / `pathHistory` are asked at: the compare side, or an explicit commit. */
export interface BlameTarget {
  /** Revision expression handed to the engine (a full ref name, `HEAD`, or an oid). */
  ref: string;
  /** The commit it resolves to — the immutable half of every cache key. */
  oid: Oid;
  /** True only when the working tree is part of the comparison *and* no commit was pinned. */
  includeWorktree: boolean;
}

/**
 * Branches-mode state (T11.7, Design §14.6). `rows` is `branchOverview()` — one row per ref with
 * the expensive cells left null — and `cells` is what `branchCells()` has filled in since, keyed
 * by full ref name, so the table can show every row immediately and let the counts arrive.
 */
export interface BranchesState {
  rows: BranchRow[] | null;
  loading: boolean;
  error: UiError | null;
  cells: Record<string, BranchCells>;
  filter: BranchFilter;
  query: string;
}

export const INITIAL_BRANCHES: BranchesState = {
  rows: null,
  loading: false,
  error: null,
  cells: {},
  filter: "active",
  query: "",
};

/**
 * T11.8 — the one search the palette is showing (Design §14.1: the palette is where the scopes
 * live). It is deliberately a single slot rather than a cache per scope: the palette shows one
 * scope at a time, a newer query supersedes the one before it, and `Escape` throws the answer away.
 * `scope === null` means nothing has been asked for the current input.
 */
export interface SearchState {
  scope: SearchScope | null;
  /** The query as it was sent to the engine (trimmed), not what is currently in the box. */
  query: string;
  regex: boolean;
  /** `SearchRequest.path`: the path part of the file filter when the search ran; null = whole repo. */
  path: string | null;
  /** `SearchRequest.commits` for the pickaxe scope; `Widen ×5` multiplies it. */
  commits: number;
  loading: boolean;
  result: SearchResult | null;
  /** A refused query (an empty, over-long or uncompilable pattern is `INTERNAL` plus a hint). */
  error: UiError | null;
}

export const INITIAL_SEARCH: SearchState = {
  scope: null,
  query: "",
  regex: false,
  path: null,
  commits: PICKAXE_COMMITS,
  loading: false,
  result: null,
  error: null,
};

/**
 * Insights-mode state (T11.12, Design §14.6). One `InsightsResult` at a time: the page asks for
 * the tip it is looking at and the period the chips are on, and `tip` + `period` say which question
 * `result` is the answer to, so a chip switch or a new commit is visibly a different answer rather
 * than a silent one. `cached` means the answer came out of `diffgit-derived` instead of the engine,
 * and `walked` is the live progress the skeleton counts up while the walk runs.
 */
export interface InsightsState {
  result: InsightsResult | null;
  loading: boolean;
  error: UiError | null;
  tip: Oid | null;
  period: InsightsPeriod | null;
  cached: boolean;
  walked: number;
}

export const INITIAL_INSIGHTS: InsightsState = {
  result: null,
  loading: false,
  error: null,
  tip: null,
  period: null,
  cached: false,
  walked: 0,
};

/**
 * Rebase-preflight state (T11.13, Design §14.6). One report at a time, because the panel shows
 * one: `branch` / `onto` say which question `result` answers, so a second `Preflight rebase onto …`
 * visibly replaces the first instead of leaving the old table under a new title. `branch !== null`
 * is what "the panel is open" means — there is no second `open` flag to keep in step with it.
 */
export interface PreflightState {
  branch: string | null;
  onto: string | null;
  result: PreflightResult | null;
  loading: boolean;
  error: UiError | null;
}

/**
 * Home dashboard state (T11.11, Design §14.6). One entry per **stored** repository, keyed by its
 * `StoredRepo.id` — this slice belongs to Home, not to an open repository, which is why nothing
 * here is cleared by `closeRepo` (only the sweep is stopped: a summary read a minute ago is still
 * the right thing to show while the next one is being read).
 *
 * `summary` is whatever the card can show right now — the value from `diffgit-derived`, then the
 * fresh one — and `mtime` is what the last cheap stat of `.git/index` saw, so `isStale(entry)` can
 * say the working tree has moved on since. `error` is the last failure of *this card's* summary
 * (`PERMISSION`, `HANDLE_GONE`, …) and never a screen or a toast: one repository the dashboard
 * cannot read must not take the page down with it.
 */
export interface DashboardEntry {
  summary: RepoSummary | null;
  mtime: number | null;
  loading: boolean;
  error: UiError | null;
}

export const INITIAL_PREFLIGHT: PreflightState = {
  branch: null,
  onto: null,
  result: null,
  loading: false,
  error: null,
};

/**
 * T11.14: the open `.patch` / `.diff` file (Design §14.6, atlas tab 17). `patchOnly` above stays
 * the flag every surface branches on; this is what that session is made of. There is no repository
 * behind it: no handle, no refresh, no File System Access API — the text arrived through a drop, a
 * file input or the manifest's file handler, and `parsePatch` turned it into ordinary diff rows.
 */
export interface PatchSessionState {
  /** The file's name, for the StatsRow's `Patch · <name>` tag. */
  name: string;
  /** The text exactly as it was opened; the Export menu re-emits these bytes. */
  text: string;
  /** A file is being read or parsed. */
  loading: boolean;
  /** `NOT_A_PATCH` (with its `line <n>:` detail) or a size refusal, printed inline where it came from. */
  error: UiError | null;
}

export const INITIAL_PATCH_SESSION: PatchSessionState = {
  name: "",
  text: "",
  loading: false,
  error: null,
};

/**
 * T11.15: the banner that says this repository cannot refresh itself. It is not an engine warning —
 * the engine cannot tell a snapshot from a handle — so the store adds it to `warnings` on open and
 * `WarningBanners` renders it from `WARNING_COPY` like every other code.
 */
export const SNAPSHOT_WARNING: RepoWarning = {
  code: "SNAPSHOT_MODE",
  message:
    "This browser can only read the folder once, so the diff cannot refresh itself. Re-open the folder to see newer changes.",
};

/** T11.10: one export the user asked for. `ids` is `patchText`'s second argument verbatim. */
export interface ExportRequest {
  kind: ExportKind;
  /** File ids to render; `null`/absent = the whole comparison (contracts `<!-- T10.10 -->`). */
  ids?: string[] | null;
  /** The commit a `commit-patch` names itself after. */
  oid?: Oid;
}

/**
 * T11.10: the Export menu's state (Design §14.6, atlas tab 12). Opening the menu renders the patch
 * once — that is where the sizes come from, and the items stay disabled until it is `ready` — and
 * the snapshot is built from the same bytes, so a menu that shows a size can always save it.
 */
export interface ExportState {
  /** The menu in the StatsRow (key `e`). */
  open: boolean;
  status: "idle" | "preparing" | "ready" | "failed";
  /** The generation `patch` belongs to; a recompute makes it stale and it is prepared again. */
  generation: number | null;
  /** The ids `patch` covers: `null` is the whole comparison, an array is the current filter. */
  ids: string[] | null;
  patch: string;
  snapshot: string;
  /** Why the preparation failed, for the menu's one-line message. */
  error: string | null;
  /** A request stopped at the secret gate, waiting for `Export anyway` / `Cancel`. */
  pending: ExportRequest | null;
  /** The generation the user has already said "export anyway" for; reset by every recompute. */
  confirmed: number | null;
  /** An export in flight, so a second click cannot start a second one. */
  busy: ExportKind | null;
}

export const INITIAL_EXPORT: ExportState = {
  open: false,
  status: "idle",
  generation: null,
  ids: null,
  patch: "",
  snapshot: "",
  error: null,
  pending: null,
  confirmed: null,
  busy: null,
};

export interface DashboardState {
  summaries: Record<string, DashboardEntry>;
}

export const EMPTY_DASHBOARD_ENTRY: DashboardEntry = {
  summary: null,
  mtime: null,
  loading: false,
  error: null,
};
export const INITIAL_DASHBOARD: DashboardState = { summaries: {} };

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
  /** T11.6: `blame()` answers, keyed by `blameCacheKey(oid, path, -w)`. */
  blames: Record<string, BlameEntry>;
  /** T11.6: `pathHistory()` pages, keyed by `pathHistoryCacheKey(oid, path, follow)`. */
  pathHistories: Record<string, PathHistoryState>;
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
  /**
   * Secret-scan findings for the current diff (T11.9, Design §14.3); null = not scanned yet.
   * Reset to null by every compute and filled by `scanSecrets()` once the stats of that diff are
   * in; `[]` is a real answer ("scanned, nothing found") and is what a committed-only diff gets
   * without the engine being asked at all.
   */
  secrets: SecretFinding[] | null;
  /**
   * The sidebar's Hidden group (T11.4, Design §14.4); null = not listed. Filled lazily the first
   * time `showHidden` turns on and refreshed after every recompute while it stays on; cleared back
   * to null when the toggle goes off, so nothing pays for a listing nobody is looking at.
   */
  hidden: HiddenEntry[] | null;
  history: HistoryState;
  /** T11.5: `commitDetails(oid)` per commit the CommitCard has shown, kept for the session. */
  commitDetails: Record<Oid, CommitDetailsEntry>;
  /** T11.5: `+n −m` per commit against its first parent; `null` = the engine could not count it. */
  commitStats: Record<Oid, CommitDetails["stats"]>;
  /** T11.5: the Stack sub-tab's commits for the current branch pair. */
  stack: StackState;
  /**
   * T11.5: the base picker's side as long as it was a plain ref. Picking a commit turns the source
   * into `parent…commit`, so the *base* the CommitCard's `Compare with base…` means is the branch
   * the user chose, not the parent the last click put there.
   */
  compareBase: { expr: string; display: string } | null;
  /**
   * Running bisect (T11.13, Design §14.5): the contract's `BisectState & BisectStep` plus the
   * strip's own `picking` / `loading` / `error` (`src/ui/bisect.ts`). Null = no bisect. It lives
   * in the store, so it survives every mode switch, and in `diffgit-derived` per repository.
   */
  bisect: BisectSlice | null;
  /** Command palette open (Design §14.1). */
  palette: boolean;
  /** Firefox/Safari read-once mode: the folder was read once and cannot refresh (T11.15). */
  snapshotMode: boolean;
  /** T11.15: when that one read happened (epoch ms) — the StatsRow tag's "read at 14:02". */
  snapshotReadAt: number | null;
  /** A `.patch` / `.diff` file is open, not a repository (T11.14). */
  patchOnly: boolean;
  /** What that patch file is: its name, its text, and why it could not be opened (T11.14). */
  patchSession: PatchSessionState;
  /** Tags for the picker's `Tags` group; null = not listed yet (T11.2, lazy on first open). */
  tags: TagInfo[] | null;
  /** Stashes for the picker's `Stashes` group; null = not listed yet (T11.2). */
  stashes: StashInfo[] | null;
  /**
   * T11.16 (atlas tab 19). Both lists are read once per repository, lazily: `submodules` when the
   * first gitlink card mounts, `worktrees` when the dialog is opened. `null` = not listed yet;
   * `[]` is a real answer (a repository with no submodules), and the two are different things.
   */
  submodules: SubmoduleInfo[] | null;
  worktrees: WorktreeInfo[] | null;
  /** The `Worktrees` dialog the palette action and the repo-name button open (Design §14.1). */
  worktreesOpen: boolean;
  /** Branches mode (T11.7, Design §14.6). */
  branches: BranchesState;
  /** The palette's search scopes (T11.8, Design §14.1 rule 2, atlas tab 05). */
  search: SearchState;
  /** Insights mode (T11.12, Design §14.6). */
  insights: InsightsState;
  /** The rebase-preflight report, which replaces the Branches table while it is open (T11.13). */
  preflight: PreflightState;
  /** The Export menu (T11.10, Design §14.6): what it has prepared and what the gate is holding. */
  export: ExportState;
  /** Home's repository cards (T11.11): one summary per stored repository, keyed by `StoredRepo.id`. */
  dashboard: DashboardState;

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
  /** T11.16: `listSubmodules()` once per repository; the gitlink card calls it when it mounts. */
  loadSubmodules(): Promise<void>;
  /** T11.16: `listWorktrees()` once per repository; the Worktrees dialog calls it when it opens. */
  loadWorktrees(): Promise<void>;
  /** T11.16: opens or closes the Worktrees dialog (palette action, repo-name button). */
  setWorktreesOpen(open: boolean): void;
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
  /** T11.4: the opt-in `listHidden()` walk behind the "Show hidden files" toggle. */
  loadHidden(): Promise<void>;
  /** T11.4: why one path is not in the diff — the WhyHidden popover's only engine call. */
  explainPath(path: string): Promise<PathExplanation>;
  /**
   * Re-opens the current folder with the current preferences. `builtinExcludes` is an `open()`
   * option (backlog B10), so changing it has to rebuild the session; the compare pair survives.
   */
  reopenSession(): Promise<void>;
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
  /** T11.6: which of `Diff | Blame | History` this card's body shows (Design §14.1). */
  setCardMode(id: string, mode: CardMode): void;
  /**
   * T11.6: blame one path at `opts.at` (a commit) or, with `at: null`, at the compare side.
   * Memoised per key in `blames` and, while the answer does not contain the working tree, in the
   * `diffgit-derived` IndexedDB store. A `STALE` / `CANCELLED` rejection is dropped silently.
   */
  loadBlame(
    path: string,
    opts: { at: Oid | null; ignoreWhitespace: boolean; maxRevisions?: number },
  ): Promise<void>;
  /** T11.6: one page of `pathHistory`; `more` appends the next page instead of starting over. */
  loadPathHistory(
    path: string,
    opts: { at: Oid | null; follow: boolean; more?: boolean },
  ): Promise<void>;

  // ---- History mode (T11.5, Design §14.5) ----
  /** `Commits | Stack | Reflog` in the History sidebar. */
  setHistoryTab(tab: HistoryTab): void;
  /**
   * One `walkCommits` page. `reset` throws the list away and walks from the tip again (the
   * `first-parent` / `all branches` toggles); otherwise it appends the page after `cursor` and is
   * a no-op once the walk is exhausted or one is already in flight.
   */
  loadHistory(reset?: boolean): Promise<void>;
  /** The search box; filters the commits already walked (Design §14.5). */
  setHistoryQuery(query: string): void;
  /** The two toggles under the search box; either one re-walks from the tip. */
  setHistoryOption(key: "firstParent" | "all", on: boolean): void;
  /**
   * Shows one commit: the source becomes `parent…commit` (a root commit against the empty tree).
   * `extend` (Shift-click) keeps the earlier selection as the other end and shows `older…newer`.
   */
  showCommit(oid: Oid, opts?: { extend?: boolean }): Promise<void>;
  /** The CommitCard payload; cached per oid for the session. */
  loadCommitDetails(oid: Oid): Promise<void>;
  /** `+n −m` for the rows that are on screen, batched and serialised (one call in flight). */
  requestCommitStats(oids: Oid[]): void;
  /**
   * Design §14.5: Enter with no local match. T10.8 owns `search`, so until it ships this answers
   * `null` and the list says it loads more as you scroll — never a guess.
   */
  searchCommits(query: string): Promise<Oid[] | null>;
  /** The Stack sub-tab: compare's commits since the merge base, newest first. */
  loadStack(): Promise<void>;
  /** CommitCard action `Compare with base…`: the range `base…commit` (Design §14.5). */
  compareCommitWithBase(oid: Oid): void;

  // ---- Branches mode (T11.7, Design §14.6) ----
  /** `branchOverview()`, once per repository; the cells stay null until `requestBranchCells`. */
  loadBranches(): Promise<void>;
  /**
   * Fills the ahead/behind cells of the rows the table is showing, `BRANCH_CELL_BATCH` (50) at a
   * time. `branchCells` is single-in-flight in the engine, so the names queue here and one drain
   * loop serialises the batches — exactly as `requestCommitStats` does for the commit list.
   */
  requestBranchCells(fullNames: string[]): void;
  /** The `Active | Stale > 90 d | Tags` control and the search box of Design §14.6. */
  setBranchFilter(filter: BranchFilter): void;
  setBranchQuery(query: string): void;
  /** Clicking a row: walk that branch in History mode (Design §14.5 "the pickers … compare"). */
  showBranchHistory(fullName: string): void;
  /** Row action `Compare with <base>`: the base branch … this branch, in Files mode. */
  compareBranchWithBase(fullName: string): void;
  /** Tags table action `Compare with previous tag`: the range `prev…this`, in Files mode. */
  compareTags(previous: TagInfo, tag: TagInfo): void;
  // ---- Secret scan (T11.9, Design §14.3) ----
  /**
   * Scans the added lines of the staged and unstaged hunks of the current diff and fills
   * `secrets`. Called by `recompute` once that diff's stats are in, and by the palette's
   * `Re-scan for secrets`, which passes `announce` so the outcome is toasted (a re-scan that finds
   * nothing has to say so — a silent no-op reads like a broken button). A diff with no uncommitted
   * layer never reaches the engine: it answers `[]` directly. `STALE` / `CANCELLED` are ignored.
   */
  scanSecrets(opts?: { announce?: boolean }): Promise<void>;

  // ---- Search scopes in the palette (T11.8, Design §14.1, atlas tab 05) ----
  /**
   * Runs one `search(req)` and parks the answer in `search`. The path is taken from the **path
   * part** of the current file filter (`status:` / `layer:` tokens are meaningless to the engine's
   * path scope), `commits` is only sent for the pickaxe scope — where the contract makes it
   * mandatory — and `limit` is always `SEARCH_HIT_LIMIT`.
   *
   * One search is in flight at a time: every call takes a ticket, and an answer whose ticket is no
   * longer the current one is dropped, so a newer query always wins and `STALE` / `CANCELLED` from
   * the superseded call go through `ignoreStale` instead of reaching the palette.
   */
  runSearch(req: {
    scope: SearchScope;
    query: string;
    regex: boolean;
    commits?: number;
  }): Promise<void>;
  /** `Widen ×5`: the same pickaxe query over five times the range, up to `PICKAXE_COMMITS_MAX`. */
  widenSearch(): Promise<void>;
  /** `Escape` on a running search, and every close of the palette: forget it and stop listening. */
  cancelSearch(): void;
  // ---- Insights mode (T11.12, Design §14.6) ----
  /**
   * Activity, contributors and hotspots for the current tip and `prefs.insightsPeriod`. Answered
   * from `diffgit-derived` (`insights:<repoId>:<tipOid>:<period>`) when that key is there and from
   * one `insights()` walk otherwise; a repository with no commits is answered without the engine.
   * A no-op while the slice already holds this tip + period, so the page may call it on every
   * render. `force` skips both caches (the palette's `Clear cache` and a manual refresh).
   * `STALE` / `CANCELLED` drop silently, as everywhere else.
   */
  loadInsights(opts?: { force?: boolean }): Promise<void>;
  /** The header's `90 d | 1 y | All` chips: writes the pref and re-asks (Design §14.6). */
  setInsightsPeriod(period: InsightsPeriod): void;
  /** Clicking a hotspot: filter Files mode down to that path (T11.12 Deliverables). */
  showHotspot(path: string): void;

  // ---- Bisect and rebase preflight (T11.13, Design §14.5 / §14.6) ------------------------------
  /**
   * Starts a bisect. With no argument it is the palette's `Start bisect…`: the strip becomes the
   * two-step prompt of Design §14.5 and the next two clicks in the commit list are the good and
   * the bad end. With both ends given it arms straight away and asks for the first midpoint.
   * Nothing is written: `git bisect` is never run (D16), only `bisectStep` is asked.
   */
  startBisect(ends?: { good: Oid; bad: Oid }): Promise<void>;
  /**
   * Marks one commit `good` / `bad` / `skip` — the strip's buttons, the `g` / `x` keys and the
   * CommitCard menu all land here. `oid` defaults to the commit under test. A mark made while no
   * bisect runs starts one and asks for the other end; otherwise the marks go to `bisectStep` and
   * the candidate it answers with is selected in the list.
   */
  markBisect(mark: BisectAction, oid?: Oid): Promise<void>;
  /** `Stop`: forgets the marks here and in `diffgit-derived`. The repository is untouched. */
  stopBisect(): Promise<void>;
  /** Reads the marks this repository was left bisecting with and re-asks for the midpoint. */
  restoreBisect(): Promise<void>;
  /**
   * `rebasePreflight(branch, onto)` for the Branches row menu and the palette. Read-only: the
   * report names the commits `git rebase -i <onto>` would replay and where the two sides overlap.
   * `STALE` / `CANCELLED` drop through `ignoreStale`, as everywhere else.
   */
  runPreflight(branchRef: string, ontoRef: string): Promise<void>;
  /** Closes the panel and puts the Branches table back. */
  closePreflight(): void;
  // ---- Export (T11.10, Design §14.6) ----
  /**
   * Opens or closes the StatsRow's Export menu (key `e`). Opening renders `patchText()` for the
   * current scope once, which is where every size in the menu comes from; a menu opened on the
   * same generation and the same scope reuses what it already has.
   */
  setExportOpen(open: boolean): void;
  /**
   * Runs one export. An export that reproduces the changed lines (`carriesLines`) is stopped at
   * the secret gate first — `selectSecretGate` clear means *scanned with nothing found*, and
   * `scanned: false` is unknown, not clean — and is parked in `export.pending` until
   * `confirmExport()`. Saves go through a Blob URL and an `<a download>`; copies through the
   * clipboard. Outcomes are toasted, `STALE` / `CANCELLED` are ignored.
   */
  requestExport(req: ExportRequest): Promise<void>;
  /**
   * `Export anyway`: remembers the override for this generation, and runs the parked request when
   * there is one. Called with nothing parked it is the menu's own override link, which puts the
   * three line-carrying rows back in place of the warning block.
   */
  confirmExport(): Promise<void>;
  /** `Cancel`: drops the parked request; nothing is written. */
  cancelExport(): void;
  // ---- Home dashboard (T11.11, Design §14.6, atlas tab 11) ----
  /**
   * Fills the repository cards, and never blocks one from being opened: it shows what
   * `diffgit-derived` already holds for every card first, and only then reads the repositories
   * themselves — `SUMMARY_CONCURRENCY` at a time, through a throw-away engine session each
   * (`summaryClient()`), for handles whose permission is already `granted`. A `prompt` or `denied`
   * card is never summarised, because `requestPermission()` needs a user gesture and a dashboard
   * that prompts twenty times on load is the atlas's first risk.
   *
   * A repository is re-read only when the cheap stat of its `.git/index` disagrees with the cached
   * summary's `indexMtimeMs` (`force` skips that check — the `Refresh all` button). Every step
   * checks the sweep's ticket, so `cancelSummaries()` — leaving Home, or opening a repository —
   * stops it wherever it is.
   */
  loadSummaries(repos: DashboardRepo[], opts?: { force?: boolean }): Promise<void>;
  /** Stops the sweep and clears the spinners it left behind. Idempotent. */
  cancelSummaries(): void;

  // ---- Patch-only mode (T11.14, Design §14.6, atlas tab 17) ----
  /**
   * Reads a dropped / picked / OS-handed `.patch` or `.diff` file and opens it. Refuses anything
   * over `MAX_PATCH_BYTES` with a message naming both sizes; everything else is handed to
   * `openPatchText`, so a drop, the file input and `launchQueue` share one path.
   */
  openPatchFile(file: File): Promise<void>;
  /**
   * `parsePatch(text)` → a patch-only session: the repo screen with the parsed FileCards, the
   * `PATCH_ONLY` banner and no repository. Closes whatever was open first, so a patch never
   * inherits a repository's refs, warnings or refresh. `NOT_A_PATCH` lands in `patchSession.error`
   * — with its `line <n>: …` detail — and leaves the current screen exactly as it was.
   */
  openPatchText(text: string, name: string): Promise<void>;
  /** Clears `patchSession.error` (the inline message's Dismiss). */
  dismissPatchError(): void;
}

/** The refresh scheduler (T6.1) registers here; the store never imports it (no cycle). */
export interface RefreshHooks {
  start(handle: unknown): void;
  stop(): void;
  request(reason: RefreshReason, paths?: string[]): void;
}

export type StoreSet = (
  partial:
    | StoreState
    | Partial<StoreState>
    | ((state: StoreState) => StoreState | Partial<StoreState>),
) => void;

export type StoreGet = () => StoreState;
