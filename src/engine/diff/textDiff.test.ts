import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { type EngineRig, openEngine } from "../../test/engineRig";
import {
  type ExpectedMeta,
  type ExpectedNumstat,
  FIXTURES_ROOT,
  hasFixture,
  loadExpected,
} from "../../test/fixtures";
import { GitAttributes } from "../git/attributes";
import type { FileDiff } from "../types";
import { isBinary, isImagePath } from "./binary";
import { loadSides } from "./contentLoader";
import type { DiffComputation } from "./diffEngine";
import { languageFor } from "./language";
import { detectRenames } from "./renames";
import {
  computeHunks,
  computeStats,
  describeFile,
  hunksFromOps,
  isTypeChange,
  lineDiff,
  lineKeys,
  splitLines,
  toPayload,
} from "./textDiff";

const STRICT = process.env.PERF_STRICT === "1";
const enc = (s: string) => new TextEncoder().encode(s);
const contents = (a: string | null, b: string | null) => ({
  old: a === null ? null : enc(a),
  new: b === null ? null : enc(b),
});

async function committed(name: string, withRenames = true) {
  const rig = await openEngine(name);
  const def = loadExpected<ExpectedMeta>(name, "meta").default as string;
  const target = rig.refs.refs.some((r) => r.name === def && !r.synthetic) ? def : `origin/${def}`;
  const comp = await rig.engine.compute(rig.source("feature", target, false));
  const attrs = await GitAttributes.load(rig.fs);
  const src = { db: rig.db, fs: rig.fs };
  let files = comp.files;
  if (withRenames) {
    files = (
      await detectRenames(files, async (f, side) => {
        const bytes =
          side === "old"
            ? (await loadSides(f, comp.sides, src)).old
            : (await loadSides(f, comp.sides, src)).new;
        return bytes ?? new Uint8Array();
      })
    ).files;
  }
  return { rig, comp, attrs, src, files };
}

async function describe1(
  ctx: {
    rig: EngineRig;
    comp: DiffComputation;
    attrs: GitAttributes;
    src: { db: EngineRig["db"]; fs: EngineRig["fs"] };
  },
  f: FileDiff,
  opts: { ignoreWhitespace?: boolean; loadLarge?: boolean; statsOnly?: boolean } = {},
) {
  const loaded = await loadSides(f, ctx.comp.sides, ctx.src);
  const path = (f.newPath ?? f.oldPath) as string;
  return describeFile(f, loaded, {
    ignoreWhitespace: opts.ignoreWhitespace ?? false,
    loadLarge: opts.loadLarge,
    statsOnly: opts.statsOnly,
    attrBinary: await ctx.attrs.isBinary(path),
    attrGenerated: await ctx.attrs.isGenerated(path),
  });
}

describe("line primitives", () => {
  test("splitLines follows git: trailing newline is not an extra line, missing one is flagged", () => {
    expect(splitLines("")).toEqual({ lines: [], noEol: false });
    expect(splitLines("a\n")).toEqual({ lines: ["a"], noEol: false });
    expect(splitLines("a")).toEqual({ lines: ["a"], noEol: true });
    expect(splitLines("a\n\n")).toEqual({ lines: ["a", ""], noEol: false });
  });

  test("lineKeys: -w strips all whitespace incl. CR and the missing-EOL marker", () => {
    const a = splitLines("  x = 1;\r\n\ty\n");
    expect(lineKeys(a, true)).toEqual(["x=1;", "y"]);
    expect(lineKeys(a, false)).toEqual(["  x = 1;\r", "\ty"]);
    const noEol = splitLines("a");
    expect(lineKeys(noEol, false)[0]).not.toBe("a");
    expect(lineKeys(noEol, true)).toEqual(["a"]);
    expect(computeStats(contents("a\n", "a"), { ignoreWhitespace: false })).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(computeStats(contents("a\n", "a"), { ignoreWhitespace: true })).toEqual({
      additions: 0,
      deletions: 0,
    });
  });

  test("lineDiff strips common prefix/suffix and reports ops with positions", () => {
    const ops = lineDiff(["a", "b", "c", "d"], ["a", "x", "c", "d"]);
    expect(ops).toEqual([
      { type: "eq", oldStart: 0, newStart: 0, count: 1 },
      { type: "del", oldStart: 1, newStart: 1, count: 1 },
      { type: "add", oldStart: 2, newStart: 1, count: 1 },
      { type: "eq", oldStart: 2, newStart: 2, count: 2 },
    ]);
    expect(lineDiff([], [])).toEqual([]);
    expect(lineDiff(["a"], ["a"])).toEqual([{ type: "eq", oldStart: 0, newStart: 0, count: 1 }]);
    expect(lineDiff([], ["a", "b"])).toEqual([{ type: "add", oldStart: 0, newStart: 0, count: 2 }]);
  });

  test("hunks: context, merging of nearby changes, line numbers, empty sides", () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
    const newLines = oldLines.slice();
    newLines[4] = "changed5";
    newLines.splice(10, 0, "inserted"); // between l10 and l11
    newLines[25] = "changed25"; // far away → separate hunk (gap > 6)
    const model = computeHunks(contents(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`), {
      ignoreWhitespace: false,
    });
    expect(model.oldLines).toBe(30);
    expect(model.newLines).toBe(31);
    expect(model.hunks).toHaveLength(2);
    const h1 = model.hunks[0] as (typeof model.hunks)[number];
    expect(h1).toMatchObject({ oldStart: 2, oldCount: 12, newStart: 2, newCount: 13 });
    expect(h1.lines.map((l) => l.type[0]).join("")).toBe("cccdacccccaccc");
    expect(h1.lines[3]).toEqual({ type: "del", old: 5, text: "l5" });
    expect(h1.lines[4]).toEqual({ type: "add", new: 5, text: "changed5" });
    expect(h1.lines[10]).toEqual({ type: "add", new: 11, text: "inserted" });
    expect(h1.lines[13]).toEqual({ type: "ctx", old: 13, new: 14, text: "l13" });
    const h2 = model.hunks[1] as (typeof model.hunks)[number];
    expect(h2).toMatchObject({ oldStart: 22, oldCount: 7, newStart: 23, newCount: 7 });
    expect(h2.lines[h2.lines.length - 1]).toEqual({ type: "ctx", old: 28, new: 29, text: "l28" });

    const added = computeHunks(contents(null, "a\nb\n"), { ignoreWhitespace: false });
    expect(added.hunks).toEqual([
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "add", new: 1, text: "a" },
          { type: "add", new: 2, text: "b" },
        ],
      },
    ]);
    const deleted = computeHunks(contents("a\n", null), { ignoreWhitespace: false });
    expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 1, newStart: 0, newCount: 0 });
    expect(hunksFromOps([], [], [], 3)).toEqual([]);
    expect(computeHunks(contents("same\n", "same\n"), { ignoreWhitespace: false }).hunks).toEqual(
      [],
    );
  });

  test("whitespace-only change: exact stats non-zero, -w stats zero, no hunks, whitespaceOnly", () => {
    const file = fakeFile("a.ts");
    const loaded = { ...contents("x = 1\n  y = 2\n", "x  = 1\n\ty = 2\n"), kind: "file" as const };
    const exact = describeFile(file, loaded, { ignoreWhitespace: false });
    expect(exact.stats).toEqual({ additions: 2, deletions: 2 });
    expect(exact.classification.whitespaceOnly).toBe(true);
    expect(exact.hunks?.hunks).toHaveLength(1);
    expect(exact.hunks?.hunks[0]?.lines.map((l) => l.text)).toEqual([
      "x = 1",
      "  y = 2",
      "x  = 1",
      "\ty = 2",
    ]);
    const w = describeFile(file, loaded, { ignoreWhitespace: true });
    expect(w.stats).toEqual({ additions: 0, deletions: 0 });
    expect(w.hunks?.hunks).toEqual([]);
    expect(w.classification.whitespaceOnly).toBe(true);
    expect(w.classification.changedLines).toBe(0);
    expect(w.oldText).toBe("x = 1\n  y = 2\n"); // originals, not normalised
  });
});

function fakeFile(path: string, partial: Partial<FileDiff> = {}): FileDiff {
  return {
    id: path,
    oldPath: path,
    newPath: path,
    status: "modified",
    layers: ["committed"],
    oldOid: null,
    newOid: null,
    oldMode: 0o100644,
    newMode: 0o100644,
    binary: false,
    image: false,
    oldSize: 0,
    newSize: 0,
    stats: null,
    tooLarge: false,
    ...partial,
  };
}

describe("classification helpers", () => {
  test("isBinary / isImagePath / isTypeChange / languageFor", () => {
    expect(isBinary(enc("plain"))).toBe(false);
    expect(isBinary(new Uint8Array([65, 0, 66]))).toBe(true);
    const late = new Uint8Array(9000);
    late.fill(65);
    late[8500] = 0;
    expect(isBinary(late)).toBe(false); // NUL after 8000 bytes is not seen, like git
    expect(isImagePath("img/logo.PNG")).toBe(true);
    expect(isImagePath("icon.svg")).toBe(true);
    expect(isImagePath("a.txt")).toBe(false);
    expect(isTypeChange(0o100644, 0o100755)).toBe(false);
    expect(isTypeChange(0o120000, 0o100644)).toBe(true);
    expect(isTypeChange(null, 0o100644)).toBe(false);
    expect(isTypeChange(0o100644, 0o160000)).toBe(true);
    expect(languageFor("src/App.tsx")).toBe("tsx");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("deploy/Makefile")).toBe("makefile");
    expect(languageFor("x.unknownext")).toBe("text");
    expect(languageFor("LICENSE")).toBe("text");
    expect(languageFor("a/b/c.py")).toBe("python");
    expect(languageFor(".gitmodules")).toBe("ini");
  });
});

describe("numstat parity", () => {
  test("every fixture: stats equal git numstat (exact) and numstat -w", async () => {
    const names = readdirSync(FIXTURES_ROOT).filter(
      (n) => !n.startsWith("_") && hasFixture(n) && n !== "perf-5k" && n !== "worktree-gitdir",
    );
    let checked = 0;
    for (const name of names) {
      let exp: ExpectedNumstat[];
      let expW: ExpectedNumstat[];
      try {
        exp = loadExpected<ExpectedNumstat[]>(name, "numstat");
        expW = loadExpected<ExpectedNumstat[]>(name, "numstat-w");
      } catch {
        continue;
      }
      const ctx = await committed(name);
      for (const [label, expected, ignoreWhitespace] of [
        ["numstat", exp, false],
        ["numstat -w", expW, true],
      ] as const) {
        const got = [];
        for (const f of ctx.files) {
          const d = await describe1(ctx, f, { ignoreWhitespace, statsOnly: true });
          got.push({
            additions: d.stats?.additions ?? null,
            deletions: d.stats?.deletions ?? null,
            path: (f.newPath ?? f.oldPath) as string,
            oldPath: f.status === "renamed" ? f.oldPath : null,
          });
        }
        const want = expected
          .map((e) => ({ ...e, oldPath: e.oldPath ?? null }))
          .sort((a, b) => (a.path < b.path ? -1 : 1));
        got.sort((a, b) => (a.path < b.path ? -1 : 1));
        if (JSON.stringify(got) !== JSON.stringify(want)) console.log(`${name} ${label} mismatch`);
        expect(got).toEqual(want);
      }
      checked++;
    }
    console.log(`numstat parity checked on ${checked} fixtures`);
    expect(checked).toBeGreaterThanOrEqual(15);
  }, 30_000);
});

describe("classification on fixtures", () => {
  test("binary fixture: .bin, PNGs and the file that gains a NUL are binary; SVG is a text image", async () => {
    const ctx = await committed("binary");
    const byId = Object.fromEntries(ctx.files.map((f) => [f.id, f]));
    const bin = await describe1(ctx, byId["data/blob.bin"] as FileDiff);
    expect(bin.classification.binary).toBe(true);
    expect(bin.hunks).toBeNull();
    expect(bin.stats).toBeNull();
    const png = await describe1(ctx, byId["img/logo.png"] as FileDiff);
    expect(png.classification).toMatchObject({ binary: true, image: true });
    const added = await describe1(ctx, byId["img/new.png"] as FileDiff);
    expect(added.classification).toMatchObject({ binary: true, image: true, oldSize: 0 });
    expect(added.classification.newSize).toBeGreaterThan(0);
    const svg = await describe1(ctx, byId["img/icon.svg"] as FileDiff);
    expect(svg.classification).toMatchObject({ binary: false, image: true });
    expect(svg.stats).toEqual({ additions: 1, deletions: 1 });
    expect(svg.language).toBe("xml");
    const nul = await describe1(ctx, byId["text/becomes-binary.txt"] as FileDiff);
    expect(nul.classification.binary).toBe(true);
    expect(nul.oldText).toBeNull();
  });

  test("attributes fixture: -diff/binary → binary, linguist-generated → generated", async () => {
    const ctx = await committed("attributes");
    const byId = Object.fromEntries(ctx.files.map((f) => [f.id, f]));
    expect((await describe1(ctx, byId["data.dat"] as FileDiff)).classification).toMatchObject({
      binary: true,
      generated: true,
    });
    expect((await describe1(ctx, byId["deps.lock"] as FileDiff)).classification).toMatchObject({
      binary: true,
      generated: true,
    });
    const gen = await describe1(ctx, byId["generated/out.js"] as FileDiff);
    expect(gen.classification).toMatchObject({ binary: false, generated: true });
    expect(gen.stats).toEqual({ additions: 2, deletions: 0 });
    expect(gen.language).toBe("javascript");
    expect((await describe1(ctx, byId["notes.txt"] as FileDiff)).classification).toMatchObject({
      binary: false,
      generated: false,
    });
  });

  test("large fixture: 3000 changed lines and 1.5 MB gate as tooLarge; 11 MB is huge with a warning", async () => {
    const ctx = await committed("large");
    const byId = Object.fromEntries(ctx.files.map((f) => [f.id, f]));
    const t0 = performance.now();
    const big = await describe1(ctx, byId["big-change.txt"] as FileDiff);
    const bigMs = performance.now() - t0;
    expect(big.classification).toMatchObject({ tooLarge: true, huge: false, changedLines: 6000 });
    expect(big.hunks).toBeNull();
    expect(big.stats).toEqual({ additions: 3000, deletions: 3000 });
    const t1 = performance.now();
    const bigLoaded = await describe1(ctx, byId["big-change.txt"] as FileDiff, { loadLarge: true });
    const hunkMs = performance.now() - t1;
    console.log(
      `big-change.txt: describe ${bigMs.toFixed(1)} ms, with hunks ${hunkMs.toFixed(1)} ms`,
    );
    expect(bigLoaded.hunks?.hunks).toHaveLength(1);
    expect(bigLoaded.hunks?.hunks[0]?.lines).toHaveLength(6006);
    if (STRICT) expect(hunkMs).toBeLessThan(300);
    const medium = await describe1(ctx, byId["medium.txt"] as FileDiff);
    expect(medium.classification).toMatchObject({ tooLarge: true, huge: false, changedLines: 1 });
    expect(medium.classification.oldSize).toBeGreaterThan(1024 * 1024);
    expect(medium.hunks).toBeNull();
    const huge = await describe1(ctx, byId["huge.txt"] as FileDiff, { loadLarge: true });
    expect(huge.classification).toMatchObject({ huge: true, tooLarge: true, changedLines: 200000 });
    expect(huge.hunks).toBeNull();
    expect(huge.stats).toEqual({ additions: 200000, deletions: 0 });
    expect(huge.warning?.code).toBe("FILE_TOO_LARGE");
    expect(huge.oldText).toBeNull();
  });

  test("symlink fixture: link2 is a typechange; hunks show the link target text", async () => {
    const ctx = await committed("symlink");
    const byId = Object.fromEntries(ctx.files.map((f) => [f.id, f]));
    const link = await describe1(ctx, byId.link as FileDiff);
    expect(link.classification.typechange).toBe(false);
    expect(link.hunks?.hunks[0]?.lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      "del:target.txt",
      "add:other.txt",
    ]);
    const link2 = await describe1(ctx, byId.link2 as FileDiff);
    expect(link2.classification.typechange).toBe(true);
    expect(link2.hunks?.hunks[0]?.lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      "del:target.txt",
      "add:now a regular file",
    ]);
    expect(link2.stats).toEqual({ additions: 1, deletions: 1 });
  });

  test("submodule fixture: gitlink has no bytes, renders Subproject commit lines", async () => {
    const ctx = await committed("submodule");
    const sub = ctx.files.find((f) => f.id === "sub") as FileDiff;
    const loaded = await loadSides(sub, ctx.comp.sides, ctx.src);
    expect(loaded).toMatchObject({ kind: "submodule", old: null, new: null });
    expect(loaded.submodule?.oldOid).toMatch(/^[0-9a-f]{40}$/);
    expect(loaded.submodule?.oldOid).not.toBe(loaded.submodule?.newOid);
    const d = await describe1(ctx, sub);
    expect(d.classification.submodule).toBe(true);
    expect(d.stats).toEqual({ additions: 1, deletions: 1 });
    expect(d.hunks?.hunks[0]?.lines.map((l) => l.text)).toEqual([
      `Subproject commit ${sub.oldOid}`,
      `Subproject commit ${sub.newOid}`,
    ]);
    const payload = toPayload(sub, d, 7);
    expect(payload).toMatchObject({
      id: "sub",
      generation: 7,
      oldMode: 0o160000,
      newMode: 0o160000,
    });
    expect(payload.submodule).toEqual({ oldOid: sub.oldOid, newOid: sub.newOid });
  });

  test("crlf fixture: exact and -w both report 1/1 (CR is whitespace, the word changed)", async () => {
    const ctx = await committed("crlf");
    const dos = ctx.files.find((f) => f.id === "dos.txt") as FileDiff;
    const exact = await describe1(ctx, dos);
    expect(exact.stats).toEqual({ additions: 1, deletions: 1 });
    expect(exact.hunks?.hunks[0]?.lines.find((l) => l.type === "add")?.text).toBe(
      "line two changed\r",
    );
    const w = await describe1(ctx, dos, { ignoreWhitespace: true });
    expect(w.stats).toEqual({ additions: 1, deletions: 1 });
    expect(w.classification.whitespaceOnly).toBe(false);
  });

  test("worktree fixture: loader reads index and worktree sides; renamed files load old/new from their own paths", async () => {
    const rig = await openEngine("worktree");
    const comp = await rig.engine.compute(rig.source("feature", "main", true));
    const src = { db: rig.db, fs: rig.fs };
    const byId = Object.fromEntries(comp.files.map((f) => [f.id, f]));
    const both = await loadSides(byId["both.txt"] as FileDiff, comp.sides, src);
    expect(new TextDecoder().decode(both.new as Uint8Array)).toBe(
      await rig.fs.readText("/both.txt"),
    );
    expect(both.old).not.toBeNull();
    const staged = await loadSides(byId["staged-mod.txt"] as FileDiff, comp.sides, src);
    expect(staged.new).toEqual(
      await rig.db.readBlob((byId["staged-mod.txt"] as FileDiff).newOid as string),
    );
    const untracked = await loadSides(byId["untracked.txt"] as FileDiff, comp.sides, src);
    expect(untracked.old).toBeNull();
    expect(untracked.new?.length).toBeGreaterThan(0);
    const del = await loadSides(byId["deleted-staged.txt"] as FileDiff, comp.sides, src);
    expect(del.new).toBeNull();
    expect(del.old?.length).toBeGreaterThan(0);
    const renamed: FileDiff = {
      ...(byId["untracked.txt"] as FileDiff),
      id: "untracked.txt",
      status: "renamed",
      oldPath: "deleted-staged.txt",
      similarity: 100,
    };
    const r = await loadSides(renamed, comp.sides, src);
    expect(r.old).toEqual(del.old);
    expect(r.new).toEqual(untracked.new);
  });
});
