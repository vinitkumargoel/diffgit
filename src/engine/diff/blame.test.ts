/**
 * T10.6: blame parity with `git blame --porcelain`.
 *
 * The oracles are the six recordings T10.0 made on the `history` fixture — three files with and
 * without `-w` — parsed here from the porcelain format rather than hand-transcribed, so a line's
 * commit, its **original** line number and the file name that commit knew it by are all asserted.
 *
 * The working-tree case runs on an in-memory copy of the fixture: `fixtures/` is built once by
 * `scripts/make-fixtures.sh` and is never written to (D16).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixturePath, HISTORY_FIXTURE, loadExpectedText } from "../../test/fixtures";
import { snapshotFromDisk } from "../../test/memorySnapshot";
import type { ProgressSink } from "../api";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { BlameLine, RepoWarning } from "../types";

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

/**
 * Lines of `git blame --porcelain` output that a diffgit `BlameLine` has to match.
 *
 * The format is one header per group — `<oid> <origLine> <finalLine> [<count>]` — followed by the
 * commit's headers the first time it is seen and then one `\t`-prefixed content line per line of
 * the group. `filename` is only printed with those headers, so it is remembered per commit; after a
 * rename it is the name the file had **at that commit**, which is exactly `BlameLine.origPath`.
 */
function parsePorcelain(text: string): { oid: string; origLine: number; origPath: string }[] {
  const lines = text.split("\n");
  const out: { oid: string; origLine: number; origPath: string }[] = [];
  const filenames = new Map<string, string>();
  let i = 0;
  while (i < lines.length) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(lines[i] as string);
    if (!header) {
      i++;
      continue;
    }
    const oid = header[1] as string;
    const origLine = Number(header[2]);
    const finalLine = Number(header[3]);
    i++;
    while (i < lines.length && !(lines[i] as string).startsWith("\t")) {
      const h = lines[i] as string;
      if (h.startsWith("filename ")) filenames.set(oid, h.slice("filename ".length));
      i++;
    }
    i++; // the content line itself
    out[finalLine - 1] = { oid, origLine, origPath: filenames.get(oid) as string };
  }
  return out;
}

/**
 * Lines where git's `-M`/`-C` move detection would legitimately disagree with diffgit's
 * "first-parent, no cross-file moves" rule (atlas tab 02 "Risks"). None on these fixtures: every
 * line of all six oracles matches, so the list is empty and any mismatch fails the test.
 */
const MOVE_DETECTION_EXCEPTIONS: Record<string, number[]> = {};

const ORACLES = [
  { file: "blame-src-hot", path: HISTORY_FIXTURE.hotPath, ignoreWhitespace: false },
  { file: "blame-src-hot-w", path: HISTORY_FIXTURE.hotPath, ignoreWhitespace: true },
  { file: "blame-src-indent", path: HISTORY_FIXTURE.indentPath, ignoreWhitespace: false },
  { file: "blame-src-indent-w", path: HISTORY_FIXTURE.indentPath, ignoreWhitespace: true },
  { file: "blame-src-renamed-to", path: HISTORY_FIXTURE.renamedTo, ignoreWhitespace: false },
  { file: "blame-src-renamed-to-w", path: HISTORY_FIXTURE.renamedTo, ignoreWhitespace: true },
] as const;

async function openHistory() {
  return RepoSession.open(await NodeDirHandle.open(fixturePath(HISTORY_FIXTURE.name)), quietSink, {
    id: "test-blame",
  });
}

async function openMemoryHistory() {
  const snap = await snapshotFromDisk(
    fixturePath(HISTORY_FIXTURE.name),
    "history-snap",
    HISTORY_FIXTURE.name,
    { exclude: (p) => p === "expected" },
  );
  const mem = MemoryFs.fromSnapshot(snap);
  const session = await RepoSession.open(mem.handle(HISTORY_FIXTURE.name), quietSink, {
    id: "mem-blame",
  });
  return { session, mem };
}

describe("blame parity with git blame --porcelain", () => {
  for (const oracle of ORACLES) {
    test(`${oracle.file}: every line matches git`, async () => {
      const session = await openHistory();
      const want = parsePorcelain(loadExpectedText(HISTORY_FIXTURE.name, oracle.file));
      const got = await session.blame("main", oracle.path, {
        ignoreWhitespace: oracle.ignoreWhitespace,
        includeWorktree: false,
        maxRevisions: 500,
      });
      expect(got.path).toBe(oracle.path);
      expect(got.ref).toBe("main");
      expect(got.capped).toBe(false);
      expect(got.lines.length).toBe(want.length);

      const exceptions = new Set(MOVE_DETECTION_EXCEPTIONS[oracle.file] ?? []);
      const mismatches: string[] = [];
      for (let i = 0; i < want.length; i++) {
        if (exceptions.has(i + 1)) continue;
        const a = got.lines[i] as BlameLine;
        const b = want[i] as (typeof want)[number];
        expect(a.line).toBe(i + 1);
        if (a.oid !== b.oid || a.origLine !== b.origLine || a.origPath !== b.origPath)
          mismatches.push(
            `line ${i + 1}: ${a.oid}/${a.origLine}/${a.origPath} != ${b.oid}/${b.origLine}/${b.origPath}`,
          );
      }
      expect(mismatches).toEqual([]);

      // Every commit a line points at carries its author and subject, so the gutter needs no
      // second call; nothing else is carried.
      const used = new Set(got.lines.map((l) => l.oid).filter((o): o is string => o !== null));
      expect(new Set(Object.keys(got.commits))).toEqual(used);
      for (const c of Object.values(got.commits)) {
        expect(c.subject.length).toBeGreaterThan(0);
        expect(c.author.email.length).toBeGreaterThan(0);
      }
      await session.close();
    });
  }

  test("the reindent commit owns every line without -w and none with it", async () => {
    const session = await openHistory();
    const plain = await session.blame("main", HISTORY_FIXTURE.indentPath, {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 500,
    });
    const ignored = await session.blame("main", HISTORY_FIXTURE.indentPath, {
      ignoreWhitespace: true,
      includeWorktree: false,
      maxRevisions: 500,
    });
    expect(new Set(plain.lines.map((l) => l.oid)).size).toBe(1);
    expect(Object.values(plain.commits)[0]?.subject).toContain("reindent");
    expect(new Set(ignored.lines.map((l) => l.oid)).size).toBe(1);
    expect(Object.values(ignored.commits)[0]?.subject).toContain("root commit");
    await session.close();
  });

  test("the renamed file's oldest lines keep the name they had before the rename", async () => {
    const session = await openHistory();
    const got = await session.blame("main", HISTORY_FIXTURE.renamedTo, {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 500,
    });
    expect(got.lines.slice(0, 19).every((l) => l.origPath === HISTORY_FIXTURE.renamedFrom)).toBe(
      true,
    );
    expect(got.lines.slice(19).every((l) => l.origPath === HISTORY_FIXTURE.renamedTo)).toBe(true);
    await session.close();
  });
});

describe("blame: worktree, caps and progress", () => {
  test("a working-tree edit is attributed to nobody (memory overlay)", async () => {
    const { session, mem } = await openMemoryHistory();
    const path = HISTORY_FIXTURE.hotPath;
    const committed = await session.blame("main", path, {
      ignoreWhitespace: false,
      includeWorktree: true,
      maxRevisions: 500,
    });
    expect(committed.lines.every((l) => l.oid !== null)).toBe(true);

    const text = readFileSync(join(fixturePath(HISTORY_FIXTURE.name), path), "utf8");
    mem.apply([
      { op: "write", path, text: `uncommitted first line\n${text}`, mtime: Date.now() + 60_000 },
    ]);
    await session.invalidate("worktree", [path]);

    const dirty = await session.blame("main", path, {
      ignoreWhitespace: false,
      includeWorktree: true,
      maxRevisions: 500,
    });
    expect(dirty.lines.length).toBe(committed.lines.length + 1);
    expect(dirty.lines[0]).toEqual({ line: 1, oid: null, origLine: 1, origPath: path });
    expect(dirty.lines.slice(1).every((l) => l.oid !== null)).toBe(true);
    // Everything below the insertion keeps the commit and the original line number it had.
    expect(dirty.lines[1]?.oid).toBe(committed.lines[0]?.oid as string);
    expect(dirty.lines[1]?.origLine).toBe(committed.lines[0]?.origLine as number);

    // Without `includeWorktree` the same session blames the committed file, unchanged.
    const ignored = await session.blame("main", path, {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 500,
    });
    expect(ignored.lines).toEqual(committed.lines);
    await session.close();
  });

  test("maxRevisions: 2 caps, warns and still covers every line", async () => {
    const warnings: RepoWarning[] = [];
    const session = await RepoSession.open(
      await NodeDirHandle.open(fixturePath(HISTORY_FIXTURE.name)),
      { onProgress() {}, onStats() {}, onWarning: (w) => void warnings.push(w) },
      { id: "test-blame-cap" },
    );
    const full = await session.blame("main", HISTORY_FIXTURE.hotPath, {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 500,
    });
    const capped = await session.blame("main", HISTORY_FIXTURE.hotPath, {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 2,
    });
    expect(full.revisions).toBe(3);
    expect(capped.revisions).toBe(2);
    expect(capped.capped).toBe(true);
    expect(capped.lines.length).toBe(full.lines.length);
    expect(capped.lines.every((l) => l.oid !== null)).toBe(true);
    // The lines the third revision would have owned fall to the oldest revision examined.
    const oldest = full.lines.map((l) => l.oid).filter((o) => o !== null)[0];
    expect(new Set(capped.lines.map((l) => l.oid)).size).toBeLessThanOrEqual(2);
    expect(oldest).toBeTruthy();
    expect(warnings.map((w) => w.code)).toContain("BLAME_CAPPED");
    await session.close();
  });

  test("progress is phase 'blame' with done/total, and a superseded call is CANCELLED", async () => {
    const progress: { phase: string; done?: number; total?: number }[] = [];
    const session = await RepoSession.open(
      await NodeDirHandle.open(fixturePath(HISTORY_FIXTURE.name)),
      { onProgress: (p) => void progress.push(p), onStats() {}, onWarning() {} },
      { id: "test-blame-progress" },
    );
    await session.blame("main", HISTORY_FIXTURE.hotPath, {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 500,
    });
    const blameProgress = progress.filter((p) => p.phase === "blame");
    expect(blameProgress.length).toBeGreaterThanOrEqual(3);
    expect(blameProgress.map((p) => p.done)).toContain(1);
    expect(blameProgress.every((p) => (p.total ?? 0) >= (p.done ?? 0))).toBe(true);

    const first = session.blame("main", HISTORY_FIXTURE.hotPath, {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 500,
    });
    const second = session.blame("main", HISTORY_FIXTURE.renamedTo, {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 500,
    });
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await second).lines.length).toBe(21);
    await session.close();
  });

  test("a path that is not in the ref is REF_NOT_FOUND", async () => {
    const session = await openHistory();
    await expect(
      session.blame("main", "src/never-existed.txt", {
        ignoreWhitespace: false,
        includeWorktree: false,
        maxRevisions: 500,
      }),
    ).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    await session.close();
  });
});
