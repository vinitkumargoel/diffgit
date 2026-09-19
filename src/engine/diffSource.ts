/**
 * Shared, pure helpers over `DiffSource` (tasks/README.md "Shared helper").
 * Both the engine (T3.2) and the UI store (T4.2) import these; the rule lives once, here.
 *
 * T10.1 made `DiffSource` a union. `sourceLabels` / `sourceRefs` give the two sides of either kind
 * under the engine's `source` (compare, new) / `target` (base, old) vocabulary, so callers that only
 * need to name or key the sides never have to narrow the union.
 */
import type { BranchesSource, DiffSource, RefSnapshot } from "./types";

/** Display names of the two sides: `source` is compare (new), `target` is base (old). */
export function sourceLabels(src: DiffSource): { source: string; target: string } {
  return src.kind === "range"
    ? { source: src.to, target: src.from }
    : { source: src.source, target: src.target };
}

/** Resolvable expressions of the two sides (full ref names, `"HEAD"`, `stash@{0}`, a SHA, …). */
export function sourceRefs(src: DiffSource): { sourceRef: string; targetRef: string } {
  return src.kind === "range"
    ? { sourceRef: src.toRef, targetRef: src.fromRef }
    : { sourceRef: src.sourceRef, targetRef: src.targetRef };
}

/** True iff the source side is the checked-out state (so the working tree can be layered, D6). */
export function isWorktreeSource(src: DiffSource, refs: RefSnapshot): boolean {
  if (src.kind === "range") {
    return src.includeWorktree && refs.headOid !== null && src.toOid === refs.headOid;
  }
  if (src.sourceRef === "HEAD") return true;
  return refs.headBranch !== null && src.sourceRef === `refs/heads/${refs.headBranch}`;
}

/** D5/D8 defaults: source = checked-out branch (or "HEAD"), target = default branch (or source). */
export function defaultDiffSource(refs: RefSnapshot): BranchesSource {
  const source = refs.headBranch ?? "HEAD";
  const sourceRef = refs.headBranch ? `refs/heads/${refs.headBranch}` : "HEAD";
  const target = refs.defaultRef?.name ?? source;
  const targetRef = refs.defaultRef?.fullName ?? sourceRef;
  return { kind: "branches", source, target, sourceRef, targetRef, includeWorktree: true };
}
