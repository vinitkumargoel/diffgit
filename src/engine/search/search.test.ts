/**
 * T10.8: `RepoSession.search` against git's own answers on the `history` fixture.
 *
 * Every oracle is written by `scripts/fixture-expectations.sh` (`search_oracles`) from the real git
 * CLI, and the assertions are **set equality**, not "contains":
 *
 *   - commits  → `git log -i -F --grep` / `--author` (and one `-i -E` for regex mode);
 *   - worktree → `git grep -in` (case-insensitive, which is what the engine always is), with the
 *     case-sensitive `git grep -n` asserted as a subset;
 *   - pickaxe  → `git log --first-parent -S` (and `--pickaxe-regex` for regex mode), with
 *     `git log --first-parent -G` asserted as a superset, because a changed occurrence count
 *     implies a changed line but not the other way round.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, hasFixture, loadExpectedLines } from "../../test/fixtures";
import { snapshotFromDisk } from "../../test/memorySnapshot";
import type { Progress, ProgressSink } from "../api";
import { errorCode } from "../errors";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { RepoWarning, SearchRequest, SearchResult } from "../types";
import { WORKTREE_HIT_SUBJECT } from "./pickaxe";
import { createMatcher, REGEX_FILE_BUDGET_MS, type SearchOutcome } from "./query";
import { searchWorktree } from "./worktree";

const FIXTURE = "history";
/** Wide enough that nothing in the fixture is ever cut, so a cap in a result is a real one. */
const WIDE: Pick<SearchRequest, "limit" | "commits"> = { limit: 5000, commits: 5000 };

interface Rig {
  session: RepoSession;
  warnings: RepoWarning[];
  progress: Progress[];
  close: () => Promise<void>;
}

async function open(name: string, id: string): Promise<Rig> {
  const warnings: RepoWarning[] = [];
  const progress: Progress[] = [];
  const sink: ProgressSink = {
    onProgress: (p) => void progress.push(p),
    onStats() {},
    onWarning: (w) => void warnings.push(w),
  };
  const session = await RepoSession.open(await NodeDirHandle.open(fixturePath(name)), sink, { id });
  return { session, warnings, progress, close: () => session.close() };
}

/** One rig for the whole read-only parity suite; every test here only reads. */
const rig = await open(FIXTURE, "search-history");

function oids(result: SearchResult): string[] {
  return result.hits.map((h) => h.oid ?? WORKTREE_HIT_SUBJECT).sort();
}

function expectedOids(file: string): string[] {
  return loadExpectedLines(FIXTURE, file).sort();
}

/** `path:line:text` as `git grep -n` prints it; the text may itself contain colons. */
function grepRows(file: string): { path: string; line: number; text: string }[] {
  return loadExpectedLines(FIXTURE, file).map((l) => {
    const first = l.indexOf(":");
    const second = l.indexOf(":", first + 1);
    return {
      path: l.slice(0, first),
      line: Number(l.slice(first + 1, second)),
      text: l.slice(second + 1),
    };
  });
}

function hitRows(result: SearchResult): { path: string; line: number; text: string }[] {
  return result.hits.map((h) => ({
    path: h.path as string,
    line: h.line as number,
    text: h.text as string,
  }));
}

function key(r: { path: string; line: number }): string {
  return `${r.path}:${r.line}`;
}

// ---- commit scope ------------------------------------------------------------------------------

describe("commit search equals git log --grep / --author", () => {
  test.each([
    ["extend mod", "log-grep-extend-mod"],
    // Parentheses prove exact mode is a literal: as a regex this would match `choredeps` too.
    ["CHORE(DEPS)", "log-grep-chore-deps"],
  ])("--grep %p", async (query, file) => {
    const out = await rig.session.search({ scope: "commits", query, ...WIDE });
    expect(oids(out)).toEqual(expectedOids(file));
    expect(out.hits.every((h) => h.kind === "commit" && typeof h.subject === "string")).toBe(true);
  });

  test.each([
    ["ada@example.com", "log-author-ada"],
    ["[bot]", "log-author-bot"],
    ["Grace Hopper", "log-author-grace"],
  ])("--author %p", async (query, file) => {
    const out = await rig.session.search({ scope: "commits", query, ...WIDE });
    expect(oids(out)).toEqual(expectedOids(file));
  });

  test("author search reads the raw author header, not the .mailmap identity (T10.9)", async () => {
    const out = await rig.session.search({ scope: "commits", query: "ada@example.com", ...WIDE });
    const mapped = loadExpectedLines(FIXTURE, "log-author-ada-mailmap");
    const raw = loadExpectedLines(FIXTURE, "log-author-ada");
    // git's own `--use-mailmap` answer is a strict superset; folding the two addresses together
    // belongs to T10.9, which owns `.mailmap`.
    expect(mapped.length).toBeGreaterThan(raw.length);
    const found = new Set(out.hits.map((h) => h.oid));
    for (const oid of raw) expect(found.has(oid)).toBe(true);
    expect(found.size).toBe(raw.length);
  });

  test("regex mode equals git log -i -E --grep", async () => {
    const out = await rig.session.search({
      scope: "commits",
      query: "^c[0-9]+: extend mod[13]$",
      regex: true,
      ...WIDE,
    });
    expect(oids(out)).toEqual(expectedOids("log-grep-regex-extend"));
  });

  test("a SHA prefix finds exactly the commit it names", async () => {
    const all = loadExpectedLines(FIXTURE, "log-main-date-order");
    const target = all[7] as string;
    const out = await rig.session.search({
      scope: "commits",
      query: target.slice(0, 8),
      ...WIDE,
    });
    expect(out.hits.map((h) => h.oid)).toEqual([target]);
    // The full oid works too, and a prefix shorter than `isOidPrefix` accepts is plain text.
    const full = await rig.session.search({ scope: "commits", query: target, ...WIDE });
    expect(full.hits.map((h) => h.oid)).toEqual([target]);
  });

  test("subject, author and body are all searched, and nothing matches nonsense", async () => {
    const none = await rig.session.search({ scope: "commits", query: "zzz-not-here", ...WIDE });
    expect(none.hits).toEqual([]);
    expect(none.capped).toBe(false);
    expect(none.scanned).toBeGreaterThanOrEqual(60);
  });

  test("the hit limit caps the list and raises SEARCH_CAPPED", async () => {
    const before = rig.warnings.length;
    const out = await rig.session.search({
      scope: "commits",
      query: "extend mod",
      limit: 3,
      commits: 5000,
    });
    expect(out.hits.length).toBe(3);
    expect(out.capped).toBe(true);
    // The head of the walk order: a capped page is still the newest matches, in order.
    const full = await rig.session.search({ scope: "commits", query: "extend mod", ...WIDE });
    expect(out.hits).toEqual(full.hits.slice(0, 3));
    const capped = rig.warnings.slice(before).filter((w) => w.code === "SEARCH_CAPPED");
    expect(capped.length).toBe(1);
    expect(capped[0]?.detail).toContain("the first 3 matching commits");
  });

  test("the commit cap stops the walk and says so", async () => {
    const out = await rig.session.search({
      scope: "commits",
      query: "extend mod",
      limit: 5000,
      commits: 10,
    });
    expect(out.scanned).toBe(10);
    expect(out.capped).toBe(true);
    // The ten newest commits of `git log --date-order` are all that was looked at.
    const newest = new Set(loadExpectedLines(FIXTURE, "log-main-date-order").slice(0, 10));
    for (const h of out.hits) expect(newest.has(h.oid as string)).toBe(true);
  });

  test("progress is reported under the `search` phase", async () => {
    const before = rig.progress.length;
    await rig.session.search({ scope: "commits", query: "extend mod", ...WIDE });
    const phases = rig.progress.slice(before);
    expect(phases.length).toBeGreaterThan(1);
    expect(phases.every((p) => p.phase === "search" || p.phase === "history")).toBe(true);
    expect(phases[phases.length - 1]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---- working-tree scope ------------------------------------------------------------------------

describe("working-tree grep equals git grep -in", () => {
  test.each([
    ["guide", undefined, "grep-i-guide"],
    ["module", undefined, "grep-i-module"],
    ["hot", "src", "grep-i-hot-src"],
  ])("grep %p (path %p)", async (query, path, file) => {
    const req: SearchRequest = {
      scope: "worktree",
      query,
      ...(path !== undefined ? { path } : {}),
      ...WIDE,
    };
    const out = await rig.session.search(req);
    expect(hitRows(out)).toEqual(grepRows(file));
    expect(out.capped).toBe(false);
    expect(out.scanned).toBeGreaterThan(0);
  });

  test("regex mode equals git grep -inE", async () => {
    const out = await rig.session.search({
      scope: "worktree",
      query: "moved [0-9]+",
      regex: true,
      ...WIDE,
    });
    expect(hitRows(out)).toEqual(grepRows("grep-i-regex-moved"));
  });

  test("the case-sensitive `git grep -n` answer is a subset of ours", async () => {
    const out = await rig.session.search({ scope: "worktree", query: "Guide", ...WIDE });
    const ours = new Set(hitRows(out).map(key));
    const sensitive = grepRows("grep-Guide");
    expect(sensitive.length).toBeGreaterThan(0);
    for (const row of sensitive) expect(ours.has(key(row))).toBe(true);
    // `-in guide` finds strictly more, which is the point of being case-insensitive.
    expect(ours.size).toBeGreaterThan(sensitive.length);
  });

  test("hits are ordered by path then line, and the limit keeps the first of them", async () => {
    const full = await rig.session.search({ scope: "worktree", query: "module", ...WIDE });
    const sorted = [...hitRows(full)].sort(
      (a, b) => a.path.localeCompare(b.path) || a.line - b.line,
    );
    expect(hitRows(full)).toEqual(sorted);
    // The limit is applied after a whole batch, so the head is exactly the head of the full list.
    const capped = await rig.session.search({
      scope: "worktree",
      query: "module",
      limit: 5,
      commits: 5000,
    });
    expect(capped.hits.length).toBe(5);
    expect(capped.capped).toBe(true);
    expect(hitRows(capped)).toEqual(hitRows(full).slice(0, 5));
  });

  test("hit text is the line itself, trimmed of its carriage return", async () => {
    const out = await rig.session.search({ scope: "worktree", query: "# Guide", ...WIDE });
    expect(out.hits).toEqual([{ kind: "file", path: "docs/guide.md", line: 1, text: "# Guide" }]);
  });
});

// ---- pickaxe scope -----------------------------------------------------------------------------

describe("pickaxe equals git log --first-parent -S", () => {
  test.each([
    ["module", "log-S-fp-module"],
    ["guide note", "log-S-fp-guide-note"],
    // The merge commit: under `--first-parent` git diffs it against its mainline and reports it.
    ["topic work", "log-S-fp-topic-work"],
    ["moved", "log-S-fp-moved"],
    ["version", "log-S-fp-version"],
    ["hot-main", "log-S-hot-main"],
    ["renamed payload marker", "log-S-payload"],
  ])("-S %p", async (query, file) => {
    const out = await rig.session.search({ scope: "pickaxe", query, ...WIDE });
    expect(oids(out)).toEqual(expectedOids(file));
    expect(out.hits.every((h) => h.kind === "commit" && typeof h.delta === "number")).toBe(true);
  });

  test.each([
    ["src/mod1.txt", "log-S-fp-module-mod1"],
    ["src", "log-S-fp-module-src"],
  ])("-S module -- %p", async (path, file) => {
    const out = await rig.session.search({ scope: "pickaxe", query: "module", path, ...WIDE });
    expect(oids(out)).toEqual(expectedOids(file));
  });

  test("regex mode equals git log --first-parent -S … --pickaxe-regex", async () => {
    const out = await rig.session.search({
      scope: "pickaxe",
      query: "module [0-9]",
      regex: true,
      ...WIDE,
    });
    expect(oids(out)).toEqual(expectedOids("log-S-fp-regex-module"));
  });

  test("-S is a subset of -G: a changed count implies a changed line", async () => {
    const out = await rig.session.search({ scope: "pickaxe", query: "version", ...WIDE });
    const g = new Set(loadExpectedLines(FIXTURE, "log-G-fp-version"));
    expect(g.size).toBeGreaterThan(out.hits.length);
    for (const h of out.hits) expect(g.has(h.oid as string)).toBe(true);
  });

  test("delta counts the occurrences the commit added", async () => {
    const out = await rig.session.search({ scope: "pickaxe", query: "hot-main", ...WIDE });
    expect(out.hits.length).toBe(1);
    // `lines hot-main 1 3` replaced three plain `hot` lines with three `hot-main` ones.
    expect(out.hits[0]?.delta).toBe(3);
  });

  test("the range is the first-parent chain and `scanned` counts it", async () => {
    const out = await rig.session.search({
      scope: "pickaxe",
      query: "module",
      limit: 5000,
      commits: 10,
    });
    expect(out.scanned).toBe(10);
    expect(out.capped).toBe(true);
    const newest = new Set(loadExpectedLines(FIXTURE, "log-main-first-parent").slice(0, 10));
    for (const h of out.hits) expect(newest.has(h.oid as string)).toBe(true);
  });

  test("a query nothing ever contained finds no commit and no working-tree row", async () => {
    const out = await rig.session.search({ scope: "pickaxe", query: "zzz-not-here", ...WIDE });
    expect(out.hits).toEqual([]);
  });
});

describe("the working-tree row of the pickaxe", () => {
  /** An in-memory copy of `history` — D16: the fixture on disk is never written. */
  async function openMemoryHistory(id: string, mutate: (fs: MemoryFs) => void) {
    const snap = await snapshotFromDisk(fixturePath(FIXTURE), `${id}-snap`, FIXTURE, {
      exclude: (p) => p === "expected",
    });
    const mem = MemoryFs.fromSnapshot(snap);
    mutate(mem);
    const session = await RepoSession.open(
      mem.handle(FIXTURE),
      { onProgress() {}, onStats() {}, onWarning() {} },
      { id },
    );
    return session;
  }

  test("uncommitted work that changes the count is a hit with no oid", async () => {
    const session = await openMemoryHistory("search-worktree-row", (fs) =>
      fs.write("src/stable.txt", "this file is never touched again\npickaxe-marker here\n"),
    );
    const out = await session.search({ scope: "pickaxe", query: "pickaxe-marker", ...WIDE });
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]).toEqual({
      kind: "commit",
      subject: WORKTREE_HIT_SUBJECT,
      delta: 1,
    });
    expect(out.hits[0]?.oid).toBeUndefined();
    await session.close();
  });

  test("a clean working tree contributes no row", async () => {
    const session = await openMemoryHistory("search-worktree-clean", () => {});
    const out = await session.search({ scope: "pickaxe", query: "module", ...WIDE });
    expect(out.hits.some((h) => h.oid === undefined)).toBe(false);
    expect(oids(out)).toEqual(expectedOids("log-S-fp-module"));
    await session.close();
  });
});

// ---- cancellation, bad input, budget -----------------------------------------------------------

describe("one search in flight, and bad input", () => {
  test("a newer search supersedes the older one with CANCELLED", async () => {
    const first = rig.session.search({ scope: "pickaxe", query: "module", ...WIDE });
    const second = rig.session.search({ scope: "commits", query: "extend mod", ...WIDE });
    let code = "no-throw";
    try {
      await first;
    } catch (e) {
      code = errorCode(e) ?? "unknown";
    }
    expect(code).toBe("CANCELLED");
    expect((await second).hits.length).toBeGreaterThan(0);
  });

  test.each([
    ["", false],
    ["(unclosed", true],
    ["a".repeat(500), true],
  ])("query %p (regex %p) is refused with INTERNAL", async (query, regex) => {
    let code = "no-throw";
    try {
      await rig.session.search({ scope: "worktree", query, regex, ...WIDE });
    } catch (e) {
      code = errorCode(e) ?? "unknown";
    }
    expect(code).toBe("INTERNAL");
  });

  test("an unknown scope is refused rather than silently answered", async () => {
    let code = "no-throw";
    try {
      await rig.session.search({
        scope: "nope" as SearchRequest["scope"],
        query: "x",
        ...WIDE,
      });
    } catch (e) {
      code = errorCode(e) ?? "unknown";
    }
    expect(code).toBe("INTERNAL");
  });
});

describe("the per-file regex budget", () => {
  /** Files of lines that make `(a+)+$` backtrack exponentially. */
  function catastrophicDeps(files: number, lines: number) {
    const body = `${`${"a".repeat(22)}b\n`.repeat(lines)}`;
    const bytes = new TextEncoder().encode(body);
    return {
      paths: Array.from({ length: files }, (_, i) => `f${String(i).padStart(3, "0")}.txt`),
      read: async () => bytes,
      isGenerated: async () => false,
      limit: <T>(fn: () => Promise<T>) => fn(),
    };
  }

  test("a catastrophic pattern over many files completes in well under a second", async () => {
    const deps = catastrophicDeps(8, 200);
    const t0 = performance.now();
    const out: SearchOutcome = await searchWorktree(deps, {
      scope: "worktree",
      query: "^(a+)+$",
      regex: true,
      limit: 5000,
    });
    const ms = performance.now() - t0;
    console.log(
      `catastrophic regex over ${deps.paths.length} files: ${ms.toFixed(0)} ms ` +
        `(budget ${REGEX_FILE_BUDGET_MS} ms per file, ${out.scanned} files read)`,
    );
    // Every file gives up on its own budget, so the result is capped and the note says why.
    expect(out.capped).toBe(true);
    expect(out.note).toContain("regex budget");
    expect(ms).toBeLessThan(1000);
  }, 20_000);

  test("a literal query has no budget to run out of", async () => {
    const deps = catastrophicDeps(2, 10);
    const out = await searchWorktree(deps, { scope: "worktree", query: "aaab", limit: 5000 });
    expect(out.capped).toBe(false);
    expect(out.hits.length).toBe(20);
    expect(out.scanned).toBe(2);
  });
});

// ---- performance --------------------------------------------------------------------------------

describe("performance", () => {
  /** T10.5b builds `perf-log` (2,000 commits) under `FIXTURES_PERF=1`; `history` otherwise. */
  const perfFixture = hasFixture("perf-log") ? "perf-log" : FIXTURE;

  test(`the three scopes on ${perfFixture}`, async () => {
    const perf = await open(perfFixture, "search-perf");
    const runs: { label: string; req: SearchRequest }[] = [
      { label: "commits", req: { scope: "commits", query: "extend", limit: 200, commits: 2000 } },
      { label: "worktree", req: { scope: "worktree", query: "module", limit: 200 } },
      { label: "pickaxe", req: { scope: "pickaxe", query: "module", limit: 200, commits: 200 } },
    ];
    for (const { label, req } of runs) {
      const t0 = performance.now();
      const out = await perf.session.search(req);
      const ms = performance.now() - t0;
      console.log(
        `search ${label} on ${perfFixture}: ${out.hits.length} hits, ${out.scanned} scanned, ` +
          `${ms.toFixed(1)} ms (engine reported ${out.durationMs.toFixed(1)} ms)`,
      );
      expect(out.durationMs).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(30_000);
    }
    await perf.close();
  }, 120_000);
});

// ---- pure helpers -------------------------------------------------------------------------------

describe("the matcher the scopes share", () => {
  test("counts on each side of a change are what decides a pickaxe hit", () => {
    const m = createMatcher("module");
    const before = "module 1\nmodule 2\n";
    const after = "module 1\nmodule 2\nmodule 3\n";
    expect(m.count(after) - m.count(before)).toBe(1);
  });
});
