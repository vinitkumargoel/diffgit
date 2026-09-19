/**
 * Branch overview (T10.5, atlas tab 09, Design §14.6): one row per ref with its upstream and last
 * commit, and the three expensive cells — ahead/behind versus the upstream, ahead/behind versus the
 * default branch, and "merged" — computed on demand for the rows the table actually shows.
 *
 * Upstream comes from the config (`branch.<name>.remote` + `branch.<name>.merge`), exactly as
 * `git branch -vv` reads it; "merged" is `vsDefault.ahead === 0`, which is the atlas's "merge base
 * equals the branch tip" said in terms of the counts we already have.
 */
import type {
  AheadBehind,
  BranchRow,
  Oid,
  RefSnapshot,
  RepoRef,
  RepoWarning,
  TagInfo,
} from "../types";
import type { GitConfig } from "./config";
import type { ObjectDb } from "./objectDb";
import { aheadBehind, type CommitReader, subjectOf } from "./walk";

/** The three cells `branchCells(names)` fills in. */
export type BranchCells = Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">;

/**
 * Maps one ref through a fetch refspec (`+refs/heads/*:refs/remotes/origin/*`), git's own rule for
 * turning `branch.<n>.merge` into a remote-tracking ref. Null when the spec does not cover it.
 */
export function mapFetchRefspec(spec: string | undefined, ref: string): string | null {
  if (spec === undefined) return null;
  const body = spec.startsWith("+") ? spec.slice(1) : spec;
  const colon = body.indexOf(":");
  if (colon === -1) return null;
  const src = body.slice(0, colon);
  const dst = body.slice(colon + 1);
  if (src.endsWith("*") && dst.endsWith("*")) {
    const prefix = src.slice(0, -1);
    return ref.startsWith(prefix) ? dst.slice(0, -1) + ref.slice(prefix.length) : null;
  }
  return src === ref ? dst : null;
}

/**
 * `origin/main` for a branch that tracks one, else null. `branch.<name>.remote = .` is git's
 * spelling for "a local branch", in which case the upstream is the merge ref's short name.
 *
 * T10.5b nit 3: the merge ref is mapped through the remote's **fetch refspec** first and then
 * looked up among the refs by full name, so a non-default layout resolves and a `merge` that does
 * not live under `refs/heads/` (a Gerrit `refs/for/x`, say) reports no upstream rather than the
 * nonsense `origin/refs/for/x` that concatenating the strings produced.
 */
export function upstreamOf(cfg: GitConfig, refs: RefSnapshot, branchName: string): string | null {
  const remote = cfg.get("branch", "remote", branchName);
  const merge = cfg.get("branch", "merge", branchName);
  if (remote === undefined || merge === undefined) return null;

  if (remote === ".") {
    if (merge.startsWith("refs/heads/")) return merge.slice("refs/heads/".length);
    return refs.refs.find((r) => r.fullName === merge && !r.synthetic)?.name ?? null;
  }

  const candidates: string[] = [];
  const mapped = mapFetchRefspec(cfg.get("remote", "fetch", remote), merge);
  if (mapped !== null) candidates.push(mapped);
  if (merge.startsWith("refs/heads/"))
    candidates.push(`refs/remotes/${remote}/${merge.slice("refs/heads/".length)}`);

  for (const fullName of candidates) {
    const found = refs.refs.find((r) => r.fullName === fullName && !r.synthetic);
    if (found) return found.name;
  }
  // Nothing fetched yet: git still prints the name the refspec would produce, but only for a ref
  // that actually maps into refs/remotes/.
  const first = candidates[0];
  if (first === undefined || !first.startsWith("refs/remotes/")) return null;
  return first.slice("refs/remotes/".length);
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
  /** T10.5b nit 2: a read that had to be given up on is reported, never swallowed. */
  warn?: (w: RepoWarning) => void;
  /**
   * T10.5b S3: `aheadBehind` memoised per `(a, b)` for the current refs generation, so a table of
   * 50 rows does not re-walk the shared trunk 100 times. Supplied by the session.
   */
  aheadBehind?: (a: Oid, b: Oid) => Promise<AheadBehind>;
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
      upstream: ref.kind === "local" ? upstreamOf(deps.cfg, deps.refs, ref.name) : null,
      lastCommit: await lastCommitOf(deps, ref),
      vsUpstream: null,
      vsDefault: null,
      merged: null,
      tags: tagsByOid.get(ref.oid) ?? [],
    });
  }
  return rows;
}

async function lastCommitOf(deps: BranchDeps, ref: RepoRef): Promise<BranchRow["lastCommit"]> {
  try {
    const commit = await deps.db.readCommit(ref.oid);
    return {
      oid: commit.oid,
      subject: subjectOf(commit.message),
      author: commit.author.name,
      // T10.5b nit 7: the table is sorted by "last activity", which is the committer date — the
      // author date survives a rebase unchanged and would sort a freshly rebased branch as old.
      timestamp: commit.committer.timestamp * 1000,
    };
  } catch (e) {
    // A ref pointing at a pruned or non-commit object still gets a row, but the user is told.
    deps.warn?.({
      code: "HISTORY_DEGRADED",
      message: `The commit ${ref.name} points at could not be read; the row has no last commit.`,
      detail: `IO_ERROR: ${ref.fullName} ${ref.oid} (${e instanceof Error ? e.message : String(e)})`,
    });
    return null;
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
  const compare =
    deps.aheadBehind ??
    ((a: Oid, b: Oid) =>
      aheadBehind(deps.db, deps.reader, a, b, deps.signal ? { signal: deps.signal } : {}));
  for (const fullName of fullNames) {
    const ref = deps.refs.refs.find((r) => r.fullName === fullName && !r.synthetic);
    if (!ref) continue;
    const upstream = ref.kind === "local" ? upstreamOf(deps.cfg, deps.refs, ref.name) : null;
    const tracked = upstreamRef(deps.refs, upstream);
    const vsUpstream: AheadBehind | null = tracked ? await compare(ref.oid, tracked.oid) : null;
    const vsDefault: AheadBehind | null =
      def && def.fullName !== ref.fullName ? await compare(ref.oid, def.oid) : null;
    out[fullName] = {
      vsUpstream,
      vsDefault,
      merged: vsDefault ? vsDefault.ahead === 0 : def ? true : null,
    };
  }
  return out;
}
