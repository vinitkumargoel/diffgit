import { describe, expect, it } from "vitest";
import type { RepoInfo, RepoRef } from "../engine/types";
import basic from "../test/recorded/basic.repoinfo.json";
import { findRef, groupRefs, refBadges, remoteName } from "./refGroups";

const repo = basic as unknown as RepoInfo;

describe("groupRefs", () => {
  it("groups the recorded basic repo into Local and Remote: origin, keeping engine order", () => {
    const g = groupRefs(repo.refs);
    expect(g.pinned).toEqual([]);
    expect(g.local.map((r) => r.name)).toEqual(["feature", "main", "topic"]);
    expect(g.remotes).toHaveLength(1);
    expect(g.remotes[0]?.remote).toBe("origin");
    expect(g.remotes[0]?.refs.map((r) => r.name)).toEqual(["origin/feature", "origin/main"]);
  });

  it("pins the synthetic HEAD entry and sorts remotes by name", () => {
    const synthetic: RepoRef = {
      name: "HEAD (detached @ 3f9a1c2)",
      fullName: "HEAD",
      kind: "local",
      oid: "3f9a1c2".padEnd(40, "0"),
      isDefault: false,
      isCheckedOut: true,
      synthetic: true,
    };
    const upstream: RepoRef = {
      name: "upstream/main",
      fullName: "refs/remotes/upstream/main",
      kind: "remote",
      oid: "1".repeat(40),
      isDefault: false,
      isCheckedOut: false,
    };
    const fork: RepoRef = { ...upstream, name: "fork/main", fullName: "refs/remotes/fork/main" };
    const g = groupRefs([synthetic, ...repo.refs, upstream, fork]);
    expect(g.pinned.map((r) => r.fullName)).toEqual(["HEAD"]);
    expect(g.local).toHaveLength(3);
    expect(g.remotes.map((r) => r.remote)).toEqual(["fork", "origin", "upstream"]);
  });
});

describe("refBadges / remoteName / findRef", () => {
  it("derives badges from the ref flags", () => {
    expect(refBadges(repo.refs[0] as RepoRef)).toEqual(["head"]);
    expect(refBadges(repo.refs[1] as RepoRef)).toEqual(["default"]);
    expect(refBadges(repo.refs[4] as RepoRef)).toEqual(["remote"]);
  });
  it("reads the remote name from the full ref name", () => {
    expect(remoteName(repo.refs[4] as RepoRef)).toBe("origin");
    expect(
      remoteName({
        name: "x/y",
        fullName: "weird",
        kind: "remote",
        oid: "",
        isDefault: false,
        isCheckedOut: false,
      }),
    ).toBe("x");
  });
  it("finds refs by full name", () => {
    expect(findRef(repo.refs, "refs/heads/topic")?.name).toBe("topic");
    expect(findRef(repo.refs, "refs/heads/nope")).toBeUndefined();
  });
});
