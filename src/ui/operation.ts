/**
 * Copy for the operation banner and the conflict card (T11.3, Design §14.3, atlas tabs 06 / 07).
 * Pure: no React, no store — `OperationBanner` and `ConflictBody` render what this returns and the
 * tests assert the wording here rather than through the DOM.
 */
import type { ConflictKind } from "../engine/api";
import type { OperationKind, RepoOperation } from "../engine/types";
import { timeAgo } from "./timeAgo";
import type { BannerLevel } from "./warnings";

/** Short oid, git's own abbreviation length for the banner and the marker lines. */
export function short(oid: string | null | undefined): string {
  return oid ? oid.slice(0, 7) : "";
}

const SUBJECT: Record<OperationKind, string> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  "cherry-pick": "Cherry-pick in progress",
  revert: "Revert in progress",
  bisect: "Bisect in progress",
};

/** `git <verb> --continue` / `--abort`; bisect has neither, only `git bisect reset`. */
const COMMANDS: Record<OperationKind, { continue: string | null; abort: string }> = {
  merge: { continue: "git merge --continue", abort: "git merge --abort" },
  rebase: { continue: "git rebase --continue", abort: "git rebase --abort" },
  "cherry-pick": { continue: "git cherry-pick --continue", abort: "git cherry-pick --abort" },
  revert: { continue: "git revert --continue", abort: "git revert --abort" },
  bisect: { continue: null, abort: "git bisect reset" },
};

export interface OperationCopy {
  /** §3.4: warning while anything still conflicts, info otherwise. */
  level: BannerLevel;
  subject: string;
  /** The `·`-joined facts after the subject. */
  message: string;
  /** The read-only sentence, shown only while something conflicts. */
  note: string | null;
  continueCommand: string | null;
  abortCommand: string;
}

/** "2 files conflict" (the atlas wording), "1 file conflicts" — the verb agrees with the count. */
function conflictPhrase(n: number): string {
  return n === 1 ? "1 file conflicts" : `${n} files conflict`;
}

/** What the operation is doing right now, in the tense of its kind. */
function action(op: RepoOperation): string | null {
  const current = short(op.current);
  switch (op.kind) {
    case "rebase": {
      if (current === "") return op.ontoDisplay ? `onto ${op.ontoDisplay}` : null;
      return op.ontoDisplay
        ? `replaying ${current} onto ${op.ontoDisplay}`
        : `replaying ${current}`;
    }
    case "merge":
      return current === "" ? null : `merging ${current}`;
    case "cherry-pick":
      return current === "" ? null : `applying ${current}`;
    case "revert":
      return current === "" ? null : `reverting ${current}`;
    case "bisect":
      return current === "" ? null : `testing ${current}`;
    default:
      return null;
  }
}

/**
 * Design §14.3: `▶ Rebase in progress · step 3 of 7 · replaying a09d3c1 onto main`, warning level
 * while conflicts exist and info otherwise. Every fact beyond the kind is optional in
 * `RepoOperation`, so a layout diffgit does not recognise still says "a rebase is in progress".
 */
export function describeOperation(op: RepoOperation, now = Date.now()): OperationCopy {
  const parts: string[] = [];
  if (op.step !== undefined && op.total !== undefined) parts.push(`step ${op.step} of ${op.total}`);
  const doing = action(op);
  if (doing !== null) parts.push(doing);
  if (op.conflicts > 0) parts.push(conflictPhrase(op.conflicts));
  if (op.startedAt !== undefined) parts.push(`started ${timeAgo(op.startedAt, now)}`);
  const commands = COMMANDS[op.kind];
  return {
    level: op.conflicts > 0 ? "warning" : "info",
    subject: SUBJECT[op.kind],
    message: parts.join(" · "),
    note:
      op.conflicts > 0
        ? "diffgit shows them; resolving happens in your editor and terminal."
        : null,
    continueCommand: commands.continue,
    abortCommand: commands.abort,
  };
}

export type StepState = "done" | "current" | "remaining";
export interface OperationStep {
  oid: string;
  state: StepState;
}

/**
 * The todo list behind "Show steps": `done` ✓, the stopped-at commit ▶, then what is still in
 * `git-rebase-todo`. `done` already contains the current commit (git writes it before stopping),
 * so it is promoted rather than listed twice.
 */
export function operationSteps(op: RepoOperation): OperationStep[] {
  const out: OperationStep[] = [];
  const current = op.current;
  for (const oid of op.done ?? [])
    out.push({ oid, state: current !== undefined && oid === current ? "current" : "done" });
  if (current !== undefined && !out.some((s) => s.oid === current))
    out.push({ oid: current, state: "current" });
  for (const oid of op.remaining ?? []) out.push({ oid, state: "remaining" });
  return out;
}

export const STEP_MARK: Record<StepState, string> = {
  done: "✓",
  current: "▶",
  remaining: "·",
};
export const STEP_LABEL: Record<StepState, string> = {
  done: "done",
  current: "current",
  remaining: "remaining",
};

const KIND_LABEL: Record<ConflictKind, string> = {
  "both-modified": "both modified",
  "both-added": "both added",
  "deleted-by-us": "deleted by us",
  "deleted-by-them": "deleted by them",
  "both-deleted": "both deleted",
};

/** The `ref`-style tag on a conflict card header ("both modified"), git's own wording. */
export function describeConflictKind(kind: ConflictKind): string {
  return KIND_LABEL[kind];
}

/**
 * The copyable next command under a conflict card: stage the file, then continue the operation.
 * Outside an operation (a conflict left over from `git merge` that was already resolved elsewhere)
 * staging is all diffgit can honestly suggest.
 */
export function conflictCommand(op: RepoOperation | null, path: string): string {
  const stage = `git add ${path}`;
  const cont = op ? COMMANDS[op.kind].continue : null;
  return cont === null ? stage : `${stage} && ${cont}`;
}
