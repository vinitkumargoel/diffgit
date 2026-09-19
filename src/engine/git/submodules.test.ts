/**
 * T10.12 — submodules (atlas tab 19).
 *
 * The oracle is `git submodule status` on `fixtures/submodule`, recorded by
 * `scripts/fixture-expectations.sh`. That fixture ends with `git submodule deinit -f sub`, so git
 * prints the `-<oid> sub` form — "recorded, never checked out" — which is precisely the state the
 * engine has to report as `checkedOut: null` instead of guessing.
 *
 * The checked-out half of the contract cannot be built by that fixture (a deinit'd submodule has no
 * `.git` at all), so it is exercised on an in-memory repository that reproduces git's real layout:
 * a `.git` *file* holding `gitdir: ../.git/modules/sub`, and the module directory's own `HEAD`,
 * loose ref and `packed-refs`.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedLines } from "../../test/fixtures";
import type { ProgressSink } from "../api";
import { createFsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { FlatTree } from "./objectDb";
import {
  checkedOutOid,
  listSubmodules,
  parseGitmodules,
  readHeadOid,
  resolveGitdirLine,
} from "./submodules";

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

/** `git submodule status`: `<prefix><oid> <path>[ (<describe>)]`, prefix `-` = not initialised. */
interface StatusRow {
  prefix: string;
  oid: string;
  path: string;
}
function gitSubmoduleStatus(): StatusRow[] {
  return loadExpectedLines("submodule", "submodule-status").map((line) => {
    const m = /^([-+U ]?)([0-9a-f]{40}) (\S+)/.exec(line);
    if (!m) throw new Error(`submodule-status.txt: unparsed ${JSON.stringify(line)}`);
    return { prefix: m[1] as string, oid: m[2] as string, path: m[3] as string };
  });
}

describe("listSubmodules matches `git submodule status`", () => {
  test("recorded oid, url and the deinit'd (`-`) checkout", async () => {
    const session = await RepoSession.open(
      await NodeDirHandle.open(fixturePath("submodule")),
      quietSink,
      { id: "t10-12-submodule" },
    );
    const subs = await session.listSubmodules();
    const expected = gitSubmoduleStatus();
    expect(subs.map((s) => s.path)).toEqual(expected.map((e) => e.path));
    for (const [i, row] of expected.entries()) {
      const got = subs[i];
      expect(got?.recorded).toBe(row.oid);
      // `-` is git's "not initialised": no repository at the path, so nothing is checked out.
      expect(got?.checkedOut).toBe(row.prefix === "-" ? null : row.oid);
      expect(got?.dirty).toBeNull();
    }
    expect(subs[0]?.url).toEndWith("/fixtures/_remotes/sub.git");
    expect(structuredClone(subs)).toEqual(subs);
    await session.close();
  });

  test("the recorded oid is the gitlink `git ls-tree` prints for HEAD", async () => {
    const gitlinks = loadExpectedLines("submodule", "ls-tree-head")
      .map((l) => /^160000 commit ([0-9a-f]{40})\t(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ oid: m[1] as string, path: m[2] as string }));
    const session = await RepoSession.open(
      await NodeDirHandle.open(fixturePath("submodule")),
      quietSink,
      { id: "t10-12-submodule-tree" },
    );
    const subs = await session.listSubmodules();
    expect(subs.map((s) => ({ oid: s.recorded, path: s.path }))).toEqual(gitlinks);
    await session.close();
  });

  test("a repository with no submodules answers []", async () => {
    const session = await RepoSession.open(
      await NodeDirHandle.open(fixturePath("basic")),
      quietSink,
      { id: "t10-12-nosub" },
    );
    expect(await session.listSubmodules()).toEqual([]);
    await session.close();
  });
});

describe("a checked-out submodule", () => {
  const HEAD_OID = "1".repeat(40);
  const PACKED_OID = "2".repeat(40);

  function repo(extra: Record<string, string> = {}) {
    return createFsaFs(
      MemoryFs.fromEntries({
        ".git/HEAD": "ref: refs/heads/main\n",
        ".gitmodules": '[submodule "sub"]\n\tpath = sub\n\turl = https://example.test/sub.git\n',
        "sub/.git": "gitdir: ../.git/modules/sub\n",
        ".git/modules/sub/HEAD": "ref: refs/heads/main\n",
        ".git/modules/sub/refs/heads/main": `${HEAD_OID}\n`,
        ...extra,
      }).handle(),
    );
  }
  const tree: FlatTree = { sub: { oid: "3".repeat(40), mode: 0o160000 } };
  const db = { flattenTree: async () => tree };

  test("follows the `.git` file into `.git/modules/<name>` and reads its HEAD", async () => {
    const subs = await listSubmodules({ fs: repo(), db }, "head");
    expect(subs).toEqual([
      {
        path: "sub",
        url: "https://example.test/sub.git",
        recorded: "3".repeat(40),
        checkedOut: HEAD_OID,
        dirty: null,
      },
    ]);
  });

  test("resolves a branch that only exists in the module's packed-refs", async () => {
    const fs = repo({
      ".git/modules/sub/HEAD": "ref: refs/heads/topic\n",
      ".git/modules/sub/packed-refs": `# pack-refs with: peeled\n${PACKED_OID} refs/heads/topic\n`,
    });
    // The loose ref for `topic` does not exist, so the packed table has to answer.
    expect(await readHeadOid(fs, ".git/modules/sub")).toBe(PACKED_OID);
  });

  test("a detached submodule HEAD is the bare oid", async () => {
    const fs = repo({ ".git/modules/sub/HEAD": `${PACKED_OID}\n` });
    expect(await checkedOutOid(fs, "sub")).toBe(PACKED_OID);
  });

  test("an old-style `.git` directory inside the submodule works too", async () => {
    const fs = createFsaFs(
      MemoryFs.fromEntries({
        ".git/HEAD": "ref: refs/heads/main\n",
        "sub/.git/HEAD": "ref: refs/heads/main\n",
        "sub/.git/refs/heads/main": `${HEAD_OID}\n`,
      }).handle(),
    );
    expect(await checkedOutOid(fs, "sub")).toBe(HEAD_OID);
  });

  test("a gitdir outside the picked folder is not followed", async () => {
    const fs = repo({ "sub/.git": "gitdir: /elsewhere/.git/modules/sub\n" });
    expect(await checkedOutOid(fs, "sub")).toBeNull();
    const up = repo({ "sub/.git": "gitdir: ../../outside/modules/sub\n" });
    expect(await checkedOutOid(up, "sub")).toBeNull();
  });

  test("an empty submodule directory (deinit) is `checkedOut: null`", async () => {
    const fs = createFsaFs(
      MemoryFs.fromEntries({ ".git/HEAD": "ref: refs/heads/main\n" }).handle(),
    );
    expect(await checkedOutOid(fs, "sub")).toBeNull();
  });
});

describe("resolveGitdirLine", () => {
  test("resolves `..` against the submodule directory", () => {
    expect(resolveGitdirLine("sub", "gitdir: ../.git/modules/sub")).toBe(".git/modules/sub");
    expect(resolveGitdirLine("vendor/lib", "gitdir: ../../.git/modules/vendor/lib")).toBe(
      ".git/modules/vendor/lib",
    );
    expect(resolveGitdirLine("sub", "gitdir: ./inner")).toBe("sub/inner");
  });
  test("refuses anything that leaves the picked folder", () => {
    expect(resolveGitdirLine("sub", "gitdir: /abs/path")).toBeNull();
    expect(resolveGitdirLine("sub", "gitdir: ../../up")).toBeNull();
    expect(resolveGitdirLine("sub", "gitdir:")).toBeNull();
  });
});

describe("parseGitmodules", () => {
  test("reads path and url per section, keyed by path", () => {
    const entries = parseGitmodules(
      [
        "# a comment",
        '[submodule "vendor/lib"]',
        "\tpath = vendor/lib",
        "\turl = https://example.test/lib.git",
        '[submodule "docs"]',
        "\tpath = docs",
        "\turl = ../docs.git  ; trailing comment",
        "\tbranch = main",
        "[core]",
        "\tpath = ignored",
        "",
      ].join("\n"),
    );
    expect(entries).toEqual([
      { name: "vendor/lib", path: "vendor/lib", url: "https://example.test/lib.git" },
      { name: "docs", path: "docs", url: "../docs.git" },
    ]);
  });

  test("a section without a path is skipped, a quoted value is unquoted", () => {
    const entries = parseGitmodules(
      ['[submodule "broken"]', "\turl = x", '[submodule "ok"]', '\tpath = "my sub"', ""].join("\n"),
    );
    expect(entries).toEqual([{ name: "ok", path: "my sub", url: null }]);
  });

  test("CRLF and an empty file", () => {
    expect(parseGitmodules('[submodule "a"]\r\n\tpath = a\r\n')).toEqual([
      { name: "a", path: "a", url: null },
    ]);
    expect(parseGitmodules("")).toEqual([]);
  });
});
