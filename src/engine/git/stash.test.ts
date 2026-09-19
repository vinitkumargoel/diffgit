/**
 * T10.1: `listStashes` matches `git stash list --format='%gd %H %s'` and the parents match
 * `git rev-list --parents -n 1 stash@{n}` (both recorded by T10.0).
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedLines } from "../../test/fixtures";
import type { FsaFs } from "../fs/fsaFs";
import { createFsaFs } from "../fs/fsaFs";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import type { StashInfo } from "../types";
import { ObjectDb } from "./objectDb";
import { countStashFiles, listStashes, parseStashLog, readStashCommits } from "./stash";

async function open(name: string): Promise<{ fs: FsaFs; db: ObjectDb }> {
  const fs = createFsaFs(await NodeDirHandle.open(fixturePath(name)));
  return { fs, db: new ObjectDb(fs) };
}

describe("listStashes", () => {
  test("equals git stash list, newest first", async () => {
    const { fs, db } = await open("stash");
    const stashes = await listStashes(fs, db);
    expect(stashes.map((s) => `${s.expr} ${s.oid} ${s.message}`)).toEqual(
      loadExpectedLines("stash", "stash-list"),
    );
    expect(stashes[0]?.index).toBe(0);
    expect(stashes[0]?.message).toContain("with untracked"); // the newest push is stash@{0}
  });

  test("parents match git rev-list --parents; only the -u stash has an untrackedOid", async () => {
    const { fs, db } = await open("stash");
    const stashes = await listStashes(fs, db);
    const asGit = (s: StashInfo) =>
      [s.oid, s.baseOid, s.indexOid, ...(s.untrackedOid ? [s.untrackedOid] : [])].join(" ");
    expect(stashes.map(asGit)).toEqual(loadExpectedLines("stash", "stash-parents"));
    expect(stashes[0]?.untrackedOid).not.toBeNull();
    expect(stashes[1]?.untrackedOid).toBeNull();
  });

  test("timestamps are epoch milliseconds and files is null until counted", async () => {
    const { fs, db } = await open("stash");
    const stashes = await listStashes(fs, db);
    for (const s of stashes) {
      expect(s.timestamp).toBeGreaterThan(1e12);
      expect(s.files).toBeNull();
    }
    // the -u stash touches one tracked file plus the untracked one it kept
    expect(await countStashFiles(db, stashes[0] as StashInfo)).toBe(2);
    expect(await countStashFiles(db, stashes[1] as StashInfo)).toBe(1);
  });

  test("a repository that never stashed lists nothing", async () => {
    const { fs, db } = await open("basic");
    expect(await listStashes(fs, db)).toEqual([]);
  });

  test("readStashCommits returns null for an ordinary commit", async () => {
    const { db } = await open("history");
    const head = await db.resolveRef("refs/heads/main");
    expect(await readStashCommits(db, head)).toBeNull();
  });
});

describe("parseStashLog", () => {
  test("reverses the reflog and skips lines git could not have written", () => {
    const oid = (c: string) => c.repeat(40);
    const line = (o: string, n: string, msg: string) =>
      `${o} ${n} Ada <ada@example.com> 1700000000 +0000\t${msg}`;
    const entries = parseStashLog(
      `${line(oid("0"), oid("a"), "On main: first")}\n` +
        "garbage\n" +
        `${line(oid("a"), oid("b"), "On main: second")}\n`,
    );
    expect(entries).toEqual([
      { index: 0, oid: oid("b"), message: "On main: second", timestamp: 1700000000000 },
      { index: 1, oid: oid("a"), message: "On main: first", timestamp: 1700000000000 },
    ]);
    expect(parseStashLog(null)).toEqual([]);
  });
});
