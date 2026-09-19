/**
 * A neutral `ref`-style tag in the file card header (T11.16, atlas tab 19: `submodule`, `LFS`).
 * Same primitive shape as `ConflictTag` / `SecretTag`, in the §3.3 `generated` chip palette —
 * these say what kind of row this is, not that anything is wrong with it.
 */
export function KindTag({ label, title }: { label: string; title: string }) {
  return (
    <span
      data-kind-tag={label}
      className="inline-flex h-4 shrink-0 items-center rounded-full border border-chip-generated-fg/40 bg-chip-generated-bg px-1.5 font-sans text-[11px] leading-4 font-medium text-chip-generated-fg"
      role="img"
      aria-label={title}
      title={title}
    >
      {label}
    </span>
  );
}
