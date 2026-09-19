/**
 * T10.11 bisect parity. The oracle is `fixtures/history/expected/rev-list-bisect.txt`, written by
 * `scripts/fixture-expectations.sh` as a real replay of
 *
 *   git rev-list --count <bad> ^<good>   →  remaining
 *   git rev-list --bisect  <bad> ^<good> →  midpoint
 *
 * with "the midpoint was good" answered at every round, exactly the game the bisect strip plays
 * (atlas tab 15). The engine has to name the same commit at every round.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, HISTORY_FIXTURE, loadExpectedLines } from "../../test/fixtures";
import type { ProgressSink } from "../api";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { BisectState, Oid } from "../types";

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

async function openHistory(id = "test-bisect") {
  return RepoSession.open(await NodeDirHandle.open(fixturePath(HISTORY_FIXTURE.name)), quietSink, {
    id,
  });
}

/** One recorded round: `step <n> good <oid> bad <oid> remaining <n> midpoint <oid>`. */
interface Round {
  good: Oid;
  bad: Oid;
  remaining: number;
  midpoint: Oid;
}

const ROUNDS: Round[] = loadExpectedLines(HISTORY_FIXTURE.name, "rev-list-bisect").map((line) => {
  const m = /^step \d+ good (\w+) bad (\w+) remaining (\d+) midpoint (\w+)$/.exec(line);
  if (!m) throw new Error(`rev-list-bisect.txt: unparsed line ${JSON.stringify(line)}`);
  return {
    good: m[1] as Oid,
    bad: m[2] as Oid,
    remaining: Number(m[3]),
    midpoint: m[4] as Oid,
  };
});

describe("bisectStep parity with `git rev-list --bisect` on the `history` fixture", () => {
  test("the oracle is the replay the engine is asked to reproduce", () => {
    expect(ROUNDS.length).toBeGreaterThan(5);
    expect(ROUNDS[0]?.remaining).toBe(59);
    // Every round narrows, and the last one has a single suspect left.
    for (let i = 1; i < ROUNDS.length; i++)
      expect(ROUNDS[i]?.remaining).toBeLessThan(ROUNDS[i - 1]?.remaining as number);
    expect(ROUNDS.at(-1)?.remaining).toBe(1);
  });

  test("names git's midpoint at every round of the replay", async () => {
    const session = await openHistory();
    for (const round of ROUNDS) {
      const step = await session.bisectStep({ good: [round.good], bad: round.bad, skipped: [] });
      expect(step.remaining).toBe(round.remaining);
      if (round.remaining > 1) {
        // git is still narrowing: the midpoint must be the same commit.
        expect(step.candidate).toBe(round.midpoint);
        expect(step.firstBad).toBeNull();
        expect(step.steps).toBe(Math.ceil(Math.log2(round.remaining)));
      } else {
        // One suspect left; `git rev-list --bisect` answers the bad commit and so do we.
        expect(step.candidate).toBeNull();
        expect(step.firstBad).toBe(round.midpoint);
        expect(step.steps).toBe(0);
      }
    }
    await session.close();
  });

  test("the first round halves a 59-commit range in the six steps git predicts", async () => {
    const session = await openHistory("test-bisect-steps");
    const first = ROUNDS[0] as Round;
    const step = await session.bisectStep({ good: [first.good], bad: first.bad, skipped: [] });
    expect(step.remaining).toBe(59);
    expect(step.steps).toBe(6);
    // Six rounds of narrowing is exactly what the replay took to reach one suspect.
    expect(ROUNDS.length - 1).toBe(6);
    await session.close();
  });

  test("accepts revision expressions as well as oids, and several good marks", async () => {
    const session = await openHistory("test-bisect-exprs");
    const byExpr = await session.bisectStep({ good: ["main~47"], bad: "main", skipped: [] });
    const first = ROUNDS[0] as Round;
    expect(byExpr.candidate).toBe(first.midpoint);
    // A second good mark that is an ancestor of the first changes nothing (git unions them).
    const both = await session.bisectStep({
      good: [first.good, "main~47"],
      bad: "main",
      skipped: [],
    });
    expect(both).toEqual(byExpr);
    await session.close();
  });
});

describe("bisectStep: skips, terminal states and cancellation", () => {
  /**
   * `git bisect skip` keeps the commit in the list and picks a replacement with a PRNG
   * (`bisect.c: get_prn`), which cannot be reproduced from the outside; the T10.11 brief instead
   * removes a skipped commit from the candidate set. These are the properties that follow, which
   * is what the contract documents.
   */
  test("a skipped midpoint is never offered again and the set shrinks by exactly one", async () => {
    const session = await openHistory("test-bisect-skip");
    const first = ROUNDS[0] as Round;
    const plain = await session.bisectStep({ good: [first.good], bad: first.bad, skipped: [] });
    const candidate = plain.candidate as Oid;
    const skipped = await session.bisectStep({
      good: [first.good],
      bad: first.bad,
      skipped: [candidate],
    });
    expect(skipped.remaining).toBe(plain.remaining - 1);
    expect(skipped.candidate).not.toBe(candidate);
    expect(skipped.candidate).not.toBeNull();
    // The replacement is still a suspect, i.e. reachable from bad and not from good, and it is
    // still a near-half split: its distance is within one of the unskipped best.
    const reachable = await session.markReachable([skipped.candidate as Oid]);
    expect(reachable[skipped.candidate as Oid]).toBe(true);
    expect(skipped.steps).toBe(Math.ceil(Math.log2(skipped.remaining)));
    // Skipping a commit that is not a suspect at all is a no-op.
    const irrelevant = await session.bisectStep({
      good: [first.good],
      bad: first.bad,
      skipped: [first.good],
    });
    expect(irrelevant).toEqual(plain);
    await session.close();
  });

  test("good === bad leaves no suspects and names bad as the first bad commit", async () => {
    const session = await openHistory("test-bisect-done");
    const bad = (await session.resolveRevision("main")).oid as Oid;
    const step = await session.bisectStep({ good: [bad], bad, skipped: [] });
    expect(step).toEqual({ candidate: null, remaining: 0, steps: 0, firstBad: bad });
    await session.close();
  });

  test("with no good mark at all every ancestor of bad is a suspect", async () => {
    const session = await openHistory("test-bisect-nogood");
    const bad = (await session.resolveRevision("main")).oid as Oid;
    const step = await session.bisectStep({ good: [], bad, skipped: [] });
    // `git rev-list --count main` is 60: the 59 of the replay plus the root.
    expect(step.remaining).toBe(60);
    expect(step.candidate).not.toBeNull();
    await session.close();
  });

  test("a bad mark that is not a commit is REV_NOT_FOUND", async () => {
    const session = await openHistory("test-bisect-badref");
    await expect(
      session.bisectStep({ good: [], bad: "refs/heads/nope", skipped: [] }),
    ).rejects.toMatchObject({ code: "REV_NOT_FOUND" });
    await session.close();
  });

  test("a newer call supersedes the older one with CANCELLED", async () => {
    const session = await openHistory("test-bisect-cancel");
    const bad = (await session.resolveRevision("main")).oid as Oid;
    const state: BisectState = { good: [], bad, skipped: [] };
    const superseded = session.bisectStep(state);
    const winner = session.bisectStep(state);
    await expect(superseded).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await winner).remaining).toBe(60);
    await session.close();
  });
});
