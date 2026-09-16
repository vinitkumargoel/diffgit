/**
 * FileSystemObserver wiring (T6.2, Plan §5.7). Feature-detected; `startObserver` returns `null`
 * when the API is missing so the scheduler falls back to polling. Records are classified into
 * git-tier changes, worktree paths and config edits; `.git/objects/**`, lock files and editor
 * temp files are ignored. Lifecycle, toasts and degradation belong to the scheduler (T6.1).
 *
 * Rules are the provisional set from the task file; Spike S3 (T6.0, pending owner run) may
 * tune them — see docs/engine-notes.md "S3 results".
 */
import type { UiError } from "../errors";
import { CONFIG_PATH, type ObserverStarter } from "./scheduler";

export type ObserverRecordType =
  | "appeared"
  | "disappeared"
  | "modified"
  | "moved"
  | "unknown"
  | "errored";

/** The subset of `FileSystemChangeRecord` we read (kept structural for the E2E stub). */
export interface ObserverRecord {
  type: ObserverRecordType | string;
  relativePathComponents?: readonly string[] | null;
  relativePathMovedFrom?: readonly string[] | null;
  changedHandle?: { kind?: string } | null;
}

export interface Classification {
  /** Refs / HEAD / index / packed-refs changed → reload refs + recompute. */
  git: boolean;
  /** Working-tree paths (repo-relative, POSIX) that changed. */
  worktree: string[];
  /** `.git/config`, `.git/info/exclude`, `.gitignore`, `.gitattributes` edits. */
  config: boolean;
  /** Ignored records (objects, locks, temp files) — for diagnostics. */
  ignored: number;
  /** An `errored` / `disappeared`-root record: the observer must stop. */
  fatal: "errored" | "disappeared" | null;
}

const GIT_TIER = new Set([
  ".git/HEAD",
  ".git/index",
  ".git/packed-refs",
  ".git/ORIG_HEAD",
  ".git/MERGE_HEAD",
  ".git/FETCH_HEAD",
  ".git/logs/HEAD",
]);

/** Editor and tool scratch files that never change the diff. */
const TEMP_FILE =
  /(~$|\.swp$|\.swx$|\.swo$|\.tmp$|\.temp$|^4913$|^\.#|^#.*#$|\.crswap$|^\.~lock\.)/;

export function classifyPath(path: string): "git" | "config" | "worktree" | "ignore" {
  if (path === "" || path === ".git") return "ignore";
  if (CONFIG_PATH.test(path)) return "config";
  if (path.startsWith(".git/")) {
    if (path.endsWith(".lock")) return "ignore";
    if (path.startsWith(".git/objects/")) return "ignore";
    if (GIT_TIER.has(path)) return "git";
    if (path.startsWith(".git/refs/") || path.startsWith(".git/logs/refs/")) return "git";
    if (path.startsWith(".git/worktrees/") || path.startsWith(".git/modules/")) return "git";
    return "ignore";
  }
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (TEMP_FILE.test(base)) return "ignore";
  return "worktree";
}

export function classifyPaths(records: readonly ObserverRecord[]): Classification {
  const out: Classification = { git: false, worktree: [], config: false, ignored: 0, fatal: null };
  const seen = new Set<string>();
  const add = (path: string) => {
    const kind = classifyPath(path);
    if (kind === "ignore") out.ignored++;
    else if (kind === "git") out.git = true;
    else if (kind === "config") out.config = true;
    else if (!seen.has(path)) {
      seen.add(path);
      out.worktree.push(path);
    }
  };
  for (const r of records) {
    if (r.type === "errored") {
      out.fatal = "errored";
      continue;
    }
    const comps = r.relativePathComponents ?? [];
    if (r.type === "disappeared" && comps.length === 0) {
      out.fatal = "disappeared";
      continue;
    }
    add(comps.join("/"));
    if (r.type === "moved" && r.relativePathMovedFrom && r.relativePathMovedFrom.length > 0)
      add(r.relativePathMovedFrom.join("/"));
  }
  out.worktree.sort();
  return out;
}

interface ObserverLike {
  observe(handle: unknown, opts?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}
type ObserverCtor = new (
  cb: (records: ObserverRecord[], observer: ObserverLike) => void,
) => ObserverLike;

export function observerSupported(win: unknown = globalThis): boolean {
  return (
    typeof win === "object" &&
    win !== null &&
    typeof (win as { FileSystemObserver?: unknown }).FileSystemObserver === "function"
  );
}

export interface StartObserverOptions {
  /** Test seam; defaults to `globalThis.FileSystemObserver`. */
  ctor?: ObserverCtor;
}

/**
 * Observe `handle` recursively and report classified changes. Returns `null` when unsupported.
 * `onError` fires once for `errored` / root `disappeared` records or an `observe()` failure; the
 * caller (scheduler) decides what to do next.
 */
export function startObserver(
  handle: unknown,
  onRecords: (git: boolean, worktree: string[], config: boolean) => void,
  onError: (error: UiError) => void,
  opts: StartObserverOptions = {},
): (() => void) | null {
  const Ctor =
    opts.ctor ??
    (observerSupported()
      ? ((globalThis as unknown as { FileSystemObserver: ObserverCtor })
          .FileSystemObserver as ObserverCtor)
      : null);
  if (!Ctor) return null;
  let stopped = false;
  let observer: ObserverLike | null = null;
  const fail = (error: UiError) => {
    if (stopped) return;
    stop();
    onError(error);
  };
  const stop = () => {
    stopped = true;
    try {
      observer?.disconnect();
    } catch {
      // disconnect after the handle vanished may throw; nothing left to release
    }
    observer = null;
  };
  try {
    observer = new Ctor((records) => {
      if (stopped) return;
      const c = classifyPaths(records);
      if (c.fatal) {
        fail({
          code: c.fatal === "disappeared" ? "HANDLE_GONE" : "INTERNAL",
          message:
            c.fatal === "disappeared"
              ? "The repository folder disappeared."
              : "The file system observer reported an error.",
        });
        return;
      }
      if (c.git || c.config || c.worktree.length > 0) onRecords(c.git, c.worktree, c.config);
    });
    observer.observe(handle, { recursive: true }).catch((e: unknown) => {
      const name = (e as { name?: string } | null)?.name;
      fail({
        code: name === "NotAllowedError" || name === "SecurityError" ? "PERMISSION" : "INTERNAL",
        message: `FileSystemObserver.observe() failed: ${(e as Error)?.message ?? String(e)}`,
      });
    });
  } catch (e) {
    return fail({ code: "INTERNAL", message: `FileSystemObserver failed: ${String(e)}` }), stop;
  }
  return stop;
}

/** The starter the scheduler expects. */
export const observerStarter: ObserverStarter = (handle, onRecords, onError) =>
  startObserver(handle, onRecords, onError);
