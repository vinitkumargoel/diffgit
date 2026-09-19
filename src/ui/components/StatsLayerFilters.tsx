import { Fragment } from "react";
import type { Breakdown } from "../store";
import { parseFilter } from "../treeModel";
import { LayerChip } from "./LayerChip";
import {
  ACTIVE_OUTLINE,
  BREAKDOWN_GROUP_CLASS,
  DIVIDER_CLASS,
  formatNumber,
  LAYER_KEYS,
  LAYER_TOGGLE_ACTIVE,
  LAYER_TOGGLE_BASE,
  STATUS_KEYS,
  STATUS_META,
  STATUS_TOGGLE_BASE,
  type StatusKey,
} from "./statsRow.styles";

export function Divider() {
  return <span aria-hidden className={DIVIDER_CLASS} />;
}

/** Adds the token when absent, removes it when already there; every other word survives. */
export function toggleFilterToken(filter: string, token: string): string {
  const words = filter.trim().split(/\s+/).filter(Boolean);
  const at = words.findIndex((w) => w.toLowerCase() === token.toLowerCase());
  if (at >= 0) words.splice(at, 1);
  else words.push(token);
  return words.join(" ");
}

export function listTitle(pairs: [number, string][]): string {
  return pairs
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${formatNumber(count)} ${word}`)
    .join(", ");
}

export function statusTitleOf(breakdown: Breakdown): string {
  return listTitle(
    STATUS_KEYS.map((k) => [breakdown.status[k], STATUS_META[k].word] as [number, string]),
  );
}

export function layerTitleOf(breakdown: Breakdown): string {
  return listTitle(LAYER_KEYS.map((k) => [breakdown.layers[k], k] as [number, string]));
}

/** The 15 px status square of the breakdown — a toggle for its `status:` filter token. */
export function StatusToggle({
  letter,
  pressed,
  onToggle,
  count,
}: {
  letter: StatusKey;
  pressed: boolean;
  onToggle: () => void;
  count: number;
}) {
  const m = STATUS_META[letter];
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={`Filter: ${m.word} (${formatNumber(count)})`}
      title={`Filter: ${m.token}`}
      onClick={onToggle}
      className={`${STATUS_TOGGLE_BASE} ${m.cls} ${pressed ? ACTIVE_OUTLINE : ""}`}
    >
      {letter}
    </button>
  );
}

export interface StatsLayerFiltersProps {
  breakdown: Breakdown;
  filter: string;
  dimCls?: string;
  onFilterChange: (nextFilter: string) => void;
}

export function StatsLayerFilters({
  breakdown,
  filter,
  dimCls = "",
  onFilterChange,
}: StatsLayerFiltersProps) {
  const parsed = parseFilter(filter);
  const statusTitle = statusTitleOf(breakdown);
  const layerTitle = layerTitleOf(breakdown);

  return (
    <>
      {statusTitle !== "" && (
        <>
          <Divider />
          <span title={statusTitle} className={`${BREAKDOWN_GROUP_CLASS} ${dimCls}`}>
            {STATUS_KEYS.filter((k) => breakdown.status[k] > 0).map((k) => (
              <Fragment key={k}>
                <StatusToggle
                  letter={k}
                  count={breakdown.status[k]}
                  pressed={parsed.statuses?.includes(STATUS_META[k].status) ?? false}
                  onToggle={() => onFilterChange(toggleFilterToken(filter, STATUS_META[k].token))}
                />
                <span className="font-mono text-[12px] tabular-nums text-ink/80">
                  {formatNumber(breakdown.status[k])}
                </span>
              </Fragment>
            ))}
          </span>
        </>
      )}
      {layerTitle !== "" && (
        <>
          <Divider />
          <span title={layerTitle} className={`${BREAKDOWN_GROUP_CLASS} ${dimCls}`}>
            {LAYER_KEYS.filter((k) => breakdown.layers[k] > 0).map((k) => (
              <Fragment key={k}>
                <button
                  type="button"
                  aria-pressed={parsed.layers?.includes(k) ?? false}
                  aria-label={`Filter: ${k} (${formatNumber(breakdown.layers[k])})`}
                  title={`Filter: layer:${k}`}
                  className={parsed.layers?.includes(k) ? LAYER_TOGGLE_ACTIVE : LAYER_TOGGLE_BASE}
                  onClick={() => onFilterChange(toggleFilterToken(filter, `layer:${k}`))}
                >
                  <LayerChip kind={k} />
                </button>
                <span className="-ml-px font-mono text-[11.5px] tabular-nums">
                  {formatNumber(breakdown.layers[k])}
                </span>
              </Fragment>
            ))}
          </span>
        </>
      )}
    </>
  );
}
