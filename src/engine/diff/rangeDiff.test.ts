/**
 * T10.1: `DiffEngine.compute` on a `RangeSource` matches `git diff --name-status` (two-dot and
 * three-dot), `git show --name-status --format=` for a single commit, and the empty tree for a root
 * commit. Expectations are the recordings in `fixtures/<name>/expected/range-name-status.txt`
 * (`<label>\t<status>\t<path>[\t<path>]`).
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedLines } from "../../test/fixtures";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { EMPTY_TREE_OID } from "../git/hash";
import { RepoSession } from "../session";
import type { FileDiff, Oid, RangeSource } from "../types";

/** A session, because ranges go through the whole path the UI uses (renames included). */
async function open(name: string): Promise<RepoSession> {
  return RepoSession.open(
    await NodeDirHandle.open(fixturePath(name)),
    { onProgress() {}, onStats() {}, onWarning() {} },
    { id: `range-${name}` },
  );
}

/** git's status letter for one of our FileDiffs (rename similarity as `R0nn`, like `--name-status`). */
function letter(f: FileDiff): string {
  switch (f.status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return `R${String(Math.round(f.similarity ?? 0)).padStart(3, "0")}`;
    case "copied":
      return `C${String(Math.round(f.similarity ?? 0)).padStart(3, "0")}`;
    case "typechange":
      return "T";
    default:
      return "M";
  }
}

function asGit(label: string, files: FileDiff[]): string[] {
  return files.map((f) =>
    f.status === "renamed" || f.status === "copied"
      ? `${label}\t${letter(f)}\t${f.oldPath}\t${f.newPath}`
      : `${label}\t${letter(f)}\t${f.newPath ?? f.oldPath}`,
  );
}

/** Lines of the recording that belong to one label. */
function expected(fixture: string, label: string): string[] {
  return loadExpectedLines(fixture, "range-name-status").filter((l) => l.startsWith(`${label}\t`));
}

async function range(
  session: RepoSession,
  from: string | null,
  to: string,
  threeDot: boolean,
): Promise<RangeSource> {
  const f = from === null ? null : await session.resolveRevision(from);
  const t = await session.resolveRevision(to);
  return {
    kind: "range",
    from: f?.display ?? "(empty)",
    to: t.display,
    fromRef: from ?? EMPTY_TREE_OID,
    toRef: to,
    fromOid: f ? f.oid : null,
    toOid: t.oid as Oid,
    threeDot,
    includeWorktree: false,
  };
}

describe("range diffs match git", () => {
  test("history: two-dot, three-dot and a three-dot across a branch point", async () => {
    const session = await open("history");
    for (const [label, from, to, threeDot] of [
      ["main~5..main", "main~5", "main", false],
      ["main~5...main", "main~5", "main", true],
      ["topic...main", "topic", "main", true],
    ] as const) {
      const out = await session.computeDiff(await range(session, from, to, threeDot));
      expect(asGit(label, out.files), label).toEqual(expected("history", label));
    }
  });

  test("history: two-dot has no merge base, three-dot has one", async () => {
    const session = await open("history");
    expect(
      (await session.computeDiff(await range(session, "topic", "main", false))).mergeBase,
    ).toBeNull();
    expect(
      (await session.computeDiff(await range(session, "topic", "main", true))).mergeBase,
    ).not.toBeNull();
  });

  test("history: one commit equals git show; the root commit equals the empty tree", async () => {
    const session = await open("history");
    const head = await session.computeDiff(await range(session, "main^", "main", false));
    expect(asGit("show main", head.files)).toEqual(expected("history", "show main"));

    const root = await session.resolveRevision("5772d43");
    // `<root>^` resolves to the empty tree, so the same expression drives both sides
    const parent = await session.resolveRevision("5772d43^");
    expect(parent.oid).toBeNull();
    const out = await session.computeDiff(await range(session, "5772d43^", "5772d43", false));
    expect(asGit("show root", out.files)).toEqual(expected("history", "show root"));
    expect(asGit("empty..root", out.files)).toEqual(expected("history", "empty..root"));
    expect(out.files.every((f) => f.status === "added")).toBe(true);
    expect(out.source).toMatchObject({ kind: "range", fromOid: null, toOid: root.oid as Oid });
    expect(out.mergeBase).toBeNull();
  });

  test("tags: an annotated tag is peeled, two-dot and three-dot agree here", async () => {
    const session = await open("tags");
    for (const [label, threeDot] of [
      ["v0.1.0..v1.0.0", false],
      ["v0.1.0...v1.0.0", true],
    ] as const) {
      const src = await range(session, "v0.1.0", "v1.0.0", threeDot);
      // the compare side is the commit the tag object points at, not the tag object
      expect(src.toOid).toBe("8d071c323aa2f4d0c74a425f4105ef2d9d1b57c8");
      const out = await session.computeDiff(src);
      expect(asGit(label, out.files), label).toEqual(expected("tags", label));
    }
  });

  test("stash: the index tree is staged, the stash tree unstaged, the third parent untracked", async () => {
    const session = await open("stash");
    const out = await session.computeDiff(await range(session, "HEAD", "stash@{0}", false));
    // tracked part = git diff HEAD stash@{0}
    const tracked = out.files.filter((f) => !f.layers.includes("untracked"));
    expect(asGit("HEAD..stash@{0}", tracked)).toEqual(expected("stash", "HEAD..stash@{0}"));
    // untracked part = the additions of git diff HEAD stash@{0}^3 (that tree holds only them)
    const untracked = out.files.filter((f) => f.layers.includes("untracked"));
    expect(asGit("HEAD..stash@{0}^3", untracked)).toEqual(
      expected("stash", "HEAD..stash@{0}^3").filter((l) => l.includes("\tA\t")),
    );
    expect(out.files.map((f) => [f.id, f.layers])).toEqual([
      ["b.txt", ["unstaged"]],
      ["stashed-untracked.txt", ["untracked"]],
    ]);

    // nothing was staged in this stash, so the index tree contributes no `staged` row
    expect(expected("stash", "HEAD..stash@{0}^2")).toEqual([]);

    const older = await session.computeDiff(await range(session, "HEAD", "stash@{1}", false));
    expect(asGit("HEAD..stash@{1}", older.files)).toEqual(expected("stash", "HEAD..stash@{1}"));
    expect(older.files.map((f) => f.layers)).toEqual([["unstaged"]]);
  });

  test("a range never layers the working tree unless it ends at HEAD", async () => {
    const session = await open("stash");
    const src = { ...(await range(session, "HEAD", "stash@{0}", false)), includeWorktree: true };
    const out = await session.computeDiff(src);
    expect(out.source.includeWorktree).toBe(false);
    expect(out.warnings.map((w) => w.code)).toContain("WORKTREE_NOT_APPLICABLE");

    // …and does layer it when it does end at HEAD
    const head = await session.resolveRevision("HEAD");
    const atHead = await session.computeDiff({
      ...(await range(session, "HEAD", "HEAD", false)),
      toOid: head.oid as Oid,
      includeWorktree: true,
    });
    expect(atHead.source.includeWorktree).toBe(true);
    expect(atHead.files.length).toBeGreaterThan(0);
  });
});
