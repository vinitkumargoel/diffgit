import { SECRET_TAG } from "../secrets";

/**
 * Design §14.3: a sidebar row whose file carries a finding wears a `secret` chip in the §3.3
 * `conflict` palette, after the XY layer code. Same primitive shape as `LayerChip` / `ConflictTag`
 * so the three never drift apart.
 */
export function SecretTag({ count }: { count: number }) {
  const label =
    count === 1 ? "1 possible secret in this file" : `${count} possible secrets in this file`;
  return (
    <span
      data-secret-tag={count}
      className="inline-flex h-4 shrink-0 items-center rounded-full border border-chip-conflict-fg/40 bg-chip-conflict-bg px-1.5 text-[11px] leading-4 font-medium text-chip-conflict-fg"
      role="img"
      aria-label={label}
      title={label}
    >
      {SECRET_TAG}
    </span>
  );
}
