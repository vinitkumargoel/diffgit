/**
 * Building a `DiffSource` out of two freely chosen sides (T11.2, Design §14.1 "BranchPicker
 * popover gains groups Tags / Stashes / Special … and a free-text row").
 *
 * Pure and engine-free: the store turns a `ResolvedRevision` (or the side it already has) into a
 * `SideRev`, and `buildSource` decides which kind of `DiffSource` the pair needs. The rule from
 * `docs/v2-contracts.md` is a single line: **two plain ref sides compared three-dot stay a
 * `BranchesSource` (v1); anything else becomes a `RangeSource`.** Keeping v1's shape whenever it
 * still fits is what keeps `viewedKey`, the persisted `lastSource`/`lastTarget` pair and the
 * scheduler's deleted-branch fallback working exactly as before.
 */
import type { DiffSource, Oid, RefSnapshot, ResolvedRevision } from "../engine/types";

/** One side of a comparison, in the form every `DiffSource` field is derived from. */
export interface SideRev {
  /** A resolvable expression: a full ref name, `HEAD`, `stash@{0}`, `v1.0.0^`, a SHA … */
  expr: string;
  /** What the picker trigger and the StatsRow print ("main", "v2.3.0", "stash@{0}"). */
  display: string;
  /** The commit; `null` is git's empty tree (only legal on the base side). */
  oid: Oid | null;
  /** Non-null when this side is a plain branch/remote ref or `HEAD` — i.e. v1-expressible. */
  branchRef: string | null;
}

/**
 * True for the expressions `BranchesSource.sourceRef` / `targetRef` are allowed to hold — branches,
 * remote-tracking branches and `HEAD`. A tag is deliberately excluded: `refs/tags/v1.0.0` is a full
 * ref name but not a branch, and the v1 pair is what the branch pickers and `lastSource` mean.
 */
export function isRefExpr(expr: string): boolean {
  return expr === "HEAD" || expr.startsWith("refs/heads/") || expr.startsWith("refs/remotes/");
}

/** The oid a full ref name points at, for a side that came from the v1 branch pair. */
function oidOfRef(refs: RefSnapshot, fullName: string): Oid | null {
  if (fullName === "HEAD") return refs.headOid;
  return refs.refs.find((r) => r.fullName === fullName)?.oid ?? null;
}

/**
 * Reads one side out of either `DiffSource` kind, under the engine's vocabulary:
 * `"source"` is compare (new, `to`), `"target"` is base (old, `from`).
 */
export function sideOf(src: DiffSource, side: "source" | "target", refs: RefSnapshot): SideRev {
  if (src.kind === "branches") {
    const expr = side === "source" ? src.sourceRef : src.targetRef;
    return {
      expr,
      display: side === "source" ? src.source : src.target,
      oid: oidOfRef(refs, expr),
      branchRef: expr,
    };
  }
  const expr = side === "source" ? src.toRef : src.fromRef;
  return {
    expr,
    display: side === "source" ? src.to : src.from,
    oid: side === "source" ? src.toOid : src.fromOid,
    branchRef: isRefExpr(expr) ? expr : null,
  };
}

/** A picked revision as a side. Only branch-shaped kinds can go back into a `BranchesSource`. */
export function revToSide(rev: ResolvedRevision): SideRev {
  const branchy = rev.kind === "branch" || rev.kind === "remote" || rev.kind === "head";
  return {
    expr: rev.fullRef ?? rev.expr,
    display: rev.display,
    oid: rev.oid,
    branchRef: branchy && rev.fullRef !== undefined ? rev.fullRef : null,
  };
}

/**
 * The `DiffSource` for a pair of sides, or `null` when the pair cannot be compared (the compare
 * side resolved to the empty tree — git has nothing to show on the new side of such a diff).
 */
export function buildSource(
  from: SideRev,
  to: SideRev,
  threeDot: boolean,
  includeWorktree: boolean,
): DiffSource | null {
  if (threeDot && from.branchRef !== null && to.branchRef !== null) {
    return {
      kind: "branches",
      source: to.display,
      target: from.display,
      sourceRef: to.branchRef,
      targetRef: from.branchRef,
      includeWorktree,
    };
  }
  if (to.oid === null) return null;
  return {
    kind: "range",
    from: from.display,
    to: to.display,
    fromRef: from.expr,
    toRef: to.expr,
    fromOid: from.oid,
    toOid: to.oid,
    threeDot,
    includeWorktree,
  };
}

/** `main … feature` / `v2.3.0 .. stash@{0}` — the StatsRow label and the picker footer's example. */
export function labelOf(src: DiffSource): string {
  const sep = src.kind === "range" && !src.threeDot ? ".." : "…";
  return src.kind === "range"
    ? `${src.from} ${sep} ${src.to}`
    : `${src.target} ${sep} ${src.source}`;
}
