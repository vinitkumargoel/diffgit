import { ChevronDown, ChevronRight, MoreHorizontal, UnfoldVertical } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { FileDiff } from "../../engine/types";
import type { CardMode } from "../store";
import { filePathOf } from "../treeModel";
import { CardModeSwitch } from "./CardModeSwitch";
import { RowStats, splitPath } from "./FileRow";
import { chipsFor, LayerChip } from "./LayerChip";
import { StatusIcon } from "./StatusIcon";
import { type PopoverAnchor, WhyHiddenPopover } from "./WhyHiddenPopover";

export interface FileHeaderProps {
  file: FileDiff;
  stats: FileDiff["stats"];
  collapsed: boolean;
  viewed: boolean;
  onToggleCollapse: () => void;
  onToggleViewed: () => void;
  /** Undefined while there is nothing to expand (button disabled). */
  onExpandAll?: () => void;
  /** An extra `ref`-style tag after the layer chips (T11.3: the conflict kind). */
  tag?: ReactNode;
  /**
   * T11.6: `Diff | Blame | History` (Design §14.1). Undefined when the file has no committed side,
   * in which case the control is not rendered at all.
   */
  mode?: CardMode;
  onMode?: (mode: CardMode) => void;
}

/** `100644` for 0o100644; null when the side is absent. */
function formatMode(mode: number | null): string | null {
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

/** A `…` menu row; an action whose task has not shipped is disabled, never hidden (T11.5's rule). */
function MenuItem({
  label,
  onClick,
  pending,
}: {
  label: string;
  onClick?: () => void;
  pending?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={pending !== undefined}
      title={pending === undefined ? undefined : `coming soon (${pending})`}
      className="flex w-full items-center px-3 py-1.5 text-left text-[12.5px] leading-5 text-ink not-disabled:hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const COPIED_MS = 1500;

/**
 * The header's `…` menu (Design §14.1 "never buttons in the chrome"): `Why is this file shown like
 * this` opens T11.4's explanation popover, `Copy path` is v1's copy button moved in here, and
 * `Export this file as .patch` is T11.10's and disabled until it ships.
 */
function FileMenu({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const [why, setWhy] = useState<PopoverAnchor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(path);
      setCopied("done");
    } catch {
      // clipboard blocked (permissions / insecure context): say so instead of failing silently (T7.3)
      setCopied("failed");
    }
    timer.current = setTimeout(() => setCopied("idle"), COPIED_MS);
  };

  const openWhy = () => {
    const box = trigger.current?.getBoundingClientRect();
    setWhy({ left: box?.left ?? 0, bottom: box?.bottom ?? 0 });
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        className="flex size-6 items-center justify-center rounded-[4px] text-muted hover:bg-surface hover:text-ink"
        aria-label={`More actions for ${path}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`More actions for ${path}`}
          className="absolute top-full right-0 z-10 mt-1 w-64 rounded-[6px] border border-line bg-surface py-1 shadow-popover"
        >
          <MenuItem label="Why is this file shown like this" onClick={openWhy} />
          <MenuItem
            label={copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy path"}
            onClick={() => void copy()}
          />
          <MenuItem label="Export this file as .patch" pending="T11.10" />
        </div>
      )}
      {why && (
        <WhyHiddenPopover
          path={path}
          anchor={why}
          onClose={(refocus) => {
            setWhy(null);
            if (refocus) trigger.current?.focus();
          }}
        />
      )}
    </div>
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
  tag,
  mode,
  onMode,
}: FileHeaderProps) {
  const path = filePathOf(file);
  const rename = file.status === "renamed" || file.status === "copied";
  const modeChanged =
    file.oldMode !== null && file.newMode !== null && file.oldMode !== file.newMode;

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
      {tag}
      <span className="ml-auto flex items-center gap-2">
        {mode !== undefined && onMode !== undefined && (
          <CardModeSwitch mode={mode} onMode={onMode} path={path} />
        )}
        <FileMenu path={path} />
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
