import type { FileStats } from "../../engine/api";
import { isWorktreeSource } from "../../engine/diffSource";
import type {
  BranchesSource,
  DiffSource,
  FileDiff,
  RepoInfo,
  RepoRef,
  RepoWarning,
  TagInfo,
} from "../../engine/types";
import type { SideRev } from "../compareSource";
import { toUiError } from "../errors";
import { SNAPSHOT_WARNING, type StoreState } from "./types";

export function findRef(repo: RepoInfo, nameOrRef: string): RepoRef | null {
  return (
    repo.refs.find((r) => r.fullName === nameOrRef) ??
    repo.refs.find((r) => r.kind === "local" && r.name === nameOrRef) ??
    repo.refs.find((r) => r.name === nameOrRef) ??
    null
  );
}

/**
 * T11.7: **the base branch**. It is chosen once and then remembered, but it is not a preference of
 * its own: it is the base side of the pickers whenever that side is a plain branch (T11.5's
 * `compareBase`, which `openRepo` seeds from the remembered `lastTarget` and every `Set as base`
 * updates), and otherwise the repository's own default branch — `RepoRef.isDefault`, which the
 * engine resolves per D8 (`refs/remotes/<remote>/HEAD`, then `main`, then `master`). One source of
 * truth, remembered per repository by the mechanism that already remembers the compare pair.
 */
export function baseRefOf(s: Pick<StoreState, "repo" | "compareBase">): RepoRef | null {
  const repo = s.repo;
  if (!repo) return null;
  const chosen = s.compareBase ? findRef(repo, s.compareBase.expr) : null;
  return chosen ?? repo.defaultRef ?? findRef(repo, "HEAD");
}

/** A tag as a comparison side. Never `branchRef`, so a tag pair is always a `RangeSource`. */
export function tagSide(tag: TagInfo): SideRev {
  return { expr: tag.fullName, display: tag.name, oid: tag.targetOid, branchRef: null };
}

/** Only a v1 branch pair is remembered for the next open; a range is deep-linked by hash instead. */
export function withRef(
  src: BranchesSource,
  side: "source" | "target",
  ref: RepoRef,
): BranchesSource {
  return side === "source"
    ? { ...src, source: ref.name, sourceRef: ref.fullName }
    : { ...src, target: ref.name, targetRef: ref.fullName };
}

/** Enforces D6: the toggle can only be on when the source is the checked-out state. */
export function guardWorktree<T extends DiffSource>(src: T, repo: RepoInfo): T {
  if (src.includeWorktree && !isWorktreeSource(src, repo))
    return { ...src, includeWorktree: false };
  return src;
}

/** Rejections that are expected during recompute races; anything else is logged. */
export function ignoreStale(e: unknown): void {
  const err = toUiError(e);
  if (err.code !== "STALE" && err.code !== "CANCELLED") console.warn("engine call failed", err);
}

export function cacheKey(id: string, ignoreWhitespace: boolean): string {
  return `${id}|${ignoreWhitespace ? "w" : "x"}`;
}

/**
 * T11.9: "stats complete" for the purpose of the secret scan. Every row either has an answer — a
 * number, or the explicit `null` the engine streams for a file it could not count — or is one that
 * never gets a `+n −m` at all. A single unreadable file must not hold a safety check back forever.
 */
export function statsSettled(
  files: readonly FileDiff[],
  stats: Record<string, FileStats>,
): boolean {
  return files.every((f) => f.id in stats || f.stats !== null || f.binary || f.tooLarge);
}

export function collectDiffStats(
  files: readonly FileDiff[],
  generation: number,
  pending: Map<number, Record<string, FileStats>>,
): { stats: Record<string, FileStats>; complete: boolean } {
  const stats: Record<string, FileStats> = {};
  for (const f of files) if (f.stats) stats[f.id] = f.stats;
  Object.assign(stats, pending.get(generation));
  for (const g of pending.keys()) if (g <= generation) pending.delete(g);
  return { stats, complete: files.every((f) => stats[f.id] !== undefined) };
}

export function mergeWarnings(
  current: Pick<StoreState, "repo" | "snapshotMode">,
  resultWarnings: RepoWarning[],
): RepoWarning[] {
  const repoWarnings = current.repo?.warnings ?? [];
  const merged: RepoWarning[] = [...repoWarnings];
  if (current.snapshotMode && !merged.some((w) => w.code === "SNAPSHOT_MODE"))
    merged.push(SNAPSHOT_WARNING);
  for (const w of resultWarnings) if (!merged.some((x) => x.code === w.code)) merged.push(w);
  return merged;
}
