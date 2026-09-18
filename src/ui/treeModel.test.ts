import { describe, expect, it } from "vitest";
import type { FileDiff } from "../engine/types";
import {
  buildTree,
  dirSummary,
  flattenTree,
  GROUP_ORDER,
  groupFiles,
  groupOf,
  layerCode,
  makePathFilter,
  type TreeDir,
} from "./treeModel";

function fd(path: string, extra: Partial<FileDiff> = {}): FileDiff {
  return {
    id: path,
    oldPath: path,
    newPath: path,
    status: "modified",
    layers: ["committed"],
    oldOid: "a",
    newOid: "b",
    oldMode: 0o100644,
    newMode: 0o100644,
    binary: false,
    image: false,
    oldSize: 1,
    newSize: 1,
    stats: null,
    tooLarge: false,
    ...extra,
  };
}

describe("buildTree", () => {
  it("compacts single-child directory chains and orders dirs before files", () => {
    const tree = buildTree([
      fd("src/engine/git/worktree.ts"),
      fd("src/engine/git/hash.ts"),
      fd("src/ui/store.ts"),
      fd("README.md"),
      fd("src/App.tsx"),
    ]);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:src", "file:README.md"]);
    const src = tree[0];
    if (src?.kind !== "dir") throw new Error("expected dir");
    expect(src.children.map((n) => `${n.kind}:${n.name}`)).toEqual([
      "dir:engine/git",
      "dir:ui",
      "file:App.tsx",
    ]);
    const eng = src.children[0];
    if (eng?.kind !== "dir") throw new Error("expected dir");
    expect(eng.path).toBe("src/engine/git");
    expect(eng.children.map((n) => n.name)).toEqual(["hash.ts", "worktree.ts"]);
  });

  it("flattens respecting collapsed dirs", () => {
    const tree = buildTree([fd("a/b/c.txt"), fd("a/d.txt"), fd("e.txt")]);
    const all = flattenTree(tree, new Set());
    expect(all.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:a",
      "1:b",
      "2:c.txt",
      "1:d.txt",
      "0:e.txt",
    ]);
    const collapsed = flattenTree(tree, new Set(["a"]));
    expect(collapsed.map((r) => r.node.name)).toEqual(["a", "e.txt"]);
  });

  it("uses newPath for renames", () => {
    const f = { ...fd("new/x.ts"), oldPath: "old/x.ts", status: "renamed" as const };
    expect(buildTree([f])[0]?.name).toBe("new");
  });
});

describe("makePathFilter", () => {
  it("substring match is case-insensitive", () => {
    const m = makePathFilter("STORE");
    expect(m("src/ui/store.ts")).toBe(true);
    expect(m("src/ui/App.tsx")).toBe(false);
  });
  it("glob: * does not cross slashes, ** does, basename globs match anywhere", () => {
    expect(makePathFilter("*.ts")("src/ui/store.ts")).toBe(true);
    expect(makePathFilter("*.ts")("src/ui/store.tsx")).toBe(false);
    expect(makePathFilter("src/*.ts")("src/ui/store.ts")).toBe(false);
    expect(makePathFilter("src/**/*.ts")("src/ui/store.ts")).toBe(true);
    expect(makePathFilter("src/**")("src/ui/store.ts")).toBe(true);
    expect(makePathFilter("st?re.ts")("src/ui/store.ts")).toBe(true);
  });
  it("empty filter matches everything", () => {
    expect(makePathFilter("  ")("anything")).toBe(true);
  });
});

describe("groupOf (D3: least-committed layer a file touches)", () => {
  it("returns the group for each single layer", () => {
    expect(groupOf({ layers: ["conflict"] })).toBe("conflict");
    expect(groupOf({ layers: ["staged"] })).toBe("staged");
    expect(groupOf({ layers: ["unstaged"] })).toBe("unstaged");
    expect(groupOf({ layers: ["untracked"] })).toBe("untracked");
    expect(groupOf({ layers: ["committed"] })).toBe("committed");
  });

  it("applies the precedence conflict → unstaged → staged → untracked → committed", () => {
    expect(groupOf({ layers: ["committed", "staged"] })).toBe("staged");
    expect(groupOf({ layers: ["committed", "staged", "unstaged"] })).toBe("unstaged");
    expect(groupOf({ layers: ["staged", "unstaged"] })).toBe("unstaged");
    expect(groupOf({ layers: ["unstaged", "conflict"] })).toBe("conflict");
    expect(groupOf({ layers: ["committed", "untracked"] })).toBe("untracked");
    expect(groupOf({ layers: [] })).toBe("committed");
  });
});

describe("groupFiles", () => {
  it("emits non-empty groups in GROUP_ORDER and keeps the engine order inside a group", () => {
    const groups = groupFiles([
      fd("z/committed.ts"),
      fd("a/untracked.ts", { layers: ["untracked"] }),
      fd("m/staged-b.ts", { layers: ["staged"] }),
      fd("a/staged-a.ts", { layers: ["staged"] }),
      fd("q/both.ts", { layers: ["staged", "unstaged"] }),
      fd("k/conflict.ts", { layers: ["unstaged", "conflict"] }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(GROUP_ORDER);
    // engine (input) order survives inside the group; the tree is the sorted view
    expect(groups[1]?.files.map((f) => f.id)).toEqual(["m/staged-b.ts", "a/staged-a.ts"]);
    expect(groups[1]?.tree.map((n) => n.name)).toEqual(["a", "m"]);
  });

  it("skips empty groups and puts a staged+unstaged file under Unstaged only", () => {
    const groups = groupFiles([fd("a.ts", { layers: ["staged", "unstaged"] }), fd("b.ts")]);
    expect(groups.map((g) => g.id)).toEqual(["unstaged", "committed"]);
    expect(groups.flatMap((g) => g.files.map((f) => f.id))).toEqual(["a.ts", "b.ts"]);
  });

  it("returns nothing for an empty file list", () => {
    expect(groupFiles([])).toEqual([]);
  });
});

describe("layerCode (D4: git status --short XY)", () => {
  it("conflict and untracked colour both columns", () => {
    expect(layerCode({ layers: ["unstaged", "conflict"], status: "modified" })).toEqual({
      x: "U",
      y: "U",
      label: "Merge conflict (UU)",
    });
    expect(layerCode({ layers: ["untracked"], status: "added" })).toEqual({
      x: "?",
      y: "?",
      label: "Untracked file (??)",
    });
  });

  it("staged and unstaged: the status letter, then M — or MD for a delete", () => {
    expect(layerCode({ layers: ["staged", "unstaged"], status: "modified" })).toEqual({
      x: "M",
      y: "M",
      label: "Staged, then edited again (MM)",
    });
    expect(layerCode({ layers: ["staged", "unstaged"], status: "added" })).toEqual({
      x: "A",
      y: "M",
      label: "Staged, then edited again (AM)",
    });
    expect(layerCode({ layers: ["staged", "unstaged"], status: "deleted" })).toEqual({
      x: "M",
      y: "D",
      label: "Staged, then deleted (MD)",
    });
  });

  it("one layer only leaves the other column empty", () => {
    expect(layerCode({ layers: ["staged"], status: "renamed" })).toEqual({
      x: "R",
      y: "·",
      label: "Staged only (R·)",
    });
    expect(layerCode({ layers: ["staged"], status: "copied" })).toEqual({
      x: "C",
      y: "·",
      label: "Staged only (C·)",
    });
    expect(layerCode({ layers: ["unstaged"], status: "typechange" })).toEqual({
      x: "·",
      y: "T",
      label: "Unstaged only (·T)",
    });
    expect(layerCode({ layers: ["unstaged"], status: "deleted" })).toEqual({
      x: "·",
      y: "D",
      label: "Unstaged only (·D)",
    });
  });

  it("a committed-only file has no code", () => {
    expect(layerCode({ layers: ["committed"], status: "modified" })).toBeNull();
    expect(layerCode({ layers: [], status: "modified" })).toBeNull();
  });
});

describe("dirSummary (D7)", () => {
  const dirOf = (nodes: ReturnType<typeof buildTree>): TreeDir => {
    const dir = nodes[0];
    if (dir?.kind !== "dir") throw new Error("expected dir");
    return dir;
  };

  it("counts every file below the node and sums the stats it has", () => {
    const tree = buildTree([
      fd("src/ui/a.ts", { stats: { additions: 3, deletions: 1 } }),
      fd("src/ui/b.ts", { stats: { additions: 4, deletions: 2 } }),
      fd("src/c.ts", { stats: { additions: 1, deletions: 0 } }),
      fd("other.ts", { stats: { additions: 9, deletions: 9 } }),
    ]);
    expect(dirSummary(dirOf(tree), (f) => f.stats)).toEqual({
      files: 3,
      additions: 8,
      deletions: 3,
      complete: true,
    });
  });

  it("is incomplete while a countable file has no stats; binary and tooLarge never count", () => {
    const tree = buildTree([
      fd("src/a.ts", { stats: { additions: 1, deletions: 1 } }),
      fd("src/pending.ts"),
    ]);
    expect(dirSummary(dirOf(tree), (f) => f.stats).complete).toBe(false);

    const skipped = buildTree([
      fd("src/a.ts", { stats: { additions: 1, deletions: 1 } }),
      fd("src/logo.png", { binary: true }),
      fd("src/huge.txt", { tooLarge: true }),
    ]);
    expect(dirSummary(dirOf(skipped), (f) => f.stats)).toEqual({
      files: 3,
      additions: 1,
      deletions: 1,
      complete: true,
    });
  });

  it("reads the live stats map through the accessor, not the file's own snapshot", () => {
    const tree = buildTree([fd("src/a.ts")]);
    const live: Record<string, FileDiff["stats"]> = { "src/a.ts": { additions: 7, deletions: 2 } };
    expect(dirSummary(dirOf(tree), (f) => live[f.id] ?? f.stats)).toEqual({
      files: 1,
      additions: 7,
      deletions: 2,
      complete: true,
    });
  });
});
