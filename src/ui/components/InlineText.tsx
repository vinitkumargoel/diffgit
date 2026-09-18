import { Fragment, type ReactNode } from "react";

/**
 * Copy in `src/ui/errors.ts` / `src/ui/warnings.ts` may carry `backtick` spans (review E1–E4).
 * `chip` is the mockup's `.err .fix code` — a bordered chip; `mono` is the plain monospace run used
 * inside the message paragraph.
 */
export type InlineVariant = "chip" | "mono";

const CLASS: Record<InlineVariant, string> = {
  chip: "rounded-[4px] border border-line bg-surface px-[5px] font-mono text-[12.5px] text-ink",
  mono: "font-mono text-[0.92em] text-ink",
};

/** Renders `backtick` spans of `text` as <code>; everything else stays plain text. */
export function renderInline(text: string, variant: InlineVariant = "chip"): ReactNode {
  const parts = text.split(/`([^`]+)`/g);
  if (parts.length === 1) return text;
  const out: ReactNode[] = [];
  // odd positions are the captured `backtick` runs; a plain loop keeps the keys stable per segment
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (part === "") continue;
    const key = `${i}:${part}`;
    out.push(
      i % 2 === 1 ? (
        <code key={key} className={CLASS[variant]}>
          {part}
        </code>
      ) : (
        <Fragment key={key}>{part}</Fragment>
      ),
    );
  }
  return out;
}
