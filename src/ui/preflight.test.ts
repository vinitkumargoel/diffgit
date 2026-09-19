/**
 * T11.13 — the rebase-preflight panel's pure half (Design §14.6, atlas tab 16), on the two reports
 * `bun run record` captured for the `history` fixture (T10.11): `preflight/a onto main`, which is
 * the likely / possible / clean trio, and `main onto preflight/base`, which is the merge case.
 */
import { describe, expect, it } from "vitest";
import type { PreflightResult } from "../engine/types";
import historyV2 from "../test/recorded/history.v2.json";
import {
  CAPPED_NOTE,
  countPredictions,
  emptyNote,
  isCapped,
  mergeNote,
  overlapLabel,
  PREDICTION_LABEL,
  PREFLIGHT_COMMIT_CAP,
  panelTitle,
  signedNote,
  summaryLine,
  todoLines,
  touchesLabel,
} from "./preflight";

const preflights = historyV2.preflights as unknown as Record<string, PreflightResult>;
const a = preflights["preflight/a onto main"] as PreflightResult;
const b = preflights["main onto preflight/base"] as PreflightResult;

describe("the recorded `preflight/a onto main` report", () => {
  it("is the likely / possible / clean trio the engine recorded", () => {
    expect(a.rows.map((r) => r.prediction)).toEqual(["likely", "possible", "clean"]);
    expect(countPredictions(a.rows)).toEqual({ likely: 1, possible: 1, clean: 1 });
    expect(a.command).toBe("git rebase -i main");
    expect(todoLines(a.todo)).toBe(3);
  });

  it("summarises the replay, how far the base moved and the two predictions", () => {
    expect(panelTitle(a)).toBe("Rebase preflight: preflight/a onto main");
    expect(summaryLine(a)).toBe(
      "3 commits to replay · main moved 55 commits since the merge base · 1 likely conflict · 1 possible",
    );
  });

  it("names the path and the onto-side commit that decided each overlap", () => {
    const likely = a.rows[0]?.overlaps[0];
    if (!likely) throw new Error("the recorded likely row has no overlap");
    expect(overlapLabel(likely, a.onto)).toBe(
      `src/hot.txt (${likely.theirs.slice(0, 7)} on main changed the same lines)`,
    );
    const possible = a.rows[1]?.overlaps[0];
    if (!possible) throw new Error("the recorded possible row has no overlap");
    expect(overlapLabel(possible, a.onto)).toBe(
      `src/hot.txt (${possible.theirs.slice(0, 7)} on main changed another part)`,
    );
    expect(a.rows[2]?.overlaps).toEqual([]);
  });

  it("has nothing to say about merges, signatures or the cap", () => {
    expect(mergeNote(a)).toBeNull();
    expect(signedNote(a)).toBeNull();
    expect(isCapped(a)).toBe(false);
  });
});

describe("the recorded `main onto preflight/base` report (the merge case)", () => {
  it("replays 55 commits, one of them a merge, and keeps history with --rebase-merges", () => {
    expect(b.rows).toHaveLength(55);
    expect(b.rows.filter((r) => r.merge)).toHaveLength(1);
    expect(b.command).toBe("git rebase -i --rebase-merges preflight/base");
    expect(mergeNote(b)).toBe(
      "One commit is a merge, so the command keeps history with --rebase-merges; a plain rebase would flatten it.",
    );
  });

  it("leaves out a base that has not moved, and says so when nothing is predicted", () => {
    expect(b.ontoAdvanced).toBe(0);
    expect(summaryLine(b)).toBe("55 commits to replay · no predicted conflict");
    expect(countPredictions(b.rows)).toEqual({ likely: 0, possible: 0, clean: 55 });
    expect(todoLines(b.todo)).toBe(55);
    expect(b.todo.endsWith("\n")).toBe(true);
  });
});

describe("the panel's remaining copy", () => {
  it("prints each prediction as its own word, never colour alone", () => {
    expect(PREDICTION_LABEL).toEqual({
      likely: "likely conflict",
      possible: "possible",
      clean: "clean",
    });
  });

  it("counts the files a commit touches", () => {
    expect(touchesLabel(1)).toBe("1 file");
    expect(touchesLabel(4)).toBe("4 files");
    expect(a.rows.map((r) => touchesLabel(r.files))).toEqual(["1 file", "1 file", "1 file"]);
  });

  it("names the signed commits a rebase would strip", () => {
    const signed: PreflightResult = {
      ...a,
      rows: a.rows.map((r, i) => (i === 0 ? { ...r, signed: true } : r)),
    };
    expect(signedNote(signed)).toBe(
      `Commit ${a.rows[0]?.oid.slice(0, 7)} is signed; rebasing rewrites it and drops the signature.`,
    );
    const two: PreflightResult = { ...a, rows: a.rows.map((r) => ({ ...r, signed: true })) };
    expect(signedNote(two)?.startsWith("Commits ")).toBe(true);
    expect(signedNote(two)?.endsWith("drops their signatures.")).toBe(true);
  });

  it("reads the cap off the report rather than off a one-shot warning", () => {
    expect(PREFLIGHT_COMMIT_CAP).toBe(500);
    expect(isCapped({ rows: a.rows, ontoAdvanced: PREFLIGHT_COMMIT_CAP })).toBe(true);
    expect(
      isCapped({ rows: new Array(PREFLIGHT_COMMIT_CAP).fill(a.rows[0]), ontoAdvanced: 0 }),
    ).toBe(true);
    expect(CAPPED_NOTE).toContain("500");
  });

  it("says there is nothing to replay when the branch is already on the base", () => {
    expect(emptyNote({ branch: "topic", onto: "main" })).toBe(
      "topic has no commit that main does not already have — there is nothing to rebase.",
    );
    expect(summaryLine({ ...a, rows: [], ontoAdvanced: 0 })).toBe("0 commits to replay");
  });
});
