import { useEffect, useRef } from "react";
import type { InsightsResult } from "../../engine/types";
import { describeError } from "../errors";
import {
  ACTIVITY_LESS,
  ACTIVITY_MORE,
  ACTIVITY_NOTE,
  ACTIVITY_TITLE,
  barPercent,
  botsLine,
  CELL,
  CONTRIBUTORS_TITLE,
  cappedLine,
  countOrder,
  dayLabel,
  dayMs,
  EMPTY_PERIOD_ACTION,
  EMPTY_REPO,
  ERROR_TITLE,
  emptyPeriodLine,
  GAP,
  GUTTER,
  gridHeight,
  gridWidth,
  HEAT_FILL,
  HOTSPOTS_NOTE,
  HOTSPOTS_TITLE,
  type Hotspot,
  heatFill,
  heatOfCount,
  hotspotGroups,
  hotspotTitle,
  hotspotValue,
  INSIGHTS_PERIODS,
  LOADING_LABEL,
  MAILMAP_NOTE,
  MANIFESTS_NOTE,
  maxScore,
  sharePercent,
  summaryLine,
  WEEKDAY_LABELS,
  WEEKDAYS,
  walkedLine,
  weekLabel,
} from "../insights";
import { useStore } from "../store";
import { CenteredColumn } from "./CenteredColumn";
import { Notice } from "./Notice";

const SEGMENT_CLASS = "rounded-[6px] px-[7px] py-[2px] text-[11px] leading-4 font-medium";
const SECTION_CLASS = "border-b border-line-subtle px-3 py-3";
const H2_CLASS = "text-[13px] leading-5 font-semibold text-ink";
const NOTE_CLASS = "mt-0.5 text-[11.5px] leading-4 text-muted";

/** The page's own header, which replaces the StatsRow in this mode (Design §14.1). */
function InsightsHeader({ summary }: { summary: string | null }) {
  const period = useStore((s) => s.prefs.insightsPeriod);
  const setInsightsPeriod = useStore((s) => s.setInsightsPeriod);
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-3 py-1 text-[12.5px] leading-5 text-muted">
      <fieldset className="inline-flex rounded-[6px] border border-line bg-surface-raised p-0">
        <legend className="sr-only">Period covered by these insights</legend>
        {INSIGHTS_PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={period === p.id}
            className={`${SEGMENT_CLASS} ${period === p.id ? "pressed" : "text-muted hover:text-ink"}`}
            onClick={() => setInsightsPeriod(p.id)}
          >
            {p.label}
          </button>
        ))}
      </fieldset>
      <span className="flex-1" />
      {summary !== null && <span className="shrink-0 tabular-nums">{summary}</span>}
    </div>
  );
}

/**
 * One hotspot: path, a bar in `--accent` (a manifest's is `--muted`, the grey Design §3 actually
 * defines) and the numbers the score is made of. The whole row is the button, so clicking anywhere
 * on it filters Files mode down to that path; the bar itself is decorative, because the numbers
 * beside it say the same thing in text.
 */
function HotspotRow({ hotspot, max }: { hotspot: Hotspot; max: number }) {
  const showHotspot = useStore((s) => s.showHotspot);
  return (
    <li>
      <button
        type="button"
        data-path={hotspot.path}
        title={hotspotTitle(hotspot)}
        onClick={() => showHotspot(hotspot.path)}
        className="grid w-full grid-cols-[minmax(6rem,18rem)_1fr_auto] items-center gap-3 rounded-[6px] px-2 py-1 text-left hover:bg-surface-raised focus-visible:bg-accent-subtle"
      >
        <span
          className={`truncate font-mono text-[12px] ${hotspot.manifest ? "text-muted" : "text-ink"}`}
        >
          {hotspot.path}
        </span>
        <span
          aria-hidden
          className="h-2 w-full min-w-8 overflow-hidden rounded-[3px] bg-surface-raised"
        >
          <i
            style={{ width: `${barPercent(hotspot.score, max)}%` }}
            className={`block h-full ${hotspot.manifest ? "bg-muted" : "bg-accent"}`}
          />
        </span>
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted">
          {hotspotValue(hotspot)}
        </span>
      </button>
    </li>
  );
}

function Hotspots({ result }: { result: InsightsResult }) {
  const { ranked, manifests } = hotspotGroups(result.hotspots);
  const max = maxScore(ranked);
  if (ranked.length === 0 && manifests.length === 0) return null;
  return (
    <section className={SECTION_CLASS} aria-labelledby="insights-hotspots">
      <h2 id="insights-hotspots" className={H2_CLASS}>
        {HOTSPOTS_TITLE}
      </h2>
      <p className={NOTE_CLASS}>{HOTSPOTS_NOTE}</p>
      <ul className="mt-2 flex flex-col gap-0.5">
        {ranked.map((h) => (
          <HotspotRow key={h.path} hotspot={h} max={max} />
        ))}
      </ul>
      {manifests.length > 0 && (
        <>
          <p className={`${NOTE_CLASS} mt-2`}>{MANIFESTS_NOTE}</p>
          <ul className="mt-1 flex flex-col gap-0.5" data-manifests>
            {manifests.map((h) => (
              <HotspotRow key={h.path} hotspot={h} max={max} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The 52 × 7 grid of Design §14.6, drawn as plain SVG (no chart library): one column per week,
 * `days[0]` on top because that is the week's Sunday (contracts T10.9), each cell filled from the
 * §3.6 `--heat1..5` ramp by the quintile its commit count falls in. Every cell carries a `<title>`
 * — the pointer tooltip with the date and the count — and the grid as a whole is one labelled
 * image with a `sr-only` table of weekly totals beside it as its text alternative.
 */
function Activity({ result }: { result: InsightsResult }) {
  const weeks = result.activity;
  if (weeks.length === 0) return null;
  const order = countOrder(weeks);
  const total = result.commits.toLocaleString("en-US");
  return (
    <section className={SECTION_CLASS} aria-labelledby="insights-activity">
      <h2 id="insights-activity" className={H2_CLASS}>
        {ACTIVITY_TITLE}
      </h2>
      <p className={NOTE_CLASS}>{ACTIVITY_NOTE}</p>
      <div className="mt-2 overflow-x-auto">
        <svg
          role="img"
          aria-label={`Commits per day over ${weeks.length} weeks, ${total} in total`}
          width={gridWidth(weeks.length)}
          height={gridHeight()}
          viewBox={`0 0 ${gridWidth(weeks.length)} ${gridHeight()}`}
        >
          {WEEKDAY_LABELS.map((w) => (
            <text
              key={w.label}
              x={0}
              y={w.row * (CELL + GAP) + CELL - 1}
              className="fill-muted text-[9px]"
            >
              {w.label}
            </text>
          ))}
          {weeks.map((week, column) =>
            week.days.map((count, day) => {
              const at = dayMs(week.weekStart, day);
              return (
                <rect
                  key={at}
                  x={GUTTER + column * (CELL + GAP)}
                  y={day * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  data-count={count}
                  data-day={WEEKDAYS[day]}
                  className={heatFill(heatOfCount(count, order))}
                >
                  <title>{dayLabel(at, count)}</title>
                </rect>
              );
            }),
          )}
        </svg>
      </div>
      <table className="sr-only">
        <caption>Commits per week</caption>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.weekStart}>
              <th scope="row">{weekLabel(week.weekStart)}</th>
              <td>{week.days.reduce((a, b) => a + b, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={`${NOTE_CLASS} flex items-center gap-1`} aria-hidden>
        {ACTIVITY_LESS}
        {HEAT_FILL.map((fill) => (
          <svg key={fill} width={CELL} height={CELL} aria-hidden>
            <rect width={CELL} height={CELL} rx={2} className={fill} />
          </svg>
        ))}
        {ACTIVITY_MORE}
      </p>
    </section>
  );
}

/**
 * Contributors are behind a disclosure, closed by default (Design §14.6 "opt-in disclosure, commit
 * counts only"): a commit count is a poor measure of a person and a good one of where the code has
 * been moving, so the page opens on the files and only opens on the people when asked.
 */
function Contributors({ result }: { result: InsightsResult }) {
  const bots = botsLine(result.bots);
  if (result.authors.length === 0 && bots === null) return null;
  const top = result.authors[0]?.commits ?? 0;
  return (
    <section className={SECTION_CLASS}>
      <details className="text-[12.5px] leading-5">
        <summary className="cursor-pointer font-semibold text-ink">{CONTRIBUTORS_TITLE}</summary>
        <ul className="mt-2 flex flex-col gap-0.5">
          {result.authors.map((a) => (
            <li
              key={a.name}
              data-author={a.name}
              className="grid grid-cols-[minmax(6rem,18rem)_1fr_auto] items-center gap-3 px-2 py-1"
            >
              <span className="truncate text-ink">{a.name}</span>
              <span
                aria-hidden
                className="h-2 w-full min-w-8 overflow-hidden rounded-[3px] bg-surface-raised"
              >
                <i
                  style={{ width: `${sharePercent(a.commits, top)}%` }}
                  className="block h-full bg-accent"
                />
              </span>
              <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted">
                {a.commits.toLocaleString("en-US")}
              </span>
            </li>
          ))}
        </ul>
        {bots !== null && <p className={`${NOTE_CLASS} mt-2`}>{bots}</p>}
        <p className={`${NOTE_CLASS} mt-1`}>{MAILMAP_NOTE}</p>
      </details>
    </section>
  );
}

/** The skeleton Design §14.6 asks for, counting the walk up as the engine reports it. */
function InsightsSkeleton({ walked }: { walked: number }) {
  return (
    <div className="flex flex-col gap-2 p-3">
      <p role="status" className="text-[12.5px] leading-5 text-muted tabular-nums">
        {LOADING_LABEL}
        {walked > 0 && ` ${walked.toLocaleString("en-US")} commits`}
      </p>
      {[90, 70, 55, 40].map((w) => (
        <div
          key={w}
          aria-hidden
          style={{ width: `${w}%` }}
          className="h-3.5 rounded-[3px] bg-surface-raised motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}

/**
 * Insights mode (Design §14.6, atlas tab 13): the page that answers "where has this repository been
 * moving, and who moved it" — hotspots, a commits-per-day grid and the contributor counts, from one
 * first-parent walk the engine caches per tip and period. It replaces the body in mode `4`; its
 * header replaces the StatsRow (§14.1), so the page adds no chrome to the bars.
 */
export function InsightsView() {
  const repoId = useStore((s) => s.repoId);
  const period = useStore((s) => s.prefs.insightsPeriod);
  const { result, loading, error, cached, walked } = useStore((s) => s.insights);
  const loadInsights = useStore((s) => s.loadInsights);
  const setInsightsPeriod = useStore((s) => s.setInsightsPeriod);

  // One ask per repository and period — a ref rather than the slice, so a walk that fails asks
  // once and stops instead of re-firing on every render (`BranchesView`'s rule). The action itself
  // is a second guard: it is a no-op while it already holds this tip and period.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    const key = `${repoId}:${period}`;
    if (asked.current === key) return;
    asked.current = key;
    void loadInsights();
  }, [repoId, period, loadInsights]);

  const empty = result !== null && result.commits === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <InsightsHeader summary={result === null || empty ? null : summaryLine(result)} />
      <div id="diff" className="min-h-0 flex-1 overflow-y-auto">
        {error !== null ? (
          <CenteredColumn as="section" label="Insights">
            <Notice detail={describeError(error.code).message} code={error.code}>
              {ERROR_TITLE}
            </Notice>
          </CenteredColumn>
        ) : result === null || loading ? (
          <InsightsSkeleton walked={walked} />
        ) : empty ? (
          <p className="px-3 py-3 text-[12.5px] leading-5 text-muted">
            {result.walked === 0 ? (
              EMPTY_REPO
            ) : (
              <>
                {emptyPeriodLine(period)}{" "}
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => setInsightsPeriod("all")}
                >
                  {EMPTY_PERIOD_ACTION}
                </button>
                .
              </>
            )}
          </p>
        ) : (
          <>
            <Hotspots result={result} />
            <Activity result={result} />
            <Contributors result={result} />
          </>
        )}
        {/* The footer of Design §14.6; a repository with nothing to walk says so above instead. */}
        {result !== null && !loading && result.walked > 0 && (
          <p className="px-3 py-2 text-[11.5px] leading-4 text-muted tabular-nums">
            {walkedLine(result, cached)}
            {result.capped && <span className="block">{cappedLine(result.walked)}</span>}
          </p>
        )}
      </div>
    </div>
  );
}
