/**
 * Copy and maths for the Home dashboard (T11.11, Design §14.6, atlas tab 11): the repository cards
 * and the background summariser that fills them. Pure — `RepoCard` renders what this returns and
 * the tests assert the wording here rather than through the DOM — with one exception at the bottom,
 * `indexMtimeOf`, which reads a directory handle and is documented there.
 */
import type { ChangeLayer, RepoOperation, RepoSummary } from "../engine/types";

/**
 * How many summaries run at once. The atlas is explicit ("sequential, cancellable, only while the
 * dashboard is visible"): each summary opens a throw-away engine session of its own, and twenty of
 * them at once is the "twenty scans eat CPU and battery" risk the same tab lists. One at a time,
 * newest repository first, is also the order the user reads the cards in.
 */
export const SUMMARY_CONCURRENCY = 1;

/** What the summariser needs to know about one card. `handle` is the stored directory handle. */
export interface DashboardRepo {
  id: string;
  name: string;
  handle: unknown;
  /** The browser's answer to `queryPermission()`; only `granted` is summarised (no prompt on load). */
  access: "granted" | "prompt" | "denied";
}

/** The four counted layers of `RepoSummary.counts`, in the order the card shows them. */
export type CountKind = Exclude<ChangeLayer, "committed">;
export const COUNT_ORDER: readonly CountKind[] = ["staged", "unstaged", "untracked", "conflict"];

/** The non-zero layers of a summary, in `COUNT_ORDER`; empty means the working tree is clean. */
export function countChips(counts: RepoSummary["counts"]): { kind: CountKind; count: number }[] {
  return COUNT_ORDER.filter((k) => counts[k] > 0).map((kind) => ({ kind, count: counts[kind] }));
}

/** The atlas's `clean` chip, shown in place of the layer chips when nothing is uncommitted. */
export const CLEAN_LABEL = "clean";

/**
 * The operation tag in the card's top-right corner: `rebase 3/7`, `merge`, `bisect`. The full
 * sentence is the repo screen's banner (Design §14.3); a card has room for the kind and the step.
 */
export function operationTag(op: RepoOperation | null): string | null {
  if (!op) return null;
  return op.step !== undefined && op.total !== undefined
    ? `${op.kind} ${op.step}/${op.total}`
    : op.kind;
}

/** Why the card is dashed and has no summary: the browser has not granted this handle yet. */
export const NEEDS_PERMISSION = "needs permission";
export const NEEDS_PERMISSION_TITLE =
  "The browser asks for read access once per visit unless diffgit is installed. Nothing is read until you allow it.";
export const GRANT_LABEL = "Re-authorise";

/** The line under the name of a card that has never been summarised (atlas: `last seen on …`). */
export function lastSeenLine(compare: string): string {
  return `last seen on ${compare}`;
}

/**
 * `last commit 2 d ago`, or null when the summary carries no commit — an unborn HEAD, or an engine
 * that could not read the tip. The card prints nothing rather than a sentence it cannot stand
 * behind ("no commits yet" would be a claim about the repository, not about the summary).
 */
export function lastCommitLine(
  summary: Pick<RepoSummary, "lastCommit">,
  ago: (timestamp: number) => string,
): string | null {
  return summary.lastCommit === null ? null : `last commit ${ago(summary.lastCommit.timestamp)}`;
}

/**
 * The stale marker (atlas tab 11: "a stale marker when a card's summary is older than its index
 * mtime"). `mtime` is what the last cheap stat of `.git/index` saw; `summary.indexMtimeMs` is what
 * the engine read when it produced the summary. They differ exactly while the working tree has
 * moved on since the card was computed — which is also the condition that makes the summariser
 * re-read it, so the marker normally shows for as long as that one call takes.
 */
export function isStale(entry: { summary: RepoSummary | null; mtime: number | null }): boolean {
  return (
    entry.summary !== null && entry.mtime !== null && entry.mtime !== entry.summary.indexMtimeMs
  );
}

export const STALE_LABEL = "stale";
export const STALE_TITLE =
  "The index has changed since this summary was read; the card is being refreshed.";

/** Header controls of the card grid (the panel's own header, never the app's chrome). */
export const REFRESH_ALL = "Refresh all";
export const REFRESH_ALL_TITLE =
  "Re-read every repository you have granted access to, ignoring the cached summaries.";
export const SUMMARISING = "Reading…";

/** The title behind the ahead/behind pair: `RepoSummary` carries the counts, not the upstream name. */
export const UPSTREAM_TITLE = "Commits ahead of and behind the upstream branch.";

/**
 * `lastModified` of `<repo>/.git/index`, or null when it cannot be read — **the one impure helper
 * in this module**, and the "cheap stat" the task asks for: it is what `IndexReader` itself keys
 * `RepoSummary.indexMtimeMs` on (`file.lastModified` in `src/engine/git/indexReader.ts`), so the
 * two numbers are comparable, and reading it here costs one file handle instead of a worker, an
 * `open()` and a scan. No `EngineApi.statIndex` was added for it: the engine's entry points all
 * open a session first, which is exactly the cost this check exists to avoid.
 *
 * Read-only (D16: no `create`, no `getFileHandle` write mode). A handle without the API — an E2E
 * marker, a test double, a repository whose `.git` is a file (worktree gitdir) — answers null,
 * which the caller reads as "cannot tell": it re-summarises rather than trusting the cache.
 */
export async function indexMtimeOf(handle: unknown): Promise<number | null> {
  const dir = handle as {
    getDirectoryHandle?: (name: string) => Promise<{
      getFileHandle?: (
        name: string,
      ) => Promise<{ getFile?: () => Promise<{ lastModified: number }> }>;
    }>;
  };
  if (typeof dir?.getDirectoryHandle !== "function") return null;
  try {
    const git = await dir.getDirectoryHandle(".git");
    if (typeof git?.getFileHandle !== "function") return null;
    const entry = await git.getFileHandle("index");
    if (typeof entry?.getFile !== "function") return null;
    const file = await entry.getFile();
    return typeof file?.lastModified === "number" ? file.lastModified : null;
  } catch {
    // A missing index, a lapsed permission or a gitdir file: "cannot tell", never an error the
    // dashboard shows. The summarise call that follows is what really answers.
    return null;
  }
}
