import { describe, expect, test } from "bun:test";
import { type ExpectedCheckIgnore, fixturePath, loadExpected } from "../../test/fixtures";
import { spyHandle } from "../../test/spyHandle";
import { createFsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { loadGitConfig, parseGitConfig } from "./config";
import { IgnoreRules } from "./ignoreRules";

async function memRules(
  files: Record<string, string>,
  opts: { builtinExcludes?: boolean; configText?: string } = {},
) {
  const fs = createFsaFs(
    MemoryFs.fromEntries({ ".git/HEAD": "ref: refs/heads/main\n", ...files }).handle(),
  );
  return IgnoreRules.load(fs, {
    builtinExcludes: opts.builtinExcludes ?? false,
    config: parseGitConfig(opts.configText ?? ""),
  });
}

describe("IgnoreRules parity with git check-ignore (fixture ignore)", () => {
  test("every probe in check-ignore.json matches", async () => {
    const fs = createFsaFs(await NodeDirHandle.open(fixturePath("ignore")));
    const rules = await IgnoreRules.load(fs, {
      builtinExcludes: false,
      config: await loadGitConfig(fs),
    });
    const expected = loadExpected<ExpectedCheckIgnore[]>("ignore", "check-ignore");
    expect(expected.length).toBeGreaterThan(10);
    for (const probe of expected) {
      const isDir = probe.path.endsWith("/");
      const path = probe.path.replace(/\/$/, "");
      const got = await rules.isPathIgnored(path, isDir ? "directory" : "file");
      expect([probe.path, got]).toEqual([probe.path, probe.ignored]);
    }
  });

  test("node_modules is pruned without touching anything inside it", async () => {
    const spy = spyHandle(await NodeDirHandle.open(fixturePath("ignore")));
    const fs = createFsaFs(spy);
    const rules = await IgnoreRules.load(fs, { builtinExcludes: false });
    const before = { ...spy.counts };
    expect(rules.isDirIgnored("node_modules")).toBe(true);
    expect(rules.isFileIgnored("node_modules/pkg/index.js")).toBe(true);
    expect(spy.counts.getDirectoryHandle).toBe(before.getDirectoryHandle);
    expect(spy.counts.getFileHandle).toBe(before.getFileHandle);
    expect(spy.counts.entries).toBe(before.entries);
  });
});

describe("IgnoreRules semantics", () => {
  test("anchored vs unanchored patterns, re-rooted per directory", async () => {
    const r = await memRules({
      ".gitignore": "/root-only.txt\nanywhere.txt\nbuild/\nsub/inner.txt\n",
      "src/.gitignore": "/local.txt\nlogs\n",
    });
    expect(await r.isPathIgnored("root-only.txt", "file")).toBe(true);
    expect(await r.isPathIgnored("src/root-only.txt", "file")).toBe(false); // anchored to root
    expect(await r.isPathIgnored("deep/er/anywhere.txt", "file")).toBe(true);
    expect(await r.isPathIgnored("sub/inner.txt", "file")).toBe(true);
    expect(await r.isPathIgnored("x/sub/inner.txt", "file")).toBe(false); // middle slash anchors
    expect(await r.isPathIgnored("src/local.txt", "file")).toBe(true);
    expect(await r.isPathIgnored("src/nested/local.txt", "file")).toBe(false); // anchored to src/
    expect(await r.isPathIgnored("local.txt", "file")).toBe(false);
    expect(await r.isPathIgnored("src/logs", "directory")).toBe(true);
    expect(await r.isPathIgnored("src/a/logs", "file")).toBe(true); // unanchored: any depth below src
    expect(await r.isPathIgnored("logs", "directory")).toBe(false);
  });

  test("dir-only patterns, ** globs, escaped #, comments and blank lines", async () => {
    const r = await memRules({
      ".gitignore": "# comment\n\nbuild/\n**/generated/**\n\\#literal.txt\n*.log\ndoc/**/*.pdf\n",
    });
    expect(await r.isPathIgnored("build", "directory")).toBe(true);
    expect(await r.isPathIgnored("build", "file")).toBe(false); // trailing slash = directories only
    expect(await r.isPathIgnored("a/generated/b/c.txt", "file")).toBe(true);
    expect(await r.isPathIgnored("#literal.txt", "file")).toBe(true);
    expect(await r.isPathIgnored("x/y.log", "file")).toBe(true);
    expect(await r.isPathIgnored("doc/a/b/c.pdf", "file")).toBe(true);
    expect(await r.isPathIgnored("doc/c.pdf", "file")).toBe(true);
    expect(await r.isPathIgnored("other/c.pdf", "file")).toBe(false);
  });

  test("negation: deeper file wins; last rule wins; cannot re-include inside an ignored dir", async () => {
    const r = await memRules({
      ".gitignore": "*.log\nvendor/\n!keep-root.log\n",
      "src/.gitignore": "!keep.log\n",
      "vendor/.gitignore": "!important.txt\n",
    });
    expect(await r.isPathIgnored("a.log", "file")).toBe(true);
    expect(await r.isPathIgnored("keep-root.log", "file")).toBe(false);
    expect(await r.isPathIgnored("src/keep.log", "file")).toBe(false);
    expect(await r.isPathIgnored("src/other.log", "file")).toBe(true);
    expect(await r.isPathIgnored("vendor/important.txt", "file")).toBe(true); // parent dir ignored
    expect(await r.isPathIgnored("vendor", "directory")).toBe(true);
  });

  test(".git/info/exclude has lowest file precedence; built-ins below it", async () => {
    const r = await memRules({
      ".git/info/exclude": "secret.txt\n*.tmp\n",
      ".gitignore": "!keep.tmp\n",
    });
    expect(await r.isPathIgnored("secret.txt", "file")).toBe(true);
    expect(await r.isPathIgnored("a.tmp", "file")).toBe(true);
    expect(await r.isPathIgnored("keep.tmp", "file")).toBe(false);
    expect(await r.isPathIgnored(".DS_Store", "file")).toBe(false); // builtins off
    const withBuiltins = await memRules(
      { ".gitignore": "!.DS_Store\n" },
      { builtinExcludes: true },
    );
    expect(await withBuiltins.isPathIgnored("Thumbs.db", "file")).toBe(true);
    expect(await withBuiltins.isPathIgnored("x/._hidden", "file")).toBe(true);
    expect(await withBuiltins.isPathIgnored(".DS_Store", "file")).toBe(false); // .gitignore negation beats builtin
  });

  test("core.ignorecase controls case sensitivity", async () => {
    const sensitive = await memRules({ ".gitignore": "Build/\n" });
    expect(await sensitive.isPathIgnored("build", "directory")).toBe(false);
    const insensitive = await memRules(
      { ".gitignore": "Build/\n" },
      { configText: "[core]\n\tignorecase = true\n" },
    );
    expect(await insensitive.isPathIgnored("build", "directory")).toBe(true);
  });

  test("core.excludesFile → one GLOBAL_EXCLUDES_UNAVAILABLE warning", async () => {
    const r = await memRules({}, { configText: "[core]\n\texcludesfile = ~/.gitignore_global\n" });
    expect(r.warnings.map((w) => w.code)).toEqual(["GLOBAL_EXCLUDES_UNAVAILABLE"]);
    expect((await memRules({})).warnings).toEqual([]);
  });

  test("invalidate + reload picks up edited rules", async () => {
    const mem = MemoryFs.fromEntries({ ".git/HEAD": "x", ".gitignore": "a.txt\n" });
    const r = await IgnoreRules.load(createFsaFs(mem.handle()), { builtinExcludes: false });
    expect(r.isFileIgnored("a.txt")).toBe(true);
    mem.write(".gitignore", "b.txt\n");
    expect(r.isFileIgnored("a.txt")).toBe(true); // cached
    await r.reload();
    expect(r.isFileIgnored("a.txt")).toBe(false);
    expect(r.isFileIgnored("b.txt")).toBe(true);
  });
});
