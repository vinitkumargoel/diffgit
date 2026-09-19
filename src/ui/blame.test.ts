/**
 * T11.6 — the pure half of blame and file history, checked against the recorded `history` fixture
 * (`bun run record`, T10.6). Blame parity with `git blame --porcelain` is the engine's
 * (`src/engine/diff/blame.test.ts`); these cases only check what the card makes of the payload.
 */
import { describe, expect, it } from "vitest";
import type { BlamePayload, PathHistoryEntry } from "../engine/types";
import historyV2 from "../test/recorded/history.v2.json";
import {
  ageOrder,
  blameCacheKey,
  blameRows,
  cappedLine,
  heatClass,
  heatOf,
  pathHistoryCacheKey,
  renamedFromLabel,
  revisionsLabel,
  shortOid,
  splitLines,
  UNCOMMITTED_AUTHOR,
} from "./blame";

const blames = historyV2.blames as unknown as Record<string, BlamePayload>;
const histories = historyV2.pathHistories as unknown as Record<string, PathHistoryEntry[]>;
const hot = blames["src/hot.txt"] as BlamePayload;
const indentW = blames["w:src/indent.txt"] as BlamePayload;

const ROOT = "5772d43fe1036c123baac6d6792d31986659a515";
const REWORK_TOP = "ff4cd35f709efdf6d6de27099e01f72eb6bbb539";
const REWORK_MIDDLE = "a73418042de715a7bef7e9bc59a8a2fadd8eb920";

describe("age heat ramp (Design §3.6)", () => {
  it("orders the distinct revision timestamps oldest first", () => {
    expect(ageOrder([3, 1, 2, 1])).toEqual([1, 2, 3]);
    expect(ageOrder([])).toEqual([]);
  });

  it("puts the oldest revision on --heat1 and the newest on --heat5", () => {
    const order = ageOrder([10, 20, 30, 40, 50]);
    expect(order.map((t) => heatOf(t, order))).toEqual([1, 2, 3, 4, 5]);
    // fewer revisions than steps: the ramp is still used end to end
    const three = ageOrder([10, 20, 30]);
    expect(three.map((t) => heatOf(t, three))).toEqual([1, 3, 5]);
    // a single revision, and an uncommitted line, are the newest thing there is
    expect(heatOf(10, [10])).toBe(5);
    expect(heatOf(null, order)).toBe(5);
    expect(heatClass(1)).toBe("bg-heat-1");
    expect(heatClass(5)).toBe("bg-heat-5");
  });
});

describe("blameRows on the recorded history fixture", () => {
  it("keeps every line and collapses runs of one commit onto their first row", () => {
    const rows = blameRows(hot);
    expect(rows).toHaveLength(hot.lines.length);
    expect(rows).toHaveLength(60);
    // the recorded attribution: 3 lines from `c05`, then `c00`, then 6 from `c29`, then `c00` again
    const firsts = rows.filter((r) => r.first);
    expect(firsts.map((r) => [r.line.line, r.oid])).toEqual([
      [1, REWORK_TOP],
      [4, ROOT],
      [25, REWORK_MIDDLE],
      [31, ROOT],
    ]);
    // two separate blocks of the same commit each print their own author and SHA
    expect(firsts.filter((r) => r.oid === ROOT)).toHaveLength(2);
    expect(rows[1]?.first).toBe(false);
    expect(rows[1]?.author).toBe("Ada Lovelace");
  });

  it("colours each revision by its age rank", () => {
    const rows = blameRows(hot);
    const heatOfOid = (oid: string) => rows.find((r) => r.oid === oid)?.heat;
    expect(heatOfOid(ROOT)).toBe(1); // c00, the root commit
    expect(heatOfOid(REWORK_TOP)).toBe(3); // c05
    expect(heatOfOid(REWORK_MIDDLE)).toBe(5); // c29, the newest
  });

  it("attributes a working-tree line to `you, uncommitted` and the newest heat", () => {
    const dirty: BlamePayload = {
      ...hot,
      lines: [{ line: 1, oid: null, origLine: 1, origPath: "src/hot.txt" }, ...hot.lines.slice(1)],
    };
    const first = blameRows(dirty)[0];
    expect(first?.oid).toBeNull();
    expect(first?.author).toBe(UNCOMMITTED_AUTHOR);
    expect(first?.heat).toBe(5);
  });

  it("`-w` falls the whitespace-only revision through to the root commit", () => {
    // engine behaviour (T10.6); the UI simply shows one run of one commit
    const rows = blameRows(indentW);
    expect(new Set(rows.map((r) => r.oid))).toEqual(new Set([ROOT]));
    expect(rows.filter((r) => r.first)).toHaveLength(1);
    expect(indentW.revisions).toBe(2);
  });
});

describe("copy and keys", () => {
  it("counts revisions and spells the cap out in one line", () => {
    expect(revisionsLabel(1)).toBe("1 revision");
    expect(revisionsLabel(3)).toBe("3 revisions");
    expect(revisionsLabel(1200)).toBe("1,200 revisions");
    expect(cappedLine(200)).toContain("Blame stopped after 200 revisions");
  });

  it("names the rename a path history entry carries", () => {
    const renamed = histories["src/renamed-to.txt"] as PathHistoryEntry[];
    const hop = renamed.find((e) => e.renamedFrom !== null) as PathHistoryEntry;
    expect(renamedFromLabel(hop)).toBe("renamed from src/renamed-from.txt");
    expect(renamedFromLabel(renamed[0] as PathHistoryEntry)).toBeNull();
    // the recorded follow-renames history really crosses the rename
    expect(renamed.some((e) => e.path === "src/renamed-from.txt")).toBe(true);
    // and the whitespace-only commit is flagged as such
    const indent = histories["src/indent.txt"] as PathHistoryEntry[];
    expect(indent.some((e) => e.whitespaceOnly)).toBe(true);
  });

  it("keys a blame by commit, path and `-w`, and a history by commit, path and follow", () => {
    expect(blameCacheKey(ROOT, "a/b.ts", false)).toBe(`${ROOT}:a/b.ts:x`);
    expect(blameCacheKey(ROOT, "a/b.ts", true)).toBe(`${ROOT}:a/b.ts:w`);
    expect(pathHistoryCacheKey(ROOT, "a/b.ts", true)).toBe(`${ROOT}:a/b.ts:f`);
    expect(pathHistoryCacheKey(ROOT, "a/b.ts", false)).toBe(`${ROOT}:a/b.ts:n`);
    expect(shortOid(ROOT)).toBe("5772d43");
  });

  it("splits text into lines without inventing one for the trailing newline", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n")).toEqual([""]);
  });
});
