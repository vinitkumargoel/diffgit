/**
 * T11.13 — the bisect strip's pure half (Design §14.5, atlas tab 15). The mark bookkeeping is
 * replayed over the recorded `history` bisect (`bun run record`, T10.11), so the states the strip
 * builds are the ones the engine was recorded answering.
 */
import { describe, expect, it } from "vitest";
import type { BisectState, BisectStep, Oid } from "../engine/types";
import historyV2 from "../test/recorded/history.v2.json";
import {
  type BisectSlice,
  bisectState,
  candidateLabel,
  checkoutCommand,
  firstBadLabel,
  isArmed,
  MARK_TITLE,
  markOf,
  pickingSlice,
  rangeLabel,
  remainingLabel,
  skippedLabel,
  stepsLabel,
  withBad,
  withGood,
  withSkip,
} from "./bisect";

const rounds = historyV2.bisect as unknown as { state: BisectState; step: BisectStep }[];
const first = rounds[0] as { state: BisectState; step: BisectStep };
const GOOD = first.state.good[0] as Oid;
const BAD = first.state.bad;

/** An armed slice with the recorded ends, as `startBisect({ good, bad })` builds it. */
function armed(): BisectSlice {
  return withBad(withGood(pickingSlice(null), GOOD), BAD);
}

describe("bisect marks", () => {
  it("builds the recorded first state from the two ends the user picks", () => {
    const s = armed();
    expect(isArmed(s)).toBe(true);
    expect(bisectState(s)).toEqual(first.state);
  });

  it("is not armed until both ends are picked", () => {
    expect(isArmed(null)).toBe(false);
    expect(isArmed(pickingSlice("good"))).toBe(false);
    expect(isArmed(withGood(pickingSlice("bad"), GOOD))).toBe(false);
  });

  it("accumulates good marks, as git's `refs/bisect/good-*` do", () => {
    const one = withGood(armed(), rounds[2]?.state.good[0] as Oid);
    expect(one.good).toEqual([GOOD, rounds[2]?.state.good[0]]);
    // the same mark twice is one mark
    expect(withGood(one, GOOD).good).toEqual(one.good);
  });

  it("a `bad` mark moves the bad end and drops that commit from the other two sets", () => {
    const mid = rounds[0]?.step.candidate as Oid;
    const s = withBad(withSkip(armed(), mid), mid);
    expect(s.bad).toBe(mid);
    expect(s.skipped).toEqual([]);
  });

  it("a `skip` keeps the commit out of the count without cutting the strand", () => {
    const mid = rounds[0]?.step.candidate as Oid;
    const s = withSkip(armed(), mid);
    expect(bisectState(s)).toEqual(rounds[1]?.state);
    expect(withSkip(s, mid).skipped).toEqual([mid]);
  });

  it("marks a row `bad`, `good`, `skip` or `test`, in that order of precedence", () => {
    const mid = rounds[0]?.step.candidate as Oid;
    const s: BisectSlice = { ...armed(), candidate: mid, remaining: 59, steps: 6 };
    expect(markOf(s, BAD)).toBe("bad");
    expect(markOf(s, GOOD)).toBe("good");
    expect(markOf(s, mid)).toBe("test");
    expect(markOf(withSkip(s, mid), mid)).toBe("skip");
    expect(markOf(s, "0".repeat(40))).toBeNull();
    expect(markOf(null, BAD)).toBeNull();
    for (const mark of ["good", "bad", "skip", "test"] as const)
      expect(MARK_TITLE[mark].endsWith(".")).toBe(true);
  });
});

describe("bisect copy (Design §14.5's strip)", () => {
  it("prints one good and one bad end, and counts the rest", () => {
    expect(rangeLabel(armed())).toBe(`good ${GOOD.slice(0, 7)} … bad ${BAD.slice(0, 7)}`);
    const second = rounds[2]?.state.good[0] as Oid;
    expect(rangeLabel(withGood(armed(), second))).toBe(
      `good ${second.slice(0, 7)} (+1) … bad ${BAD.slice(0, 7)}`,
    );
    expect(rangeLabel(pickingSlice("good"))).toBe("good — … bad —");
  });

  it("prints the remaining count, the step estimate and the candidate", () => {
    expect(remainingLabel(59)).toBe("59 between");
    expect(stepsLabel(6)).toBe("≈ 6 steps");
    expect(stepsLabel(1)).toBe("≈ 1 step");
    expect(skippedLabel(1)).toBe("1 skipped");
    expect(skippedLabel(3)).toBe("3 skipped");
    expect(candidateLabel(BAD)).toBe(`test ${BAD.slice(0, 7)}`);
  });

  it("offers the checkout and the answer, never a command it would run itself", () => {
    expect(checkoutCommand(BAD)).toBe(`git checkout ${BAD}`);
    expect(firstBadLabel(BAD)).toBe(`first bad commit: ${BAD.slice(0, 7)}`);
  });
});

describe("the recorded replay (T10.11, `rev-list --bisect` parity)", () => {
  it("narrows 59 → 30 → 15 → 8 → 4 → 2 → 1 by marking every midpoint good", () => {
    // The recorded rounds are the engine's own answers; this walks the marks the strip would build.
    const replay = rounds.filter((r) => r.state.skipped.length === 0);
    expect(replay.map((r) => r.step.remaining)).toEqual([59, 30, 15, 8, 4, 2, 1]);
    let s = armed();
    for (const round of replay) {
      expect(bisectState(s).bad).toBe(round.state.bad);
      // every good the strip carries is the one the recording marked, plus the ones before it
      expect(s.good.at(-1)).toBe(round.state.good.at(-1));
      if (round.step.candidate === null) {
        expect(round.step.firstBad).toBe(BAD);
        break;
      }
      s = withGood(s, round.step.candidate);
    }
  });
});
