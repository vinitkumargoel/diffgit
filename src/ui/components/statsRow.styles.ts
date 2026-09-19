import type { FileStatus } from "../../engine/types";

export const STATUS_KEYS = ["M", "A", "D", "R", "T"] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

export const STATUS_META: Record<
  StatusKey,
  { status: FileStatus; word: string; token: string; cls: string }
> = {
  M: {
    status: "modified",
    word: "modified",
    token: "status:M",
    cls: "bg-status-m-bg text-status-m-fg",
  },
  A: { status: "added", word: "added", token: "status:A", cls: "bg-status-a-bg text-status-a-fg" },
  D: {
    status: "deleted",
    word: "deleted",
    token: "status:D",
    cls: "bg-status-d-bg text-status-d-fg",
  },
  R: {
    status: "renamed",
    word: "renamed",
    token: "status:R",
    cls: "bg-status-r-bg text-status-r-fg",
  },
  T: {
    status: "typechange",
    word: "type changed",
    token: "status:T",
    cls: "bg-status-t-bg text-status-t-fg",
  },
};

export const LAYER_KEYS = ["staged", "unstaged", "untracked", "conflict"] as const;
export type LayerKey = (typeof LAYER_KEYS)[number];

/* ------------------------------------------------------------------ styling */

export const STATS_ROW_CONTAINER =
  "flex min-h-10 flex-wrap items-center gap-3 bg-surface px-3 py-1 text-[12.5px] leading-5 text-muted";

export const DIVIDER_CLASS = "h-[18px] w-px shrink-0 bg-line";

export const BREAKDOWN_GROUP_CLASS =
  "hidden shrink-0 items-center gap-1.5 min-[1100px]:inline-flex";

export const STATUS_TOGGLE_BASE =
  "inline-flex size-[15px] shrink-0 items-center justify-center rounded-[4px] font-mono text-[9.5px] leading-none font-bold";

export const ACTIVE_OUTLINE = "outline-2 outline-offset-1 outline-accent";

export const LAYER_TOGGLE_ACTIVE = "rounded-full outline-2 outline-offset-1 outline-accent";
export const LAYER_TOGGLE_BASE = "rounded-full";

export const SNAPSHOT_BADGE =
  "inline-flex h-4 items-center rounded-full border border-attention/40 bg-banner-warning-bg px-1.5 font-sans text-[11px] font-semibold leading-4 text-attention";

export const PATCH_TAG =
  "inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border border-attention/40 px-1.5 text-[11.5px] text-attention";

export const SKELETON_PILL = "inline-block h-2.5 w-9 rounded-[3px] bg-surface-raised";

export const INDICATOR_ATTENTION = "inline-flex shrink-0 items-center gap-1.5 text-attention";
export const INDICATOR_ACCENT = "inline-flex shrink-0 items-center gap-1.5 text-accent";

export const LINK_BUTTON = "text-accent hover:underline";

export const formatNumber = (x: number): string => x.toLocaleString("en-US");
