import { describe, expect, test } from "bun:test";
import {
  type ExpectedStatusEntry,
  fixturePath,
  hasFixture,
  loadExpected,
} from "../../test/fixtures";
import { snapshotFromDisk } from "../../test/memorySnapshot";
import { spyHandle } from "../../test/spyHandle";
import type { DirHandleLike } from "../fs/dirHandleLike";
import { createFsaFs, type FsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { loadGitConfig } from "./config";
import { hashBlob } from "./hash";
import { IgnoreRules } from "./ignoreRules";
import { type IndexSnapshot, readIndex } from "./indexReader";
import { type FlatTree, ObjectDb } from "./objectDb";
import { type ScannerOptions, WorktreeScanner, type WorktreeStatus } from "./worktree";

interface Rig {
  fs: FsaFs;
  db: ObjectDb;
  scanner: WorktreeScanner;
  index: IndexSnapshot;
  headTree: FlatTree | null;
  scan: (signal?: AbortSignal) => Promise<WorktreeStatus>;
  reload: () => Promise<void>;
}

async function rig(root: DirHandleLike, opts: ScannerOptions = {}): Promise<Rig> {
  const fs = createFsaFs(root);
  const cfg = await loadGitConfig(fs);
  const db = new ObjectDb(fs);
  const ignore = await IgnoreRules.load(fs, { builtinExcludes: false, config: cfg });
  const scanner = new WorktreeScanner(fs, db, cfg, ignore, opts);
  const r: Rig = {
    fs,
    db,
    scanner,
    index: await readIndex(fs),
    headTree: null,
    scan: (signal) => scanner.scan(r.index, r.headTree, signal),
    reload: async () => {
      r.index = await readIndex(fs);
      const head = await db.tryResolveRef("HEAD");
      r.headTree = head ? await db.flattenTree(head) : null;
    },
  };
  await r.reload();
  return r;
}

async function fixtureRig(name: string) {
  return rig(await NodeDirHandle.open(fixturePath(name)));
}

/** Expected shape from porcelain v2: staged (X), unstaged (Y), untracked, conflicts. */
function expectedFrom(entries: ExpectedStatusEntry[]) {
  const staged: Record<
    string,
    { oldOid: string | null; newOid: string | null; oldMode: number | null; newMode: number | null }
  > = {};
  const unstaged: Record<string, "M" | "D" | "A"> = {};
  const untracked: string[] = [];
  const conflicts: string[] = [];
  const nul = (o: string) => (/^0+$/.test(o) ? null : o);
  const mode = (m: string) => (m === "000000" ? null : Number.parseInt(m, 8));
  for (const e of entries) {
    if (e.type === "1" || e.type === "2") {
      const x = e.xy[0] as string;
      const y = e.xy[1] as string;
      if (x !== ".")
        staged[e.path] = {
          oldOid: nul(e.hH),
          newOid: nul(e.hI),
          oldMode: mode(e.mH),
          newMode: mode(e.mI),
        };
      if (y !== ".") unstaged[e.path] = y as "M" | "D" | "A";
    } else if (e.type === "?") untracked.push(e.path);
    else if (e.type === "u") conflicts.push(e.path);
  }
  return { staged, unstaged, untracked: untracked.sort(), conflicts: conflicts.sort() };
}

async function assertParity(
  name: string,
  status: WorktreeStatus,
  opts: { ignoreUntracked?: string[] } = {},
) {
  const exp = expectedFrom(loadExpected<ExpectedStatusEntry[]>(name, "status-porcelain-v2"));
  expect(status.staged).toEqual(exp.staged);
  expect(Object.keys(status.unstaged).sort()).toEqual(Object.keys(exp.unstaged).sort());
  for (const [path, y] of Object.entries(exp.unstaged)) {
    const c = status.unstaged[path];
    if (y === "D") expect(c?.newOid).toBeNull();
    else {
      const onDisk = await hashBlob(await Bun.file(`${fixturePath(name)}/${path}`).bytes());
      expect(c?.newOid).toBe(onDisk);
      if (y === "A") expect(c?.oldOid).toBeNull();
    }
  }
  const skip = new Set(opts.ignoreUntracked ?? []);
  expect(status.untracked).toEqual(
    exp.untracked.filter((p) => ![...skip].some((s) => p === s || p.startsWith(`${s}/`))),
  );
  expect(status.conflicts).toEqual(exp.conflicts);
}

describe("WorktreeScanner parity with git status --porcelain=v2", () => {
  test("worktree fixture: every case", async () => {
    const r = await fixtureRig("worktree");
    const s = await r.scan();
    await assertParity("worktree", s);
    // spot checks on the documented cases
    expect(s.staged["script.sh"]).toMatchObject({ oldMode: 0o100644, newMode: 0o100755 });
    expect(s.unstaged["script.sh"]).toBeUndefined(); // mode change: staged only
    expect(s.staged["both.txt"]).toBeDefined();
    expect(s.unstaged["both.txt"]).toBeDefined();
    expect(s.unstaged["reverted.txt"]?.newOid).toBe(
      r.headTree
        ? (await r.db.flattenTree(await r.db.resolveRef("main")))["reverted.txt"]?.oid
        : "",
    );
    expect(s.staged["reverted.txt"]).toBeUndefined();
    expect(s.unstaged["deleted-unstaged.txt"]?.newOid).toBeNull();
    expect(s.staged["deleted-staged.txt"]?.newOid).toBeNull();
    expect(s.untrackedInfo["untracked.txt"]?.oid).toBe(
      await hashBlob(await Bun.file(`${fixturePath("worktree")}/untracked.txt`).bytes()),
    );
    expect(s.warnings).toEqual([]);
  });

  test("index-v3: intent-to-add shows as unstaged added, not staged", async () => {
    const s = await (await fixtureRig("index-v3")).scan();
    await assertParity("index-v3", s);
    expect(s.staged["intent.txt"]).toBeUndefined();
    expect(s.unstaged["intent.txt"]).toMatchObject({ oldOid: null });
  });

  for (const name of ["index-v4", "symlink", "basic", "detached", "attributes"]) {
    test(`${name}`, async () => {
      await assertParity(name, await (await fixtureRig(name)).scan());
    });
  }

  test("conflict: conflicted path only in conflicts, never staged-deleted", async () => {
    const s = await (await fixtureRig("conflict")).scan();
    await assertParity("conflict", s);
    expect(s.conflicts).toEqual(["file.txt"]);
    expect(s.staged["file.txt"]).toBeUndefined();
    expect(s.unstaged["file.txt"]).toBeUndefined();
  });

  test("unborn: everything in the index is staged-added (headTree null)", async () => {
    const r = await fixtureRig("unborn");
    expect(r.headTree).toBeNull();
    const s = await r.scan();
    await assertParity("unborn", s);
    expect(Object.keys(s.staged).sort()).toEqual(["dir/second.txt", "first.txt"]);
    expect(s.untracked).toEqual(["untracked.txt"]);
  });

  test("submodule: gitlink is clean and its directory is not walked", async () => {
    const s = await (await fixtureRig("submodule")).scan();
    await assertParity("submodule", s);
    expect(s.unstaged.sub).toBeUndefined();
    expect(s.untracked).toEqual([]);
  });

  test("embedded: inner/.git pruned with EMBEDDED_REPO; other untracked files still listed", async () => {
    const s = await (await fixtureRig("embedded")).scan();
    await assertParity("embedded", s, { ignoreUntracked: ["inner"] });
    expect(s.warnings.map((w) => w.code)).toEqual(["EMBEDDED_REPO"]);
    expect(s.untracked).toContain("visible-untracked.txt");
  });

  test("crlf: AUTOCRLF warning emitted once", async () => {
    const s = await (await fixtureRig("crlf")).scan();
    expect(s.warnings.map((w) => w.code)).toEqual(["AUTOCRLF"]);
  });

  test("ignore: node_modules never opened; keep.log untracked; secret.txt and logs excluded", async () => {
    const spy = spyHandle(await NodeDirHandle.open(fixturePath("ignore")));
    const opened: string[] = [];
    const guarded: DirHandleLike = {
      kind: "directory",
      name: spy.name,
      async getDirectoryHandle(name) {
        opened.push(name);
        return spy.getDirectoryHandle(name);
      },
      getFileHandle: spy.getFileHandle.bind(spy),
      entries: spy.entries.bind(spy),
    };
    const s = await (await rig(guarded)).scan();
    await assertParity("ignore", s);
    expect(s.untracked).toEqual(["notes.txt", "src/keep.log"]);
    expect(opened).not.toContain("node_modules");
    expect(opened).not.toContain("build");
    // ignored-dir IS opened: it holds a tracked file that the unstaged pass must stat (git does the same)
  });
});

describe("WorktreeScanner caching, racy rule, force refresh, cancellation, caps", () => {
  async function memRig(name: string) {
    const snap = await snapshotFromDisk(fixturePath(name), "m", name, {
      exclude: (p) => p === "expected",
    });
    const mem = MemoryFs.fromSnapshot(snap);
    const r = await rig(mem.handle());
    return { mem, r, snap };
  }

  test("re-scan: touched-but-unchanged file is hashed once, then served from the stat cache", async () => {
    const { mem, r } = await memRig("basic");
    const first = await r.scan();
    expect(first.unstaged).toEqual({});
    // clean tree: stat data matches the index → nothing hashed at all
    expect(first.stats.hashed).toBe(0);
    expect(first.stats.statOnly).toBe(first.stats.indexEntries);
    mem.touch("README.md", r.index.indexMtimeMs + 10_000); // mtime changed, content same
    const second = await r.scan();
    expect(second.unstaged).toEqual({});
    expect(second.stats.hashed).toBe(1);
    const third = await r.scan();
    expect(third.stats.hashed).toBe(0);
    expect(third.stats.cacheHits).toBe(1);
  });

  test("racy-clean rule: same size, same mtime as the index write → hashed and detected", async () => {
    const { mem, r } = await memRig("basic");
    const entry = r.index.byPath["src/c.txt"];
    expect(entry).toBeDefined();
    const original = mem.readBytes("src/c.txt") as Uint8Array;
    const edited = new Uint8Array(original);
    edited[0] = edited[0] === 0x58 ? 0x59 : 0x58; // same size, different content
    // file mtime == index mtime: git distrusts the stat data and hashes
    mem.write("src/c.txt", edited, r.index.indexMtimeMs);
    const s = await r.scan();
    expect(s.unstaged["src/c.txt"]).toBeDefined();
    expect(s.unstaged["src/c.txt"]?.newOid).toBe(await hashBlob(edited));
  });

  test("stat heuristic (documented): same size + same recorded mtime, older than the index → assumed clean until force refresh", async () => {
    const { mem, r } = await memRig("basic");
    const entry = r.index.byPath["src/c.txt"];
    if (!entry) throw new Error("missing entry");
    const original = mem.readBytes("src/c.txt") as Uint8Array;
    const edited = new Uint8Array(original);
    edited[0] = edited[0] === 0x58 ? 0x59 : 0x58;
    mem.write("src/c.txt", edited, entry.mtimeSec * 1000 + Math.floor(entry.mtimeNsec / 1e6));
    const s = await r.scan();
    expect(s.unstaged["src/c.txt"]).toBeUndefined(); // R1 case
    r.scanner.forgetStatCache();
    const forced = await r.scan();
    expect(forced.unstaged["src/c.txt"]?.newOid).toBe(await hashBlob(edited));
    expect(forced.stats.hashed).toBe(forced.stats.indexEntries);
    // the forced result sticks: the cache now holds the real oid and later scans reuse it
    const later = await r.scan();
    expect(later.unstaged["src/c.txt"]?.newOid).toBe(await hashBlob(edited));
    expect(later.stats.cacheHits).toBeGreaterThan(0);
  });

  test("cancellation via AbortSignal rejects with CANCELLED", async () => {
    const r = await fixtureRig("basic");
    const ac = new AbortController();
    ac.abort();
    await expect(r.scan(ac.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });

  test("SPLIT_INDEX and INDEX_TOO_LARGE are thrown before any I/O", async () => {
    const r = await fixtureRig("basic");
    await expect(
      r.scanner.scan({ ...r.index, hasSplitIndex: true }, r.headTree),
    ).rejects.toMatchObject({ code: "SPLIT_INDEX" });
    await expect(r.scanner.scan({ ...r.index, tooLarge: true }, r.headTree)).rejects.toMatchObject({
      code: "INDEX_TOO_LARGE",
    });
  });

  test("untracked cap → UNTRACKED_CAPPED; INDEX_CHECKSUM warning surfaces; sparse dirs skipped", async () => {
    const { mem, r } = await memRig("basic");
    for (let i = 0; i < 12; i++) mem.write(`junk/f${i}.txt`, `${i}`);
    const capped = await new WorktreeScanner(
      r.fs,
      r.db,
      await loadGitConfig(r.fs),
      await IgnoreRules.load(r.fs, { builtinExcludes: false }),
      { maxUntracked: 5 },
    ).scan(r.index, r.headTree);
    expect(capped.untracked.length).toBe(5);
    expect(capped.warnings.map((w) => w.code)).toEqual(["UNTRACKED_CAPPED"]);

    const bad = await r.scan();
    expect(bad.warnings).toEqual([]);
    const withBadChecksum = await r.scanner.scan({ ...r.index, checksumOk: false }, r.headTree);
    expect(withBadChecksum.warnings.map((w) => w.code)).toEqual(["INDEX_CHECKSUM"]);

    // synthetic sparse index: "src" becomes an opaque directory entry
    const sparse: IndexSnapshot = {
      ...r.index,
      hasSparseIndex: true,
      entries: [
        ...r.index.entries.filter((e) => !e.path.startsWith("src/")),
        {
          ...(r.index.entries[0] as IndexSnapshot["entries"][number]),
          path: "src",
          mode: 0o40000,
          isSparseDir: true,
        },
      ],
      byPath: Object.fromEntries(
        Object.entries(r.index.byPath).filter(([p]) => !p.startsWith("src/")),
      ),
    };
    mem.write("src/untracked-in-sparse.txt", "x");
    const s = await r.scanner.scan(sparse, r.headTree);
    expect(s.warnings.map((w) => w.code)).toEqual(["SPARSE_INDEX"]);
    expect(s.untracked.some((p) => p.startsWith("src/"))).toBe(false);
    expect(Object.keys(s.staged).some((p) => p.startsWith("src/"))).toBe(false);
  });

  test("large untracked files above hashUntrackedUpTo keep oid null", async () => {
    const { mem, r } = await memRig("basic");
    mem.write("big.bin", new Uint8Array(2048));
    const s = await new WorktreeScanner(
      r.fs,
      r.db,
      await loadGitConfig(r.fs),
      await IgnoreRules.load(r.fs, { builtinExcludes: false }),
      { hashUntrackedUpTo: 1024 },
    ).scan(r.index, r.headTree);
    expect(s.untrackedInfo["big.bin"]).toMatchObject({ oid: null, size: 2048 });
  });

  test.skipIf(!hasFixture("perf-5k"))("perf-5k clean-tree scan < 800 ms", async () => {
    const r = await fixtureRig("perf-5k");
    const t0 = performance.now();
    const s = await r.scan();
    const ms = performance.now() - t0;
    console.log(
      `perf-5k worktree scan: ${ms.toFixed(0)} ms (hashed ${s.stats.hashed}, statOnly ${s.stats.statOnly}, dirs ${s.stats.walkedDirs}; budget 800 ms)`,
    );
    expect(s.unstaged).toEqual({});
    expect(s.untracked).toEqual([]);
    if (process.env.PERF_STRICT === "1") expect(ms).toBeLessThan(800);
  });
});
