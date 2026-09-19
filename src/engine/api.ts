/**
 * The worker API contract shared by the engine (`RepoSession`, T3.5) and the UI (`WorkerClient`,
 * T4.1). Everything here is structured-cloneable: no classes, no Maps, no functions except the
 * methods of `ProgressSink`, which comlink proxies.
 *
 * `RepoInfo` structurally satisfies `RefSnapshot`, so the UI can call `isWorktreeSource(src, info)`.
 */
import type { EngineErrorJSON, PublicCode } from "./errors";
import type {
  AheadBehind,
  BlamePayload,
  BranchRow,
  CommitDetails,
  DiffResult,
  DiffSource,
  FileDiff,
  HiddenEntry,
  Oid,
  PathExplanation,
  PathHistoryEntry,
  ReflogEntry,
  RepoInfo,
  RepoOperation,
  RepoWarning,
  ResolvedRevision,
  SecretFinding,
  StashInfo,
  TagInfo,
  WalkPage,
  WalkRequest,
} from "./types";

export type ProgressPhase =
  | "layout"
  | "config"
  | "refs"
  | "index"
  | "worktree"
  | "diff"
  | "renames"
  | "stats"
  | "probe"
  /** T10.5: a page of `walkCommits` (`done` = rows emitted). */
  | "history"
  /** T10.6: one revision of `blame` (`done`/`total` = revisions reverse-diffed). */
  | "blame"
  /** T10.7: the secret scan (`done`/`total` = files scanned). */
  | "secrets";

export interface Progress {
  phase: ProgressPhase;
  done?: number;
  total?: number;
  durationMs?: number;
  /** For `probe`: which tier was measured. */
  tier?: ProbeTier;
}

export type FileStats = FileDiff["stats"]; // { additions, deletions } | null (null = binary / not text-diffable)

export interface StatsBatch {
  generation: number;
  stats: Record<string, FileStats>;
}

/** The single proxied sink registered at `open()` (T3.5 amendment: no per-call proxies). */
export interface ProgressSink {
  onProgress(p: Progress): void;
  onStats(batch: StatsBatch): void;
  onWarning(w: RepoWarning): void;
}

export type ProbeTier = "git" | "index" | "untracked";
export type InvalidateScope = "refs" | "worktree" | "all";

export interface HunkLine {
  type: "ctx" | "add" | "del";
  old?: number; // 1-based line number on the old side (ctx/del)
  new?: number; // 1-based line number on the new side (ctx/add)
  text: string; // without trailing newline
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

export interface HunkModel {
  oldLines: number;
  newLines: number;
  hunks: Hunk[];
}

export interface FileClassification {
  binary: boolean;
  image: boolean; // by extension (rendering hint)
  tooLarge: boolean; // > 1 MB either side or > 3000 changed lines: UI gates behind "Load diff"
  huge: boolean; // > 10 MB: never rendered
  typechange: boolean;
  submodule: boolean;
  generated: boolean;
  whitespaceOnly: boolean; // exact hunks exist but the -w hunk set is empty
  oldSize: number;
  newSize: number;
  changedLines: number | null; // additions + deletions when known
}

export interface FileDiffPayload {
  id: string;
  generation: number;
  classification: FileClassification;
  /** null when binary / huge / submodule, or when the caller did not request hunks. */
  hunks: HunkModel | null;
  oldText: string | null;
  newText: string | null;
  language: string; // Shiki/lowlight id or "text"
  stats: FileStats;
  oldMode: number | null;
  newMode: number | null;
  /** For gitlinks: the two commit oids. */
  submodule?: { oldOid: string | null; newOid: string | null };
}

export interface FileDiffOptions {
  ignoreWhitespace: boolean;
  /** Skip hunk computation for a gated (tooLarge) file until the user clicks "Load diff". */
  loadLarge?: boolean;
}

// ---- conflicts (T10.3, atlas tab 06, Design §14.3) --------------------------------------------

/** One of the three index stages of a conflicted path, as far as the UI needs it. */
export interface SideBlob {
  oid: Oid;
  /** null when the blob is binary or larger than 1 MB (the UI gates it, like a large file). */
  text: string | null;
  size: number;
  binary: boolean;
}

/**
 * Which stages the index kept for the path, named the way `git status` names them.
 * Derived structurally from the presence of stages 1/2/3 (see `conflictKindOf`), so git's rarer
 * `AU` (added by us) folds into `deleted-by-them` and `UA` into `deleted-by-us` — in both the side
 * without a blob is the one the payload renders as absent.
 */
export type ConflictKind =
  | "both-modified"
  | "both-added"
  | "deleted-by-us"
  | "deleted-by-them"
  | "both-deleted";

/**
 * One `<<<<<<< / ======= / >>>>>>>` block in the working-tree file, as **1-based line numbers of
 * the marker lines themselves**:
 *
 * ```
 *   <<<<<<< HEAD          start
 *   ours…
 *   ||||||| base          oursEnd   (diff3 style only; otherwise oursEnd is the ======= line)
 *   base…
 *   =======               baseEnd   (diff3 style only)
 *   theirs…
 *   >>>>>>> theirs        end
 * ```
 *
 * So "ours" is `(start, oursEnd)` exclusive, "base" is `(oursEnd, baseEnd)` and "theirs" is
 * `(baseEnd ?? oursEnd, end)`.
 */
export interface ConflictMarker {
  start: number;
  end: number;
  oursEnd: number;
  baseEnd?: number;
}

/** The three-way view of one conflicted file (`EngineApi.conflict`). Nothing here is written back. */
export interface ConflictPayload {
  id: string;
  generation: number;
  /** Stage 1 / 2 / 3; null when the index kept no such stage (a deleted side). */
  base: SideBlob | null;
  ours: SideBlob | null;
  theirs: SideBlob | null;
  /** base→ours and base→theirs; null when a side is binary, gated, or both sides are absent. */
  oursHunks: HunkModel | null;
  theirsHunks: HunkModel | null;
  /** The file as the editor sees it; null when it is absent, binary or over 1 MB. */
  worktree: { text: string; markers: ConflictMarker[] } | null;
  /** The file exists in the working tree and carries no conflict markers (Design §14.3 notice). */
  resolvedInWorktree: boolean;
  kind: ConflictKind;
  /** What the two sides are called, for the column headers: e.g. `{ ours: "main", theirs: "topic" }`. */
  labels: { ours: string; theirs: string };
}

/**
 * What the page may set when it opens a repository (T10.4). Separate from `SessionOptions`, which
 * is the engine's own tuning: these are user preferences that travel across the worker boundary.
 */
/** What `EngineApi.pathHistory` accepts (T10.6). */
export interface PathHistoryOptions {
  /** Follow the rename chain (`git log --follow`); off is plain `git log -- <path>`. */
  follow: boolean;
  limit: number;
  /** Opaque continuation token from the previous page. */
  cursor?: string;
}

/** What `EngineApi.blame` accepts (T10.6). */
export interface BlameRequest {
  ignoreWhitespace: boolean;
  includeWorktree: boolean;
  maxRevisions: number;
}

export interface OpenOptions {
  /**
   * Apply diffgit's built-in excludes (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) at the
   * lowest precedence. Default true; the UI preference is backlog B10 (T11.4). With it off, a
   * `.DS_Store` shows up as untracked, exactly as git reports it.
   */
  builtinExcludes?: boolean;
}

/** Engine-side counters for the hidden debug panel and `scripts/perf.ts` (T7.2). */
export interface EngineMetrics {
  generation: number;
  computes: number;
  /** FsaFs handle cache size. */
  handleCache: number;
  io: { reads: number; bytes: number; packBytes: number; packFiles: number };
  /** Approximate bytes isomorphic-git may hold (pack + idx files read so far). */
  memoryEstimate: number;
  /** Last compute: files, wall time, background stats time. */
  lastCompute: { files: number; durationMs: number; statsMs: number | null } | null;
}

/** Shape of every error crossing the worker boundary (comlink loses prototypes). */
export interface PublicError extends EngineErrorJSON {
  code: PublicCode;
}

/**
 * What the worker exposes over comlink. One session at a time; `open` closes the previous one.
 * Mirrors `RepoSession` (T3.5). Methods that take `generation` reject with `STALE` when it is not the
 * current diff generation.
 */
export interface EngineApi {
  /** `handle` is a `FileSystemDirectoryHandle` (or an E2E memory marker). */
  open(handle: unknown, sink: ProgressSink, opts?: OpenOptions): Promise<RepoInfo>;
  info(): Promise<RepoInfo>;
  reloadRefs(): Promise<RepoInfo>;
  /** Cancels any in-flight compute; the superseded call rejects with `CANCELLED`. */
  computeDiff(src: DiffSource): Promise<DiffResult>;
  /**
   * Resolves one revision expression (T10.1): full refs, `HEAD`, short names in git's precedence,
   * 7–40 hex SHA prefixes, `~n`, `^`, `^n`, `^{}`, `stash@{n}` and chains of those. Annotated tags
   * are peeled to their commit. Rejects with `REV_NOT_FOUND`, or `REV_AMBIGUOUS` (candidate oids in
   * `detail`) when a short SHA matches more than one object.
   */
  resolveRevision(expr: string): Promise<ResolvedRevision>;
  /** Every tag, loose and packed, annotated ones peeled (T10.1). */
  listTags(): Promise<TagInfo[]>;
  /** The stash stack, newest first (T10.1). */
  listStashes(): Promise<StashInfo[]>;
  /**
   * The reflog of `expr` ("HEAD", "main", "origin/main", "refs/heads/main", "stash"), newest first
   * (T10.2). A repository that keeps none yields `[]` and a `NO_REFLOG` warning on the sink.
   * `ReflogEntry.reachable` is null here; T10.5's `markReachable` fills it in.
   */
  reflog(expr: string, limit: number): Promise<ReflogEntry[]>;
  /** What git is in the middle of, or null (T10.2). Also `RepoInfo.operation` on open/reloadRefs. */
  operation(): Promise<RepoOperation | null>;
  fileStats(generation: number, ids: string[]): Promise<Record<string, FileStats>>;
  fileDiff(generation: number, id: string, opts: FileDiffOptions): Promise<FileDiffPayload>;
  cancelFileDiff(id: string): Promise<void>;
  /**
   * The three-way view of one conflicted file (T10.3): the index stages, base→ours and base→theirs
   * hunks, and the working-tree file with its conflict markers located. `STALE` when `generation`
   * is not current, `CANCELLED` when a newer `conflict()` for the same id supersedes this one.
   */
  conflict(generation: number, id: string): Promise<ConflictPayload>;
  fileBytes(generation: number, id: string, side: "old" | "new"): Promise<Uint8Array | null>;
  /**
   * Why one path is not in the diff (T10.4): the ignore rule that matched (`git check-ignore -v`
   * terms), the index flags `skip-worktree` / `assume-unchanged`, the sparse checkout, the 10 MB
   * gate, `linguist-generated`, or `clean` when it is simply unchanged.
   */
  explainPath(path: string): Promise<PathExplanation>;
  /**
   * The sidebar's Hidden group (T10.4): ignored directories as one row with a count (never
   * descended), ignored files, the index-flagged entries, sparse directories and the files the last
   * diff found to be over 10 MB. Runs only on demand; capped at 2,000 rows (`HIDDEN_CAPPED`).
   */
  listHidden(): Promise<HiddenEntry[]>;
  /**
   * One page of history (T10.5), ordered exactly like `git log --date-order`. `from` holds
   * revision expressions (`all: true` seeds from every ref, tag and stash as well); `cursor`
   * continues the previous page and carries the lane table so the graph column stays continuous.
   * Progress phase `"history"`.
   */
  walkCommits(req: WalkRequest): Promise<WalkPage>;
  /** The CommitCard payload: body, tree, signed, note and stats vs the first parent (T10.5). */
  commitDetails(oid: Oid): Promise<CommitDetails>;
  /** `{ files, additions, deletions }` per commit vs its first parent, batched 16 at a time. */
  commitStats(oids: Oid[]): Promise<Record<Oid, CommitDetails["stats"]>>;
  /** `git rev-list --left-right --count a...b`, capped at 10,000 per side (T10.5). */
  aheadBehind(a: string, b: string): Promise<AheadBehind>;
  /** One row per ref; `vsUpstream`/`vsDefault`/`merged` are null until `branchCells` (T10.5). */
  branchOverview(): Promise<BranchRow[]>;
  /** The three expensive cells for the rows the Branches table is showing (T10.5). */
  branchCells(
    fullNames: string[],
  ): Promise<Record<string, Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">>>;
  /** Which of these commits are reachable from any ref — the reflog's "unreachable" badge. */
  markReachable(oids: Oid[]): Promise<Record<Oid, boolean>>;
  /**
   * The commits that changed one path, newest first (T10.6) — `git log -- <path>`, and with
   * `follow` the rename chain as `git log --follow` walks it, so `PathHistoryEntry.path` is the
   * name the file had at that commit. `cursor` continues where the previous page stopped.
   */
  pathHistory(
    ref: string,
    path: string,
    opts: PathHistoryOptions,
  ): Promise<{ entries: PathHistoryEntry[]; cursor: string | null }>;
  /**
   * Who wrote each line of one file (T10.6), renames followed. `includeWorktree` starts from the
   * working-tree file when it is dirty (those lines get `oid: null`), `ignoreWhitespace` applies
   * git's `-w` keys so a reindent steals no attribution, and `maxRevisions` bounds the walk
   * (`BLAME_CAPPED`, the remaining lines attributed to the oldest revision examined). Progress
   * phase `"blame"`.
   */
  blame(ref: string, path: string, opts: BlameRequest): Promise<BlamePayload>;
  /**
   * Token shapes and high-entropy strings in the **added** lines of the staged and unstaged layers
   * of generation `generation` (T10.7, atlas tab 14). Nothing leaves the machine and nothing is
   * written: the scan reuses the hunks the diff pane already computes. Findings are sorted by path
   * then line, capped at `SECRET_FINDING_CAP`, and a `SECRETS_FOUND` warning with the count goes to
   * the sink whenever there is at least one. `STALE` when `generation` is not current, `CANCELLED`
   * when a newer `scanSecrets()` supersedes this one. Progress phase `"secrets"`.
   */
  scanSecrets(generation: number): Promise<SecretFinding[]>;
  /** Move these files to the front of the background stats queue (visible sidebar rows). */
  prioritise(ids: string[]): Promise<void>;
  /** Cheap change signature per tier for the polling fallback (T6.3). */
  probe(tier: ProbeTier): Promise<string>;
  invalidate(scope: InvalidateScope, paths?: string[]): Promise<void>;
  forceRehash(): Promise<void>;
  /** Counters for the debug panel (T7.2). */
  metrics(): Promise<EngineMetrics>;
  close(): Promise<void>;
}
