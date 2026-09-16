/**
 * Shared, pure helpers over `DiffSource` (tasks/README.md "Shared helper").
 * Both the engine (T3.2) and the UI store (T4.2) import these; the rule lives once, here.
 */
import type { DiffSource, RefSnapshot } from "./types";

/** True iff the source side is the checked-out state (so the working tree can be layered, D6). */
export function isWorktreeSource(src: DiffSource, refs: RefSnapshot): boolean {
  if (src.sourceRef === "HEAD") return true;
  return refs.headBranch !== null && src.sourceRef === `refs/heads/${refs.headBranch}`;
}

/** D5/D8 defaults: source = checked-out branch (or "HEAD"), target = default branch (or source). */
export function defaultDiffSource(refs: RefSnapshot): DiffSource {
  const source = refs.headBranch ?? "HEAD";
  const sourceRef = refs.headBranch ? `refs/heads/${refs.headBranch}` : "HEAD";
  const target = refs.defaultRef?.name ?? source;
  const targetRef = refs.defaultRef?.fullName ?? sourceRef;
  return { kind: "branches", source, target, sourceRef, targetRef, includeWorktree: true };
}
