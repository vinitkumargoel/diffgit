import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceLabels } from "../../engine/diffSource";
import type { RepoInfo } from "../../engine/types";
import showcase from "../../test/recorded/showcase.repoinfo.json";
import type { UiError } from "../errors";
import { setStoreClient, useStore } from "../store";
import type { WorkerClient } from "../workerClient";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { CONFIG_PATH, createScheduler, type Scheduler, type SchedulerDeps } from "./scheduler";

/** Display name of the base side, whichever DiffSource kind the store holds (T10.1 union). */
function baseLabel(): string | null {
  const src = useStore.getState().diffSource;
  return src ? sourceLabels(src).target : null;
}

const initial = useStore.getState();
let mock: MockWorkerClient;
let client: WorkerClient & {
  computeDiff: ReturnType<typeof vi.fn>;
  reloadRefs: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  forceRehash: ReturnType<typeof vi.fn>;
};
let scheduler: Scheduler | null = null;

function make(deps: Partial<SchedulerDeps> = {}): Scheduler {
  scheduler = createScheduler({ client, ...deps });
  return scheduler;
}

beforeEach(() => {
  vi.useFakeTimers();
  mock = createMockWorkerClient();
  client = {
    ...mock,
    computeDiff: vi.fn((src) => mock.computeDiff(src)),
    reloadRefs: vi.fn(() => mock.reloadRefs()),
    invalidate: vi.fn(() => mock.invalidate("all")),
    forceRehash: vi.fn(() => mock.forceRehash()),
  } as typeof client;
  setStoreClient(client);
  useStore.setState(initial, true);
});
afterEach(() => {
  scheduler?.dispose();
  scheduler = null;
  setStoreClient(null);
  vi.useRealTimers();
});

async function open() {
  await useStore.getState().openRepo({ name: "showcase" });
  expect(useStore.getState().screen).toBe("repo");
  client.computeDiff.mockClear();
  client.reloadRefs.mockClear();
  client.invalidate.mockClear();
}

/** Advance fake time and let promise chains settle. */
async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("scheduler", () => {
  it("coalesces a burst: 5 observer requests → 1 compute, trailing 300 ms", async () => {
    const s = make();
    await open();
    for (let i = 0; i < 5; i++) {
      s.request("observer:worktree", [`f${i}.txt`]);
      await tick(50);
    }
    expect(client.computeDiff).toHaveBeenCalledTimes(0);
    await tick(300);
    expect(client.computeDiff).toHaveBeenCalledTimes(1);
    expect(client.invalidate).toHaveBeenCalledWith("worktree", [
      "f0.txt",
      "f1.txt",
      "f2.txt",
      "f3.txt",
      "f4.txt",
    ]);
    expect(client.reloadRefs).not.toHaveBeenCalled();
  });

  it("max-wait: a burst that never goes quiet still fires within 2 s", async () => {
    const s = make();
    await open();
    for (let i = 0; i < 15; i++) {
      s.request("poll:worktree");
      await tick(200); // 3 s of continuous requests
      if (client.computeDiff.mock.calls.length > 0) break;
    }
    expect(client.computeDiff).toHaveBeenCalledTimes(1);
    const firstCallAt = Date.now();
    expect(firstCallAt).toBeLessThanOrEqual(2200 + firstCallAt - 2000);
  });

  it("reason merging: git reasons reload refs, worktree ones do not, force rehashes", async () => {
    const s = make();
    await open();
    s.request("poll:git");
    await s.flush();
    expect(client.invalidate).toHaveBeenCalledWith("refs");
    expect(client.reloadRefs).toHaveBeenCalledTimes(1);
    expect(client.forceRehash).not.toHaveBeenCalled();
    client.invalidate.mockClear();
    client.reloadRefs.mockClear();

    s.request("observer:worktree", ["a.txt"]);
    await s.flush();
    expect(client.invalidate).toHaveBeenCalledWith("worktree", ["a.txt"]);
    expect(client.reloadRefs).not.toHaveBeenCalled();
    client.invalidate.mockClear();

    s.request("force");
    await s.flush();
    expect(client.forceRehash).toHaveBeenCalledTimes(1);
    expect(client.invalidate).toHaveBeenCalledWith("all");
    expect(client.reloadRefs).toHaveBeenCalledTimes(1);
    expect(client.computeDiff).toHaveBeenCalledTimes(3);
  });

  it("user-initiated reasons fire immediately when idle; the following burst coalesces", async () => {
    const s = make();
    await open();
    s.request("manual");
    await tick(0);
    expect(client.computeDiff).toHaveBeenCalledTimes(1);
    await s.flush();
    s.request("manual");
    s.request("manual");
    s.request("branch-change");
    await s.flush();
    expect(client.computeDiff).toHaveBeenCalledTimes(2);
  });

  it("config/ignore/attributes edits invalidate everything and reload refs", async () => {
    expect(CONFIG_PATH.test(".git/config")).toBe(true);
    expect(CONFIG_PATH.test(".git/info/exclude")).toBe(true);
    expect(CONFIG_PATH.test(".gitignore")).toBe(true);
    expect(CONFIG_PATH.test("src/.gitattributes")).toBe(true);
    expect(CONFIG_PATH.test("src/config.ts")).toBe(false);
    expect(CONFIG_PATH.test(".git/index")).toBe(false);
    const s = make();
    await open();
    s.request("observer:worktree", ["src/.gitignore"]);
    await s.flush();
    expect(client.invalidate).toHaveBeenCalledWith("all");
    expect(client.reloadRefs).toHaveBeenCalledTimes(1);
    expect(client.computeDiff).toHaveBeenCalledTimes(1);
  });

  it("checked-out branch change resets the source to the new HEAD branch and keeps the target", async () => {
    const s = make();
    await open();
    useStore.getState().setTarget("topic");
    await s.flush();
    expect(baseLabel()).toBe("topic");
    const moved: RepoInfo = {
      ...(showcase as unknown as RepoInfo),
      headBranch: "main",
      refs: (showcase as unknown as RepoInfo).refs.map((r) => ({
        ...r,
        isCheckedOut: r.name === "main",
      })),
    };
    client.reloadRefs.mockResolvedValueOnce(moved);
    s.request("observer:git");
    await s.flush();
    const src = useStore.getState().diffSource;
    expect(src).toMatchObject({
      source: "main",
      sourceRef: "refs/heads/main",
      target: "topic",
      includeWorktree: true,
    });
    expect(useStore.getState().repo?.headBranch).toBe("main");
  });

  it("a deleted target falls back to the default branch", async () => {
    const s = make();
    await open();
    useStore.getState().setTarget("topic");
    await s.flush();
    const info = showcase as unknown as RepoInfo;
    client.reloadRefs.mockResolvedValueOnce({
      ...info,
      refs: info.refs.filter((r) => r.name !== "topic"),
    });
    s.request("poll:git");
    await s.flush();
    expect(baseLabel()).toBe("main");
  });

  it("superseded computes are silent; other errors surface as one toast", async () => {
    const s = make();
    await open();
    client.computeDiff.mockRejectedValueOnce({ code: "CANCELLED", message: "superseded" });
    s.request("manual");
    await s.flush();
    expect(useStore.getState().toasts).toHaveLength(0);
    expect(useStore.getState().refresh.busy).toBe(false);
    client.computeDiff.mockRejectedValueOnce({ code: "IO_ERROR", message: "disk on fire" });
    s.request("manual");
    await s.flush();
    expect(useStore.getState().toasts.map((t) => t.message)).toEqual([
      "Refresh failed: disk on fire",
    ]);
  });

  it("ladder: live → polling on observer error (REFRESH_DEGRADED) → manual on poller permission error, one toast, re-grant climbs back", async () => {
    let observerError: ((e: UiError) => void) | null = null;
    let pollerError: ((e: UiError) => void) | null = null;
    const stopObserver = vi.fn();
    const stopPoller = vi.fn();
    const requestPermission = vi.fn(async () => true);
    const s = make({
      startObserver: (_h, _onRecords, onError) => {
        observerError = onError;
        return stopObserver;
      },
      startPoller: (_c, _onChange, onError) => {
        pollerError = onError;
        return stopPoller;
      },
      requestPermission,
    });
    await open();
    expect(s.mode).toBe("live");
    (observerError as unknown as (e: UiError) => void)({
      code: "INTERNAL",
      message: "observer died",
    });
    expect(stopObserver).toHaveBeenCalledTimes(1);
    expect(s.mode).toBe("polling");
    expect(useStore.getState().warnings.map((w) => w.code)).toContain("REFRESH_DEGRADED");

    const perm: UiError = { code: "PERMISSION", message: "denied" };
    (pollerError as unknown as (e: UiError) => void)(perm);
    (pollerError as unknown as (e: UiError) => void)(perm);
    expect(stopPoller).toHaveBeenCalledTimes(1);
    expect(s.mode).toBe("manual");
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toContain("was revoked. Live refresh paused.");
    expect(toasts[0]?.action?.label).toBe("Grant access");

    toasts[0]?.action?.onClick();
    await tick(0);
    await s.flush();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(s.mode).toBe("live");
    expect(client.computeDiff).toHaveBeenCalled();
  });

  it("observer records map to reasons; HANDLE_GONE stops everything and shows the error screen", async () => {
    let onRecords: ((git: boolean, wt: string[], config: boolean) => void) | null = null;
    const stopObserver = vi.fn();
    const s = make({
      startObserver: (_h, records) => {
        onRecords = records;
        return stopObserver;
      },
    });
    await open();
    (onRecords as unknown as (g: boolean, w: string[], c: boolean) => void)(true, ["a.txt"], false);
    await s.flush();
    expect(client.invalidate).toHaveBeenCalledWith("refs");
    expect(client.invalidate).toHaveBeenCalledWith("worktree", ["a.txt"]);
    expect(client.reloadRefs).toHaveBeenCalledTimes(1);

    client.reloadRefs.mockRejectedValueOnce({ code: "HANDLE_GONE", message: "gone" });
    s.request("poll:git");
    await s.flush();
    expect(useStore.getState().screen).toBe("error");
    expect(useStore.getState().error?.code).toBe("HANDLE_GONE");
    expect(stopObserver).toHaveBeenCalled();
    expect(s.mode).toBe("manual");
  });

  it("store lifecycle: openRepo starts detection, closeRepo stops it; branch changes route through the scheduler", async () => {
    const stopObserver = vi.fn();
    const startObserver = vi.fn(() => stopObserver);
    const s = make({ startObserver });
    await open();
    expect(startObserver).toHaveBeenCalledTimes(1);
    expect(s.mode).toBe("live");
    useStore.getState().setTarget("topic");
    await s.flush();
    expect(client.computeDiff).toHaveBeenCalledTimes(1);
    expect(client.reloadRefs).not.toHaveBeenCalled();
    await useStore.getState().closeRepo();
    expect(stopObserver).toHaveBeenCalledTimes(1);
    expect(useStore.getState().refresh.mode).toBe("manual");
  });
});
