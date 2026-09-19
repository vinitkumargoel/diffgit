import type { ConflictKind } from "../../engine/api";
import { describeConflictKind } from "../operation";

/**
 * Design §14.3: the card header of a conflicted file says which conflict it is — `both modified`,
 * `both added`, `deleted by them` — as a `ref`-style tag in the §3.3 `conflict` chip palette.
 * While the payload is still in flight the tag says `conflict`, never a kind it does not know.
 */
export function ConflictTag({ kind }: { kind: ConflictKind | undefined }) {
  const label = kind === undefined ? "conflict" : describeConflictKind(kind);
  return (
    <span
      className="inline-flex h-4 shrink-0 items-center rounded-full border border-chip-conflict-fg/40 bg-chip-conflict-bg px-1.5 text-[11px] leading-4 font-medium text-chip-conflict-fg"
      role="img"
      aria-label={`Conflict: ${label}`}
      title={`Conflict: ${label}`}
    >
      {label}
    </span>
  );
}
