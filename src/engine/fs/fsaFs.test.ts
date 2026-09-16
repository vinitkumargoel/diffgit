import { beforeAll, describe, expect, test } from "bun:test";
import git from "isomorphic-git";
import { fixturePath, loadExpected } from "../../test/fixtures";
import { type SpyCounts, spyHandle } from "../../test/spyHandle";
import { createFsaFs, type FsaFs, fsCode, normalizePath } from "./fsaFs";
import { MemoryFs } from "./memoryDirHandle";
import { NodeDirHandle } from "./nodeDirHandle";

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return fsCode(e);
  }
}

describe("normalizePath", () => {
  test("strips leading / and ./, keeps repo-relative POSIX paths", () => {
    expect(normalizePath("/.git/HEAD")).toBe(".git/HEAD");
    expect(normalizePath("./src//a.txt")).toBe("src/a.txt");
    expect(normalizePath("")).toBe("");
    expect(normalizePath(".")).toBe("");
    expect(normalizePath("/")).toBe("");
    expect(normalizePath("a/./b/")).toBe("a/b");
  });
  test("rejects .. with EINVAL", () => {
    expect(() => normalizePath("../x")).toThrow();
    let code: string | undefined;
    try {
      normalizePath("a/../b");
    } catch (e) {
      code = fsCode(e);
    }
    expect(code).toBe("EINVAL");
  });
});

describe("FsaFs on fixtures/basic", () => {
  let fs: FsaFs;
  let counts: SpyCounts;
  beforeAll(async () => {
    const spy = spyHandle(await NodeDirHandle.open(fixturePath("basic")));
    counts = spy.counts;
    fs = createFsaFs(spy);
  });

  test("readFile as bytes and as utf8 string", async () => {
    const bytes = await fs.promises.readFile("/.git/HEAD");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("ref: refs/heads/feature\n");
    expect(await fs.promises.readFile("/.git/HEAD", "utf8")).toBe("ref: refs/heads/feature\n");
    expect(await fs.promises.readFile(".git/HEAD", { encoding: "utf8" })).toBe(
      "ref: refs/heads/feature\n",
    );
    expect(await fs.readText(".git/HEAD")).toBe("ref: refs/heads/feature\n");
  });

  test("readdir lists branches; readdirWithKinds carries kinds", async () => {
    const names = await fs.promises.readdir("/.git/refs/heads");
    expect(names.sort()).toEqual(["feature", "main"]);
    const kinds = await fs.readdirWithKinds("");
    expect(kinds.find((e) => e.name === ".git")?.kind).toBe("directory");
    expect(kinds.find((e) => e.name === "README.md")?.kind).toBe("file");
  });

  test("stat maps size/mtime/mode; directories have mode 0o40000", async () => {
    const s = await fs.promises.stat("/.git/HEAD");
    expect(s.isFile()).toBe(true);
    expect(s.isDirectory()).toBe(false);
    expect(s.isSymbolicLink()).toBe(false);
    expect(s.size).toBe("ref: refs/heads/feature\n".length);
    expect(s.mode).toBe(0o100644);
    expect(Number.isInteger(s.mtimeMs) && s.mtimeMs > 0).toBe(true);
    expect(s.ctimeMs).toBe(0);
    const d = await fs.promises.lstat("/.git");
    expect(d.isDirectory()).toBe(true);
    expect(d.mode).toBe(0o40000);
    const rootStat = await fs.promises.stat("/");
    expect(rootStat.isDirectory()).toBe(true);
  });

  test("error codes: ENOENT, EISDIR, ENOTDIR, EINVAL", async () => {
    expect(await codeOf(fs.promises.readFile("/nope.txt"))).toBe("ENOENT");
    expect(await codeOf(fs.promises.readFile("/.git/refs/heads/nope"))).toBe("ENOENT");
    expect(await codeOf(fs.promises.readFile("/.git"))).toBe("EISDIR");
    expect(await codeOf(fs.promises.readdir("/.git/HEAD"))).toBe("ENOTDIR");
    // a file used as an intermediate directory is ENOTDIR, exactly like Node
    expect(await codeOf(fs.promises.readdir("/README.md/x"))).toBe("ENOTDIR");
    expect(await codeOf(fs.promises.stat("/README.md/x"))).toBe("ENOTDIR");
    expect(await codeOf(fs.promises.readFile("/../etc/passwd"))).toBe("EINVAL");
    expect(await codeOf(fs.promises.readlink("/.git/HEAD"))).toBe("EINVAL");
    expect(await fs.exists("/.git/HEAD")).toBe(true);
    expect(await fs.exists("/nothing")).toBe(false);
  });

  test("readFile with no argument returns a rejected promise (isomorphic-git's promise-fs probe)", async () => {
    const p = (fs.promises.readFile as (p?: string) => Promise<unknown>)();
    expect(p).toBeInstanceOf(Promise);
    await expect(p).rejects.toBeDefined();
  });

  test("INVARIANT: every write method throws EROFS before touching a handle", async () => {
    const before = { ...counts };
    const p = fs.promises;
    expect(await codeOf(p.writeFile("/x", "data"))).toBe("EROFS");
    expect(await codeOf(p.unlink("/README.md"))).toBe("EROFS");
    expect(await codeOf(p.mkdir("/newdir"))).toBe("EROFS");
    expect(await codeOf(p.rmdir("/src"))).toBe("EROFS");
    expect(await codeOf(p.rm("/src", { recursive: true }))).toBe("EROFS");
    expect(await codeOf(p.symlink("/README.md", "/link"))).toBe("EROFS");
    expect(await codeOf(p.chmod("/README.md", 0o755))).toBe("EROFS");
    expect(await codeOf(p.rename("/README.md", "/R.md"))).toBe("EROFS");
    // zero calls reached the underlying handles
    expect(counts.getDirectoryHandle).toBe(before.getDirectoryHandle);
    expect(counts.getFileHandle).toBe(before.getFileHandle);
    expect(counts.entries).toBe(before.entries);
    expect(counts.getFile).toBe(before.getFile);
    expect(counts.optionsPassed).toBe(0);
    expect(counts.unknownAccess).toEqual([]);
  });

  test("handle cache: repeated resolves hit the handle once; invalidateAll forces a new lookup", async () => {
    fs.invalidateAll();
    const start = counts.getFileHandle;
    await fs.promises.readFile("/.git/HEAD");
    await fs.promises.readFile("/.git/HEAD");
    await fs.promises.stat("/.git/HEAD");
    expect(counts.getFileHandle - start).toBe(1);
    fs.invalidateAll();
    await fs.promises.readFile("/.git/HEAD");
    expect(counts.getFileHandle - start).toBe(2);
  });

  test("invalidatePath drops the path and its descendants only", async () => {
    fs.invalidateAll();
    await fs.promises.readFile("/.git/HEAD");
    await fs.promises.readFile("/src/a.txt");
    const size = fs.cacheSize();
    const start = counts.getFileHandle;
    fs.invalidatePath(".git");
    expect(fs.cacheSize()).toBeLessThan(size);
    await fs.promises.readFile("/src/a.txt"); // still cached
    expect(counts.getFileHandle - start).toBe(0);
    await fs.promises.readFile("/.git/HEAD"); // re-resolved
    expect(counts.getFileHandle - start).toBe(1);
  });
});

describe("FsaFs cache eviction on stale handles (memory fs)", () => {
  test("a cached file handle whose file was deleted evicts and reports ENOENT; recreated file is re-read", async () => {
    const mem = MemoryFs.fromEntries({ "a/b.txt": "one", "c.txt": "c" });
    const spy = spyHandle(mem.handle());
    const fs = createFsaFs(spy);
    expect(await fs.readText("a/b.txt")).toBe("one");
    mem.remove("a/b.txt");
    expect(await codeOf(fs.readText("a/b.txt"))).toBe("ENOENT");
    mem.write("a/b.txt", "two");
    expect(await fs.readText("a/b.txt")).toBe("two");
  });

  test("a path that changed kind (file → dir) is re-resolved instead of failing forever", async () => {
    const mem = MemoryFs.fromEntries({ thing: "file" });
    const fs = createFsaFs(mem.handle());
    expect((await fs.stat("thing")).isFile()).toBe(true);
    mem.remove("thing");
    mem.write("thing/inner.txt", "x");
    expect((await fs.stat("thing")).isDirectory()).toBe(true);
    expect(await fs.promises.readdir("thing")).toEqual(["inner.txt"]);
    expect(await codeOf(fs.promises.readFile("thing"))).toBe("EISDIR");
  });

  test("openFile().stream() works", async () => {
    const mem = MemoryFs.fromEntries({ big: new Uint8Array(70_000).fill(7) });
    const fs = createFsaFs(mem.handle());
    const f = await fs.openFile("big");
    const reader = f.stream().getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    expect(total).toBe(70_000);
    expect(f.size).toBe(70_000);
  });

  test("NotAllowedError maps to EACCES", async () => {
    const root = MemoryFs.fromEntries({ "x.txt": "x" }).handle();
    const denied = {
      kind: "directory" as const,
      name: "denied",
      getDirectoryHandle: root.getDirectoryHandle.bind(root),
      async getFileHandle(): Promise<never> {
        throw new DOMException("denied", "NotAllowedError");
      },
      entries: root.entries.bind(root),
    };
    const fs = createFsaFs(denied);
    expect(await codeOf(fs.promises.readFile("x.txt"))).toBe("EACCES");
  });
});

describe("isomorphic-git integration through FsaFs (dir is always '/')", () => {
  for (const name of ["basic", "packed"]) {
    test(`resolveRef HEAD on fixtures/${name}`, async () => {
      const spy = spyHandle(await NodeDirHandle.open(fixturePath(name)));
      const fs = createFsaFs(spy);
      const oid = await git.resolveRef({ fs, dir: "/", ref: "HEAD" });
      const expected = loadExpected<{ headOid: string }>(name, "refs").headOid;
      expect(oid).toBe(expected);
      const main = await git.resolveRef({ fs, dir: "/", ref: "main" });
      expect(main).toBe(
        loadExpected<{ refs: Record<string, string> }>(name, "refs").refs[
          "refs/heads/main"
        ] as string,
      );
      expect(spy.counts.optionsPassed).toBe(0);
      expect(spy.counts.unknownAccess).toEqual([]);
    });
  }
});
