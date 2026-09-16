/**
 * Tree diff (T3.1, Plan §5.6 step 4): flattened tree A vs B → per-path changes in git's byte-wise
 * path order. `null` = empty tree. Mode-only and type changes are emitted as modified; T3.4 labels
 * typechanges and renders gitlinks (160000) as submodule notices.
 */
import type { FlatTree } from "../git/objectDb";
import type { Change } from "../git/worktree";

export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function treeDiff(a: FlatTree | null, b: FlatTree | null): Record<string, Change> {
  const out: Record<string, Change> = {};
  const paths = new Set<string>();
  if (a) for (const p of Object.keys(a)) paths.add(p);
  if (b) for (const p of Object.keys(b)) paths.add(p);
  for (const path of [...paths].sort(comparePaths)) {
    const oldE = a?.[path];
    const newE = b?.[path];
    if (oldE && !newE)
      out[path] = { oldOid: oldE.oid, newOid: null, oldMode: oldE.mode, newMode: null };
    else if (!oldE && newE)
      out[path] = { oldOid: null, newOid: newE.oid, oldMode: null, newMode: newE.mode };
    else if (oldE && newE && (oldE.oid !== newE.oid || oldE.mode !== newE.mode)) {
      out[path] = { oldOid: oldE.oid, newOid: newE.oid, oldMode: oldE.mode, newMode: newE.mode };
    }
  }
  return out;
}
