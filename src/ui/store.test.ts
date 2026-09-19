import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchesSource, DiffSource, RangeSource, RepoInfo } from "../engine/types";
import basicInfo from "../test/recorded/showcase.repoinfo.json";
import { Lru } from "./lru";
import {
  configurePersistence,
  isViewed,
  selectCanIncludeWorktree,
  selectConflictKind,
  selectConflictKinds,
  selectGroupTotals,
  selectHasLayers,
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
/** Narrows the store's DiffSource to the branch pair these tests always build (T10.1 union). */
function branches(src: DiffSource | null | undefined): BranchesSource | null {
  return src && src.kind === "branches" ? src : null;
}

const initial = useStore.getState();

beforeEach(() => {
  mock = createMockWorkerClient();
  setStoreClient(mock);
  useStore.setState(initial, true);
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
    });
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

  it("loadPickerSources lists tags and stashes once per open", async () => {
    await openTags();
    expect(useStore.getState().tags).toBeNull();
    await Promise.all([
      useStore.getState().loadPickerSources(),
      useStore.getState().loadPickerSources(),
    ]);
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

  it("loadReflog reads HEAD's log once; `unreachable` stays unknown until T10.5 ships markReachable", async () => {
    await useStore.getState().openRepo({ name: "rebase-conflict" }, { id: "rc" });
    expect("markReachable" in mock).toBe(false);
    await useStore.getState().loadReflog();
    const log = useStore.getState().reflog ?? [];
    expect(log[0]?.expr).toBe("HEAD@{0}");
    expect(log[0]?.action).toBe("rebase (pick)");
    expect(log.every((e) => e.reachable === null)).toBe(true);
  });

  it("loadReflog fills `reachable` in batches once the client exposes markReachable", async () => {
    const calls: string[][] = [];
    setStoreClient({
      ...mock,
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
