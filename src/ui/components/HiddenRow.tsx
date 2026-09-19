import type { CSSProperties, FocusEventHandler, KeyboardEventHandler } from "react";
import type { HiddenEntry } from "../../engine/types";
import { HIDDEN_SENTENCE, HIDDEN_TAG, hiddenRowLabel } from "../hidden";
import { splitPath } from "./FileRow";

/**
 * Design §14.4: one row of the Hidden group. Muted, 26 px like a FileRow so the two lists align,
 * with the small `ref`-style tag naming the reason. An ignored directory is a single row carrying
 * the count of what is inside it and never expands — that is the whole point of `ignored-dir`
 * (atlas tab 08 "Risks": listing `node_modules` would be 100,000 rows).
 */
export function HiddenRow({
  entry,
  active,
  onExplain,
  tabIndex,
  onFocus,
  onKeyDown,
  index,
  style,
}: {
  entry: HiddenEntry;
  /** The WhyHidden popover is open on this row. */
  active: boolean;
  onExplain: () => void;
  tabIndex: number;
  onFocus: FocusEventHandler<HTMLDivElement>;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  index: number;
  style?: CSSProperties;
}) {
  const isDir = entry.kind === "ignored-dir";
  const { dir, base } = splitPath(entry.path);
  return (
    <div
      role="treeitem"
      aria-level={2}
      aria-selected={active}
      aria-haspopup="dialog"
      aria-expanded={active}
      aria-label={hiddenRowLabel(entry)}
      data-index={index}
      data-hidden-kind={entry.kind}
      tabIndex={tabIndex}
      title={hiddenRowLabel(entry)}
      className={`flex h-[26px] cursor-pointer items-center gap-[7px] pr-2 text-muted select-none ${
        active ? "bg-accent-subtle shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-raised"
      }`}
      style={{ ...style, paddingLeft: 12 }}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={onExplain}
      onContextMenu={(e) => {
        e.preventDefault();
        onExplain();
      }}
    >
      <span aria-hidden className="w-4 shrink-0 text-center font-mono text-[10px] leading-4">
        ·
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] leading-5">
        {dir && <span className="opacity-70">{dir}</span>}
        {base}
        {isDir && "/"}
      </span>
      {isDir && entry.count !== undefined && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">{entry.count}</span>
      )}
      <span
        aria-hidden
        title={HIDDEN_SENTENCE[entry.kind]}
        className="inline-flex h-4 shrink-0 items-center rounded-full border border-line bg-surface-raised px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap"
      >
        {HIDDEN_TAG[entry.kind]}
      </span>
    </div>
  );
}
