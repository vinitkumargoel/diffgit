/**
 * T11.7 — the pure part of Branches mode, checked against the recorded `history`, `tags` and
 * `octopus` overviews (`bun run record`), so the filters, the order and the bar widths are asserted
 * on rows and counts the real engine produced.
 */
import { describe, expect, it } from "vitest";
import type { AheadBehind, BranchRow, TagInfo } from "../engine/types";
import historyV2 from "../test/recorded/history.v2.json";
import octopusV2 from "../test/recorded/octopus.v2.json";
import tagsV2 from "../test/recorded/tags.v2.json";
import {
  aheadBehindLabel,
  BAR_W,
  barWidths,
  countLabel,
  filterBranches,
  filterTags,
  isStale,
  matchesBranch,
  matchesTag,
  overviewCounts,
  previousTag,
  STALE_MS,
  sortBranches,
  sortTags,
  syncHint,
  tagKindLabel,
  tagMessageLine,
} from "./branches";

const rows = historyV2.branches as unknown as BranchRow[];
const octopusRows = octopusV2.branches as unknown as BranchRow[];
const historyTags = historyV2.tags as unknown as TagInfo[];
const allTags = tagsV2.tags as unknown as TagInfo[];

/** The newest tip in the recorded `history` overview (`preflight/a`). */
const NEWEST = 1710633600000;

function ab(ahead: number, behind: number, capped = false): AheadBehind {
  return { ahead, behind, mergeBase: null, capped };
}

describe("branches: order and filters", () => {
  it("sorts by age, newest tip first", () => {
    expect(sortBranches(rows).map((r) => r.ref.name)).toEqual([
      "preflight/a",
      "main",
      "topic",
      "preflight/base",
    ]);
  });

  it("keeps the order stable when a tip could not be read", () => {
    const broken: BranchRow = { ...(rows[0] as BranchRow), lastCommit: null };
    const sorted = sortBranches([broken, ...rows.slice(1)]);
    // no date is not "old": it simply sorts last, and it is never called stale
    expect(sorted[sorted.length - 1]?.ref.name).toBe(broken.ref.name);
    expect(isStale(broken, NEWEST + 10 * STALE_MS)).toBe(false);
  });

  it("splits Active from `Stale > 90 d` at exactly 90 days", () => {
    const main = rows.find((r) => r.ref.name === "main") as BranchRow;
    const tip = main.lastCommit?.timestamp as number;
    expect(isStale(main, tip + STALE_MS)).toBe(false);
    expect(isStale(main, tip + STALE_MS + 1)).toBe(true);
    // one day after the newest tip every recorded branch is still active
    expect(filterBranches(rows, "active", "", NEWEST + 86_400_000)).toHaveLength(4);
    expect(filterBranches(rows, "stale", "", NEWEST + 86_400_000)).toHaveLength(0);
    // a year later they are all stale, and Active is empty
    expect(filterBranches(rows, "active", "", NEWEST + 4 * STALE_MS)).toHaveLength(0);
    expect(filterBranches(rows, "stale", "", NEWEST + 4 * STALE_MS).map((r) => r.ref.name)).toEqual(
      ["preflight/a", "main", "topic", "preflight/base"],
    );
  });

  it("searches name, upstream, subject, author and tag", () => {
    const main = rows.find((r) => r.ref.name === "main") as BranchRow;
    expect(matchesBranch(main, "MAI")).toBe(true);
    expect(matchesBranch(main, "extend mod4")).toBe(true); // the subject
    expect(matchesBranch(main, "v1.0.0")).toBe(true); // the tag on its tip
    expect(matchesBranch(main, "topic")).toBe(false);
    expect(matchesBranch(main, "  ")).toBe(true);
    expect(
      filterBranches(rows, "active", "preflight", NEWEST + 86_400_000).map((r) => r.ref.name),
    ).toEqual(["preflight/a", "preflight/base"]);
  });

  it("counts the header line", () => {
    expect(overviewCounts(rows, historyTags.length)).toBe("4 local · 0 remote-tracking · 4 tags");
    expect(overviewCounts(octopusRows, 1)).toBe("3 local · 0 remote-tracking · 1 tag");
  });
});

describe("branches: ahead/behind cells", () => {
  it("labels the recorded counts", () => {
    const a = rows.find((r) => r.ref.name === "preflight/a") as BranchRow;
    expect(aheadBehindLabel(a.vsDefault as AheadBehind)).toBe("3 ↑ 55 ↓");
    const sideA = octopusRows.find((r) => r.ref.name === "side-a") as BranchRow;
    expect(aheadBehindLabel(sideA.vsDefault as AheadBehind)).toBe("2 ↑ 3 ↓");
  });

  it("says `≥` rather than a number once the divergence walk was capped", () => {
    expect(countLabel(10_000, false)).toBe("10,000");
    expect(countLabel(10_000, true)).toBe("≥10,000");
    expect(aheadBehindLabel(ab(4, 0, true))).toBe("≥4 ↑ ≥0 ↓");
  });

  it("draws the 60 px bar the way the atlas mockup does", () => {
    // atlas tab 09: 4↑0↓ → 40/0, 0↑2↓ → 0/20, 1↑37↓ → 10/50, 0↑61↓ → 0/60
    expect(barWidths(ab(4, 0))).toEqual({ ahead: 40, behind: 0 });
    expect(barWidths(ab(0, 2))).toEqual({ ahead: 0, behind: 20 });
    expect(barWidths(ab(1, 37))).toEqual({ ahead: 10, behind: 50 });
    expect(barWidths(ab(0, 61))).toEqual({ ahead: 0, behind: 60 });
    const w = barWidths(ab(9, 9));
    expect(w.ahead + w.behind).toBeLessThanOrEqual(BAR_W);
  });

  it("turns the upstream counts into the pull / push hints", () => {
    expect(syncHint(null)).toBeNull();
    expect(syncHint(ab(0, 0))).toBeNull();
    expect(syncHint(ab(0, 2))).toBe("pull");
    expect(syncHint(ab(4, 0))).toBe("push");
    expect(syncHint(ab(4, 2))).toBe("diverged");
  });
});

describe("branches: tags table", () => {
  it("orders tags newest first by numeric-aware name", () => {
    expect(sortTags(historyTags).map((t) => t.name)).toEqual([
      "v1.0.0",
      "v0.3.0",
      "v0.2.0",
      "v0.1.0",
    ]);
    // `v1.10.0` is newer than `v1.9.0`; a plain string sort would say otherwise
    const fake = ["v1.9.0", "v1.10.0"].map((name) => ({ ...(historyTags[0] as TagInfo), name }));
    expect(sortTags(fake).map((t) => t.name)).toEqual(["v1.10.0", "v1.9.0"]);
  });

  it("names the previous tag of every row", () => {
    const sorted = sortTags(historyTags);
    expect(previousTag(sorted, 0)?.name).toBe("v0.3.0");
    expect(previousTag(sorted, sorted.length - 1)).toBeNull();
  });

  it("reads the kind and the first message line off the recording", () => {
    const annotated = allTags.find((t) => t.name === "v1.0.0") as TagInfo;
    const light = allTags.find((t) => t.name === "v0.1.0") as TagInfo;
    expect(tagKindLabel(annotated)).toBe("annotated");
    expect(tagMessageLine(annotated)).toBe("annotated release 1.0.0");
    expect(tagKindLabel(light)).toBe("lightweight");
    expect(tagMessageLine(light)).toBe("");
    expect(light.timestamp).toBeUndefined(); // git gives a lightweight tag no date of its own
  });

  it("searches name, message and tagger", () => {
    const annotated = allTags.find((t) => t.name === "v1.0.0") as TagInfo;
    expect(matchesTag(annotated, "V1.0")).toBe(true);
    expect(matchesTag(annotated, "release 1.0")).toBe(true);
    expect(matchesTag(annotated, "test")).toBe(true); // the tagger
    expect(matchesTag(annotated, "nothing")).toBe(false);
    expect(filterTags(historyTags, "v0.").map((t) => t.name)).toEqual([
      "v0.3.0",
      "v0.2.0",
      "v0.1.0",
    ]);
  });
});
