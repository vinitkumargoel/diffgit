const WIDTHS = [60, 80, 40, 90, 70, 50];

/** Card body placeholder (Design §7.5): six 14 px `--surface-raised` bars, 8 px gap, 12 px padding. */
export function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3" role="status" aria-label="Loading diff">
      {WIDTHS.map((w) => (
        <div
          key={w}
          className="h-3.5 rounded-[3px] bg-surface-raised motion-safe:animate-pulse"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}
