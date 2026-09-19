/**
 * T11.5 — the pure part of History mode (Design §14.5). Everything runs on the recorded `octopus`
 * and `history` walks, so the lane geometry is checked against edges the real engine produced.
 */
import { describe, expect, it } from "vitest";
import type { CommitSummary, RepoInfo, Signature } from "../engine/types";
import historyInfo from "../test/recorded/history.repoinfo.json";
import historyV2 from "../test/recorded/history.v2.json";
import octopusV2 from "../test/recorded/octopus.v2.json";
import {
  cherryPickCommand,
  commitRange,
  edgePath,
  formatCommitDate,
  formatSignature,
  incomingLanes,
  incomingPath,
  LANE_TOKENS,
  LANE_W,
  laneColor,
  laneX,
  matchesCommit,
  refChipKind,
  shortOid,
  spanRange,
} from "./history";

const octopus = octopusV2.walks.default.commits as unknown as CommitSummary[];
const walk = historyV2.walks.default.commits as unknown as CommitSummary[];
const repo = historyInfo as unknown as RepoInfo;

describe("lane geometry (Design §14.5, edges from T10.5)", () => {
  it("places one lane at 10 px and spreads the rest 14 px apart inside the 44 px column", () => {
    expect(laneX(0, 1)).toBe(10);
    expect(laneX(0, 3)).toBe(10);
    expect(laneX(1, 3)).toBe(24);
    expect(laneX(2, 3)).toBe(38);
    // a wider graph is squeezed rather than clipped
    for (const lanes of [4, 8, 20]) {
      for (let l = 0; l < lanes; l++) {
        expect(laneX(l, lanes)).toBeGreaterThanOrEqual(10);
        expect(laneX(l, lanes)).toBeLessThanOrEqual(LANE_W - 6);
      }
    }
  });

  it("cycles the three validated hues and then the muted tone", () => {
    expect(LANE_TOKENS).toEqual(["var(--accent)", "var(--success)", "var(--done)", "var(--muted)"]);
    expect(laneColor(0)).toBe("var(--accent)");
    expect(laneColor(2)).toBe("var(--done)");
    expect(laneColor(3)).toBe("var(--muted)");
    expect(laneColor(4)).toBe("var(--accent)");
  });

  it("draws a straight lane as a vertical line and a fork or merge as a curve", () => {
    const merge = octopus[0] as CommitSummary; // the three-parent merge
    const edges = merge.edges ?? [];
    expect(edges.map((e) => e.kind)).toEqual(["straight", "fork", "fork"]);
    expect(edgePath(edges[0] as never, 3)).toBe("M10 15V30");
    expect(edgePath(edges[1] as never, 3)).toBe("M10 15C10 22 24 23 24 30");
    expect(edgePath(edges[2] as never, 3)).toBe("M10 15C10 22 38 23 38 30");
    expect(incomingPath(2, 3)).toBe("M38 0V15");
  });

  it("takes the lines entering a row from the row above, so no third row is needed", () => {
    expect(incomingLanes(undefined)).toEqual([]);
    // the octopus merge hands lanes 0, 1 and 2 down to `c2: main moves on`
    expect(incomingLanes(octopus[0])).toEqual([0, 1, 2]);
    // the root of the `history` walk has no edges at all, and nothing continues past it
    const root = walk[walk.length - 1] as CommitSummary;
    expect(root.parents).toEqual([]);
    expect(root.edges).toEqual([]);
    expect(incomingLanes(root)).toEqual([]);
  });
});

describe("the sources a selection builds (docs/v2-contracts.md RangeSource)", () => {
  it("shows one commit as parent…commit, two-dot, with `commit` set", () => {
    const c = walk[0] as CommitSummary;
    const src = commitRange(c.oid, c.parents[0] ?? null);
    expect(src).toEqual({
      kind: "range",
      from: shortOid(c.parents[0] as string),
      to: shortOid(c.oid),
      fromRef: `${c.oid}^`,
      toRef: c.oid,
      fromOid: c.parents[0],
      toOid: c.oid,
      threeDot: false,
      includeWorktree: false,
      commit: c.oid,
    });
  });

  it("shows a root commit against the empty tree (fromOid null)", () => {
    const root = walk[walk.length - 1] as CommitSummary;
    const src = commitRange(root.oid, root.parents[0] ?? null);
    expect(src.fromOid).toBeNull();
    expect(src.from).toBe("(root)");
    expect(src.commit).toBe(root.oid);
  });

  it("shows a shift-selected pair as older…newer", () => {
    const newer = (walk[0] as CommitSummary).oid;
    const older = (walk[5] as CommitSummary).oid;
    const src = spanRange(older, newer);
    expect([src.fromOid, src.toOid]).toEqual([older, newer]);
    expect(src.commit).toBeUndefined();
    expect(src.threeDot).toBe(false);
  });
});

describe("the search box, the ref chips and the card's copy", () => {
  it("filters on subject, author, email, oid prefix and ref name", () => {
    const head = walk[0] as CommitSummary;
    expect(matchesCommit(head, "")).toBe(true);
    expect(matchesCommit(head, "extend mod4")).toBe(true);
    expect(matchesCommit(head, "EXTEND")).toBe(true);
    expect(matchesCommit(head, head.oid.slice(0, 7))).toBe(true);
    expect(matchesCommit(head, "main")).toBe(true); // a ref on the commit
    expect(matchesCommit(head, "nothing at all")).toBe(false);
    const bot = walk.find((c) => c.author.name.includes("[bot]")) as CommitSummary;
    expect(matchesCommit(bot, "renovate")).toBe(true);
    expect(matchesCommit(bot, "users.noreply")).toBe(true);
  });

  it("names every kind of ref a commit can carry", () => {
    // the recorded HEAD commit carries HEAD, the branch `main` and the tag `v1.0.0`
    expect((walk[0] as CommitSummary).refs).toEqual(["HEAD", "main", "v1.0.0"]);
    expect(refChipKind("HEAD", repo)).toBe("head");
    expect(refChipKind("main", repo)).toBe("branch");
    expect(refChipKind("v1.0.0", repo)).toBe("tag");
    expect(refChipKind("stash@{0}", repo)).toBe("stash");
    expect(refChipKind("origin/main", null)).toBe("tag"); // unknown to the snapshot
  });

  it("prints the commit's own wall clock, not the reader's", () => {
    const sig: Signature = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      timestamp: 1709553600000,
      tzOffsetMin: 0,
    };
    expect(formatCommitDate(sig)).toBe("4 Mar 2024, 12:00 +0000");
    // git's convention: minutes to add to reach UTC, so −60 is UTC+01:00
    expect(formatCommitDate({ ...sig, tzOffsetMin: -60 })).toBe("4 Mar 2024, 13:00 +0100");
    expect(formatCommitDate({ ...sig, tzOffsetMin: 330 })).toBe("4 Mar 2024, 06:30 −0530");
    expect(formatSignature(sig)).toBe("Ada Lovelace <ada@example.com>");
  });

  it("offers the cherry-pick command with the full oid, and never runs it", () => {
    const oid = (walk[0] as CommitSummary).oid;
    expect(cherryPickCommand(oid)).toBe(`git cherry-pick ${oid}`);
  });
});
