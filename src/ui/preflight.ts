/**
 * Rebase preflight, pure part (T11.13, Design §14.6; atlas tab 16).
 *
 * The panel is a **report**: it says what `git rebase -i <onto>` would replay and where the two
 * sides touched the same lines, and hands over the command and the todo. It has no reorder
 * controls and never writes (D16) — the atlas's first risk row is exactly that expectation.
 *
 * Everything here is counting and copy, so `preflight.test.ts` can check both recorded reports
 * without rendering anything.
 */
import type { PreflightResult, PreflightRow } from "../engine/types";
import { shortOid } from "./history";

/** The three predictions of Design §14.6, worst first — the order the summary counts them in. */
export type Prediction = PreflightRow["prediction"];

/** The word the chip prints. Colour is never the only signal (Design §2.1). */
export const PREDICTION_LABEL: Record<Prediction, string> = {
  likely: "likely conflict",
  possible: "possible",
  clean: "clean",
};

export const PREDICTION_TITLE: Record<Prediction, string> = {
  likely:
    "Both sides changed the same lines of a file, or overlapping ones. git will almost certainly stop here.",
  possible:
    "Both sides changed the same file, but different parts of it. git usually merges this, but not always.",
  clean: "The base side never touched the files this commit changes.",
};

/** How many rows each prediction has, for the header line. */
export function countPredictions(rows: readonly PreflightRow[]): Record<Prediction, number> {
  const out: Record<Prediction, number> = { likely: 0, possible: 0, clean: 0 };
  for (const r of rows) out[r.prediction]++;
  return out;
}

/** Panel title: `Rebase preflight: preflight/a onto main`. */
export function panelTitle(r: Pick<PreflightResult, "branch" | "onto">): string {
  return `Rebase preflight: ${r.branch} onto ${r.onto}`;
}

/**
 * The mockup's stats line: `3 commits to replay · main moved 55 commits since the merge base ·
 * 1 likely conflict · 1 possible`. A count that is zero is left out — the line states what is
 * there, not what is not.
 */
export function summaryLine(r: PreflightResult): string {
  const parts: string[] = [
    `${r.rows.length} ${r.rows.length === 1 ? "commit" : "commits"} to replay`,
  ];
  if (r.ontoAdvanced > 0)
    parts.push(
      `${r.onto} moved ${r.ontoAdvanced} ${
        r.ontoAdvanced === 1 ? "commit" : "commits"
      } since the merge base`,
    );
  const counts = countPredictions(r.rows);
  if (counts.likely > 0)
    parts.push(`${counts.likely} ${counts.likely === 1 ? "likely conflict" : "likely conflicts"}`);
  if (counts.possible > 0) parts.push(`${counts.possible} possible`);
  if (counts.likely === 0 && counts.possible === 0 && r.rows.length > 0)
    parts.push("no predicted conflict");
  return parts.join(" · ");
}

/** The `Touches` cell: `1 file` / `4 files`. */
export function touchesLabel(files: number): string {
  return `${files} ${files === 1 ? "file" : "files"}`;
}

/**
 * One line of the `Overlaps with <onto>` cell. `PreflightRow.overlaps` carries the path and the
 * newest commit on the onto side that decided it, so that is what the cell names — never a line
 * range the engine did not hand over.
 */
export function overlapLabel(overlap: PreflightRow["overlaps"][number], onto: string): string {
  return overlap.prediction === "likely"
    ? `${overlap.path} (${shortOid(overlap.theirs)} on ${onto} changed the same lines)`
    : `${overlap.path} (${shortOid(overlap.theirs)} on ${onto} changed another part)`;
}

/** `—` in the mockup: this commit's paths are untouched on the other side. */
export const NO_OVERLAP = "—";

/** The todo line count, for the `Copy todo` button's title. */
export function todoLines(todo: string): number {
  return todo.split("\n").filter((l) => l !== "").length;
}

export const COMMAND_HEADING = "Nothing has been changed. To run this rebase:";
export const TODO_HEADING = "Paste this todo when the editor opens:";

/**
 * Design §14.6 / atlas tab 16: a merge inside the replay set needs `--rebase-merges`, which the
 * engine has already put in `command`. The note says why, because the plain command would silently
 * flatten the merge.
 */
export function mergeNote(r: PreflightResult): string | null {
  const merges = r.rows.filter((x) => x.merge).length;
  if (merges === 0) return null;
  return `${merges === 1 ? "One commit is a merge" : `${merges} commits are merges`}, so the command keeps history with --rebase-merges; a plain rebase would flatten ${merges === 1 ? "it" : "them"}.`;
}

/** Signed commits lose their signature when they are replayed (atlas tab 16's fourth risk row). */
export function signedNote(r: PreflightResult): string | null {
  const signed = r.rows.filter((x) => x.signed);
  if (signed.length === 0) return null;
  const names = signed.map((x) => shortOid(x.oid)).join(", ");
  return signed.length === 1
    ? `Commit ${names} is signed; rebasing rewrites it and drops the signature.`
    : `Commits ${names} are signed; rebasing rewrites them and drops their signatures.`;
}

/** The honest scope of the prediction, printed under every report (atlas tab 16, risk row 2). */
export const TEXTUAL_ONLY_NOTE =
  "Textual conflicts only. Renames are followed, but mode changes and semantic conflicts — both sides compile, the result does not — are not predicted.";

/** `PreflightResult.mergeBase === null`: the two sides share no history. */
export const UNRELATED_NOTE =
  "These two branches share no commit, so there is nothing to replay onto: git would refuse this rebase.";

/** No rows: the branch is already on top of the base. */
export function emptyNote(r: Pick<PreflightResult, "branch" | "onto">): string {
  return `${r.branch} has no commit that ${r.onto} does not already have — there is nothing to rebase.`;
}

/**
 * `PREFLIGHT_COMMIT_CAP` in `src/engine/git/preflight.ts` (T10.11). Repeated rather than imported
 * so the engine's walker never reaches the UI bundle; `preflight.test.ts` pins it against the
 * recorded reports, which are both far below it.
 */
export const PREFLIGHT_COMMIT_CAP = 500;

/**
 * T11.7's rule again: the cap is read off the **report**, not off the one-shot `HISTORY_CAPPED`
 * warning, which the next recompute replaces. Either side hitting the cap means the same thing —
 * the list stops short — and the panel says so in one inline line.
 */
export function isCapped(r: Pick<PreflightResult, "rows" | "ontoAdvanced">): boolean {
  return r.rows.length >= PREFLIGHT_COMMIT_CAP || r.ontoAdvanced >= PREFLIGHT_COMMIT_CAP;
}

/** `PREFLIGHT_COMMIT_CAP` was hit on one of the sides (`HISTORY_CAPPED`). */
export const CAPPED_NOTE =
  "One side has more than 500 commits since the merge base, so only the first 500 were read.";
