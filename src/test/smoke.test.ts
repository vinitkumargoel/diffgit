import { describe, expect, test } from "bun:test";
import { NodeDirHandle } from "../engine/fs/nodeDirHandle";
import { fixturePath } from "./fixtures";

describe("test harness smoke", () => {
  test("opens fixtures/basic via NodeDirHandle, lists .git entries, reads HEAD", async () => {
    const root = await NodeDirHandle.open(fixturePath("basic"));
    expect(root.kind).toBe("directory");
    const git = await root.getDirectoryHandle(".git");
    const names: string[] = [];
    for await (const [name, handle] of git.entries()) {
      names.push(name);
      expect(["file", "directory"]).toContain(handle.kind);
    }
    expect(names).toEqual(expect.arrayContaining(["HEAD", "config", "objects", "refs", "index"]));
    const head = await (await git.getFileHandle("HEAD")).getFile();
    const text = new TextDecoder().decode(await head.arrayBuffer());
    expect(text).toBe("ref: refs/heads/feature\n");
    expect(head.size).toBe(text.length);
    expect(Number.isInteger(head.lastModified)).toBe(true);
  });
});
