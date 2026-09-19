/**
 * T10.12 — linked worktrees (atlas tab 19).
 *
 * The oracle is `git worktree list --porcelain`, recorded by `scripts/fixture-expectations.sh` from
 * `fixtures/worktree-gitdir` with the absolute paths rewritten relative to `fixtures/` (they differ
 * per machine). git prints the **main** checkout first and the linked one second:
 *
 * ```
 * worktree _worktree-main
 * HEAD e6474f9…
 * branch refs/heads/main
 *
 * worktree worktree-gitdir
 * HEAD 2fa7483…
 * branch refs/heads/feature
 * ```
 *
 * `fixtures/_worktree-main` is the folder a user would pick, so that is where the session opens.
 *
 * **Opening the linked checkout is refused**, and deliberately: `checkLayout` classifies a folder
 * whose `.git` is a `gitdir:` file as `WORKTREE_GITDIR` (T1.2, Plan §5.2, the public error registry
 * in `tasks/README.md`). That refusal predates this task and is asserted here rather than worked
 * around — the module's own linked-checkout branch is tested directly, and it reports what a
 * browser can actually see from inside that folder: itself, by name, with nothing else resolvable.
 */
import { describe, expect, test } from "bun:test";
import { FIXTURES_ROOT, fixturePath, loadExpectedText } from "../../test/fixtures";
import type { ProgressSink } from "../api";
import { createFsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { Oid, RefSnapshot } from "../types";
import { listWorktrees, parseWorktreeHead, worktreePathFromGitdir } from "./worktrees";

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

/** `git worktree list --porcelain` → one record per worktree. */
interface PorcelainEntry {
  worktree: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  prunable: boolean;
}
function gitWorktreeList(): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  let cur: PorcelainEntry | null = null;
  for (const line of loadExpectedText("worktree-gitdir", "worktree-list").split("\n")) {
    if (line === "") {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      cur = { worktree: value, head: null, branch: null, detached: false, prunable: false };
    } else if (cur && key === "HEAD") cur.head = value;
    else if (cur && key === "branch") cur.branch = value;
    else if (cur && key === "detached") cur.detached = true;
    else if (cur && key === "prunable") cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** The engine reports the path the `gitdir` file records; the oracle is relative to `fixtures/`. */
function relative(path: string | null): string | null {
  return path === null ? null : path.replace(`${FIXTURES_ROOT}/`, "");
}

async function openMain(id: string) {
  return RepoSession.open(await NodeDirHandle.open(`${FIXTURES_ROOT}/_worktree-main`), quietSink, {
    id,
  });
}

describe("listWorktrees at the main checkout", () => {
  test("reports the main entry as `isThis` plus the linked one, like git", async () => {
    const session = await openMain("t10-12-worktrees");
    const info = await session.info();
    const list = await session.listWorktrees();
    const expected = gitWorktreeList();
    expect(expected).toHaveLength(2);
    expect(list).toHaveLength(2);

    const [main, linked] = list;
    const [gitMain, gitLinked] = expected;
    // Entry 1: the folder the session opened. git prints its absolute path; a directory handle has
    // only a name, so `path` is null and `name` is the folder's.
    expect(main?.isThis).toBe(true);
    expect(main?.path).toBeNull();
    expect(main?.name).toBe("_worktree-main");
    expect(gitMain?.worktree).toBe("_worktree-main");
    expect(main?.head).toBe(gitMain?.head as Oid);
    expect(main?.branch).toBe(gitMain?.branch as string);
    expect(main?.head).toBe(info.headOid);
    expect(main?.prunable).toBe(false);

    // Entry 2: the linked checkout, read out of `.git/worktrees/<name>/`.
    expect(linked?.isThis).toBe(false);
    expect(linked?.name).toBe("worktree-gitdir");
    expect(relative(linked?.path ?? null)).toBe(gitLinked?.worktree as string);
    expect(linked?.head).toBe(gitLinked?.head as Oid);
    expect(linked?.branch).toBe(gitLinked?.branch as string);
    expect(linked?.prunable).toBe(gitLinked?.prunable as boolean);
    expect(structuredClone(list)).toEqual(list);
    await session.close();
  });

  test("the linked worktree's branch tip resolves through the shared object database", async () => {
    const session = await openMain("t10-12-worktrees-tip");
    const list = await session.listWorktrees();
    const feature = (await session.info()).refs.find((r) => r.name === "feature");
    expect(list[1]?.head).toBe(feature?.oid as Oid);
    await session.close();
  });

  test("a repository with no linked worktrees is just itself", async () => {
    const session = await RepoSession.open(
      await NodeDirHandle.open(fixturePath("basic")),
      quietSink,
      { id: "t10-12-worktrees-none" },
    );
    const list = await session.listWorktrees();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "basic", isThis: true, prunable: false, path: null });
    await session.close();
  });
});

describe("opening the linked checkout", () => {
  test("RepoSession refuses it with WORKTREE_GITDIR (T1.2), so the list comes from the main folder", async () => {
    await expect(
      RepoSession.open(await NodeDirHandle.open(fixturePath("worktree-gitdir")), quietSink, {
        id: "t10-12-linked",
      }),
    ).rejects.toMatchObject({ code: "WORKTREE_GITDIR" });
  });

  test("the module itself reports the linked worktree as `isThis`, by name only", async () => {
    // Everything else about a linked checkout — its HEAD, its branch, the whole common directory —
    // is outside the picked folder, so this is the complete honest answer from in there.
    const fs = createFsaFs(await NodeDirHandle.open(fixturePath("worktree-gitdir")));
    const refs = {
      headBranch: null,
      headOid: null,
      detached: false,
      unborn: false,
      headDisplay: "HEAD",
      refs: [],
      defaultRef: null,
    } satisfies RefSnapshot;
    const list = await listWorktrees(
      { fs, db: { tryResolveRef: async () => null } },
      refs,
      "worktree-gitdir",
    );
    expect(list).toEqual([
      {
        name: "worktree-gitdir",
        path: null,
        head: null,
        branch: null,
        prunable: false,
        isThis: true,
      },
    ]);
  });
});

describe("worktree entries the fixture cannot build", () => {
  const refs = {
    headBranch: "main",
    headOid: "a".repeat(40),
    detached: false,
    unborn: false,
    headDisplay: "main",
    refs: [],
    defaultRef: null,
  } satisfies RefSnapshot;

  function repo(entries: Record<string, string>) {
    return createFsaFs(
      MemoryFs.fromEntries({ ".git/HEAD": "ref: refs/heads/main\n", ...entries }).handle(),
    );
  }
  const db = {
    tryResolveRef: async (ref: string) => (ref === "refs/heads/hot" ? "b".repeat(40) : null),
  };

  test("a detached linked worktree has a bare oid and no branch", async () => {
    const fs = repo({
      ".git/worktrees/review/HEAD": `${"c".repeat(40)}\n`,
      ".git/worktrees/review/gitdir": "/home/u/code/review/.git\n",
    });
    const list = await listWorktrees({ fs, db }, refs, "repo");
    expect(list[1]).toEqual({
      name: "review",
      path: "/home/u/code/review",
      head: "c".repeat(40),
      branch: null,
      prunable: false,
      isThis: false,
    });
  });

  test("a missing `gitdir` file is the one case reported as prunable", async () => {
    const fs = repo({ ".git/worktrees/gone/HEAD": "ref: refs/heads/hot\n" });
    const list = await listWorktrees({ fs, db }, refs, "repo");
    expect(list[1]).toMatchObject({
      name: "gone",
      path: null,
      prunable: true,
      branch: "refs/heads/hot",
      head: "b".repeat(40),
    });
  });

  test("entries are sorted by name, main first", async () => {
    const fs = repo({
      ".git/worktrees/zeta/HEAD": "ref: refs/heads/hot\n",
      ".git/worktrees/zeta/gitdir": "/z/.git\n",
      ".git/worktrees/alpha/HEAD": "ref: refs/heads/hot\n",
      ".git/worktrees/alpha/gitdir": "/a/.git\n",
    });
    const list = await listWorktrees({ fs, db }, refs, "repo");
    expect(list.map((w) => w.name)).toEqual(["repo", "alpha", "zeta"]);
    expect(list.map((w) => w.isThis)).toEqual([true, false, false]);
  });

  test("a detached main checkout carries no branch", async () => {
    const fs = repo({});
    const detached = { ...refs, headBranch: null, detached: true, headDisplay: "HEAD (detached)" };
    const list = await listWorktrees({ fs, db }, detached, "repo");
    expect(list[0]?.branch).toBeNull();
    expect(list[0]?.head).toBe(refs.headOid);
  });
});

describe("worktree file parsing", () => {
  test("HEAD is a symref or a bare oid", () => {
    expect(parseWorktreeHead("ref: refs/heads/feature\n")).toEqual({
      branch: "refs/heads/feature",
      oid: null,
    });
    expect(parseWorktreeHead(`${"f".repeat(40)}\n`)).toEqual({
      branch: null,
      oid: "f".repeat(40),
    });
    expect(parseWorktreeHead("garbage\n")).toEqual({ branch: null, oid: null });
  });

  test("gitdir names the `.git` file, so the worktree is its directory", () => {
    expect(worktreePathFromGitdir("/home/u/code/wt/.git\n")).toBe("/home/u/code/wt");
    expect(worktreePathFromGitdir("\n")).toBeNull();
    expect(worktreePathFromGitdir(".git\n")).toBeNull();
  });
});
