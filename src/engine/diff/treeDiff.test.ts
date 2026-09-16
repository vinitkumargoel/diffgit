import { describe, expect, test } from "bun:test";
import {
  type ExpectedLsTree,
  type ExpectedNameStatus,
  fixturePath,
  loadExpected,
} from "../../test/fixtures";
import { createFsaFs } from "../fs/fsaFs";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { ObjectDb } from "../git/objectDb";
import { treeDiff } from "./treeDiff";

function statusOf(c: { oldOid: string | null; newOid: string | null }): string {
  if (c.oldOid === null) return "A";
  if (c.newOid === null) return "D";
  return "M";
}

describe("treeDiff parity with git diff --name-status --no-renames", () => {
  for (const name of [
    "basic",
    "renames",
    "binary",
    "symlink",
    "submodule",
    "attributes",
    "large",
  ]) {
    test(name, async () => {
      const db = new ObjectDb(createFsaFs(await NodeDirHandle.open(fixturePath(name))));
      const ls = loadExpected<ExpectedLsTree>(name, "ls-tree");
      const base = await db.flattenTree(ls.base as string);
      const tip = await db.flattenTree(ls.featureOid);
      const diff = treeDiff(base, tip);
      const expected = loadExpected<ExpectedNameStatus[]>(name, "name-status-3dot-no-renames");
      // git reports T (typechange) for symlink↔file; we emit modified and let T3.4 label it
      const got = Object.entries(diff).map(([path, c]) => ({ path, status: statusOf(c) }));
      const exp = expected.map((e) => ({
        path: (e.newPath ?? e.oldPath) as string,
        status: e.status === "T" ? "M" : e.status,
      }));
      expect(got).toEqual(exp);
      // ordering equals git's byte-wise path sort
      expect(Object.keys(diff)).toEqual([...Object.keys(diff)].sort());
    });
  }

  test("symlink fixture: link2 typechange carries both modes; submodule gitlink change carries 160000", async () => {
    const dbS = new ObjectDb(createFsaFs(await NodeDirHandle.open(fixturePath("symlink"))));
    const lsS = loadExpected<ExpectedLsTree>("symlink", "ls-tree");
    const dS = treeDiff(
      await dbS.flattenTree(lsS.base as string),
      await dbS.flattenTree(lsS.featureOid),
    );
    expect(dS.link2).toMatchObject({ oldMode: 0o120000, newMode: 0o100644 });
    expect(dS.link).toMatchObject({ oldMode: 0o120000, newMode: 0o120000 });
    const dbM = new ObjectDb(createFsaFs(await NodeDirHandle.open(fixturePath("submodule"))));
    const lsM = loadExpected<ExpectedLsTree>("submodule", "ls-tree");
    const dM = treeDiff(
      await dbM.flattenTree(lsM.base as string),
      await dbM.flattenTree(lsM.featureOid),
    );
    expect(dM.sub).toMatchObject({ oldMode: 0o160000, newMode: 0o160000 });
    expect(dM.sub?.oldOid).not.toBe(dM.sub?.newOid);
  });

  test("pure: null trees, identical trees, mode-only change", () => {
    const t = { "a.txt": { oid: "1".repeat(40), mode: 0o100644 } };
    expect(treeDiff(null, null)).toEqual({});
    expect(treeDiff(t, t)).toEqual({});
    expect(treeDiff(null, t)).toEqual({
      "a.txt": { oldOid: null, newOid: "1".repeat(40), oldMode: null, newMode: 0o100644 },
    });
    expect(treeDiff(t, null)).toEqual({
      "a.txt": { oldOid: "1".repeat(40), newOid: null, oldMode: 0o100644, newMode: null },
    });
    expect(treeDiff(t, { "a.txt": { oid: "1".repeat(40), mode: 0o100755 } })).toEqual({
      "a.txt": {
        oldOid: "1".repeat(40),
        newOid: "1".repeat(40),
        oldMode: 0o100644,
        newMode: 0o100755,
      },
    });
    // byte-wise ordering: "a-b" < "a/b" < "a0" (ASCII '-' 0x2d, '/' 0x2f, '0' 0x30)
    const many = treeDiff(null, { "a/b": t["a.txt"], a0: t["a.txt"], "a-b": t["a.txt"] });
    expect(Object.keys(many)).toEqual(["a-b", "a/b", "a0"]);
  });
});
