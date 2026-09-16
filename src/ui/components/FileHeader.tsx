import { Check, ChevronDown, ChevronRight, Copy, UnfoldVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FileDiff } from "../../engine/types";
import { filePathOf } from "../treeModel";
import { RowStats, splitPath } from "./FileRow";
import { chipsFor, LayerChip } from "./LayerChip";
import { StatusIcon } from "./StatusIcon";

export interface FileHeaderProps {
  file: FileDiff;
  stats: FileDiff["stats"];
  collapsed: boolean;
  viewed: boolean;
  onToggleCollapse: () => void;
  onToggleViewed: () => void;
  /** Undefined while there is nothing to expand (button disabled). */
  onExpandAll?: () => void;
}

/** `100644` for 0o100644; null when the side is absent. */
export function formatMode(mode: number | null): string | null {
  return mode === null ? null : mode.toString(8).padStart(6, "0");
}

function PathLabel({ path, className }: { path: string; className?: string }) {
  const { dir, base } = splitPath(path);
  return (
    <span className={`font-mono text-xs font-semibold ${className ?? ""}`}>
      <span className="font-normal opacity-70">{dir}</span>
      {base}
    </span>
  );
}

/** Sticky card header (Design §7.5) with the exact element order. */
export function FileHeader({
  file,
  stats,
  collapsed,
  viewed,
  onToggleCollapse,
  onToggleViewed,
  onExpandAll,
}: FileHeaderProps) {
  const path = filePathOf(file);
  const rename = file.status === "renamed" || file.status === "copied";
  const modeChanged =
    file.oldMode !== null && file.newMode !== null && file.oldMode !== file.newMode;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(path);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (permissions / insecure context): nothing to report */
    }
  };

  return (
    <header className="sticky top-0 z-[1] flex flex-wrap items-center gap-2.5 border-b border-line bg-surface-raised px-3 py-2 text-xs leading-5">
      <button
        type="button"
        className="flex size-4 shrink-0 items-center justify-center text-muted hover:text-ink"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${path}` : `Collapse ${path}`}
        onClick={onToggleCollapse}
      >
        {collapsed ? <ChevronRight size={10} aria-hidden /> : <ChevronDown size={10} aria-hidden />}
      </button>
      <StatusIcon status={file.status} />
      {rename ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <PathLabel path={file.oldPath ?? ""} className="truncate" />
          <span className="text-muted">→</span>
          <PathLabel path={file.newPath ?? ""} className="truncate" />
          {file.similarity !== undefined && (
            <span className="text-muted">({file.similarity}%)</span>
          )}
        </span>
      ) : (
        <PathLabel path={path} className="min-w-0 truncate" />
      )}
      {file.status === "typechange" && <span className="text-muted">type changed</span>}
      {modeChanged && (
        <span className="font-mono text-[11px] text-muted">
          {formatMode(file.oldMode)} → {formatMode(file.newMode)}
        </span>
      )}
      <RowStats file={file} stats={stats} />
      {chipsFor(file).map((c) => (
        <LayerChip key={c} kind={c} />
      ))}
      <span className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-[4px] text-muted hover:bg-surface hover:text-ink"
          aria-label={copied ? "Path copied" : "Copy path"}
          title={copied ? "Copied" : "Copy path"}
          onClick={() => void copy()}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!onExpandAll}
          title="Expand all context"
          onClick={onExpandAll}
        >
          <UnfoldVertical size={12} aria-hidden />
          Expand all
        </button>
        <label className="flex cursor-pointer items-center gap-1.5 select-none">
          <input
            type="checkbox"
            className="size-3.5 accent-success"
            checked={viewed}
            onChange={onToggleViewed}
          />
          Viewed
        </label>
      </span>
    </header>
  );
}
