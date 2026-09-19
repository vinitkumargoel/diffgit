/**
 * T10.5: the commit walker equals `git log --date-order --format=%H` on every fixture T10.0
 * recorded an order for, with and without `--first-parent` and with `--all`; the path walk equals
 * `git log --format=%H -- <path>`; the lanes are structurally continuous; `aheadBehind` equals
 * `git rev-list --left-right --count`; and `markReachable` agrees with git's orphan list.
 */
import { describe, expect, test } from "bun:test";
import {
  fixturePath,
  HISTORY_FIXTURE,
  hasExpected,
  hasFixture,
  loadExpectedLines,
} from "../../test/fixtures";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { CommitSummary, RepoWarning, WalkPage, WalkRequest } from "../types";
import { MAX_LANES, placeCommit } from "./walk";

/** Fixtures whose `expected/log-*-date-order.txt` T10.0/T10.5 recorded from the real git CLI. */
const ORDER_FIXTURES = ["history", "octopus", "crisscross", "detached", "perf-5k"] as const;

interface Rig {
  session: RepoSession;
  warnings: RepoWarning[];
  close: () => Promise<void>;
}

async function open(name: string): Promise<Rig> {
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
    { id: `walk-${name}` },
  );
  return { session, warnings, close: () => session.close() };
}

/** Every commit of a walk, paged with `limit` so the cursor is exercised on every fixture. */
async function walkAll(
  session: RepoSession,
  req: Omit<WalkRequest, "cursor">,
): Promise<{ commits: CommitSummary[]; pages: WalkPage[] }> {
  const commits: CommitSummary[] = [];
  const pages: WalkPage[] = [];
  let cursor: string | null = null;
  do {
    const page: WalkPage = await session.walkCommits(cursor === null ? req : { ...req, cursor });
    pages.push(page);
    commits.push(...page.commits);
    cursor = page.cursor;
  } while (cursor !== null && pages.length < 200);
  return { commits, pages };
}

describe("walkCommits — order parity with git", () => {
  for (const name of ORDER_FIXTURES) {
    const maybe = hasFixture(name) ? test : test.skip;
    maybe(`${name}: HEAD equals git log --date-order`, async () => {
      const rig = await open(name);
      try {
        const { commits } = await walkAll(rig.session, {
          from: ["HEAD"],
          firstParent: false,
          limit: 7,
        });
        expect(commits.map((c) => c.oid)).toEqual(loadExpectedLines(name, "log-head-date-order"));
      } finally {
        await rig.close();
      }
    });

    maybe(`${name}: --first-parent equals git log --date-order --first-parent`, async () => {
      const rig = await open(name);
      try {
        const { commits } = await walkAll(rig.session, {
          from: ["HEAD"],
          firstParent: true,
          limit: 7,
        });
        expect(commits.map((c) => c.oid)).toEqual(loadExpectedLines(name, "log-head-first-parent"));
      } finally {
        await rig.close();
      }
    });

    maybe(`${name}: --all equals git log --date-order --all`, async () => {
      const rig = await open(name);
      try {
        const { commits } = await walkAll(rig.session, {
          from: [],
          firstParent: false,
          all: true,
          limit: 7,
        });
        expect(commits.map((c) => c.oid)).toEqual(loadExpectedLines(name, "log-all-date-order"));
      } finally {
        await rig.close();
      }
    });
  }

  test("history: main equals git log --date-order main, with and without --first-parent", async () => {
    const rig = await open("history");
    try {
      const all = await walkAll(rig.session, { from: ["main"], firstParent: false, limit: 50 });
      expect(all.commits.map((c) => c.oid)).toEqual(
        loadExpectedLines("history", "log-main-date-order"),
      );
      const first = await walkAll(rig.session, { from: ["main"], firstParent: true, limit: 50 });
      expect(first.commits.map((c) => c.oid)).toEqual(
        loadExpectedLines("history", "log-main-first-parent"),
      );
      // The merge's second parent is in the full walk and not in the first-parent one.
      expect(all.commits.length).toBeGreaterThan(first.commits.length);
    } finally {
      await rig.close();
    }
  });

  test("octopus: the three-parent merge reports all three parents", async () => {
    const rig = await open("octopus");
    try {
      const { commits } = await walkAll(rig.session, {
        from: [],
        firstParent: false,
        all: true,
        limit: 50,
      });
      const expected = (loadExpectedLines("octopus", "merge-parents")[0] as string).split(" ");
      const merge = commits.find((c) => c.oid === expected[0]);
      expect(merge?.parents).toEqual(expected.slice(1));
      expect(merge?.parents.length).toBe(3);
    } finally {
      await rig.close();
    }
  });

  test("a single page stops at `limit` and hands back a usable cursor", async () => {
    const rig = await open("history");
    try {
      const first = await rig.session.walkCommits({ from: ["main"], firstParent: false, limit: 5 });
      expect(first.commits.length).toBe(5);
      expect(first.cursor).not.toBeNull();
      expect(first.graphAvailable).toBe(true);
      expect(first.capped).toBe(false);
      const second = await rig.session.walkCommits({
        from: ["main"],
        firstParent: false,
        limit: 5,
        cursor: first.cursor as string,
      });
      const expected = loadExpectedLines("history", "log-main-date-order");
      expect(first.commits.map((c) => c.oid)).toEqual(expected.slice(0, 5));
      expect(second.commits.map((c) => c.oid)).toEqual(expected.slice(5, 10));
    } finally {
      await rig.close();
    }
  });

  test("a repository without a commit-graph still walks, with graphAvailable false", async () => {
    const rig = await open("octopus");
    try {
      const page = await rig.session.walkCommits({ from: ["HEAD"], firstParent: false, limit: 50 });
      expect(page.graphAvailable).toBe(false);
      expect(page.commits.length).toBeGreaterThan(0);
      expect(rig.warnings.filter((w) => w.code === "COMMIT_GRAPH_STALE")).toEqual([]);
    } finally {
      await rig.close();
    }
  });
});

describe("walkCommits — path filter", () => {
  for (const [file, path] of [
    ["log-path-hot", HISTORY_FIXTURE.hotPath],
    ["log-path-renamed", HISTORY_FIXTURE.renamedTo],
  ] as const) {
    test(`${path} equals git log --format=%H main -- ${path}`, async () => {
      const rig = await open("history");
      try {
        const { commits } = await walkAll(rig.session, {
          from: ["main"],
          firstParent: false,
          limit: 2,
          path,
        });
        expect(commits.map((c) => c.oid)).toEqual(loadExpectedLines("history", file));
        // No rename following here (T10.6): the walk stops at the `git mv`.
        expect(commits.every((c) => c.lane === undefined)).toBe(true);
      } finally {
        await rig.close();
      }
    });
  }

  test("a path nothing ever touched yields no commits", async () => {
    const rig = await open("history");
    try {
      const page = await rig.session.walkCommits({
        from: ["main"],
        firstParent: false,
        limit: 50,
        path: "does/not/exist.txt",
      });
      expect(page.commits).toEqual([]);
      expect(page.cursor).toBeNull();
    } finally {
      await rig.close();
    }
  });
});

describe("lanes", () => {
  /**
   * The graph column must be drawable from two consecutive rows alone: every parent that is also
   * in the page is reached by an unbroken chain of edges in one lane.
   */
  function assertContinuous(commits: CommitSummary[]): void {
    const rowOf = new Map(commits.map((c, i) => [c.oid, i]));
    for (let i = 0; i < commits.length; i++) {
      const row = commits[i] as CommitSummary;
      expect(row.lane).toBeGreaterThanOrEqual(0);
      expect(row.laneCount).toBeGreaterThan(row.lane as number);
      for (const parent of row.parents) {
        const target = rowOf.get(parent);
        if (target === undefined) continue; // the parent is on a later page
        const laneIndex = (commits[target] as CommitSummary).lane as number;
        // this row hands the parent's line to that lane …
        expect(
          (row.edges ?? []).some((e) => e.from === (row.lane as number) && e.to === laneIndex),
        ).toBe(true);
        // … and every row in between keeps it there
        for (let r = i + 1; r < target; r++) {
          const between = commits[r] as CommitSummary;
          expect(
            (between.edges ?? []).some((e) => e.from === laneIndex && e.to === laneIndex),
          ).toBe(true);
        }
      }
    }
  }

  test("history --all: every parent edge connects consecutive rows, ≤ 12 lanes", async () => {
    const rig = await open("history");
    try {
      const { commits } = await walkAll(rig.session, {
        from: [],
        firstParent: false,
        all: true,
        limit: 7,
      });
      assertContinuous(commits);
      expect(Math.max(...commits.map((c) => c.laneCount as number))).toBeLessThanOrEqual(MAX_LANES);
    } finally {
      await rig.close();
    }
  });

  test("octopus: the merge opens a lane per extra parent and they all close again", async () => {
    const rig = await open("octopus");
    try {
      const { commits } = await walkAll(rig.session, {
        from: [],
        firstParent: false,
        all: true,
        limit: 50,
      });
      assertContinuous(commits);
      const merge = commits.find((c) => c.parents.length === 3) as CommitSummary;
      expect(merge.edges?.filter((e) => e.from === merge.lane)).toHaveLength(3);
      expect(merge.edges?.filter((e) => e.kind === "fork").length).toBeGreaterThan(0);
      expect(commits[commits.length - 1]?.edges).toEqual([]); // the root closes the last lane
    } finally {
      await rig.close();
    }
  });

  test("placeCommit: a straight chain stays in lane 0", () => {
    const lanes: (string | null)[] = [];
    const a = placeCommit(lanes, { oid: "a", parents: ["b"] }, false);
    const b = placeCommit(lanes, { oid: "b", parents: ["c"] }, false);
    expect(a).toEqual({ lane: 0, laneCount: 1, edges: [{ from: 0, to: 0, kind: "straight" }] });
    expect(b.lane).toBe(0);
    expect(lanes).toEqual(["c"]);
  });

  test("placeCommit: two branches converging on one parent merge back into its lane", () => {
    const lanes: (string | null)[] = [];
    placeCommit(lanes, { oid: "tip-a", parents: ["base"] }, false); // reserves lane 0 for base
    const second = placeCommit(lanes, { oid: "tip-b", parents: ["base"] }, false);
    expect(second.lane).toBe(1);
    // the merge line plus the vertical line lane 0 was already drawing for `base`
    expect(second.edges).toEqual([
      { from: 1, to: 0, kind: "merge" },
      { from: 0, to: 0, kind: "straight" },
    ]);
    expect(lanes).toEqual(["base"]);
  });

  test("placeCommit: --first-parent never opens a lane for the second parent", () => {
    const lanes: (string | null)[] = [];
    const row = placeCommit(lanes, { oid: "m", parents: ["p1", "p2"] }, true);
    expect(row.edges).toEqual([{ from: 0, to: 0, kind: "straight" }]);
    expect(lanes).toEqual(["p1"]);
  });
});

describe("aheadBehind", () => {
  test("history: equals git rev-list --left-right --count", async () => {
    const rig = await open("history");
    try {
      for (const line of loadExpectedLines("history", "rev-list-left-right-count")) {
        const [range, left, right] = line.split("\t") as [string, string, string];
        const [a, b] = range.split("...") as [string, string];
        const got = await rig.session.aheadBehind(a, b);
        expect(`${a}...${b} ${got.ahead} ${got.behind}`).toBe(`${range} ${left} ${right}`);
        expect(got.capped).toBe(false);
        expect(got.mergeBase).not.toBeNull();
      }
    } finally {
      await rig.close();
    }
  });

  test("a branch compared with itself is 0/0 and its own merge base", async () => {
    const rig = await open("history");
    try {
      const got = await rig.session.aheadBehind("main", "main");
      expect(got.ahead).toBe(0);
      expect(got.behind).toBe(0);
      expect(got.mergeBase).toBe((await rig.session.resolveRevision("main")).oid);
    } finally {
      await rig.close();
    }
  });

  test("crisscross: two merge bases still give git's counts", async () => {
    const rig = await open("crisscross");
    try {
      const got = await rig.session.aheadBehind("main", "feature");
      const reverse = await rig.session.aheadBehind("feature", "main");
      expect(got.ahead).toBe(reverse.behind);
      expect(got.behind).toBe(reverse.ahead);
      expect(got.mergeBase).not.toBeNull();
    } finally {
      await rig.close();
    }
  });

  test("unrelated histories have no merge base and count every commit", async () => {
    const rig = await open("unrelated");
    try {
      const got = await rig.session.aheadBehind("main", "feature");
      expect(got.mergeBase).toBeNull();
      expect(got.ahead).toBeGreaterThan(0);
      expect(got.behind).toBeGreaterThan(0);
    } finally {
      await rig.close();
    }
  });
});

describe("markReachable", () => {
  test("reflog-orphan: git's orphan list is exactly what is unreachable", async () => {
    const rig = await open("reflog-orphan");
    try {
      const entries = await rig.session.reflog("HEAD", 200);
      const orphans = new Set(loadExpectedLines("reflog-orphan", "orphan"));
      expect(orphans.size).toBe(2);
      // `reflog()` fills `reachable` itself (T10.5), so T11.3's badge needs no second call.
      expect(entries.every((e) => e.reachable !== null)).toBe(true);
      for (const e of entries) expect(e.reachable).toBe(!orphans.has(e.newOid));
      const direct = await rig.session.markReachable(entries.map((e) => e.newOid));
      for (const e of entries) expect(direct[e.newOid]).toBe(e.reachable as boolean);
    } finally {
      await rig.close();
    }
  });

  test("history: every commit git lists is reachable, an invented oid is not", async () => {
    const rig = await open("history");
    try {
      const oids = loadExpectedLines("history", "log-all-date-order");
      const got = await rig.session.markReachable([...oids, "0".repeat(40)]);
      for (const oid of oids) expect(got[oid]).toBe(true);
      expect(got["0".repeat(40)]).toBe(false);
    } finally {
      await rig.close();
    }
  });

  test("a fixture with no reflog answers NO_REFLOG and no reachability work", async () => {
    const rig = await open("unborn");
    try {
      expect(hasExpected("unborn", "reflog")).toBe(false);
      const entries = await rig.session.reflog("HEAD", 50);
      expect(entries).toEqual([]);
      expect(rig.warnings.some((w) => w.code === "NO_REFLOG")).toBe(true);
    } finally {
      await rig.close();
    }
  });
});
