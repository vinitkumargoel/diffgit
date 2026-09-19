export const SEGMENT_CLASS = "rounded-[6px] px-[7px] py-[2px] text-[11px] leading-4 font-medium";

/**
 * Both tables are `role="grid"` (T11.7): a row is focusable, walked with `j` / `k` and opened with
 * Enter, which is what a grid is and a plain table is not. The file-level suppression at the top
 * covers the two — Biome would rather see the role on a `div`, which costs the column alignment
 * and a focusable wrapper per cell for nothing.
 */
export const GRID_CLASS = "w-full border-collapse text-[12.5px]";

export const TH_CLASS =
  "sticky top-0 z-[1] border-b border-line bg-surface px-3 py-1.5 text-left text-[11px] leading-4 font-medium text-muted";

export const TD_CLASS = "border-b border-line-subtle px-3 py-1.5 align-middle";
