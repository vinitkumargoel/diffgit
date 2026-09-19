/**
 * Branch overview (T10.5, atlas tab 09, Design §14.6): one row per ref with its upstream and last
 * commit, and the three expensive cells — ahead/behind versus the upstream, ahead/behind versus the
 * default branch, and "merged" — computed on demand for the rows the table actually shows.
 *
 * Upstream comes from the config (`branch.<name>.remote` + `branch.<name>.merge`), exactly as
 * `git branch -vv` reads it; "merged" is `vsDefault.ahead === 0`, which is the atlas's "merge base
 * equals the branch tip" said in terms of the counts we already have.
 */
import type { AheadBehind, BranchRow, Oid, RefSnapshot, RepoRef, TagInfo } from "../types";
import type { GitConfig } from "./config";
import type { ObjectDb } from "./objectDb";
import { aheadBehind, type CommitReader, subjectOf } from "./walk";

/** The three cells `branchCells(names)` fills in. */
export type BranchCells = Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">;

/**
 * `origin/main` for a branch that tracks one, else null. `branch.<name>.remote = .` is git's
 * spelling for "a local branch", in which case the upstream is the merge ref's short name.
 */
export function upstreamOf(cfg: GitConfig, branchName: string): string | null {
  const remote = cfg.get("branch", "remote", branchName);
  const merge = cfg.get("branch", "merge", branchName);
  if (remote === undefined || merge === undefined) return null;
  const short = merge.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : merge;
  return remote === "." ? short : `${remote}/${short}`;
}

/** The full ref an upstream display name points at, or null when it is not fetched. */
function upstreamRef(refs: RefSnapshot, upstream: string | null): RepoRef | null {
  if (upstream === null) return null;
  return refs.refs.find((r) => r.name === upstream && !r.synthetic) ?? null;
}

export interface BranchDeps {
  db: ObjectDb;
  reader: CommitReader;
  cfg: GitConfig;
  refs: RefSnapshot;
  signal?: AbortSignal;
}

/**
 * Every real ref (the synthetic `HEAD` entry a detached/unborn repository carries is not a branch),
 * with the cheap columns filled and the three expensive ones left null for `branchCells`.
 */
export async function branchOverview(deps: BranchDeps, tags: TagInfo[]): Promise<BranchRow[]> {
  const tagsByOid = new Map<Oid, string[]>();
  for (const tag of tags) {
    const list = tagsByOid.get(tag.targetOid) ?? [];
    list.push(tag.name);
    tagsByOid.set(tag.targetOid, list);
  }
  const rows: BranchRow[] = [];
  for (const ref of deps.refs.refs) {
    if (ref.synthetic) continue;
    rows.push({
      ref,
      upstream: ref.kind === "local" ? upstreamOf(deps.cfg, ref.name) : null,
      lastCommit: await lastCommitOf(deps.db, ref.oid),
      vsUpstream: null,
      vsDefault: null,
      merged: null,
      tags: tagsByOid.get(ref.oid) ?? [],
    });
  }
  return rows;
}

async function lastCommitOf(db: ObjectDb, oid: Oid): Promise<BranchRow["lastCommit"]> {
  try {
    const commit = await db.readCommit(oid);
    return {
      oid: commit.oid,
      subject: subjectOf(commit.message),
      author: commit.author.name,
      timestamp: commit.author.timestamp * 1000,
    };
  } catch {
    return null; // a ref pointing at a pruned or non-commit object still gets a row
  }
}

/**
 * The ahead/behind cells for the named refs (full names, as the table keys its rows).
 * A ref with no upstream, and the default branch's own `vsDefault`, stay null.
 */
export async function branchCells(
  deps: BranchDeps,
  fullNames: string[],
): Promise<Record<string, BranchCells>> {
  const out: Record<string, BranchCells> = {};
  const def = deps.refs.defaultRef;
  for (const fullName of fullNames) {
    const ref = deps.refs.refs.find((r) => r.fullName === fullName && !r.synthetic);
    if (!ref) continue;
    const upstream = ref.kind === "local" ? upstreamOf(deps.cfg, ref.name) : null;
    const tracked = upstreamRef(deps.refs, upstream);
    const vsUpstream: AheadBehind | null = tracked
      ? await aheadBehind(deps.db, deps.reader, ref.oid, tracked.oid, deps.signal)
      : null;
    const vsDefault: AheadBehind | null =
      def && def.fullName !== ref.fullName
        ? await aheadBehind(deps.db, deps.reader, ref.oid, def.oid, deps.signal)
        : null;
    out[fullName] = {
      vsUpstream,
      vsDefault,
      merged: vsDefault ? vsDefault.ahead === 0 : def ? true : null,
    };
  }
  return out;
}
