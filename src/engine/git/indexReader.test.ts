import { describe, expect, test } from "bun:test";
import {
  type ExpectedIndexEntry,
  fixturePath,
  hasFixture,
  loadExpected,
} from "../../test/fixtures";
import { snapshotFromDisk } from "../../test/memorySnapshot";
import { restoreIndex, truncateIndex } from "../../test/torn";
import { createFsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { sha1 } from "./hash";
import { type IndexEntry, parseIndex, readIndex, readOffsetVarint } from "./indexReader";

// ---- tiny index builder for byte-level tests ----
interface BuildEntry {
  path: string;
  oid?: string;
  mode?: number;
  size?: number;
  mtimeSec?: number;
  mtimeNsec?: number;
  stage?: number;
  assumeValid?: boolean;
  skipWorktree?: boolean;
  intentToAdd?: boolean;
}

function encodeOffsetVarint(value: number): number[] {
  // inverse of git's offset encoding (varint.c encode_varint)
  const out: number[] = [];
  let v = value;
  out.unshift(v & 0x7f);
  v >>= 7;
  while (v) {
    v -= 1;
    out.unshift(0x80 | (v & 0x7f));
    v >>= 7;
  }
  return out;
}

async function buildIndex(
  version: 2 | 3 | 4,
  entries: BuildEntry[],
  extensions: { sig: string; payload?: Uint8Array }[] = [],
  corruptTrailer = false,
): Promise<Uint8Array> {
  const parts: number[] = [];
  const u32 = (n: number) =>
    parts.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const u16 = (n: number) => parts.push((n >>> 8) & 0xff, n & 0xff);
  parts.push(0x44, 0x49, 0x52, 0x43); // DIRC
  u32(version);
  u32(entries.length);
  let prev = "";
  for (const e of entries) {
    const start = parts.length;
    u32(1_700_000_000);
    u32(0); // ctime
    u32(e.mtimeSec ?? 1_700_000_000);
    u32(e.mtimeNsec ?? 0);
    u32(0);
    u32(0); // dev ino
    u32(e.mode ?? 0o100644);
    u32(0);
    u32(0); // uid gid
    u32(e.size ?? 0);
    const oid = e.oid ?? "0123456789abcdef0123456789abcdef01234567";
    for (let i = 0; i < 40; i += 2) parts.push(Number.parseInt(oid.slice(i, i + 2), 16));
    const nameBytes = new TextEncoder().encode(e.path);
    const extended = version >= 3 && (e.skipWorktree || e.intentToAdd);
    let flags = Math.min(nameBytes.length, 0xfff) | ((e.stage ?? 0) << 12);
    if (e.assumeValid) flags |= 0x8000;
    if (extended) flags |= 0x4000;
    u16(flags);
    if (extended) u16((e.skipWorktree ? 0x4000 : 0) | (e.intentToAdd ? 0x2000 : 0));
    if (version === 4) {
      let common = 0;
      while (common < prev.length && common < e.path.length && prev[common] === e.path[common])
        common++;
      parts.push(...encodeOffsetVarint(prev.length - common));
      parts.push(...new TextEncoder().encode(e.path.slice(common)), 0);
    } else {
      parts.push(...nameBytes, 0);
      while ((parts.length - start) % 8 !== 0) parts.push(0);
    }
    prev = e.path;
  }
  for (const ext of extensions) {
    parts.push(...new TextEncoder().encode(ext.sig));
    const payload = ext.payload ?? new Uint8Array(0);
    u32(payload.length);
    parts.push(...payload);
  }
  const body = new Uint8Array(parts);
  const trailer = await sha1(body);
  if (corruptTrailer) trailer[0] = (trailer[0] as number) ^ 0xff;
  const out = new Uint8Array(body.length + 20);
  out.set(body, 0);
  out.set(trailer, body.length);
  return out;
}

function pick(e: IndexEntry) {
  return { path: e.path, oid: e.oid, mode: e.mode.toString(8), stage: e.stage as number };
}

describe("parseIndex byte-level", () => {
  test("offset varint round trip", () => {
    for (const v of [0, 1, 127, 128, 129, 255, 256, 16_383, 16_384, 1_000_000]) {
      const bytes = new Uint8Array(encodeOffsetVarint(v));
      expect(readOffsetVarint(bytes, 0)).toEqual({ value: v, next: bytes.length });
    }
    // known encodings from git's varint.c: 128 → 0x80 0x00
    expect(encodeOffsetVarint(128)).toEqual([0x80, 0x00]);
  });

  test("v2: fields, stages, assume-valid, padding", async () => {
    const bytes = await buildIndex(2, [
      { path: "a.txt", size: 5, mtimeSec: 100, mtimeNsec: 999_999 },
      { path: "conflict.txt", stage: 1, oid: "1".repeat(40) },
      { path: "conflict.txt", stage: 2, oid: "2".repeat(40) },
      { path: "conflict.txt", stage: 3, oid: "3".repeat(40) },
      { path: "dir/exec.sh", mode: 0o100755, assumeValid: true },
      { path: "link", mode: 0o120000 },
      { path: "sub", mode: 0o160000 },
    ]);
    const s = await parseIndex(bytes, 4242);
    expect(s.version).toBe(2);
    expect(s.checksumOk).toBe(true);
    expect(s.indexMtimeMs).toBe(4242);
    expect(s.entries.length).toBe(7);
    expect(s.byPath["a.txt"]).toMatchObject({
      size: 5,
      mtimeSec: 100,
      mtimeNsec: 999_999,
      stage: 0,
      assumeValid: false,
      skipWorktree: false,
      intentToAdd: false,
      isSparseDir: false,
    });
    expect(s.byPath["conflict.txt"]).toBeUndefined();
    expect(s.conflicts["conflict.txt"]?.map((e) => [e.stage, e.oid[0]])).toEqual([
      [1, "1"],
      [2, "2"],
      [3, "3"],
    ]);
    expect(s.byPath["dir/exec.sh"]).toMatchObject({ mode: 0o100755, assumeValid: true });
    expect(s.byPath.link?.mode).toBe(0o120000);
    expect(s.byPath.sub?.mode).toBe(0o160000);
    expect(s.extensions).toEqual([]);
    expect(s.hasSplitIndex).toBe(false);
    expect(s.tooLarge).toBe(false);
  });

  test("v3: extended flags (skip-worktree, intent-to-add) and extension signatures", async () => {
    const bytes = await buildIndex(
      3,
      [
        { path: "normal.txt" },
        { path: "skipped.txt", skipWorktree: true },
        { path: "intent.txt", intentToAdd: true, oid: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" },
      ],
      [
        { sig: "TREE", payload: new Uint8Array([1, 2, 3]) },
        { sig: "REUC" },
        { sig: "UNTR", payload: new Uint8Array(10) },
      ],
    );
    const s = await parseIndex(bytes);
    expect(s.version).toBe(3);
    expect(s.byPath["skipped.txt"]).toMatchObject({ skipWorktree: true, intentToAdd: false });
    expect(s.byPath["intent.txt"]).toMatchObject({ skipWorktree: false, intentToAdd: true });
    expect(s.byPath["normal.txt"]).toMatchObject({ skipWorktree: false, intentToAdd: false });
    expect(s.extensions).toEqual(["TREE", "REUC", "UNTR"]);
    expect(s.checksumOk).toBe(true);
  });

  test("v4: prefix compression across shared-prefix paths; link/sdir extensions; sparse dir entries", async () => {
    const paths = [
      "src/engine/a.ts",
      "src/engine/ab.ts",
      "src/engine/git/x.ts",
      "src/ui/App.tsx",
      "zzz",
      "sparse/",
    ];
    const bytes = await buildIndex(
      4,
      paths.map((p) => ({ path: p, mode: p.endsWith("/") ? 0o40000 : 0o100644 })),
      [{ sig: "sdir" }, { sig: "link", payload: new Uint8Array(24) }],
    );
    const s = await parseIndex(bytes);
    expect(s.version).toBe(4);
    expect(s.entries.map((e) => e.path)).toEqual([
      "src/engine/a.ts",
      "src/engine/ab.ts",
      "src/engine/git/x.ts",
      "src/ui/App.tsx",
      "zzz",
      "sparse",
    ]);
    expect(s.byPath.sparse).toMatchObject({ isSparseDir: true, mode: 0o40000 });
    expect(Object.keys(s.byPath).some((k) => k.endsWith("/"))).toBe(false);
    expect(s.hasSparseIndex).toBe(true);
    expect(s.hasSplitIndex).toBe(true);
    expect(s.extensions).toEqual(["sdir", "link"]);
  });

  test("corrupted trailer → checksumOk false but entries still parsed", async () => {
    const bytes = await buildIndex(2, [{ path: "a" }], [], true);
    const s = await parseIndex(bytes);
    expect(s.checksumOk).toBe(false);
    expect(s.entries.length).toBe(1);
  });

  test("unsupported version / bad signature / truncated → INDEX_UNSUPPORTED", async () => {
    const good = await buildIndex(2, [{ path: "a" }, { path: "b" }]);
    const v5 = new Uint8Array(good);
    v5[7] = 5;
    await expect(parseIndex(v5)).rejects.toMatchObject({ code: "INDEX_UNSUPPORTED" });
    const badSig = new Uint8Array(good);
    badSig[0] = 0x58;
    await expect(parseIndex(badSig)).rejects.toMatchObject({ code: "INDEX_UNSUPPORTED" });
    await expect(parseIndex(good.subarray(0, 40))).rejects.toMatchObject({
      code: "INDEX_UNSUPPORTED",
    });
    await expect(parseIndex(good.subarray(0, good.length >> 1))).rejects.toMatchObject({
      code: "INDEX_UNSUPPORTED",
    });
  });

  test("tooLarge flag above 200k entries (synthetic count, tiny names)", async () => {
    const entries = Array.from({ length: 200_001 }, (_, i) => ({ path: `f${i.toString(36)}` }));
    const bytes = await buildIndex(4, entries);
    const s = await parseIndex(bytes);
    expect(s.tooLarge).toBe(true);
    expect(s.entries.length).toBe(200_001);
  }, 20_000);
});

describe("readIndex on fixtures vs ls-files -s", () => {
  const cases: Record<string, 2 | 3 | 4> = {
    basic: 2,
    worktree: 2,
    "index-v3": 3,
    "index-v4": 4,
    conflict: 2,
    unborn: 2,
    symlink: 2,
    submodule: 2,
  };
  for (const [name, version] of Object.entries(cases)) {
    test(`${name} (v${version})`, async () => {
      const fs = createFsaFs(await NodeDirHandle.open(fixturePath(name)));
      const s = await readIndex(fs);
      expect(s.version).toBe(version);
      expect(s.checksumOk).toBe(true);
      expect(s.indexMtimeMs).toBeGreaterThan(0);
      const expected = loadExpected<ExpectedIndexEntry[]>(name, "ls-files-s").map((e) => ({
        path: e.path,
        oid: e.oid,
        mode: e.mode,
        stage: e.stage,
      }));
      expect(s.entries.map(pick)).toEqual(expected);
      expect(s.hasSplitIndex).toBe(false);
    });
  }

  test("index-v3: intent.txt has intentToAdd; nothing else does", async () => {
    const s = await readIndex(createFsaFs(await NodeDirHandle.open(fixturePath("index-v3"))));
    expect(s.byPath["intent.txt"]?.intentToAdd).toBe(true);
    expect(s.entries.filter((e) => e.intentToAdd).map((e) => e.path)).toEqual(["intent.txt"]);
  });

  test("conflict: file.txt grouped into stages 1/2/3 and absent from byPath", async () => {
    const s = await readIndex(createFsaFs(await NodeDirHandle.open(fixturePath("conflict"))));
    expect(s.conflicts["file.txt"]?.map((e) => e.stage)).toEqual([1, 2, 3]);
    expect(s.byPath["file.txt"]).toBeUndefined();
    expect(s.byPath["other.txt"]).toBeDefined();
  });

  test("missing .git/index → empty snapshot", async () => {
    const fs = createFsaFs(
      MemoryFs.fromEntries({ ".git/HEAD": "ref: refs/heads/main\n" }).handle(),
    );
    const s = await readIndex(fs, 1);
    expect(s.entries).toEqual([]);
    expect(s.checksumOk).toBe(true);
  });

  test("torn read: truncated index is retried once and the restored file parses", async () => {
    const snap = await snapshotFromDisk(fixturePath("worktree"), "w", "worktree", {
      exclude: (p) => p === "expected",
    });
    const mem = MemoryFs.fromSnapshot(snap);
    const fs = createFsaFs(mem.handle());
    mem.apply(truncateIndex(snap));
    setTimeout(() => mem.apply(restoreIndex(snap)), 20);
    const s = await readIndex(fs, 60);
    expect(s.checksumOk).toBe(true);
    expect(s.entries.length).toBeGreaterThan(5);
    // still torn after the retry → returned with checksumOk=false, no throw
    mem.apply(truncateIndex(snap));
    const bad = await readIndex(fs, 1);
    expect(bad.checksumOk).toBe(false);
  });

  test.skipIf(!hasFixture("perf-5k"))("perf-5k index parses < 50 ms", async () => {
    const fs = createFsaFs(await NodeDirHandle.open(fixturePath("perf-5k")));
    const bytes = await fs.readFile(".git/index");
    const t0 = performance.now();
    const s = await parseIndex(bytes);
    const ms = performance.now() - t0;
    console.log(
      `perf-5k parseIndex: ${ms.toFixed(1)} ms for ${s.entries.length} entries (budget 50 ms)`,
    );
    expect(s.entries.length).toBe(5000);
    if (process.env.PERF_STRICT === "1") expect(ms).toBeLessThan(50);
  });
});
