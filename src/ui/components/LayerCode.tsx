import type { LayerCodeInfo } from "../treeModel";

/**
 * Colour of one column of the code (Design §3.3): x is the index, y is the working tree; `?` and
 * `U` colour both columns, `·` (the empty column) is muted. Tokens only — no literal colours.
 */
function columnClass(char: string, column: "x" | "y"): string {
  if (char === "·") return "text-muted";
  if (char === "?") return "text-chip-untracked-fg";
  if (char === "U") return "text-chip-conflict-fg";
  return column === "x" ? "text-chip-staged-fg" : "text-chip-unstaged-fg";
}

/**
 * D4: git's `status --short` XY column on a sidebar row — two monospace characters with the
 * full sentence in `aria-label` / `title`. The glyphs themselves are `aria-hidden`.
 */
export function LayerCode({ code }: { code: LayerCodeInfo }) {
  return (
    <span
      role="img"
      aria-label={code.label}
      title={code.label}
      className="inline-flex h-4 shrink-0 items-center rounded-[3px] border border-line bg-surface px-1 font-mono text-[10px] leading-4 font-semibold tracking-[0.08em]"
    >
      <span aria-hidden className={columnClass(code.x, "x")}>
        {code.x}
      </span>
      <span aria-hidden className={columnClass(code.y, "y")}>
        {code.y}
      </span>
    </span>
  );
}
