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
import {
  defaultDiffSource,
  isWorktreeSource,
  sourceLabels,
  sourceRefs,
} from "../engine/diffSource";
import type { WarningCode } from "../engine/errors";
import { isFileSnapshot } from "../engine/fs/fileSnapshot";
import type {
  BisectState,
  BlamePayload,
  BranchesSource,
  BranchRow,
  CommitDetails,
  CommitSummary,
  DiffResult,
  DiffSource,
  FileDiff,
  HiddenEntry,
  InsightsResult,
  Oid,
  PathExplanation,
  PathHistoryEntry,
  PreflightResult,
  RangeSource,
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
  TagInfo,
  WalkRequest,
} from "../engine/types";
import {
  type BisectAction,
  type BisectSlice,
  bisectState,
  isArmed,
  pickingSlice,
  withBad,
  withGood,
  withSkip,
} from "./bisect";
import { BLAME_REVISIONS, blameCacheKey, PATH_HISTORY_PAGE, pathHistoryCacheKey } from "./blame";
import { BRANCH_CELL_BATCH, type BranchCells, type BranchFilter } from "./branches";
import type { CompareSpec } from "./compareHash";
import { buildSource, isRefExpr, labelOf, revToSide, type SideRev, sideOf } from "./compareSource";
import { type DashboardRepo, indexMtimeOf, SUMMARY_CONCURRENCY } from "./dashboard";
import { getWorkerClient, summaryClient } from "./engineClient";
import { LOADING_INLINE_CODES, toUiError, type UiError } from "./errors";
import { copyText, downloadText, HTML_MIME, PATCH_MIME } from "./export/download";
import {
  COPY_FAILED,
  carriesLines,
  commitPatchName,
  copiedNote,
  type ExportKind,
  exportedPastGate,
  exportFailed,
  exportFileName,
  fileListMarkdown,
  filePatchName,
  savedNote,
  statsLine,
} from "./export/exportModel";
import { snapshotFor } from "./export/snapshot";
import {
  COMMIT_STATS_BATCH,
  commitRange,
  HISTORY_PAGE,
  matchesCommit,
  STACK_LIMIT,
  shortOid,
  spanRange,
} from "./history";
import { EMPTY_RESULT, INSIGHTS_LIMIT, sinceMsFor } from "./insights";
import { Lru } from "./lru";
import { clearDerived, derivedKey, getDerived, setDerived } from "./persistence/derived";
import { revisionOfRef } from "./refGroups";
import { nextWiden, PICKAXE_COMMITS, SEARCH_HIT_LIMIT, type SearchScope } from "./search";
import {
  foundNote,
  hasUncommittedLayer,
  NO_FINDINGS_NOTE,
  NOTHING_TO_SCAN_NOTE,
  redactFindings,
} from "./secrets";
import {
  buildTree,
  type FileGroup,
  GROUP_ORDER,
  groupFiles,
  groupOf,
  makeFileFilter,
  makePathFilter,
  parseFilter,
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
/** `markReachable` is called in batches of this size (T11.3; T10.5 ships the method). */
export const REACHABLE_BATCH = 50;

/**
 * T10.8 ships `search`; until then the client simply does not have it, so the History search box
 * says the list loads more as you scroll instead of guessing. Feature check, not a contract change.
 */
type MaybeSearch = {
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
 * T11.1's `PendingEngineType = never` stood in for an engine type a later phase-10 task still had
 * to add. T11.13 widened the last one (`bisect`, `BisectState & BisectStep`), so the alias is gone:
 * `RepoOperation` was widened by T11.3, `HiddenEntry` by T11.4, `CommitSummary` by T11.5 and
 * `SecretFinding` by T11.9. Every v2 field now carries the type `docs/v2-contracts.md` names.
 */

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
 * T11.13: one `bisectStep(state)` for the marks the strip currently holds, then the answer.
 *
 * Module-level rather than a closure helper so the whole slice stays one contiguous block. It is
 * the only place that calls the engine for a bisect, so every entry point — the strip's buttons,
 * `g` / `x`, the CommitCard menu, the restore from `diffgit-derived` — narrows the same way:
 *
 * - the marks are written to `diffgit-derived` before the call, because they are the user's work
 *   and survive a reload whatever the engine answers;
 * - an answer whose marks are no longer the ones on screen is dropped (the user can press `g`
 *   twice faster than the worker replies), and `STALE` / `CANCELLED` go through `ignoreStale`;
 * - a candidate is *selected*, which makes the source `parent…candidate`, so the commit under
 *   test is the diff on screen — the atlas's "you can often answer without running anything".
 */
async function bisectStepNow(): Promise<void> {
  const { bisect: slice, repoId } = useStore.getState();
  if (!isArmed(slice)) return;
  const asked = bisectState(slice);
  const key = JSON.stringify(asked);
  useStore.setState({ bisect: { ...slice, loading: true, error: null } });
  if (repoId !== null) void setDerived(derivedKey.bisect(repoId), asked);
  /** The marks this call answers; a mark made while it was in flight makes it stale. */
  const current = (): BisectSlice | null => {
    const cur = useStore.getState().bisect;
    return cur !== null && JSON.stringify(bisectState(cur)) === key ? cur : null;
  };
  try {
    const step = await client().bisectStep(asked);
    const cur = current();
    if (!cur) return;
    useStore.setState({ bisect: { ...cur, ...step, loading: false, error: null } });
    if (step.candidate !== null) void useStore.getState().showCommit(step.candidate);
  } catch (e) {
    const err = toUiError(e);
    const stale = err.code === "STALE" || err.code === "CANCELLED";
    if (stale) ignoreStale(e);
    const cur = current();
    if (!cur) return;
    useStore.setState({ bisect: { ...cur, loading: false, error: stale ? null : err } });
  }
}

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

/** Nothing on the dashboard's sessions is worth a progress bar; the cards say "Reading…" instead. */
const SILENT_SINK: ProgressSink = {
  onProgress() {},
  onStats() {},
  onWarning() {},
};

/**
 * The ticket of the newest dashboard sweep. Leaving Home, opening a repository and starting a new
 * sweep all bump it, and every step of the walk checks it, so a summary that was already in flight
 * lands nowhere instead of writing into a screen the user has left (the task: "cancel on
 * navigation", the atlas: "only while the dashboard is visible").
 */
let summaryTicket = 0;
/** Test hook (T11.11): where the throw-away summary sessions come from. */
let summaryClientFactory: (() => WorkerClient) | null = null;
export function setSummaryClientFactory(factory: (() => WorkerClient) | null): void {
  summaryClientFactory = factory;
}
function newSummaryClient(): WorkerClient {
  return summaryClientFactory ? summaryClientFactory() : summaryClient();
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
  /** Tags for the picker's `Tags` group; null = not listed yet (T11.2, lazy on first open). */
  tags: TagInfo[] | null;
  /** Stashes for the picker's `Stashes` group; null = not listed yet (T11.2). */
  stashes: StashInfo[] | null;
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

/**
 * T11.6: what `blame` / `pathHistory` are asked at. With `at` set (the History-mode "Blame here"
 * action, or the popover's "Blame at parent") it is that commit and the working tree is out of the
 * picture; otherwise it is the compare side of the current source, which is also the side whose
 * text the card already shows.
 */
export function blameTarget(
  s: Pick<StoreState, "diffSource" | "repo">,
  at: Oid | null = null,
): BlameTarget | null {
  const { diffSource, repo } = s;
  if (at !== null) return { ref: at, oid: at, includeWorktree: false };
  if (!diffSource || !repo) return null;
  const includeWorktree = diffSource.includeWorktree && isWorktreeSource(diffSource, repo);
  if (diffSource.kind === "range") {
    return { ref: diffSource.toRef, oid: diffSource.toOid, includeWorktree };
  }
  const { sourceRef } = sourceRefs(diffSource);
  const oid = sourceRef === "HEAD" ? repo.headOid : (findRef(repo, sourceRef)?.oid ?? repo.headOid);
  // An unborn HEAD has no commit to blame or to key a cache entry by.
  return oid === null ? null : { ref: sourceRef, oid, includeWorktree };
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

/**
 * T11.5: `commitStats` is single-in-flight in the engine like every other method, so a second call
 * would cancel the first. The visible rows queue here and one drain loop serialises the batches.
 */
const commitStatsQueue = new Set<Oid>();
let commitStatsDraining = false;

/** T11.7: the same rule for `branchCells` — the table's visible rows queue, one loop drains them. */
const branchCellQueue = new Set<string>();
let branchCellsDraining = false;

/**
 * T11.8: the ticket of the newest `search` call. `search` is single-in-flight in the engine, so a
 * newer query cancels the older one there; here the ticket is what makes the older *answer* — or
 * its `CANCELLED` rejection — land nowhere. `cancelSearch` and `closeRepo` bump it too, so a reply
 * that arrives after `Escape` cannot repopulate a palette the user has already dismissed.
 */
let searchTicket = 0;

/**
 * T11.7: **the base branch**. It is chosen once and then remembered, but it is not a preference of
 * its own: it is the base side of the pickers whenever that side is a plain branch (T11.5's
 * `compareBase`, which `openRepo` seeds from the remembered `lastTarget` and every `Set as base`
 * updates), and otherwise the repository's own default branch — `RepoRef.isDefault`, which the
 * engine resolves per D8 (`refs/remotes/<remote>/HEAD`, then `main`, then `master`). One source of
 * truth, remembered per repository by the mechanism that already remembers the compare pair.
 */
function baseRefOf(s: Pick<StoreState, "repo" | "compareBase">): RepoRef | null {
  const repo = s.repo;
  if (!repo) return null;
  const chosen = s.compareBase ? findRef(repo, s.compareBase.expr) : null;
  return chosen ?? repo.defaultRef ?? findRef(repo, "HEAD");
}

/** The base branch, for the page header and the row menu's label. */
export function selectBranchBase(
  s: Pick<StoreState, "repo" | "compareBase">,
): { fullName: string; display: string } | null {
  const ref = baseRefOf(s);
  return ref ? { fullName: ref.fullName, display: ref.name } : null;
}

/** A tag as a comparison side. Never `branchRef`, so a tag pair is always a `RangeSource`. */
function tagSide(tag: TagInfo): SideRev {
  return { expr: tag.fullName, display: tag.name, oid: tag.targetOid, branchRef: null };
}

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

/**
 * T11.9: "stats complete" for the purpose of the secret scan. Every row either has an answer — a
 * number, or the explicit `null` the engine streams for a file it could not count — or is one that
 * never gets a `+n −m` at all. A single unreadable file must not hold a safety check back forever.
 */
function statsSettled(files: readonly FileDiff[], stats: Record<string, FileStats>): boolean {
  return files.every((f) => f.id in stats || f.stats !== null || f.binary || f.tooLarge);
}

export const useStore = create<StoreState>()((set, get) => {
  /**
   * T11.9: the generation whose secret scan is still waiting for its stats, or null. The scan and
   * the stats pump both read file content in the engine, so the banner waits for the counts rather
   * than racing them (the brief: "after stats complete").
   */
  let secretsAfterStats: number | null = null;
  function maybeScanSecrets(
    files: readonly FileDiff[],
    stats: Record<string, FileStats>,
    generation: number,
  ): void {
    if (secretsAfterStats !== generation) return;
    if (!statsSettled(files, stats)) return;
    secretsAfterStats = null;
    void get().scanSecrets();
  }

  const sink: ProgressSink = {
    onProgress(p: Progress) {
      // T11.12: the insights walk reports every 500 commits and the skeleton counts them up.
      if (p.phase === "insights" && p.done !== undefined) {
        const done = p.done;
        set((s) => (s.insights.loading ? { insights: { ...s.insights, walked: done } } : {}));
      }
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
        const stats = { ...s.stats, ...batch.stats };
        set({ stats, statsLastAt: Date.now() });
        maybeScanSecrets(s.diff.files, stats, batch.generation);
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
    // T11.5: a picker change is a new branch pair, so the Stack tab has to walk again. Picking a
    // commit goes through `applyRange` instead and deliberately leaves the stack alone.
    set((s) => ({
      diffSource: src,
      stack: { ...s.stack, ready: false },
      compareBase:
        from.branchRef === null ? s.compareBase : { expr: from.branchRef, display: from.display },
    }));
    if (src.kind === "branches") {
      void persistence.touchRepo(get().repoId ?? "", {
        lastSource: src.sourceRef,
        lastTarget: src.targetRef,
      });
    }
    get().requestRefresh("branch-change");
  }

  /**
   * T11.5: commits the History list picks. Unlike `applySides` it never touches the remembered
   * branch pair (a range is deep-linked by hash, not persisted) and never invalidates the stack.
   */
  function applyRange(src: RangeSource): void {
    const { repo } = get();
    if (!repo) return;
    set({ diffSource: guardWorktree(src, repo) });
    get().requestRefresh("branch-change");
  }

  /**
   * Which ref the History list walks: the compare side while it is a plain branch (Design §14.1,
   * "in History mode the pickers still define the branch that is walked"), and `HEAD` once picking
   * a commit has turned the source into a range — a list that truncated itself at the row you just
   * clicked would be unusable.
   */
  function walkTip(): string {
    const src = get().diffSource;
    if (!src) return "HEAD";
    const { sourceRef } = sourceRefs(src);
    return isRefExpr(sourceRef) ? sourceRef : "HEAD";
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
    blames: {},
    pathHistories: {},
    operation: null,
    reflog: null,
    conflicts: {},
    secrets: null,
    hidden: null,
    history: INITIAL_HISTORY,
    commitDetails: {},
    commitStats: {},
    stack: INITIAL_STACK,
    compareBase: null,
    bisect: null,
    palette: false,
    snapshotMode: false,
    snapshotReadAt: null,
    patchOnly: false,
    tags: null,
    stashes: null,
    branches: INITIAL_BRANCHES,
    search: INITIAL_SEARCH,
    insights: INITIAL_INSIGHTS,
    preflight: INITIAL_PREFLIGHT,
    export: INITIAL_EXPORT,
    dashboard: INITIAL_DASHBOARD,

    async openRepo(handle, opts = {}) {
      await get().closeRepo();
      // T11.15: a read-once `FileSnapshot` instead of a directory handle — the folder was handed
      // over whole and cannot be read again, so nothing here may schedule, remember or poll it.
      const snapshot = isFileSnapshot(handle) ? handle : null;
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
        snapshotMode: snapshot !== null,
        snapshotReadAt: snapshot?.readAt ?? null,
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
          // B10 / T10.4: the only page preference the engine needs at open time.
          const info = await client().open(handle, sink, {
            builtinExcludes: get().prefs.builtinExcludes,
          });
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
          // T11.15: the banner belongs to the repository for as long as it is open, so it rides on
          // `RepoInfo.warnings`, which every `recompute()` merges back into `warnings`.
          const shown = snapshot
            ? { ...info, warnings: [...info.warnings, SNAPSHOT_WARNING] }
            : info;
          set((s) => ({
            repo: shown,
            diffSource: src,
            // T11.5: the base picker's side, remembered for `Compare with base…`.
            compareBase: { expr: src.targetRef, display: src.target },
            // Design §14.3: the operation banner is driven by `RepoInfo.operation`, which the
            // scheduler refreshes through `reloadRefs()` on every git-side tick.
            operation: info.operation,
            warnings: [...shown.warnings],
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
            // T11.15: snapshot mode has no handle to observe, poll or store, so neither the
            // scheduler nor Recent hears about it. Re-opening the folder is the only refresh.
            if (!snapshot) {
              refreshHooks?.start(handle);
              void persistence.touchRepo(get().repoId ?? "", {
                lastOpenMs: Date.now() - startedAt,
                lastSource: src.sourceRef,
                lastTarget: src.targetRef,
              });
            }
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
        blames: {},
        pathHistories: {},
        operation: null,
        reflog: null,
        conflicts: {},
        secrets: null,
        hidden: null,
        history: INITIAL_HISTORY,
        commitDetails: {},
        commitStats: {},
        stack: INITIAL_STACK,
        compareBase: null,
        bisect: null,
        palette: false,
        snapshotMode: false,
        snapshotReadAt: null,
        patchOnly: false,
        tags: null,
        stashes: null,
        branches: INITIAL_BRANCHES,
        search: INITIAL_SEARCH,
        insights: INITIAL_INSIGHTS,
        preflight: INITIAL_PREFLIGHT,
        export: INITIAL_EXPORT,
      });
      pickerSources = null;
      commitStatsQueue.clear();
      branchCellQueue.clear();
      secretsAfterStats = null;
      searchTicket++;
      summaryTicket++; // T11.11: a sweep started on Home must not write into the next visit
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
          // A tag can name a blob or a tree (T10.5b `TagInfo.targetType`); only a commit can be a
          // side of a diff, so the picker lists the others no more than `git log --all` walks them.
          const tags = (await client().listTags()).filter((t) => t.targetType === "commit");
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
        // T11.15: snapshot mode's banner outlives every refresh — the scheduler's `reloadRefs()`
        // and the restart listener both replace `repo` with a RepoInfo that cannot know about it.
        if (current.snapshotMode && !merged.some((w) => w.code === "SNAPSHOT_MODE"))
          merged.push(SNAPSHOT_WARNING);
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
          // T11.9: findings belong to one generation; the new diff is unscanned until the scan
          // below answers, so the banner can never describe a diff that is no longer on screen.
          secrets: null,
          // T11.10: the prepared patch and the secret-gate override belong to the old generation.
          export: { ...INITIAL_EXPORT, open: s.export.open },
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
        // T11.4: while the Hidden group is up it follows the working tree, like every other group.
        if (get().prefs.showHidden) void get().loadHidden();
        // T11.9: arm the scan for this generation; it runs as soon as the stats of that diff are
        // in — immediately when the result already carried them all.
        secretsAfterStats = result.generation;
        maybeScanSecrets(result.files, stats, result.generation);
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
        // T10.5's `reflog()` already fills `reachable` from one batched walk; the batches below
        // re-confirm it for a recording (or a future reader) that left the field unknown.
        if (entries.every((e) => e.reachable !== null)) return;
        for (let i = 0; i < entries.length; i += REACHABLE_BATCH) {
          const batch = entries.slice(i, i + REACHABLE_BATCH);
          const map = await client().markReachable(batch.map((e) => e.newOid));
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

    async loadHidden() {
      if (!get().repo) return;
      try {
        const entries = await client().listHidden();
        // The toggle may have gone off (or the repo closed) while the walk was running.
        if (!get().repo || !get().prefs.showHidden) return;
        set({ hidden: entries });
      } catch (e) {
        // A superseded or stale call is normal (one in-flight per method); anything else leaves the
        // group empty rather than blocking the sidebar — the toggle can be pressed again.
        ignoreStale(e);
        if (get().prefs.showHidden && get().hidden === null) set({ hidden: [] });
      }
    },

    explainPath(path) {
      return client().explainPath(path);
    },

    async reopenSession() {
      const { handle, repoId, diffSource } = get();
      if (!handle) return;
      const pair =
        diffSource?.kind === "branches"
          ? { lastSource: diffSource.sourceRef, lastTarget: diffSource.targetRef }
          : {};
      await get().openRepo(handle, {
        ...(repoId === null ? {} : { id: repoId }),
        ...pair,
        ...(diffSource && !diffSource.includeWorktree ? { skipWorktree: true } : {}),
      });
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
      const previous = get().prefs;
      const prefs = { ...previous, [key]: value };
      set({ prefs });
      persistence.savePrefs(prefs);
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

    setCardMode(id, cardMode) {
      set((s) =>
        s.cardModes[id] === cardMode ? {} : { cardModes: { ...s.cardModes, [id]: cardMode } },
      );
    },

    async loadBlame(path, opts) {
      const s = get();
      const target = blameTarget(s, opts.at);
      if (!target || !s.repo) return;
      const max = opts.maxRevisions ?? BLAME_REVISIONS;
      const key = blameCacheKey(target.oid, path, opts.ignoreWhitespace);
      const existing = s.blames[key];
      if (existing?.status === "loading") return;
      if (existing?.status === "ready" && existing.maxRevisions >= max) return;
      set((cur) => ({ blames: { ...cur.blames, [key]: { status: "loading" } } }));
      // The derived cache is keyed by a commit oid, so it may only hold answers that a commit fully
      // determines: a blame that carries working-tree lines is not one of those.
      const cacheable = !target.includeWorktree && s.repoId !== null;
      const derived = cacheable
        ? derivedKey.blame(s.repoId as string, target.oid, path, opts.ignoreWhitespace)
        : null;
      if (derived !== null) {
        const hit = await getDerived<{ data: BlamePayload; maxRevisions: number }>(derived);
        if (hit && hit.maxRevisions >= max) {
          if (get().blames[key]?.status !== "loading") return;
          set((cur) => ({
            blames: {
              ...cur.blames,
              [key]: { status: "ready", data: hit.data, maxRevisions: hit.maxRevisions },
            },
          }));
          return;
        }
      }
      try {
        const data = await client().blame(target.ref, path, {
          ignoreWhitespace: opts.ignoreWhitespace,
          includeWorktree: target.includeWorktree,
          maxRevisions: max,
        });
        if (!get().repo) return;
        set((cur) => ({
          blames: { ...cur.blames, [key]: { status: "ready", data, maxRevisions: max } },
        }));
        if (derived !== null) void setDerived(derived, { data, maxRevisions: max });
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED") {
          // A superseded blame is normal (one in flight per method): drop the placeholder and let
          // the card ask again rather than showing a failure the user did not cause.
          set((cur) => {
            const { [key]: dropped, ...rest } = cur.blames;
            return dropped?.status === "loading" ? { blames: rest } : {};
          });
          return;
        }
        set((cur) => ({ blames: { ...cur.blames, [key]: { status: "error", error: err } } }));
      }
    },

    async loadPathHistory(path, opts) {
      const s = get();
      const target = blameTarget(s, opts.at);
      if (!target || !s.repo) return;
      const key = pathHistoryCacheKey(target.oid, path, opts.follow);
      const existing = s.pathHistories[key];
      if (existing?.loading) return;
      if (!opts.more && existing && existing.entries.length > 0) return;
      if (opts.more && existing && existing.cursor === null) return;
      const cursor = opts.more ? (existing?.cursor ?? undefined) : undefined;
      set((cur) => ({
        pathHistories: {
          ...cur.pathHistories,
          [key]: {
            ...(cur.pathHistories[key] ?? INITIAL_PATH_HISTORY),
            loading: true,
            error: null,
          },
        },
      }));
      try {
        const page = await client().pathHistory(target.ref, path, {
          follow: opts.follow,
          limit: PATH_HISTORY_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!get().repo) return;
        set((cur) => {
          const before = cur.pathHistories[key] ?? INITIAL_PATH_HISTORY;
          return {
            pathHistories: {
              ...cur.pathHistories,
              [key]: {
                entries: cursor === undefined ? page.entries : [...before.entries, ...page.entries],
                cursor: page.cursor,
                loading: false,
                error: null,
              },
            },
          };
        });
      } catch (e) {
        const err = toUiError(e);
        const stale =
          err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED";
        set((cur) => {
          const before = cur.pathHistories[key] ?? INITIAL_PATH_HISTORY;
          return {
            pathHistories: {
              ...cur.pathHistories,
              [key]: { ...before, loading: false, error: stale ? null : err },
            },
          };
        });
        if (stale) ignoreStale(e);
      }
    },

    setHistoryTab(tab) {
      set({ historyTab: tab });
    },

    async loadHistory(reset = false) {
      const { repo, history } = get();
      if (!repo || history.loading) return;
      if (!reset && history.cursor === null && history.commits.length > 0) return;
      const cursor = reset ? undefined : (history.cursor ?? undefined);
      set((s) => ({
        history: reset
          ? {
              ...s.history,
              commits: [],
              cursor: null,
              capped: false,
              laneOverflow: false,
              loading: true,
            }
          : { ...s.history, loading: true },
      }));
      try {
        const req: WalkRequest = {
          from: [walkTip()],
          firstParent: history.firstParent,
          limit: HISTORY_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
          ...(history.all ? { all: true } : {}),
        };
        const page = await client().walkCommits(req);
        if (!get().repo) return;
        // T10.5b: `WalkPage.laneOverflow` is not in the type yet; read it forward-compatibly.
        const overflow = (page as { laneOverflow?: boolean }).laneOverflow === true;
        set((s) => {
          const seen = new Set(s.history.commits.map((c) => c.oid));
          const added = page.commits.filter((c) => !seen.has(c.oid));
          return {
            history: {
              ...s.history,
              commits: [...s.history.commits, ...added],
              cursor: page.cursor,
              capped: s.history.capped || page.capped,
              laneOverflow: s.history.laneOverflow || overflow,
              loading: false,
            },
          };
        });
        get().requestCommitStats(page.commits.map((c) => c.oid));
      } catch (e) {
        const err = toUiError(e);
        set((s) => ({ history: { ...s.history, loading: false } }));
        // T10.5b: a cursor goes STALE when the refs moved under the walk. The pages either side of
        // that move do not line up, so the list is thrown away and walked again from the tip —
        // appending would duplicate rows.
        if (err.code === "STALE" && cursor !== undefined) {
          await get().loadHistory(true);
          return;
        }
        // A superseded walk is normal (one in flight per method); the list keeps what it has.
        ignoreStale(e);
      }
    },

    setHistoryQuery(query) {
      set((s) => ({ history: { ...s.history, query } }));
    },

    setHistoryOption(key, on) {
      if (get().history[key] === on) return;
      set((s) => ({ history: { ...s.history, [key]: on } }));
      void get().loadHistory(true);
    },

    async showCommit(oid, opts = {}) {
      const { repo, history } = get();
      if (!repo) return;
      const commits = history.commits;
      const anchor = opts.extend ? (history.rangeStart ?? history.selected) : null;
      if (anchor !== null && anchor !== oid) {
        // The list is newest first, so the higher index is the older commit.
        const ai = commits.findIndex((c) => c.oid === anchor);
        const bi = commits.findIndex((c) => c.oid === oid);
        const [older, newer] = ai > bi ? [anchor, oid] : [oid, anchor];
        set((s) => ({ history: { ...s.history, selected: newer, rangeStart: older } }));
        applyRange(spanRange(older, newer));
        return;
      }
      set((s) => ({ history: { ...s.history, selected: oid, rangeStart: null } }));
      let parent = commits.find((c) => c.oid === oid)?.parents[0] ?? null;
      if (!commits.some((c) => c.oid === oid)) {
        // A commit that is not in the walk (a Reflog row, an orphan): its parent comes from
        // `commitDetails`, which the card needs anyway.
        await get().loadCommitDetails(oid);
        const entry = get().commitDetails[oid];
        if (entry?.status === "error") return;
        parent = entry?.status === "ready" ? (entry.data.parents[0] ?? null) : null;
        if (get().history.selected !== oid) return;
      }
      applyRange(commitRange(oid, parent));
      void get().loadCommitDetails(oid);
    },

    async loadCommitDetails(oid) {
      const existing = get().commitDetails[oid];
      if (existing && existing.status !== "error") return;
      if (!get().repo) return;
      set((s) => ({ commitDetails: { ...s.commitDetails, [oid]: { status: "loading" } } }));
      try {
        const data = await client().commitDetails(oid);
        if (!get().repo) return;
        set((s) => ({ commitDetails: { ...s.commitDetails, [oid]: { status: "ready", data } } }));
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED") {
          set((s) => {
            const { [oid]: dropped, ...rest } = s.commitDetails;
            return dropped?.status === "loading" ? { commitDetails: rest } : {};
          });
          return;
        }
        set((s) => ({
          commitDetails: { ...s.commitDetails, [oid]: { status: "error", error: err } },
        }));
      }
    },

    requestCommitStats(oids) {
      const have = get().commitStats;
      for (const oid of oids) if (!(oid in have)) commitStatsQueue.add(oid);
      if (commitStatsDraining || commitStatsQueue.size === 0 || !get().repo) return;
      commitStatsDraining = true;
      void (async () => {
        try {
          while (commitStatsQueue.size > 0 && get().repo) {
            const batch = [...commitStatsQueue].slice(0, COMMIT_STATS_BATCH);
            for (const oid of batch) commitStatsQueue.delete(oid);
            const map = await client().commitStats(batch);
            if (!get().repo) return;
            set((s) => ({ commitStats: { ...s.commitStats, ...map } }));
          }
        } catch (e) {
          // Superseded or stale: the rows keep their skeletons and the next window asks again.
          ignoreStale(e);
        } finally {
          commitStatsDraining = false;
        }
      })();
    },

    async searchCommits(query) {
      const c = client() as WorkerClient & MaybeSearch;
      if (typeof c.search !== "function") return null;
      try {
        const res = await c.search({ scope: "commits", query, limit: HISTORY_PAGE });
        return res.hits.flatMap((h) => (h.oid ? [h.oid] : []));
      } catch (e) {
        ignoreStale(e);
        return [];
      }
    },

    async loadStack() {
      const { repo, diffSource, diff, stack } = get();
      if (!repo || !diffSource || stack.loading) return;
      const { sourceRef } = sourceRefs(diffSource);
      const base = diff?.mergeBase ?? (diffSource.kind === "range" ? diffSource.fromOid : null);
      const label = labelOf(diffSource);
      set((s) => ({ stack: { ...s.stack, loading: true, tip: sourceRef, label } }));
      try {
        let commits: CommitSummary[] = [];
        let cursor: string | undefined;
        let capped = false;
        let reachedBase = false;
        /** T10.5b: one restart from the tip when a cursor goes STALE under a moving ref. */
        let restarts = 0;
        while (!reachedBase && commits.length < STACK_LIMIT) {
          let page: Awaited<ReturnType<WorkerClient["walkCommits"]>>;
          try {
            page = await client().walkCommits({
              from: [sourceRef],
              firstParent: true,
              limit: HISTORY_PAGE,
              ...(cursor === undefined ? {} : { cursor }),
            });
          } catch (e) {
            if (toUiError(e).code !== "STALE" || cursor === undefined || restarts >= 1) throw e;
            restarts++;
            commits = [];
            cursor = undefined;
            continue;
          }
          for (const c of page.commits) {
            if (c.oid === base) {
              reachedBase = true;
              break;
            }
            if (commits.length >= STACK_LIMIT) break;
            commits.push(c);
          }
          if (page.cursor === null) {
            // The whole branch was walked; with no merge base every commit belongs to the stack.
            reachedBase = true;
            break;
          }
          cursor = page.cursor;
        }
        if (!reachedBase && commits.length >= STACK_LIMIT) capped = true;
        if (!get().repo) return;
        set({
          stack: {
            commits,
            base,
            tip: sourceRef,
            label,
            loading: false,
            ready: true,
            capped,
          },
        });
        get().requestCommitStats(commits.map((c) => c.oid));
      } catch (e) {
        ignoreStale(e);
        set((s) => ({ stack: { ...s.stack, loading: false, ready: true } }));
      }
    },

    compareCommitWithBase(oid) {
      const { repo, diffSource, compareBase, prefs } = get();
      if (!repo || !diffSource) return;
      const base = compareBase ?? {
        expr: sourceRefs(diffSource).targetRef,
        display: sourceLabels(diffSource).target,
      };
      const baseOid = base.expr === "HEAD" ? repo.headOid : (findRef(repo, base.expr)?.oid ?? null);
      applyRange({
        kind: "range",
        from: base.display,
        to: shortOid(oid),
        fromRef: base.expr,
        toRef: oid,
        fromOid: baseOid,
        toOid: oid,
        threeDot: !prefs.twoDot,
        includeWorktree: false,
      });
      set((s) => ({ history: { ...s.history, selected: oid, rangeStart: null } }));
      void get().loadCommitDetails(oid);
    },

    // ---- Branches mode (T11.7, Design §14.6) ------------------------------------------------
    async loadBranches() {
      const { repo, branches } = get();
      if (!repo || branches.loading || branches.rows !== null) return;
      set((s) => ({ branches: { ...s.branches, loading: true, error: null } }));
      try {
        const rows = await client().branchOverview();
        if (!get().repo) return;
        set((s) => ({ branches: { ...s.branches, rows, loading: false } }));
      } catch (e) {
        const err = toUiError(e);
        const stale =
          err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED";
        set((s) => ({
          branches: { ...s.branches, loading: false, error: stale ? null : err },
        }));
        if (stale) ignoreStale(e);
      }
    },

    requestBranchCells(fullNames) {
      const have = get().branches.cells;
      for (const name of fullNames) if (!(name in have)) branchCellQueue.add(name);
      if (branchCellsDraining || branchCellQueue.size === 0 || !get().repo) return;
      branchCellsDraining = true;
      void (async () => {
        try {
          while (branchCellQueue.size > 0 && get().repo) {
            const batch = [...branchCellQueue].slice(0, BRANCH_CELL_BATCH);
            for (const name of batch) branchCellQueue.delete(name);
            const filled = await client().branchCells(batch);
            if (!get().repo) return;
            // A name the engine did not answer for (a ref that vanished under us) is recorded as
            // "asked and unknown", so the table prints `—` instead of asking again for ever.
            const cells: Record<string, BranchCells> = {};
            for (const name of batch) {
              cells[name] = filled[name] ?? { vsUpstream: null, vsDefault: null, merged: null };
            }
            set((s) => ({ branches: { ...s.branches, cells: { ...s.branches.cells, ...cells } } }));
          }
        } catch (e) {
          // Superseded or stale: the rows keep their skeletons and the next render asks again.
          ignoreStale(e);
        } finally {
          branchCellsDraining = false;
        }
      })();
    },

    setBranchFilter(filter) {
      set((s) => ({ branches: { ...s.branches, filter } }));
    },

    setBranchQuery(query) {
      set((s) => ({ branches: { ...s.branches, query } }));
    },

    showBranchHistory(fullName) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const ref = findRef(repo, fullName);
      if (!ref) return;
      // The compare side is the branch History walks (Design §14.1), so this is the picker's own
      // action — hash, remembered pair and StatsRow follow exactly as if it had been chosen there.
      applySides(sideOf(diffSource, "target", repo), revToSide(revisionOfRef(ref)));
      set((s) => ({ history: { ...s.history, selected: null, rangeStart: null } }));
      get().setMode("history");
      void get().loadHistory(true);
    },

    compareBranchWithBase(fullName) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const ref = findRef(repo, fullName);
      const base = baseRefOf(get());
      if (!ref || !base || base.fullName === ref.fullName) return;
      applySides(revToSide(revisionOfRef(base)), revToSide(revisionOfRef(ref)));
      get().setMode("files");
    },

    compareTags(previous, tag) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      applySides(tagSide(previous), tagSide(tag));
      get().setMode("files");
    },

    async scanSecrets(opts = {}) {
      const s = get();
      if (!s.diff) return;
      const generation = s.diff.generation;
      // T10.7 skips these rows without reading a byte; the store skips the round trip as well, so
      // a committed-only diff never wakes the scanner (the task's "scan is not called" case).
      if (!s.diff.files.some(hasUncommittedLayer)) {
        secretsAfterStats = null;
        set({ secrets: [] });
        if (opts.announce) get().addToast({ level: "info", message: NOTHING_TO_SCAN_NOTE });
        return;
      }
      try {
        const found = await client().scanSecrets(generation);
        const cur = get();
        if (!cur.diff || cur.diff.generation !== generation) return;
        set({ secrets: found });
        if (opts.announce) {
          get().addToast(
            found.length === 0
              ? { level: "info", message: NO_FINDINGS_NOTE }
              : { level: "warning", message: foundNote(found.length) },
          );
        }
      } catch (e) {
        const err = toUiError(e);
        // A superseded or stale scan is normal (one call in flight per method): the next compute
        // asks again and the banner keeps whatever it had.
        ignoreStale(e);
        if (opts.announce && err.code !== "STALE" && err.code !== "CANCELLED") {
          get().addToast({ level: "warning", message: `Secret scan failed: ${err.message}` });
        }
      }
    },

    async fileBytes(id, side) {
      const s = get();
      if (!s.diff) return null;
      return client().fileBytes(s.diff.generation, id, side);
    },

    // ---- Search scopes in the palette (T11.8, Design §14.1, atlas tab 05) ----
    async runSearch(req) {
      const ticket = ++searchTicket;
      const query = req.query.trim();
      const commits = req.scope === "pickaxe" ? (req.commits ?? PICKAXE_COMMITS) : undefined;
      if (!get().repo || query === "") {
        set({
          search: {
            ...INITIAL_SEARCH,
            scope: req.scope,
            query,
            regex: req.regex,
            commits: commits ?? PICKAXE_COMMITS,
          },
        });
        return;
      }
      // Only the path part: `status:` / `layer:` are the sidebar's vocabulary, not the engine's.
      const path = parseFilter(get().filter).path.trim();
      set({
        search: {
          scope: req.scope,
          query,
          regex: req.regex,
          path: path === "" ? null : path,
          commits: commits ?? PICKAXE_COMMITS,
          loading: true,
          result: null,
          error: null,
        },
      });
      try {
        const result = await client().search({
          scope: req.scope,
          query,
          limit: SEARCH_HIT_LIMIT,
          ...(req.regex ? { regex: true } : {}),
          ...(path === "" ? {} : { path }),
          ...(commits === undefined ? {} : { commits }),
        });
        if (ticket !== searchTicket) return; // a newer query, or Escape, got there first
        set((s) => ({ search: { ...s.search, loading: false, result } }));
      } catch (e) {
        if (ticket !== searchTicket) return;
        const err = toUiError(e);
        ignoreStale(e);
        if (err.code === "STALE" || err.code === "CANCELLED") {
          set((s) => ({ search: { ...s.search, loading: false } }));
          return;
        }
        set((s) => ({ search: { ...s.search, loading: false, error: err } }));
      }
    },

    async widenSearch() {
      const s = get().search;
      const next = s.scope === "pickaxe" ? nextWiden(s.commits) : null;
      if (s.scope === null || next === null) return;
      await get().runSearch({
        scope: s.scope,
        query: s.query,
        regex: s.regex,
        commits: next,
      });
    },

    cancelSearch() {
      // The engine exposes no `cancelSearch`, so the running call is abandoned rather than aborted:
      // the ticket makes its answer land nowhere (T11.8 deliverables, "else ignore result").
      searchTicket++;
      if (get().search === INITIAL_SEARCH) return;
      set({ search: INITIAL_SEARCH });
    },

    // ---- Insights mode (T11.12, Design §14.6) ---------------------------------------------------

    async loadInsights(opts = {}) {
      const s = get();
      const { repo, repoId } = s;
      if (!repo || repoId === null) return;
      const period = s.prefs.insightsPeriod;
      const tip = repo.headOid;
      const { insights } = s;
      if (insights.loading) return;
      if (
        !opts.force &&
        insights.result !== null &&
        insights.tip === tip &&
        insights.period === period
      )
        return;
      // A repository with no commits: nothing to walk, and no oid to key a cache entry by.
      if (tip === null) {
        set({ insights: { ...INITIAL_INSIGHTS, result: EMPTY_RESULT, tip: null, period } });
        return;
      }
      set({ insights: { ...INITIAL_INSIGHTS, loading: true, tip, period } });
      /** The request this call is the answer to; a later chip click makes it stale. */
      const current = () => {
        const cur = get().insights;
        return cur.loading && cur.tip === tip && cur.period === period;
      };
      const key = derivedKey.insights(repoId, tip, period);
      if (!opts.force) {
        const hit = await getDerived<InsightsResult>(key);
        if (hit) {
          if (!current()) return;
          set({ insights: { ...INITIAL_INSIGHTS, result: hit, tip, period, cached: true } });
          if (hit.capped) get().dismissWarning("INSIGHTS_CAPPED");
          return;
        }
      }
      try {
        const sinceMs = sinceMsFor(period, selectInsightsAnchor(get()));
        const result = await client().insights({
          limit: INSIGHTS_LIMIT,
          ...(sinceMs === undefined ? {} : { sinceMs }),
        });
        if (!current()) return;
        set({ insights: { ...INITIAL_INSIGHTS, result, tip, period } });
        void setDerived(key, result);
        // The page prints the cap as one inline line (Design §14, rule 2), so the engine's one-shot
        // `INSIGHTS_CAPPED` never also gets a banner of its own.
        if (result.capped) get().dismissWarning("INSIGHTS_CAPPED");
      } catch (e) {
        const err = toUiError(e);
        const stale = err.code === "STALE" || err.code === "CANCELLED";
        if (stale) ignoreStale(e);
        if (!current()) return;
        set({
          insights: { ...INITIAL_INSIGHTS, tip, period, error: stale ? null : err },
        });
      }
    },

    setInsightsPeriod(period) {
      if (get().prefs.insightsPeriod === period) return;
      get().setPref("insightsPeriod", period);
      void get().loadInsights();
    },

    showHotspot(path) {
      get().setFilter(path);
      get().setMode("files");
    },

    // ---- Bisect and rebase preflight (T11.13, Design §14.5 / §14.6) -----------------------------

    async startBisect(ends) {
      const { repo } = get();
      if (!repo) return;
      get().setMode("history");
      if (!ends) {
        // Design §14.5: `Start bisect…` is a prompt, and the next two clicks in the list are the ends.
        set({ bisect: pickingSlice("good") });
        return;
      }
      set({ bisect: withBad(withGood(pickingSlice(null), ends.good), ends.bad) });
      await bisectStepNow();
    },

    async markBisect(mark, oid) {
      const current = get().bisect;
      const target = oid ?? current?.candidate ?? null;
      if (target === null) return;
      // No bisect yet (the CommitCard menu's `Bisect: mark good` / `mark bad`): this mark is one
      // end and the strip asks for the other. `skip` on its own means nothing, so it is ignored.
      if (current === null) {
        if (mark === "skip") return;
        get().setMode("history");
        const seeded =
          mark === "good"
            ? withGood(pickingSlice("bad"), target)
            : withBad(pickingSlice("good"), target);
        set({ bisect: seeded });
        return;
      }
      if (current.picking !== null) {
        if (mark === "skip") return;
        const marked = mark === "good" ? withGood(current, target) : withBad(current, target);
        const other = mark === "good" ? "bad" : "good";
        const complete = marked.good.length > 0 && marked.bad !== "";
        set({ bisect: { ...marked, picking: complete ? null : other } });
        if (complete) await bisectStepNow();
        return;
      }
      const next =
        mark === "good"
          ? withGood(current, target)
          : mark === "bad"
            ? withBad(current, target)
            : withSkip(current, target);
      set({ bisect: next });
      await bisectStepNow();
    },

    async stopBisect() {
      const { repoId } = get();
      if (get().bisect === null) return;
      set({ bisect: null });
      if (repoId !== null) await clearDerived(derivedKey.bisect(repoId));
    },

    async restoreBisect() {
      const { repoId, bisect } = get();
      if (repoId === null || bisect !== null) return;
      const saved = await getDerived<BisectState>(derivedKey.bisect(repoId));
      if (!saved || saved.bad === "" || get().bisect !== null) return;
      set({
        bisect: {
          ...saved,
          candidate: null,
          remaining: 0,
          steps: 0,
          firstBad: null,
          picking: null,
          loading: false,
          error: null,
        },
      });
      await bisectStepNow();
    },

    async runPreflight(branchRef, ontoRef) {
      if (!get().repo) return;
      get().setMode("branches");
      set({ preflight: { ...INITIAL_PREFLIGHT, branch: branchRef, onto: ontoRef, loading: true } });
      /** The pair this call answers; a second `Preflight rebase…` makes it stale. */
      const current = () => {
        const p = get().preflight;
        return p.branch === branchRef && p.onto === ontoRef;
      };
      try {
        const result = await client().rebasePreflight(branchRef, ontoRef);
        if (!current()) return;
        set({
          preflight: { branch: branchRef, onto: ontoRef, result, loading: false, error: null },
        });
      } catch (e) {
        const err = toUiError(e);
        const stale = err.code === "STALE" || err.code === "CANCELLED";
        if (stale) ignoreStale(e);
        if (!current()) return;
        set({
          preflight: {
            branch: branchRef,
            onto: ontoRef,
            result: null,
            loading: false,
            error: stale ? null : err,
          },
        });
      }
    },

    closePreflight() {
      if (get().preflight === INITIAL_PREFLIGHT) return;
      set({ preflight: INITIAL_PREFLIGHT });
    },

    // ---- Export (T11.10, Design §14.6, atlas tab 12) ----

    setExportOpen(open) {
      const s = get();
      if (!open) {
        set({ export: { ...s.export, open: false, pending: null } });
        return;
      }
      if (!s.export.open) set({ export: { ...s.export, open: true } });
      const generation = s.diff?.generation ?? null;
      if (generation === null) return;
      // The scope is the current filter: `null` is the whole comparison, an array the rows the
      // sidebar and the pane are showing (Design §14.6 "this comparison · N files").
      const ids = s.filter.trim() === "" ? null : selectVisibleFiles(s).map((f) => f.id);
      const same =
        s.export.generation === generation &&
        (s.export.ids === null) === (ids === null) &&
        (ids === null || (s.export.ids as string[]).join("\u0000") === ids.join("\u0000"));
      if (same && (s.export.status === "ready" || s.export.status === "preparing")) return;
      set({
        export: { ...get().export, status: "preparing", error: null, generation, ids, patch: "" },
      });
      void (async () => {
        try {
          const patch = await client().patchText(generation, ids);
          const cur = get();
          if (cur.diff?.generation !== generation || cur.export.generation !== generation) return;
          const files = ids === null ? cur.diff.files : selectVisibleFiles(cur);
          const snapshot = snapshotFor({
            repo: cur.repo?.name ?? "repository",
            label: cur.diffSource ? labelOf(cur.diffSource) : "",
            at: Date.now(),
            patch,
            files,
            statsOf: (f) => cur.stats[f.id] ?? f.stats ?? null,
            viewedOf: (f) => isViewed(cur, f),
          });
          set({ export: { ...get().export, status: "ready", patch, snapshot } });
        } catch (e) {
          // A superseded render is normal (one `patchText` in flight per session); a real failure
          // is printed in the menu instead of leaving the sizes blank forever.
          ignoreStale(e);
          const err = toUiError(e);
          if (err.code === "STALE" || err.code === "CANCELLED") return;
          if (get().export.generation !== generation) return;
          set({ export: { ...get().export, status: "failed", error: err.message } });
        }
      })();
    },

    async requestExport(req) {
      const s = get();
      if (!s.diff || s.export.busy !== null) return;
      const generation = s.diff.generation;
      const gate = selectSecretGate(s);
      // `scanned: false` is *unknown*, not clean (contracts `<!-- T11.9 -->`): both it and a real
      // finding stop an export that would carry the lines.
      const clear = gate.scanned && gate.count === 0;
      if (carriesLines(req.kind) && !clear && s.export.confirmed !== generation) {
        set({ export: { ...s.export, open: true, pending: req } });
        return;
      }
      const repo = s.repo?.name ?? "repository";
      const label = s.diffSource ? labelOf(s.diffSource) : "";
      const at = Date.now();
      const scopeIds = s.filter.trim() === "" ? null : selectVisibleFiles(s).map((f) => f.id);
      const ids = req.ids === undefined ? scopeIds : req.ids;
      const statsOf = (f: FileDiff) => s.stats[f.id] ?? f.stats ?? null;
      const viewedOf = (f: FileDiff) => isViewed(s, f);
      const findings = selectSecrets(s);
      /** True when the menu already rendered exactly these rows of exactly this generation. */
      const prepared =
        s.export.status === "ready" &&
        s.export.generation === generation &&
        (s.export.ids === null) === (ids === null) &&
        (ids === null ||
          (s.export.ids as string[]).join("\u0000") === (ids as string[]).join("\u0000"));
      /** The prepared bytes when they cover exactly this request, a fresh render otherwise. */
      const patchFor = async (): Promise<string> =>
        prepared ? s.export.patch : await client().patchText(generation, ids);
      const tell = (ok: boolean, note: string) =>
        get().addToast(
          ok ? { level: "info", message: note } : { level: "warning", message: COPY_FAILED },
        );
      set({ export: { ...s.export, busy: req.kind, pending: null } });
      try {
        switch (req.kind) {
          case "copy-list": {
            // Text diffgit writes *about* the diff, so Design §14.3's "masked everywhere including
            // copy" applies; the patch and the snapshot below are the user's own lines verbatim,
            // because a masked patch is one `git apply` rejects.
            const list = fileListMarkdown(selectVisibleFiles(s), statsOf, viewedOf);
            tell(await copyText(redactFindings(list, findings)), copiedNote(req.kind));
            break;
          }
          case "copy-stats": {
            const line = statsLine(selectVisibleFiles(s), statsOf);
            tell(await copyText(redactFindings(line, findings)), copiedNote(req.kind));
            break;
          }
          case "copy-patch": {
            tell(await copyText(await patchFor()), copiedNote(req.kind));
            break;
          }
          case "save-patch":
          case "file-patch":
          case "commit-patch": {
            const file =
              req.kind === "file-patch"
                ? s.diff.files.find((f) => f.id === (ids?.[0] ?? ""))
                : undefined;
            const name =
              req.kind === "commit-patch" && req.oid !== undefined
                ? commitPatchName(repo, req.oid, at)
                : file
                  ? filePatchName(repo, file.newPath ?? file.oldPath ?? file.id, at)
                  : exportFileName(repo, label, "patch", at);
            const saved = downloadText(name, await patchFor(), PATCH_MIME);
            tell(saved, savedNote(name));
            break;
          }
          case "snapshot": {
            const patch = await patchFor();
            const files = ids === null ? s.diff.files : selectVisibleFiles(s);
            const html =
              prepared && s.export.snapshot !== "" && clear
                ? s.export.snapshot
                : snapshotFor({
                    repo,
                    label,
                    at,
                    patch,
                    files,
                    statsOf,
                    viewedOf,
                    ...(clear ? {} : { warning: exportedPastGate(gate) }),
                  });
            const name = exportFileName(repo, label, "html", at);
            tell(downloadText(name, html, HTML_MIME), savedNote(name));
            break;
          }
        }
      } catch (e) {
        ignoreStale(e);
        const err = toUiError(e);
        if (err.code !== "STALE" && err.code !== "CANCELLED")
          get().addToast({ level: "warning", message: exportFailed(err.message) });
      } finally {
        set({ export: { ...get().export, busy: null } });
      }
    },

    async confirmExport() {
      const s = get();
      if (!s.diff) return;
      const req = s.export.pending;
      // With no parked request this is the menu's own `Export anyway` link, which unlocks the three
      // line-carrying rows for this generation; with one, it also runs it.
      set({ export: { ...s.export, pending: null, confirmed: s.diff.generation } });
      if (req) await get().requestExport(req);
    },

    cancelExport() {
      set({ export: { ...get().export, pending: null } });
    },

    // ---- Home dashboard (T11.11, Design §14.6) --------------------------------------------------

    async loadSummaries(repos, opts = {}) {
      summaryTicket++;
      const ticket = summaryTicket;
      const alive = () => summaryTicket === ticket;
      const patch = (id: string, next: Partial<DashboardEntry>) => {
        set((s) => ({
          dashboard: {
            summaries: {
              ...s.dashboard.summaries,
              [id]: { ...(s.dashboard.summaries[id] ?? EMPTY_DASHBOARD_ENTRY), ...next },
            },
          },
        }));
      };

      // 1. Every card shows what is already known before anything is computed (the atlas's first
      //    mitigation: "show cards from cache immediately"). The derived store is only asked for
      //    the cards this session has not filled yet.
      for (const repo of repos) {
        if (!alive()) return;
        if (get().dashboard.summaries[repo.id]?.summary) continue;
        const hit = await getDerived<RepoSummary>(derivedKey.summary(repo.id));
        if (!alive()) return;
        if (hit) patch(repo.id, { summary: hit, mtime: hit.indexMtimeMs });
      }

      // 2. …then the repositories themselves, one session at a time, granted handles only.
      const runOne = async (repo: DashboardRepo) => {
        const mtime = await indexMtimeOf(repo.handle);
        if (!alive()) return;
        if (mtime !== null) patch(repo.id, { mtime });
        const cached = get().dashboard.summaries[repo.id]?.summary ?? null;
        // Design §14.6 / atlas tab 11: revalidate only when the index moved under the cache.
        if (!opts.force && cached && mtime !== null && cached.indexMtimeMs === mtime) return;
        patch(repo.id, { loading: true, error: null });
        let session: WorkerClient | null = null;
        try {
          session = newSummaryClient();
          await session.open(repo.handle, SILENT_SINK);
          const summary = await session.summarise();
          if (!alive()) return;
          // The engine's own reading of `.git/index` is the authority on how fresh this card is.
          patch(repo.id, { summary, mtime: summary.indexMtimeMs, loading: false, error: null });
          void setDerived(derivedKey.summary(repo.id), summary);
        } catch (e) {
          const err = toUiError(e);
          const stale = err.code === "STALE" || err.code === "CANCELLED";
          if (stale) ignoreStale(e);
          if (!alive()) return;
          patch(repo.id, { loading: false, error: stale ? null : err });
        } finally {
          try {
            await session?.close();
          } catch (e) {
            // the session is being discarded anyway; a failed close is not the user's problem
            console.warn("loadSummaries: closing the summary session failed", e);
          }
          session?.terminate();
        }
      };

      const queue = repos.filter((r) => r.access === "granted");
      const lanes = Math.max(1, Math.min(SUMMARY_CONCURRENCY, queue.length));
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          while (alive()) {
            const next = queue.shift();
            if (!next) return;
            await runOne(next);
          }
        }),
      );
    },

    cancelSummaries() {
      summaryTicket++;
      const { summaries } = get().dashboard;
      const entries = Object.entries(summaries);
      if (!entries.some(([, e]) => e.loading)) return;
      set({
        dashboard: {
          summaries: Object.fromEntries(
            entries.map(([id, e]) => [id, e.loading ? { ...e, loading: false } : e]),
          ),
        },
      });
    },
  };
});

/**
 * The instant the period chips count back from (T11.12): the newest commit date the store already
 * knows — the tip of the commit list, or the newest branch tip the overview carries — and the wall
 * clock only when it knows none. The engine has no clock of its own (contracts `<!-- T10.9 -->`:
 * `activity` ends at the week of the newest commit), and the derived cache is keyed by tip oid and
 * period, so anchoring on a commit keeps `90 d` meaning the same window for as long as that key is
 * valid, and gives a repository whose last commit is a year old something to show.
 */
export function selectInsightsAnchor(
  s: Pick<StoreState, "history" | "branches">,
  now = Date.now(),
): number {
  let newest = 0;
  for (const c of s.history.commits) newest = Math.max(newest, c.author.timestamp);
  for (const r of s.branches.rows ?? []) newest = Math.max(newest, r.lastCommit?.timestamp ?? 0);
  return newest > 0 ? newest : now;
}

/**
 * T11.13: the pair the palette's `Preflight rebase of compare onto base` would ask about — the
 * compare side while it is a plain branch, and `selectBranchBase`'s base. Null when the compare
 * side is a range, a tag or a stash (there is no branch to rebase), or when the two are the same
 * branch. Both sides are the **display** names, because they are also what the engine puts into
 * `git rebase -i <onto>`: `refs/heads/main` there would be a command nobody types.
 */
export function selectPreflightPair(
  s: Pick<StoreState, "repo" | "compareBase" | "diffSource">,
): { branch: string; onto: string } | null {
  const base = selectBranchBase(s);
  const src = s.diffSource;
  if (base === null || src === null || src.kind !== "branches") return null;
  return src.source === base.display ? null : { branch: src.source, onto: base.display };
}

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

/**
 * T11.4: the rows of the Hidden group, or null while the group is not up (toggle off, or the
 * listing walk has not answered yet). The path part of the file filter applies, so filtering
 * narrows the Hidden group the same way it narrows the layer groups; the `status:` / `layer:`
 * tokens do not, because a hidden path has neither.
 */
let hiddenCache: { entries: HiddenEntry[]; path: string; result: HiddenEntry[] } | null = null;
export function selectHiddenEntries(
  s: Pick<StoreState, "hidden" | "prefs" | "filter">,
): HiddenEntry[] | null {
  if (!s.prefs.showHidden || s.hidden === null) return null;
  const path = parseFilter(s.filter).path;
  if (hiddenCache && hiddenCache.entries === s.hidden && hiddenCache.path === path)
    return hiddenCache.result;
  const match = makePathFilter(path);
  const result = path === "" ? s.hidden : s.hidden.filter((e) => match(e.path));
  hiddenCache = { entries: s.hidden, path, result };
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

/**
 * T11.5: the commit rows the History list shows — everything walked so far, narrowed by the search
 * box (subject, author, email, oid prefix or a ref name). Memoised on the list and the query, like
 * `selectVisibleFiles`, so scrolling never re-filters.
 */
let historyCache: { commits: CommitSummary[]; query: string; result: CommitSummary[] } | null =
  null;
export function selectHistoryRows(s: Pick<StoreState, "history">): CommitSummary[] {
  const { commits, query } = s.history;
  if (historyCache && historyCache.commits === commits && historyCache.query === query)
    return historyCache.result;
  const result = query.trim() === "" ? commits : commits.filter((c) => matchesCommit(c, query));
  historyCache = { commits, query, result };
  return result;
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

// ---- Secret scan selectors (T11.9, Design §14.3) ----

const NO_SECRETS: readonly SecretFinding[] = [];

/** Findings of the current diff, in the engine's order; empty while nothing has been scanned. */
export function selectSecrets(s: Pick<StoreState, "secrets">): readonly SecretFinding[] {
  return s.secrets ?? NO_SECRETS;
}

/** File id → number of findings in it, for the sidebar's `secret` chip (shallow-compared). */
let secretCountCache: {
  findings: readonly SecretFinding[];
  result: Record<string, number>;
} | null = null;
export function selectSecretCounts(s: Pick<StoreState, "secrets">): Record<string, number> {
  const findings = selectSecrets(s);
  if (secretCountCache && secretCountCache.findings === findings) return secretCountCache.result;
  const result: Record<string, number> = {};
  for (const f of findings) result[f.fileId] = (result[f.fileId] ?? 0) + 1;
  secretCountCache = { findings, result };
  return result;
}

/** Findings of one file card, memoised on the list so a re-render never re-filters. */
let secretByFileCache: {
  findings: readonly SecretFinding[];
  result: Map<string, SecretFinding[]>;
} | null = null;
export function selectFileSecrets(
  s: Pick<StoreState, "secrets">,
  id: string,
): readonly SecretFinding[] {
  const findings = selectSecrets(s);
  if (!secretByFileCache || secretByFileCache.findings !== findings) {
    const result = new Map<string, SecretFinding[]>();
    for (const f of findings) {
      const bucket = result.get(f.fileId);
      if (bucket) bucket.push(f);
      else result.set(f.fileId, [f]);
    }
    secretByFileCache = { findings, result };
  }
  return secretByFileCache.result.get(id) ?? NO_SECRETS;
}

/**
 * The gate T11.10's export flow asks before it writes anything ("there are N secrets in this diff
 * — export anyway?"). `total` is `SECRETS_FOUND.detail`, which counts past the 500-finding cap, so
 * the dialog can say how many exist and how many it can list. `scanned` is false while the current
 * diff has not been scanned at all, which an export must treat as "unknown", not as "clean".
 */
export interface SecretGate {
  scanned: boolean;
  findings: readonly SecretFinding[];
  /** Findings listed (capped at `SECRET_FINDING_CAP`). */
  count: number;
  /** Findings the engine actually saw; equals `count` unless the list was cut. */
  total: number;
}
let gateCache: {
  secrets: SecretFinding[] | null;
  warnings: RepoWarning[];
  result: SecretGate;
} | null = null;
export function selectSecretGate(s: Pick<StoreState, "secrets" | "warnings">): SecretGate {
  // Memoised on identity like `selectVisibleFiles`: the banner subscribes to it, and a fresh
  // object every render is an infinite `useSyncExternalStore` loop.
  if (gateCache && gateCache.secrets === s.secrets && gateCache.warnings === s.warnings)
    return gateCache.result;
  const findings = selectSecrets(s);
  const detail = s.warnings.find((w) => w.code === "SECRETS_FOUND")?.detail;
  const reported = detail === undefined ? Number.NaN : Number.parseInt(detail, 10);
  const result: SecretGate = {
    scanned: s.secrets !== null,
    findings,
    count: findings.length,
    total: Number.isFinite(reported) ? Math.max(reported, findings.length) : findings.length,
  };
  gateCache = { secrets: s.secrets, warnings: s.warnings, result };
  return result;
}
