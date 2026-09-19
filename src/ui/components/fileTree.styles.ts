import type { FileDiff, HiddenEntry } from "../../engine/types";
import type { FileGroup, SidebarGroupId, TreeDir } from "../treeModel";

/** Rows above this count are virtualised (T5.2; Plan §6.7). */
export const VIRTUALISE_ABOVE = 300;
export const DIR_ROW = 24;
export const FILE_ROW = 26;
export const GROUP_ROW = 28;

/** D1 labels; `committed` gains the compare branch ("Committed on feature"). */
export const GROUP_LABELS: Record<SidebarGroupId, string> = {
  conflict: "Conflicts",
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
  committed: "Committed",
};

/** D6 item 2: the 7 px dot, one token per layer. */
export const GROUP_DOT: Record<SidebarGroupId, string> = {
  conflict: "bg-chip-conflict-fg",
  staged: "bg-chip-staged-fg",
  unstaged: "bg-chip-unstaged-fg",
  untracked: "bg-chip-untracked-fg",
  committed: "bg-muted",
};

export const ACTION_CLASS =
  "hidden size-5 shrink-0 items-center justify-center rounded-[4px] text-muted hover:bg-line group-hover:inline-flex group-focus-within:inline-flex";

export type Row =
  | { key: string; kind: "group"; group: FileGroup; depth: 0 }
  | { key: string; kind: "dir"; node: TreeDir; depth: number; dirKey: string }
  | { key: string; kind: "file"; file: FileDiff; depth: number }
  /** T11.4: the Hidden section header and its rows (Design §14.4). */
  | { key: string; kind: "hidden-group"; entries: HiddenEntry[]; total: number; depth: 0 }
  | { key: string; kind: "hidden"; entry: HiddenEntry; depth: 0 }
  | { key: string; kind: "hidden-empty"; depth: 0 };
