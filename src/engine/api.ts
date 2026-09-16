/**
 * The worker API contract shared by the engine (`RepoSession`, T3.5) and the UI (`WorkerClient`,
 * T4.1). Everything here is structured-cloneable: no classes, no Maps, no functions except the
 * methods of `ProgressSink`, which comlink proxies.
 *
 * `RepoInfo` structurally satisfies `RefSnapshot`, so the UI can call `isWorktreeSource(src, info)`.
 */
import type { EngineErrorJSON, PublicCode } from "./errors";
import type { DiffResult, DiffSource, FileDiff, RepoInfo, RepoWarning } from "./types";

export type ProgressPhase =
  | "layout"
  | "config"
  | "refs"
  | "index"
  | "worktree"
  | "diff"
  | "renames"
  | "stats"
  | "probe";

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
  open(handle: unknown, sink: ProgressSink): Promise<RepoInfo>;
  info(): Promise<RepoInfo>;
  reloadRefs(): Promise<RepoInfo>;
  /** Cancels any in-flight compute; the superseded call rejects with `CANCELLED`. */
  computeDiff(src: DiffSource): Promise<DiffResult>;
  fileStats(generation: number, ids: string[]): Promise<Record<string, FileStats>>;
  fileDiff(generation: number, id: string, opts: FileDiffOptions): Promise<FileDiffPayload>;
  cancelFileDiff(id: string): Promise<void>;
  fileBytes(generation: number, id: string, side: "old" | "new"): Promise<Uint8Array | null>;
  /** Move these files to the front of the background stats queue (visible sidebar rows). */
  prioritise(ids: string[]): Promise<void>;
  /** Cheap change signature per tier for the polling fallback (T6.3). */
  probe(tier: ProbeTier): Promise<string>;
  invalidate(scope: InvalidateScope, paths?: string[]): Promise<void>;
  forceRehash(): Promise<void>;
  close(): Promise<void>;
}
