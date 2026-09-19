import { describe, expect, test } from "bun:test";
import {
  type ExpectedCheckIgnore,
  fixturePath,
  HIDDEN_FIXTURE,
  loadExpected,
  loadExpectedLines,
} from "../../test/fixtures";
import { defaultDiffSource } from "../diffSource";
import { createFsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession, type SessionOptions } from "../session";
import type { HiddenEntry, PathExplanation, RepoWarning } from "../types";
import { loadGitConfig, parseGitConfig } from "./config";
import { BUILTIN_SOURCE, IgnoreRules } from "./ignoreRules";
import { emptySnapshot } from "./indexReader";
import { ObjectDb } from "./objectDb";
import { HIDDEN_LIMIT, WorktreeScanner } from "./worktree";

/** `git check-ignore -v` prints `<source>:<line>:<pattern>\t<path>`, or `::\t<path>` for no match. */
function attribution(m: { source: string; line: number; pattern: string } | null): string {
  return m ? `${m.source}:${m.line}:${m.pattern}` : "::";
}

async function fixtureRules(name: string, builtinExcludes: boolean) {
  const fs = createFsaFs(await NodeDirHandle.open(fixturePath(name)));
  return IgnoreRules.load(fs, { builtinExcludes, config: await loadGitConfig(fs) });
}

async function memRules(files: Record<string, string>, builtinExcludes = false) {
  const fs = createFsaFs(
    MemoryFs.fromEntries({ ".git/HEAD": "ref: refs/heads/main\n", ...files }).handle(),
  );
  return IgnoreRules.load(fs, { builtinExcludes, config: parseGitConfig("") });
}

interface SessionRig {
  session: RepoSession;
  warnings: RepoWarning[];
  explain: (path: string) => Promise<PathExplanation>;
  hidden: () => Promise<HiddenEntry[]>;
  close: () => Promise<void>;
}

/** Opens the fixture for real and computes the default diff, as the app does before it asks. */
async function openFixture(name: string, opts: SessionOptions = {}): Promise<SessionRig> {
  const warnings: RepoWarning[] = [];
  const session = await RepoSession.open(
    await NodeDirHandle.open(fixturePath(name)),
    {
      onProgress() {},
      onStats() {},
      onWarning(w) {
        warnings.push(w);
      },
    },
    { id: `test-${name}`, ...opts },
  );
  const info = await session.info();
  await session.computeDiff(defaultDiffSource(info));
  return {
    session,
    warnings,
    explain: (path) => session.explainPath(path),
    hidden: () => session.listHidden(),
    close: () => session.close(),
  };
}

function kindsOf(e: PathExplanation): string[] {
  return e.reasons.map((r) => r.kind);
}

function byPath(entries: HiddenEntry[]): Record<string, HiddenEntry> {
  return Object.fromEntries(entries.map((e) => [e.path, e]));
}

// ------------------------------------------------------------------------------------------------

describe("IgnoreRules.explain parity with git check-ignore -v (T10.4)", () => {
  test("hidden fixture: every recorded line, verbatim", async () => {
    const rules = await fixtureRules("hidden", true);
    const lines = loadExpectedLines("hidden", "check-ignore");
    expect(lines.length).toBe(12);
    const directories = new Set<string>([HIDDEN_FIXTURE.ignoredDir]);
    for (const line of lines) {
      const [rule, path] = line.split("\t") as [string, string];
      const m = await rules.explainPath(path, directories.has(path) ? "directory" : "file");
      // git has no built-in excludes, so it prints `::` for .DS_Store; diffgit names its own rule
      // (B10 / `OpenOptions.builtinExcludes` turns that off). The single documented divergence.
      const expected =
        path === HIDDEN_FIXTURE.builtinExcluded ? `${BUILTIN_SOURCE}:1:.DS_Store` : rule;
      expect([path, attribution(m)]).toEqual([path, expected]);
    }
  });

  test("ignore fixture: source, line, pattern and the negation git reports", async () => {
    const rules = await fixtureRules("ignore", false);
    const expected = loadExpected<ExpectedCheckIgnore[]>("ignore", "check-ignore");
    expect(expected.length).toBeGreaterThan(10);
    for (const probe of expected) {
      const isDir = probe.path.endsWith("/");
      const path = probe.path.replace(/\/$/, "");
      const m = await rules.explainPath(path, isDir ? "directory" : "file");
      expect([probe.path, m?.source ?? null, m?.line ?? null, m?.pattern ?? null]).toEqual([
        probe.path,
        probe.source,
        probe.line,
        probe.pattern,
      ]);
      // `!keep.log` is reported as the deciding rule *and* as not ignored, exactly as git does.
      expect([probe.path, m !== null && !m.negated]).toEqual([probe.path, probe.ignored]);
    }
  });

  test("explain agrees with isPathIgnored on every probe of the ignore fixture", async () => {
    const rules = await fixtureRules("ignore", false);
    for (const probe of loadExpected<ExpectedCheckIgnore[]>("ignore", "check-ignore")) {
      const isDir = probe.path.endsWith("/");
      const path = probe.path.replace(/\/$/, "");
      const m = await rules.explainPath(path, isDir ? "directory" : "file");
      const ignored = await rules.isPathIgnored(path, isDir ? "directory" : "file");
      expect([probe.path, m !== null && !m.negated]).toEqual([probe.path, ignored]);
    }
  });
});

describe("IgnoreRules.explain precedence (T10.4)", () => {
  test("nearest .gitignore wins over the parent, and the last rule in a file wins", async () => {
    const rules = await memRules({
      ".gitignore": "*.log\n!root-keep.log\n*.log\n",
      "src/.gitignore": "!keep.log\n",
    });
    expect(await rules.explainPath("src/keep.log", "file")).toEqual({
      source: "src/.gitignore",
      line: 1,
      pattern: "!keep.log",
      negated: true,
    });
    expect(await rules.explainPath("src/other.log", "file")).toMatchObject({
      source: ".gitignore",
      line: 3,
      negated: false,
    });
    // last rule in the root file re-ignores it, which is what `isFileIgnored` says too
    expect(await rules.isPathIgnored("root-keep.log", "file")).toBe(true);
    expect(await rules.explainPath("root-keep.log", "file")).toMatchObject({ line: 3 });
  });

  test("info/exclude sits below every .gitignore, built-ins below that", async () => {
    const rules = await memRules(
      { ".git/info/exclude": "# note\nsecret.txt\n*.tmp\n", ".gitignore": "!keep.tmp\n" },
      true,
    );
    expect(await rules.explainPath("secret.txt", "file")).toEqual({
      source: ".git/info/exclude",
      line: 2,
      pattern: "secret.txt",
      negated: false,
    });
    expect(await rules.explainPath("a.tmp", "file")).toMatchObject({
      source: ".git/info/exclude",
      line: 3,
    });
    expect(await rules.explainPath("keep.tmp", "file")).toMatchObject({
      source: ".gitignore",
      negated: true,
    });
    expect(await rules.explainPath("Thumbs.db", "file")).toEqual({
      source: BUILTIN_SOURCE,
      line: 3,
      pattern: "Thumbs.db",
      negated: false,
    });
    expect(await rules.explainPath("notes.txt", "file")).toBeNull();
  });

  test("a file inside an ignored directory reports the rule that excluded the directory", async () => {
    const rules = await memRules({ ".gitignore": "*.keep\nvendor\n", "vendor/.gitignore": "*\n" });
    // git stops at `vendor` and never looks at vendor/.gitignore
    expect(await rules.explainPath("vendor/deep/a.txt", "file")).toEqual({
      source: ".gitignore",
      line: 2,
      pattern: "vendor",
      negated: false,
    });
  });
});

describe("explainPath (T10.4, hidden fixture)", () => {
  test("every planted reason, with the command that undoes it", async () => {
    const rig = await openFixture(HIDDEN_FIXTURE.name);
    try {
      const ignored = await rig.explain(HIDDEN_FIXTURE.ignoredFile);
      expect(ignored).toEqual({
        path: ".env.local",
        shown: false,
        reasons: [
          {
            kind: "ignored",
            source: ".gitignore",
            line: 2,
            pattern: ".env.local",
            command: "git check-ignore -v .env.local",
          },
        ],
      });

      const dir = await rig.explain(HIDDEN_FIXTURE.ignoredDir);
      expect(dir.shown).toBe(false);
      expect(dir.reasons[0]).toMatchObject({ kind: "ignored", line: 1, pattern: "dist/" });

      const skipped = await rig.explain(HIDDEN_FIXTURE.skipWorktree);
      expect(skipped).toEqual({
        path: "src/skipped.txt",
        shown: false,
        reasons: [
          {
            kind: "skip-worktree",
            command: "git update-index --no-skip-worktree src/skipped.txt",
          },
        ],
      });

      const assumed = await rig.explain(HIDDEN_FIXTURE.assumeUnchanged);
      expect(assumed).toEqual({
        path: "src/assumed.txt",
        shown: false,
        reasons: [
          {
            kind: "assume-unchanged",
            command: "git update-index --no-assume-unchanged src/assumed.txt",
          },
        ],
      });

      // 11 MB, modified in the working tree: it has a row, but nothing renders it
      const big = await rig.explain(HIDDEN_FIXTURE.tooLarge);
      expect(big).toEqual({ path: "big.txt", shown: false, reasons: [{ kind: "too-large" }] });

      // tracked and unchanged on both sides
      expect(await rig.explain("src/app.txt")).toEqual({
        path: "src/app.txt",
        shown: false,
        reasons: [{ kind: "clean" }],
      });
      // untracked and visible: a row, and nothing to explain
      expect(await rig.explain("notes.txt")).toEqual({
        path: "notes.txt",
        shown: true,
        reasons: [],
      });
    } finally {
      await rig.close();
    }
  });

  test("a leading slash and a trailing slash name the same path", async () => {
    const rig = await openFixture(HIDDEN_FIXTURE.name);
    try {
      expect(kindsOf(await rig.explain("/dist/"))).toEqual(["ignored"]);
      expect((await rig.explain("/dist/")).path).toBe("dist");
    } finally {
      await rig.close();
    }
  });

  test("builtinExcludes: false makes .DS_Store an ordinary untracked file", async () => {
    const on = await openFixture(HIDDEN_FIXTURE.name);
    try {
      const e = await on.explain(HIDDEN_FIXTURE.builtinExcluded);
      expect(e.shown).toBe(false);
      expect(e.reasons[0]).toMatchObject({ kind: "ignored", source: BUILTIN_SOURCE });
    } finally {
      await on.close();
    }

    const off = await openFixture(HIDDEN_FIXTURE.name, { builtinExcludes: false });
    try {
      const diff = await off.session.computeDiff(defaultDiffSource(await off.session.info()));
      expect(diff.files.map((f) => f.id)).toContain(HIDDEN_FIXTURE.builtinExcluded);
      expect(await off.explain(HIDDEN_FIXTURE.builtinExcluded)).toEqual({
        path: ".DS_Store",
        shown: true,
        reasons: [],
      });
      expect((await off.hidden()).map((h) => h.path)).not.toContain(HIDDEN_FIXTURE.builtinExcluded);
    } finally {
      await off.close();
    }
  });
});

describe("listHidden (T10.4, hidden fixture)", () => {
  test("ignored directories are one row with a count and are never descended", async () => {
    const rig = await openFixture(HIDDEN_FIXTURE.name);
    try {
      const entries = await rig.hidden();
      const paths = entries.map((e) => e.path);
      expect(paths.filter((p) => p === HIDDEN_FIXTURE.ignoredDir)).toEqual([
        HIDDEN_FIXTURE.ignoredDir,
      ]);
      expect(byPath(entries)[HIDDEN_FIXTURE.ignoredDir]).toEqual({
        path: "dist",
        kind: "ignored-dir",
        count: HIDDEN_FIXTURE.ignoredDirCount,
      });
      expect(paths.some((p) => p.startsWith("dist/"))).toBe(false);
      expect(paths).toEqual([...paths].sort());
    } finally {
      await rig.close();
    }
  });

  test("one row per planted reason, and nothing that git shows", async () => {
    const rig = await openFixture(HIDDEN_FIXTURE.name);
    try {
      const entries = byPath(await rig.hidden());
      expect(entries[HIDDEN_FIXTURE.ignoredFile]).toEqual({ path: ".env.local", kind: "ignored" });
      expect(entries[HIDDEN_FIXTURE.builtinExcluded]).toEqual({
        path: ".DS_Store",
        kind: "ignored",
      });
      expect(entries[HIDDEN_FIXTURE.skipWorktree]).toEqual({
        path: "src/skipped.txt",
        kind: "skip-worktree",
      });
      expect(entries[HIDDEN_FIXTURE.assumeUnchanged]).toEqual({
        path: "src/assumed.txt",
        kind: "assume-unchanged",
      });
      expect(entries[HIDDEN_FIXTURE.tooLarge]).toEqual({ path: "big.txt", kind: "too-large" });
      // visible files never appear
      for (const shown of ["notes.txt", "README.md", "src/app.txt", ".gitignore"]) {
        expect(`${shown}=${entries[shown]?.kind ?? "absent"}`).toBe(`${shown}=absent`);
      }
      expect(rig.warnings.some((w) => w.code === "HIDDEN_CAPPED")).toBe(false);
    } finally {
      await rig.close();
    }
  });

  test("every ignored path git reports is listed, one way or another", async () => {
    const rig = await openFixture(HIDDEN_FIXTURE.name);
    try {
      const listed = new Set((await rig.hidden()).map((e) => e.path));
      for (const line of loadExpectedLines(HIDDEN_FIXTURE.name, "status-ignored")) {
        if (!line.startsWith("!! ")) continue;
        expect([line, listed.has(line.slice(3).replace(/\/$/, ""))]).toEqual([line, true]);
      }
    } finally {
      await rig.close();
    }
  });
});

describe("listHidden caps (T10.4)", () => {
  test("past 2,000 rows the list is cut and HIDDEN_CAPPED is raised", async () => {
    const files: Record<string, string> = { ".git/HEAD": "x", ".gitignore": "*.junk\n" };
    for (let i = 0; i < HIDDEN_LIMIT + 5; i++) files[`junk/f${i}.junk`] = "x";
    const fs = createFsaFs(MemoryFs.fromEntries(files).handle());
    const cfg = parseGitConfig("");
    const ignore = await IgnoreRules.load(fs, { builtinExcludes: false, config: cfg });
    const scanner = new WorktreeScanner(fs, new ObjectDb(fs), cfg, ignore, {});
    const out = await scanner.listHidden(emptySnapshot(0));
    expect(out.entries.length).toBe(HIDDEN_LIMIT);
    expect(out.warnings.map((w) => w.code)).toEqual(["HIDDEN_CAPPED"]);
  });
});
