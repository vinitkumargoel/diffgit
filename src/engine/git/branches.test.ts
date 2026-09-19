/**
 * T10.5: the Branches table (Design §14.6). `upstream` is what
 * `git for-each-ref --format='%(upstream:short)'` says, the ahead/behind cells are
 * `git rev-list --left-right --count`, and `merged` agrees with `git branch --merged <default>`.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedLines } from "../../test/fixtures";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { BranchRow } from "../types";
import { upstreamOf } from "./branches";
import { parseGitConfig } from "./config";

async function open(name: string): Promise<RepoSession> {
  return RepoSession.open(
    await NodeDirHandle.open(fixturePath(name)),
    { onProgress() {}, onStats() {}, onWarning() {} },
    { id: `branches-${name}` },
  );
}

/** `refs/heads/x|origin/x|ahead 1, behind 2` → the fields the table shows. */
function upstreamOracle(name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of loadExpectedLines(name, "branch-upstream")) {
    const [fullName, upstream] = line.split("|") as [string, string, string];
    out.set(fullName, upstream);
  }
  return out;
}

describe("branchOverview", () => {
  for (const name of ["remote", "remote-master", "no-origin-head", "history"] as const) {
    test(`${name}: upstream equals git for-each-ref %(upstream:short)`, async () => {
      const session = await open(name);
      try {
        const rows = await session.branchOverview();
        const oracle = upstreamOracle(name);
        for (const [fullName, upstream] of oracle) {
          const row = rows.find((r) => r.ref.fullName === fullName) as BranchRow;
          expect(`${fullName} → ${row?.upstream ?? ""}`).toBe(`${fullName} → ${upstream}`);
        }
        // Remote-tracking branches get a row too, but never an upstream of their own.
        for (const row of rows.filter((r) => r.ref.kind === "remote")) {
          expect(row.upstream).toBeNull();
        }
        // The expensive cells are lazy (docs/v2-contracts.md).
        for (const row of rows) {
          expect(row.vsUpstream).toBeNull();
          expect(row.vsDefault).toBeNull();
          expect(row.merged).toBeNull();
        }
      } finally {
        await session.close();
      }
    });
  }

  test("history: last commit, tags on the tip, and every ref present", async () => {
    const session = await open("history");
    try {
      const rows = await session.branchOverview();
      const names = rows.map((r) => r.ref.fullName).sort();
      expect(names).toEqual([
        "refs/heads/main",
        "refs/heads/preflight/a",
        "refs/heads/preflight/base",
        "refs/heads/topic",
      ]);
      const main = rows.find((r) => r.ref.name === "main") as BranchRow;
      expect(main.lastCommit?.subject).toBe("c59: extend mod4");
      expect(main.lastCommit?.author).toBe("test");
      expect(main.lastCommit?.timestamp).toBeGreaterThan(1_500_000_000_000);
      expect(main.tags).toEqual(["v1.0.0"]);
      const base = rows.find((r) => r.ref.name === "preflight/base") as BranchRow;
      expect(base.tags).toEqual(["v0.1.0"]);
    } finally {
      await session.close();
    }
  });

  test("a detached HEAD does not become a branch row", async () => {
    const session = await open("detached");
    try {
      const rows = await session.branchOverview();
      expect(rows.every((r) => r.ref.synthetic !== true)).toBe(true);
      expect(rows.every((r) => r.ref.fullName !== "HEAD")).toBe(true);
    } finally {
      await session.close();
    }
  });
});

describe("branchCells", () => {
  test("history: vsDefault equals git rev-list --left-right --count against main", async () => {
    const session = await open("history");
    try {
      const rows = await session.branchOverview();
      const cells = await session.branchCells(rows.map((r) => r.ref.fullName));
      for (const line of loadExpectedLines("history", "rev-list-left-right-count")) {
        const [range, left, right] = line.split("\t") as [string, string, string];
        const [, branch] = range.split("...") as [string, string];
        // the oracle is `main...<branch>`, so the branch's own cell is the mirror image
        const cell = cells[`refs/heads/${branch}`];
        expect(`${branch} ${cell?.vsDefault?.ahead} ${cell?.vsDefault?.behind}`).toBe(
          `${branch} ${right} ${left}`,
        );
      }
      // The default branch has nothing to compare itself with.
      expect(cells["refs/heads/main"]?.vsDefault).toBeNull();
      expect(cells["refs/heads/main"]?.merged).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("history: merged agrees with git branch --merged main", async () => {
    const session = await open("history");
    try {
      const merged = new Set(loadExpectedLines("history", "branch-merged"));
      const rows = await session.branchOverview();
      const cells = await session.branchCells(rows.map((r) => r.ref.fullName));
      for (const row of rows) {
        expect(`${row.ref.fullName} merged=${cells[row.ref.fullName]?.merged}`).toBe(
          `${row.ref.fullName} merged=${merged.has(row.ref.fullName)}`,
        );
      }
    } finally {
      await session.close();
    }
  });

  test("remote: a branch level with its upstream is 0 ahead, 0 behind", async () => {
    const session = await open("remote");
    try {
      const cells = await session.branchCells(["refs/heads/main", "refs/heads/topic"]);
      expect(cells["refs/heads/main"]?.vsUpstream).toMatchObject({ ahead: 0, behind: 0 });
      expect(cells["refs/heads/topic"]?.vsUpstream).toBeNull(); // no upstream configured
    } finally {
      await session.close();
    }
  });

  test("an unknown ref name is simply absent from the answer", async () => {
    const session = await open("history");
    try {
      expect(await session.branchCells(["refs/heads/nope"])).toEqual({});
    } finally {
      await session.close();
    }
  });
});

describe("upstreamOf", () => {
  test("reads branch.<name>.remote and .merge, including the local `.` remote", () => {
    const cfg = parseGitConfig(
      '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n' +
        '[branch "local"]\n\tremote = .\n\tmerge = refs/heads/main\n' +
        '[branch "half"]\n\tremote = origin\n',
    );
    expect(upstreamOf(cfg, "main")).toBe("origin/main");
    expect(upstreamOf(cfg, "local")).toBe("main");
    expect(upstreamOf(cfg, "half")).toBeNull();
    expect(upstreamOf(cfg, "absent")).toBeNull();
  });
});
