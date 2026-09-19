import { describe, expect, it } from "vitest";
import type { BranchesSource, RangeSource, RefSnapshot, ResolvedRevision } from "../engine/types";
import { buildSource, isRefExpr, labelOf, revToSide, type SideRev, sideOf } from "./compareSource";

const refs: RefSnapshot = {
  headBranch: "feature",
  headOid: "f".repeat(40),
  detached: false,
  unborn: false,
  headDisplay: "feature",
  refs: [
    {
      name: "feature",
      fullName: "refs/heads/feature",
      kind: "local",
      oid: "f".repeat(40),
      isDefault: false,
      isCheckedOut: true,
    },
    {
      name: "main",
      fullName: "refs/heads/main",
      kind: "local",
      oid: "m".padEnd(40, "0"),
      isDefault: true,
      isCheckedOut: false,
    },
  ],
  defaultRef: null,
};

const pair: BranchesSource = {
  kind: "branches",
  source: "feature",
  target: "main",
  sourceRef: "refs/heads/feature",
  targetRef: "refs/heads/main",
  includeWorktree: true,
};

const tag: ResolvedRevision = {
  expr: "v1.0.0",
  oid: "1".repeat(40),
  kind: "tag",
  display: "v1.0.0",
  fullRef: "refs/tags/v1.0.0",
};

describe("compareSource", () => {
  it("only branches, remotes and HEAD are v1-expressible sides", () => {
    expect(isRefExpr("HEAD")).toBe(true);
    expect(isRefExpr("refs/heads/main")).toBe(true);
    expect(isRefExpr("refs/remotes/origin/main")).toBe(true);
    expect(isRefExpr("refs/tags/v1.0.0")).toBe(false);
    expect(isRefExpr("stash@{0}")).toBe(false);
  });

  it("reads either DiffSource kind under the source/target vocabulary", () => {
    expect(sideOf(pair, "source", refs)).toEqual({
      expr: "refs/heads/feature",
      display: "feature",
      oid: "f".repeat(40),
      branchRef: "refs/heads/feature",
    });
    const range: RangeSource = {
      kind: "range",
      from: "v1.0.0",
      to: "stash@{0}",
      fromRef: "refs/tags/v1.0.0",
      toRef: "stash@{0}",
      fromOid: "1".repeat(40),
      toOid: "2".repeat(40),
      threeDot: true,
      includeWorktree: false,
    };
    expect(sideOf(range, "target", refs).branchRef).toBeNull();
    expect(sideOf(range, "source", refs)).toMatchObject({ expr: "stash@{0}", oid: "2".repeat(40) });
  });

  it("a branch pair stays a BranchesSource; anything else becomes a RangeSource", () => {
    const from = sideOf(pair, "target", refs);
    const to = sideOf(pair, "source", refs);
    expect(buildSource(from, to, true, true)).toEqual(pair);
    // two-dot alone is enough to need a range: BranchesSource has no threeDot field
    expect(buildSource(from, to, false, true)).toMatchObject({ kind: "range", threeDot: false });
    expect(buildSource(revToSide(tag), to, true, true)).toMatchObject({
      kind: "range",
      from: "v1.0.0",
      fromRef: "refs/tags/v1.0.0",
      fromOid: "1".repeat(40),
      to: "feature",
      toRef: "refs/heads/feature",
    });
  });

  it("the empty tree is a base, never a compare side", () => {
    const empty: SideRev = { expr: "main~9", display: "main~9", oid: null, branchRef: null };
    expect(buildSource(empty, sideOf(pair, "source", refs), true, false)).toMatchObject({
      kind: "range",
      fromOid: null,
    });
    expect(buildSource(sideOf(pair, "target", refs), empty, true, false)).toBeNull();
  });

  it("labels use git's own separators", () => {
    expect(labelOf(pair)).toBe("main … feature");
    const two = buildSource(revToSide(tag), sideOf(pair, "source", refs), false, false);
    expect(two && labelOf(two)).toBe("v1.0.0 .. feature");
  });
});
