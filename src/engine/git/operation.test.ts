/**
 * T10.2: `detectOperation` reads the same state files `git status` does. The three interrupted
 * fixtures (T10.0) are the oracle — `expected/operation.txt` is a dump of those very files, and
 * `expected/ls-files-u.txt` is git's own unmerged list, which `conflicts` counts.
 *
 * The `rebase-apply` (am) backend has no fixture: `scripts/make-fixtures.sh` builds every repo with
 * git 2.50, whose `rebase` always uses the merge backend, and `--apply` cannot be made to stop
 * reproducibly on every platform. It is covered here against an in-memory `.git` instead.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedLines, loadExpectedText } from "../../test/fixtures";
import { createFsaFs, type FsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import type { RepoRef } from "../types";
import { loadGitConfig } from "./config";
import { ObjectDb } from "./objectDb";
import { detectOperation, OPERATION_FILES } from "./operation";
import { loadRefs } from "./refStore";

async function open(name: string): Promise<{ fs: FsaFs; db: ObjectDb; refs: RepoRef[] }> {
  const fs = createFsaFs(await NodeDirHandle.open(fixturePath(name)));
  const db = new ObjectDb(fs);
  const snapshot = await loadRefs(db, await loadGitConfig(fs));
  return { fs, db, refs: snapshot.refs };
}

/** `key\tvalue` lines of `expected/operation.txt` (`<absent>` = the file is not there). */
function expectedState(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of loadExpectedLines(name, "operation")) {
    const tab = line.indexOf("\t");
    if (tab === -1 || line.startsWith("  ")) continue;
    out[line.slice(0, tab)] = line.slice(tab + 1);
  }
  return out;
}

/** Paths git reports as unmerged in `git ls-files -u`. */
function unmergedPaths(name: string): string[] {
  const set = new Set(loadExpectedLines(name, "ls-files-u").map((l) => l.split("\t")[1] as string));
  return [...set];
}

describe("detectOperation", () => {
  test("rebase-conflict: the interactive merge backend, stopped at step 2 of 3", async () => {
    const { fs, db, refs } = await open("rebase-conflict");
    const op = await detectOperation(fs, db, refs);
    const state = expectedState("rebase-conflict");
    expect(op).toMatchObject({
      kind: "rebase",
      step: 2,
      total: 3,
      conflicts: 2,
      onto: state.onto as string,
      headName: state["head-name"] as string,
      interactive: true,
      current: state["stopped-sha"] as string,
    });
    expect(op?.step).toBe(Number(state.msgnum));
    expect(op?.total).toBe(Number(state.end));
    expect(op?.conflicts).toBe(unmergedPaths("rebase-conflict").length);
    // `onto` is a commit the picker can name: `main` in this fixture
    expect(op?.ontoDisplay).toBe("main");
    expect(op?.startedAt).toBeGreaterThan(0);
  });

  test("rebase-conflict: remaining and done come from the todo files, oids resolved", async () => {
    const { fs, db, refs } = await open("rebase-conflict");
    const op = await detectOperation(fs, db, refs);
    // expected/operation.txt prints each todo file indented by two spaces under its own heading
    const lines = loadExpectedText("rebase-conflict", "operation").split("\n");
    const oidsUnder = (heading: string) => {
      const out: string[] = [];
      let inSection = false;
      for (const l of lines) {
        if (!l.startsWith("  ")) inSection = l === heading;
        else if (inSection && l.startsWith("  pick ")) out.push(l.trim().split(" ")[1] as string);
      }
      return out;
    };
    expect(op?.remaining).toEqual(oidsUnder("git-rebase-todo"));
    expect(op?.done).toEqual(oidsUnder("done"));
    expect(op?.remaining?.length).toBe(1);
    expect(op?.done?.length).toBe(2);
    for (const oid of [...(op?.remaining ?? []), ...(op?.done ?? [])])
      expect(oid).toMatch(/^[0-9a-f]{40}$/);
  });

  test("merge-conflict: MERGE_HEAD, two conflicted paths, no step counters", async () => {
    const { fs, db, refs } = await open("merge-conflict");
    const op = await detectOperation(fs, db, refs);
    expect(op).toMatchObject({ kind: "merge", conflicts: 2 });
    expect(op?.current).toBe(expectedState("merge-conflict").MERGE_HEAD as string);
    expect(op?.step).toBeUndefined();
    expect(op?.total).toBeUndefined();
    expect(op?.conflicts).toBe(unmergedPaths("merge-conflict").length);
  });

  test("cherry-pick-conflict: CHERRY_PICK_HEAD names the commit being replayed", async () => {
    const { fs, db, refs } = await open("cherry-pick-conflict");
    const op = await detectOperation(fs, db, refs);
    expect(op).toMatchObject({ kind: "cherry-pick", conflicts: 1 });
    expect(op?.current).toBe(expectedState("cherry-pick-conflict").CHERRY_PICK_HEAD as string);
    expect(op?.conflicts).toBe(unmergedPaths("cherry-pick-conflict").length);
  });

  test("rebase-detached: a rebase stopped by `edit` with no conflicts at all", async () => {
    const { fs, db, refs } = await open("rebase-detached");
    const op = await detectOperation(fs, db, refs);
    expect(op).toMatchObject({
      kind: "rebase",
      step: 1,
      total: 2,
      conflicts: 0,
      headName: "refs/heads/feature",
      interactive: true,
    });
    expect(op?.remaining?.length).toBe(1); // the `edit` line still to replay
    expect(op?.done?.length).toBe(1);
  });

  test("a repository that is not mid-anything answers null", async () => {
    for (const name of ["basic", "history", "worktree", "reflog-orphan"]) {
      const { fs, db, refs } = await open(name);
      expect(await detectOperation(fs, db, refs)).toBeNull();
    }
  });

  test("without refs, ontoDisplay falls back to the short oid", async () => {
    const { fs, db } = await open("rebase-conflict");
    const op = await detectOperation(fs, db);
    expect(op?.ontoDisplay).toBe((expectedState("rebase-conflict").onto as string).slice(0, 7));
  });
});

/** A `.git` with only the files the detector reads; enough to exercise layouts we have no fixture for. */
function memoryRepo(files: Record<string, string>): { fs: FsaFs; db: ObjectDb } {
  const mem = MemoryFs.fromEntries({ ".git/HEAD": "ref: refs/heads/main\n", ...files });
  const fs = createFsaFs(mem.handle("memory-repo"));
  return { fs, db: new ObjectDb(fs) };
}

describe("detectOperation on layouts without a fixture", () => {
  test("the rebase-apply (am) backend reports the same shape as rebase-merge", async () => {
    const { fs, db } = memoryRepo({
      ".git/rebase-apply/next": "3\n",
      ".git/rebase-apply/last": "7\n",
      ".git/rebase-apply/onto": `${"a".repeat(40)}\n`,
      ".git/rebase-apply/head-name": "refs/heads/feature\n",
    });
    expect(await detectOperation(fs, db)).toMatchObject({
      kind: "rebase",
      step: 3,
      total: 7,
      conflicts: 0,
      onto: "a".repeat(40),
      ontoDisplay: "aaaaaaa",
      headName: "refs/heads/feature",
    });
  });

  test("an unknown rebase layout still says a rebase is in progress", async () => {
    const { fs, db } = memoryRepo({ ".git/rebase-merge/quiet": "" });
    expect(await detectOperation(fs, db)).toEqual({ kind: "rebase", conflicts: 0 });
  });

  test("a detached-HEAD rebase records no headName", async () => {
    const { fs, db } = memoryRepo({
      ".git/rebase-merge/msgnum": "1\n",
      ".git/rebase-merge/end": "1\n",
      ".git/rebase-merge/head-name": "detached HEAD\n",
    });
    const op = await detectOperation(fs, db);
    expect(op?.headName).toBeUndefined();
    expect(op?.interactive).toBeUndefined();
  });

  test("revert and bisect are recognised, and rebase outranks a leftover MERGE_HEAD", async () => {
    const revert = memoryRepo({ ".git/REVERT_HEAD": `${"b".repeat(40)}\n` });
    expect(await detectOperation(revert.fs, revert.db)).toMatchObject({
      kind: "revert",
      current: "b".repeat(40),
    });

    const bisect = memoryRepo({
      ".git/BISECT_LOG": "git bisect start\n",
      ".git/BISECT_START": "main\n",
    });
    expect(await detectOperation(bisect.fs, bisect.db)).toMatchObject({
      kind: "bisect",
      headName: "main",
    });

    // a rebase that stopped on a conflict leaves MERGE_MODE/MERGE_HEAD behind; git calls it a rebase
    const both = memoryRepo({
      ".git/MERGE_HEAD": `${"c".repeat(40)}\n`,
      ".git/rebase-merge/msgnum": "2\n",
      ".git/rebase-merge/end": "4\n",
    });
    expect((await detectOperation(both.fs, both.db))?.kind).toBe("rebase");
  });

  test("an octopus MERGE_HEAD reports the first commit being merged", async () => {
    const { fs, db } = memoryRepo({
      ".git/MERGE_HEAD": `${"d".repeat(40)}\n${"e".repeat(40)}\n`,
    });
    expect((await detectOperation(fs, db))?.current).toBe("d".repeat(40));
  });
});

describe("OPERATION_FILES", () => {
  test("covers every state file the detector reads, so the probe sees them change", () => {
    for (const f of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "BISECT_START",
      "rebase-merge/msgnum",
      "rebase-merge/git-rebase-todo",
      "rebase-merge/done",
      "rebase-apply/next",
      "rebase-apply/last",
    ])
      expect(OPERATION_FILES).toContain(f as (typeof OPERATION_FILES)[number]);
  });
});
