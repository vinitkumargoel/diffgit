import { describe, expect, test } from "bun:test";
import { fixturePath } from "../../test/fixtures";
import { createFsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { loadGitConfig, parseGitConfig } from "./config";
import { checkLayout } from "./layoutChecks";

async function onFixture(name: string) {
  const fs = createFsaFs(await NodeDirHandle.open(fixturePath(name)));
  return checkLayout(fs, await loadGitConfig(fs));
}

const MINIMAL = {
  ".git/HEAD": "ref: refs/heads/main\n",
  ".git/config": "[core]\n\trepositoryformatversion = 0\n",
  ".git/objects/info/.keep": "",
  ".git/refs/heads/.keep": "",
};

async function onMemory(
  files: Record<string, string | Uint8Array>,
  opts?: Parameters<typeof checkLayout>[2],
) {
  const fs = createFsaFs(MemoryFs.fromEntries(files).handle());
  return checkLayout(fs, await loadGitConfig(fs), opts);
}

describe("checkLayout on fixtures", () => {
  test("basic and packed are ok with no warnings", async () => {
    for (const name of ["basic", "packed"]) {
      const r = await onFixture(name);
      expect(r.ok).toBe(true);
      expect(r.warnings).toEqual([]);
      expect(r.capabilities.isWorktreeGitdir).toBe(false);
    }
    expect((await onFixture("packed")).packBytes).toBeGreaterThan(0);
    expect((await onFixture("basic")).packBytes).toBe(0);
  });
  test("worktree-gitdir → WORKTREE_GITDIR", async () => {
    const r = await onFixture("worktree-gitdir");
    expect(r.ok).toBe(false);
    expect(r.fatal?.code).toBe("WORKTREE_GITDIR");
    expect(r.fatal?.hint).toContain("main repository");
    expect(r.capabilities.isWorktreeGitdir).toBe(true);
  });
  test("sha256 → OBJECT_FORMAT_SHA256", async () => {
    expect((await onFixture("sha256")).fatal?.code).toBe("OBJECT_FORMAT_SHA256");
  });
  test("alternates → ALTERNATES", async () => {
    expect((await onFixture("alternates")).fatal?.code).toBe("ALTERNATES");
  });
  test("partial → PARTIAL_CLONE", async () => {
    expect((await onFixture("partial")).fatal?.code).toBe("PARTIAL_CLONE");
  });
  test("crlf → AUTOCRLF warning, still ok", async () => {
    const r = await onFixture("crlf");
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(["AUTOCRLF"]);
  });
  test("a folder without .git → NOT_A_REPO", async () => {
    const r = await onMemory({ "README.md": "hi", "src/a.ts": "x" });
    expect(r.fatal?.code).toBe("NOT_A_REPO");
    expect(r.fatal?.hint).toBe("Choose the folder that contains .git");
  });
});

describe("checkLayout synthetic layouts", () => {
  test("bare repo opened directly → BARE_REPO", async () => {
    const r = await onMemory({
      HEAD: "ref: refs/heads/main\n",
      "objects/.keep": "",
      "refs/heads/.keep": "",
      config: "",
    });
    expect(r.fatal?.code).toBe("BARE_REPO");
  });
  test(".git file without gitdir → NOT_A_REPO", async () => {
    expect((await onMemory({ ".git": "garbage" })).fatal?.code).toBe("NOT_A_REPO");
  });
  test(".git dir without HEAD → NOT_A_REPO", async () => {
    expect((await onMemory({ ".git/config": "" })).fatal?.code).toBe("NOT_A_REPO");
  });
  test("reftable directory → REFTABLE", async () => {
    const r = await onMemory({ ...MINIMAL, ".git/reftable/tables.list": "" });
    expect(r.fatal?.code).toBe("REFTABLE");
    expect(r.capabilities.hasReftable).toBe(true);
  });
  test("refStorage = reftable in config → REFTABLE", async () => {
    const r = await onMemory({
      ...MINIMAL,
      ".git/config": "[extensions]\n\trefStorage = reftable\n",
    });
    expect(r.fatal?.code).toBe("REFTABLE");
  });
  test("extensions.partialClone / remote promisor / .promisor pack → PARTIAL_CLONE", async () => {
    expect(
      (await onMemory({ ...MINIMAL, ".git/config": "[extensions]\n\tpartialClone = origin\n" }))
        .fatal?.code,
    ).toBe("PARTIAL_CLONE");
    expect(
      (
        await onMemory({
          ...MINIMAL,
          ".git/config": '[remote "origin"]\n\turl = x\n\tpromisor = true\n',
        })
      ).fatal?.code,
    ).toBe("PARTIAL_CLONE");
    expect(
      (await onMemory({ ...MINIMAL, ".git/objects/pack/pack-abc.promisor": "" })).fatal?.code,
    ).toBe("PARTIAL_CLONE");
  });
  test("pack size thresholds: warning above large, fatal above too-large", async () => {
    const files = {
      ...MINIMAL,
      ".git/objects/pack/pack-a.pack": new Uint8Array(600),
      ".git/objects/pack/pack-b.pack": new Uint8Array(500),
    };
    const ok = await onMemory(files, { packLargeBytes: 2000, packTooLargeBytes: 5000 });
    expect(ok.ok).toBe(true);
    expect(ok.packBytes).toBe(1100);
    expect(ok.warnings).toEqual([]);
    const warn = await onMemory(files, { packLargeBytes: 1000, packTooLargeBytes: 5000 });
    expect(warn.ok).toBe(true);
    expect(warn.warnings.map((w) => w.code)).toEqual(["PACK_LARGE"]);
    const fatal = await onMemory(files, { packLargeBytes: 100, packTooLargeBytes: 1000 });
    expect(fatal.fatal?.code).toBe("PACK_TOO_LARGE");
  });
  test("multi-pack-index, shallow and LFS produce warnings", async () => {
    const r = await onMemory({
      ...MINIMAL,
      ".git/objects/pack/multi-pack-index": "",
      ".git/shallow": "abc\n",
      ".gitattributes": "*.psd filter=lfs diff=lfs merge=lfs -text\n",
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code).sort()).toEqual([
      "LFS_PRESENT",
      "MULTI_PACK_INDEX",
      "SHALLOW",
    ]);
  });
  test("EACCES escalates to PERMISSION", async () => {
    const denied = {
      kind: "directory" as const,
      name: "denied",
      async getDirectoryHandle(): Promise<never> {
        throw new DOMException("denied", "NotAllowedError");
      },
      async getFileHandle(): Promise<never> {
        throw new DOMException("denied", "NotAllowedError");
      },
      async *entries() {
        yield* [] as [string, never][];
      },
    };
    const fs = createFsaFs(denied);
    await expect(checkLayout(fs, parseGitConfig(""))).rejects.toMatchObject({ code: "PERMISSION" });
  });
});
