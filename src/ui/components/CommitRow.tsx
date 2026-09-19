import type { CSSProperties } from "react";
import type { CommitSummary, RefSnapshot } from "../../engine/types";
import {
  edgePath,
  incomingLanes,
  incomingPath,
  LANE_W,
  laneColor,
  laneX,
  type RefChipKind,
  ROW_H,
  refChipKind,
  shortOid,
} from "../history";
import { timeAgo } from "../timeAgo";

const CHIP_CLASS: Record<RefChipKind, string> = {
  head: "bg-badge-head-bg text-badge-head-fg border-badge-head-border",
  branch: "bg-badge-default-bg text-badge-default-fg border-badge-default-border",
  remote: "bg-badge-remote-bg text-badge-remote-fg border-badge-remote-border",
  // §3.3 has no tag or stash row; T11.2 gave them the `M` and `T` palettes and §14.5 keeps them.
  tag: "bg-status-m-bg text-status-m-fg border-status-m-fg/40",
  stash: "bg-status-t-bg text-status-t-fg border-status-t-fg/40",
};

const CHIP_TITLE: Record<RefChipKind, string> = {
  head: "Checked-out branch",
  branch: "Branch",
  remote: "Remote-tracking branch",
  tag: "Tag",
  stash: "Stashed change",
};

/**
 * A ref that points at this commit (Design §14.5). Unlike `Badge` it prints the ref's own name —
 * `main`, `origin/main`, `v1.0.0` — in the palette of its kind.
 */
export function RefChip({ name, refs }: { name: string; refs: RefSnapshot | null }) {
  const kind = refChipKind(name, refs);
  return (
    <span
      className={`inline-flex h-4 max-w-[140px] shrink-0 items-center truncate rounded-full border px-1.5 font-mono text-[10.5px] leading-4 font-semibold ${CHIP_CLASS[kind]}`}
      title={`${CHIP_TITLE[kind]}: ${name}`}
    >
      {name}
    </span>
  );
}

/**
 * The 44 px lane column of Design §14.5, drawn from `CommitSummary.edges` (`docs/v2-contracts.md`,
 * T10.5). A row draws three things and never needs a third row: the half-height lines the row
 * above handed down (its `to` lanes), the node in this commit's own lane, and one path per edge
 * going into the band below. Lanes cycle through the three validated hues and then the muted tone.
 */
export function LaneCell({
  commit,
  previous,
}: {
  commit: CommitSummary;
  previous: CommitSummary | undefined;
}) {
  const laneCount = Math.max(1, commit.laneCount ?? 1);
  const lane = commit.lane ?? 0;
  const edges = commit.edges ?? [];
  const incoming = incomingLanes(previous);
  return (
    <svg
      width={LANE_W}
      height={ROW_H}
      viewBox={`0 0 ${LANE_W} ${ROW_H}`}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
      data-lane={lane}
      data-lanes={laneCount}
      data-edges={edges.length}
    >
      <title>{`lane ${lane + 1} of ${laneCount}`}</title>
      {incoming.map((l) => (
        <path
          key={`in-${l}`}
          d={incomingPath(l, laneCount)}
          stroke={laneColor(l)}
          strokeWidth={2}
          fill="none"
          data-edge="incoming"
        />
      ))}
      {edges.map((e) => (
        <path
          key={`${e.from}-${e.to}-${e.kind}`}
          d={edgePath(e, laneCount)}
          stroke={laneColor(e.from)}
          strokeWidth={2}
          fill="none"
          data-edge={e.kind}
        />
      ))}
      <circle
        cx={laneX(lane, laneCount)}
        cy={ROW_H / 2}
        r={4.5}
        fill={laneColor(lane)}
        stroke="var(--bg)"
        strokeWidth={2}
      />
    </svg>
  );
}

export interface CommitRowProps {
  commit: CommitSummary;
  /** The row above, for the lines entering this one; undefined on the first row of the list. */
  previous: CommitSummary | undefined;
  refs: RefSnapshot | null;
  /** `+n −m` once `commitStats` has answered; `undefined` = still streaming, `null` = not counted. */
  stats: { additions: number; deletions: number } | null | undefined;
  selected: boolean;
  /** The other end of a shift-selected range, highlighted like the selection. */
  inRange: boolean;
  focused: boolean;
  index: number;
  now: number;
  onSelect: (oid: string, extend: boolean) => void;
  onFocus: (index: number) => void;
  style?: CSSProperties;
}

/**
 * One 30 px row of the commit list (Design §14.5): lane column, short SHA in `--accent` mono,
 * subject, ref badges, then author and age right-aligned with `+n −m` when it is known.
 */
export function CommitRow({
  commit,
  previous,
  refs,
  stats,
  selected,
  inRange,
  focused,
  index,
  now,
  onSelect,
  onFocus,
  style,
}: CommitRowProps) {
  const highlight = selected
    ? "bg-accent-subtle shadow-[inset_2px_0_0_var(--accent)]"
    : inRange
      ? "bg-accent-subtle"
      : "hover:bg-surface-raised";
  return (
    <div
      role="option"
      aria-selected={selected}
      data-index={index}
      data-oid={commit.oid}
      tabIndex={focused ? 0 : -1}
      style={style}
      className={`flex h-[30px] w-full items-center gap-2 pr-3 text-left text-[12.5px] leading-5 ${highlight}`}
      onClick={(e) => onSelect(commit.oid, e.shiftKey)}
      onFocus={() => onFocus(index)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(commit.oid, e.shiftKey);
        }
      }}
    >
      <LaneCell commit={commit} previous={previous} />
      <span className="shrink-0 font-mono text-[11px] text-accent">{shortOid(commit.oid)}</span>
      <span className="min-w-0 flex-1 truncate text-ink" title={commit.subject}>
        {commit.subject}
      </span>
      {commit.refs.map((r) => (
        <RefChip key={r} name={r} refs={refs} />
      ))}
      <span className="shrink-0 text-[11px] whitespace-nowrap text-muted">
        {commit.author.name} · {timeAgo(commit.author.timestamp, now)}
      </span>
      {stats === undefined ? (
        <span aria-hidden className="h-2.5 w-8 shrink-0 rounded-[2px] bg-surface-raised" />
      ) : stats === null ? (
        <span className="shrink-0 font-mono text-[11px] text-muted">—</span>
      ) : (
        <span className="shrink-0 font-mono text-[11px] whitespace-nowrap tabular-nums">
          <span className="text-success">+{stats.additions}</span>{" "}
          <span className="text-danger">−{stats.deletions}</span>
        </span>
      )}
    </div>
  );
}
