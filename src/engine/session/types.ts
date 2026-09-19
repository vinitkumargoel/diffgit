import type { FileStats } from "../api";
import type { DiffComputation } from "../diff/diffEngine";
import { EngineError } from "../errors";
import type { ScannerOptions } from "../git/worktree";
import type { DiffResult, DiffSource, FileDiff, RepoOperation, RepoWarning } from "../types";

export interface SessionOptions {
  scanner?: ScannerOptions;
  /** Background stats concurrency (default 4). */
  statsConcurrency?: number;
  /** Flush a stats batch after this many files or this many ms, whichever first. */
  statsBatchSize?: number;
  statsBatchMs?: number;
  /** Fixed repo id (tests/recordings); default `crypto.randomUUID()`. */
  id?: string;
  /**
   * T10.4: apply the built-in excludes (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) in
   * `IgnoreRules`. Default true; `OpenOptions.builtinExcludes` is how the page sets it (B10).
   */
  builtinExcludes?: boolean;
}

export interface Current {
  generation: number;
  source: DiffSource;
  comp: DiffComputation;
  result: DiffResult;
  byId: Map<string, FileDiff>;
  stats: Map<string, FileStats>;
}

export interface StatsItem {
  id: string;
  stats: FileStats;
}

export interface FileDiffState {
  file: FileDiff;
  stats?: FileStats;
}

export const NO_SESSION = () => new EngineError("INTERNAL", "No repository is open.");
/** Plan §11 R3: warn when the packs read so far exceed this. */
export const MEMORY_WARN_BYTES = 300 * 1024 * 1024;
/** How many stashes get a file count eagerly (T10.1); the rest keep `files: null`. */
export const STASH_FILE_COUNT_LIMIT = 50;

export function requireGeneration(cur: Current | null, generation: number): Current {
  if (!cur || cur.generation !== generation) {
    throw new EngineError(
      "STALE",
      `Diff generation ${generation} is no longer current${cur ? ` (now ${cur.generation})` : ""}.`,
    );
  }
  return cur;
}

export function requireFile(cur: Current, id: string): FileDiff {
  const f = cur.byId.get(id);
  if (!f)
    throw new EngineError("INTERNAL", `Unknown file id "${id}" in generation ${cur.generation}.`);
  return f;
}

export function isDiffComputation(v: unknown): v is DiffComputation {
  return typeof v === "object" && v !== null && Array.isArray((v as DiffComputation).warnings);
}

/** The one `OPERATION_IN_PROGRESS` warning a session records (docs/errors.md owns the UI copy). */
export function operationWarning(op: RepoOperation): RepoWarning {
  const where = op.step && op.total ? ` (step ${op.step} of ${op.total})` : "";
  return {
    code: "OPERATION_IN_PROGRESS",
    message: `A ${op.kind} is in progress in this repository${where}.`,
    ...(op.conflicts > 0
      ? { detail: `${op.conflicts} path${op.conflicts === 1 ? "" : "s"} still conflict.` }
      : {}),
  };
}

export function dedupe(ws: RepoWarning[]): RepoWarning[] {
  const seen = new Set<string>();
  return ws.filter((w) => {
    const k = `${w.code}:${w.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
