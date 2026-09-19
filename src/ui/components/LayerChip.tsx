import type { ChangeLayer, FileDiff } from "../../engine/types";

export type ChipKind = Exclude<ChangeLayer, "committed"> | "generated";

const META: Record<ChipKind, { aria: string; cls: string }> = {
  staged: {
    aria: "Staged change",
    cls: "bg-chip-staged-bg text-chip-staged-fg border-chip-staged-fg/40",
  },
  unstaged: {
    aria: "Unstaged change",
    cls: "bg-chip-unstaged-bg text-chip-unstaged-fg border-chip-unstaged-fg/40",
  },
  untracked: {
    aria: "Untracked file",
    cls: "bg-chip-untracked-bg text-chip-untracked-fg border-chip-untracked-fg/40",
  },
  conflict: {
    aria: "Merge conflict",
    cls: "bg-chip-conflict-bg text-chip-conflict-fg border-chip-conflict-fg/40",
  },
  generated: {
    aria: "Generated file",
    cls: "bg-chip-generated-bg text-chip-generated-fg border-chip-generated-fg/40",
  },
};

/** Chips a file row/card shows: its non-committed layers (Plan D6) plus `generated` (T3.4). */
export function chipsFor(file: Pick<FileDiff, "layers" | "generated">): ChipKind[] {
  const out: ChipKind[] = file.layers.filter(
    (l): l is Exclude<ChangeLayer, "committed"> => l !== "committed",
  );
  if (file.generated) out.push("generated");
  return out;
}

/** `staged` is an adjective and does not pluralise; `conflict` is a noun and does (T11.11). */
const PLURAL: Partial<Record<ChipKind, string>> = { conflict: "conflicts" };

/** The counted chip text: `2 staged`, `1 conflict`, `2 conflicts` (Design §14.6, atlas tab 11). */
export function layerCountLabel(kind: ChipKind, count: number): string {
  return `${count} ${count === 1 ? kind : (PLURAL[kind] ?? kind)}`;
}

/**
 * Layer chip (Design §3.3 / §7.4): 11 px, 0 6 px padding, pill, border = fg at 40 %. Shared primitive.
 *
 * With `count` (Design §14.6, the Home dashboard's cards) the chip reads `2 staged` / `1 conflict`
 * and the text is its own accessible name; without one it is the bare layer name and carries the
 * `role="img"` label it always had.
 */
export function LayerChip({ kind, count }: { kind: ChipKind; count?: number }) {
  const m = META[kind];
  const cls = `inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 text-[11px] leading-4 font-medium ${m.cls}`;
  if (count !== undefined) {
    return (
      <span className={cls} title={m.aria}>
        {layerCountLabel(kind, count)}
      </span>
    );
  }
  return (
    <span className={cls} role="img" aria-label={m.aria} title={m.aria}>
      {kind}
    </span>
  );
}
