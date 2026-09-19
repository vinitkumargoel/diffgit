/**
 * T10.5: `commitStats` equals `git show --numstat --first-parent` for every commit in the `history`
 * and `octopus` fixtures (rename detection included, so the `git mv` counts as one file), and
 * `commitDetails` carries the subject/body, tree, signature flag, note and those same stats.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, HISTORY_FIXTURE, loadExpectedLines } from "../../test/fixtures";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { CommitDetails, Oid } from "../types";
import { bodyOf, subjectOf } from "./walk";

/** `commit <oid>` then git's `<added>\t<deleted>\t<path>` rows, binary sides written as `-`. */
function expectedStats(
  name: string,
): Map<Oid, { files: number; additions: number; deletions: number }> {
  const out = new Map<Oid, { files: number; additions: number; deletions: number }>();
  let current: { files: number; additions: number; deletions: number } | null = null;
  for (const line of loadExpectedLines(name, "commit-numstat")) {
    if (line.startsWith("commit ")) {
      current = { files: 0, additions: 0, deletions: 0 };
      out.set(line.slice(7), current);
      continue;
    }
    const [add, del] = line.split("\t") as [string, string];
    (current as { files: number }).files++;
    if (add !== "-") (current as { additions: number }).additions += Number.parseInt(add, 10);
    if (del !== "-") (current as { deletions: number }).deletions += Number.parseInt(del, 10);
  }
  return out;
}

async function open(name: string): Promise<RepoSession> {
  return RepoSession.open(
    await NodeDirHandle.open(fixturePath(name)),
    { onProgress() {}, onStats() {}, onWarning() {} },
    { id: `commits-${name}` },
  );
}

describe("commitStats", () => {
  for (const name of ["history", "octopus"] as const) {
    test(`${name}: every commit equals git show --numstat --first-parent`, async () => {
      const session = await open(name);
      try {
        const expected = expectedStats(name);
        expect(expected.size).toBeGreaterThan(0);
        const got = await session.commitStats([...expected.keys()]);
        for (const [oid, want] of expected) {
          expect(`${oid} ${JSON.stringify(got[oid])}`).toBe(`${oid} ${JSON.stringify(want)}`);
        }
      } finally {
        await session.close();
      }
    });
  }

  test("history: the root commit is counted against the empty tree", async () => {
    const session = await open("history");
    try {
      const oids = loadExpectedLines("history", "log-main-date-order");
      const root = oids[oids.length - 1] as string;
      const stats = (await session.commitStats([root]))[root];
      // every file the root added, all additions and no deletions
      expect(stats?.deletions).toBe(0);
      expect(stats?.files).toBeGreaterThan(3);
      expect(stats?.additions).toBeGreaterThan(50);
    } finally {
      await session.close();
    }
  });

  test("history: the rename is one file, not an add plus a delete", async () => {
    const session = await open("history");
    try {
      const renamed = loadExpectedLines("history", "log-path-renamed");
      const oid = renamed[renamed.length - 1] as string; // the `git mv` commit
      const details = await session.commitDetails(oid);
      expect(details.subject).toContain("git mv");
      expect(details.stats?.files).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("an unknown oid answers null rather than failing the batch", async () => {
    const session = await open("history");
    try {
      const good = loadExpectedLines("history", "log-main-date-order")[0] as string;
      const got = await session.commitStats([good, "0".repeat(40)]);
      expect(got[good]).not.toBeNull();
      expect(got["0".repeat(40)]).toBeNull();
    } finally {
      await session.close();
    }
  });
});

describe("commitDetails", () => {
  test("history: the merge carries both parents, the refs and the tag on it", async () => {
    const session = await open("history");
    try {
      const oids = loadExpectedLines("history", "log-main-date-order");
      // sequentially: `commitDetails` is single-in-flight, so a parallel burst would CANCEL
      const details: CommitDetails[] = [];
      for (const oid of oids.slice(0, 40)) details.push(await session.commitDetails(oid));
      const merge = details.find((d) => d.parents.length === 2) as CommitDetails;
      expect(merge.subject).toContain("merge topic into main");
      expect(merge.body).toBe("");
      expect(merge.signed).toBe(false);
      expect(merge.note).toBeNull();
      expect(merge.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(merge.refs).toContain("v0.2.0");
      const tip = details[0] as CommitDetails;
      expect(tip.refs).toEqual(["HEAD", "main", "v1.0.0"]);
      expect(tip.author.timestamp).toBeGreaterThan(1_500_000_000_000); // milliseconds, not seconds
      expect(tip.committer.email).toBe("test@example.com");
    } finally {
      await session.close();
    }
  });

  test("a revision expression resolves, so the CommitCard can be opened by name", async () => {
    const session = await open("history");
    try {
      const byName = await session.commitDetails(HISTORY_FIXTURE.annotatedTag);
      const byOid = await session.commitDetails(byName.oid);
      expect(byOid).toEqual(byName);
      expect(byName.refs).toContain(HISTORY_FIXTURE.annotatedTag);
    } finally {
      await session.close();
    }
  });

  test("subjectOf / bodyOf split git's %s and %b", () => {
    expect(subjectOf("one line\n")).toBe("one line");
    expect(bodyOf("one line\n")).toBe("");
    expect(subjectOf("subject\n\nbody line 1\nbody line 2\n")).toBe("subject");
    expect(bodyOf("subject\n\nbody line 1\nbody line 2\n")).toBe("body line 1\nbody line 2");
    expect(subjectOf("")).toBe("");
  });
});
