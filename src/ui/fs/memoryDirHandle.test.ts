import { describe, expect, it, vi } from "vitest";
import { fileSnapshotHandle, isFileSnapshot } from "../../engine/fs/fileSnapshot";
import { resolveHandle } from "../../engine/fs/resolveHandle";
import {
  collectSnapshot,
  relativePathOf,
  rootNameOf,
  SNAPSHOT_ENTRY_LIMIT,
  type SnapshotInputFile,
  SnapshotTooLargeError,
} from "./memoryDirHandle";

/**
 * A `File` double that counts every byte read, so "lazy" is asserted rather than assumed
 * (T11.15: bytes are read when the engine asks, never while the folder is listed).
 */
class CountingFile implements SnapshotInputFile {
  reads = 0;
  readonly lastModified = 1_700_000_000_000;
  private readonly bytes: Uint8Array;
  constructor(
    readonly webkitRelativePath: string,
    text = "x",
  ) {
    this.bytes = new TextEncoder().encode(text);
  }
  get name(): string {
    return this.webkitRelativePath.split("/").pop() ?? "";
  }
  get size(): number {
    return this.bytes.byteLength;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    this.reads++;
    return this.bytes.slice().buffer as ArrayBuffer;
  }
  stream(): ReadableStream<Uint8Array> {
    this.reads++;
    const bytes = this.bytes;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
}

/** What `<input webkitdirectory>` hands over for a tiny repository. */
function repoFiles(): CountingFile[] {
  return [
    new CountingFile("showcase/.git/HEAD", "ref: refs/heads/main\n"),
    new CountingFile("showcase/.git/refs/heads/main", "a".repeat(40)),
    new CountingFile("showcase/README.md", "# showcase"),
    new CountingFile("showcase/src/index.ts", "export {};"),
    new CountingFile("showcase/node_modules/left-pad/index.js", "module.exports = 1;"),
  ];
}

const totalReads = (files: CountingFile[]) => files.reduce((n, f) => n + f.reads, 0);

describe("collectSnapshot", () => {
  it("names the snapshot after the picked folder and strips it from every path", async () => {
    const files = repoFiles();
    const snapshot = await collectSnapshot(files, { now: () => 1_700_000_000_000 });
    expect(snapshot.name).toBe("showcase");
    expect(snapshot.readAt).toBe(1_700_000_000_000);
    expect(isFileSnapshot(snapshot)).toBe(true);
    expect(snapshot.entries.map((e) => e.path)).toEqual([
      ".git/HEAD",
      ".git/refs/heads/main",
      "README.md",
      "src/index.ts",
      "node_modules/left-pad/index.js",
    ]);
  });

  it("reads no bytes while walking the list", async () => {
    const files = repoFiles();
    await collectSnapshot(files);
    expect(totalReads(files)).toBe(0);
  });

  it("reports entries, total and the folder size as it goes", async () => {
    const files = repoFiles();
    const onProgress = vi.fn();
    const snapshot = await collectSnapshot(files, { onProgress });
    expect(onProgress).toHaveBeenCalledWith({
      entries: 5,
      total: 5,
      bytes: files.reduce((n, f) => n + f.size, 0),
    });
    expect(snapshot.entries).toHaveLength(5);
  });

  it("refuses a folder above the entry limit, with advice", async () => {
    const files = repoFiles();
    await expect(collectSnapshot(files, { limit: 3 })).rejects.toBeInstanceOf(
      SnapshotTooLargeError,
    );
    const error = await collectSnapshot(files, { limit: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnapshotTooLargeError);
    expect((error as SnapshotTooLargeError).advice).toMatch(/node_modules/);
    expect((error as SnapshotTooLargeError).advice).toMatch(/Chrome, Edge, Brave or Arc/);
    expect(totalReads(files)).toBe(0);
  });

  it("defaults to 100,000 entries and falls back when there is no relative path", () => {
    expect(SNAPSHOT_ENTRY_LIMIT).toBe(100_000);
    const loose = new CountingFile("patch.diff");
    expect(loose.webkitRelativePath).toBe("patch.diff");
    expect(relativePathOf({ ...loose, name: "patch.diff", webkitRelativePath: "" }, "repo")).toBe(
      "patch.diff",
    );
    expect(rootNameOf([])).toBe("repository");
  });
});

describe("the tree the worker rehydrates", () => {
  it("is a DirHandleLike that reads only the file the engine asks for", async () => {
    const files = repoFiles();
    const snapshot = await collectSnapshot(files);
    const root = fileSnapshotHandle(snapshot);

    const git = await root.getDirectoryHandle(".git");
    const names: string[] = [];
    for await (const [name] of root.entries()) names.push(name);
    // directories first, then files, each sorted — and still nothing read
    expect(names).toEqual([".git", "node_modules", "src", "README.md"]);
    expect(totalReads(files)).toBe(0);

    const head = await git.getFileHandle("HEAD");
    const file = await head.getFile();
    expect(new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))).toBe(
      "ref: refs/heads/main\n",
    );
    expect(files[0]?.reads).toBe(1);
    expect(totalReads(files)).toBe(1); // node_modules and README were never opened
  });

  it("throws the browser's own error names for missing entries and kind mismatches", async () => {
    const root = fileSnapshotHandle(await collectSnapshot(repoFiles()));
    await expect(root.getDirectoryHandle("nope")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await expect(root.getFileHandle("src")).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(root.getDirectoryHandle("README.md")).rejects.toMatchObject({
      name: "TypeMismatchError",
    });
  });

  it("crosses the worker boundary: `resolveHandle` accepts the cloneable payload", async () => {
    const snapshot = await collectSnapshot(repoFiles());
    const root = await resolveHandle(structuredClone({ ...snapshot, entries: [] }));
    expect(root.kind).toBe("directory");
    expect(root.name).toBe("showcase");
    // the real payload keeps the File objects, which structured-clone as themselves
    const withFiles = await resolveHandle(snapshot);
    await expect(withFiles.getDirectoryHandle(".git")).resolves.toMatchObject({
      kind: "directory",
    });
  });
});
