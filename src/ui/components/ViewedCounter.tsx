/** "3 / 11 viewed" + 80 × 6 px progress bar (Design §7.2). */
export function ViewedCounter({ viewed, total }: { viewed: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((viewed / total) * 100);
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted tabular-nums">
      <span data-testid="viewed-count">
        <b className="font-semibold text-ink">{viewed}</b> / {total} viewed
      </span>
      <div
        role="progressbar"
        aria-label="Files viewed"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={viewed}
        className="h-1.5 w-20 overflow-hidden rounded-[3px] bg-progress-track"
      >
        <div className="h-full bg-success" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
