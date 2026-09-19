/**
 * Insights mode, pure part (T11.12, Design §14.6; atlas tab 13).
 *
 * Maths and strings only: the window each period chip asks for, the quintile a day's commit count
 * lands in on the §3.6 heat ramp, the geometry of the 52 × 7 activity grid, the width of a hotspot
 * bar, and every label the page prints. No React and no engine calls — the store owns those — so
 * `insights.test.ts` can check the rules on the recorded `history` pass without rendering anything.
 */
import type { InsightsResult } from "../engine/types";
import type { Heat } from "./blame";
import { formatBytes } from "./format";
import type { InsightsPeriod } from "./store";

/**
 * Hotspots asked for per group (`insights(req).limit`). The engine answers the top `limit` real
 * files *followed by* the top `limit` manifests, so one number sizes both lists; 12 is the length
 * the atlas mockup's ranked list reads at, and short enough that the page stays one screen of
 * sections rather than one screen of bars.
 */
export const INSIGHTS_LIMIT = 12;

export const DAY_MS = 86_400_000;

/**
 * The header's chips (Design §14.6 "header with `90 d | 1 y | All`"). `days` is the window the UI
 * turns into `InsightsRequest.sinceMs`; `null` is the whole history, which sends no `sinceMs`.
 */
export const INSIGHTS_PERIODS: { id: InsightsPeriod; label: string; days: number | null }[] = [
  { id: "90d", label: "90 d", days: 90 },
  { id: "1y", label: "1 y", days: 365 },
  { id: "all", label: "All", days: null },
];

/**
 * The window a period asks for, counted back from `anchor`. `undefined` (period `all`) means "send
 * no `sinceMs`", which is the whole history.
 *
 * `anchor` is the newest commit the UI knows about rather than the wall clock wherever it can be:
 * the engine deliberately has no clock of its own (contracts `<!-- T10.9 -->`: `activity` ends at
 * the week of the newest commit, not at today), the derived cache is keyed by tip oid + period, and
 * a repository whose last commit is a year old should answer "the 90 days up to its last commit"
 * instead of an empty page. The store falls back to `Date.now()` when it knows no commit date yet.
 */
export function sinceMsFor(period: InsightsPeriod, anchor: number): number | undefined {
  const days = INSIGHTS_PERIODS.find((p) => p.id === period)?.days ?? null;
  return days === null ? undefined : anchor - days * DAY_MS;
}

export const PERIOD_LABEL: Record<InsightsPeriod, string> = {
  "90d": "the last 90 days",
  "1y": "the last year",
  all: "the whole history",
};

// ---- activity grid (Design §14.6 "52-week heatmap using the `--heat*` ramp") ------------------

/** Widest grid the engine can answer with: `activity` is at most 52 weeks (contracts T10.9). */
export const ACTIVITY_WEEKS = 52;
/** `days[0]` is that week's Sunday (contracts T10.9), so row 0 is Sunday. */
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
/** Only three weekday labels are drawn, as GitHub's own grid does — the rest are noise. */
export const WEEKDAY_LABELS: { row: number; label: string }[] = [
  { row: 1, label: "Mon" },
  { row: 3, label: "Wed" },
  { row: 5, label: "Fri" },
];

/** Cell side and gap in px; a week is a column of 7 (`CELL + GAP` apart). */
export const CELL = 10;
export const GAP = 2;
/** Width of the weekday label gutter to the left of the grid. */
export const GUTTER = 26;

export function gridWidth(weeks: number): number {
  return GUTTER + weeks * (CELL + GAP);
}
export function gridHeight(): number {
  return 7 * (CELL + GAP);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The instant of day `index` (0 = Sunday) in the week that starts at `weekStart`. */
export function dayMs(weekStart: number, index: number): number {
  return weekStart + index * DAY_MS;
}

/**
 * `4 Mar 2024` from a local-midnight instant. `weekStart` is the **local** midnight of that week's
 * Sunday (contracts T10.9), so the date is read with local getters: the engine and the page run in
 * the same zone, and a UTC read would name the wrong day west of Greenwich.
 */
export function formatDay(ms: number): string {
  const at = new Date(ms);
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

/** The label of one cell — the tooltip and its accessible name: "3 commits on 4 Mar 2024". */
export function dayLabel(ms: number, count: number): string {
  const what =
    count === 0 ? "No commits" : `${count.toLocaleString("en-US")} commit${count === 1 ? "" : "s"}`;
  return `${what} on ${formatDay(ms)}`;
}

/** The label of one column, for the `sr-only` table that is the grid's text alternative. */
export function weekLabel(weekStart: number): string {
  return `Week of ${formatDay(weekStart)}`;
}

/**
 * The distinct non-zero day counts of a pass, smallest first — the sample the ramp buckets against.
 * A day with no commits is not in it: it has no heat, it is an empty cell.
 */
export function countOrder(activity: InsightsResult["activity"]): number[] {
  const seen = new Set<number>();
  for (const week of activity) for (const n of week.days) if (n > 0) seen.add(n);
  return [...seen].sort((a, b) => a - b);
}

/**
 * Which step of the §3.6 ramp a day gets: 1 = quietest, 5 = busiest, `null` = no commits. It is the
 * count's **rank** among the distinct counts spread across the five steps — `blame.ts`'s `heatOf`
 * for age, and the same reason: a quintile over the *days* would paint a repository whose days are
 * nearly all `1` in one colour, and the recorded `history` pass is exactly that repository.
 */
export function heatOfCount(count: number, order: readonly number[]): Heat | null {
  if (count <= 0) return null;
  if (order.length <= 1) return 5;
  const rank = order.indexOf(count);
  if (rank < 0) return 5;
  return (1 + Math.round((rank * 4) / (order.length - 1))) as Heat;
}

/** Tailwind `fill-*` utilities for the ramp; SVG rects take a fill, not a background (§3.6). */
export const HEAT_FILL = [
  "fill-heat-1",
  "fill-heat-2",
  "fill-heat-3",
  "fill-heat-4",
  "fill-heat-5",
] as const;
/** A day with no commits: the same empty ground the skeletons use. */
export const EMPTY_FILL = "fill-surface-raised";

export function heatFill(heat: Heat | null): string {
  return heat === null ? EMPTY_FILL : (HEAT_FILL[heat - 1] as string);
}

// ---- hotspots (Design §14.6 "commits × size, horizontal bars, manifests greyed") ---------------

export type Hotspot = InsightsResult["hotspots"][number];

/**
 * The two groups the engine hands back in one array: the ranked real files first, then the
 * manifests it kept but deliberately left out of the ranking (contracts T10.9).
 */
export function hotspotGroups(hotspots: readonly Hotspot[]): {
  ranked: Hotspot[];
  manifests: Hotspot[];
} {
  return {
    ranked: hotspots.filter((h) => !h.manifest),
    manifests: hotspots.filter((h) => h.manifest),
  };
}

/**
 * Bar width in percent. Both groups are measured against the **ranked** maximum, as the mockup
 * draws them, so a lockfile's grey bar can be read against the files it is excluded from.
 */
export function barPercent(score: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((score / max) * 100)));
}

export function maxScore(ranked: readonly Hotspot[]): number {
  return ranked.reduce((m, h) => Math.max(m, h.score), 0);
}

/** `9 commits · 631 B` — the number beside a hotspot bar. `size` is the blob size at the tip. */
export function hotspotValue(h: Hotspot): string {
  const commits = `${h.commits.toLocaleString("en-US")} commit${h.commits === 1 ? "" : "s"}`;
  return h.size === 0 ? commits : `${commits} · ${formatBytes(h.size)}`;
}

/** The title of a hotspot row: what the score is made of, spelled out. */
export function hotspotTitle(h: Hotspot): string {
  return `${h.path} · score ${h.score.toLocaleString("en-US")} = ${h.commits} commit${
    h.commits === 1 ? "" : "s"
  } × log₂(size)`;
}

// ---- contributors ------------------------------------------------------------------------------

export type Author = InsightsResult["authors"][number];

/** Share of the period's author commits, for the bar beside a contributor (never for a judgement). */
export function sharePercent(commits: number, top: number): number {
  if (top <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((commits / top) * 100)));
}

/** `8 commits by bots, counted separately` — the line Design §14.6 keeps out of the ranking. */
export function botsLine(bots: number): string | null {
  if (bots <= 0) return null;
  return `${bots.toLocaleString("en-US")} commit${bots === 1 ? "" : "s"} by bots, counted separately and left out of the list above.`;
}

// ---- copy ---------------------------------------------------------------------------------------

export const HOTSPOTS_TITLE = "Hotspots";
export const HOTSPOTS_NOTE = "Commits touching the file × its current size.";
export const MANIFESTS_NOTE = "Manifests and lockfiles: kept, but excluded from the ranking above.";
export const ACTIVITY_TITLE = "Activity";
export const ACTIVITY_NOTE = "Commits per day, ending at the week of the newest commit.";
export const ACTIVITY_LESS = "Less";
export const ACTIVITY_MORE = "More";
export const CONTRIBUTORS_TITLE = "Show contributors";
export const MAILMAP_NOTE =
  "Identities are folded through the repository’s .mailmap. Commit counts measure activity, not value.";
export const LOADING_LABEL = "Walking the first-parent history…";
export const EMPTY_REPO = "No commits yet, so there is nothing to summarise.";
export const EMPTY_PERIOD_ACTION = "Show the whole history";
export const ERROR_TITLE = "Couldn’t summarise this repository";

/** The `INSIGHTS_CAPPED` copy, as **one inline line** under the page rather than a banner. */
export function cappedLine(walked: number): string {
  return `The walk stopped at ${walked.toLocaleString("en-US")} commits, so these numbers are a sample of the newest history.`;
}

/** `48 commits · 3 authors` — the counts in the page header, beside the period chips. */
export function summaryLine(result: InsightsResult): string {
  const commits = `${result.commits.toLocaleString("en-US")} commit${result.commits === 1 ? "" : "s"}`;
  const authors = `${result.authors.length.toLocaleString("en-US")} author${
    result.authors.length === 1 ? "" : "s"
  }`;
  return `${commits} · ${authors}`;
}

/** The footer Design §14.6 asks for: what was walked, and whether this answer came from the cache. */
export function walkedLine(result: InsightsResult, cached: boolean): string {
  const walked = `Walked ${result.walked.toLocaleString("en-US")} first-parent commit${
    result.walked === 1 ? "" : "s"
  } from HEAD`;
  return cached ? `${walked} · cached` : walked;
}

/** "No commits in the last 90 days." — a period with nothing in it, but a history behind it. */
export function emptyPeriodLine(period: InsightsPeriod): string {
  return `No commits in ${PERIOD_LABEL[period]}.`;
}

/** The answer for a repository with no commits at all; no engine call can say anything else. */
export const EMPTY_RESULT: InsightsResult = {
  commits: 0,
  authors: [],
  hotspots: [],
  activity: [],
  walked: 0,
  capped: false,
  bots: 0,
};
