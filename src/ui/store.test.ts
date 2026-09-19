import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BranchesSource,
  DiffResult,
  DiffSource,
  RangeSource,
  RepoInfo,
} from "../engine/types";
import historyInfo from "../test/recorded/history.repoinfo.json";
import basicInfo from "../test/recorded/showcase.repoinfo.json";
import { blameCacheKey, pathHistoryCacheKey } from "./blame";
import { Lru } from "./lru";
import { derivedKey, resetDerivedStore, setDerived } from "./persistence/derived";
import {
  configurePersistence,
  INITIAL_BRANCHES,
  INITIAL_HISTORY,
  INITIAL_STACK,
  isViewed,
  selectBranchBase,
  selectCanIncludeWorktree,
  selectConflictKind,
  selectConflictKinds,
  selectGroupTotals,
  selectHasLayers,
  selectHiddenEntries,
  selectHistoryRows,
  selectSourceLabel,
  selectTotals,
  selectViewedCount,
  selectVisibleFiles,
  setStoreClient,
  useStore,
} from "./store";
import { viewedKey } from "./viewedKey";
import { createMockWorkerClient, type MockWorkerClient } from "./workerClient.mock";

let mock: MockWorkerClient;
let derivedSeq = 0;
/** Narrows the store's DiffSource to the branch pair these tests always build (T10.1 union). */
function branches(src: DiffSource | null | undefined): BranchesSource | null {
  return src && src.kind === "branches" ? src : null;
}

const initial = useStore.getState();

beforeEach(() => {
  mock = createMockWorkerClient();
  setStoreClient(mock);
  useStore.setState(initial, true);
  // T11.6 writes blames into `diffgit-derived`; a fresh database per case keeps them apart.
  derivedSeq++;
  resetDerivedStore(`store-derived-${derivedSeq}`);
});
afterEach(() => {
  setStoreClient(null);
});

async function openBasic(opts?: Parameters<typeof initial.openRepo>[1]) {
  await useStore.getState().openRepo({ name: "showcase" }, opts);
}

describe("store: v2 shell (T11.1)", () => {
  it("starts in Files mode with the palette closed and the v2 fields empty", async () => {
    await openBasic();
    const s = useStore.getState();
    expect(s.mode).toBe("files");
    expect(s.palette).toBe(false);
    expect(s.historyTab).toBe("commits");
    expect(s.cardModes).toEqual({});
    expect(s.operation).toBeNull();
    expect(s.secrets).toBeNull();
    expect(s.hidden).toBeNull();
    expect(s.bisect).toBeNull();
    expect(s.snapshotMode).toBe(false);
    expect(s.patchOnly).toBe(false);
    expect(s.history).toEqual({
      commits: [],
      cursor: null,
      loading: false,
      selected: null,
      rangeStart: null,
      query: "",
      firstParent: false,
      all: false,
      capped: false,
      laneOverflow: false,
    });
    expect(s.commitDetails).toEqual({});
    expect(s.commitStats).toEqual({});
    expect(s.stack.ready).toBe(false);
  });

  it("setMode switches and closes the palette; closing the repo returns to Files", async () => {
    await openBasic();
    const { setMode, setPalette } = useStore.getState();
    setPalette(true);
    expect(useStore.getState().palette).toBe(true);
    setMode("insights");
    expect(useStore.getState().mode).toBe("insights");
    expect(useStore.getState().palette).toBe(false);
    setPalette(true);
    setMode("insights"); // same mode: nothing to do, the palette stays as it is
    expect(useStore.getState().palette).toBe(true);
    await useStore.getState().closeRepo();
    expect(useStore.getState().mode).toBe("files");
    expect(useStore.getState().palette).toBe(false);
  });
});

describe("store", () => {
  it("openRepo sets defaults from RepoInfo: source = checked-out, target = default, worktree on", async () => {
    await openBasic();
    const s = useStore.getState();
    expect(s.screen).toBe("repo");
    expect(s.diffSource).toEqual({
      kind: "branches",
      source: "feature",
      target: "main",
      sourceRef: "refs/heads/feature",
      targetRef: "refs/heads/main",
      includeWorktree: true,
    });
    expect(s.diff?.files.length).toBe(12);
    expect(selectCanIncludeWorktree(s)).toBe(true);
    await vi.waitFor(() => expect(Object.keys(useStore.getState().stats).length).toBe(12));
    expect(selectTotals(useStore.getState()).additions).toBeGreaterThan(3000);
  });

  it("stats streamed before the result is committed (slow loadViewed) are not lost", async () => {
    configurePersistence({
      loadViewed: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return new Set<string>();
      },
    });
    try {
      await openBasic();
      // every batch fired (setTimeout 0) while recompute() was still awaiting loadViewed
      expect(Object.keys(useStore.getState().stats).length).toBe(12);
      expect(selectTotals(useStore.getState()).additions).toBeGreaterThan(3000);
    } finally {
      configurePersistence({});
    }
  });

  it("remembered branches are applied when they still exist", async () => {
    await openBasic({ id: "r1", lastTarget: "refs/remotes/origin/main", lastSource: "nope" });
    const s = useStore.getState().diffSource;
    expect(branches(s)?.targetRef).toBe("refs/remotes/origin/main");
    expect(branches(s)?.target).toBe("origin/main");
    expect(branches(s)?.sourceRef).toBe("refs/heads/feature");
  });

  it("swap flips both sides and turns the worktree layer off when source is no longer HEAD", async () => {
    await openBasic();
    useStore.getState().swapBranches();
    const s = useStore.getState().diffSource;
    expect(branches(s)?.source).toBe("main");
    expect(branches(s)?.target).toBe("feature");
    expect(s?.includeWorktree).toBe(false);
    expect(selectCanIncludeWorktree(useStore.getState())).toBe(false);
    useStore.getState().setIncludeWorktree(true); // guarded: stays off
    expect(useStore.getState().diffSource?.includeWorktree).toBe(false);
    useStore.getState().swapBranches();
    expect(selectCanIncludeWorktree(useStore.getState())).toBe(true);
    useStore.getState().setIncludeWorktree(true);
    expect(useStore.getState().diffSource?.includeWorktree).toBe(true);
    await vi.waitFor(() => expect(useStore.getState().diff?.generation).toBe(4));
  });

  it("setSource to a non-HEAD branch flips includeWorktree to false; swap disabled when equal", async () => {
    await openBasic();
    useStore.getState().setSource("topic");
    expect(useStore.getState().diffSource).toMatchObject({
      source: "topic",
      sourceRef: "refs/heads/topic",
      includeWorktree: false,
    });
    useStore.getState().setTarget("topic");
    const before = useStore.getState().diffSource;
    useStore.getState().swapBranches();
    expect(useStore.getState().diffSource).toBe(before);
  });

  it("filter: substring and glob", async () => {
    await openBasic();
    useStore.getState().setFilter("src/");
    expect(selectVisibleFiles(useStore.getState()).map((f) => f.id)).toEqual([
      "src/a.txt",
      "src/b.txt",
      "src/big-change.txt",
      "src/link",
      "src/new.txt",
    ]);
    useStore.getState().setFilter("**/*.png");
    expect(selectVisibleFiles(useStore.getState()).map((f) => f.id)).toEqual(["assets/logo.png"]);
  });

  it("viewed: toggling collapses the card, keys invalidate when the oid changes, untracked keys differ", async () => {
    await openBasic();
    const s = useStore.getState();
    const file = s.diff?.files.find((f) => f.id === "src/a.txt");
    if (!file || !s.diff) throw new Error("file missing");
    s.toggleViewed("src/a.txt");
    expect(isViewed(useStore.getState(), file)).toBe(true);
    expect(useStore.getState().collapsed.has("src/a.txt")).toBe(true);
    expect(selectViewedCount(useStore.getState())).toBe(1);
    const changed = { ...file, newOid: "ffff000000000000000000000000000000000fff" };
    expect(isViewed(useStore.getState(), changed)).toBe(false);
    const u1 = { ...file, id: "u1", newOid: null, newSize: 3 };
    const u2 = { ...file, id: "u2", newOid: null, newSize: 3 };
    expect(viewedKey("r", s.diff.source, u1)).not.toBe(viewedKey("r", s.diff.source, u2));
    s.toggleViewed("src/a.txt");
    expect(useStore.getState().collapsed.has("src/a.txt")).toBe(false);
  });

  it("setViewed marks a batch in one update, persists every key and collapses every card", async () => {
    const saved: [string, boolean][] = [];
    configurePersistence({
      loadViewed: async () => new Set(),
      saveViewed: async (key, viewed) => {
        saved.push([key, viewed]);
      },
    });
    try {
      await openBasic();
      const s = useStore.getState();
      if (!s.diff) throw new Error("diff missing");
      const ids = ["src/a.txt", "src/b.txt", "nope.txt"];
      s.setViewed(ids, true);
      const after = useStore.getState();
      expect(selectViewedCount(after)).toBe(2);
      expect(after.collapsed.has("src/a.txt")).toBe(true);
      expect(after.collapsed.has("src/b.txt")).toBe(true);
      expect(after.collapsed.has("nope.txt")).toBe(false);
      // one saveViewed per *known* file
      expect(saved.map(([, v]) => v)).toEqual([true, true]);
      const keys = s.diff.files
        .filter((f) => f.id === "src/a.txt" || f.id === "src/b.txt")
        .map((f) => viewedKey(after.repoId ?? "", s.diff?.source as never, f));
      expect(saved.map(([k]) => k).sort()).toEqual([...keys].sort());

      saved.length = 0;
      useStore.getState().setViewed(["src/a.txt", "src/b.txt"], false);
      expect(selectViewedCount(useStore.getState())).toBe(0);
      expect(useStore.getState().collapsed.has("src/a.txt")).toBe(false);
      expect(saved.map(([, v]) => v)).toEqual([false, false]);

      // nothing known in the batch: no write at all
      saved.length = 0;
      const before = useStore.getState().viewed;
      useStore.getState().setViewed(["nope.txt"], true);
      expect(saved).toEqual([]);
      expect(useStore.getState().viewed).toBe(before);
    } finally {
      configurePersistence({});
    }
  });

  it("selectHasLayers and selectGroupTotals describe the unfiltered diff", async () => {
    await openBasic();
    expect(selectHasLayers(useStore.getState())).toBe(false);
    expect(selectGroupTotals(useStore.getState())).toEqual({
      conflict: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      committed: 12,
    });

    await useStore.getState().openRepo({ name: "showcase-worktree" });
    const s = useStore.getState();
    expect(selectHasLayers(s)).toBe(true);
    expect(selectGroupTotals(s)).toEqual({
      conflict: 1,
      staged: 4,
      unstaged: 3,
      untracked: 2,
      committed: 1,
    });
    // memoised on diff.files, and unaffected by the filter
    const totals = selectGroupTotals(useStore.getState());
    useStore.getState().setFilter("staged");
    expect(selectGroupTotals(useStore.getState())).toBe(totals);
    expect(selectVisibleFiles(useStore.getState()).length).toBeLessThan(11);
  });

  it("detached repo defaults to the synthetic HEAD source", async () => {
    const detached: RepoInfo = {
      ...(basicInfo as RepoInfo),
      headBranch: null,
      detached: true,
      headDisplay: "HEAD (detached @ d77b2f4)",
      refs: [
        {
          name: "HEAD (detached @ d77b2f4)",
          fullName: "HEAD",
          kind: "local",
          oid: "d77b2f48c7fb90cbf3c4bd5c9ee1f159a73c7c07",
          isDefault: false,
          isCheckedOut: true,
          synthetic: true,
        },
        ...(basicInfo as RepoInfo).refs.map((r) => ({ ...r, isCheckedOut: false })),
      ],
    };
    const original = mock.open.bind(mock);
    mock.open = async (h, sink) => {
      await original(h, sink);
      return detached;
    };
    await openBasic();
    expect(useStore.getState().diffSource).toMatchObject({
      source: "HEAD",
      sourceRef: "HEAD",
      target: "main",
    });
    expect(selectCanIncludeWorktree(useStore.getState())).toBe(true);
  });

  it("loadFileDiff caches per whitespace variant and drops stale responses", async () => {
    await openBasic();
    await useStore.getState().loadFileDiff("docs/guide.md");
    const entry = useStore.getState().fileDiffs.get("docs/guide.md|x");
    expect(entry?.status).toBe("ready");
    useStore.getState().setPref("ignoreWhitespace", true);
    expect(useStore.getState().fileDiffs.get("docs/guide.md|w")).toBeUndefined();
    await useStore.getState().loadFileDiff("docs/guide.md");
    expect(useStore.getState().fileDiffs.get("docs/guide.md|w")?.status).toBe("ready");
    // recompute invalidates the cache
    await useStore.getState().recompute("manual");
    expect(useStore.getState().fileDiffs.size).toBe(0);
  });

  it("drops STALE file diffs silently: no toast, no error, no stuck loading entry", async () => {
    await openBasic();
    const original = mock.fileDiff.bind(mock);
    let calls = 0;
    mock.fileDiff = async (gen, id, o) => {
      if (calls++ === 0) throw { name: "EngineError", code: "STALE", message: "old generation" };
      return original(gen, id, o);
    };
    await useStore.getState().loadFileDiff("docs/guide.md");
    expect(useStore.getState().fileDiffs.get("docs/guide.md|x")).toBeUndefined();
    expect(useStore.getState().toasts).toEqual([]);
    expect(useStore.getState().screen).toBe("repo");
    await useStore.getState().loadFileDiff("docs/guide.md");
    expect(useStore.getState().fileDiffs.get("docs/guide.md|x")?.status).toBe("ready");
  });

  it("LRU evicts the oldest entry beyond max", () => {
    const lru = new Lru<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    lru.get("a");
    lru.set("d", 4);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("a")).toBe(true);
    expect(lru.size).toBe(3);
  });

  it("open error → error screen with public code; closeRepo returns home", async () => {
    mock.open = async () => {
      throw { code: "NOT_A_REPO", message: "no .git" };
    };
    await openBasic();
    expect(useStore.getState().screen).toBe("error");
    expect(useStore.getState().error?.code).toBe("NOT_A_REPO");
    await useStore.getState().closeRepo();
    expect(useStore.getState().screen).toBe("home");
  });

  it("phase-attachable open errors stay on the loading screen (L4)", async () => {
    mock.open = async () => {
      throw { code: "INDEX_UNSUPPORTED", message: "index v5" };
    };
    await openBasic();
    const s = useStore.getState();
    expect(s.screen).toBe("loading");
    expect(s.loading.failed?.code).toBe("INDEX_UNSUPPORTED");
    expect(s.loading.failedStep).toBe("refs");
    expect(s.error?.code).toBe("INDEX_UNSUPPORTED");
    await s.closeRepo();
    expect(useStore.getState().screen).toBe("home");
    expect(useStore.getState().loading.failed).toBeNull();
  });

  it("a crash during open retries up to three times, bumping the attempt (L5)", async () => {
    const original = mock.open.bind(mock);
    let calls = 0;
    mock.open = async (h, sink) => {
      calls++;
      if (calls < 3) throw { code: "WORKER_CRASHED", message: "boom" };
      return original(h, sink);
    };
    await openBasic();
    expect(calls).toBe(3);
    expect(useStore.getState().screen).toBe("repo");
    expect(useStore.getState().loading.attempt).toBe(3);

    calls = 0;
    mock.open = async () => {
      calls++;
      throw { code: "WORKER_CRASHED", message: "boom" };
    };
    await openBasic();
    expect(calls).toBe(3);
    expect(useStore.getState().screen).toBe("error");
    expect(useStore.getState().error?.code).toBe("WORKER_CRASHED");
  });

  it("a successful open records the pair and the wall time; a missing remembered branch toasts", async () => {
    const touched: unknown[] = [];
    configurePersistence({
      touchRepo: async (id, patch) => {
        touched.push({ id, patch });
      },
    });
    try {
      await openBasic({ id: "r1", lastSource: "refs/heads/nope" });
      const s = useStore.getState();
      expect(s.screen).toBe("repo");
      const last = touched.at(-1) as { id: string; patch: Record<string, unknown> };
      expect(last.id).toBe("r1");
      expect(last.patch.lastSource).toBe(branches(s.diffSource)?.sourceRef);
      expect(last.patch.lastTarget).toBe(branches(s.diffSource)?.targetRef);
      expect(typeof last.patch.lastOpenMs).toBe("number");
      expect(s.toasts.some((t) => t.message.includes("nope no longer exists"))).toBe(true);
    } finally {
      configurePersistence({});
    }
  });

  it("restart from the client triggers a recompute and a toast", async () => {
    await openBasic();
    const gen = useStore.getState().diff?.generation;
    mock.simulateRestart();
    await vi.waitFor(() => expect(useStore.getState().diff?.generation).toBe((gen ?? 0) + 1));
    expect(useStore.getState().toasts.some((t) => t.message.includes("Engine restarted"))).toBe(
      true,
    );
  });
});

describe("store: compare anything (T11.2)", () => {
  const openTags = () => useStore.getState().openRepo({ name: "tags" }, { id: "tags" });
  const src = () => useStore.getState().diffSource;
  const range = (s: DiffSource | null | undefined): RangeSource | null =>
    s && s.kind === "range" ? s : null;

  it("loadPickerSources lists tags and stashes once per open; tags on a blob or a tree are not offered", async () => {
    await openTags();
    expect(useStore.getState().tags).toBeNull();
    await Promise.all([
      useStore.getState().loadPickerSources(),
      useStore.getState().loadPickerSources(),
    ]);
    // The recording has `blob-tag` and `tree-tag` (T10.5b); neither can be a side of a diff.
    expect(useStore.getState().tags?.map((t) => t.name)).toEqual([
      "v0.1.0",
      "v0.2.0",
      "v1.0.0",
      "v1.1.0",
    ]);
    expect(useStore.getState().stashes).toEqual([]);
    await useStore.getState().closeRepo();
    expect(useStore.getState().tags).toBeNull();
  });

  it("a tag on one side turns the branch pair into a RangeSource and back", async () => {
    await openTags();
    const tag = await useStore.getState().resolveRevision("v0.1.0");
    useStore.getState().setRevision(tag, "target");
    expect(range(src())).toMatchObject({
      kind: "range",
      from: "v0.1.0",
      fromRef: "refs/tags/v0.1.0",
      fromOid: tag.oid,
      to: "main",
      toRef: "refs/heads/main",
      threeDot: true,
    });
    expect(selectSourceLabel(useStore.getState())).toBe("v0.1.0 … main");
    // …and a branch back on that side restores the v1 shape, so `lastTarget` is storable again
    useStore.getState().setTarget("release");
    expect(src()?.kind).toBe("branches");
    expect(selectSourceLabel(useStore.getState())).toBe("release … main");
  });

  it("the two-dot toggle rewrites the source and the StatsRow label; swap works on a range", async () => {
    await openTags();
    expect(src()?.kind).toBe("branches");
    useStore.getState().setTwoDot(true);
    expect(useStore.getState().prefs.twoDot).toBe(true);
    expect(range(src())).toMatchObject({
      from: "main",
      fromRef: "refs/heads/main",
      to: "main",
      toRef: "refs/heads/main",
      threeDot: false,
    });
    const tag = await useStore.getState().resolveRevision("v1.0.0");
    useStore.getState().setRevision(tag, "target");
    expect(selectSourceLabel(useStore.getState())).toBe("v1.0.0 .. main");
    useStore.getState().swapBranches();
    expect(range(src())).toMatchObject({ from: "main", to: "v1.0.0", toRef: "refs/tags/v1.0.0" });
    expect(selectSourceLabel(useStore.getState())).toBe("main .. v1.0.0");
    // back to three-dot: both sides are plain refs again only when neither is a tag
    useStore.getState().setTwoDot(false);
    expect(range(src())?.threeDot).toBe(true);
    expect(selectSourceLabel(useStore.getState())).toBe("main … v1.0.0");
  });

  it("a range off HEAD cannot include the working tree (D6)", async () => {
    await openTags();
    const tag = await useStore.getState().resolveRevision("v1.0.0");
    useStore.getState().setRevision(tag, "source");
    expect(src()?.includeWorktree).toBe(false);
    expect(selectCanIncludeWorktree(useStore.getState())).toBe(false);
    // HEAD back on the compare side and it is allowed again
    useStore.getState().setSource("main");
    useStore.getState().setIncludeWorktree(true);
    expect(selectCanIncludeWorktree(useStore.getState())).toBe(true);
    expect(src()?.includeWorktree).toBe(true);
  });

  it("the Special rows compare HEAD with the working tree; `staged` also sets the filter", async () => {
    await openTags();
    useStore.getState().setSpecialSource("staged");
    expect(src()).toMatchObject({ sourceRef: "HEAD", targetRef: "HEAD", includeWorktree: true });
    expect(useStore.getState().filter).toBe("layer:staged");
    useStore.getState().setSpecialSource("worktree");
    expect(useStore.getState().filter).toBe("");
  });

  it("applyCompare resolves a hash spec; an unresolvable one toasts and keeps the source", async () => {
    await openTags();
    await useStore.getState().applyCompare({ from: "v0.1.0", to: "v1.0.0", threeDot: true });
    expect(range(src())).toMatchObject({
      from: "v0.1.0",
      to: "v1.0.0",
      fromOid: "1e919f3681161418fef2e272272c9cb707fa65f6",
      toOid: "8d071c323aa2f4d0c74a425f4105ef2d9d1b57c8",
      threeDot: true,
    });
    const before = src();
    await useStore.getState().applyCompare({ from: "nope", to: "v1.0.0", threeDot: true });
    expect(src()).toBe(before);
    const toast = useStore.getState().toasts.at(-1);
    expect(toast?.level).toBe("warning");
    expect(toast?.message).toContain("Cannot compare nope … v1.0.0");
    expect(toast?.message).toContain("Showing v0.1.0 … v1.0.0 instead.");
  });

  it("a stash is a first-class compare side (stash fixture)", async () => {
    await useStore.getState().openRepo({ name: "stash" }, { id: "stash" });
    await useStore.getState().loadPickerSources();
    const stashes = useStore.getState().stashes ?? [];
    expect(stashes.map((s) => s.expr)).toEqual(["stash@{0}", "stash@{1}"]);
    const head = await useStore.getState().resolveRevision("HEAD");
    const stash = await useStore.getState().resolveRevision("stash@{0}");
    useStore.getState().setRevision(head, "target");
    useStore.getState().setRevision(stash, "source");
    useStore.getState().setTwoDot(true);
    expect(range(src())).toMatchObject({
      from: "HEAD",
      to: "stash@{0}",
      toRef: "stash@{0}",
      toOid: stashes[0]?.oid,
      threeDot: false,
    });
    // the recorded range replays, so the viewed key follows the expressions, not the branch names
    await vi.waitFor(() => expect(useStore.getState().diff?.source.kind).toBe("range"));
    const file = useStore.getState().diff?.files[0];
    if (file) expect(viewedKey("stash", src() as DiffSource, file)).toContain("|stash@{0}|HEAD|");
  });
});

describe("store: operation, conflicts and reflog (T11.3)", () => {
  it("openRepo mirrors RepoInfo.operation, and closeRepo clears every T11.3 field", async () => {
    await useStore.getState().openRepo({ name: "rebase-conflict" }, { id: "rc" });
    const op = useStore.getState().operation;
    expect(op?.kind).toBe("rebase");
    expect(op).toEqual(useStore.getState().repo?.operation);
    await useStore.getState().closeRepo();
    expect(useStore.getState().operation).toBeNull();
    expect(useStore.getState().reflog).toBeNull();
    expect(useStore.getState().conflicts).toEqual({});
  });

  it("pre-loads the payload of every conflicted file so the sidebar can print git's XY", async () => {
    await useStore.getState().openRepo({ name: "rebase-conflict" }, { id: "rc" });
    await vi.waitFor(() => {
      const c = useStore.getState().conflicts;
      expect(Object.keys(c).sort()).toEqual(["both-added.txt", "file.txt"]);
      expect(selectConflictKinds(useStore.getState())).toEqual({
        "both-added.txt": "both-added",
        "file.txt": "both-modified",
      });
    });
    expect(selectConflictKind(useStore.getState(), "file.txt")).toBe("both-modified");
    // one three-way payload per conflicted file, with the markers the recording holds
    const entry = useStore.getState().conflicts["file.txt"];
    expect(entry?.status).toBe("ready");
    if (entry?.status === "ready") {
      expect(entry.data.worktree?.markers).toEqual([{ start: 3, end: 7, oursEnd: 5 }]);
      expect(entry.data.labels).toEqual({ ours: "main", theirs: "d424326" });
    }
  });

  it("loadReflog reads HEAD's log once; T10.5 fills `reachable` on every row", async () => {
    await useStore.getState().openRepo({ name: "reflog-orphan" }, { id: "orphan" });
    await useStore.getState().loadReflog();
    const log = useStore.getState().reflog ?? [];
    expect(log[0]?.expr).toBe("HEAD@{0}");
    expect(log[0]?.action).toBe("commit");
    // `reflog()` fills reachability itself (T10.5), so no row is left unknown.
    expect(log.every((e) => typeof e.reachable === "boolean")).toBe(true);
    // the reset orphaned c3 and c4; everything still on `main` stays reachable
    expect(log.filter((e) => e.reachable === false).map((e) => e.expr)).toEqual([
      "HEAD@{2}",
      "HEAD@{3}",
    ]);
  });

  it("loadReflog fills `reachable` in batches when the recording left it unknown", async () => {
    const calls: string[][] = [];
    setStoreClient({
      ...mock,
      // A reader that has not computed reachability leaves the field null (`ReflogEntry.reachable`).
      reflog: async (expr: string, limit: number) =>
        (await mock.reflog(expr, limit)).map((e) => ({ ...e, reachable: null })),
      markReachable: async (oids: string[]) => {
        calls.push(oids);
        return Object.fromEntries(oids.map((o, i) => [o, i > 0]));
      },
    } as unknown as MockWorkerClient);
    await useStore.getState().openRepo({ name: "rebase-conflict" }, { id: "rc" });
    await useStore.getState().loadReflog();
    expect(calls).toHaveLength(1); // 10 recorded entries, one batch of 50
    const log = useStore.getState().reflog ?? [];
    expect(log[0]?.reachable).toBe(false);
    expect(log[1]?.reachable).toBe(true);
  });

  it("a repository with no reflog answers an empty list instead of throwing", async () => {
    await openBasic();
    await useStore.getState().loadReflog();
    expect(useStore.getState().reflog).toEqual([]);
  });
});

describe("store: hidden paths and the built-in excludes (T11.4)", () => {
  const openHidden = () => useStore.getState().openRepo({ name: "hidden" }, { id: "hidden" });

  it("lists hidden paths lazily: only once the toggle turns on, and drops them when it goes off", async () => {
    await openHidden();
    expect(useStore.getState().hidden).toBeNull();
    useStore.getState().setPref("showHidden", true);
    await vi.waitFor(() => expect(useStore.getState().hidden).toHaveLength(7));
    expect(useStore.getState().hidden?.map((e) => e.kind)).toContain("ignored-dir");
    useStore.getState().setPref("showHidden", false);
    expect(useStore.getState().hidden).toBeNull();
  });

  it("refreshes the listing on every recompute while the toggle is on, and not otherwise", async () => {
    await openHidden();
    let calls = 0;
    setStoreClient({
      ...mock,
      listHidden: async () => {
        calls++;
        return [];
      },
    } as unknown as MockWorkerClient);
    await useStore.getState().recompute("manual");
    expect(calls).toBe(0);
    useStore.setState((s) => ({ prefs: { ...s.prefs, showHidden: true } }));
    await useStore.getState().recompute("poll:worktree");
    await vi.waitFor(() => expect(calls).toBe(1));
  });

  it("selectHiddenEntries applies the path part of the filter and nothing else", async () => {
    await openHidden();
    useStore.getState().setPref("showHidden", true);
    await vi.waitFor(() => expect(useStore.getState().hidden).toHaveLength(7));
    expect(selectHiddenEntries(useStore.getState())).toHaveLength(7);
    useStore.getState().setFilter("src/");
    expect(selectHiddenEntries(useStore.getState())?.map((e) => e.path)).toEqual([
      "src/assumed.txt",
      "src/skipped.txt",
    ]);
    // `layer:` has no meaning for a hidden path, so it leaves the group alone
    useStore.getState().setFilter("layer:staged");
    expect(selectHiddenEntries(useStore.getState())).toHaveLength(7);
    useStore.setState((s) => ({ prefs: { ...s.prefs, showHidden: false } }));
    expect(selectHiddenEntries(useStore.getState())).toBeNull();
  });

  it("explainPath reaches the engine and closeRepo clears the listing", async () => {
    await openHidden();
    const explained = await useStore.getState().explainPath("src/skipped.txt");
    expect(explained.shown).toBe(false);
    expect(explained.reasons[0]?.kind).toBe("skip-worktree");
    useStore.setState({ hidden: [] });
    await useStore.getState().closeRepo();
    expect(useStore.getState().hidden).toBeNull();
  });

  it("open() carries the builtinExcludes preference, and changing it re-opens the session (B10)", async () => {
    await openHidden();
    expect(mock.lastOpenOptions).toEqual({ builtinExcludes: true });
    useStore.getState().setPref("builtinExcludes", false);
    await vi.waitFor(() => expect(mock.lastOpenOptions).toEqual({ builtinExcludes: false }));
    const after = useStore.getState();
    // the folder is open again on the same compare pair, not thrown back to Home
    expect(after.screen).toBe("repo");
    expect(after.repoId).toBe("hidden");
    expect(after.diff?.files).toHaveLength(2);
    // an unchanged value never rebuilds the session
    mock.lastOpenOptions = undefined;
    useStore.getState().setPref("builtinExcludes", false);
    await Promise.resolve();
    expect(mock.lastOpenOptions).toBeUndefined();
  });
});

describe("store: History mode (T11.5)", () => {
  const openHistory = () => useStore.getState().openRepo({ name: "history" }, { id: "hist" });
  const headOid = "822313f6746d7982943f0d59fc5e09b626769141";
  const headParent = "82bc6c6d1bc309b9e6463af370ec95aa4866a78c";
  /** `main~5`, the merge base the recorded `main~5…main` range was captured against. */
  const fiveBack = "10f27d53c19de4ea66ac966ec37d30d9871abc64";

  function range(src: DiffSource | null | undefined): RangeSource | null {
    return src && src.kind === "range" ? src : null;
  }

  it("walks the first page and pages the rest with the cursor", async () => {
    await openHistory();
    await useStore.getState().loadHistory();
    let h = useStore.getState().history;
    expect(h.commits).toHaveLength(50); // HISTORY_PAGE
    expect(h.cursor).toBe("50");
    expect(h.commits[0]?.oid).toBe(headOid);
    await useStore.getState().loadHistory();
    h = useStore.getState().history;
    expect(h.commits).toHaveLength(60); // the whole recorded walk
    expect(h.cursor).toBeNull();
    // exhausted: asking again is a no-op rather than a second walk
    await useStore.getState().loadHistory();
    expect(useStore.getState().history.commits).toHaveLength(60);
  });

  it("re-walks from the tip when `first-parent` or `all branches` is toggled", async () => {
    await openHistory();
    await useStore.getState().loadHistory();
    expect(useStore.getState().history.commits).toHaveLength(50);
    useStore.getState().setHistoryOption("firstParent", true);
    await vi.waitFor(() => {
      const h = useStore.getState().history;
      expect(h.loading).toBe(false);
      expect(h.commits).toHaveLength(48); // the whole --first-parent walk fits in one page
    });
    expect(useStore.getState().history.cursor).toBeNull();
    useStore.getState().setHistoryOption("all", true);
    await vi.waitFor(() => expect(useStore.getState().history.cursor).toBe("50"));
    // `--all` seeds from every ref, so it starts on another branch's tip and is wider
    const all = useStore.getState().history.commits;
    expect(all[0]?.refs).toEqual(["preflight/a"]);
    expect(Math.max(...all.map((c) => c.laneCount ?? 1))).toBe(3);
  });

  it("a STALE cursor throws the list away and walks again from the tip (T10.5b)", async () => {
    let staled = false;
    setStoreClient({
      ...mock,
      walkCommits: async (req: { cursor?: string }) => {
        if (req.cursor !== undefined && !staled) {
          staled = true;
          throw { code: "STALE", message: "the refs moved" };
        }
        return mock.walkCommits(req as never);
      },
    } as unknown as MockWorkerClient);
    await openHistory();
    await useStore.getState().loadHistory();
    await useStore.getState().loadHistory(); // this one goes STALE and restarts at page 1
    expect(staled).toBe(true);
    const h = useStore.getState().history;
    expect(h.commits).toHaveLength(50);
    expect(h.commits.map((c) => c.oid)).toHaveLength(new Set(h.commits.map((c) => c.oid)).size);
  });

  it("filters the walked commits client-side", async () => {
    await openHistory();
    await useStore.getState().loadHistory();
    useStore.getState().setHistoryQuery("bump manifest");
    const rows = selectHistoryRows(useStore.getState());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.subject.includes("bump manifest"))).toBe(true);
    useStore.getState().setHistoryQuery(headOid.slice(0, 7));
    expect(selectHistoryRows(useStore.getState()).map((c) => c.oid)).toEqual([headOid]);
  });

  it("picking a commit makes the source parent…commit and loads its details", async () => {
    await openHistory();
    await useStore.getState().loadHistory();
    await useStore.getState().showCommit(headOid);
    const src = range(useStore.getState().diffSource);
    expect(src?.commit).toBe(headOid);
    expect(src?.fromOid).toBe(headParent);
    expect(src?.toOid).toBe(headOid);
    expect(src?.threeDot).toBe(false);
    expect(selectSourceLabel(useStore.getState())).toBe("82bc6c6 .. 822313f");
    await vi.waitFor(() => {
      const entry = useStore.getState().commitDetails[headOid];
      expect(entry?.status).toBe("ready");
    });
    expect(useStore.getState().history.selected).toBe(headOid);
  });

  it("shift-picking a second commit makes the range older…newer", async () => {
    await openHistory();
    await useStore.getState().loadHistory();
    await useStore.getState().showCommit(headOid);
    await useStore.getState().showCommit(fiveBack, { extend: true });
    const src = range(useStore.getState().diffSource);
    expect([src?.fromOid, src?.toOid]).toEqual([fiveBack, headOid]);
    expect(src?.commit).toBeUndefined();
    expect(useStore.getState().history.rangeStart).toBe(fiveBack);
    expect(useStore.getState().history.selected).toBe(headOid);
  });

  it("`Compare with base…` keeps the base picker's branch, not the parent of the last pick", async () => {
    await openHistory();
    await useStore.getState().loadHistory();
    await useStore.getState().showCommit(headOid);
    useStore.getState().compareCommitWithBase(fiveBack);
    const src = range(useStore.getState().diffSource);
    expect(src?.fromRef).toBe("refs/heads/main");
    expect(src?.toOid).toBe(fiveBack);
    expect(src?.threeDot).toBe(true); // the three-dot default of the picker footer
  });

  it("batches commitStats for the rows it is asked about, one call at a time", async () => {
    const batches: string[][] = [];
    setStoreClient({
      ...mock,
      commitStats: async (oids: string[]) => {
        batches.push(oids);
        return mock.commitStats(oids);
      },
    } as unknown as MockWorkerClient);
    await openHistory();
    await useStore.getState().loadHistory(); // the page asks for its own rows
    await vi.waitFor(() => expect(useStore.getState().commitStats[headOid]).toBeTruthy());
    expect(batches[0]).toHaveLength(50);
    const before = batches.length;
    // already known: nothing is asked twice
    useStore.getState().requestCommitStats([headOid, headParent]);
    await Promise.resolve();
    expect(batches).toHaveLength(before);
    expect(useStore.getState().commitStats[headOid]).toEqual({
      files: 1,
      additions: 5,
      deletions: 0,
    });
  });

  it("searchCommits answers null until T10.8 ships `search`, and maps its hits when it does", async () => {
    await openHistory();
    expect(await useStore.getState().searchCommits("anything")).toBeNull();
    setStoreClient({
      ...mock,
      search: async () => ({ hits: [{ kind: "commit", oid: headOid }, { kind: "file" }] }),
    } as unknown as MockWorkerClient);
    expect(await useStore.getState().searchCommits("anything")).toEqual([headOid]);
  });

  it("the stack walks back to the merge base, newest first", async () => {
    await openHistory();
    // the recorded default pair is main…main, so nothing is stacked on the base
    await useStore.getState().loadStack();
    expect(useStore.getState().stack.commits).toHaveLength(0);
    expect(useStore.getState().stack.ready).toBe(true);
    // move the base five commits back, the range `bun run record` captured
    const diff = useStore.getState().diff as DiffResult;
    useStore.setState({ diff: { ...diff, mergeBase: fiveBack }, stack: INITIAL_STACK });
    await useStore.getState().loadStack();
    const stack = useStore.getState().stack;
    expect(stack.base).toBe(fiveBack);
    expect(stack.commits.map((c) => c.oid)).toEqual([
      headOid,
      headParent,
      "fb9edcd9be63538ff6d425970ceaaaf27e1009ee",
      "8295928b1c222c2877dbcf442573effe40d97e5a",
      "87a3a12b31ee4268cf84cfed8254425a12658c7a",
    ]);
    expect(stack.capped).toBe(false);
  });

  it("closeRepo drops the walk, the details and the stack", async () => {
    await openHistory();
    await useStore.getState().loadHistory();
    await useStore.getState().showCommit(headOid);
    await useStore.getState().closeRepo();
    const s = useStore.getState();
    expect(s.history).toEqual(INITIAL_HISTORY);
    expect(s.commitDetails).toEqual({});
    expect(s.commitStats).toEqual({});
    expect(s.stack).toEqual(INITIAL_STACK);
    expect(s.compareBase).toBeNull();
  });
});

describe("store: blame and file history (T11.6)", () => {
  const openHistoryRepo = () => useStore.getState().openRepo({ name: "history" }, { id: "hist" });
  const HOT = "src/hot.txt";
  const RENAMED = "src/renamed-to.txt";
  const MAIN = (historyInfo as unknown as RepoInfo).refs.find(
    (r) => r.fullName === "refs/heads/main",
  )?.oid as string;

  it("blames the compare side, keyed by commit, path and `-w`", async () => {
    await openHistoryRepo();
    const spy = vi.spyOn(mock, "blame");
    await useStore.getState().loadBlame(HOT, { at: null, ignoreWhitespace: true });
    const key = blameCacheKey(MAIN, HOT, true);
    const entry = useStore.getState().blames[key];
    expect(entry?.status).toBe("ready");
    expect(entry?.status === "ready" && entry.data.lines).toHaveLength(60);
    expect(spy).toHaveBeenCalledWith(
      "refs/heads/main",
      HOT,
      // the `history` fixture compares main with the working tree on top of it
      { ignoreWhitespace: true, includeWorktree: true, maxRevisions: 200 },
    );
    // a second ask for the same key is answered from the store, not the worker
    await useStore.getState().loadBlame(HOT, { at: null, ignoreWhitespace: true });
    expect(spy).toHaveBeenCalledTimes(1);
    // `-w` off is a different key and a second call
    await useStore.getState().loadBlame(HOT, { at: null, ignoreWhitespace: false });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useStore.getState().blames[blameCacheKey(MAIN, HOT, false)]?.status).toBe("ready");
  });

  it("a derived-cache hit skips the worker call", async () => {
    await openHistoryRepo();
    // the working tree is not part of an immutable answer, so the cache only applies without it
    useStore.getState().setIncludeWorktree(false);
    await vi.waitFor(() => expect(useStore.getState().diff?.source.includeWorktree).toBe(false));
    const cached = { lines: [], commits: {}, path: HOT, ref: "x", revisions: 7, capped: false };
    await setDerived(derivedKey.blame("hist", MAIN, HOT, true), {
      data: cached,
      maxRevisions: 200,
    });
    const spy = vi.spyOn(mock, "blame");
    await useStore.getState().loadBlame(HOT, { at: null, ignoreWhitespace: true });
    expect(spy).not.toHaveBeenCalled();
    const entry = useStore.getState().blames[blameCacheKey(MAIN, HOT, true)];
    expect(entry?.status === "ready" && entry.data.revisions).toBe(7);
  });

  it("`Continue` re-asks with a higher cap; a cached answer below the cap does not count", async () => {
    await openHistoryRepo();
    const spy = vi.spyOn(mock, "blame");
    await useStore.getState().loadBlame(HOT, { at: null, ignoreWhitespace: true });
    await useStore
      .getState()
      .loadBlame(HOT, { at: null, ignoreWhitespace: true, maxRevisions: 600 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[2]).toMatchObject({ maxRevisions: 600 });
  });

  it("blames an explicit commit without the working tree", async () => {
    await openHistoryRepo();
    const spy = vi.spyOn(mock, "blame");
    const oid = "a73418042de715a7bef7e9bc59a8a2fadd8eb920";
    await useStore.getState().loadBlame(HOT, { at: oid, ignoreWhitespace: false });
    expect(spy).toHaveBeenCalledWith(oid, HOT, {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 200,
    });
    expect(useStore.getState().blames[blameCacheKey(oid, HOT, false)]?.status).toBe("ready");
  });

  it("pages the file history, follows renames and stops when the cursor runs out", async () => {
    await openHistoryRepo();
    await useStore.getState().loadPathHistory(RENAMED, { at: null, follow: true });
    const key = pathHistoryCacheKey(MAIN, RENAMED, true);
    let state = useStore.getState().pathHistories[key];
    expect(state?.entries).toHaveLength(4);
    expect(state?.cursor).toBeNull();
    expect(state?.entries.some((e) => e.renamedFrom !== null)).toBe(true);
    // `Load more` on an exhausted list is a no-op
    const spy = vi.spyOn(mock, "pathHistory");
    await useStore.getState().loadPathHistory(RENAMED, { at: null, follow: true, more: true });
    expect(spy).not.toHaveBeenCalled();
    // follow off is its own key and its own (shorter) list
    await useStore.getState().loadPathHistory(RENAMED, { at: null, follow: false });
    state = useStore.getState().pathHistories[pathHistoryCacheKey(MAIN, RENAMED, false)];
    expect(state?.entries).toHaveLength(2);
  });

  it("closeRepo drops the blames and the file histories", async () => {
    await openHistoryRepo();
    await useStore.getState().loadBlame(HOT, { at: null, ignoreWhitespace: true });
    await useStore.getState().loadPathHistory(RENAMED, { at: null, follow: true });
    useStore.getState().setCardMode(HOT, "blame");
    expect(useStore.getState().cardModes[HOT]).toBe("blame");
    await useStore.getState().closeRepo();
    const s = useStore.getState();
    expect(s.blames).toEqual({});
    expect(s.pathHistories).toEqual({});
    expect(s.cardModes).toEqual({});
  });
});

describe("store: Branches mode (T11.7)", () => {
  const openHistoryRepo = () => useStore.getState().openRepo({ name: "history" }, { id: "hist" });
  const openTagsRepo = () => useStore.getState().openRepo({ name: "tags" }, { id: "tagrepo" });

  function range(src: DiffSource | null | undefined): RangeSource | null {
    return src && src.kind === "range" ? src : null;
  }

  it("reads the overview once, with the expensive cells still empty", async () => {
    await openHistoryRepo();
    const spy = vi.spyOn(mock, "branchOverview");
    await useStore.getState().loadBranches();
    const b = useStore.getState().branches;
    expect(b.rows?.map((r) => r.ref.name)).toEqual([
      "main",
      "preflight/a",
      "preflight/base",
      "topic",
    ]);
    expect(b.rows?.every((r) => r.vsUpstream === null && r.vsDefault === null)).toBe(true);
    expect(b.cells).toEqual({});
    expect(b.error).toBeNull();
    // a second call is a no-op: the overview is read once per repository
    await useStore.getState().loadBranches();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fills the cells in batches and never asks for one twice", async () => {
    await openHistoryRepo();
    await useStore.getState().loadBranches();
    const names = (useStore.getState().branches.rows ?? []).map((r) => r.ref.fullName);
    const spy = vi.spyOn(mock, "branchCells");
    useStore.getState().requestBranchCells(names);
    await vi.waitFor(() =>
      expect(Object.keys(useStore.getState().branches.cells)).toHaveLength(names.length),
    );
    expect(spy.mock.calls[0]?.[0]).toEqual(names); // 4 rows fit in one 50-row batch
    expect(useStore.getState().branches.cells["refs/heads/preflight/a"]?.vsDefault).toEqual({
      ahead: 3,
      behind: 55,
      mergeBase: "cc269cbc13f6b0b687d7e81ce26fae14f9787b3f",
      capped: false,
    });
    expect(useStore.getState().branches.cells["refs/heads/topic"]?.merged).toBe(true);
    spy.mockClear();
    useStore.getState().requestBranchCells(names);
    expect(spy).not.toHaveBeenCalled();
  });

  it("records a cell the engine did not answer for, so the row stops asking", async () => {
    await openHistoryRepo();
    useStore.getState().requestBranchCells(["refs/heads/gone"]);
    await vi.waitFor(() =>
      expect(useStore.getState().branches.cells["refs/heads/gone"]).toEqual({
        vsUpstream: null,
        vsDefault: null,
        merged: null,
      }),
    );
  });

  it("clicking a row walks that branch in History mode", async () => {
    await openHistoryRepo();
    await useStore.getState().loadHistory();
    expect(useStore.getState().history.commits[0]?.oid).toBe(
      "822313f6746d7982943f0d59fc5e09b626769141",
    );
    useStore.getState().showBranchHistory("refs/heads/topic");
    expect(useStore.getState().mode).toBe("history");
    expect(branches(useStore.getState().diffSource)?.sourceRef).toBe("refs/heads/topic");
    expect(useStore.getState().history.selected).toBeNull();
    await vi.waitFor(() => expect(useStore.getState().history.loading).toBe(false));
    // the list was thrown away and walked again from the new tip
    expect(useStore.getState().history.commits.length).toBeGreaterThan(0);
  });

  it("`Compare with base` sets the source exactly as the pickers do", async () => {
    await openHistoryRepo();
    useStore.getState().compareBranchWithBase("refs/heads/topic");
    const src = branches(useStore.getState().diffSource);
    expect(useStore.getState().mode).toBe("files");
    // two plain refs three-dot stay a v1 `BranchesSource` (compareSource's single rule)
    expect(src).toMatchObject({ targetRef: "refs/heads/main", sourceRef: "refs/heads/topic" });
    // the base is the base picker's side, so `Set as base` moves it
    useStore.getState().setTarget("refs/heads/preflight/base");
    useStore.getState().compareBranchWithBase("refs/heads/topic");
    expect(branches(useStore.getState().diffSource)?.targetRef).toBe("refs/heads/preflight/base");
    expect(selectBranchBase(useStore.getState())?.display).toBe("preflight/base");
  });

  it("defaults the base to the repository's own default branch", async () => {
    await openHistoryRepo();
    useStore.setState({ compareBase: null });
    expect(selectBranchBase(useStore.getState())).toEqual({
      fullName: "refs/heads/main",
      display: "main",
    });
  });

  it("`Compare with previous tag` builds the range prev…this", async () => {
    await openTagsRepo();
    await useStore.getState().loadPickerSources();
    const all = useStore.getState().tags ?? [];
    const v1 = all.find((t) => t.name === "v1.0.0");
    const v02 = all.find((t) => t.name === "v0.2.0");
    if (!v1 || !v02) throw new Error("recorded tags missing");
    useStore.getState().compareTags(v02, v1);
    expect(useStore.getState().mode).toBe("files");
    // a tag is not a branch, so the pair is a RangeSource (contracts `<!-- T11.2 -->`)
    expect(range(useStore.getState().diffSource)).toMatchObject({
      from: "v0.2.0",
      to: "v1.0.0",
      fromRef: "refs/tags/v0.2.0",
      toRef: "refs/tags/v1.0.0",
      threeDot: true,
    });
  });

  it("closeRepo drops the overview, its cells and the filter", async () => {
    await openHistoryRepo();
    await useStore.getState().loadBranches();
    useStore.getState().setBranchFilter("stale");
    useStore.getState().setBranchQuery("topic");
    expect(useStore.getState().branches.rows).not.toBeNull();
    await useStore.getState().closeRepo();
    expect(useStore.getState().branches).toEqual(INITIAL_BRANCHES);
  });
});
