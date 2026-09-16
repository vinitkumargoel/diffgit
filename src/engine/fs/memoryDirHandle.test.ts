import { describe, expect, test } from "bun:test";
import { fixturePath } from "../../test/fixtures";
import { fromInitScript, snapshotFromDisk, toInitScript } from "../../test/memorySnapshot";
import { dropRoot, restoreIndex, swapPack, truncateIndex } from "../../test/torn";
import type { DirHandleLike } from "./dirHandleLike";
import { isHandleError } from "./dirHandleLike";
import { isMemoryHandleMarker, MemoryFs } from "./memoryDirHandle";
import { NodeDirHandle } from "./nodeDirHandle";

async function rejectsWith(
  p: Promise<unknown>,
  name: "NotFoundError" | "TypeMismatchError" | "NotAllowedError",
) {
  try {
    await p;
  } catch (e) {
    expect(isHandleError(e, name)).toBe(true);
    return;
  }
  throw new Error(`expected rejection with ${name}`);
}

async function listAll(root: DirHandleLike, prefix = ""): Promise<Map<string, Uint8Array | null>> {
  const out = new Map<string, Uint8Array | null>();
  for await (const [name, h] of root.entries()) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (h.kind === "directory") {
      out.set(p, null);
      for (const [k, v] of await listAll(h, p)) out.set(k, v);
    } else {
      out.set(p, new Uint8Array(await (await h.getFile()).arrayBuffer()));
    }
  }
  return out;
}

describe("MemoryDirHandle", () => {
  test("round-trips fixtures/basic: snapshotFromDisk → toInitScript → parse → same files and bytes", async () => {
    const dir = fixturePath("basic");
    const snap = await snapshotFromDisk(dir, "basic-snap", "basic", {
      exclude: (p) => p === "expected",
    });
    const script = toInitScript(snap);
    const parsed = fromInitScript(script);
    expect(parsed.id).toBe("basic-snap");
    expect(Object.keys(parsed.files).sort()).toEqual(Object.keys(snap.files).sort());

    const fromDisk = await listAll(await NodeDirHandle.open(dir));
    const fromMemory = await listAll(MemoryFs.fromSnapshot(parsed).handle("basic"));
    for (const k of [...fromDisk.keys()])
      if (k === "expected" || k.startsWith("expected/")) fromDisk.delete(k);
    expect([...fromMemory.keys()].sort()).toEqual([...fromDisk.keys()].sort());
    for (const [k, v] of fromDisk) {
      const m = fromMemory.get(k);
      if (v === null) expect(m).toBeNull();
      else expect(Buffer.from(m as Uint8Array).equals(Buffer.from(v))).toBe(true);
    }
    expect(Object.keys(snap.files).length).toBeGreaterThan(10);
  });

  test("errors carry browser names; mutations are visible through existing handles", async () => {
    const fs = MemoryFs.fromEntries({ "a/b.txt": "hello", "c.txt": "x" });
    const root = fs.handle();
    const a = await root.getDirectoryHandle("a");
    await rejectsWith(root.getDirectoryHandle("zzz"), "NotFoundError");
    await rejectsWith(root.getFileHandle("a"), "TypeMismatchError");
    await rejectsWith(root.getDirectoryHandle("c.txt"), "TypeMismatchError");

    const b = await a.getFileHandle("b.txt");
    const f1 = await b.getFile();
    expect(new TextDecoder().decode(await f1.arrayBuffer())).toBe("hello");
    fs.apply([{ op: "write", path: "a/b.txt", text: "changed", mtime: 42 }]);
    const f2 = await b.getFile(); // same handle object sees the new content
    expect(new TextDecoder().decode(await f2.arrayBuffer())).toBe("changed");
    expect(f2.lastModified).toBe(42);
    fs.apply([{ op: "remove", path: "a/b.txt" }]);
    await rejectsWith(b.getFile(), "NotFoundError");

    fs.apply([{ op: "rename", from: "c.txt", to: "d/e.txt" }]);
    expect(fs.readBytes("c.txt")).toBeNull();
    expect(new TextDecoder().decode(fs.readBytes("d/e.txt") ?? new Uint8Array())).toBe("x");

    fs.apply(dropRoot());
    await rejectsWith(root.getFileHandle("d"), "NotFoundError");
  });

  test("stream() yields the same bytes as arrayBuffer()", async () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    const fs = MemoryFs.fromEntries({ big });
    const f = await (await fs.handle().getFileHandle("big")).getFile();
    const chunks: Uint8Array[] = [];
    const reader = f.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const joined = Buffer.concat(chunks);
    expect(joined.equals(Buffer.from(await f.arrayBuffer()))).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("torn helpers produce the right mutations on the packed fixture", async () => {
    const snap = await snapshotFromDisk(fixturePath("packed"), "packed-snap", "packed", {
      exclude: (p) => p === "expected",
    });
    const fs = MemoryFs.fromSnapshot(snap);
    const before = fs.readBytes(".git/index")?.length ?? 0;
    fs.apply(truncateIndex(snap));
    expect(fs.readBytes(".git/index")?.length).toBe(before >> 1);
    fs.apply(restoreIndex(snap));
    expect(fs.readBytes(".git/index")?.length).toBe(before);
    const packs = Object.keys(snap.files).filter((p) => p.endsWith(".pack"));
    expect(packs.length).toBe(1);
    fs.apply(swapPack(snap));
    expect(fs.readBytes(packs[0] as string)).toBeNull();
    const dir = fs.lookup(".git/objects/pack");
    expect(dir?.kind).toBe("dir");
    expect(
      [...(dir?.kind === "dir" ? dir.children.keys() : [])].some((n) => n.endsWith(".pack")),
    ).toBe(true);
  });

  test("marker detection", () => {
    expect(
      isMemoryHandleMarker({
        __diffgoelMemoryHandle: true,
        kind: "directory",
        snapshotId: "x",
        name: "n",
      }),
    ).toBe(true);
    expect(isMemoryHandleMarker({ kind: "directory" })).toBe(false);
    expect(isMemoryHandleMarker(null)).toBe(false);
  });
});
