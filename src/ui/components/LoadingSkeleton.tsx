const WIDTHS = [60, 80, 40, 90, 70, 50];

/**
 * Card body placeholder (Design §7.5): six 14 px `--surface-raised` bars, 8 px gap, 12 px padding.
 * `label` names the phase the card is waiting for — T11.6 adds the engine's `"blame"` progress
 * phase, which is the slow one and the only one worth spelling out ("Blaming <path>").
 */
export function LoadingSkeleton({ label = "Loading diff" }: { label?: string }) {
  return (
    <div className="flex flex-col gap-2 p-3" role="status" aria-label={label}>
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
