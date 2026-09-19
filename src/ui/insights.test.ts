/**
 * T11.12 — the pure part of Insights mode (Design §14.6, atlas tab 13), on the recorded `history`
 * pass: 48 first-parent commits, three mapped identities plus `renovate[bot]`, 14 paths.
 *
 * Dates are built with local getters on both sides (`new Date(y, m, d)`), because `weekStart` is a
 * **local** midnight and the recording was made under `TZ=UTC`; asserting a formatted UTC instant
 * would pass only on a machine in UTC.
 */
import { describe, expect, it } from "vitest";
import type { InsightsResult } from "../engine/types";
import historyV2 from "../test/recorded/history.v2.json";
import {
  barPercent,
  botsLine,
  cappedLine,
  countOrder,
  DAY_MS,
  dayLabel,
  dayMs,
  emptyPeriodLine,
  formatDay,
  gridHeight,
  gridWidth,
  heatFill,
  heatOfCount,
  hotspotGroups,
  hotspotTitle,
  hotspotValue,
  INSIGHTS_PERIODS,
  maxScore,
  sharePercent,
  sinceMsFor,
  summaryLine,
  walkedLine,
  weekLabel,
} from "./insights";

const result = historyV2.insights as unknown as InsightsResult;
/** 4 March 2024, local midnight — a Monday, in the recording's last week. */
const MAR4 = new Date(2024, 2, 4).getTime();

describe("insights: the period window (Design §14.6)", () => {
  it("counts back from the anchor, and sends nothing for `All`", () => {
    expect(INSIGHTS_PERIODS.map((p) => p.label)).toEqual(["90 d", "1 y", "All"]);
    expect(sinceMsFor("90d", MAR4)).toBe(MAR4 - 90 * DAY_MS);
    expect(sinceMsFor("1y", MAR4)).toBe(MAR4 - 365 * DAY_MS);
    expect(sinceMsFor("all", MAR4)).toBeUndefined();
  });
});

describe("insights: the activity grid (Design §14.6, §3.6)", () => {
  it("is 10 weeks of 7 days that sum to the recorded commit count", () => {
    expect(result.activity).toHaveLength(10);
    for (const week of result.activity) expect(week.days).toHaveLength(7);
    const total = result.activity.reduce((a, w) => a + w.days.reduce((x, y) => x + y, 0), 0);
    expect(total).toBe(result.commits);
    expect(total).toBe(48);
  });

  it("buckets the counts by rank, and a day with no commits has no heat", () => {
    // the recorded repository commits at most once a day, so every busy day is the same step
    expect(countOrder(result.activity)).toEqual([1]);
    expect(heatOfCount(1, [1])).toBe(5);
    expect(heatOfCount(0, [1])).toBeNull();
    // a repository with a spread: the ranks are spread over the whole ramp
    const order = countOrder([{ weekStart: 0, days: [0, 1, 2, 3, 5, 9, 0] }]);
    expect(order).toEqual([1, 2, 3, 5, 9]);
    expect([1, 2, 3, 5, 9].map((n) => heatOfCount(n, order))).toEqual([1, 2, 3, 4, 5]);
    expect(heatFill(heatOfCount(9, order))).toBe("fill-heat-5");
    expect(heatFill(heatOfCount(0, order))).toBe("fill-surface-raised");
  });

  it("labels a cell with its date and count, and a week with its Sunday", () => {
    expect(formatDay(MAR4)).toBe("4 Mar 2024");
    expect(dayLabel(MAR4, 3)).toBe("3 commits on 4 Mar 2024");
    expect(dayLabel(MAR4, 1)).toBe("1 commit on 4 Mar 2024");
    expect(dayLabel(MAR4, 0)).toBe("No commits on 4 Mar 2024");
    const sunday = new Date(2024, 2, 3).getTime();
    expect(weekLabel(sunday)).toBe("Week of 3 Mar 2024");
    expect(dayMs(sunday, 1)).toBe(MAR4);
  });

  it("sizes the grid from the number of weeks", () => {
    expect(gridHeight()).toBe(84);
    expect(gridWidth(52)).toBe(26 + 52 * 12);
  });
});

describe("insights: hotspots (Design §14.6)", () => {
  const { ranked, manifests } = hotspotGroups(result.hotspots);

  it("splits the manifests out of the ranking and keeps the engine's order", () => {
    expect(ranked.map((h) => h.path).slice(0, 3)).toEqual([
      "src/mod4.txt",
      "src/mod3.txt",
      "src/mod2.txt",
    ]);
    expect(manifests.map((h) => h.path)).toEqual(["package.json"]);
    expect(ranked).toHaveLength(13);
    expect(ranked.every((h) => !h.manifest)).toBe(true);
  });

  it("measures every bar against the ranked maximum", () => {
    const max = maxScore(ranked);
    expect(max).toBe(83.713);
    expect(barPercent(max, max)).toBe(100);
    // `package.json` is busier than anything but scores lower, and is drawn on the same scale
    expect(barPercent(manifests[0]?.score as number, max)).toBe(61);
    // a path that is no longer at the tip (size 0) still scores its commit count
    expect(barPercent(3, max)).toBe(4);
    expect(barPercent(1, 0)).toBe(0);
  });

  it("prints the commits and the size the score is made of", () => {
    expect(hotspotValue(ranked[0] as never)).toBe("9 commits · 631 B");
    const gone = ranked.find((h) => h.size === 0);
    expect(gone?.path).toBe("src/renamed-from.txt");
    expect(hotspotValue(gone as never)).toBe("3 commits");
    expect(hotspotTitle(ranked[0] as never)).toBe(
      "src/mod4.txt · score 83.713 = 9 commits × log₂(size)",
    );
  });
});

describe("insights: contributors and the page copy", () => {
  it("keeps bots out of the list and counts them on their own line", () => {
    expect(result.authors.map((a) => a.name)).toEqual(["Ada Lovelace", "Grace Hopper", "test"]);
    expect(result.bots).toBe(8);
    const authored = result.authors.reduce((a, x) => a + x.commits, 0);
    expect(authored + result.bots).toBe(result.commits);
    expect(botsLine(8)).toContain("8 commits by bots");
    expect(botsLine(1)).toContain("1 commit by bots");
    expect(botsLine(0)).toBeNull();
  });

  it("scales a contributor bar against the busiest one", () => {
    expect(sharePercent(19, 19)).toBe(100);
    expect(sharePercent(15, 19)).toBe(79);
    expect(sharePercent(0, 19)).toBe(2);
    expect(sharePercent(1, 0)).toBe(0);
  });

  it("says what was counted, what was walked and when a walk was capped", () => {
    expect(summaryLine(result)).toBe("48 commits · 3 authors");
    expect(walkedLine(result, false)).toBe("Walked 48 first-parent commits from HEAD");
    expect(walkedLine(result, true)).toBe("Walked 48 first-parent commits from HEAD · cached");
    expect(cappedLine(50_000)).toContain("50,000 commits");
    expect(emptyPeriodLine("90d")).toBe("No commits in the last 90 days.");
    expect(emptyPeriodLine("all")).toBe("No commits in the whole history.");
  });
});
