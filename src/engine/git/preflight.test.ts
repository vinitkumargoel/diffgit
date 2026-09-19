/**
 * T10.11 rebase-preflight parity. The oracles are written by `scripts/fixture-expectations.sh` from
 * git itself, on throwaway clones of `fixtures/history` (the fixture is never written — D16):
 *
 * | file                       | git command |
 * |----------------------------|-------------|
 * | `preflight-outcome.txt`    | `git rebase main preflight/a`, then `git rebase --onto main <c>^ <c>` per commit |
 * | `preflight-todo.txt`       | the todo `git rebase -i main` generates, comments stripped |
 * | `rev-list-left-right-count.txt` | `git rev-list --left-right --count main...preflight/a` |
 *
 * `preflight/a` is crafted (T10.0) so the three grades all appear: p1 rewrites the same three lines
 * of `src/hot.txt` that `main` rewrote (`likely`), p2 edits the same file 45 lines away
 * (`possible`), p3 adds a file nothing else touches (`clean`). The recorded rebase confirms which
 * one really conflicts.
 */
import { describe, expect, test } from "bun:test";
import {
  fixturePath,
  HISTORY_FIXTURE,
  loadExpectedLines,
  loadExpectedText,
} from "../../test/fixtures";
import type { ProgressSink } from "../api";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { Oid } from "../types";

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

async function openHistory(id = "test-preflight") {
  return RepoSession.open(await NodeDirHandle.open(fixturePath(HISTORY_FIXTURE.name)), quietSink, {
    id,
  });
}

/** What `git rebase --onto main <commit>^ <commit>` really did, per replayed commit. */
interface Outcome {
  oid: Oid;
  conflicted: boolean;
  paths: string[];
}

function loadOutcomes(): { mergeBase: Oid; perCommit: Outcome[] } {
  let mergeBase = "";
  const perCommit: Outcome[] = [];
  let current: Outcome | null = null;
  let inPerCommit = false;
  for (const line of loadExpectedLines(HISTORY_FIXTURE.name, "preflight-outcome")) {
    if (line.startsWith("merge-base ")) mergeBase = line.slice("merge-base ".length);
    if (line.startsWith("## git rebase --onto")) {
      inPerCommit = true;
      continue;
    }
    if (!inPerCommit) continue;
    const m = /^commit (\w+) (clean|conflict) /.exec(line);
    if (m) {
      current = { oid: m[1] as Oid, conflicted: m[2] === "conflict", paths: [] };
      perCommit.push(current);
      continue;
    }
    const c = /^ {2}conflicted (.+)$/.exec(line);
    if (c && current) current.paths.push(c[1] as string);
  }
  if (mergeBase === "" || perCommit.length === 0)
    throw new Error("preflight-outcome.txt: no recorded rebase outcome");
  return { mergeBase: mergeBase as Oid, perCommit };
}

const OUTCOME = loadOutcomes();
/** `pick <sha7> [# ]<subject>` — git ≥ 2.46 comments the oneline out; both spellings are accepted. */
const GIT_TODO = loadExpectedLines(HISTORY_FIXTURE.name, "preflight-todo").map((l) =>
  l.replace(/^(pick [0-9a-f]+) # /, "$1 "),
);

describe("rebasePreflight on `history`: predictions vs the recorded `git rebase`", () => {
  test("the oracle really has one conflicting commit and two clean ones", () => {
    expect(OUTCOME.perCommit.length).toBe(3);
    expect(OUTCOME.perCommit.filter((o) => o.conflicted).length).toBe(1);
    expect(OUTCOME.perCommit.find((o) => o.conflicted)?.paths).toEqual([HISTORY_FIXTURE.hotPath]);
  });

  test("rows are the replayed commits, oldest first, with git's merge base and advance", async () => {
    const session = await openHistory();
    const out = await session.rebasePreflight(HISTORY_FIXTURE.preflightBranch, "main");
    expect(out.branch).toBe(HISTORY_FIXTURE.preflightBranch);
    expect(out.onto).toBe("main");
    expect(out.mergeBase).toBe(OUTCOME.mergeBase);
    expect(out.rows.map((r) => r.oid)).toEqual(OUTCOME.perCommit.map((o) => o.oid));
    // `git rev-list --left-right --count main...preflight/a` is "55\t3": main gained 55 commits
    // (the onto side's advance) and preflight/a 3 (the rows to replay).
    const counts = (
      loadExpectedLines(HISTORY_FIXTURE.name, "rev-list-left-right-count").find((l) =>
        l.startsWith("main...preflight/a\t"),
      ) as string
    ).split(/\s+/);
    expect(out.ontoAdvanced).toBe(Number(counts[1]));
    expect(out.rows.length).toBe(Number(counts[2]));
    await session.close();
  });

  test("grades the crafted trio likely / possible / clean, and `likely` is the one git stopped on", async () => {
    const session = await openHistory("test-preflight-grades");
    const out = await session.rebasePreflight(HISTORY_FIXTURE.preflightBranch, "main");
    expect(out.rows.map((r) => r.prediction)).toEqual(["likely", "possible", "clean"]);

    for (const row of out.rows) {
      const recorded = OUTCOME.perCommit.find((o) => o.oid === row.oid) as Outcome;
      // The prediction is a superset of the truth: `clean` is never wrong, `likely` is the one git
      // really stopped on, and `possible` is allowed to be either (here it merged).
      if (row.prediction === "clean") expect(recorded.conflicted).toBe(false);
      if (row.prediction === "likely") expect(recorded.conflicted).toBe(true);
      if (recorded.conflicted) expect(row.prediction).toBe("likely");
    }

    const [p1, p2, p3] = out.rows;
    // p1: the same three lines of hot.txt that main rewrote → overlapping ranges.
    expect(p1?.overlaps.map((o) => o.path)).toEqual([HISTORY_FIXTURE.hotPath]);
    expect(p1?.overlaps[0]?.prediction).toBe("likely");
    expect(p1?.files).toBe(1);
    // The onto-side commit named is a real commit of main that touched the file.
    const theirs = p1?.overlaps[0]?.theirs as Oid;
    const details = await session.commitDetails(theirs);
    expect(details.subject).toContain("hot.txt");
    // p2: the same file, 45 lines away → same file, disjoint ranges.
    expect(p2?.overlaps.map((o) => o.path)).toEqual([HISTORY_FIXTURE.hotPath]);
    expect(p2?.overlaps[0]?.prediction).toBe("possible");
    // p3: a file only preflight/a touches → no overlaps at all.
    expect(p3?.overlaps).toEqual([]);
    expect(p3?.files).toBe(1);
    // None of the three is a merge or signed, so the plain command is right.
    expect(out.rows.every((r) => !r.merge && !r.signed)).toBe(true);
    expect(out.command).toBe("git rebase -i main");
    await session.close();
  });

  test("the todo is git's own todo list, in git's own order", async () => {
    const session = await openHistory("test-preflight-todo");
    const out = await session.rebasePreflight(HISTORY_FIXTURE.preflightBranch, "main");
    expect(out.todo.split("\n").filter((l) => l.length > 0)).toEqual(GIT_TODO);
    expect(out.todo.endsWith("\n")).toBe(true);
    for (const row of out.rows)
      expect(out.todo).toContain(`pick ${row.oid.slice(0, 7)} ${row.subject}\n`);
    await session.close();
  });
});

describe("rebasePreflight: merges, empty ranges, errors and cancellation", () => {
  test("a merge in the replay set switches the command to --rebase-merges", async () => {
    const session = await openHistory("test-preflight-merges");
    // `main` since `preflight/base` contains the merge of `topic`; the onto side gained nothing.
    const out = await session.rebasePreflight("main", HISTORY_FIXTURE.preflightBase);
    expect(out.ontoAdvanced).toBe(0);
    expect(out.rows.length).toBe(55);
    const merges = out.rows.filter((r) => r.merge);
    expect(merges.length).toBe(1);
    expect(merges[0]?.subject).toContain("merge topic into main");
    expect(out.command).toBe(`git rebase -i --rebase-merges ${HISTORY_FIXTURE.preflightBase}`);
    // Nothing on the onto side moved, so nothing can collide.
    expect(out.rows.every((r) => r.prediction === "clean")).toBe(true);
    expect(out.todo.split("\n").filter((l) => l.length > 0).length).toBe(55);
    await session.close();
  });

  test("rebasing onto a descendant replays nothing and produces an empty todo", async () => {
    const session = await openHistory("test-preflight-empty");
    const out = await session.rebasePreflight(HISTORY_FIXTURE.preflightBase, "main");
    expect(out.rows).toEqual([]);
    expect(out.todo).toBe("");
    expect(out.command).toBe("git rebase -i main");
    expect(out.mergeBase).toBe((await session.resolveRevision(HISTORY_FIXTURE.preflightBase)).oid);
    expect(out.ontoAdvanced).toBe(55);
    await session.close();
  });

  test("a side that does not resolve is REV_NOT_FOUND", async () => {
    const session = await openHistory("test-preflight-badref");
    await expect(session.rebasePreflight("refs/heads/nope", "main")).rejects.toMatchObject({
      code: "REV_NOT_FOUND",
    });
    await session.close();
  });

  test("a newer call supersedes the older one with CANCELLED", async () => {
    const session = await openHistory("test-preflight-cancel");
    const superseded = session.rebasePreflight("main", HISTORY_FIXTURE.preflightBase);
    const winner = session.rebasePreflight("main", HISTORY_FIXTURE.preflightBase);
    await expect(superseded).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await winner).rows.length).toBe(55);
    await session.close();
  });

  test("the report is structured-cloneable — no Maps, Sets or class instances", async () => {
    const session = await openHistory("test-preflight-clone");
    const out = await session.rebasePreflight(HISTORY_FIXTURE.preflightBranch, "main");
    expect(structuredClone(out)).toEqual(out);
    expect(loadExpectedText(HISTORY_FIXTURE.name, "preflight-todo").length).toBeGreaterThan(0);
    await session.close();
  });
});
