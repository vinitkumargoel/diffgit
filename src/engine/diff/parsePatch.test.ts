/**
 * T10.12 — `parsePatch`: a unified diff back into diff rows (atlas tab 17, Design §14.6).
 *
 * Three kinds of evidence:
 *
 *  1. **Round trip.** `parsePatch(patchText(<fixture>))` must reproduce the file set, the statuses,
 *     the rename similarities and the hunk geometry of the rows `RepoSession` computed. That is the
 *     acceptance test the task names, and it runs over every fixture shape the writer can produce —
 *     renames, binary rows, a >10 MB row with its `# diffgit:` note, a missing final newline, CRLF.
 *  2. **git's own output.** The same assertion against `git diff` text rather than ours, so the
 *     parser is not merely the inverse of one writer. `git format-patch` (mail header, diffstat,
 *     signature) and a plain `diff -u` with timestamps are parsed too.
 *  3. **Unit cases** for the shapes no fixture produces: `/dev/null` sides, `copy from`/`copy to`,
 *     `quote_c_style` paths, `\ No newline at end of file`, and the garbage that must be
 *     `NOT_A_PATCH` with the first bad line in `detail`.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath } from "../../test/fixtures";
import type { HunkModel, ProgressSink } from "../api";
import { defaultDiffSource } from "../diffSource";
import { errorCode } from "../errors";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { PatchSession } from "../patchSession";
import { RepoSession } from "../session";
import type { FileDiff } from "../types";
import { parsePatch, patchLines, unquotePath } from "./parsePatch";

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const HAS_GIT = Bun.spawnSync(["git", "--version"], { env: GIT_ENV }).exitCode === 0;
if (!HAS_GIT) {
  console.warn("T10.12: skipping the `git diff` parsing tests — `git` is not on PATH.");
}
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** `id status similarity` per row, the identity a round trip has to preserve. */
function shape(files: FileDiff[]): string[] {
  return files.map((f) => `${f.id} ${f.status} ${f.similarity ?? "-"}`);
}

/** `oldStart,oldCount,newStart,newCount,lines` per hunk. */
function geometry(model: HunkModel | undefined): string[] {
  return (model?.hunks ?? []).map(
    (h) => `${h.oldStart},${h.oldCount},${h.newStart},${h.newCount},${h.lines.length}`,
  );
}

async function computeAndRender(name: string) {
  const session = await RepoSession.open(await NodeDirHandle.open(fixturePath(name)), quietSink, {
    id: `t10-12-${name}`,
  });
  const info = await session.info();
  const result = await session.computeDiff(defaultDiffSource(info));
  const text = await session.patchText(result.generation, null);
  const hunks: Record<string, HunkModel | null> = {};
  for (const f of result.files) {
    hunks[f.id] = (
      await session.fileDiff(result.generation, f.id, {
        ignoreWhitespace: false,
        loadLarge: true,
      })
    ).hunks;
  }
  await session.close();
  return { files: result.files, text, hunks };
}

describe("parsePatch round-trips patchText", () => {
  // `basic` and `renames` are the two the task names; the rest cover the writer's other forms.
  for (const name of ["basic", "renames", "binary", "worktree", "crlf", "large", "symlink"]) {
    test(`${name}: same file set, statuses, similarity and hunk counts`, async () => {
      const { files, text, hunks } = await computeAndRender(name);
      const parsed = parsePatch(text);
      expect(shape(parsed.files)).toEqual(shape(files));
      for (const f of files) {
        const original = hunks[f.id];
        if (!original || original.hunks.length === 0) continue;
        expect(geometry(parsed.hunks[f.id])).toEqual(geometry(original));
      }
      expect(parsed.stats.files).toBe(files.length);
      expect(parsed.warnings.map((w) => w.code)).toEqual(["PATCH_ONLY"]);
    });
  }

  test("renames keep their similarity index and both paths", async () => {
    const { files, text } = await computeAndRender("renames");
    const parsed = parsePatch(text);
    const renames = parsed.files.filter((f) => f.status === "renamed");
    expect(renames.length).toBeGreaterThan(0);
    for (const r of renames) {
      const original = files.find((f) => f.id === r.id) as FileDiff;
      expect(r.oldPath).toBe(original.oldPath);
      expect(r.newPath).toBe(original.newPath);
      expect(r.similarity).toBe(original.similarity as number);
    }
  });

  test("a 10 MB row survives its `# diffgit:` note and stays binary", async () => {
    const { text } = await computeAndRender("large");
    expect(text).toContain("# diffgit: huge.txt is larger than 10 MB");
    const huge = parsePatch(text).files.find((f) => f.id === "huge.txt");
    expect(huge?.binary).toBe(true);
    expect(huge?.stats).toBeNull();
  });

  test("the result is structured-cloneable", async () => {
    const { text } = await computeAndRender("basic");
    const parsed = parsePatch(text);
    expect(structuredClone(parsed)).toEqual(parsed);
  });
});

describe.if(HAS_GIT)("parsePatch reads git's own output", () => {
  for (const [name, args] of [
    ["basic", ["main...feature"]],
    ["renames", ["-M", "main...feature"]],
    ["binary", ["main...feature"]],
    ["crlf", ["main...feature"]],
    ["attributes", ["main...feature"]],
    ["submodule", ["main...feature"]],
  ] as [string, string[]][]) {
    test(`${name}: every path git names is a row`, () => {
      const dir = fixturePath(name);
      const text = git(dir, "diff", "--full-index", ...args);
      const parsed = parsePatch(text);
      const expected = git(dir, "diff", "--name-only", ...args)
        .split("\n")
        .filter((l) => l.length > 0)
        .sort();
      expect(parsed.files.map((f) => f.id).sort()).toEqual(expected);
    });
  }

  test("a symlink → regular file pair is folded into one typechange row", () => {
    const parsed = parsePatch(git(fixturePath("symlink"), "diff", "main...feature"));
    const row = parsed.files.filter((f) => f.id === "link2");
    expect(row).toHaveLength(1);
    expect(row[0]?.status).toBe("typechange");
    expect(row[0]?.oldMode).toBe(0o120000);
    expect(row[0]?.newMode).toBe(0o100644);
  });

  test("`git format-patch` output parses past the mail header and the signature", () => {
    const text = git(fixturePath("basic"), "format-patch", "--stdout", "-1", "feature");
    expect(text).toContain("Subject:");
    expect(text).toContain("\n-- \n");
    const parsed = parsePatch(text);
    expect(parsed.files.map((f) => f.id).sort()).toEqual(["docs/guide.md", "lib/util.txt"]);
  });

  test("hunk geometry matches git's own `@@` headers", () => {
    const text = git(fixturePath("basic"), "diff", "main...feature");
    const parsed = parsePatch(text);
    const headers = text.split("\n").filter((l) => l.startsWith("@@ "));
    const ours = parsed.files.flatMap((f) =>
      (parsed.hunks[f.id] as HunkModel).hunks.map((h) => {
        const o = h.oldCount === 1 ? `${h.oldStart}` : `${h.oldStart},${h.oldCount}`;
        const n = h.newCount === 1 ? `${h.newStart}` : `${h.newStart},${h.newCount}`;
        return `@@ -${o} +${n} @@`;
      }),
    );
    expect(headers.map((h) => h.slice(0, h.indexOf("@@", 3) + 2))).toEqual(ours);
  });
});

describe("parsePatch header forms", () => {
  test("a plain `diff -u` with timestamps", () => {
    const text = [
      "--- a.txt\t2026-09-19 09:16:47",
      "+++ b.txt\t2026-09-19 09:16:47",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+2",
      " three",
      "+four",
      "",
    ].join("\n");
    const parsed = parsePatch(text);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.oldPath).toBe("a.txt");
    expect(parsed.files[0]?.newPath).toBe("b.txt");
    expect(parsed.files[0]?.stats).toEqual({ additions: 2, deletions: 1 });
    expect(parsed.stats).toEqual({ files: 1, additions: 2, deletions: 1 });
  });

  test("a plain diff keeps a directory component (no `a/` prefix to strip)", () => {
    const text = ["--- src/old.txt", "+++ src/new.txt", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const parsed = parsePatch(text);
    expect(parsed.files[0]?.oldPath).toBe("src/old.txt");
    expect(parsed.files[0]?.newPath).toBe("src/new.txt");
  });

  test("`--- /dev/null` is an addition and `+++ /dev/null` a deletion", () => {
    const added = parsePatch(
      ["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+one", "+two", ""].join("\n"),
    );
    expect(added.files[0]).toMatchObject({
      id: "new.txt",
      oldPath: null,
      newPath: "new.txt",
      status: "added",
    });
    const deleted = parsePatch(
      ["--- a/gone.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-one", "-two", ""].join("\n"),
    );
    expect(deleted.files[0]).toMatchObject({
      id: "gone.txt",
      oldPath: "gone.txt",
      newPath: null,
      status: "deleted",
    });
  });

  test("mode-only changes, copies and dissimilarity", () => {
    const text = [
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/one.txt b/two.txt",
      "similarity index 88%",
      "copy from one.txt",
      "copy to two.txt",
      "diff --git a/rewrite.txt b/rewrite.txt",
      "dissimilarity index 97%",
      "",
    ].join("\n");
    const parsed = parsePatch(text);
    expect(parsed.files.map((f) => [f.id, f.status])).toEqual([
      ["run.sh", "modified"],
      ["two.txt", "copied"],
      ["rewrite.txt", "modified"],
    ]);
    expect(parsed.files[0]?.oldMode).toBe(0o100644);
    expect(parsed.files[0]?.newMode).toBe(0o100755);
    expect(parsed.files[1]?.similarity).toBe(88);
    expect(parsed.files[2]?.similarity).toBe(3);
  });

  test("binary rows carry no stats, in both git spellings", () => {
    const stub = parsePatch(
      [
        "diff --git a/img/logo.png b/img/logo.png",
        "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
        "Binary files a/img/logo.png and b/img/logo.png differ",
        "",
      ].join("\n"),
    );
    expect(stub.files[0]).toMatchObject({ id: "img/logo.png", binary: true, stats: null });
    expect(stub.files[0]?.image).toBe(true);
    const literal = parsePatch(
      [
        "diff --git a/data/blob.bin b/data/blob.bin",
        "index 1111111..2222222 100644",
        "GIT binary patch",
        "literal 12",
        "zcmZQzU|?VZV9;",
        "",
        "literal 8",
        "zcmZQzU|",
        "",
        "diff --git a/after.txt b/after.txt",
        "--- a/after.txt",
        "+++ b/after.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
    expect(literal.files.map((f) => f.id)).toEqual(["data/blob.bin", "after.txt"]);
    expect(literal.files[0]?.binary).toBe(true);
  });

  test("`\\ No newline at end of file` does not count as a hunk line", () => {
    const parsed = parsePatch(
      [
        "diff --git a/n.txt b/n.txt",
        "--- a/n.txt",
        "+++ b/n.txt",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-last",
        "\\ No newline at end of file",
        "+last line",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    const hunk = (parsed.hunks["n.txt"] as HunkModel).hunks[0];
    expect(hunk?.lines.map((l) => l.type)).toEqual(["ctx", "del", "add"]);
    expect(parsed.files[0]?.stats).toEqual({ additions: 1, deletions: 1 });
  });

  test("quoted paths are unescaped", () => {
    expect(unquotePath('"src/caf\\303\\251.txt"')).toBe("src/café.txt");
    expect(unquotePath('"a\\tb"')).toBe("a\tb");
    expect(unquotePath("plain.txt")).toBe("plain.txt");
    const parsed = parsePatch(
      [
        'diff --git "a/src/caf\\303\\251.txt" "b/src/caf\\303\\251.txt"',
        '--- "a/src/caf\\303\\251.txt"',
        '+++ "b/src/caf\\303\\251.txt"',
        "@@ -1 +1 @@",
        "-un",
        "+deux",
        "",
      ].join("\n"),
    );
    expect(parsed.files[0]?.id).toBe("src/café.txt");
  });

  test("a path with a space splits at the midpoint of `a/X b/X`", () => {
    const parsed = parsePatch(
      [
        "diff --git a/my file.txt b/my file.txt",
        "--- a/my file.txt",
        "+++ b/my file.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
    expect(parsed.files[0]?.id).toBe("my file.txt");
  });

  test("CRLF terminators are stripped, a CRLF file's content is not", () => {
    const crlf = ["--- a/x.txt", "+++ b/x.txt", "@@ -1 +1 @@", "-a", "+b", ""].join("\r\n");
    expect(patchLines(crlf).some((l) => l.endsWith("\r"))).toBe(false);
    expect(parsePatch(crlf).files[0]?.id).toBe("x.txt");
    // A patch *of* a CRLF file: only the structural lines end in CR, the content keeps its own.
    const ofCrlf = [
      "--- a/dos.txt",
      "+++ b/dos.txt",
      "@@ -1 +1 @@",
      "-line one\r",
      "+line two\r",
      "",
    ].join("\n");
    const hunk = (parsePatch(ofCrlf).hunks["dos.txt"] as HunkModel).hunks[0];
    expect(hunk?.lines.map((l) => l.text)).toEqual(["line one\r", "line two\r"]);
  });

  test("rows are `committed`, sizes are 0 and nothing is gated", () => {
    const parsed = parsePatch(
      ["--- a/x.txt", "+++ b/x.txt", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
    );
    expect(parsed.files[0]?.layers).toEqual(["committed"]);
    expect(parsed.files[0]?.oldSize).toBe(0);
    expect(parsed.files[0]?.newSize).toBe(0);
    expect(parsed.files[0]?.tooLarge).toBe(false);
  });
});

describe("parsePatch rejects garbage", () => {
  function codeAndDetail(text: string): { code: string; detail: string } {
    try {
      parsePatch(text);
    } catch (e) {
      return { code: errorCode(e) as string, detail: (e as { detail: string }).detail };
    }
    throw new Error("expected NOT_A_PATCH");
  }

  test("prose is NOT_A_PATCH, pointing at the first line", () => {
    const { code, detail } = codeAndDetail("Hello, this is a bug report.\nNot a patch.\n");
    expect(code).toBe("NOT_A_PATCH");
    expect(detail).toStartWith("line 1:");
    expect(detail).toContain("Hello");
  });

  test("an empty file is NOT_A_PATCH", () => {
    expect(codeAndDetail("").code).toBe("NOT_A_PATCH");
  });

  test("a truncated hunk names the `@@` line", () => {
    const { code, detail } = codeAndDetail(
      ["--- a/x.txt", "+++ b/x.txt", "@@ -1,5 +1,5 @@", " one", "-two", "+2", ""].join("\n"),
    );
    expect(code).toBe("NOT_A_PATCH");
    expect(detail).toStartWith("line 3:");
  });

  test("a stray line inside a hunk names that line", () => {
    const { code, detail } = codeAndDetail(
      [
        "--- a/x.txt",
        "+++ b/x.txt",
        "@@ -1,3 +1,3 @@",
        " one",
        "OOPS not a hunk line",
        " three",
        "",
      ].join("\n"),
    );
    expect(code).toBe("NOT_A_PATCH");
    expect(detail).toStartWith("line 5:");
  });

  test("a binary file is NOT_A_PATCH rather than a crash", () => {
    const bytes = String.fromCharCode(...Array.from({ length: 64 }, (_, i) => (i * 7) % 256));
    expect(codeAndDetail(bytes).code).toBe("NOT_A_PATCH");
  });
});

describe("PatchSession answers without a repository", () => {
  test("parses, warns PATCH_ONLY and needs no handle", async () => {
    const result = await new PatchSession().parse(
      ["--- a/x.txt", "+++ b/x.txt", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
    );
    expect(result.files.map((f) => f.id)).toEqual(["x.txt"]);
    expect(result.warnings.map((w) => w.code)).toEqual(["PATCH_ONLY"]);
  });

  test("a newer parse supersedes the older one with CANCELLED", async () => {
    const session = new PatchSession();
    const good = ["--- a/x.txt", "+++ b/x.txt", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const first = session.parse(good);
    const second = session.parse(good);
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await second).files).toHaveLength(1);
  });

  test("NOT_A_PATCH still crosses the boundary from the session", async () => {
    await expect(new PatchSession().parse("nope\n")).rejects.toMatchObject({
      code: "NOT_A_PATCH",
    });
  });
});
