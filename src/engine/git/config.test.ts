import { describe, expect, test } from "bun:test";
import { fixturePath } from "../../test/fixtures";
import { createFsaFs } from "../fs/fsaFs";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { loadGitConfig, parseGitConfig } from "./config";

describe("parseGitConfig", () => {
  test("sections, subsections, case rules, bare keys, comments", () => {
    const c = parseGitConfig(`
# comment
; another
[Core]
\tRepositoryFormatVersion = 0
\tbare
\tautocrlf = TRUE   # trailing comment
[remote "Origin"]
\turl = https://example.com/x.git ; comment
\tfetch = +refs/heads/*:refs/remotes/Origin/*
[branch "main"]
\tremote = Origin
[Diff]
\trenameLimit = 2500
\trenames = copies
`);
    expect(c.get("core", "repositoryformatversion")).toBe("0");
    expect(c.get("CORE", "Bare")).toBe("true");
    expect(c.core.autocrlf).toBe("true");
    expect(c.remotes).toEqual(["Origin"]);
    expect(c.remoteUrls.Origin).toBe("https://example.com/x.git");
    expect(c.get("remote", "url", "Origin")).toBe("https://example.com/x.git");
    expect(c.get("remote", "url", "origin")).toBeUndefined(); // subsections are case-sensitive
    expect(c.diff).toEqual({ renameLimit: 2500, renames: true });
  });

  test("quoted values, escapes, inline # inside quotes, continuation lines", () => {
    const c = parseGitConfig(`[alias]
\tlg = "log --graph # not a comment" ; real comment
\tesc = "a\\"b\\\\c\\n"
\tcont = first \\
second \\
third
[user]
\tname = "  padded  "
`);
    expect(c.get("alias", "lg")).toBe("log --graph # not a comment");
    expect(c.get("alias", "esc")).toBe('a"b\\c\n');
    expect(c.get("alias", "cont")).toBe("first second third");
    expect(c.get("user", "name")).toBe("  padded  ");
  });

  test("deprecated [section.sub] syntax and subsection escapes", () => {
    const c = parseGitConfig(`[Remote.Upstream]\n\turl = u\n[remote "we\\"ird"]\n\turl = w\n`);
    expect(c.get("remote", "url", "upstream")).toBe("u");
    expect(c.remotes).toEqual(["upstream", 'we"ird']);
    expect(c.get("remote", "url", 'we"ird')).toBe("w");
  });

  test("include/includeIf are skipped with one warning", () => {
    const c = parseGitConfig(
      `[include]\n\tpath = ~/.gitconfig.local\n[includeIf "gitdir:~/work/"]\n\tpath = work.inc\n[core]\n\tsymlinks = false\n`,
    );
    expect(c.warnings.map((w) => w.code)).toEqual(["CONFIG_INCLUDE_SKIPPED"]);
    expect(c.core.symlinks).toBe(false);
  });

  test("autocrlf input, ignoreCase, excludesFile, extensions", () => {
    const c = parseGitConfig(
      `[core]\n\tautocrlf = input\n\tignorecase = yes\n\texcludesfile = /home/u/.gitignore\n[extensions]\n\tobjectFormat = SHA256\n\tpartialClone = origin\n\trefStorage = reftable\n`,
    );
    expect(c.core).toEqual({
      autocrlf: "input",
      ignoreCase: true,
      excludesFile: "/home/u/.gitignore",
    });
    expect(c.extensions).toEqual({
      objectFormat: "sha256",
      partialClone: "origin",
      refStorage: "reftable",
    });
  });

  test("empty and garbage input do not throw", () => {
    expect(parseGitConfig("").remotes).toEqual([]);
    expect(parseGitConfig("key = value before any section\n[x]\n=bad\n").raw).toEqual({ x: {} });
  });
});

describe("loadGitConfig on fixtures", () => {
  async function load(name: string) {
    return loadGitConfig(createFsaFs(await NodeDirHandle.open(fixturePath(name))));
  }
  test("crlf fixture has core.autocrlf = true", async () => {
    expect((await load("crlf")).core.autocrlf).toBe("true");
  });
  test("remote fixture lists origin with its url", async () => {
    const c = await load("remote");
    expect(c.remotes).toEqual(["origin"]);
    expect(c.remoteUrls.origin).toContain("_remotes/basic.git");
  });
  test("basic fixture has no remotes and no autocrlf", async () => {
    const c = await load("basic");
    expect(c.remotes).toEqual([]);
    expect(c.core.autocrlf).toBeUndefined();
  });
  test("partial fixture exposes the promisor remote; sha256 fixture exposes objectFormat", async () => {
    const p = await load("partial");
    expect(p.get("remote", "promisor", "origin")).toBe("true");
    expect(p.get("remote", "partialclonefilter", "origin")).toBe("blob:none");
    const s = await load("sha256");
    expect(s.extensions.objectFormat).toBe("sha256");
  });
  test("missing .git/config yields an empty config", async () => {
    const { MemoryFs } = await import("../fs/memoryDirHandle");
    const fs = createFsaFs(
      MemoryFs.fromEntries({ ".git/HEAD": "ref: refs/heads/main\n" }).handle(),
    );
    expect((await loadGitConfig(fs)).remotes).toEqual([]);
  });
});
