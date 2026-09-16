import { describe, expect, it } from "vitest";
import type { FileDiff } from "../engine/types";
import { buildTree, flattenTree, makePathFilter } from "./treeModel";

function fd(path: string): FileDiff {
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
