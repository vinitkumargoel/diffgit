import { describe, expect, test } from "bun:test";
import * as Comlink from "comlink";
import { type ExpectedRefs, fixturePath, hasFixture, loadExpected } from "../test/fixtures";
import { snapshotFromDisk } from "../test/memorySnapshot";
import { dropRoot, swapPack } from "../test/torn";
import type { Progress, ProgressSink, StatsBatch } from "./api";
import { defaultDiffSource } from "./diffSource";
import { EngineError, fsError } from "./errors";
import { bytesToBase64, MemoryFs } from "./fs/memoryDirHandle";
import { NodeDirHandle } from "./fs/nodeDirHandle";
import { RepoSession, toPublicError } from "./session";
import type { RepoWarning } from "./types";
import { createEngineApi } from "./workerApi";

const STRICT = process.env.PERF_STRICT === "1";

function sink() {
  const progress: Progress[] = [];
  const batches: StatsBatch[] = [];
  const warnings: RepoWarning[] = [];
  const s: ProgressSink = {
    onProgress: (p) => void progress.push(p),
    onStats: (b) => void batches.push(b),
    onWarning: (w) => void warnings.push(w),
  };
  return { s, progress, batches, warnings };
}

async function openFixture(name: string) {
  const k = sink();
  const session = await RepoSession.open(await NodeDirHandle.open(fixturePath(name)), k.s, {
    id: `test-${name}`,
  });
  return { session, ...k };
}

async function openMemory(name: string) {
  const snap = await snapshotFromDisk(fixturePath(name), `${name}-snap`, name, {
    exclude: (p) => p === "expected",
  });
  const mem = MemoryFs.fromSnapshot(snap);
  const k = sink();
  const session = await RepoSession.open(mem.handle(name), k.s, { id: `mem-${name}` });
  return { session, mem, snap, ...k };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
async function waitFor(pred: () => boolean, ms = 5000) {
  const t0 = performance.now();
  while (!pred()) {
    if (performance.now() - t0 > ms) throw new Error("timed out waiting");
    await settle();
  }
}

describe("toPublicError", () => {
  test("maps fs-tier and DOM errors to public codes, passes public codes through", () => {
    expect(toPublicError(new EngineError("REF_NOT_FOUND", "nope", { hint: "h" }))).toEqual({
      name: "EngineError",
      code: "REF_NOT_FOUND",
      message: "nope",
      hint: "h",
    });
    expect(toPublicError(fsError("EACCES", "/x")).code).toBe("PERMISSION");
    expect(toPublicError(fsError("ENOENT", "/x")).code).toBe("IO_ERROR");
    expect(toPublicError(fsError("ENOENT", "/x"), true).code).toBe("HANDLE_GONE");
    expect(toPublicError(fsError("EIO", "/x")).code).toBe("IO_ERROR");
    expect(toPublicError(fsError("EROFS", "/x")).code).toBe("INTERNAL");
    expect(toPublicError(new EngineError("SPLIT_INDEX", "internal tier")).code).toBe("INTERNAL");
    expect(toPublicError(new DOMException("denied", "NotAllowedError")).code).toBe("PERMISSION");
    expect(toPublicError(new DOMException("gone", "NotFoundError")).code).toBe("HANDLE_GONE");
    expect(toPublicError(new Error("boom"))).toMatchObject({ code: "INTERNAL", message: "boom" });
    expect(toPublicError("str")).toMatchObject({ code: "INTERNAL", message: "str" });
    expect(JSON.parse(JSON.stringify(toPublicError(fsError("EACCES", "/p")))).path).toBe("/p");
  });
});

describe("RepoSession on fixtures", () => {
  test("worktree: open → computeDiff → stats → fileDiff → fileBytes, STALE after recompute", async () => {
    const { session, progress, batches, warnings } = await openFixture("worktree");
    const info = await session.info();
    expect(info).toMatchObject({
      id: "test-worktree",
      name: "worktree",
      headBranch: "feature",
      detached: false,
      unborn: false,
    });
    expect(info.refs.map((r) => r.name)).toContain("main");
    expect(info.capabilities.indexVersion).toBe(2);
    expect(info.headOid).toBe(loadExpected<ExpectedRefs>("worktree", "refs").headOid as string);
    expect(progress.map((p) => p.phase)).toEqual(["config", "layout", "refs", "index"]);

    const src = defaultDiffSource(info);
    expect(src).toMatchObject({ source: "feature", target: "main", includeWorktree: true });
    const res = await session.computeDiff(src);
    expect(res.generation).toBe(1);
    expect(res.files.map((f) => f.id)).toEqual([
      "both.txt",
      "deleted-staged.txt",
      "deleted-unstaged.txt",
      "feature-only.txt",
      "newdir/untracked2.txt",
      "script.sh",
      "staged-mod.txt",
      "staged-new.txt",
      "unstaged-mod.txt",
      "untracked.txt",
    ]);
    expect(res.totals.files).toBe(10);
    expect(res.warnings).toEqual([]);
    expect(progress.filter((p) => p.phase === "diff")).toHaveLength(1);
    expect(progress.filter((p) => p.phase === "renames")).toHaveLength(1);

    // background stats arrive through the sink for every file, stamped with the generation
    await waitFor(
      () => Object.keys(Object.assign({}, ...batches.map((b) => b.stats))).length === 10,
    );
    expect(batches.every((b) => b.generation === 1)).toBe(true);
    const all = Object.assign({}, ...batches.map((b) => b.stats)) as Record<
      string,
      { additions: number; deletions: number } | null
    >;
    expect(all["both.txt"]).toEqual({ additions: 2, deletions: 0 });
    expect(all["deleted-staged.txt"]).toEqual({ additions: 0, deletions: 1 });
    expect(all["untracked.txt"]?.additions).toBeGreaterThan(0);
    const direct = await session.fileStats(1, ["both.txt", "script.sh"]);
    expect(direct["both.txt"]).toEqual({ additions: 2, deletions: 0 });
    expect(direct["script.sh"]).toEqual({ additions: 0, deletions: 0 }); // mode-only change
    expect(progress.some((p) => p.phase === "stats" && p.total === 10)).toBe(true);

    const payload = await session.fileDiff(1, "both.txt", { ignoreWhitespace: false });
    expect(payload).toMatchObject({
      id: "both.txt",
      generation: 1,
      language: "text",
      oldMode: 0o100644,
      newMode: 0o100644,
    });
    expect(payload.classification).toMatchObject({
      binary: false,
      image: false,
      tooLarge: false,
      changedLines: 2,
    });
    expect(payload.hunks?.hunks).toHaveLength(1);
    expect(payload.hunks?.hunks[0]?.lines.filter((l) => l.type === "add")).toHaveLength(2);
    expect(payload.newText).toBe(await session.fs.readText("/both.txt"));
    const bytes = await session.fileBytes(1, "both.txt", "new");
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(payload.newText as string);
    expect(await session.fileBytes(1, "untracked.txt", "old")).toBeNull();
    expect(await session.fileBytes(1, "deleted-staged.txt", "new")).toBeNull();

    // renamed files load both sides; the deleted+untracked pair here differ, so none expected
    expect(res.files.some((f) => f.status === "renamed")).toBe(false);

    const again = await session.computeDiff(src);
    expect(again.generation).toBe(2);
    await expect(
      session.fileDiff(1, "both.txt", { ignoreWhitespace: false }),
    ).rejects.toMatchObject({ code: "STALE" });
    await expect(session.fileStats(1, ["both.txt"])).rejects.toMatchObject({ code: "STALE" });
    await expect(session.fileBytes(1, "both.txt", "new")).rejects.toMatchObject({ code: "STALE" });
    await expect(
      session.fileDiff(2, "nope.txt", { ignoreWhitespace: false }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(warnings).toEqual([]);
    await session.close();
    await expect(session.computeDiff(src)).rejects.toMatchObject({ code: "INTERNAL" });
  });

  test("fileBytes refuses sides over 10 MB with TOO_LARGE (large fixture, huge.txt)", async () => {
    const { session } = await openFixture("large");
    const info = await session.info();
    const res = await session.computeDiff(defaultDiffSource(info));
    expect(res.files.some((f) => f.id === "huge.txt")).toBe(true);
    await expect(session.fileBytes(res.generation, "huge.txt", "new")).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
    expect(
      toPublicError(await session.fileBytes(res.generation, "huge.txt", "new").catch((e) => e)),
    ).toMatchObject({ code: "TOO_LARGE", path: "huge.txt" });
    const medium = await session.fileBytes(res.generation, "medium.txt", "new");
    expect(medium?.byteLength).toBeGreaterThan(1024 * 1024);
    await session.close();
  });

  test("binary fixture: image/binary classification and raw bytes for the image viewer", async () => {
    const { session, batches } = await openFixture("binary");
    const info = await session.info();
    const res = await session.computeDiff(defaultDiffSource(info));
    const png = await session.fileDiff(res.generation, "img/logo.png", { ignoreWhitespace: false });
    expect(png.classification).toMatchObject({ binary: true, image: true });
    expect(png.hunks).toBeNull();
    expect(png.stats).toBeNull();
    const bytes = await session.fileBytes(res.generation, "img/logo.png", "new");
    expect([...(bytes as Uint8Array).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const svg = await session.fileDiff(res.generation, "img/icon.svg", { ignoreWhitespace: false });
    expect(svg.classification).toMatchObject({ binary: false, image: true });
    expect(svg.hunks?.hunks).toHaveLength(1);
    const bin = await session.fileDiff(res.generation, "data/blob.bin", {
      ignoreWhitespace: false,
    });
    expect(bin.classification.binary).toBe(true);
    await waitFor(
      () =>
        Object.keys(Object.assign({}, ...batches.map((b) => b.stats))).length === res.files.length,
    );
    const all = Object.assign({}, ...batches.map((b) => b.stats)) as Record<string, unknown>;
    expect(all["img/logo.png"]).toBeNull();
    expect(all["img/icon.svg"]).toEqual({ additions: 1, deletions: 1 });
    // the FileDiff rows were refined in place with binary/image/sizes
    const row = res.files.find((f) => f.id === "img/logo.png");
    expect(row?.binary).toBe(true);
    expect(row?.newSize).toBeGreaterThan(0);
    await session.close();
  });

  test("renames fixture: renamed entries appear in the DiffResult and diff old→new content", async () => {
    const { session } = await openFixture("renames");
    const res = await session.computeDiff(defaultDiffSource(await session.info()));
    const r = res.files.find((f) => f.id === "moved/similar.txt");
    expect(r).toMatchObject({ status: "renamed", oldPath: "similar.txt", similarity: 58 });
    const payload = await session.fileDiff(res.generation, "moved/similar.txt", {
      ignoreWhitespace: false,
    });
    expect(payload.stats).toEqual({ additions: 8, deletions: 8 });
    expect(payload.oldText?.startsWith("similar 1")).toBe(true);
    await session.close();
  });

  test("overlapping computeDiff: the first rejects CANCELLED, the second resolves", async () => {
    const { session } = await openFixture("worktree");
    const src = defaultDiffSource(await session.info());
    const p1 = session.computeDiff(src);
    const p2 = session.computeDiff(src);
    await expect(p1).rejects.toMatchObject({ code: "CANCELLED" });
    const r2 = await p2;
    expect(r2.generation).toBe(2);
    expect(r2.files).toHaveLength(10);
    await session.close();
  });

  test("layout fatals surface as public codes from open()", async () => {
    const k = sink();
    if (hasFixture("sha256")) {
      await expect(
        RepoSession.open(await NodeDirHandle.open(fixturePath("sha256")), k.s),
      ).rejects.toMatchObject({ code: "OBJECT_FORMAT_SHA256" });
    }
    const empty = MemoryFs.fromEntries({ "README.md": "not a repo\n" });
    await expect(RepoSession.open(empty.handle("plain"), k.s)).rejects.toMatchObject({
      code: "NOT_A_REPO",
    });
  });
});

describe("RepoSession on memory repos (mutations)", () => {
  test("invalidate('worktree') after editing a file → the next compute sees the change", async () => {
    const { session, mem } = await openMemory("worktree");
    const src = defaultDiffSource(await session.info());
    const first = await session.computeDiff(src);
    const before = first.files.find((f) => f.id === "unstaged-mod.txt");
    mem.apply([
      {
        op: "write",
        path: "unstaged-mod.txt",
        text: "totally new content\nline 2\nline 3\n",
        mtime: Date.now() + 60_000,
      },
    ]);
    await session.invalidate("worktree", ["unstaged-mod.txt"]);
    const second = await session.computeDiff(src);
    const after = second.files.find((f) => f.id === "unstaged-mod.txt");
    expect(after?.newOid).not.toBe(before?.newOid);
    expect(after?.newOid).toMatch(/^[0-9a-f]{40}$/);
    const payload = await session.fileDiff(second.generation, "unstaged-mod.txt", {
      ignoreWhitespace: false,
    });
    expect(payload.newText).toBe("totally new content\nline 2\nline 3\n");
    await session.invalidate("all");
    await session.forceRehash();
    const third = await session.computeDiff(src);
    expect(third.files.find((f) => f.id === "unstaged-mod.txt")?.newOid).toBe(
      after?.newOid as string,
    );
    await session.close();
  });

  test("R1: a same-size same-mtime edit is missed by the stat cache and caught by forceRehash", async () => {
    const { session, mem } = await openMemory("worktree");
    const src = defaultDiffSource(await session.info());
    const first = await session.computeDiff(src);
    const before = first.files.find((f) => f.id === "unstaged-mod.txt");
    expect(before).toBeDefined();
    const original = mem.readBytes("unstaged-mod.txt") as Uint8Array;
    const entry = mem.lookup("unstaged-mod.txt");
    const mtime = entry && entry.kind === "file" ? entry.mtime : 0;
    // flip one byte, keep the size and the mtime → git's own heuristic cannot see it either
    const edited = new Uint8Array(original);
    edited[0] = edited[0] === 65 ? 66 : 65;
    mem.apply([{ op: "write", path: "unstaged-mod.txt", b64: bytesToBase64(edited), mtime }]);
    // no observer told us about this path: a plain recompute trusts the stat cache (git does too)
    const second = await session.computeDiff(src);
    expect(second.files.find((f) => f.id === "unstaged-mod.txt")?.newOid).toBe(
      before?.newOid as string,
    );
    await session.forceRehash();
    const third = await session.computeDiff(src);
    const after = third.files.find((f) => f.id === "unstaged-mod.txt");
    expect(after?.newOid).not.toBe(before?.newOid);
    expect(
      new TextDecoder().decode(
        (await session.fileBytes(third.generation, "unstaged-mod.txt", "new")) as Uint8Array,
      ),
    ).toBe(new TextDecoder().decode(edited));
    await session.close();
  });

  test("pack renamed mid-session (git gc) → compute recovers; ENOENT mid-compute retries once with STALE_PACK_RETRIED", async () => {
    const { session, mem, snap, warnings } = await openMemory("packed");
    const src = defaultDiffSource(await session.info());
    const first = await session.computeDiff(src);
    expect(first.files.length).toBeGreaterThan(0);
    mem.apply(swapPack(snap));
    const second = await session.computeDiff(src);
    expect(second.files.map((f) => f.id)).toEqual(first.files.map((f) => f.id));
    const natural = [...second.warnings.map((w) => w.code), ...warnings.map((w) => w.code)];
    expect(natural.every((c) => c === "STALE_PACK_RETRIED")).toBe(true);

    // Force the session-level path: the first attempt dies with ENOENT inside object reads.
    const engine = session.engine;
    const orig = engine.compute.bind(engine);
    let calls = 0;
    engine.compute = async (s, signal) => {
      if (calls++ === 0) throw fsError("ENOENT", "/.git/objects/pack/pack-dead.pack");
      return orig(s, signal);
    };
    const third = await session.computeDiff(src);
    expect(calls).toBe(2);
    expect(third.files.map((f) => f.id)).toEqual(first.files.map((f) => f.id));
    expect(third.warnings.map((w) => w.code)).toEqual(["STALE_PACK_RETRIED"]);

    // A persistent failure is not retried forever and keeps its (translated) code.
    engine.compute = async () => {
      throw fsError("EACCES", "/.git/objects");
    };
    await expect(session.computeDiff(src)).rejects.toMatchObject({ code: "EACCES" });
    expect(toPublicError(await session.computeDiff(src).catch((e) => e)).code).toBe("PERMISSION");
    await session.close();
  });

  test("root disappears → HANDLE_GONE", async () => {
    const { session, mem } = await openMemory("basic");
    const src = defaultDiffSource(await session.info());
    await session.computeDiff(src);
    mem.apply(dropRoot());
    await session.invalidate("all");
    await expect(session.computeDiff(src)).rejects.toMatchObject({ code: "HANDLE_GONE" });
    await session.close();
  });

  test("probe tiers: stable signatures that change on the right mutations", async () => {
    const { session, mem, progress } = await openMemory("worktree");
    await session.computeDiff(defaultDiffSource(await session.info()));
    const git1 = await session.probe("git");
    const idx1 = await session.probe("index");
    const unt1 = await session.probe("untracked");
    expect(await session.probe("git")).toBe(git1);
    expect(await session.probe("index")).toBe(idx1);
    expect(await session.probe("untracked")).toBe(unt1);
    expect(git1.startsWith("git:")).toBe(true);
    expect(idx1.startsWith("index:")).toBe(true);
    expect(unt1.startsWith("untracked:2:")).toBe(true); // untracked.txt + newdir/untracked2.txt

    mem.apply([{ op: "touch", path: ".git/HEAD", mtime: Date.now() + 120_000 }]);
    expect(await session.probe("git")).not.toBe(git1);
    expect(await session.probe("index")).toBe(idx1);

    mem.apply([{ op: "write", path: "brand-new.txt", text: "hello\n", mtime: Date.now() }]);
    const unt2 = await session.probe("untracked");
    expect(unt2).not.toBe(unt1);
    expect(unt2.startsWith("untracked:3:")).toBe(true);
    mem.apply([{ op: "write", path: "unstaged-mod.txt", text: "edited\n", mtime: Date.now() }]);
    expect(await session.probe("untracked")).toBe(unt2); // tracked edits do not move the untracked tier
    expect(await session.probe("index")).toBe(idx1); // nor the index tier
    const probes = progress.filter((p) => p.phase === "probe");
    expect(probes.every((p) => typeof p.durationMs === "number" && p.tier !== undefined)).toBe(
      true,
    );
    await session.close();
  });

  test("perf-5k probe timing per tier", async () => {
    if (!hasFixture("perf-5k")) return;
    const { session } = await openFixture("perf-5k");
    const times: Record<string, number> = {};
    for (const tier of ["git", "index", "untracked"] as const) {
      const t0 = performance.now();
      await session.probe(tier);
      times[tier] = performance.now() - t0;
    }
    console.log("perf-5k probe ms:", times);
    if (STRICT) {
      expect(times.git as number).toBeLessThan(30);
      expect(times.index as number).toBeLessThan(300);
      expect(times.untracked as number).toBeLessThan(600);
    }
    await session.close();
  });
});

describe("worker boundary (comlink over a MessageChannel)", () => {
  test("errors arrive as plain objects with a public code; calls round-trip", async () => {
    const { port1, port2 } = new MessageChannel();
    const api = createEngineApi({
      resolve: async (h) => NodeDirHandle.open(fixturePath(String(h))),
      session: { id: "wire" },
    });
    Comlink.expose(api, port1);
    const remote = Comlink.wrap<typeof api>(port2);
    try {
      let err: unknown;
      try {
        await remote.info();
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err instanceof Error).toBe(false);
      expect(err).toMatchObject({ code: "INTERNAL", name: "EngineError" });
      const k = sink();
      const info = await remote.open("basic", Comlink.proxy(k.s));
      expect(info).toMatchObject({ id: "wire", name: "basic", headBranch: "feature" });
      const res = await remote.computeDiff(defaultDiffSource(info));
      expect(res.files.length).toBeGreaterThan(0);
      const payload = await remote.fileDiff(res.generation, res.files[0]?.id as string, {
        ignoreWhitespace: false,
      });
      expect(payload.generation).toBe(res.generation);
      let stale: unknown;
      try {
        await remote.fileDiff(res.generation + 1, res.files[0]?.id as string, {
          ignoreWhitespace: false,
        });
      } catch (e) {
        stale = e;
      }
      expect(stale).toMatchObject({ code: "STALE" });
      let missing: unknown;
      try {
        await remote.computeDiff({
          ...defaultDiffSource(info),
          sourceRef: "refs/heads/nope",
          source: "nope",
        });
      } catch (e) {
        missing = e;
      }
      expect(missing).toMatchObject({ code: "REF_NOT_FOUND" });
      await waitFor(() => k.progress.some((p) => p.phase === "stats"));
      await remote.close();
    } finally {
      remote[Comlink.releaseProxy]();
      port1.close();
      port2.close();
    }
  });
});
