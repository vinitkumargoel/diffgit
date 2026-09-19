import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { FileDiff } from "../../engine/types";
import { dirSummary, type TreeDir } from "../treeModel";

export interface FileTreeDirRowProps {
  node: TreeDir;
  depth: number;
  dirKey: string;
  index: number;
  open: boolean;
  grouped: boolean;
  tabIndex: number;
  statsOf: (f: FileDiff) => FileDiff["stats"];
  onToggle: () => void;
  onFocus: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  style?: CSSProperties;
}

export function FileTreeDirRow({
  node,
  depth,
  index,
  open,
  grouped,
  tabIndex,
  statsOf,
  onToggle,
  onFocus,
  onKeyDown,
  style,
}: FileTreeDirRowProps) {
  const summary = open ? null : dirSummary(node, statsOf);
  return (
    <div
      role="treeitem"
      aria-level={depth + (grouped ? 2 : 1)}
      aria-expanded={open}
      aria-selected={false}
      data-index={index}
      tabIndex={tabIndex}
      className={`flex h-6 cursor-pointer items-center gap-1 text-xs text-muted select-none hover:bg-surface-raised${
        summary ? " pr-2" : ""
      }`}
      style={{ ...style, paddingLeft: 12 + depth * 14 }}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={onToggle}
    >
      {open ? (
        <ChevronDown size={9} aria-hidden className="shrink-0" />
      ) : (
        <ChevronRight size={9} aria-hidden className="shrink-0" />
      )}
      <Folder size={14} aria-hidden className="shrink-0" />
      <span className="truncate">{node.name}</span>
      {summary && (
        <>
          <span className="flex-1" />
          <span className="shrink-0 font-mono text-[11px] text-muted">{summary.files}</span>
          {summary.complete && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums whitespace-nowrap">
              <span className="text-success">+{summary.additions}</span>{" "}
              <span className="text-danger">−{summary.deletions}</span>
            </span>
          )}
        </>
      )}
    </div>
  );
}
