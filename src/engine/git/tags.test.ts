/**
 * T10.1: `listTags` matches `git tag -l --format='%(refname) %(objecttype) %(objectname) %(*objectname)'`,
 * recorded by T10.0 in `fixtures/<name>/expected/tag-list.txt`.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedLines } from "../../test/fixtures";
import { createFsaFs } from "../fs/fsaFs";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import type { TagInfo } from "../types";
import { ObjectDb } from "./objectDb";
import { listTags } from "./tags";

async function tagsOf(name: string): Promise<TagInfo[]> {
  return listTags(new ObjectDb(createFsaFs(await NodeDirHandle.open(fixturePath(name)))));
}

/** The `TAG_FMT` line git printed for this tag (a lightweight tag has an empty `*objectname`). */
function asGit(t: TagInfo): string {
  return `${t.fullName} ${t.annotated ? "tag" : "commit"} ${t.oid} ${t.annotated ? t.targetOid : ""}`;
}

describe("listTags", () => {
  for (const fixture of ["tags", "history"]) {
    test(`${fixture} equals git tag -l`, async () => {
      const tags = await tagsOf(fixture);
      expect(tags.map(asGit)).toEqual(loadExpectedLines(fixture, "tag-list"));
    });
  }

  test("annotated tags carry the message and the tagger; lightweight ones do not", async () => {
    const tags = await tagsOf("tags");
    const annotated = tags.find((t) => t.name === "v1.0.0") as TagInfo;
    expect(annotated.annotated).toBe(true);
    expect(annotated.oid).not.toBe(annotated.targetOid); // the tag object, then the commit
    expect(annotated.message).toContain("annotated release 1.0.0");
    expect(annotated.tagger).toMatchObject({ name: "test", email: "test@example.com" });
    // milliseconds, like every other timestamp crossing the worker boundary
    expect(annotated.timestamp).toBe(annotated.tagger?.timestamp as number);
    expect(annotated.timestamp).toBeGreaterThan(1e12);

    const lightweight = tags.find((t) => t.name === "v0.1.0") as TagInfo;
    expect(lightweight.annotated).toBe(false);
    expect(lightweight.oid).toBe(lightweight.targetOid);
    expect(lightweight.message).toBeUndefined();
    expect(lightweight.tagger).toBeUndefined();
  });

  test("a repository without tags lists nothing", async () => {
    expect(await tagsOf("basic")).toEqual([]);
  });
});
