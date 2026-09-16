import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { type EngineRig, openEngine } from "../../test/engineRig";
import {
  type ExpectedMeta,
  type ExpectedNameStatus,
  FIXTURES_ROOT,
  hasFixture,
  loadExpected,
} from "../../test/fixtures";
import type { FileDiff } from "../types";
import type { DiffComputation } from "./diffEngine";
import {
  detectRenames,
  type RenameLoader,
  sharedBytes,
  similarityPercent,
  sizesTooDifferent,
  spanhash,
} from "./renames";

const STRICT = process.env.PERF_STRICT === "1";
const enc = (s: string) => new TextEncoder().encode(s);

/** Content loader over a DiffComputation's sides table (what T3.4's contentLoader will do). */
function loaderFor(rig: EngineRig, comp: DiffComputation): RenameLoader {
  return async (file, side) => {
    const path = (side === "old" ? file.oldPath : file.newPath) as string;
    const s = comp.sides[path];
    if (side === "old") {
      if (!s?.old) throw new Error(`no old side for ${path}`);
      return rig.db.readBlob(s.old.oid);
    }
    const ref = s?.new;
    if (!ref) throw new Error(`no new side for ${path}`);
    if (ref.oid && (ref.kind === "tree" || ref.kind === "index")) return rig.db.readBlob(ref.oid);
    return rig.fs.readFile(`/${path}`);
  };
}

const letter = (f: FileDiff) =>
  f.status === "added" ? "A" : f.status === "deleted" ? "D" : f.status === "renamed" ? "R" : "M";
const summary = (files: FileDiff[]) =>
  files.map((f) => ({
    status: letter(f),
    oldPath: f.oldPath,
    newPath: f.newPath,
    similarity: f.similarity ?? null,
  }));
const fromExpected = (exp: ExpectedNameStatus[]) =>
  exp
    .map((e) => ({
      status: e.status === "T" ? "M" : e.status,
      oldPath: e.status === "A" ? null : e.oldPath,
      newPath: e.status === "D" ? null : e.newPath,
      similarity: e.similarity,
    }))
    .sort((a, b) =>
      ((a.newPath ?? a.oldPath) as string) < ((b.newPath ?? b.oldPath) as string) ? -1 : 1,
    );

function fake(partial: Partial<FileDiff> & { id: string }): FileDiff {
  return {
    oldPath: null,
    newPath: null,
    status: "added",
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

describe("spanhash scoring (git diffcore-delta)", () => {
  test("identical content scores 100, disjoint content 0, CRLF ignored in text", () => {
    const a = enc("line one\nline two\nline three\n");
    expect(
      similarityPercent(sharedBytes(spanhash(a, true), spanhash(a, true)), a.length, a.length),
    ).toBe(100);
    const b = enc("completely\ndifferent\n");
    expect(sharedBytes(spanhash(a, true), spanhash(b, true))).toBe(0);
    const crlf = enc("line one\r\nline two\r\nline three\r\n");
    const s1 = spanhash(a, true);
    const s2 = spanhash(crlf, true);
    expect([...s1.entries()].sort()).toEqual([...s2.entries()].sort());
    expect([...spanhash(crlf, false).keys()].sort()).not.toEqual([...s1.keys()].sort());
  });

  test("chunks split at 64 bytes and repeated chunks accumulate byte counts", () => {
    const chunk = "x".repeat(64);
    const s = spanhash(enc(chunk + chunk + chunk), true);
    expect(s.size).toBe(1);
    expect([...s.values()]).toEqual([192]);
    expect(sharedBytes(s, spanhash(enc(chunk), true))).toBe(64);
  });

  test("size pre-filter matches git's bound at the 50% threshold", () => {
    expect(sizesTooDifferent(100, 49, 50)).toBe(true);
    expect(sizesTooDifferent(100, 50, 50)).toBe(false);
    expect(sizesTooDifferent(0, 0, 50)).toBe(false);
    expect(similarityPercent(0, 10, 0)).toBe(0);
  });
});

describe("detectRenames on fixtures", () => {
  test("renames fixture: parity with git diff -M --name-status (similarity exact or ±5)", async () => {
    const rig = await openEngine("renames");
    const comp = await rig.engine.compute(rig.source("feature", "main", false));
    const t0 = performance.now();
    const res = await detectRenames(comp.files, loaderFor(rig, comp));
    const ms = performance.now() - t0;
    console.log(`renames fixture: detectRenames ${ms.toFixed(1)} ms`, res.stats);
    const expected = fromExpected(
      loadExpected<ExpectedNameStatus[]>("renames", "name-status-3dot"),
    );
    const got = summary(res.files);
    expect(got.map((g) => ({ ...g, similarity: null }))).toEqual(
      expected.map((e) => ({ ...e, similarity: null })),
    );
    for (let i = 0; i < got.length; i++) {
      const e = expected[i] as (typeof expected)[number];
      const g = got[i] as (typeof got)[number];
      if (e.similarity === null) expect(g.similarity).toBeNull();
      else {
        expect(Math.abs((g.similarity as number) - e.similarity)).toBeLessThanOrEqual(5);
        if (g.similarity !== e.similarity)
          console.log(`similarity deviates: ${g.newPath} ours=${g.similarity} git=${e.similarity}`);
      }
    }
    const similar = res.files.find((f) => f.newPath === "moved/similar.txt");
    expect(similar?.similarity).toBe(58); // git says R058; our spanhash reproduces it exactly
    expect(similar?.layers).toEqual(["committed"]);
    expect(similar?.id).toBe("moved/similar.txt");
    expect(res.files.find((f) => f.newPath === "other/b.txt")?.similarity).toBe(100);
    expect(res.files.find((f) => f.id === "moved/rewrite.txt")?.status).toBe("added");
    expect(res.files.find((f) => f.id === "rewrite.txt")?.status).toBe("deleted");
    expect(res.warnings).toEqual([]);
    expect(res.stats.exact).toBe(2);
    expect(res.stats.similar).toBe(1);
    if (STRICT) expect(ms).toBeLessThan(200);
  });

  test("every fixture with a feature branch matches git diff -M on the committed layer", async () => {
    const names = readdirSync(FIXTURES_ROOT).filter(
      (n) => !n.startsWith("_") && hasFixture(n) && n !== "perf-5k" && n !== "worktree-gitdir",
    );
    let checked = 0;
    for (const name of names) {
      let exp: ExpectedNameStatus[];
      try {
        exp = loadExpected<ExpectedNameStatus[]>(name, "name-status-3dot");
      } catch {
        continue;
      }
      const rig = await openEngine(name);
      const def = loadExpected<ExpectedMeta>(name, "meta").default as string;
      const local = rig.refs.refs.some((r) => r.name === def && !r.synthetic);
      const target = local ? def : `origin/${def}`;
      const comp = await rig.engine.compute(rig.source("feature", target, false));
      const res = await detectRenames(comp.files, loaderFor(rig, comp), {
        limit: rig.cfg.diff.renameLimit,
      });
      const got = summary(res.files);
      const want = fromExpected(exp);
      expect(got.map((g) => ({ ...g, similarity: null }))).toEqual(
        want.map((e) => ({ ...e, similarity: null })),
      );
      got.forEach((g, i) => {
        const e = want[i] as (typeof want)[number];
        if (e.similarity !== null)
          expect(Math.abs((g.similarity as number) - e.similarity)).toBeLessThanOrEqual(5);
      });
      checked++;
    }
    console.log(`rename parity checked on ${checked} fixtures`);
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  test("basic: candidates score below threshold → files returned untouched", async () => {
    const rig = await openEngine("basic");
    const comp = await rig.engine.compute(rig.source("feature", "main", false));
    const res = await detectRenames(comp.files, loaderFor(rig, comp));
    expect(res.files).toBe(comp.files); // same array: nothing paired (git agrees: no R entries)
    expect(res.files.some((f) => f.status === "renamed")).toBe(false);
    expect(
      loadExpected<ExpectedNameStatus[]>("basic", "name-status-3dot").some((e) => e.status === "R"),
    ).toBe(false);
  });
});

describe("detectRenames synthetic cases", () => {
  const contents = new Map<string, Uint8Array>();
  const load: RenameLoader = async (f, side) => {
    const b = contents.get(`${side}:${side === "old" ? f.oldPath : f.newPath}`);
    if (!b) throw new Error("missing content");
    return b;
  };
  const del = (path: string, text: string, extra: Partial<FileDiff> = {}) => {
    contents.set(`old:${path}`, enc(text));
    return fake({
      id: path,
      oldPath: path,
      status: "deleted",
      oldSize: text.length,
      newMode: null,
      ...extra,
    });
  };
  const add = (path: string, text: string, extra: Partial<FileDiff> = {}) => {
    contents.set(`new:${path}`, enc(text));
    return fake({
      id: path,
      newPath: path,
      status: "added",
      newSize: text.length,
      oldMode: null,
      ...extra,
    });
  };
  const body = (seed: string) =>
    Array.from({ length: 20 }, (_, i) => `${seed} line ${i + 1}`).join("\n") + "\n";

  test("renameLimit² rule: 40×40 with limit 30 → RENAME_LIMIT warning, exact pass still runs", async () => {
    const files: FileDiff[] = [];
    for (let i = 0; i < 40; i++) {
      files.push(del(`old/${i}.txt`, body(`f${i}`)));
      files.push(add(`new/${i}.txt`, body(`f${i}`).replace("line 1\n", "line one\n")));
    }
    files.push(del("exact/a.txt", "same\n", { oldOid: "a".repeat(40) }));
    files.push(add("exact/b.txt", "same\n", { newOid: "a".repeat(40) }));
    const res = await detectRenames(files, load, { limit: 30 });
    expect(res.warnings.map((w) => w.code)).toEqual(["RENAME_LIMIT"]);
    expect(res.stats.exact).toBe(1);
    expect(res.stats.similar).toBe(0);
    expect(res.files.filter((f) => f.status === "renamed").map((f) => f.id)).toEqual([
      "exact/b.txt",
    ]);
    const ok = await detectRenames(files, load, { limit: 40 });
    expect(ok.warnings).toEqual([]);
    expect(ok.stats.similar).toBe(40);
    expect(ok.files.every((f) => f.status === "renamed")).toBe(true);
  });

  test("untracked added file pairs with a staged deletion; layers are the union in canonical order", async () => {
    const files = [
      del("src/a.txt", body("k"), { layers: ["staged"] }),
      add("lib/a.txt", body("k"), { layers: ["untracked"], newOid: null }),
    ];
    const res = await detectRenames(files, load);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({
      id: "lib/a.txt",
      status: "renamed",
      similarity: 100,
      oldPath: "src/a.txt",
      newPath: "lib/a.txt",
      layers: ["staged", "untracked"],
    });
    expect(res.stats.exact).toBe(1); // hashed lazily, then paired by oid
  });

  test("exact pass prefers the same basename; symlinks only pair with symlinks", async () => {
    const files = [
      del("a/keep.txt", "dup\n", { oldOid: "b".repeat(40) }),
      del("a/other.txt", "dup\n", { oldOid: "b".repeat(40) }),
      add("b/other.txt", "dup\n", { newOid: "b".repeat(40) }),
      del("link", "target", { oldOid: "c".repeat(40), oldMode: 0o120000 }),
      add("file", "target", { newOid: "c".repeat(40), newMode: 0o100644 }),
    ];
    const res = await detectRenames(files, load);
    const r = res.files.find((f) => f.status === "renamed");
    expect(r).toMatchObject({ oldPath: "a/other.txt", newPath: "b/other.txt" });
    expect(res.files.map((f) => `${letter(f)} ${f.id}`).sort()).toEqual([
      "A file",
      "D a/keep.txt",
      "D link",
      "R b/other.txt",
    ]);
  });

  test("below-threshold pair stays D+A; custom threshold pairs it", async () => {
    const files = [
      del("x.txt", body("keep")),
      add("y.txt", body("keep").replace(/line (1[0-9]|20)/g, "zzz $1")),
    ];
    const strict = await detectRenames(files, load, { threshold: 90 });
    expect(strict.files.map((f) => f.status)).toEqual(["deleted", "added"]);
    const loose = await detectRenames(files, load, { threshold: 30 });
    expect(loose.files).toHaveLength(1);
    expect(loose.files[0]?.similarity).toBeGreaterThanOrEqual(30);
  });

  test("maxSideBytes skips oversized pairs with a RENAME_LIMIT warning", async () => {
    const files = [del("big-old.txt", body("big")), add("big-new.txt", body("big"))];
    const res = await detectRenames(files, load, { maxSideBytes: 10 });
    expect(res.files.map((f) => f.status)).toEqual(["deleted", "added"]);
    expect(res.warnings.map((w) => w.detail)).toEqual(["maxSideBytes"]);
  });

  test("aborted signal → CANCELLED", async () => {
    const files = [del("p.txt", body("p")), add("q.txt", body("p"))];
    const ac = new AbortController();
    ac.abort();
    await expect(detectRenames(files, load, { signal: ac.signal })).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});
