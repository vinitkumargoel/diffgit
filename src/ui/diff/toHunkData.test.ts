import { describe, expect, it } from "vitest";
import { mockHunks } from "../mock/mockContents";
import { diffTypeFor, hasCollapsedContext, hunkHeader, lineCount, toHunkData } from "./toHunkData";

describe("toHunkData", () => {
  it("maps HunkModel lines to react-diff-view changes with the right line numbers", () => {
    const model = mockHunks("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
    const hunks = toHunkData(model);
    expect(hunks).toHaveLength(1);
    const h = hunks[0];
    expect(h?.content).toBe(
      hunkHeader(model.hunks[0] ?? { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0 }),
    );
    expect(h?.oldStart).toBe(1);
    expect(h?.newStart).toBe(1);
    expect(h?.changes.map((c) => c.type)).toEqual([
      "normal",
      "delete",
      "insert",
      "normal",
      "normal",
      "insert",
    ]);
    const del = h?.changes[1];
    const ins = h?.changes[2];
    const ctx = h?.changes[3];
    expect(del && "lineNumber" in del ? del.lineNumber : null).toBe(2);
    expect(ins && "lineNumber" in ins ? ins.lineNumber : null).toBe(2);
    expect(ctx?.type === "normal" ? [ctx.oldLineNumber, ctx.newLineNumber] : null).toEqual([3, 3]);
    expect(h?.oldLines).toBe(4);
    expect(h?.newLines).toBe(5);
  });

  it("hasCollapsedContext detects hidden lines before, between and after hunks", () => {
    const full = mockHunks("a\nb\nc\n", "a\nB\nc\n"); // hunk covers the whole file
    expect(hasCollapsedContext(full, "a\nb\nc\n")).toBe(false);
    const lines = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
    const oldText = `${lines.join("\n")}\n`;
    const newText = `${lines.map((l, i) => (i === 19 ? "X" : l)).join("\n")}\n`;
    expect(hasCollapsedContext(mockHunks(oldText, newText), oldText)).toBe(true);
    expect(hasCollapsedContext(mockHunks(oldText, newText), null)).toBe(false);
  });

  it("diffTypeFor and lineCount", () => {
    expect(diffTypeFor("added")).toBe("add");
    expect(diffTypeFor("deleted")).toBe("delete");
    expect(diffTypeFor("renamed")).toBe("rename");
    expect(diffTypeFor("copied")).toBe("copy");
    expect(diffTypeFor("modified")).toBe("modify");
    expect(diffTypeFor("typechange")).toBe("modify");
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
  });
});
