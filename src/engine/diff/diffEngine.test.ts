import { describe, expect, test } from "bun:test";
import { openEngine } from "../../test/engineRig";
import {
  type ExpectedMergeBase,
  type ExpectedNameStatus,
  type ExpectedWorktreeLayer,
  fixturePath,
  loadExpected,
} from "../../test/fixtures";
import type { FileDiff } from "../types";

const letter = (s: FileDiff["status"]) => (s === "added" ? "A" : s === "deleted" ? "D" : "M");
const summary = (files: FileDiff[]) => files.map((f) => ({ path: f.id, status: letter(f.status) }));
const fromNameStatus = (exp: ExpectedNameStatus[]) =>
  exp.map((e) => ({
    path: (e.newPath ?? e.oldPath) as string,
    status: e.status === "T" ? "M" : e.status,
  }));

describe("DiffEngine committed layer parity", () => {
  for (const [name, target] of [
    ["basic", "main"],
    ["packed", "main"],
    ["remote", "origin/main"],
  ] as const) {
    test(`${name}: feature vs ${target} matches name-status (no renames) and merge-base`, async () => {
      const r = await openEngine(name);
      const out = await r.engine.compute(r.source("feature", target, false));
      expect(summary(out.files)).toEqual(
        fromNameStatus(loadExpected<ExpectedNameStatus[]>(name, "name-status-3dot-no-renames")),
      );
      expect(out.mergeBase).toBe(loadExpected<ExpectedMergeBase>(name, "merge-base").feature);
      expect(out.warnings).toEqual([]);
      for (const f of out.files) {
        expect(f.layers).toEqual(["committed"]);
        expect(f.id).toBe((f.newPath ?? f.oldPath) as string);
        expect(out.sides[f.id]?.new?.kind ?? "tree").toBe("tree");
      }
    });
  }

  test("basic: source === target → empty result with mergeBase = that commit", async () => {
    const r = await openEngine("basic");
    const out = await r.engine.compute(r.source("main", "main", false));
    expect(out.files).toEqual([]);
    expect(out.mergeBase).toBe(r.refs.refs.find((x) => x.name === "main")?.oid as string);
  });

  test("REF_NOT_FOUND for an unknown ref", async () => {
    const r = await openEngine("basic");
    await expect(
      r.engine.compute({
        kind: "branches",
        source: "x",
        target: "main",
        sourceRef: "refs/heads/nope",
        targetRef: "refs/heads/main",
        includeWorktree: false,
      }),
    ).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
  });

  test("unrelated: UNRELATED_HISTORIES warning, two-dot file list", async () => {
    const r = await openEngine("unrelated");
    const out = await r.engine.compute(r.source("feature", "main", false));
    expect(out.mergeBase).toBeNull();
    expect(out.warnings.map((w) => w.code)).toEqual(["UNRELATED_HISTORIES"]);
    expect(summary(out.files)).toEqual(
      fromNameStatus(
        loadExpected<ExpectedNameStatus[]>("unrelated", "name-status-3dot-no-renames"),
      ),
    );
    expect(out.files.length).toBeGreaterThan(0);
  });

  test("shallow capability turns the fallback warning into SHALLOW", async () => {
    const r = await openEngine("unrelated", { shallow: true });
    const out = await r.engine.compute(r.source("feature", "main", false));
    expect(out.warnings.map((w) => w.code)).toEqual(["SHALLOW"]);
  });

  test("crisscross: MULTIPLE_MERGE_BASES and files equal git diff <all[0]> feature", async () => {
    const r = await openEngine("crisscross");
    const out = await r.engine.compute(r.source("feature", "main", false));
    const w = out.warnings.find((x) => x.code === "MULTIPLE_MERGE_BASES");
    expect(w).toBeDefined();
    const all = (w?.detail ?? "").split(",");
    expect(all.length).toBe(2);
    expect(out.mergeBase).toBe(all[0] as string);
    const git = Bun.spawnSync(
      [
        "git",
        "-C",
        fixturePath("crisscross"),
        "diff",
        "--name-status",
        "--no-renames",
        out.mergeBase as string,
        "feature",
      ],
      {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
    const expected = git.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split("\t");
        return { path: path as string, status: status as string };
      });
    expect(summary(out.files)).toEqual(expected);
  });
});

describe("DiffEngine working-tree layer", () => {
  test("worktree fixture: layers, sides and elimination match git", async () => {
    const r = await openEngine("worktree");
    const out = await r.engine.compute(r.source("feature", "main", true));
    expect(out.includeWorktree).toBe(true);
    const exp = loadExpected<ExpectedWorktreeLayer>("worktree", "worktree-layer");
    const expected = [
      ...exp.changes.map((c) => ({ path: (c.newPath ?? c.oldPath) as string, status: c.status })),
      ...exp.untracked.map((p) => ({ path: p, status: "A" })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(summary(out.files)).toEqual(expected);
    const byId = Object.fromEntries(out.files.map((f) => [f.id, f]));
    expect(byId["both.txt"]?.layers).toEqual(["staged", "unstaged"]);
    expect(byId["staged-mod.txt"]?.layers).toEqual(["staged"]);
    expect(byId["unstaged-mod.txt"]?.layers).toEqual(["unstaged"]);
    expect(byId["staged-new.txt"]).toMatchObject({ status: "added", layers: ["staged"] });
    expect(byId["untracked.txt"]).toMatchObject({ status: "added", layers: ["untracked"] });
    expect(byId["newdir/untracked2.txt"]).toMatchObject({ status: "added", layers: ["untracked"] });
    expect(byId["deleted-staged.txt"]).toMatchObject({ status: "deleted", layers: ["staged"] });
    expect(byId["deleted-unstaged.txt"]).toMatchObject({ status: "deleted", layers: ["unstaged"] });
    expect(byId["script.sh"]).toMatchObject({
      status: "modified",
      layers: ["staged"],
      oldMode: 0o100644,
      newMode: 0o100755,
    });
    expect(byId["feature-only.txt"]).toMatchObject({ status: "added", layers: ["committed"] });
    expect(byId["reverted.txt"]).toBeUndefined(); // committed change reverted in the worktree → eliminated
    // sides table tells T3.4 where content lives
    expect(out.sides["both.txt"]?.new?.kind).toBe("worktree");
    expect(out.sides["staged-mod.txt"]?.new?.kind).toBe("index");
    expect(out.sides["untracked.txt"]?.new).toMatchObject({
      kind: "untracked",
      size: expect.any(Number),
    });
    expect(out.sides["feature-only.txt"]?.new?.kind).toBe("tree");
    expect(out.sides["deleted-staged.txt"]?.new).toBeNull();
    expect(out.sides["both.txt"]?.old?.oid).toBe(byId["both.txt"]?.oldOid as string);
    expect(byId["untracked.txt"]?.newOid).toMatch(/^[0-9a-f]{40}$/);
    expect(byId["untracked.txt"]?.newSize).toBeGreaterThan(0);
    expect(out.warnings).toEqual([]);
    expect(out.worktree).toBeDefined();
  });

  test("worktree fixture with includeWorktree=false equals committed-only", async () => {
    const r = await openEngine("worktree");
    const out = await r.engine.compute(r.source("feature", "main", false));
    expect(summary(out.files)).toEqual(
      fromNameStatus(loadExpected<ExpectedNameStatus[]>("worktree", "name-status-3dot-no-renames")),
    );
    expect(out.worktree).toBeUndefined();
  });

  test("non-checked-out source with includeWorktree → WORKTREE_NOT_APPLICABLE and committed-only", async () => {
    const r = await openEngine("worktree");
    const out = await r.engine.compute(r.source("main", "feature", true));
    expect(out.includeWorktree).toBe(false);
    expect(out.warnings.map((w) => w.code)).toEqual(["WORKTREE_NOT_APPLICABLE"]);
    expect(out.worktree).toBeUndefined();
    expect(out.files.every((f) => f.layers.length === 1 && f.layers[0] === "committed")).toBe(true);
  });

  test("same branch + dirty tree: base is the branch tip, only worktree changes remain", async () => {
    const r = await openEngine("worktree");
    const out = await r.engine.compute(r.source("feature", "feature", true));
    expect(out.mergeBase).toBe(r.refs.headOid as string);
    expect(out.files.every((f) => !f.layers.includes("committed"))).toBe(true);
    expect(out.files.map((f) => f.id)).toContain("both.txt");
    expect(out.files.map((f) => f.id)).toContain("reverted.txt"); // differs from the tip (not from base)
  });

  test("unborn: HEAD source, everything in the index is staged-added plus untracked", async () => {
    const r = await openEngine("unborn");
    const src = r.source("HEAD", "HEAD", true);
    expect(src.sourceRef).toBe("HEAD");
    const out = await r.engine.compute(src);
    expect(out.mergeBase).toBeNull();
    expect(summary(out.files)).toEqual([
      { path: "dir/second.txt", status: "A" },
      { path: "first.txt", status: "A" },
      { path: "untracked.txt", status: "A" },
    ]);
    expect(out.files[0]?.layers).toEqual(["staged"]);
    expect(out.files[2]?.layers).toEqual(["untracked"]);
    expect(out.warnings).toEqual([]);
  });

  test("detached: HEAD source vs main works with the worktree layer", async () => {
    const r = await openEngine("detached");
    const out = await r.engine.compute(r.source("HEAD", "main", true));
    expect(out.includeWorktree).toBe(true);
    expect(out.mergeBase).toBe(loadExpected<ExpectedMergeBase>("detached", "merge-base").feature);
    expect(out.files.length).toBeGreaterThan(0);
  });

  test("conflict: conflicted file carries the conflict layer with a worktree new side", async () => {
    const r = await openEngine("conflict");
    const out = await r.engine.compute(r.source("HEAD", "feature", true));
    const f = out.files.find((x) => x.id === "file.txt");
    expect(f?.layers).toContain("conflict");
    expect(out.sides["file.txt"]?.new).toMatchObject({ kind: "worktree", oid: null });
  });

  test("split index → committed-only with SPLIT_INDEX warning", async () => {
    const r0 = await openEngine("worktree");
    const real = await r0.readIndex();
    const r = await openEngine("worktree", {
      readIndex: async () => ({ ...real, hasSplitIndex: true }),
    });
    const out = await r.engine.compute(r.source("feature", "main", true));
    expect(out.warnings.map((w) => w.code)).toEqual(["SPLIT_INDEX"]);
    expect(out.worktree).toBeUndefined();
    expect(summary(out.files)).toEqual(
      fromNameStatus(loadExpected<ExpectedNameStatus[]>("worktree", "name-status-3dot-no-renames")),
    );
    const r2 = await openEngine("worktree", {
      readIndex: async () => ({ ...real, tooLarge: true }),
    });
    expect(
      (await r2.engine.compute(r2.source("feature", "main", true))).warnings.map((w) => w.code),
    ).toEqual(["INDEX_TOO_LARGE"]);
  });

  test("cancellation rejects with CANCELLED", async () => {
    const r = await openEngine("worktree");
    const ac = new AbortController();
    ac.abort();
    await expect(
      r.engine.compute(r.source("feature", "main", true), ac.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
