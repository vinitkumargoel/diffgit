import { describe, expect, test } from "bun:test";
import { type ExpectedRefs, fixturePath, loadExpected } from "../../test/fixtures";
import { defaultDiffSource, isWorktreeSource } from "../diffSource";
import { createFsaFs } from "../fs/fsaFs";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import type { DiffSource, RefSnapshot } from "../types";
import { loadGitConfig } from "./config";
import { ObjectDb } from "./objectDb";
import { loadRefs } from "./refStore";

async function refsOf(name: string): Promise<RefSnapshot> {
  const fs = createFsaFs(await NodeDirHandle.open(fixturePath(name)));
  return loadRefs(new ObjectDb(fs), await loadGitConfig(fs));
}

function realRefs(snap: RefSnapshot) {
  return Object.fromEntries(snap.refs.filter((r) => !r.synthetic).map((r) => [r.fullName, r.oid]));
}

describe("loadRefs parity with refs.json", () => {
  const cases: Record<
    string,
    { default: string | null; head: string | null; detached?: boolean; unborn?: boolean }
  > = {
    basic: { default: "main", head: "feature" },
    packed: { default: "main", head: "feature" },
    remote: { default: "origin/main", head: "feature" },
    "remote-master": { default: "origin/master", head: "feature" },
    "no-origin-head": { default: "main", head: "main" },
    detached: { default: "main", head: null, detached: true },
    unborn: { default: null, head: "main", unborn: true },
    "rebase-detached": { default: "main", head: null, detached: true },
    conflict: { default: "main", head: "main" },
  };
  for (const [name, exp] of Object.entries(cases)) {
    test(name, async () => {
      const snap = await refsOf(name);
      const expected = loadExpected<ExpectedRefs>(name, "refs");
      const expectedRefs = Object.fromEntries(
        Object.entries(expected.refs).filter(([k]) => !k.endsWith("/HEAD")),
      );
      expect(realRefs(snap)).toEqual(expectedRefs);
      expect(snap.headOid).toBe(expected.headOid);
      expect(snap.defaultRef?.name ?? null).toBe(exp.default);
      expect(snap.headBranch).toBe(exp.head);
      expect(snap.detached).toBe(exp.detached ?? false);
      expect(snap.unborn).toBe(exp.unborn ?? false);
      const checkedOut = snap.refs.filter((r) => r.isCheckedOut);
      expect(checkedOut.length).toBe(exp.head === null && !exp.unborn ? 1 : 1);
      if (!exp.detached && !exp.unborn) {
        expect(checkedOut[0]?.fullName).toBe(`refs/heads/${exp.head}`);
        expect(checkedOut[0]?.synthetic).toBeUndefined();
        expect(snap.headDisplay).toBe(exp.head as string);
      }
      expect(snap.refs.filter((r) => r.isDefault).length).toBe(exp.default === null ? 0 : 1);
    });
  }

  test("remote: kinds, names and origin/HEAD excluded from the list", async () => {
    const snap = await refsOf("remote");
    const remote = snap.refs.filter((r) => r.kind === "remote").map((r) => r.name);
    expect([...remote].sort()).toEqual(["origin/feature", "origin/main"]);
    expect(snap.refs.find((r) => r.name === "origin/HEAD")).toBeUndefined();
    expect(snap.refs.find((r) => r.name === "origin/main")?.isDefault).toBe(true);
  });
});

describe("loadRefs sort order and synthetic entries", () => {
  test("remote fixture: checked-out, default, locals A→Z, then remotes grouped", async () => {
    const snap = await refsOf("remote");
    expect(snap.refs.map((r) => r.name)).toEqual([
      "feature",
      "origin/main",
      "main",
      "topic",
      "origin/feature",
    ]);
  });

  test("detached: synthetic `HEAD (detached @ sha)` pinned first, checked out, fullName HEAD", async () => {
    const snap = await refsOf("detached");
    const first = snap.refs[0];
    expect(first?.synthetic).toBe(true);
    expect(first?.fullName).toBe("HEAD");
    expect(first?.isCheckedOut).toBe(true);
    expect(first?.name).toBe(`HEAD (detached @ ${(snap.headOid as string).slice(0, 7)})`);
    expect(snap.headDisplay).toBe(first?.name as string);
    expect(snap.refs.slice(1).map((r) => r.name)).toEqual(["main", "feature"]);
    expect(snap.refs.slice(1).some((r) => r.isCheckedOut)).toBe(false);
  });

  test("unborn: synthetic `HEAD (no commits)`, no default, oid empty", async () => {
    const snap = await refsOf("unborn");
    expect(snap.refs).toEqual([
      {
        name: "HEAD (no commits)",
        fullName: "HEAD",
        kind: "local",
        oid: "",
        isDefault: false,
        isCheckedOut: true,
        synthetic: true,
      },
    ]);
    expect(snap.headBranch).toBe("main");
    expect(snap.headOid).toBeNull();
    expect(snap.defaultRef).toBeNull();
  });

  test("rebase-detached: synthetic entry and usable default source", async () => {
    const snap = await refsOf("rebase-detached");
    expect(snap.refs[0]?.synthetic).toBe(true);
    const src = defaultDiffSource(snap);
    expect(src).toEqual({
      kind: "branches",
      source: "HEAD",
      target: "main",
      sourceRef: "HEAD",
      targetRef: "refs/heads/main",
      includeWorktree: true,
    });
    expect(isWorktreeSource(src, snap)).toBe(true);
  });
});

describe("diffSource helpers", () => {
  const snap = (over: Partial<RefSnapshot>): RefSnapshot => ({
    headBranch: "feature",
    headOid: "a".repeat(40),
    detached: false,
    unborn: false,
    headDisplay: "feature",
    refs: [],
    defaultRef: {
      name: "main",
      fullName: "refs/heads/main",
      kind: "local",
      oid: "b".repeat(40),
      isDefault: true,
      isCheckedOut: false,
    },
    ...over,
  });
  const src = (sourceRef: string): DiffSource => ({
    kind: "branches",
    source: "x",
    target: "y",
    sourceRef,
    targetRef: "refs/heads/main",
    includeWorktree: true,
  });

  test("defaultDiffSource: checked-out branch vs default; HEAD when detached; source when no default", () => {
    expect(defaultDiffSource(snap({}))).toEqual({
      kind: "branches",
      source: "feature",
      target: "main",
      sourceRef: "refs/heads/feature",
      targetRef: "refs/heads/main",
      includeWorktree: true,
    });
    expect(defaultDiffSource(snap({ headBranch: null, detached: true })).sourceRef).toBe("HEAD");
    const noDefault = defaultDiffSource(snap({ defaultRef: null }));
    expect(noDefault.target).toBe("feature");
    expect(noDefault.targetRef).toBe("refs/heads/feature");
    const remoteDefault = defaultDiffSource(
      snap({
        defaultRef: {
          name: "origin/main",
          fullName: "refs/remotes/origin/main",
          kind: "remote",
          oid: "c".repeat(40),
          isDefault: true,
          isCheckedOut: false,
        },
      }),
    );
    expect(remoteDefault.targetRef).toBe("refs/remotes/origin/main");
  });

  test("isWorktreeSource truth table", () => {
    expect(isWorktreeSource(src("refs/heads/feature"), snap({}))).toBe(true);
    expect(isWorktreeSource(src("refs/heads/main"), snap({}))).toBe(false);
    expect(isWorktreeSource(src("refs/remotes/origin/feature"), snap({}))).toBe(false);
    expect(isWorktreeSource(src("HEAD"), snap({}))).toBe(true);
    expect(isWorktreeSource(src("HEAD"), snap({ headBranch: null, detached: true }))).toBe(true);
    expect(
      isWorktreeSource(src("refs/heads/feature"), snap({ headBranch: null, detached: true })),
    ).toBe(false);
    expect(
      isWorktreeSource(
        src("refs/heads/main"),
        snap({ headBranch: "main", unborn: true, headOid: null }),
      ),
    ).toBe(true);
  });
});
