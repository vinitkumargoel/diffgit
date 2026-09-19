/**
 * T10.7: the scan end to end.
 *
 * The oracle is the `secrets` fixture itself — `scripts/make-fixtures.sh` plants four fake
 * credentials (two unstaged, two staged), one allowlisted token and one 40-hex object name, and
 * `expected/diff-unstaged.txt` / `diff-staged.txt` are git's own view of exactly those hunks. Every
 * other fixture is swept for false positives.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_ROOT, fixturePath } from "../../test/fixtures";
import { snapshotFromDisk } from "../../test/memorySnapshot";
import type { Progress, ProgressSink } from "../api";
import { defaultDiffSource } from "../diffSource";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { RepoWarning, SecretFinding } from "../types";
import {
  addedLines,
  SECRET_FINDING_CAP,
  scanTarget,
  secretAllowlist,
  sortFindings,
} from "./secrets";

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

interface Recorder {
  sink: ProgressSink;
  warnings: RepoWarning[];
  progress: Progress[];
}
function recorder(): Recorder {
  const warnings: RepoWarning[] = [];
  const progress: Progress[] = [];
  return {
    warnings,
    progress,
    sink: {
      onProgress: (p) => void progress.push(p),
      onStats() {},
      onWarning: (w) => void warnings.push(w),
    },
  };
}

async function openFixture(name: string, sink: ProgressSink = quietSink, id = `secrets-${name}`) {
  return RepoSession.open(await NodeDirHandle.open(fixturePath(name)), sink, { id });
}

/** Opens a fixture, computes the default diff and scans it. */
async function scan(name: string, sink: ProgressSink = quietSink) {
  const session = await openFixture(name, sink);
  const info = await session.info();
  const result = await session.computeDiff(defaultDiffSource(info));
  const findings = await session.scanSecrets(result.generation);
  return { session, result, findings };
}

/** The four credentials `build_secrets` plants, in the order `scanSecrets` must return them. */
const PLANTED = [
  { path: "config/deploy.sh", line: 3, rule: "anthropic-api-key", layer: "staged" },
  { path: "config/id_rsa", line: 1, rule: "private-key-rsa", layer: "staged" },
  { path: "config/settings.ini", line: 4, rule: "aws-access-key-id", layer: "unstaged" },
  { path: "config/settings.ini", line: 5, rule: "github-personal-access-token", layer: "unstaged" },
] as const;

/** The two lines the fixture plants that must **not** produce a finding. */
const ALLOWLISTED_LINE = 7; // legacy_token = ghp_… # diffgit:allow-secret
const HEX_SHA_LINE = 6; // release_commit = 9f2c0a1b…

describe("scanSecrets on the `secrets` fixture", () => {
  test("finds exactly the planted keys, in path/line order", async () => {
    const k = recorder();
    const { session, findings } = await scan("secrets", k.sink);
    expect(
      findings.map((f) => ({ path: f.path, line: f.line, rule: f.rule, layer: f.layer })),
    ).toEqual(PLANTED.map((p) => ({ ...p })));
    // `fileId` is the diff row's id, so the UI can jump straight to the card.
    expect(findings.map((f) => f.fileId)).toEqual(PLANTED.map((p) => p.path));
    await session.close();
  });

  test("the allowlisted line and the 40-hex object name are not reported", async () => {
    const { session, findings } = await scan("secrets");
    const ini = findings.filter((f) => f.path === "config/settings.ini");
    expect(ini.map((f) => f.line)).toEqual([4, 5]);
    expect(findings.some((f) => f.line === ALLOWLISTED_LINE)).toBe(false);
    expect(findings.some((f) => f.line === HEX_SHA_LINE)).toBe(false);
    // The allowlisted token really is a token: only the comment saves it.
    expect(findings.some((f) => f.full.startsWith("ghp_1aB2"))).toBe(false);
    await session.close();
  });

  test("masked never contains the middle of the token", async () => {
    const { session, findings } = await scan("secrets");
    expect(findings.length).toBe(4);
    for (const f of findings) {
      expect(f.masked).toBe(`${f.full.slice(0, 8)}…${f.full.slice(-4)}`);
      const middle = f.full.slice(8, -4);
      expect(middle.length).toBeGreaterThan(0);
      expect(f.masked).not.toContain(middle);
      for (let i = 8; i + 5 <= f.full.length - 4; i++) {
        expect(f.masked).not.toContain(f.full.slice(i, i + 5));
      }
    }
    await session.close();
  });

  test("entropy is reported per finding: the random tokens clear 3.8, the PEM header does not", async () => {
    const { session, findings } = await scan("secrets");
    const byRule = Object.fromEntries(findings.map((f) => [f.rule, f.entropy]));
    expect(byRule["anthropic-api-key"] as number).toBeGreaterThan(3.8);
    expect(byRule["github-personal-access-token"] as number).toBeGreaterThan(3.8);
    // Reported for every finding, including rules that do not gate on it.
    expect(byRule["private-key-rsa"] as number).toBeLessThan(3.8);
    expect(byRule["aws-access-key-id"] as number).toBeCloseTo(3.68, 1);
    await session.close();
  });

  test("SECRETS_FOUND carries the count, and progress is phase 'secrets'", async () => {
    const k = recorder();
    const { session, findings } = await scan("secrets", k.sink);
    const found = k.warnings.filter((w) => w.code === "SECRETS_FOUND");
    expect(found.length).toBe(1);
    expect(found[0]?.detail).toBe(String(findings.length));
    expect(found[0]?.message).toContain("4 possible secrets");
    expect(found[0]?.message).not.toContain("Showing the first");
    const phases = k.progress.filter((p) => p.phase === "secrets");
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases.every((p) => (p.total ?? 0) >= (p.done ?? 0))).toBe(true);
    expect(phases[phases.length - 1]?.durationMs).toBeGreaterThanOrEqual(0);
    await session.close();
  });

  test("a second scan of the same generation is stable, an old generation is STALE", async () => {
    const session = await openFixture("secrets");
    const info = await session.info();
    const first = await session.computeDiff(defaultDiffSource(info));
    const a = await session.scanSecrets(first.generation);
    const b = await session.scanSecrets(first.generation);
    expect(b).toEqual(a);
    const second = await session.computeDiff(defaultDiffSource(info));
    expect(second.generation).not.toBe(first.generation);
    await expect(session.scanSecrets(first.generation)).rejects.toMatchObject({ code: "STALE" });
    await session.close();
  });

  test("a superseded scan rejects with CANCELLED", async () => {
    const session = await openFixture("secrets");
    const info = await session.info();
    const result = await session.computeDiff(defaultDiffSource(info));
    const first = session.scanSecrets(result.generation);
    const second = session.scanSecrets(result.generation);
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await second).length).toBe(4);
    await session.close();
  });
});

describe("no false positives on the other fixtures", () => {
  const names = readdirSync(FIXTURES_ROOT)
    .filter((n) => !n.startsWith("_") && !n.includes("."))
    .filter((n) => statSync(join(FIXTURES_ROOT, n)).isDirectory())
    .filter((n) => n !== "secrets")
    .sort();

  test("every fixture that opens scans clean, with no SECRETS_FOUND warning", async () => {
    expect(names.length).toBeGreaterThan(20); // the sweep really is over every fixture
    const dirty: Record<string, SecretFinding[]> = {};
    let scanned = 0;
    for (const name of names) {
      const k = recorder();
      let session: RepoSession;
      try {
        session = await openFixture(name, k.sink, `sweep-${name}`);
      } catch {
        continue; // bare / sha256 / reftable / worktree-gitdir fixtures: `open` refuses them
      }
      try {
        const info = await session.info();
        const result = await session.computeDiff(defaultDiffSource(info));
        const findings = await session.scanSecrets(result.generation);
        scanned++;
        if (findings.length > 0) dirty[name] = findings;
        expect(k.warnings.some((w) => w.code === "SECRETS_FOUND")).toBe(false);
      } catch (e) {
        // `unborn` has no commit to diff against; nothing to scan there either.
        if ((e as { code?: string }).code !== "REF_NOT_FOUND") throw e;
      } finally {
        await session.close();
      }
    }
    expect(dirty).toEqual({});
    expect(scanned).toBeGreaterThan(20);
  }, 120_000);
});

describe("path allowlist and the finding cap", () => {
  /** An in-memory copy of the `secrets` fixture (D16: the fixture on disk is never written). */
  async function openMemorySecrets(id: string, mutate: (fs: MemoryFs) => void) {
    const snap = await snapshotFromDisk(fixturePath("secrets"), `${id}-snap`, "secrets", {
      exclude: (p) => p === "expected",
    });
    const mem = MemoryFs.fromSnapshot(snap);
    mutate(mem);
    const k = recorder();
    const session = await RepoSession.open(mem.handle("secrets"), k.sink, { id });
    const info = await session.info();
    const result = await session.computeDiff(defaultDiffSource(info));
    const findings = await session.scanSecrets(result.generation);
    return { session, findings, warnings: k.warnings };
  }

  test(".diffgitignore-secrets silences the paths it lists", async () => {
    const { session, findings, warnings } = await openMemorySecrets("secrets-allowlist", (fs) =>
      fs.write(".diffgitignore-secrets", "# fixtures, not real keys\nconfig/id_rsa\n*.ini\n"),
    );
    expect(findings.map((f) => f.path)).toEqual(["config/deploy.sh"]);
    expect(warnings.filter((w) => w.code === "SECRETS_FOUND")[0]?.detail).toBe("1");
    await session.close();
  });

  test("an allowlist that matches everything yields no findings and no warning", async () => {
    const { session, findings, warnings } = await openMemorySecrets("secrets-allow-all", (fs) =>
      fs.write(".diffgitignore-secrets", "config/\n"),
    );
    expect(findings).toEqual([]);
    expect(warnings.some((w) => w.code === "SECRETS_FOUND")).toBe(false);
    await session.close();
  });

  test(`findings are capped at ${SECRET_FINDING_CAP} and the warning says how many there were`, async () => {
    const planted = 600;
    const lines: string[] = [];
    for (let i = 0; i < planted; i++) {
      lines.push(`token_${i} = ghp_${String(i).padStart(4, "0")}aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV`);
    }
    const { session, findings, warnings } = await openMemorySecrets("secrets-cap", (fs) =>
      fs.write("clean.txt", `${lines.join("\n")}\n`),
    );
    const total = planted + 4; // the 600 planted here plus the fixture's own four
    expect(findings.length).toBe(SECRET_FINDING_CAP);
    const warning = warnings.filter((w) => w.code === "SECRETS_FOUND")[0];
    expect(warning?.detail).toBe(String(total));
    expect(warning?.message).toContain(`${total} possible secrets`);
    expect(warning?.message).toContain(`Showing the first ${SECRET_FINDING_CAP}`);
    // The cap keeps the head of the sorted list, so the order is still path then line.
    expect(findings[0]?.path).toBe("clean.txt");
    expect(sortFindings(findings)).toEqual(findings);
    await session.close();
  });
});

describe("pure helpers", () => {
  test("addedLines takes only `add` lines, numbered on the new side", () => {
    expect(
      addedLines({
        oldLines: 2,
        newLines: 3,
        hunks: [
          {
            oldStart: 1,
            oldCount: 2,
            newStart: 1,
            newCount: 3,
            lines: [
              { type: "ctx", old: 1, new: 1, text: "keep" },
              { type: "del", old: 2, text: "gone" },
              { type: "add", new: 2, text: "added a" },
              { type: "add", new: 3, text: "added b" },
            ],
          },
        ],
      }),
    ).toEqual([
      { line: 2, text: "added a" },
      { line: 3, text: "added b" },
    ]);
    expect(addedLines(null)).toEqual([]);
  });

  test("secretAllowlist is gitignore syntax, and a missing file allows nothing", () => {
    expect(secretAllowlist(null)("anything")).toBe(false);
    expect(secretAllowlist("   \n")("anything")).toBe(false);
    const allow = secretAllowlist("fixtures/\n*.pem\n!keep.pem\n");
    expect(allow("fixtures/keys.json")).toBe(true);
    expect(allow("a/b.pem")).toBe(true);
    expect(allow("keep.pem")).toBe(false);
    expect(allow("src/app.ts")).toBe(false);
  });

  test("two different secrets on one line are two findings; one secret is never doubled", () => {
    const file = { fileId: "f", path: "f", layer: "unstaged" } as const;
    const both = scanTarget({
      ...file,
      lines: [
        {
          line: 1,
          text: "curl -H ghp_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0 -d npm_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0",
        },
      ],
    });
    expect(both.map((f) => f.rule)).toEqual(["github-personal-access-token", "npm-access-token"]);
    // `github_token = ghp_…` matches the vendor rule *and* `generic-token-assignment`.
    const once = scanTarget({
      ...file,
      lines: [{ line: 1, text: "github_token = ghp_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0" }],
    });
    expect(once.map((f) => f.rule)).toEqual(["github-personal-access-token"]);
  });
});
