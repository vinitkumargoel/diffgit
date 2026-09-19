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
import { EngineError } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { CommitSummary, RepoWarning, WalkPage, WalkRequest } from "../types";
import { branchOverview } from "./branches";
import { CommitGraph } from "./commitGraph";
import { commitStats } from "./commits";
import type { ObjectDb } from "./objectDb";
import {
  aheadBehind,
  CommitReader,
  MAX_LANES,
  MAX_WALK,
  PROGRESS_EVERY,
  placeCommit,
  reachableFrom,
  walkCommits,
} from "./walk";

/** Fixtures whose `expected/log-*-date-order.txt` T10.0/T10.5 recorded from the real git CLI. */
const ORDER_FIXTURES = [
  "history",
  "octopus",
  "crisscross",
  "detached",
  "skew",
  "perf-5k",
  "perf-log",
] as const;

/** A big fixture is paged in chunks of 250; the small ones in 7s, so the cursor is exercised. */
const pageSize = (name: string) => (name.startsWith("perf-") ? 250 : 7);

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
  } while (cursor !== null && pages.length < 500);
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
          limit: pageSize(name),
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
          limit: pageSize(name),
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
          limit: pageSize(name),
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
    const rig = await open("crisscross");
    try {
      const page = await rig.session.walkCommits({ from: ["HEAD"], firstParent: false, limit: 50 });
      expect(page.graphAvailable).toBe(false);
      expect(page.commits.length).toBeGreaterThan(0);
      expect(rig.warnings.filter((w) => w.code === "COMMIT_GRAPH_STALE")).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  // T10.5b nit 1: `octopus` now carries a commit-graph, which is the only fixture whose graph needs
  // an EDGE chunk — the 3rd..nth parents of the merge come out of it, not out of the commit object.
  test("octopus: the three-parent merge is read from the commit-graph EDGE chunk", async () => {
    const rig = await open("octopus");
    try {
      const page = await rig.session.walkCommits({
        from: [],
        firstParent: false,
        all: true,
        limit: 50,
      });
      expect(page.graphAvailable).toBe(true);
      const expected = (loadExpectedLines("octopus", "merge-parents")[0] as string).split(" ");
      const merge = page.commits.find((c) => c.oid === expected[0]);
      expect(merge?.parents).toEqual(expected.slice(1));
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
      // A parent *above* its child would be a topological-order bug; the order tests assert it
      // cannot happen, and `placeCommit` draws no edge for one (T10.5b S1).
      expect(target).toBeGreaterThan(i);
      const laneIndex = (commits[target] as CommitSummary).lane as number;
      // this row hands the parent's line to that lane …
      expect(
        (row.edges ?? []).some((e) => e.from === (row.lane as number) && e.to === laneIndex),
      ).toBe(true);
      // … and every row in between keeps it there
      for (let r = i + 1; r < target; r++) {
        const between = commits[r] as CommitSummary;
        expect((between.edges ?? []).some((e) => e.from === laneIndex && e.to === laneIndex)).toBe(
          true,
        );
      }
    }
  }
}

describe("lanes", () => {
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
    expect(a).toEqual({
      lane: 0,
      laneCount: 1,
      edges: [{ from: 0, to: 0, kind: "straight" }],
      overflow: false,
    });
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

// ---- T10.5b: walker review fixes -------------------------------------------------------------

describe("T10.5b B1 — refs that do not point at a commit", () => {
  test("tags: a blob tag and a tree tag are reported with their real target type", async () => {
    const rig = await open("tags");
    try {
      const tags = await rig.session.listTags();
      expect(tags.find((t) => t.name === "blob-tag")?.targetType).toBe("blob");
      expect(tags.find((t) => t.name === "tree-tag")?.targetType).toBe("tree");
      expect(tags.find((t) => t.name === "v1.0.0")?.targetType).toBe("commit");
    } finally {
      await rig.close();
    }
  });

  test("tags: walkCommits --all skips them and equals git log --all", async () => {
    const rig = await open("tags");
    try {
      const { commits } = await walkAll(rig.session, {
        from: [],
        firstParent: false,
        all: true,
        limit: 3,
      });
      expect(commits.map((c) => c.oid)).toEqual(loadExpectedLines("tags", "log-all-date-order"));
    } finally {
      await rig.close();
    }
  });

  test("tags: markReachable and reflog survive them", async () => {
    const rig = await open("tags");
    try {
      const tags = await rig.session.listTags();
      const blob = tags.find((t) => t.name === "blob-tag")?.targetOid as string;
      const head = (await rig.session.resolveRevision("HEAD")).oid as string;
      const marks = await rig.session.markReachable([head, blob]);
      expect(marks[head]).toBe(true);
      expect(marks[blob]).toBe(false); // a blob is never a commit `rev-list --all` reaches
      const entries = await rig.session.reflog("HEAD", 50);
      expect(entries.every((e) => e.reachable !== null)).toBe(true);
    } finally {
      await rig.close();
    }
  });

  test("CommitReader.meta answers null for a blob and a tree", async () => {
    const rig = await open("tags");
    try {
      const db = rig.session.db;
      const reader = new CommitReader(db, null);
      const tags = await rig.session.listTags();
      for (const name of ["blob-tag", "tree-tag"]) {
        const oid = tags.find((t) => t.name === name)?.targetOid as string;
        expect(await reader.meta(oid)).toBeNull();
        expect(await reader.isCommit(oid)).toBe(false);
      }
      const head = (await rig.session.resolveRevision("HEAD")).oid as string;
      expect((await reader.meta(head))?.parents.length).toBe(1);
    } finally {
      await rig.close();
    }
  });
});

describe("T10.5b S1 — committer-date skew", () => {
  test("skew: --all equals git log --date-order --all and leaks no lane", async () => {
    const rig = await open("skew");
    try {
      const { commits } = await walkAll(rig.session, {
        from: [],
        firstParent: false,
        all: true,
        limit: 2,
      });
      expect(commits.map((c) => c.oid)).toEqual(loadExpectedLines("skew", "log-all-date-order"));
      // Every parent that is also on the page is reached by an unbroken chain of edges …
      assertContinuous(commits);
      // … and the last row closes every lane it was still drawing: nothing was reserved for a
      // commit that had already been emitted.
      expect(commits[commits.length - 1]?.edges).toEqual([]);
      expect(Math.max(...commits.map((c) => c.laneCount as number))).toBeLessThanOrEqual(2);
    } finally {
      await rig.close();
    }
  });

  test("skew: HEAD and --first-parent also match git", async () => {
    const rig = await open("skew");
    try {
      const head = await walkAll(rig.session, { from: ["HEAD"], firstParent: false, limit: 2 });
      expect(head.commits.map((c) => c.oid)).toEqual(
        loadExpectedLines("skew", "log-head-date-order"),
      );
      const first = await walkAll(rig.session, { from: ["HEAD"], firstParent: true, limit: 2 });
      expect(first.commits.map((c) => c.oid)).toEqual(
        loadExpectedLines("skew", "log-head-first-parent"),
      );
    } finally {
      await rig.close();
    }
  });

  test("placeCommit never reserves a lane for an already emitted parent", () => {
    const lanes: (string | null)[] = [];
    placeCommit(lanes, { oid: "p", parents: ["r"] }, false);
    const row = placeCommit(lanes, { oid: "c", parents: ["t", "p"] }, false, {
      emitted: new Set(["p"]),
    });
    // only the `t` edge: `p`'s line closed two rows ago and must not be drawn into.
    expect(row.edges.filter((e) => e.from === row.lane)).toHaveLength(1);
    expect(lanes.includes("p")).toBe(false);
  });
});

describe("T10.5b S2/S4 — the cursor is an opaque session token", () => {
  test("the cursor is a short token, not a serialised frontier", async () => {
    const rig = await open("history");
    try {
      const page = await rig.session.walkCommits({ from: ["main"], firstParent: false, limit: 5 });
      expect(page.cursor).not.toBeNull();
      expect((page.cursor as string).length).toBeLessThan(24);
      expect(page.cursor).toMatch(/^w[0-9a-f]{8}\.\d+$/);
    } finally {
      await rig.close();
    }
  });

  test("a cursor whose request key no longer matches answers STALE", async () => {
    const rig = await open("history");
    try {
      const page = await rig.session.walkCommits({ from: ["main"], firstParent: false, limit: 5 });
      // Same token, different query: page 1 of the new query would silently repeat itself.
      await expect(
        rig.session.walkCommits({
          from: ["main"],
          firstParent: true,
          limit: 5,
          cursor: page.cursor as string,
        }),
      ).rejects.toMatchObject({ code: "STALE" });
    } finally {
      await rig.close();
    }
  });

  test("a token this session never issued answers STALE", async () => {
    const rig = await open("history");
    try {
      await expect(
        rig.session.walkCommits({
          from: ["main"],
          firstParent: false,
          limit: 5,
          cursor: "wdeadbeef.99",
        }),
      ).rejects.toMatchObject({ code: "STALE" });
    } finally {
      await rig.close();
    }
  });

  test("a malformed cursor is a caller bug: INTERNAL, with the text as detail", async () => {
    const rig = await open("history");
    try {
      await expect(
        rig.session.walkCommits({
          from: ["main"],
          firstParent: false,
          limit: 5,
          cursor: '{"v":2,"frontier":[]}',
        }),
      ).rejects.toMatchObject({ code: "INTERNAL" });
    } finally {
      await rig.close();
    }
  });

  test("refs moving invalidates every outstanding cursor", async () => {
    const rig = await open("history");
    try {
      const page = await rig.session.walkCommits({ from: ["main"], firstParent: false, limit: 5 });
      await rig.session.reloadRefs();
      await expect(
        rig.session.walkCommits({
          from: ["main"],
          firstParent: false,
          limit: 5,
          cursor: page.cursor as string,
        }),
      ).rejects.toMatchObject({ code: "STALE" });
    } finally {
      await rig.close();
    }
  });
});

describe("T10.5b S3 — ahead/behind is git's algorithm, not two truncated sets", () => {
  /** `aheadBehind` straight from the module, so the cap can be scaled down (T10.5b S3). */
  async function counts(rig: Rig, a: string, b: string, cap: number) {
    const left = (await rig.session.resolveRevision(a)).oid as string;
    const right = (await rig.session.resolveRevision(b)).oid as string;
    return aheadBehind(rig.session.db, new CommitReader(rig.session.db, null), left, right, {
      cap,
    });
  }

  test("history: a 55-commit shared trunk with the cap at 10 still gives exact counts", async () => {
    const rig = await open("history");
    try {
      // `main` is 60 commits deep; the old version built both reachability sets and truncated each
      // at the cap, so every number past it was arbitrary.
      const got = await counts(rig, "main", "main~5", 10);
      expect({ ahead: got.ahead, behind: got.behind, capped: got.capped }).toEqual({
        ahead: 5,
        behind: 0,
        capped: false,
      });
      const back = await counts(rig, "main~5", "main", 10);
      expect({ ahead: back.ahead, behind: back.behind }).toEqual({ ahead: 0, behind: 5 });
    } finally {
      await rig.close();
    }
  });

  test("crisscross: two merge bases, cap at 6, exact 2/2", async () => {
    const rig = await open("crisscross");
    try {
      const got = await counts(rig, "main", "feature", 6);
      const [range, left, right] = (
        loadExpectedLines("crisscross", "rev-list-left-right-count")[0] as string
      ).split("\t") as [string, string, string];
      expect(`${range} ${got.ahead} ${got.behind}`).toBe(`${range} ${left} ${right}`);
      expect(got.capped).toBe(false);
    } finally {
      await rig.close();
    }
  });

  test("history: the oracle counts are reproduced with a cap far below the history size", async () => {
    const rig = await open("history");
    try {
      for (const line of loadExpectedLines("history", "rev-list-left-right-count")) {
        const [range, left, right] = line.split("\t") as [string, string, string];
        const [a, b] = range.split("...") as [string, string];
        const got = await counts(rig, a, b, 200);
        expect(`${range} ${got.ahead} ${got.behind}`).toBe(`${range} ${left} ${right}`);
      }
    } finally {
      await rig.close();
    }
  });

  test("a cap that does bite reports capped and lower bounds", async () => {
    const rig = await open("history");
    try {
      const got = await counts(rig, "main", "topic", 3);
      expect(got.capped).toBe(true);
      expect(got.ahead).toBeLessThanOrEqual(36);
    } finally {
      await rig.close();
    }
  });

  test("branchCells walks each pair once: 50 rows do not re-walk the trunk", async () => {
    const rig = await open("history");
    try {
      const rows = await rig.session.branchOverview();
      const names = rows.map((r) => r.ref.fullName);
      const t0 = performance.now();
      const first = await rig.session.branchCells(names);
      const firstMs = performance.now() - t0;
      const t1 = performance.now();
      const second = await rig.session.branchCells(names);
      const secondMs = performance.now() - t1;
      expect(second).toEqual(first);
      // The memo makes the second call a lookup per row; allow a wide margin for a noisy machine.
      expect(secondMs).toBeLessThanOrEqual(Math.max(firstMs, 1));
    } finally {
      await rig.close();
    }
  });
});

describe("T10.5b S5 — every long loop honours the AbortSignal", () => {
  const aborted = (): AbortSignal => AbortSignal.abort();

  test("walkCommits, reachableFrom and aheadBehind throw CANCELLED on an aborted signal", async () => {
    const rig = await open("history");
    try {
      const reader = new CommitReader(rig.session.db, null);
      const head = (await rig.session.resolveRevision("main")).oid as string;
      const topic = (await rig.session.resolveRevision("topic")).oid as string;
      await expect(
        walkCommits(
          { db: rig.session.db, reader, refsByCommit: new Map(), signal: aborted() },
          { from: ["main"], firstParent: false, limit: 50 },
          [head],
        ),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      await expect(reachableFrom(reader, [head], MAX_WALK, aborted())).rejects.toMatchObject({
        code: "CANCELLED",
      });
      await expect(
        aheadBehind(rig.session.db, reader, head, topic, { signal: aborted() }),
      ).rejects.toMatchObject({ code: "CANCELLED" });
    } finally {
      await rig.close();
    }
  });

  test("a superseded walkCommits rejects with CANCELLED", async () => {
    const rig = await open("history");
    try {
      const first = rig.session.walkCommits({ from: [], firstParent: false, all: true, limit: 50 });
      const second = rig.session.walkCommits({ from: ["main"], firstParent: false, limit: 5 });
      await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
      expect((await second).commits.length).toBe(5);
    } finally {
      await rig.close();
    }
  });

  const maybePerf = hasFixture("perf-log") ? test : test.skip;
  maybePerf("perf-log: progress is reported while walking, not once at the end", async () => {
    const seen: number[] = [];
    const session = await RepoSession.open(
      await NodeDirHandle.open(fixturePath("perf-log")),
      {
        onProgress(p) {
          if (p.phase === "history" && p.durationMs === undefined) seen.push(p.done ?? 0);
        },
        onStats() {},
        onWarning() {},
      },
      { id: "walk-perf-log-progress" },
    );
    try {
      await session.walkCommits({ from: ["main"], firstParent: false, limit: 2000 });
      // 2,000 commits at one message per PROGRESS_EVERY, plus the final one.
      expect(seen.length).toBeGreaterThanOrEqual(Math.floor(2000 / PROGRESS_EVERY));
      expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(2000);
    } finally {
      await session.close();
    }
  });
});

describe("T10.5b nits — lane cap, input hardening, degraded reads", () => {
  test("nit 4: more tips than MAX_LANES fold into the last lane and report laneOverflow", () => {
    const lanes: (string | null)[] = [];
    let overflow = false;
    let widest = 0;
    for (let i = 0; i < MAX_LANES + 5; i++) {
      const row = placeCommit(lanes, { oid: `tip${i}`, parents: [`p${i}`] }, false);
      overflow ||= row.overflow;
      widest = Math.max(widest, row.laneCount);
    }
    expect(overflow).toBe(true);
    expect(widest).toBe(MAX_LANES);
    expect(lanes.length).toBeLessThanOrEqual(MAX_LANES);
  });

  test("nit 4: a page without overflow reports laneOverflow false", async () => {
    const rig = await open("history");
    try {
      const page = await rig.session.walkCommits({
        from: [],
        firstParent: false,
        all: true,
        limit: 50,
      });
      expect(page.laneOverflow).toBe(false);
    } finally {
      await rig.close();
    }
  });

  test("nit 5: a limit that is not a positive integer is INTERNAL", async () => {
    const rig = await open("history");
    try {
      for (const limit of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
        await expect(
          rig.session.walkCommits({ from: ["main"], firstParent: false, limit }),
        ).rejects.toMatchObject({ code: "INTERNAL" });
      }
    } finally {
      await rig.close();
    }
  });

  test("nit 5/6: a repeated seed is walked once", async () => {
    const rig = await open("history");
    try {
      const once = await walkAll(rig.session, { from: ["main"], firstParent: false, limit: 50 });
      const twice = await walkAll(rig.session, {
        from: ["main", "main", "refs/heads/main"],
        firstParent: false,
        limit: 50,
      });
      expect(twice.commits.map((c) => c.oid)).toEqual(once.commits.map((c) => c.oid));
    } finally {
      await rig.close();
    }
  });

  test("nit 2: an unreadable commit-graph is a HISTORY_DEGRADED warning, not silence", async () => {
    const io = new EngineError("EIO", "disk went away");
    const fs = {
      readFile: () => Promise.reject(io),
      exists: () => Promise.resolve(false),
    } as unknown as FsaFs;
    const load = await CommitGraph.load(fs);
    expect(load.graph).toBeNull();
    expect(load.warnings.map((w) => w.code)).toEqual(["HISTORY_DEGRADED"]);
    expect(load.warnings[0]?.detail).toContain("IO_ERROR");
  });

  test("nit 2: an absent commit-graph stays silent", async () => {
    const fs = {
      readFile: () => Promise.reject(new EngineError("ENOENT", "no such file")),
      exists: () => Promise.resolve(false),
    } as unknown as FsaFs;
    const load = await CommitGraph.load(fs);
    expect(load.status).toBe("absent");
    expect(load.warnings).toEqual([]);
  });

  test("nit 2: a branch row whose commit cannot be read warns instead of going quiet", async () => {
    const rig = await open("tags");
    try {
      const blob = (await rig.session.listTags()).find((t) => t.name === "blob-tag")
        ?.targetOid as string;
      const warnings: RepoWarning[] = [];
      const rows = await branchOverview(
        {
          db: rig.session.db,
          reader: new CommitReader(rig.session.db, null),
          cfg: rig.session.cfg,
          refs: {
            headBranch: "main",
            headOid: null,
            detached: false,
            unborn: false,
            headDisplay: "main",
            refs: [
              {
                name: "broken",
                fullName: "refs/heads/broken",
                kind: "local",
                oid: blob,
                isDefault: false,
                isCheckedOut: false,
              },
            ],
            defaultRef: null,
          },
          warn: (w) => warnings.push(w),
        },
        [],
      );
      expect(rows[0]?.lastCommit).toBeNull();
      expect(warnings.map((w) => w.code)).toEqual(["HISTORY_DEGRADED"]);
      expect(warnings[0]?.detail).toContain("IO_ERROR");
    } finally {
      await rig.close();
    }
  });

  test("nit 2: commitStats reports a commit it could not read", async () => {
    const warnings: RepoWarning[] = [];
    const db = {
      flattenTree: () => Promise.reject(new EngineError("EIO", "pack went away")),
    } as unknown as ObjectDb;
    const reader = {
      meta: () => Promise.resolve({ parents: ["p".repeat(40)], time: 1 }),
    } as unknown as CommitReader;
    const out = await commitStats(
      { db, reader, limit: (fn) => fn(), warn: (w) => warnings.push(w) },
      ["a".repeat(40)],
    );
    expect(out["a".repeat(40)]).toBeNull();
    expect(warnings.map((w) => w.code)).toEqual(["HISTORY_DEGRADED"]);
  });

  test("nit 7: BranchRow.lastCommit.timestamp is the committer date", async () => {
    const rig = await open("history");
    try {
      const rows = await rig.session.branchOverview();
      const main = rows.find((r) => r.ref.name === "main") as {
        lastCommit: { oid: string; timestamp: number } | null;
      };
      const commit = await rig.session.commitDetails(main.lastCommit?.oid as string);
      expect(main.lastCommit?.timestamp).toBe(commit.committer.timestamp);
    } finally {
      await rig.close();
    }
  });

  test("nit 9: commitGraph.position clamps a fanout that points past the lookup chunk", async () => {
    const rig = await open("history");
    try {
      const load = await CommitGraph.load(rig.session.fs);
      const graph = load.graph as CommitGraph;
      expect(graph.position("f".repeat(40))).toBe(-1);
      expect(graph.position("zz")).toBe(-1);
      expect(graph.oidAt(graph.count)).toBeNull();
      expect(graph.oidAt(-1)).toBeNull();
    } finally {
      await rig.close();
    }
  });
});
