/**
 * T10.2: `readReflog` matches `git reflog --format='%H %gs'` (and the `%gd` selectors) on every
 * fixture T10.0 recorded one for, splits the action off the message, and degrades to `NO_REFLOG`
 * when the repository keeps no log.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedLines } from "../../test/fixtures";
import { EngineError } from "../errors";
import { createFsaFs, type FsaFs } from "../fs/fsaFs";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import {
  isTornReflog,
  parseReflogLine,
  parseReflogLines,
  type ReflogFs,
  readReflog,
  reflogAction,
  reflogCandidates,
} from "./reflog";

/** Every fixture whose `expected/reflog.txt` is a `git reflog --format='%H %gs'` recording. */
const PARITY_FIXTURES = [
  "reflog-orphan",
  "rebase-conflict",
  "merge-conflict",
  "cherry-pick-conflict",
  "history",
] as const;

async function open(name: string): Promise<FsaFs> {
  return createFsaFs(await NodeDirHandle.open(fixturePath(name)));
}

describe("readReflog", () => {
  for (const name of PARITY_FIXTURES) {
    test(`${name}: HEAD entries equal git reflog --format='%H %gs'`, async () => {
      const { entries, warnings } = await readReflog(await open(name), "HEAD", { limit: 1000 });
      expect(warnings).toEqual([]);
      expect(entries.map((e) => `${e.newOid} ${e.message}`)).toEqual(
        loadExpectedLines(name, "reflog"),
      );
    });
  }

  test("selectors equal git reflog --format='%gd %H %gs'", async () => {
    const { entries } = await readReflog(await open("reflog-orphan"), "HEAD");
    expect(entries.map((e) => `${e.expr} ${e.newOid} ${e.message}`)).toEqual(
      loadExpectedLines("reflog-orphan", "reflog-selectors"),
    );
  });

  test("the orphaned commits git lost are in HEAD's reflog and nowhere else", async () => {
    const { entries } = await readReflog(await open("reflog-orphan"), "HEAD");
    const orphans = loadExpectedLines("reflog-orphan", "orphan");
    expect(orphans.length).toBe(2);
    for (const oid of orphans) expect(entries.some((e) => e.newOid === oid)).toBe(true);
    // reachability is T10.5's job; every entry says "not computed yet"
    expect(entries.every((e) => e.reachable === null)).toBe(true);
  });

  test("action is the text before the first colon; message stays git's %gs", async () => {
    const { entries } = await readReflog(await open("reflog-orphan"), "HEAD");
    expect(entries.map((e) => e.action)).toEqual([
      "commit",
      "reset",
      "commit",
      "commit",
      "commit",
      "commit (initial)",
    ]);
    const rebase = await readReflog(await open("rebase-conflict"), "HEAD");
    expect(rebase.entries[0]?.action).toBe("rebase (pick)");
    expect(rebase.entries[0]?.message).toStartWith("rebase (pick): ");
  });

  test("oldOid chains backwards and is null for the entry that created the ref", async () => {
    const { entries } = await readReflog(await open("reflog-orphan"), "HEAD");
    for (let i = 0; i < entries.length - 1; i++) {
      expect(entries[i]?.oldOid).toBe(entries[i + 1]?.newOid as string);
    }
    expect(entries.at(-1)?.oldOid).toBeNull();
  });

  test("timestamps are epoch milliseconds and the signature is git's committer line", async () => {
    const { entries } = await readReflog(await open("history"), "HEAD");
    for (const e of entries) {
      expect(e.who.timestamp).toBeGreaterThan(1e12);
      expect(e.who.email).toContain("@");
      expect(Number.isInteger(e.who.tzOffsetMin)).toBe(true);
    }
  });

  test("limit keeps the newest entries", async () => {
    const all = await readReflog(await open("history"), "HEAD", { limit: 1000 });
    const three = await readReflog(await open("history"), "HEAD", { limit: 3 });
    expect(three.entries.length).toBe(3);
    expect(three.entries.map((e) => e.newOid)).toEqual(
      all.entries.slice(0, 3).map((e) => e.newOid),
    );
  });

  test("a branch reflog is read by short name, full ref and selector prefix", async () => {
    const fs = await open("history");
    const byShort = await readReflog(fs, "main");
    const byFull = await readReflog(fs, "refs/heads/main");
    expect(byShort.warnings).toEqual([]);
    expect(byShort.entries.map((e) => e.newOid)).toEqual(byFull.entries.map((e) => e.newOid));
    expect(byShort.entries[0]?.expr).toBe("main@{0}");
    expect(byFull.entries[0]?.expr).toBe("refs/heads/main@{0}");
  });

  test("the stash stack is a reflog too", async () => {
    const { entries } = await readReflog(await open("stash"), "stash");
    expect(entries.length).toBe(2);
    expect(entries[0]?.message).toContain("with untracked");
  });

  test("a repository with no logs yields [] and one NO_REFLOG warning", async () => {
    const { entries, warnings } = await readReflog(await open("unborn"), "HEAD");
    expect(entries).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(["NO_REFLOG"]);
    expect(warnings[0]?.detail).toContain("core.logAllRefUpdates");
  });

  test("a ref that has no reflog of its own warns rather than throwing", async () => {
    const { entries, warnings } = await readReflog(await open("history"), "no-such-branch");
    expect(entries).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(["NO_REFLOG"]);
  });

  test("a torn read is retried once, like the index reader", async () => {
    const full =
      `${"a".repeat(40)} ${"b".repeat(40)} Ada <ada@example.com> 1700000000 +0000\tcommit: one\n` +
      `${"b".repeat(40)} ${"c".repeat(40)} Ada <ada@example.com> 1700000001 +0000\tcommit: two\n`;
    let reads = 0;
    const fs: ReflogFs = {
      async readText(path) {
        expect(path).toBe(".git/logs/HEAD");
        reads++;
        // first read catches git mid-append: the last line is half-written
        return reads === 1 ? full.slice(0, full.length - 30) : full;
      },
    };
    const { entries } = await readReflog(fs, "HEAD", { retryMs: 1 });
    expect(reads).toBe(2);
    expect(entries.map((e) => e.message)).toEqual(["commit: two", "commit: one"]);
  });

  test("a file that is still torn after the retry keeps the complete lines it has", async () => {
    const torn = `${"a".repeat(40)} ${"b".repeat(40)} Ada <ada@example.com> 1700000000 +0000\tcommit: one\nhalf`;
    let reads = 0;
    const fs: ReflogFs = {
      async readText() {
        reads++;
        return torn;
      },
    };
    const { entries } = await readReflog(fs, "HEAD", { retryMs: 1 });
    expect(reads).toBe(2);
    expect(entries.map((e) => e.message)).toEqual(["commit: one"]);
  });

  test("a read error that is not ENOENT is not swallowed", async () => {
    const fs: ReflogFs = {
      async readText() {
        throw new EngineError("EIO", "disk went away");
      },
    };
    await expect(readReflog(fs, "HEAD")).rejects.toThrow("disk went away");
  });
});

describe("reflog parsing helpers", () => {
  test("parseReflogLine reads the signature and the git timezone convention", () => {
    const line = `${"0".repeat(40)} ${"a".repeat(40)} Ada Lovelace <ada@example.com> 1700000000 +0530\tcommit (initial): c1`;
    expect(parseReflogLine(line)).toEqual({
      oldOid: null, // all zeroes = the entry that created the ref
      newOid: "a".repeat(40),
      message: "commit (initial): c1",
      who: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        timestamp: 1700000000000,
        tzOffsetMin: -330, // +0530 east of UTC → Date.getTimezoneOffset() convention
      },
    });
    expect(parseReflogLine("nonsense")).toBeNull();
  });

  test("parseReflogLines reverses the file and skips lines git could not have written", () => {
    const l = (n: string, msg: string) =>
      `${"0".repeat(40)} ${n.repeat(40)} A <a@b> 1700000000 -0800\t${msg}`;
    expect(
      parseReflogLines(`${l("a", "one")}\ngarbage\n${l("b", "two")}\n`).map((x) => x.message),
    ).toEqual(["two", "one"]);
    expect(parseReflogLines(null)).toEqual([]);
    expect(parseReflogLines("")).toEqual([]);
  });

  test("reflogAction falls back to the whole message when there is no colon", () => {
    expect(reflogAction("rebase (pick): subject: with colons")).toBe("rebase (pick)");
    expect(reflogAction("no colon here")).toBe("no colon here");
  });

  test("isTornReflog only fires on an incomplete trailing line", () => {
    const good = `${"a".repeat(40)} ${"b".repeat(40)} A <a@b> 1700000000 +0000\tcommit: x\n`;
    expect(isTornReflog(good)).toBe(false);
    expect(isTornReflog("")).toBe(false);
    expect(isTornReflog(`${good}${"a".repeat(40)} ${"b".repeat(20)}`)).toBe(true);
  });

  test("reflogCandidates follows git's short-name precedence", () => {
    expect(reflogCandidates("HEAD")).toEqual(["logs/HEAD"]);
    expect(reflogCandidates("")).toEqual(["logs/HEAD"]);
    expect(reflogCandidates("refs/heads/main")).toEqual(["logs/refs/heads/main"]);
    expect(reflogCandidates("stash")).toEqual(["logs/refs/stash"]);
    expect(reflogCandidates("origin/main")).toEqual([
      "logs/refs/heads/origin/main",
      "logs/refs/remotes/origin/main",
      "logs/refs/tags/origin/main",
    ]);
  });
});
