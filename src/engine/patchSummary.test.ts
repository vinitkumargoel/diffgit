/**
 * T10.10 — `patchText` and `summarise` through `RepoSession`, against git itself.
 *
 * The patch oracle is `git apply` on a **temp copy** of the fixture (Plan D16: nothing under
 * `fixtures/` is ever written): the copy is reset to the diff's old side, `git apply --check` must
 * accept the patch, and applying it for real must reproduce byte for byte the tree git had before
 * the reset — so both `git diff --numstat` answers, and `git write-tree`, agree.
 *
 * These tests shell out to `git`. When `git` is not on PATH they skip with a logged reason, which is
 * what `tasks/phase-10-engine/T10.10-patch-summary.md` asks for.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExpectedStatusEntry } from "../test/fixtures";
import { fixturePath, loadExpected, loadExpectedLines } from "../test/fixtures";
import type { ProgressSink } from "./api";
import { defaultDiffSource } from "./diffSource";
import { NodeDirHandle } from "./fs/nodeDirHandle";
import { RepoSession } from "./session";
import type { DiffResult, RepoInfo, RepoWarning } from "./types";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: GIT_ENV });
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
  };
}

const HAS_GIT = Bun.spawnSync(["git", "--version"], { env: GIT_ENV }).exitCode === 0;
if (!HAS_GIT) {
  console.warn(
    "T10.10: skipping the `git apply` parity tests — `git` is not on PATH in this environment.",
  );
}

function silentSink(): ProgressSink & { warnings: RepoWarning[] } {
  const warnings: RepoWarning[] = [];
  return {
    warnings,
    onProgress() {},
    onStats() {},
    onWarning(w) {
      warnings.push(w);
    },
  };
}

async function openFixture(name: string, sink = silentSink()) {
  const session = await RepoSession.open(await NodeDirHandle.open(fixturePath(name)), sink, {
    id: `t10-10-${name}`,
  });
  return { session, sink };
}

interface Exported {
  info: RepoInfo;
  result: DiffResult;
  patch: string;
}

async function exportFixture(name: string): Promise<Exported> {
  const { session } = await openFixture(name);
  try {
    const info = await session.info();
    const result = await session.computeDiff(defaultDiffSource(info));
    const patch = await session.patchText(result.generation, null);
    return { info, result, patch };
  } finally {
    await session.close();
  }
}

/** `diff --git` / mode / rename / index / `---` / `+++` lines, in order. */
function fileHeaders(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ") ||
      line.startsWith("index ") ||
      line.startsWith("Binary files ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    )
      out.push(line);
  }
  return out;
}

/** Copies a fixture under the OS temp dir. Never touches `fixtures/` (D16). */
function copyFixture(name: string): { repo: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `diffgit-t10-10-${name}-`));
  const repo = join(dir, "repo");
  cpSync(fixturePath(name), repo, { recursive: true });
  return { repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface ApplyReport {
  checkCode: number;
  checkErr: string;
  oracleNumstat: string;
  appliedNumstat: string;
  oracleTree: string;
  appliedTree: string;
}

/**
 * Records what git makes of the fixture as it stands, resets the copy to the patch's old side, and
 * replays the patch onto it.
 */
function applyRoundTrip(name: string, patch: string, oldRev: string): ApplyReport {
  const { repo, cleanup } = copyFixture(name);
  try {
    const patchFile = join(repo, "..", "export.patch");
    writeFileSync(patchFile, patch);

    // 1. git's own answer for "old side → the state this fixture is actually in".
    expect(git(repo, "add", "-A").code).toBe(0);
    const oracleNumstat = git(repo, "diff", "--cached", "-M", "--numstat", oldRev).out;
    const oracleTree = git(repo, "write-tree").out.trim();

    // 2. rewind the working tree to the old side the patch was written against.
    expect(git(repo, "checkout", "-f", "--detach", oldRev).code).toBe(0);
    expect(git(repo, "clean", "-ffdxq").code).toBe(0);

    // 3. the acceptance criterion, then the real apply.
    const check = git(repo, "apply", "--check", "--whitespace=nowarn", patchFile);
    if (check.code === 0) {
      expect(git(repo, "apply", "--whitespace=nowarn", patchFile).code).toBe(0);
      expect(git(repo, "add", "-A").code).toBe(0);
    }
    return {
      checkCode: check.code,
      checkErr: check.err,
      oracleNumstat,
      appliedNumstat: git(repo, "diff", "--cached", "-M", "--numstat").out,
      oracleTree,
      appliedTree: git(repo, "write-tree").out.trim(),
    };
  } finally {
    cleanup();
  }
}

const APPLY_FIXTURES = ["basic", "renames", "binary", "worktree", "large"] as const;

describe.if(HAS_GIT)("T10.10 patchText: git apply --check on every fixture", () => {
  for (const name of APPLY_FIXTURES) {
    test(`${name}: git apply --check accepts the patch and replaying it reproduces git's tree`, async () => {
      const { result, patch } = await exportFixture(name);
      expect(patch.length).toBeGreaterThan(0);
      expect(patch.endsWith("\n")).toBe(true);
      const oldRev = result.mergeBase as string;
      expect(oldRev).toBeTruthy();

      const report = applyRoundTrip(name, patch, oldRev);
      if (report.checkCode !== 0) throw new Error(`git apply --check failed:\n${report.checkErr}`);
      expect(report.checkCode).toBe(0);
      expect(report.appliedNumstat).toBe(report.oracleNumstat);
      expect(report.appliedTree).toBe(report.oracleTree);
    });
  }
});

describe.if(HAS_GIT)("T10.10 patchText: the two shapes no fixture carries", () => {
  test("crlf: a CRLF file round-trips through git apply", async () => {
    const { result, patch } = await exportFixture("crlf");
    const report = applyRoundTrip("crlf", patch, result.mergeBase as string);
    if (report.checkCode !== 0) throw new Error(`git apply --check failed:\n${report.checkErr}`);
    expect(report.appliedTree).toBe(report.oracleTree);
  });

  test("a missing final newline round-trips through git apply", async () => {
    // No fixture ends a file without a newline, so this one builds its own repository under the
    // temp dir — `fixtures/` is never written to (D16).
    const dir = mkdtempSync(join(tmpdir(), "diffgit-t10-10-noeol-"));
    const repo = join(dir, "repo");
    try {
      expect(Bun.spawnSync(["git", "init", "-q", repo], { env: GIT_ENV }).exitCode).toBe(0);
      expect(git(repo, "config", "user.email", "t@example.com").code).toBe(0);
      expect(git(repo, "config", "user.name", "T").code).toBe(0);
      writeFileSync(join(repo, "tail.txt"), "keep\nold tail");
      writeFileSync(join(repo, "grows.txt"), "one\ntwo\n");
      expect(git(repo, "add", "-A").code).toBe(0);
      expect(git(repo, "commit", "-qm", "c1").code).toBe(0);
      const base = git(repo, "rev-parse", "HEAD").out.trim();
      expect(git(repo, "checkout", "-qb", "feature").code).toBe(0);
      writeFileSync(join(repo, "tail.txt"), "keep\nnew tail\n");
      writeFileSync(join(repo, "grows.txt"), "one\ntwo\nthree");
      expect(git(repo, "commit", "-qam", "f1").code).toBe(0);

      const session = await RepoSession.open(await NodeDirHandle.open(repo), silentSink(), {
        id: "t10-10-noeol",
      });
      let patch: string;
      try {
        const result = await session.computeDiff(defaultDiffSource(await session.info()));
        patch = await session.patchText(result.generation, null);
      } finally {
        await session.close();
      }
      expect(patch).toContain("-old tail\n\\ No newline at end of file\n+new tail\n");
      expect(patch).toContain("+three\n\\ No newline at end of file\n");

      const patchFile = join(dir, "export.patch");
      writeFileSync(patchFile, patch);
      const oracleTree = git(repo, "write-tree").out.trim();
      expect(git(repo, "checkout", "-f", "--detach", base).code).toBe(0);
      expect(git(repo, "clean", "-ffdxq").code).toBe(0);
      const check = git(repo, "apply", "--check", "--whitespace=nowarn", patchFile);
      if (check.code !== 0) throw new Error(`git apply --check failed:\n${check.err}`);
      expect(git(repo, "apply", "--whitespace=nowarn", patchFile).code).toBe(0);
      expect(git(repo, "add", "-A").code).toBe(0);
      expect(git(repo, "write-tree").out.trim()).toBe(oracleTree);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.if(HAS_GIT)("T10.10 patchText: headers match git's own", () => {
  // Tree-to-tree fixtures only: `git diff` has no spelling for "plus the working tree".
  for (const name of ["basic", "renames", "binary"] as const) {
    test(`${name}: every file header equals git diff --full-index -M`, async () => {
      const { result, patch } = await exportFixture(name);
      const source = result.source;
      const to = source.kind === "range" ? source.toRef : source.sourceRef;
      const oracle = git(
        fixturePath(name),
        "diff",
        "--full-index",
        "-M",
        result.mergeBase as string,
        to,
      );
      expect(oracle.code).toBe(0);
      // git orders renames by its own pairing, we order by path: compare the header sets.
      expect(fileHeaders(patch).sort()).toEqual(fileHeaders(oracle.out).sort());
    });
  }

  test("basic: the header sequence is git's, in git's order", async () => {
    const { result, patch } = await exportFixture("basic");
    const oracle = git(
      fixturePath("basic"),
      "diff",
      "--full-index",
      "-M",
      result.mergeBase as string,
      "feature",
    );
    expect(fileHeaders(patch)).toEqual(fileHeaders(oracle.out));
  });
});

describe("T10.10 patchText: shape and subsetting", () => {
  test("ids pick a subset, always in DiffResult order", async () => {
    const { session } = await openFixture("basic");
    try {
      const result = await session.computeDiff(defaultDiffSource(await session.info()));
      const ids = result.files.map((f) => f.id);
      expect(ids.length).toBeGreaterThan(2);
      const reversed = [...ids].reverse();
      const subsetIds = [ids[1] as string, ids[0] as string];
      const subset = await session.patchText(result.generation, subsetIds);
      const whole = await session.patchText(result.generation, null);
      const reversedWhole = await session.patchText(result.generation, reversed);
      expect(reversedWhole).toBe(whole);
      const headers = fileHeaders(subset).filter((l) => l.startsWith("diff --git "));
      expect(headers.length).toBe(2);
      expect(headers[0]).toContain(ids[0] as string);
      expect(headers[1]).toContain(ids[1] as string);
      expect(await session.patchText(result.generation, [])).toBe("");
    } finally {
      await session.close();
    }
  });

  test("a mode-only change carries no index line and no hunks", async () => {
    const { session } = await openFixture("worktree");
    try {
      const result = await session.computeDiff(defaultDiffSource(await session.info()));
      const script = result.files.find((f) => f.id === "script.sh");
      expect(script).toBeDefined();
      const patch = await session.patchText(result.generation, ["script.sh"]);
      expect(patch).toBe("diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n");
    } finally {
      await session.close();
    }
  });

  test("a 100% rename is similarity + rename lines only; a partial rename carries hunks", async () => {
    const { session } = await openFixture("renames");
    try {
      const result = await session.computeDiff(defaultDiffSource(await session.info()));
      const exact = await session.patchText(result.generation, ["new/exact.txt"]);
      expect(exact).toBe(
        "diff --git a/old/exact.txt b/new/exact.txt\n" +
          "similarity index 100%\n" +
          "rename from old/exact.txt\n" +
          "rename to new/exact.txt\n",
      );
      const partial = await session.patchText(result.generation, ["moved/similar.txt"]);
      expect(partial).toContain("similarity index 58%\n");
      expect(partial).toContain("rename from similar.txt\n");
      expect(partial).toContain("rename to moved/similar.txt\n");
      expect(partial).toContain("--- a/similar.txt\n");
      expect(partial).toContain("+++ b/moved/similar.txt\n");
      expect(partial).toContain("@@ ");
    } finally {
      await session.close();
    }
  });

  test("binaries are a full-index stub; a huge file is the same stub plus a note", async () => {
    const { session } = await openFixture("binary");
    try {
      const result = await session.computeDiff(defaultDiffSource(await session.info()));
      const patch = await session.patchText(result.generation, null);
      expect(patch).toContain("Binary files a/img/logo.png and b/img/logo.png differ\n");
      expect(patch).toContain("Binary files /dev/null and b/img/new.png differ\n");
      for (const line of patch.split("\n").filter((l) => l.startsWith("index ")))
        expect(line).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40}( \d{6})?$/);
    } finally {
      await session.close();
    }

    const large = await exportFixture("large");
    expect(large.patch).toContain(
      "# diffgit: huge.txt is larger than 10 MB; the patch records its object names only.\n",
    );
    expect(large.patch).toContain("Binary files /dev/null and b/huge.txt differ\n");
    // The gated 1.5 MB and 3,000-line rows keep their real hunks.
    expect(large.patch).toContain("--- a/medium.txt\n");
    expect(large.patch).toContain("--- a/big-change.txt\n");
  });

  test("STALE for an old generation, CANCELLED when a newer call supersedes", async () => {
    const { session } = await openFixture("basic");
    try {
      const result = await session.computeDiff(defaultDiffSource(await session.info()));
      await expect(session.patchText(result.generation - 1, null)).rejects.toMatchObject({
        code: "STALE",
      });
      const first = session.patchText(result.generation, null);
      const second = session.patchText(result.generation, null);
      await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
      expect((await second).length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});

describe("T10.10 summarise", () => {
  test("worktree: counts equal git status --porcelain=v2", async () => {
    const { session } = await openFixture("worktree");
    try {
      const summary = await session.summarise();
      const rows = loadExpected<ExpectedStatusEntry[]>("worktree", "status-porcelain-v2");
      const tracked = rows.filter((r) => r.type === "1" || r.type === "2");
      const staged = tracked.filter((r) => (r as { xy: string }).xy[0] !== ".").length;
      const unstaged = tracked.filter((r) => (r as { xy: string }).xy[1] !== ".").length;
      const untracked = rows.filter((r) => r.type === "?").length;
      const conflict = rows.filter((r) => r.type === "u").length;
      expect(summary.counts).toEqual({ staged, unstaged, untracked, conflict });
      expect(summary.counts).toEqual({ staged: 5, unstaged: 4, untracked: 2, conflict: 0 });
      expect(summary.headBranch).toBe("feature");
      expect(summary.headDisplay).toBe("feature");
      expect(summary.operation).toBeNull();
      expect(summary.vsUpstream).toBeNull(); // the fixture has no remote
      expect(summary.lastCommit?.subject).toBe("f1: feature commit");
      expect(summary.indexMtimeMs).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  test("rebase-conflict: the operation in progress is reported", async () => {
    const { session } = await openFixture("rebase-conflict");
    try {
      const summary = await session.summarise();
      expect(summary.operation?.kind).toBe("rebase");
      expect(summary.operation?.step).toBe(2);
      expect(summary.operation?.total).toBe(3);
      expect(summary.counts.conflict).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  test.if(HAS_GIT)("history: vsUpstream equals git rev-list --left-right --count", async () => {
    const counts = new Map(
      loadExpectedLines("history", "rev-list-left-right-count").map((line) => {
        // `<pair>\t<left>\t<right>` — git's own `rev-list --left-right --count` output.
        const [pair, ahead, behind] = line.split("\t");
        return [pair as string, { ahead: Number(ahead), behind: Number(behind) }];
      }),
    );
    const expected = counts.get("main...topic");
    expect(expected).toBeDefined();

    // `history` ships no upstream, so one is configured on a temp copy — git's own spelling for
    // "this branch tracks another local branch" (`branch.main.remote = .`).
    const { repo, cleanup } = copyFixture("history");
    try {
      expect(git(repo, "branch", "--set-upstream-to=topic", "main").code).toBe(0);
      const session = await RepoSession.open(await NodeDirHandle.open(repo), silentSink(), {
        id: "t10-10-history-upstream",
      });
      try {
        const summary = await session.summarise();
        expect(summary.headBranch).toBe("main");
        expect(summary.vsUpstream).toMatchObject({
          ahead: expected?.ahead as number,
          behind: expected?.behind as number,
          capped: false,
        });
        expect(summary.lastCommit?.oid).toBe(git(repo, "rev-parse", "HEAD").out.trim());
      } finally {
        await session.close();
      }
    } finally {
      cleanup();
    }
  });

  test("does not disturb an open diff generation", async () => {
    const { session } = await openFixture("worktree");
    try {
      const result = await session.computeDiff(defaultDiffSource(await session.info()));
      const id = result.files[0]?.id as string;
      const before = await session.fileDiff(result.generation, id, { ignoreWhitespace: false });
      await session.summarise();
      const after = await session.fileDiff(result.generation, id, { ignoreWhitespace: false });
      expect(after).toEqual(before);
      // and the patch of that same generation still exports.
      expect((await session.patchText(result.generation, null)).length).toBeGreaterThan(0);
      const metrics = await session.metrics();
      expect(metrics.generation).toBe(result.generation);
    } finally {
      await session.close();
    }
  });

  test("a newer summarise supersedes the older one", async () => {
    const { session } = await openFixture("basic");
    try {
      const first = session.summarise();
      const second = session.summarise();
      await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
      expect((await second).headBranch).toBe("feature");
    } finally {
      await session.close();
    }
  });
});
