/**
 * T10.1: every revision form resolves the way `git rev-parse` did when T10.0 recorded
 * `fixtures/<name>/expected/rev-parse.txt`.
 *
 * One deliberate difference, which the helper below encodes: `resolveRevision` always returns a
 * **commit**, so for an annotated tag `oid` is the peeled commit and the tag object goes in
 * `peeledFrom` — that is the oid `git rev-parse v1.0.0` prints. `git rev-parse <root>^` fails; we
 * answer `{ oid: null, kind: "empty-tree" }` so a root commit can be diffed against the empty tree.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedLines } from "../../test/fixtures";
import { memoryFsFromDisk } from "../../test/memorySnapshot";
import { errorCode } from "../errors";
import { createFsaFs } from "../fs/fsaFs";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import type { RefSnapshot, ResolvedRevision } from "../types";
import { loadGitConfig } from "./config";
import { ObjectDb } from "./objectDb";
import { loadRefs } from "./refStore";
import { MIN_OID_PREFIX, parseRevision, resolveRevision } from "./revisions";

async function open(name: string): Promise<{ db: ObjectDb; refs: RefSnapshot }> {
  const fs = createFsaFs(await NodeDirHandle.open(fixturePath(name)));
  const db = new ObjectDb(fs);
  return { db, refs: await loadRefs(db, await loadGitConfig(fs)) };
}

/** What `git rev-parse <expr>` printed for a resolution of ours. */
function asGit(expr: string, r: ResolvedRevision): string {
  if (r.oid === null) return "<unresolved>";
  // `^{}` / `^{commit}` ask for the peeled object; every other form prints the ref's own object.
  return expr.endsWith("^{}") || expr.endsWith("^{commit}") ? r.oid : (r.peeledFrom ?? r.oid);
}

describe("resolveRevision parity with git rev-parse", () => {
  for (const fixture of ["history", "tags", "stash"]) {
    test(fixture, async () => {
      const { db, refs } = await open(fixture);
      const seen: string[] = [];
      for (const line of loadExpectedLines(fixture, "rev-parse")) {
        const expr = line.split("\t")[0] as string;
        let got: string;
        try {
          got = asGit(expr, await resolveRevision(db, refs, expr));
        } catch (e) {
          expect(errorCode(e), `${expr} failed with an unexpected code`).toBe("REV_NOT_FOUND");
          got = "<unresolved>";
        }
        seen.push(`${expr}\t${got}`);
      }
      expect(seen).toEqual(loadExpectedLines(fixture, "rev-parse"));
      expect(seen.length).toBeGreaterThan(8);
    });
  }
});

describe("resolveRevision shapes", () => {
  test("branches, remotes, HEAD and short SHAs carry kind, display and fullRef", async () => {
    const { db, refs } = await open("history");
    expect(await resolveRevision(db, refs, "main")).toMatchObject({
      kind: "branch",
      display: "main",
      fullRef: "refs/heads/main",
    });
    expect(await resolveRevision(db, refs, "refs/heads/topic")).toMatchObject({
      kind: "branch",
      display: "topic",
      fullRef: "refs/heads/topic",
    });
    expect(await resolveRevision(db, refs, "HEAD")).toMatchObject({
      kind: "head",
      display: "HEAD",
      fullRef: "HEAD",
    });
    const short = await resolveRevision(db, refs, "5772d43");
    expect(short).toMatchObject({ kind: "commit", display: "5772d43" });
    expect(short.fullRef).toBeUndefined();
    // a walked expression is a commit, displayed as typed
    expect(await resolveRevision(db, refs, "main~2")).toMatchObject({
      kind: "commit",
      display: "main~2",
    });
  });

  test("annotated tags peel to their commit and keep the tag object in peeledFrom", async () => {
    const { db, refs } = await open("tags");
    const r = await resolveRevision(db, refs, "v1.0.0");
    expect(r.kind).toBe("tag");
    expect(r.oid).toBe("8d071c323aa2f4d0c74a425f4105ef2d9d1b57c8");
    expect(r.peeledFrom).toBe("11f05d304a2a99fc00f110ab8db9e3a61f6b0dd8");
    // a lightweight tag has no tag object to peel
    expect((await resolveRevision(db, refs, "v0.1.0")).peeledFrom).toBeUndefined();
  });

  test("short names follow git's search order", async () => {
    // `tags` has refs/heads/release and refs/tags/v1.0.0 on the same commit; git's precedence is
    // refs/<x> → refs/tags/<x> → refs/heads/<x>, which `release` (a branch only) exercises.
    const { db, refs } = await open("tags");
    expect((await resolveRevision(db, refs, "release")).fullRef).toBe("refs/heads/release");
    expect((await resolveRevision(db, refs, "v1.0.0")).fullRef).toBe("refs/tags/v1.0.0");
  });

  test("stash@{n} resolves from the stash reflog", async () => {
    const { db, refs } = await open("stash");
    expect(await resolveRevision(db, refs, "stash@{1}")).toMatchObject({
      kind: "stash",
      display: "stash@{1}",
      oid: "6622462c5b8d28bc3773f3716bb08042cab077ba",
    });
    await expect(resolveRevision(db, refs, "stash@{7}")).rejects.toMatchObject({
      code: "REV_NOT_FOUND",
    });
  });

  test("the first parent of a root commit is the empty tree", async () => {
    const { db, refs } = await open("history");
    const root = "5772d43fe1036c123baac6d6792d31986659a515";
    for (const expr of [`${root}^`, `${root}~1`]) {
      expect(await resolveRevision(db, refs, expr)).toMatchObject({
        oid: null,
        kind: "empty-tree",
      });
    }
    // nothing precedes the empty tree
    await expect(resolveRevision(db, refs, `${root}^^`)).rejects.toMatchObject({
      code: "REV_NOT_FOUND",
    });
  });

  test("garbage, unknown names and too-short SHAs are REV_NOT_FOUND", async () => {
    const { db, refs } = await open("history");
    for (const expr of ["", "   ", "nope", "refs/heads/nope", "main@{1}", "main^{tree}", ":/hot"]) {
      await expect(resolveRevision(db, refs, expr)).rejects.toMatchObject({
        code: "REV_NOT_FOUND",
      });
    }
    // 6 hex characters is below MIN_OID_PREFIX, so it is not even tried as a SHA
    expect(MIN_OID_PREFIX).toBe(7);
    await expect(resolveRevision(db, refs, "5772d4")).rejects.toMatchObject({
      code: "REV_NOT_FOUND",
    });
  });

  test("a short SHA matching two objects is REV_AMBIGUOUS with the candidates in detail", async () => {
    // Crafted in memory (never on disk, D16): a second loose object file whose name shares the
    // root commit's 7-character prefix. `expandOid` lists loose object names, so both match.
    const fs = await memoryFsFromDisk(fixturePath("history"));
    const root = "5772d43fe1036c123baac6d6792d31986659a515";
    const twin = `${root.slice(0, 7)}${"a".repeat(33)}`;
    fs.write(`.git/objects/${twin.slice(0, 2)}/${twin.slice(2)}`, new Uint8Array([0]));
    const memFs = createFsaFs(fs.handle("history"));
    const db = new ObjectDb(memFs);
    const refs = await loadRefs(db, await loadGitConfig(memFs));
    await expect(resolveRevision(db, refs, root.slice(0, 7))).rejects.toMatchObject({
      code: "REV_AMBIGUOUS",
      detail: [root, twin].sort().join(","),
    });
    // the full SHA is still unambiguous
    expect((await resolveRevision(db, refs, root)).oid).toBe(root);
  });
});

describe("parseRevision", () => {
  test("splits the base from the suffix chain", () => {
    expect(parseRevision("main")).toEqual({ base: "main", steps: [] });
    expect(parseRevision("stash@{0}")).toEqual({ base: "stash@{0}", steps: [] });
    expect(parseRevision("main~2^2")).toEqual({
      base: "main",
      steps: [
        { op: "ancestor", n: 2 },
        { op: "parent", n: 2 },
      ],
    });
    expect(parseRevision("v1.0.0^{}")).toEqual({
      base: "v1.0.0",
      steps: [{ op: "peel", want: "any" }],
    });
    expect(parseRevision("v1.0.0^{commit}")).toEqual({
      base: "v1.0.0",
      steps: [{ op: "peel", want: "commit" }],
    });
    expect(() => parseRevision("main^{tree}")).toThrow();
  });
});
