/**
 * T10.3: the three-way conflict payload. The oracle is git itself — `expected/ls-files-u.txt` is
 * `git ls-files -u`, so every stage oid in the payload has to be the one git put in the index, and
 * the marker line numbers have to be the lines the markers actually occupy in the checked-out file
 * (recomputed here from the fixture, not hard-coded).
 *
 * The "resolved in the working tree" flip is tested on an in-memory copy of the fixture: the
 * repositories in `fixtures/` are built once by `scripts/make-fixtures.sh` and are never written to.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixturePath, loadExpectedLines } from "../../test/fixtures";
import { snapshotFromDisk } from "../../test/memorySnapshot";
import type { ProgressSink } from "../api";
import { defaultDiffSource } from "../diffSource";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import type { IndexEntry } from "../git/indexReader";
import { RepoSession } from "../session";
import { conflictKindOf, conflictLabels, conflictStatus, parseConflictMarkers } from "./conflict";

const CONFLICT_FIXTURES = ["rebase-conflict", "merge-conflict", "cherry-pick-conflict"] as const;

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

async function openFixture(name: string) {
  const session = await RepoSession.open(await NodeDirHandle.open(fixturePath(name)), quietSink, {
    id: `test-${name}`,
  });
  const info = await session.info();
  const result = await session.computeDiff(defaultDiffSource(info));
  return { session, info, result };
}

async function openMemory(name: string) {
  const snap = await snapshotFromDisk(fixturePath(name), `${name}-snap`, name, {
    exclude: (p) => p === "expected",
  });
  const mem = MemoryFs.fromSnapshot(snap);
  const session = await RepoSession.open(mem.handle(name), quietSink, { id: `mem-${name}` });
  const info = await session.info();
  const result = await session.computeDiff(defaultDiffSource(info));
  return { session, mem, info, result };
}

/** `git ls-files -u` → path → stage → oid. */
function unmerged(name: string): Record<string, Record<number, string>> {
  const out: Record<string, Record<number, string>> = {};
  for (const line of loadExpectedLines(name, "ls-files-u")) {
    const [meta, path] = line.split("\t") as [string, string];
    const [, oid, stage] = meta.split(" ") as [string, string, string];
    const stages = out[path] ?? {};
    stages[Number(stage)] = oid;
    out[path] = stages;
  }
  return out;
}

/** The 1-based line numbers of the conflict markers as they sit in the fixture on disk. */
function markerLines(name: string, path: string) {
  const lines = readFileSync(join(fixturePath(name), path), "utf8").split("\n");
  const at = (re: RegExp) => lines.map((l, i) => (re.test(l) ? i + 1 : 0)).filter((n) => n !== 0);
  return {
    start: at(/^<{7}(?:[ \t]|$)/),
    base: at(/^\|{7}(?:[ \t]|$)/),
    split: at(/^={7}(?:[ \t]|$)/),
    end: at(/^>{7}(?:[ \t]|$)/),
  };
}

const entry = (stage: 0 | 1 | 2 | 3, oid = "x"): IndexEntry =>
  ({ path: "p", oid, mode: 0o100644, stage }) as IndexEntry;

describe("conflictKindOf / conflictStatus", () => {
  test("names the pair from the stages git kept", () => {
    expect(conflictKindOf([entry(1), entry(2), entry(3)])).toBe("both-modified");
    expect(conflictKindOf([entry(2), entry(3)])).toBe("both-added");
    expect(conflictKindOf([entry(1), entry(2)])).toBe("deleted-by-them");
    expect(conflictKindOf([entry(1), entry(3)])).toBe("deleted-by-us");
    expect(conflictKindOf([entry(1)])).toBe("both-deleted");
    // git's AU / UA fold onto the side that has no blob
    expect(conflictKindOf([entry(2)])).toBe("deleted-by-them");
    expect(conflictKindOf([entry(3)])).toBe("deleted-by-us");
    expect(conflictKindOf([])).toBe("both-deleted");
  });

  test("maps kinds to FileDiff.status", () => {
    expect(conflictStatus("both-added")).toBe("added");
    expect(conflictStatus("deleted-by-us")).toBe("deleted");
    expect(conflictStatus("deleted-by-them")).toBe("deleted");
    expect(conflictStatus("both-modified")).toBe("modified");
    expect(conflictStatus("both-deleted")).toBe("modified");
  });
});

describe("parseConflictMarkers", () => {
  test("merge style: oursEnd is the ======= line, no baseEnd", () => {
    const text = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nb\n";
    expect(parseConflictMarkers(text)).toEqual([{ start: 2, end: 6, oursEnd: 4 }]);
  });

  test("diff3 style: oursEnd is the ||||||| line and baseEnd the ======= line", () => {
    const text = "<<<<<<< ours\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> theirs\ntail\n";
    expect(parseConflictMarkers(text)).toEqual([{ start: 1, end: 7, oursEnd: 3, baseEnd: 5 }]);
  });

  test("several blocks in one file are reported in order", () => {
    const text = [
      "<<<<<<< a",
      "1",
      "=======",
      "2",
      ">>>>>>> b",
      "x",
      "<<<<<<< a",
      "3",
      "=======",
      "4",
      ">>>>>>> b",
      "",
    ].join("\n");
    expect(parseConflictMarkers(text)).toEqual([
      { start: 1, end: 5, oursEnd: 3 },
      { start: 7, end: 11, oursEnd: 9 },
    ]);
  });

  test("odd input never throws: nested opener, stray closer, missing separator, unterminated block", () => {
    // a second opener before the first closed: only the innermost block can be delimited honestly
    expect(parseConflictMarkers("<<<<<<< a\n<<<<<<< b\nx\n=======\ny\n>>>>>>> c\n")).toEqual([
      { start: 2, end: 6, oursEnd: 4 },
    ]);
    // a closer with nothing open is ignored
    expect(parseConflictMarkers("x\n>>>>>>> a\n")).toEqual([]);
    // no separator at all: the block is still reported, with ours spanning it
    expect(parseConflictMarkers("<<<<<<< a\nx\n>>>>>>> b\n")).toEqual([
      { start: 1, end: 3, oursEnd: 3 },
    ]);
    // never closed: nothing to delimit, so nothing is reported
    expect(parseConflictMarkers("<<<<<<< a\nx\n")).toEqual([]);
    // an extra ======= inside a diff3 block does not move baseEnd again
    expect(
      parseConflictMarkers("<<<<<<< a\n1\n||||||| b\n2\n=======\n3\n=======\n4\n>>>>>>> c\n"),
    ).toEqual([{ start: 1, end: 9, oursEnd: 3, baseEnd: 5 }]);
    expect(parseConflictMarkers("")).toEqual([]);
    // eight or more characters, or text glued to the marker, are not markers
    expect(parseConflictMarkers("<<<<<<<<\n=======\n>>>>>>>>\n")).toEqual([]);
    expect(parseConflictMarkers("<<<<<<<HEAD\n=======\n>>>>>>>topic\n")).toEqual([]);
  });
});

describe("conflictLabels", () => {
  const refs = (over: Record<string, unknown>) =>
    ({
      headBranch: null,
      headOid: "a".repeat(40),
      detached: true,
      unborn: false,
      headDisplay: "HEAD",
      refs: [{ name: "topic", fullName: "refs/heads/topic", kind: "local", oid: "b".repeat(40) }],
      defaultRef: null,
      ...over,
      // biome-ignore lint/suspicious/noExplicitAny: a hand-built RefSnapshot for one pure function
    }) as any;

  test("merge: ours is the checked-out branch, theirs the ref MERGE_HEAD points at", () => {
    expect(
      conflictLabels(refs({ headBranch: "main", detached: false }), {
        kind: "merge",
        conflicts: 1,
        current: "b".repeat(40),
      }),
    ).toEqual({ ours: "main", theirs: "topic" });
  });

  test("rebase: ours is what it replays onto, theirs the stopped commit's short oid", () => {
    expect(
      conflictLabels(refs({}), {
        kind: "rebase",
        conflicts: 1,
        ontoDisplay: "main",
        current: "c".repeat(40),
      }),
    ).toEqual({ ours: "main", theirs: "ccccccc" });
  });

  test("no operation at all still names both columns", () => {
    expect(conflictLabels(refs({}), null)).toEqual({ ours: "aaaaaaa", theirs: "theirs" });
  });
});

describe("ConflictPayload parity with git ls-files -u", () => {
  for (const name of CONFLICT_FIXTURES) {
    test(`${name}: every stage oid is the one git recorded`, async () => {
      const { session, result } = await openFixture(name);
      const expected = unmerged(name);
      const conflicted = result.files.filter((f) => f.layers.includes("conflict"));
      expect(conflicted.map((f) => f.id).sort()).toEqual(Object.keys(expected).sort());
      for (const f of conflicted) {
        const p = await session.conflict(result.generation, f.id);
        const stages = expected[f.id] as Record<number, string>;
        expect(p.id).toBe(f.id);
        expect(p.generation).toBe(result.generation);
        expect(p.base?.oid ?? null).toBe(stages[1] ?? null);
        expect(p.ours?.oid ?? null).toBe(stages[2] ?? null);
        expect(p.theirs?.oid ?? null).toBe(stages[3] ?? null);
        expect(p.kind).toBe(
          conflictKindOf(Object.keys(stages).map((s) => entry(Number(s) as 1 | 2 | 3))),
        );
        expect(f.status).toBe(conflictStatus(p.kind));
      }
      await session.close();
    });

    test(`${name}: marker ranges are the marker lines of the checked-out file`, async () => {
      const { session, result } = await openFixture(name);
      for (const f of result.files.filter((x) => x.layers.includes("conflict"))) {
        const p = await session.conflict(result.generation, f.id);
        const lines = markerLines(name, f.id);
        if (lines.start.length === 0) {
          // a modify/delete conflict: git leaves the surviving side on disk, unmarked
          expect(p.worktree?.markers ?? []).toEqual([]);
          expect(p.resolvedInWorktree).toBe(true);
          continue;
        }
        expect(p.worktree).not.toBeNull();
        expect(p.worktree?.text).toBe(readFileSync(join(fixturePath(name), f.id), "utf8"));
        expect(p.worktree?.markers.map((m) => m.start)).toEqual(lines.start);
        expect(p.worktree?.markers.map((m) => m.end)).toEqual(lines.end);
        // these fixtures are `merge` style, so oursEnd is the ======= line and there is no base
        expect(p.worktree?.markers.map((m) => m.oursEnd)).toEqual(lines.split);
        expect(lines.base).toEqual([]);
        expect(p.worktree?.markers.every((m) => m.baseEnd === undefined)).toBe(true);
        expect(p.resolvedInWorktree).toBe(false);
      }
      await session.close();
    });
  }

  test("rebase-conflict: both-added has no base and diffs each side from nothing", async () => {
    const { session, result } = await openFixture("rebase-conflict");
    const p = await session.conflict(result.generation, "both-added.txt");
    expect(p.kind).toBe("both-added");
    expect(p.base).toBeNull();
    expect(p.ours?.text).toBe("both-added, main version\n");
    expect(p.theirs?.text).toBe("both-added, topic version\n");
    // base→side with no base is a pure addition on both sides
    expect(p.oursHunks?.oldLines).toBe(0);
    expect(p.oursHunks?.hunks[0]?.lines.every((l) => l.type === "add")).toBe(true);
    expect(p.theirsHunks?.newLines).toBe(1);
    expect(result.files.find((f) => f.id === "both-added.txt")?.status).toBe("added");
    expect(p.labels).toEqual({ ours: "main", theirs: "d424326" });
    await session.close();
  });

  test("merge-conflict: modify/delete yields deleted-by-them with theirs null", async () => {
    const { session, result } = await openFixture("merge-conflict");
    const p = await session.conflict(result.generation, "gone.txt");
    expect(p.kind).toBe("deleted-by-them");
    expect(p.theirs).toBeNull();
    expect(p.theirsHunks?.newLines).toBe(0);
    expect(p.theirsHunks?.hunks[0]?.lines.every((l) => l.type === "del")).toBe(true);
    expect(p.base?.oid).toBe("21f56f2ddca0be9b6848ceb902e51fac06623cf8");
    expect(p.ours?.oid).toBe("b7de1d2b085d62773583a6fbd0f5438e88d77fec");
    expect(p.oursHunks?.hunks.length).toBeGreaterThan(0);
    expect(result.files.find((f) => f.id === "gone.txt")?.status).toBe("deleted");
    expect(p.labels).toEqual({ ours: "main", theirs: "topic" });
    await session.close();
  });

  test("merge-conflict: base→ours and base→theirs are the two halves of the marked-up file", async () => {
    const { session, result } = await openFixture("merge-conflict");
    const p = await session.conflict(result.generation, "file.txt");
    expect(p.base?.text).toContain("line 3\n");
    expect(
      p.oursHunks?.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add")).map((l) => l.text),
    ).toEqual(["line 3 from main"]);
    expect(
      p.theirsHunks?.hunks
        .flatMap((h) => h.lines.filter((l) => l.type === "add"))
        .map((l) => l.text),
    ).toEqual(["line 3 from topic"]);
    await session.close();
  });
});

describe("RepoSession.conflict", () => {
  test("resolvedInWorktree flips once the markers are edited away (memory overlay)", async () => {
    const { session, mem, result } = await openMemory("merge-conflict");
    const before = await session.conflict(result.generation, "file.txt");
    expect(before.resolvedInWorktree).toBe(false);
    expect(before.worktree?.markers).toHaveLength(1);

    mem.apply([
      {
        op: "write",
        path: "file.txt",
        text: "line 1\nline 2\nline 3 merged by hand\nline 4\nline 5\nline 6\n",
        mtime: Date.now() + 60_000,
      },
    ]);
    await session.invalidate("worktree", ["file.txt"]);

    const after = await session.conflict(result.generation, "file.txt");
    expect(after.resolvedInWorktree).toBe(true);
    expect(after.worktree?.markers).toEqual([]);
    expect(after.worktree?.text).toContain("line 3 merged by hand");
    // the index still holds all three stages: resolved in the working tree, not yet staged
    expect(after.base?.oid).toBe(before.base?.oid as string);
    expect(after.ours?.oid).toBe(before.ours?.oid as string);
    expect(after.theirs?.oid).toBe(before.theirs?.oid as string);
    expect(after.kind).toBe("both-modified");
    await session.close();
  });

  test("a deleted working-tree file is never called resolved", async () => {
    const { session, mem, result } = await openMemory("merge-conflict");
    mem.apply([{ op: "remove", path: "file.txt" }]);
    await session.invalidate("worktree", ["file.txt"]);
    const p = await session.conflict(result.generation, "file.txt");
    expect(p.worktree).toBeNull();
    expect(p.resolvedInWorktree).toBe(false);
    expect(p.ours?.text).toContain("line 3 from main");
    await session.close();
  });

  test("STALE on an old generation, INTERNAL on a file with no stages, CANCELLED when superseded", async () => {
    const { session, result } = await openFixture("rebase-conflict");
    await expect(session.conflict(result.generation - 1, "file.txt")).rejects.toMatchObject({
      code: "STALE",
    });
    await expect(session.conflict(result.generation, "one.txt")).rejects.toMatchObject({
      code: "INTERNAL",
    });
    const first = session.conflict(result.generation, "file.txt");
    const second = session.conflict(result.generation, "file.txt");
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await second).id).toBe("file.txt");
    await session.close();
  });
});
