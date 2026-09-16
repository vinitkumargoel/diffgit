import { describe, expect, test } from "bun:test";
import { openEngine } from "../../test/engineRig";
import { createFsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { compilePattern, GitAttributes, parseAttributes } from "./attributes";

const m = (pattern: string, path: string) => compilePattern(pattern)?.(path) ?? false;

describe("gitattributes patterns", () => {
  test("basename patterns match at any depth; anchored ones only from the file's directory", () => {
    expect(m("*.dat", "data.dat")).toBe(true);
    expect(m("*.dat", "a/b/data.dat")).toBe(true);
    expect(m("*.dat", "data.dat.bak")).toBe(false);
    expect(m("/data.dat", "data.dat")).toBe(true);
    expect(m("/data.dat", "a/data.dat")).toBe(false);
    expect(m("src/*.js", "src/a.js")).toBe(true);
    expect(m("src/*.js", "src/sub/a.js")).toBe(false);
    expect(m("src/**", "src/sub/a.js")).toBe(true);
    expect(m("src/**", "src")).toBe(false);
    expect(m("**/vendor/*.js", "vendor/x.js")).toBe(true);
    expect(m("**/vendor/*.js", "a/b/vendor/x.js")).toBe(true);
    expect(m("a/**/z.txt", "a/z.txt")).toBe(true);
    expect(m("a/**/z.txt", "a/b/c/z.txt")).toBe(true);
    expect(m("?.txt", "a.txt")).toBe(true);
    expect(m("?.txt", "ab.txt")).toBe(false);
    expect(m("[abc].txt", "b.txt")).toBe(true);
    expect(m("[!abc].txt", "b.txt")).toBe(false);
    expect(m("[[:digit:]].txt", "7.txt")).toBe(true);
    expect(m("a\\*b", "a*b")).toBe(true);
    expect(m("a\\*b", "axb")).toBe(false);
  });

  test("a pattern matching a directory does not match its contents; negation is rejected", () => {
    expect(m("generated", "generated/out.js")).toBe(false);
    expect(m("generated/", "generated/out.js")).toBe(false);
    expect(compilePattern("!x.txt")).toBeNull();
    expect(m("\\!x.txt", "!x.txt")).toBe(true);
  });

  test("attribute tokens, macros and quoted patterns", () => {
    const rules = parseAttributes(
      [
        "# comment",
        "[attr]gen linguist-generated -diff",
        "*.dat binary",
        '"with space.txt" text=auto eol=lf',
        "*.lock -diff !merge",
        "out/** gen",
      ].join("\n"),
    );
    expect(rules).toHaveLength(4);
    const attrsOf = (p: string) =>
      Object.fromEntries(rules.filter((r) => r.match(p)).flatMap((r) => r.attrs));
    expect(attrsOf("a.dat")).toEqual({ diff: false, merge: false, text: false, binary: true });
    expect(attrsOf("with space.txt")).toEqual({ text: "auto", eol: "lf" });
    expect(attrsOf("deps.lock")).toEqual({ diff: false, merge: { unspecified: true } });
    expect(attrsOf("out/x.js")).toEqual({ "linguist-generated": true, diff: false, gen: true });
  });
});

describe("GitAttributes lookup", () => {
  test("attributes fixture: binary via `binary`/-diff, generated via linguist-generated and -diff", async () => {
    const rig = await openEngine("attributes");
    const attrs = await GitAttributes.load(rig.fs);
    expect(await attrs.isBinary("data.dat")).toBe(true);
    expect(await attrs.isBinary("deps.lock")).toBe(true);
    expect(await attrs.isBinary("notes.txt")).toBe(false);
    expect(await attrs.isBinary("generated/out.js")).toBe(false);
    expect(await attrs.isGenerated("generated/out.js")).toBe(true);
    expect(await attrs.isGenerated("deps.lock")).toBe(true);
    expect(await attrs.isGenerated("notes.txt")).toBe(false);
    expect((await attrs.attributesFor("notes.txt")).get("text")).toBe(true);
  });

  test("precedence: deeper .gitattributes overrides root, info/attributes overrides everything", async () => {
    const mem = MemoryFs.fromEntries({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/info/attributes": "sub/keep.js diff\n",
      ".gitattributes": "*.js -diff\n*.md linguist-generated\n",
      "sub/.gitattributes": "*.js diff=javascript\n*.md -linguist-generated\nlocal.js -diff\n",
      "sub/a.js": "x",
    });
    const fs = createFsaFs(mem.handle("repo"));
    const attrs = await GitAttributes.load(fs);
    expect(await attrs.isBinary("root.js")).toBe(true);
    expect(await attrs.isBinary("sub/a.js")).toBe(false); // diff=<driver> → text
    expect((await attrs.attributesFor("sub/a.js")).get("diff")).toBe("javascript");
    expect(await attrs.isBinary("sub/local.js")).toBe(true); // later line in the same file wins
    expect(await attrs.isBinary("sub/keep.js")).toBe(false); // info/attributes wins over sub/
    expect(await attrs.isGenerated("README.md")).toBe(true);
    expect(await attrs.isGenerated("sub/README.md")).toBe(false);
    mem.apply([{ op: "write", path: ".gitattributes", text: "*.js diff\n", mtime: 1 }]);
    expect(await attrs.isBinary("root.js")).toBe(true); // cached until reload
    await attrs.reload();
    expect(await attrs.isBinary("root.js")).toBe(false);
  });

  test("repos without any attributes file behave as unspecified", async () => {
    const rig = await openEngine("basic");
    const attrs = await GitAttributes.load(rig.fs);
    expect(await attrs.isBinary("README.md")).toBe(false);
    expect(await attrs.isGenerated("README.md")).toBe(false);
    expect((await attrs.attributesFor("src/a.txt")).size).toBe(0);
  });
});
