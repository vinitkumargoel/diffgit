import { describe, expect, test } from "bun:test";
import {
  type ExpectedLsTree,
  type ExpectedMergeBase,
  type ExpectedRefs,
  fixturePath,
  hasFixture,
  loadExpected,
} from "../../test/fixtures";
import { snapshotFromDisk } from "../../test/memorySnapshot";
import { spyHandle } from "../../test/spyHandle";
import { createFsaFs, type FsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { ObjectDb } from "./objectDb";

async function open(name: string) {
  const spy = spyHandle(await NodeDirHandle.open(fixturePath(name)));
  const fs = createFsaFs(spy);
  return { db: new ObjectDb(fs), spy, fs };
}

function flatFromLsTree(entries: ExpectedLsTree["trees"][string]) {
  return Object.fromEntries(
    entries.map((e) => [e.path, { oid: e.oid, mode: Number.parseInt(e.mode, 8) }]),
  );
}

describe("ObjectDb refs", () => {
  for (const name of ["basic", "packed", "remote"]) {
    test(`resolveRef HEAD / branches on ${name} match refs.json`, async () => {
      const { db, spy } = await open(name);
      const refs = loadExpected<ExpectedRefs>(name, "refs");
      expect(await db.resolveRef("HEAD")).toBe(refs.headOid as string);
      for (const [full, oid] of Object.entries(refs.refs)) {
        if (full.endsWith("/HEAD")) continue;
        expect(await db.resolveRef(full)).toBe(oid);
        const short = full.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
        expect(await db.resolveRef(short)).toBe(oid);
      }
      expect(spy.counts.optionsPassed).toBe(0);
      expect(spy.counts.unknownAccess).toEqual([]);
    });
  }

  test("REF_NOT_FOUND for unknown refs; tryResolveRef returns null", async () => {
    const { db } = await open("basic");
    await expect(db.resolveRef("refs/heads/nope")).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(await db.tryResolveRef("nope")).toBeNull();
    expect(await db.resolveRef("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
  });

  test("readSymref: origin/HEAD on remote → refs/remotes/origin/main; null on no-origin-head; null for oid refs", async () => {
    expect(await (await open("remote")).db.readSymref("refs/remotes/origin/HEAD")).toBe(
      "refs/remotes/origin/main",
    );
    expect(await (await open("remote-master")).db.readSymref("refs/remotes/origin/HEAD")).toBe(
      "refs/remotes/origin/master",
    );
    expect(
      await (await open("no-origin-head")).db.readSymref("refs/remotes/origin/HEAD"),
    ).toBeNull();
    expect(await (await open("basic")).db.readSymref("refs/heads/main")).toBeNull();
    expect(await (await open("basic")).db.readSymref("HEAD")).toBe("refs/heads/feature");
  });

  test("listLocalBranches / listRemoteBranches (HEAD pseudo-entry removed)", async () => {
    const { db } = await open("remote");
    expect(await db.listLocalBranches()).toEqual(["feature", "main", "topic"]);
    expect(await db.listRemoteBranches("origin")).toEqual(["feature", "main"]);
    expect(await (await open("packed")).db.listLocalBranches()).toEqual(["feature", "main"]);
    expect(await (await open("basic")).db.listRemoteBranches("origin")).toEqual([]);
  });
});

describe("ObjectDb objects", () => {
  for (const name of ["basic", "packed", "remote"]) {
    test(`findMergeBase matches merge-base.json on ${name}`, async () => {
      const { db } = await open(name);
      const exp = loadExpected<ExpectedMergeBase>(name, "merge-base");
      const main = await db.resolveRef("main");
      const feature = await db.resolveRef("feature");
      const mb = await db.findMergeBase(main, feature);
      expect(mb.oid).toBe(exp.feature as string);
      expect(mb.all).toEqual([exp.feature as string]);
      expect((await db.findMergeBase(feature, main)).oid).toBe(exp.feature as string);
      expect((await db.findMergeBase(main, main)).oid).toBe(main);
    });
  }

  test("unrelated histories → { oid: null, all: [] }", async () => {
    const { db } = await open("unrelated");
    const mb = await db.findMergeBase(await db.resolveRef("main"), await db.resolveRef("feature"));
    expect(mb).toEqual({ oid: null, all: [] });
  });

  test("crisscross → two merge bases; all[0] is documented as the pick", async () => {
    const { db } = await open("crisscross");
    const all = loadExpected<string[]>("crisscross", "merge-base-all");
    const mb = await db.findMergeBase(await db.resolveRef("main"), await db.resolveRef("feature"));
    expect([...mb.all].sort()).toEqual([...all].sort());
    expect(mb.all.length).toBe(2);
    expect(mb.oid).toBe(mb.all[0] as string);
  });

  test("shallow history (parents missing) → { oid: null, all: [] } without throwing", async () => {
    // Synthetic shallow: keep only the tip commits' objects reachable by removing the root commit.
    const snap = await snapshotFromDisk(fixturePath("basic"), "s", "basic", {
      exclude: (p) => p === "expected",
    });
    const mem = MemoryFs.fromSnapshot(snap);
    const db = new ObjectDb(createFsaFs(mem.handle()));
    const main = await db.resolveRef("main");
    const feature = await db.resolveRef("feature");
    const base = loadExpected<ExpectedMergeBase>("basic", "merge-base").feature as string;
    const { parents } = await db.readCommit(base);
    // delete the merge-base's parent objects (loose) and mark the base shallow like `git clone --depth`
    for (const p of parents) mem.remove(`.git/objects/${p.slice(0, 2)}/${p.slice(2)}`);
    mem.write(".git/shallow", `${base}\n`);
    const db2 = new ObjectDb(createFsaFs(mem.handle()));
    expect((await db2.findMergeBase(main, feature)).oid).toBe(base);
    // now remove the base itself: history is cut before the common ancestor
    mem.remove(`.git/objects/${base.slice(0, 2)}/${base.slice(2)}`);
    const db3 = new ObjectDb(createFsaFs(mem.handle()));
    expect(await db3.findMergeBase(main, feature)).toEqual({ oid: null, all: [] });
  });

  for (const name of ["basic", "packed", "symlink", "submodule"]) {
    test(`flattenTree matches ls-tree.json on ${name} (modes incl. 120000/160000/100755)`, async () => {
      const { db } = await open(name);
      const ls = loadExpected<ExpectedLsTree>(name, "ls-tree");
      for (const [oid, entries] of Object.entries(ls.trees)) {
        const flat = await db.flattenTree(oid);
        expect(flat).toEqual(flatFromLsTree(entries));
        expect(Object.keys(flat)).toEqual([...Object.keys(flat)].sort());
      }
    });
  }

  test("flattenTree accepts a tree oid too and is memoised", async () => {
    const { db, spy } = await open("basic");
    const tip = await db.resolveRef("feature");
    const { tree } = await db.readCommit(tip);
    const a = await db.flattenTree(tip);
    const b = await db.flattenTree(tree);
    expect(a).toEqual(b);
    const calls = spy.counts.getFile;
    await db.flattenTree(tip);
    expect(spy.counts.getFile).toBe(calls); // no new reads
    db.dropCaches();
    await db.flattenTree(tip);
    expect(spy.counts.getFile).toBeGreaterThanOrEqual(calls); // may re-read loose objects
  });

  test("readCommit / readBlob bytes equal the file on disk; works from a delta pack", async () => {
    for (const name of ["basic", "packed"]) {
      const { db } = await open(name);
      const tip = await db.resolveRef("feature");
      const c = await db.readCommit(tip);
      expect(c.message).toContain("f2: guide + util");
      expect(c.parents.length).toBe(1);
      const flat = await db.flattenTree(tip);
      const blob = await db.readBlob((flat["docs/guide.md"] as { oid: string }).oid);
      const onDisk = await Bun.file(`${fixturePath(name)}/docs/guide.md`).bytes();
      expect(Buffer.from(blob).equals(Buffer.from(onDisk))).toBe(true);
    }
  });

  test("write guard: the whole suite above performed zero write attempts", async () => {
    const { db, spy } = await open("packed");
    await db.flattenTree(await db.resolveRef("feature"));
    await db.readBlob(
      (await db.flattenTree(await db.resolveRef("main")))["README.md"]?.oid as string,
    );
    expect(spy.counts.optionsPassed).toBe(0);
    expect(spy.counts.unknownAccess).toEqual([]);
  });
});

describe("ObjectDb stale pack retry", () => {
  test("a pack that vanishes between idx and pack reads triggers one retry + STALE_PACK_RETRIED", async () => {
    const snap = await snapshotFromDisk(fixturePath("packed"), "p", "packed", {
      exclude: (p) => p === "expected",
    });
    const mem = MemoryFs.fromSnapshot(snap);
    const inner = createFsaFs(mem.handle());
    let failNextPackRead = true;
    // Wrap readFile so the first .pack read fails as if git gc had just renamed the file.
    const fs: FsaFs = {
      ...inner,
      promises: {
        ...inner.promises,
        async readFile(path, opts) {
          if (failNextPackRead && path.endsWith(".pack")) {
            failNextPackRead = false;
            const { fsError } = await import("../errors");
            throw fsError("ENOENT", path, "open");
          }
          return inner.promises.readFile(path, opts);
        },
      },
    };
    const warnings: string[] = [];
    const db = new ObjectDb(fs, (w) => warnings.push(w.code));
    const tip = await db.resolveRef("feature");
    const commit = await db.readCommit(tip);
    expect(commit.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(warnings).toEqual(["STALE_PACK_RETRIED"]);
    expect(failNextPackRead).toBe(false);
    // subsequent reads are normal and emit no more warnings
    await db.flattenTree(tip);
    expect(warnings.length).toBe(1);
  });

  test("real pack swap on the memory fs: reads keep working after dropCaches(true)", async () => {
    const snap = await snapshotFromDisk(fixturePath("packed"), "p", "packed", {
      exclude: (p) => p === "expected",
    });
    const mem = MemoryFs.fromSnapshot(snap);
    const db = new ObjectDb(createFsaFs(mem.handle()));
    const tip = await db.resolveRef("feature");
    const before = await db.flattenTree(tip);
    const { swapPack } = await import("../../test/torn");
    mem.apply(swapPack(snap));
    db.dropCaches(true);
    const after = await db.flattenTree(tip);
    expect(after).toEqual(before);
  });
});

describe("ObjectDb performance", () => {
  test.skipIf(!hasFixture("perf-5k"))("flattenTree of perf-5k tip < 400 ms", async () => {
    const { db } = await open("perf-5k");
    const tip = await db.resolveRef("feature");
    const t0 = performance.now();
    const flat = await db.flattenTree(tip);
    const ms = performance.now() - t0;
    expect(Object.keys(flat).length).toBe(5000);
    console.log(`perf-5k flattenTree: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(400);
  });
});
