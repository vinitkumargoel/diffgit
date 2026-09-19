import { CircleX } from "lucide-react";
import type { CSSProperties, FocusEventHandler, KeyboardEventHandler } from "react";
import type { FileDiff } from "../../engine/types";
import type { SidebarLayout } from "../store";
import { filePathOf, type LayerCodeInfo } from "../treeModel";
import { LayerCode } from "./LayerCode";
import { SecretTag } from "./SecretTag";
import { StatusIcon } from "./StatusIcon";

export interface FileRowProps {
  file: FileDiff;
  depth: number;
  layout: SidebarLayout;
  active: boolean;
  viewed: boolean;
  stats: FileDiff["stats"];
  /** D4: git's XY code, when this row should carry one (`layerCode`); null renders nothing. */
  code?: LayerCodeInfo | null;
  /** T11.9: findings in this file — the `secret` chip goes after the XY code (Design §14.3). */
  secrets?: number;
  /** The file's diff request errored — the row shows the red `retry` mark (S3). */
  failed?: boolean;
  onRetry?: () => void;
  onActivate: () => void;
  /** T11.4: right-click asks "why is this in / not in the diff" (WhyHidden popover). */
  onExplain?: () => void;
  onToggleViewed: () => void;
  /** Roving-tabindex plumbing from the tree. */
  role: "treeitem" | "option";
  "aria-level"?: number;
  "aria-selected": boolean;
  "data-index": number;
  tabIndex: number;
  onFocus: FocusEventHandler<HTMLDivElement>;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  style?: CSSProperties;
}

export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i === -1
    ? { dir: "", base: path }
    : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/**
 * `+n −m` (mono 11 px), 32 × 10 px skeleton while stats are loading (Design §7.4) and the three
 * "not counted" marks of mockup S3: `> 1 MB` (gated, loadable), `—` (binary, never counted) and a
 * red `retry` (the per-file read failed — actionable).
 */
export function RowStats({
  file,
  stats,
  failed,
  onRetry,
}: {
  file: FileDiff;
  stats: FileDiff["stats"];
  /** The file's diff request errored (`selectFailedFiles`). */
  failed?: boolean;
  onRetry?: () => void;
}) {
  if (file.tooLarge && !file.binary) {
    return (
      <span
        className="font-mono text-[11px] whitespace-nowrap text-muted"
        title="Over 1 MB — Load diff in the card"
      >
        &gt; 1 MB
      </span>
    );
  }
  if (file.binary) {
    return (
      <span role="img" className="font-mono text-[11px] text-muted" aria-label="Binary file">
        —
      </span>
    );
  }
  if (failed) {
    return (
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-[3px] font-mono text-[11px] text-danger hover:underline"
        aria-label="Stats failed: retry"
        title="Read error — click to retry"
        onClick={(e) => {
          e.stopPropagation();
          onRetry?.();
        }}
      >
        <CircleX size={11} aria-hidden />
        retry
      </button>
    );
  }
  if (!stats) {
    return (
      <span
        className="inline-block h-2.5 w-8 rounded-[2px] bg-surface-raised"
        role="img"
        aria-label="Loading stats"
      />
    );
  }
  return (
    <span className="font-mono text-[11px] tabular-nums whitespace-nowrap">
      <span className="text-success">+{stats.additions}</span>{" "}
      <span className="text-danger">−{stats.deletions}</span>
    </span>
  );
}

/** Sidebar file row, 26 px, element order per Design §7.4. The tree owns roles and keyboard. */
export function FileRow({
  file,
  depth,
  layout,
  active,
  viewed,
  stats,
  code,
  secrets,
  failed,
  onRetry,
  onActivate,
  onExplain,
  onToggleViewed,
  role,
  tabIndex,
  onFocus,
  onKeyDown,
  style,
  ...aria
}: FileRowProps) {
  const path = filePathOf(file);
  const { dir, base } = splitPath(path);
  const renameTitle =
    file.status === "renamed" || file.status === "copied"
      ? `${file.oldPath ?? ""} → ${file.newPath ?? ""}${file.similarity !== undefined ? ` (${file.similarity}%)` : ""}`
      : undefined;
  const common = {
    "aria-selected": aria["aria-selected"],
    "data-index": aria["data-index"],
    className: `flex h-[26px] cursor-pointer items-center gap-[7px] pr-2 select-none ${
      active ? "bg-accent-subtle shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-raised"
    } ${viewed ? "opacity-55" : ""}`,
    style: { ...style, paddingLeft: 12 + (layout === "tree" ? depth * 14 : 0) },
    title: path,
    onFocus,
    onKeyDown,
    onClick: onActivate,
    ...(onExplain
      ? {
          onContextMenu: (e: React.MouseEvent) => {
            e.preventDefault();
            onExplain();
          },
        }
      : {}),
  };
  const content = (
    <>
      <StatusIcon status={file.status} title={renameTitle} />
      <span
        className={`min-w-0 flex-1 truncate text-[12.5px] leading-5 font-medium${
          file.status === "deleted" ? " text-muted line-through" : ""
        }`}
      >
        {layout === "flat" && dir && <span className="font-normal text-muted">{dir}</span>}
        {base}
      </span>
      {code ? <LayerCode code={code} /> : null}
      {secrets ? <SecretTag count={secrets} /> : null}
      <RowStats file={file} stats={stats} failed={failed} onRetry={onRetry} />
      <input
        type="checkbox"
        className="size-3.5 shrink-0 accent-success"
        checked={viewed}
        tabIndex={-1}
        aria-label={`Viewed: ${path}`}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggleViewed}
      />
    </>
  );
  return role === "treeitem" ? (
    <div role="treeitem" aria-level={aria["aria-level"]} tabIndex={tabIndex} {...common}>
      {content}
    </div>
  ) : (
    <div role="option" tabIndex={tabIndex} {...common}>
      {content}
    </div>
  );
}
