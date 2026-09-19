import type { AheadBehind } from "../../engine/types";
import { aheadBehindLabel, BAR_W, barWidths, CAPPED_TITLE } from "../branches";

/** The small `ref`-style tag Design §14.6 uses for `merged` and the `pull` / `push` hints. */
export function RefTag({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="ml-1.5 inline-flex h-4 shrink-0 items-center rounded-full border border-line bg-surface-raised px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap"
    >
      {label}
    </span>
  );
}

/**
 * Design §14.6: "a 60 px two-colour bar (`--success` ahead, `--danger` behind) plus numbers". The
 * bar is decorative — `aria-hidden`, because the numbers next to it say the same thing in text.
 */
export function AheadBehindCell({ ab }: { ab: AheadBehind }) {
  const w = barWidths(ab);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden
        data-bar={`${w.ahead}/${w.behind}`}
        style={{ width: BAR_W }}
        className="inline-flex h-1.5 shrink-0 overflow-hidden rounded-[3px] bg-surface-raised"
      >
        <i style={{ width: w.ahead }} className="block h-full bg-success" />
        <i style={{ width: w.behind }} className="block h-full bg-danger" />
      </span>
      <span
        className="font-mono text-[11.5px] tabular-nums"
        title={ab.capped ? CAPPED_TITLE : undefined}
      >
        {aheadBehindLabel(ab)}
      </span>
    </span>
  );
}

/** A cell the engine has not been asked for yet — the same skeleton the commit list uses. */
export function CellSkeleton() {
  return <span aria-hidden className="inline-block h-2.5 w-16 rounded-[2px] bg-surface-raised" />;
}

/** `—` with a reason, for a cell that was asked for and has no answer. */
export function NoValue({ title }: { title: string }) {
  return (
    <span className="text-muted" title={title}>
      —
    </span>
  );
}
