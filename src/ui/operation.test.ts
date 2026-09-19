import { describe, expect, it } from "vitest";
import type { RepoOperation } from "../engine/types";
import cherryV2 from "../test/recorded/cherry-pick-conflict.v2.json";
import mergeV2 from "../test/recorded/merge-conflict.v2.json";
import rebaseV2 from "../test/recorded/rebase-conflict.v2.json";
import {
  conflictCommand,
  describeConflictKind,
  describeOperation,
  operationSteps,
  short,
} from "./operation";

const rebase = rebaseV2.operation as unknown as RepoOperation;
const merge = mergeV2.operation as unknown as RepoOperation;
const cherry = cherryV2.operation as unknown as RepoOperation;
/** Recorded fixtures pin `startedAt`; freeze "now" so the age is a constant in the assertions. */
const NOW = 1704067200000 + 4 * 60_000;

describe("describeOperation (Design §14.3)", () => {
  it("rebase: subject, step k of n, what is being replayed onto what, conflicts and age", () => {
    const copy = describeOperation(rebase, NOW);
    expect(copy.subject).toBe("Rebase in progress");
    expect(copy.message).toBe(
      "step 2 of 3 · replaying d424326 onto main · 2 files conflict · started 4 min ago",
    );
    expect(copy.level).toBe("warning"); // conflicts > 0
    expect(copy.note).toBe("diffgit shows them; resolving happens in your editor and terminal.");
    expect(copy.continueCommand).toBe("git rebase --continue");
    expect(copy.abortCommand).toBe("git rebase --abort");
  });

  it("merge and cherry-pick get their own verb and their own commands", () => {
    const m = describeOperation(merge, NOW);
    expect(m.subject).toBe("Merge in progress");
    expect(m.message).toBe("merging fa38608 · 2 files conflict · started 4 min ago");
    expect(m.continueCommand).toBe("git merge --continue");
    expect(m.abortCommand).toBe("git merge --abort");

    const c = describeOperation(cherry, NOW);
    expect(c.subject).toBe("Cherry-pick in progress");
    expect(c.message).toBe("applying 77be65c · 1 file conflicts · started 4 min ago");
    expect(c.continueCommand).toBe("git cherry-pick --continue");
    expect(c.abortCommand).toBe("git cherry-pick --abort");
  });

  it("info level while nothing conflicts; bisect has no --continue, only a reset", () => {
    const clean = describeOperation({ ...rebase, conflicts: 0 }, NOW);
    expect(clean.level).toBe("info");
    expect(clean.note).toBeNull();
    expect(clean.message).not.toContain("conflict");

    const bisect = describeOperation({ kind: "bisect", conflicts: 0 }, NOW);
    expect(bisect.subject).toBe("Bisect in progress");
    expect(bisect.message).toBe("");
    expect(bisect.continueCommand).toBeNull();
    expect(bisect.abortCommand).toBe("git bisect reset");
  });

  it("a layout with no counts still names the operation (atlas tab 07 risk row)", () => {
    const copy = describeOperation({ kind: "revert", conflicts: 0 }, NOW);
    expect(copy.subject).toBe("Revert in progress");
    expect(copy.message).toBe("");
    expect(copy.abortCommand).toBe("git revert --abort");
  });
});

describe("operationSteps (the Show steps popover)", () => {
  it("promotes the stopped-at commit out of `done` and appends what is still to do", () => {
    const steps = operationSteps(rebase);
    expect(steps).toEqual([
      { oid: "e3c40a407beaf6e4a5105e4895545c7ff952672c", state: "done" },
      { oid: "d424326b468f78a175aa69ff38d2e81cde985913", state: "current" },
      { oid: "83e12b7fa78ea58beb3434d25276f41fd1584444", state: "remaining" },
    ]);
    expect(steps).toHaveLength(rebase.total ?? 0);
  });

  it("a merge has no todo list, only the commit it stopped on", () => {
    expect(operationSteps(merge)).toEqual([
      { oid: "fa386080e5fe2f64967f9c18fbe8d2e505dcb812", state: "current" },
    ]);
    expect(operationSteps({ kind: "merge", conflicts: 0 })).toEqual([]);
  });
});

describe("conflict copy", () => {
  it("names every ConflictKind the way git does", () => {
    expect(describeConflictKind("both-modified")).toBe("both modified");
    expect(describeConflictKind("both-added")).toBe("both added");
    expect(describeConflictKind("deleted-by-us")).toBe("deleted by us");
    expect(describeConflictKind("deleted-by-them")).toBe("deleted by them");
    expect(describeConflictKind("both-deleted")).toBe("both deleted");
  });

  it("stages the file, then continues the operation that is actually running", () => {
    expect(conflictCommand(rebase, "src/cart/total.ts")).toBe(
      "git add src/cart/total.ts && git rebase --continue",
    );
    expect(conflictCommand(merge, "file.txt")).toBe("git add file.txt && git merge --continue");
    // no operation, or one with no --continue: staging is all diffgit can honestly suggest
    expect(conflictCommand(null, "file.txt")).toBe("git add file.txt");
    expect(conflictCommand({ kind: "bisect", conflicts: 0 }, "file.txt")).toBe("git add file.txt");
  });

  it("short() is git's own abbreviation and tolerates a missing oid", () => {
    expect(short("d424326b468f78a175aa69ff38d2e81cde985913")).toBe("d424326");
    expect(short(undefined)).toBe("");
  });
});
