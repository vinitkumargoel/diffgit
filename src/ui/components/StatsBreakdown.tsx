import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { formatNumber, INDICATOR_ATTENTION, LINK_BUTTON, SKELETON_PILL } from "./statsRow.styles";

/** "2 files over 1 MB, 3 binary, 1 read error" — zero parts are left out. */
export function notCountedTitle(p: { tooLarge: number; binary: number; failed: number }): string {
  const parts: string[] = [];
  if (p.tooLarge > 0)
    parts.push(`${formatNumber(p.tooLarge)} ${p.tooLarge === 1 ? "file" : "files"} over 1 MB`);
  if (p.binary > 0) parts.push(`${formatNumber(p.binary)} binary`);
  if (p.failed > 0)
    parts.push(`${formatNumber(p.failed)} read ${p.failed === 1 ? "error" : "errors"}`);
  return parts.join(", ");
}

export interface StatsBreakdownProps {
  filesCount: number;
  totalFilesCount: number;
  filtering: boolean;
  dimCls?: string;
  countTitle?: string;
  totals: { additions: number; deletions: number };
  complete: boolean;
  stalled: boolean;
  dim: boolean;
}

export function StatsBreakdown({
  filesCount,
  totalFilesCount,
  filtering,
  dimCls = "",
  countTitle,
  totals,
  complete,
  stalled,
  dim,
}: StatsBreakdownProps) {
  let totalsNode: ReactNode;
  if (complete || stalled) {
    totalsNode = (
      <span
        className={`font-mono font-semibold tabular-nums ${dim || stalled ? "opacity-55" : ""}`}
      >
        <span className="text-success">+{formatNumber(totals.additions)}</span>{" "}
        <span className="text-danger">−{formatNumber(totals.deletions)}</span>
      </span>
    );
  } else {
    totalsNode = (
      <span
        role="img"
        aria-label="Counting changes"
        className="inline-flex shrink-0 items-center gap-1.5"
      >
        <span className={SKELETON_PILL} />
        <span className={SKELETON_PILL} />
      </span>
    );
  }

  return (
    <>
      <span className={`shrink-0 tabular-nums ${dimCls}`} title={countTitle}>
        <b className="font-semibold text-ink">{formatNumber(filesCount)}</b>{" "}
        {filtering
          ? `of ${formatNumber(totalFilesCount)} match`
          : `${filesCount === 1 ? "file" : "files"} changed`}
      </span>
      {totalsNode}
    </>
  );
}

export interface StatsNotCountedProps {
  notCounted: number;
  progressNotCounted: { tooLarge: number; binary: number; failed: number };
  onJump: () => void;
}

export function StatsNotCounted({ notCounted, progressNotCounted, onJump }: StatsNotCountedProps) {
  if (notCounted <= 0) return null;
  return (
    <span className={INDICATOR_ATTENTION} title={notCountedTitle(progressNotCounted)}>
      <TriangleAlert size={13} aria-hidden />
      <button type="button" className={LINK_BUTTON} onClick={onJump}>
        {formatNumber(notCounted)} not counted
      </button>
    </span>
  );
}
