import { CheckCheck, ChevronDown, ChevronRight, ListCollapse, RotateCcw } from "lucide-react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { FileDiff, HiddenEntry } from "../../engine/types";
import type { FileGroup } from "../treeModel";
import { ACTION_CLASS, GROUP_DOT, GROUP_LABELS } from "./fileTree.styles";

export interface FileTreeGroupHeaderProps {
  group: FileGroup;
  index: number;
  open: boolean;
  compare: string;
  total: number;
  filtering: boolean;
  tabIndex: number;
  statsOf: (f: FileDiff) => FileDiff["stats"];
  viewedOf: (f: FileDiff) => boolean;
  onFocus: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onToggle: () => void;
  onSetViewed: (fileIds: string[], viewed: boolean) => void;
  onCollapseOthers: () => void;
  style?: CSSProperties;
}

export function FileTreeGroupHeader({
  group,
  index,
  open,
  compare,
  total,
  filtering,
  tabIndex,
  statsOf,
  viewedOf,
  onFocus,
  onKeyDown,
  onToggle,
  onSetViewed,
  onCollapseOthers,
  style,
}: FileTreeGroupHeaderProps) {
  const label =
    group.id === "committed" && compare ? `Committed on ${compare}` : GROUP_LABELS[group.id];
  const shown = group.files.length;
  let additions = 0;
  let deletions = 0;
  let counted = 0;
  let seen = 0;
  for (const f of group.files) {
    const st = statsOf(f);
    if (st) {
      additions += st.additions;
      deletions += st.deletions;
      counted++;
    }
    if (viewedOf(f)) seen++;
  }
  const allViewed = shown > 0 && seen === shown;
  const markLabel = allViewed ? `Clear viewed in ${label}` : `Mark all in ${label} viewed`;

  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-expanded={open}
      aria-selected={false}
      aria-label={`${label}, ${shown} ${shown === 1 ? "file" : "files"}`}
      data-index={index}
      tabIndex={tabIndex}
      className={`group sticky top-0 z-[1] flex h-7 cursor-pointer items-center gap-[6px] border-b border-line bg-surface-sunken pr-2 select-none ${
        allViewed ? "opacity-55" : ""
      }`}
      style={{ ...style, paddingLeft: 10 }}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={onToggle}
    >
      {open ? (
        <ChevronDown size={9} aria-hidden className="shrink-0 text-muted" />
      ) : (
        <ChevronRight size={9} aria-hidden className="shrink-0 text-muted" />
      )}
      <span aria-hidden className={`size-[7px] shrink-0 rounded-full ${GROUP_DOT[group.id]}`} />
      <span className="truncate text-xs font-semibold">{label}</span>
      <span className="shrink-0 rounded-full border border-line bg-surface-raised px-[5px] font-mono text-[10px] leading-[15px] font-semibold">
        {filtering ? `${shown} of ${total}` : shown}
      </span>
      <span className="flex-1" />
      {counted > 0 && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums whitespace-nowrap">
          <span className="text-success">+{additions}</span>{" "}
          <span className="text-danger">−{deletions}</span>
        </span>
      )}
      <span
        className={`shrink-0 font-mono text-[11px] whitespace-nowrap ${
          allViewed ? "text-success" : "text-muted"
        }`}
      >
        {allViewed ? "✓ " : ""}
        {seen}/{shown}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={markLabel}
        title={markLabel}
        className={ACTION_CLASS}
        onClick={(e) => {
          e.stopPropagation();
          onSetViewed(
            group.files.map((f) => f.id),
            !allViewed,
          );
        }}
      >
        {allViewed ? <RotateCcw size={12} aria-hidden /> : <CheckCheck size={12} aria-hidden />}
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Collapse other groups"
        title="Collapse other groups"
        className={ACTION_CLASS}
        onClick={(e) => {
          e.stopPropagation();
          onCollapseOthers();
        }}
      >
        <ListCollapse size={12} aria-hidden />
      </button>
    </div>
  );
}

export interface FileTreeHiddenGroupHeaderProps {
  entries: HiddenEntry[];
  total: number;
  index: number;
  open: boolean;
  filtering: boolean;
  tabIndex: number;
  onFocus: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onToggle: () => void;
  onCollapseOthers: () => void;
  style?: CSSProperties;
}

export function FileTreeHiddenGroupHeader({
  entries,
  total,
  index,
  open,
  filtering,
  tabIndex,
  onFocus,
  onKeyDown,
  onToggle,
  onCollapseOthers,
  style,
}: FileTreeHiddenGroupHeaderProps) {
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-expanded={open}
      aria-selected={false}
      aria-label={`Hidden, ${entries.length} ${entries.length === 1 ? "path" : "paths"}`}
      data-index={index}
      data-group="hidden"
      tabIndex={tabIndex}
      className="group sticky top-0 z-[1] flex h-7 cursor-pointer items-center gap-[6px] border-b border-line bg-surface-sunken pr-2 select-none"
      style={{ ...style, paddingLeft: 10 }}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={onToggle}
    >
      {open ? (
        <ChevronDown size={9} aria-hidden className="shrink-0 text-muted" />
      ) : (
        <ChevronRight size={9} aria-hidden className="shrink-0 text-muted" />
      )}
      <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-muted" />
      <span className="truncate text-xs font-semibold text-muted">Hidden</span>
      <span className="shrink-0 rounded-full border border-line bg-surface-raised px-[5px] font-mono text-[10px] leading-[15px] font-semibold text-muted">
        {filtering && entries.length !== total ? `${entries.length} of ${total}` : entries.length}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Collapse other groups"
        title="Collapse other groups"
        className={ACTION_CLASS}
        onClick={(e) => {
          e.stopPropagation();
          onCollapseOthers();
        }}
      >
        <ListCollapse size={12} aria-hidden />
      </button>
    </div>
  );
}
