/**
 * T10.10 — the patch writer itself, from literal rows: every header form, the `/dev/null` sides,
 * the binary stub, the missing final newline and git's path quoting. The round-trip against `git
 * apply` lives in `src/engine/patchSummary.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { FileClassification, HunkModel } from "../api";
import type { FileDiff } from "../types";
import { hunkHeader, NULL_OID, type PatchRow, patchText, quotePath } from "./patchText";
import type { FileDescription } from "./textDiff";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function classification(over: Partial<FileClassification> = {}): FileClassification {
  return {
    binary: false,
    image: false,
    tooLarge: false,
    huge: false,
    typechange: false,
    submodule: false,
    generated: false,
    whitespaceOnly: false,
    oldSize: 0,
    newSize: 0,
    changedLines: null,
    ...over,
  };
}

function file(over: Partial<FileDiff> = {}): FileDiff {
  return {
    id: "a.txt",
    oldPath: "a.txt",
    newPath: "a.txt",
    status: "modified",
    layers: ["committed"],
    oldOid: OID_A,
    newOid: OID_B,
    oldMode: 0o100644,
    newMode: 0o100644,
    binary: false,
    image: false,
    oldSize: 0,
    newSize: 0,
    stats: null,
    tooLarge: false,
    ...over,
  };
}

function description(over: Partial<FileDescription> = {}): FileDescription {
  return {
    classification: classification(),
    hunks: { oldLines: 0, newLines: 0, hunks: [] },
    oldText: null,
    newText: null,
    stats: null,
    language: "text",
    ...over,
  };
}

/** One-line-in, one-line-out model: `old` → `new`. */
function oneLineChange(oldLine: string, newLine: string): HunkModel {
  return {
    oldLines: 1,
    newLines: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [
          { type: "del", old: 1, text: oldLine },
          { type: "add", new: 1, text: newLine },
        ],
      },
    ],
  };
}

function row(
  f: Partial<FileDiff>,
  d: Partial<FileDescription>,
  oids?: Partial<PatchRow>,
): PatchRow {
  return {
    file: file(f),
    description: description(d),
    oldOid: OID_A,
    newOid: OID_B,
    ...oids,
  };
}

describe("quotePath", () => {
  test("leaves ordinary and space-bearing paths alone", () => {
    expect(quotePath("src/a.txt")).toBe("src/a.txt");
    expect(quotePath("a/with space.txt")).toBe("a/with space.txt");
  });

  test("C-quotes the characters git C-quotes", () => {
    expect(quotePath('say "hi"')).toBe('"say \\"hi\\""');
    expect(quotePath("back\\slash")).toBe('"back\\\\slash"');
    expect(quotePath("tab\there")).toBe('"tab\\there"');
    expect(quotePath("nl\nhere")).toBe('"nl\\nhere"');
  });

  test("octal-escapes every non-ASCII byte, like core.quotepath", () => {
    // "é" is C3 A9 in UTF-8.
    expect(quotePath("café.txt")).toBe('"caf\\303\\251.txt"');
  });
});

describe("hunkHeader", () => {
  test("elides `,1` exactly where git does", () => {
    expect(hunkHeader({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] })).toBe(
      "@@ -1 +1 @@",
    );
    expect(hunkHeader({ oldStart: 3, oldCount: 0, newStart: 4, newCount: 2, lines: [] })).toBe(
      "@@ -3,0 +4,2 @@",
    );
  });
});

describe("patchText header forms", () => {
  test("no rows is the empty string", () => {
    expect(patchText([])).toBe("");
  });

  test("a modified file", () => {
    expect(patchText([row({}, { hunks: oneLineChange("old", "new") })])).toBe(
      "diff --git a/a.txt b/a.txt\n" +
        `index ${OID_A}..${OID_B} 100644\n` +
        "--- a/a.txt\n" +
        "+++ b/a.txt\n" +
        "@@ -1 +1 @@\n" +
        "-old\n" +
        "+new\n",
    );
  });

  test("an added file gets `new file mode` and a /dev/null old side", () => {
    const added = row(
      { status: "added", oldPath: null, oldOid: null, oldMode: null },
      {
        hunks: {
          oldLines: 0,
          newLines: 1,
          hunks: [
            {
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: 1,
              lines: [{ type: "add", new: 1, text: "hello" }],
            },
          ],
        },
      },
      { oldOid: null },
    );
    expect(patchText([added])).toBe(
      "diff --git a/a.txt b/a.txt\n" +
        "new file mode 100644\n" +
        `index ${NULL_OID}..${OID_B}\n` +
        "--- /dev/null\n" +
        "+++ b/a.txt\n" +
        "@@ -0,0 +1 @@\n" +
        "+hello\n",
    );
  });

  test("a deleted file gets `deleted file mode` and a /dev/null new side", () => {
    const deleted = row(
      { status: "deleted", newPath: null, newOid: null, newMode: null },
      {
        hunks: {
          oldLines: 1,
          newLines: 0,
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 0,
              newCount: 0,
              lines: [{ type: "del", old: 1, text: "bye" }],
            },
          ],
        },
      },
      { newOid: null },
    );
    expect(patchText([deleted])).toBe(
      "diff --git a/a.txt b/a.txt\n" +
        "deleted file mode 100644\n" +
        `index ${OID_A}..${NULL_OID}\n` +
        "--- a/a.txt\n" +
        "+++ /dev/null\n" +
        "@@ -1 +0,0 @@\n" +
        "-bye\n",
    );
  });

  test("a mode change alone stops after `new mode`, as git does", () => {
    expect(patchText([row({ newMode: 0o100755, newOid: OID_A }, {})])).toBe(
      "diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 100755\n",
    );
  });

  test("a mode change with content drops the mode suffix from the index line", () => {
    const patch = patchText([row({ newMode: 0o100755 }, { hunks: oneLineChange("old", "new") })]);
    expect(patch).toContain("old mode 100644\nnew mode 100755\n");
    expect(patch).toContain(`index ${OID_A}..${OID_B}\n--- a/a.txt\n`);
  });

  test("a 100% rename is similarity + rename lines only", () => {
    expect(
      patchText([
        row(
          {
            id: "new.txt",
            status: "renamed",
            oldPath: "old.txt",
            newPath: "new.txt",
            similarity: 100,
            newOid: OID_A,
          },
          {},
        ),
      ]),
    ).toBe(
      "diff --git a/old.txt b/new.txt\n" +
        "similarity index 100%\n" +
        "rename from old.txt\n" +
        "rename to new.txt\n",
    );
  });

  test("a partial rename carries its similarity index and its hunks", () => {
    const patch = patchText([
      row(
        {
          id: "new.txt",
          status: "renamed",
          oldPath: "old.txt",
          newPath: "new.txt",
          similarity: 74,
        },
        { hunks: oneLineChange("old", "new") },
      ),
    ]);
    expect(patch).toContain("similarity index 74%\nrename from old.txt\nrename to new.txt\n");
    expect(patch).toContain(`index ${OID_A}..${OID_B} 100644\n--- a/old.txt\n+++ b/new.txt\n`);
  });

  test("a copy is spelled `copy from` / `copy to`", () => {
    const patch = patchText([
      row(
        {
          id: "copy.txt",
          status: "copied",
          oldPath: "src.txt",
          newPath: "copy.txt",
          similarity: 90,
        },
        {},
      ),
    ]);
    expect(patch).toContain("copy from src.txt\ncopy to copy.txt\n");
  });

  test("a binary row is the stub, with /dev/null for an absent side", () => {
    const binary = row({ binary: true }, { classification: classification({ binary: true }) });
    expect(patchText([binary])).toBe(
      "diff --git a/a.txt b/a.txt\n" +
        `index ${OID_A}..${OID_B} 100644\n` +
        "Binary files a/a.txt and b/a.txt differ\n",
    );
    const addedBinary = row(
      { status: "added", oldPath: null, oldOid: null, oldMode: null, binary: true },
      { classification: classification({ binary: true }) },
      { oldOid: null },
    );
    expect(patchText([addedBinary])).toContain("Binary files /dev/null and b/a.txt differ\n");
  });

  test("a huge row is the stub plus a `#` note git's header scan skips", () => {
    const huge = row({}, { classification: classification({ huge: true, tooLarge: true }) });
    expect(patchText([huge])).toBe(
      "# diffgit: a.txt is larger than 10 MB; the patch records its object names only.\n" +
        "diff --git a/a.txt b/a.txt\n" +
        `index ${OID_A}..${OID_B} 100644\n` +
        "Binary files a/a.txt and b/a.txt differ\n",
    );
  });

  test("a binary row whose oids are equal carries no body", () => {
    const same = row(
      { newOid: OID_A, binary: true },
      { classification: classification({ binary: true }) },
      { newOid: OID_A },
    );
    expect(patchText([same])).toBe("diff --git a/a.txt b/a.txt\n");
  });

  test("an unhashed worktree side falls back to the null oid", () => {
    const patch = patchText([row({}, { hunks: oneLineChange("old", "new") }, { newOid: null })]);
    expect(patch).toContain(`index ${OID_A}..${NULL_OID} 100644\n`);
  });

  test("paths that need quoting are quoted in every place git quotes them", () => {
    const patch = patchText([
      row(
        {
          id: 'q "b".txt',
          status: "renamed",
          oldPath: 'q "a".txt',
          newPath: 'q "b".txt',
          similarity: 80,
        },
        { hunks: oneLineChange("old", "new") },
      ),
    ]);
    expect(patch).toContain('diff --git "a/q \\"a\\".txt" "b/q \\"b\\".txt"\n');
    expect(patch).toContain('rename from "q \\"a\\".txt"\nrename to "q \\"b\\".txt"\n');
    expect(patch).toContain('--- "a/q \\"a\\".txt"\n+++ "b/q \\"b\\".txt"\n');
  });
});

describe("patchText: missing final newline", () => {
  const model: HunkModel = {
    oldLines: 2,
    newLines: 2,
    hunks: [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "ctx", old: 1, new: 1, text: "keep" },
          { type: "del", old: 2, text: "old tail" },
          { type: "add", new: 2, text: "new tail" },
        ],
      },
    ],
  };

  test("marks the side that lacks it, and only that side", () => {
    expect(
      patchText([
        row({}, { hunks: model, oldText: "keep\nold tail", newText: "keep\nnew tail\n" }),
      ]),
    ).toContain("-old tail\n\\ No newline at end of file\n+new tail\n");
    expect(
      patchText([
        row({}, { hunks: model, oldText: "keep\nold tail\n", newText: "keep\nnew tail" }),
      ]),
    ).toContain("-old tail\n+new tail\n\\ No newline at end of file\n");
  });

  test("marks both sides when neither ends in a newline", () => {
    expect(
      patchText([row({}, { hunks: model, oldText: "keep\nold tail", newText: "keep\nnew tail" })]),
    ).toContain(
      "-old tail\n\\ No newline at end of file\n+new tail\n\\ No newline at end of file\n",
    );
  });

  test("a trailing context line that is last on both sides gets exactly one marker", () => {
    const ctxModel: HunkModel = {
      oldLines: 2,
      newLines: 2,
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 2,
          lines: [
            { type: "del", old: 1, text: "a" },
            { type: "add", new: 1, text: "b" },
            { type: "ctx", old: 2, new: 2, text: "tail" },
          ],
        },
      ],
    };
    const patch = patchText([row({}, { hunks: ctxModel, oldText: "a\ntail", newText: "b\ntail" })]);
    expect(patch.split("\\ No newline at end of file").length - 1).toBe(1);
    expect(patch).toContain(" tail\n\\ No newline at end of file\n");
  });
});
