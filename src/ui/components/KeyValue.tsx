import type { ReactNode } from "react";

/**
 * The two-column `label · value` body atlas tab 19 draws for the submodule and LFS cards
 * (mockup `.kv`): a definition list, 12 px, the label muted in a fixed column and the value taking
 * the rest. Shared primitive (Design §11) so the two cards cannot drift apart, and a list rather
 * than a table because every row is one fact about the file, not a cell in a grid.
 *
 * The card's `<article aria-label={path}>` already names it, so the list carries no label of its
 * own; `kind` is what the tests and the styling hook on.
 */
export function KeyValue({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <dl
      data-card={kind}
      className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 p-3 text-[12px] leading-5"
    >
      {children}
    </dl>
  );
}

export function KeyValueRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </>
  );
}
