/**
 * Bisect strip, pure part (T11.13, Design §14.5; atlas tab 15).
 *
 * Everything here is the mark bookkeeping and the copy the strip shows. No React, no engine calls —
 * the store owns those — so `bisect.test.ts` can replay a whole bisect over the recorded marks
 * without rendering anything.
 *
 * diffgit never writes (D16): `git bisect` itself is never run. The strip keeps the good / bad /
 * skip marks, asks the engine for the midpoint, and hands the user the `git checkout` command.
 */
import type { BisectState, BisectStep, Oid } from "../engine/types";
import type { UiError } from "./errors";
import { shortOid } from "./history";

/** What one commit is marked as in the running bisect; `test` is the candidate under test. */
export type BisectMark = "good" | "bad" | "skip" | "test";

/** The three marks a user can set from the strip, the commit list or the CommitCard menu. */
export type BisectAction = "good" | "bad" | "skip";

/**
 * The store's bisect slice: the contract's `BisectState & BisectStep` (`docs/v2-contracts.md`)
 * plus the three fields the strip owns and the engine knows nothing about.
 *
 * `picking` is the two-step start of Design §14.5 ("pick good and bad from the commit list"): while
 * it is set, the strip is a prompt and a click in the list is a mark rather than a selection. While
 * `picking === "good"` the marks are still empty and `bad` is `""` — the one value `Oid` cannot
 * hold — which is why `bisectState()` below is the only way the slice reaches the engine.
 */
export interface BisectSlice extends BisectState, BisectStep {
  picking: "good" | "bad" | null;
  loading: boolean;
  /** A refused `bisectStep` (`REV_NOT_FOUND` for a mark that is not a commit); `STALE` never lands. */
  error: UiError | null;
}

/** The marks alone — what `bisectStep(state)` takes and what `diffgit-derived` remembers. */
export function bisectState(s: BisectSlice): BisectState {
  return { good: [...s.good], bad: s.bad, skipped: [...s.skipped] };
}

/** True once both ends are picked, i.e. once there is a question the engine can answer. */
export function isArmed(s: BisectSlice | null): s is BisectSlice {
  return s !== null && s.picking === null && s.bad !== "";
}

/** A fresh slice: waiting for the user to pick one end in the list, or armed with `null`. */
export function pickingSlice(picking: "good" | "bad" | null): BisectSlice {
  return {
    good: [],
    bad: "",
    skipped: [],
    candidate: null,
    remaining: 0,
    steps: 0,
    firstBad: null,
    picking,
    loading: false,
    error: null,
  };
}

/**
 * `Good`: the commit is known to work, so it joins the good set. git accumulates
 * `refs/bisect/good-*` and asks `rev-list <bad> ^<good…>`; diffgit keeps every mark for the same
 * reason — in a merge-heavy range a newer good is not necessarily a descendant of an older one, so
 * dropping the older mark would put commits that are already known good back into the count.
 */
export function withGood(s: BisectSlice, oid: Oid): BisectSlice {
  return {
    ...s,
    good: s.good.includes(oid) ? s.good : [...s.good, oid],
    skipped: s.skipped.filter((x) => x !== oid),
    error: null,
  };
}

/** `Bad`: the commit is broken, so it becomes the new bad end and every later mark is dropped. */
export function withBad(s: BisectSlice, oid: Oid): BisectSlice {
  return {
    ...s,
    bad: oid,
    good: s.good.filter((x) => x !== oid),
    skipped: s.skipped.filter((x) => x !== oid),
    error: null,
  };
}

/**
 * `Skip`: the commit cannot be tested (it does not build, it is a merge of a broken branch). It
 * stays in the graph so no strand is cut, is never offered again, and counts for nothing
 * (`docs/v2-contracts.md` `<!-- T10.11 -->`).
 */
export function withSkip(s: BisectSlice, oid: Oid): BisectSlice {
  return {
    ...s,
    skipped: s.skipped.includes(oid) ? s.skipped : [...s.skipped, oid],
    good: s.good.filter((x) => x !== oid),
    error: null,
  };
}

/** The mark a commit row wears, or null when this bisect says nothing about it. */
export function markOf(s: BisectSlice | null, oid: Oid): BisectMark | null {
  if (s === null) return null;
  if (s.bad === oid) return "bad";
  if (s.good.includes(oid)) return "good";
  if (s.skipped.includes(oid)) return "skip";
  if (s.candidate === oid) return "test";
  return null;
}

/** The word each mark prints, and the sentence its `title` explains it with. */
export const MARK_TITLE: Record<BisectMark, string> = {
  good: "Marked good: the bug is not here yet.",
  bad: "Marked bad: the bug is here.",
  skip: "Skipped: this commit could not be tested.",
  test: "The commit under test — check it out and run your test.",
};

// ---- Copy (Design §14.5's strip, atlas tab 15) -------------------------------------------------

export const STRIP_LABEL = "Bisect";

/** `good 5772d43 … bad 822313f`; several good marks are counted rather than listed. */
export function rangeLabel(s: BisectSlice): string {
  const good =
    s.good.length === 0
      ? "good —"
      : s.good.length === 1
        ? `good ${shortOid(s.good[0] as Oid)}`
        : `good ${shortOid(s.good[s.good.length - 1] as Oid)} (+${s.good.length - 1})`;
  return `${good} … bad ${s.bad === "" ? "—" : shortOid(s.bad)}`;
}

/**
 * Design §14.5's `14 between`. `BisectStep.remaining` is `git rev-list --count <bad> ^<good…>`,
 * i.e. the commits after the last good mark up to and including the bad one.
 */
export function remainingLabel(remaining: number): string {
  return `${remaining} between`;
}

export const REMAINING_TITLE =
  "Commits still suspect: everything after the good mark up to and including the bad one.";

/** `≈ 4 steps` — `ceil(log2(remaining))`, the same number git prints as "roughly N steps". */
export function stepsLabel(steps: number): string {
  return `≈ ${steps} ${steps === 1 ? "step" : "steps"}`;
}

/** `test a1b2c3d` — the commit the engine picked as the midpoint. */
export function candidateLabel(oid: Oid): string {
  return `test ${shortOid(oid)}`;
}

/** The one command the strip offers; diffgit never runs it (D16). */
export function checkoutCommand(oid: Oid): string {
  return `git checkout ${oid}`;
}

export function skippedLabel(count: number): string {
  return count === 1 ? "1 skipped" : `${count} skipped`;
}

export const PICK_GOOD_PROMPT =
  "Pick the commit you know was good in the list — the last one where the bug was not there.";
export const PICK_BAD_PROMPT = "Now pick a commit you know is bad — usually the tip.";

export const READ_ONLY_NOTE =
  "Nothing is written. Check the commit out yourself, run your test, then say what happened.";

export const ON_CANDIDATE_NOTE = "You are on the commit under test.";

export const DIRTY_NOTE =
  "You have uncommitted changes: git checkout will refuse, or carry them along. Stash them first.";

export const STASH_COMMAND = "git stash -u";

/** `first bad commit: 822313f` — the answer, once `remaining` is down to one. */
export function firstBadLabel(oid: Oid): string {
  return `first bad commit: ${shortOid(oid)}`;
}

export const FIRST_BAD_NOTE =
  "Every commit before it tested good and this one tested bad, so this is where the behaviour changed.";

/** `remaining === 0`: every candidate was skipped, so nothing is left to test. */
export const ALL_SKIPPED_NOTE =
  "Every commit left was skipped, so diffgit cannot narrow this down further.";
