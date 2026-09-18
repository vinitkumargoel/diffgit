/**
 * The diffgit brand mark: a rounded dark chip with a branch line splitting off in green.
 * Traced from the marketing mockup's `#logo` symbol; the chip is dark in both themes by design,
 * so it uses the fixed `--brand-*` tokens rather than the theme palette.
 *
 * Decorative everywhere it is used — the wordmark next to it carries the name.
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="7" fill="var(--brand-chip)" />
      <path
        d="M10 10.5v11"
        fill="none"
        stroke="var(--brand-line)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M22 12.6c0 6-12 3.4-12 9"
        fill="none"
        stroke="var(--brand-branch)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="10" cy="8" r="2.6" fill="var(--brand-line)" />
      <circle cx="10" cy="24" r="2.6" fill="var(--brand-line)" />
      <circle cx="22" cy="10" r="2.6" fill="var(--brand-branch)" />
    </svg>
  );
}
