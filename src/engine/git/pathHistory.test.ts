/**
 * T10.6: `git log -- <path>` and `git log --follow -- <path>`.
 *
 * The oracles are git's own recordings on the `history` fixture —
 * `expected/log-path-hot.txt`, `expected/log-path-renamed.txt` and
 * `expected/log-follow-renamed.txt` — replayed oid for oid.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, HISTORY_FIXTURE, loadExpectedLines } from "../../test/fixtures";
import type { ProgressSink } from "../api";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

async function openHistory() {
  return RepoSession.open(await NodeDirHandle.open(fixturePath(HISTORY_FIXTURE.name)), quietSink, {
    id: "test-path-history",
  });
}

describe("pathHistory", () => {
  test("equals `git log --format=%H main -- <path>` without follow", async () => {
    const session = await openHistory();
    for (const [file, path] of [
      ["log-path-hot", HISTORY_FIXTURE.hotPath],
      ["log-path-renamed", HISTORY_FIXTURE.renamedTo],
    ] as const) {
      const page = await session.pathHistory("main", path, { follow: false, limit: 500 });
      expect(page.entries.map((e) => e.oid)).toEqual(loadExpectedLines(HISTORY_FIXTURE.name, file));
      expect(page.entries.every((e) => e.path === path)).toBe(true);
      expect(page.entries.every((e) => e.renamedFrom === null)).toBe(true);
      expect(page.cursor).toBeNull();
    }
    await session.close();
  });

  test("equals `git log --follow --format=%H main -- <renamed file>` and names the hop", async () => {
    const session = await openHistory();
    const page = await session.pathHistory("main", HISTORY_FIXTURE.renamedTo, {
      follow: true,
      limit: 500,
    });
    expect(page.entries.map((e) => e.oid)).toEqual(
      loadExpectedLines(HISTORY_FIXTURE.name, "log-follow-renamed"),
    );
    // `git log --follow --name-status` calls the middle commit R078 and the root an add of the
    // old name; below the hop every entry is on the old path.
    expect(page.entries.map((e) => [e.status, e.path, e.renamedFrom] as const)).toEqual([
      ["modified", HISTORY_FIXTURE.renamedTo, null],
      ["renamed", HISTORY_FIXTURE.renamedTo, HISTORY_FIXTURE.renamedFrom],
      ["modified", HISTORY_FIXTURE.renamedFrom, null],
      ["added", HISTORY_FIXTURE.renamedFrom, null],
    ]);
    await session.close();
  });

  test("whitespaceOnly is true for the reindent commit and false for the rest", async () => {
    const session = await openHistory();
    const page = await session.pathHistory("main", HISTORY_FIXTURE.indentPath, {
      follow: true,
      limit: 500,
    });
    expect(page.entries.map((e) => [e.subject, e.whitespaceOnly] as const)).toEqual([
      ["c31: reindent indent.txt (whitespace only)", true],
      ["c00: root commit", false],
    ]);
    // Every other path's history is whitespace-free, so the flag never fires by accident.
    const hot = await session.pathHistory("main", HISTORY_FIXTURE.hotPath, {
      follow: true,
      limit: 500,
    });
    expect(hot.entries.some((e) => e.whitespaceOnly)).toBe(false);
    await session.close();
  });

  test("pages with the cursor across the rename hop", async () => {
    const session = await openHistory();
    const want = loadExpectedLines(HISTORY_FIXTURE.name, "log-follow-renamed");
    const got: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: { entries: { oid: string }[]; cursor: string | null } = await session.pathHistory(
        HISTORY_FIXTURE.defaultBranch,
        HISTORY_FIXTURE.renamedTo,
        {
          follow: true,
          limit: 1,
          ...(cursor === null ? {} : { cursor }),
        },
      );
      got.push(...page.entries.map((e) => e.oid));
      cursor = page.cursor;
      if (cursor === null) break;
    }
    expect(got).toEqual(want);
    await session.close();
  });

  test("a path that never existed has no history; a bad ref is REV_NOT_FOUND", async () => {
    const session = await openHistory();
    const page = await session.pathHistory("main", "src/never-existed.txt", {
      follow: true,
      limit: 50,
    });
    expect(page).toEqual({ entries: [], cursor: null });
    await expect(
      session.pathHistory("no-such-branch", HISTORY_FIXTURE.hotPath, { follow: false, limit: 1 }),
    ).rejects.toMatchObject({ code: "REV_NOT_FOUND" });
    await session.close();
  });

  test("a superseded call rejects with CANCELLED", async () => {
    const session = await openHistory();
    const first = session.pathHistory("main", HISTORY_FIXTURE.hotPath, {
      follow: true,
      limit: 500,
    });
    const second = session.pathHistory("main", HISTORY_FIXTURE.renamedTo, {
      follow: true,
      limit: 500,
    });
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await second).entries.length).toBe(4);
    await session.close();
  });
});
