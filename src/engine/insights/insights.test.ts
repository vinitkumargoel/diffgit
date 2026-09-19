/**
 * T10.9 unit tests: the pure parts of the insights pass — manifest and bot classification, the
 * hotspot score, and the week/day bucketing. The walk itself is asserted against git in
 * `insights.parity.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { WARNING_CODES } from "../errors";
import { MAX_WALK } from "../git/walk";
import {
  ACTIVITY_DAYS,
  ACTIVITY_WEEKS,
  addDays,
  buildActivity,
  hotspotScore,
  INSIGHTS_WALK_CAP,
  insightsCappedWarning,
  isBotIdentity,
  isManifestPath,
  localMidnight,
  weekStartOf,
} from "./insights";

/** Local midnight of a `YYYY-MM-DD`, which is what the day buckets are keyed by. */
function day(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
}

describe("isManifestPath", () => {
  test("matches manifests and lockfiles anywhere in the tree, by basename", () => {
    for (const p of [
      "package.json",
      "frontend/package.json",
      "bun.lock",
      "go.sum",
      "Cargo.lock",
      "a/b/Gemfile.lock",
      "PACKAGE-LOCK.JSON",
      "pyproject.toml",
    ])
      expect(isManifestPath(p)).toBe(true);
  });

  test("does not match ordinary source files or a manifest-looking directory", () => {
    for (const p of [
      "src/hot.txt",
      "package.json.bak",
      "package.json/inner.txt",
      "docs/package-notes.md",
      "src/cargo.rs",
    ])
      expect(isManifestPath(p)).toBe(false);
  });
});

describe("isBotIdentity", () => {
  test("flags a `[bot]` suffix and a dependabot/renovate prefix, in name or email local part", () => {
    expect(isBotIdentity("renovate[bot]", "renovate[bot]@users.noreply.github.com")).toBe(true);
    expect(isBotIdentity("GitHub Actions", "github-actions[bot]@users.noreply.github.com")).toBe(
      true,
    );
    expect(isBotIdentity("dependabot-preview", "support@dependabot.com")).toBe(true);
    expect(isBotIdentity("Renovate Bot", "bot@renovateapp.com")).toBe(true);
  });

  test("does not flag a human whose name merely contains one of the words", () => {
    expect(isBotIdentity("Ada Lovelace", "ada@example.com")).toBe(false);
    expect(isBotIdentity("Robot Robertson", "robot@example.com")).toBe(false);
    // The brief's `/^dependabot|renovate/i` would match this one; the anchored form does not.
    expect(isBotIdentity("Renata Renovate-Smith", "renata@example.com")).toBe(false);
    // `[bot]` has to be at the end, as GitHub writes it.
    expect(isBotIdentity("The [bot] Whisperer", "human@example.com")).toBe(false);
  });
});

describe("hotspotScore", () => {
  test("is `commits × log2(size)` with the size floored at 2", () => {
    expect(hotspotScore(9, 631)).toBe(Math.round(9 * Math.log2(631) * 1000) / 1000);
    expect(hotspotScore(4, 1024)).toBe(40);
    // A file that no longer exists at the tip (size 0) and a one-byte file score their count.
    expect(hotspotScore(3, 0)).toBe(3);
    expect(hotspotScore(3, 1)).toBe(3);
    expect(hotspotScore(0, 1_000_000)).toBe(0);
  });

  test("size can outrank commit count, which is the point of the formula", () => {
    expect(hotspotScore(4, 1_000_000)).toBeGreaterThan(hotspotScore(9, 8));
  });
});

describe("day and week buckets", () => {
  test("localMidnight and weekStartOf land on local midnight, Sunday for the week", () => {
    const noon = new Date(2024, 0, 10, 12, 34, 56, 789).getTime(); // Wednesday 2024-01-10
    expect(localMidnight(noon)).toBe(day("2024-01-10"));
    expect(new Date(localMidnight(noon)).getHours()).toBe(0);
    expect(weekStartOf(noon)).toBe(day("2024-01-07")); // the Sunday before
    expect(new Date(weekStartOf(noon)).getDay()).toBe(0);
    // A Sunday is its own week start.
    expect(weekStartOf(day("2024-01-07"))).toBe(day("2024-01-07"));
  });

  test("addDays crosses a DST boundary without drifting off midnight", () => {
    // 2024-03-10 is the US spring-forward; in a zone with no DST the assertion is trivially true.
    const before = day("2024-03-09");
    const after = addDays(before, 2);
    expect(new Date(after).getHours()).toBe(0);
    expect(new Date(after).getDate()).toBe(11);
  });
});

describe("buildActivity", () => {
  test("is empty for no commits", () => {
    expect(buildActivity(new Map())).toEqual([]);
  });

  test("emits whole weeks of seven, oldest first, with day 0 the week's Sunday", () => {
    const counts = new Map([
      [day("2024-01-10"), 3], // Wednesday
      [day("2024-01-14"), 1], // Sunday, the next week
    ]);
    const activity = buildActivity(counts);
    expect(activity).toEqual([
      { weekStart: day("2024-01-07"), days: [0, 0, 0, 3, 0, 0, 0] },
      { weekStart: day("2024-01-14"), days: [1, 0, 0, 0, 0, 0, 0] },
    ]);
    for (const week of activity) expect(week.days).toHaveLength(ACTIVITY_DAYS);
  });

  test("fills the gap between two distant days rather than skipping weeks", () => {
    const activity = buildActivity(
      new Map([
        [day("2024-01-10"), 1],
        [day("2024-02-07"), 2],
      ]),
    );
    expect(activity).toHaveLength(5);
    expect(activity[0]?.weekStart).toBe(day("2024-01-07"));
    expect(activity.at(-1)?.weekStart).toBe(day("2024-02-04"));
    expect(activity.reduce((n, w) => n + w.days.reduce((a, b) => a + b, 0), 0)).toBe(3);
  });

  test("sums to the number of commits, and caps at 52 weeks ending at the newest day", () => {
    const counts = new Map<number, number>();
    // Three years of one commit a week: 157 weeks, of which only the newest 52 are reported.
    let d = day("2021-01-06");
    let total = 0;
    for (let i = 0; i < 157; i++) {
      counts.set(d, 1);
      total++;
      d = addDays(d, 7);
    }
    const activity = buildActivity(counts);
    expect(activity).toHaveLength(ACTIVITY_WEEKS);
    expect(activity.at(-1)?.weekStart).toBe(weekStartOf(addDays(d, -7)));
    const sum = activity.reduce((n, w) => n + w.days.reduce((a, b) => a + b, 0), 0);
    expect(sum).toBe(ACTIVITY_WEEKS);
    expect(sum).toBeLessThan(total);
  });
});

describe("the 50,000-commit cap", () => {
  test("is the walker's own cap, so `walkCommits` enforces it for us", () => {
    expect(INSIGHTS_WALK_CAP).toBe(50_000);
    expect(INSIGHTS_WALK_CAP).toBe(MAX_WALK);
  });

  test("its warning uses a registered code and names the count", () => {
    const w = insightsCappedWarning(50_000);
    expect(WARNING_CODES).toContain(w.code);
    expect(w.code).toBe("INSIGHTS_CAPPED");
    expect(w.message).toContain("50,000");
    expect(w.detail).toContain("50,000");
  });
});
