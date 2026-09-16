import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoInfo } from "../engine/types";
import basicInfo from "../test/recorded/basic.repoinfo.json";
import { Lru } from "./lru";
import {
  configurePersistence,
  isViewed,
  selectCanIncludeWorktree,
  selectTotals,
  selectViewedCount,
  selectVisibleFiles,
  setStoreClient,
  useStore,
} from "./store";
import { viewedKey } from "./viewedKey";
import { createMockWorkerClient, type MockWorkerClient } from "./workerClient.mock";

let mock: MockWorkerClient;
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
  await useStore.getState().openRepo({ name: "basic" }, opts);
}

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
    expect(s?.targetRef).toBe("refs/remotes/origin/main");
    expect(s?.target).toBe("origin/main");
    expect(s?.sourceRef).toBe("refs/heads/feature");
  });

  it("swap flips both sides and turns the worktree layer off when source is no longer HEAD", async () => {
    await openBasic();
    useStore.getState().swapBranches();
    const s = useStore.getState().diffSource;
    expect(s?.source).toBe("main");
    expect(s?.target).toBe("feature");
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
