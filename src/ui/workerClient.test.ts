import * as Comlink from "comlink";
import { describe, expect, it, vi } from "vitest";
import type { EngineApi, ProgressSink, StatsBatch } from "../engine/api";
import type { DiffSource, RepoInfo } from "../engine/types";
import basicInfo from "../test/recorded/showcase.repoinfo.json";
import { createWorkerClient, type WorkerClient } from "./workerClient";
import { createMockWorkerClient } from "./workerClient.mock";

const SRC: DiffSource = {
  kind: "branches",
  source: "feature",
  target: "main",
  sourceRef: "refs/heads/feature",
  targetRef: "refs/heads/main",
  includeWorktree: true,
};

function sink(): ProgressSink & { batches: StatsBatch[] } {
  const batches: StatsBatch[] = [];
  return { batches, onProgress: () => {}, onWarning: () => {}, onStats: (b) => batches.push(b) };
}

describe("mock worker client", () => {
  it("satisfies the WorkerClient interface and serves recorded data", async () => {
    const client: WorkerClient = createMockWorkerClient();
    const s = sink();
    const info = await client.open({ name: "showcase" }, s);
    expect(info.headBranch).toBe("feature");
    const diff = await client.computeDiff(SRC);
    expect(diff.generation).toBe(1);
    expect(diff.files.length).toBe(12);
    expect(diff.files.every((f) => f.stats === null)).toBe(true);
    await vi.waitFor(() => expect(s.batches.flatMap((b) => Object.keys(b.stats)).length).toBe(12));
    const payload = await client.fileDiff(1, "docs/guide.md", { ignoreWhitespace: false });
    expect(payload.hunks?.hunks.length).toBe(1);
    expect(payload.stats).toEqual({ additions: 2, deletions: 1 });
    expect(payload.language).toBe("markdown");
    const png = await client.fileBytes(1, "assets/logo.png", "new");
    expect(png?.[0]).toBe(0x89);
  });

  it("filters worktree layers when includeWorktree is off, and rejects stale generations", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "showcase-worktree" }, sink());
    const withWt = await client.computeDiff(SRC);
    expect(withWt.files.some((f) => f.layers.includes("untracked"))).toBe(true);
    const without = await client.computeDiff({ ...SRC, includeWorktree: false });
    expect(without.generation).toBe(2);
    expect(without.files.every((f) => f.layers.length === 1 && f.layers[0] === "committed")).toBe(
      true,
    );
    await expect(client.fileDiff(1, "both.txt", { ignoreWhitespace: false })).rejects.toMatchObject(
      {
        code: "STALE",
      },
    );
    const same = await client.computeDiff({
      ...SRC,
      target: "feature",
      targetRef: SRC.sourceRef,
      includeWorktree: false,
    });
    expect(same.files).toEqual([]);
  });

  it("probe signature changes after mutate()", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "showcase" }, sink());
    const a = await client.probe("git");
    client.mutate();
    expect(await client.probe("git")).not.toBe(a);
  });

  it("tooLarge files return no hunks until loadLarge", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "showcase" }, sink());
    await client.computeDiff(SRC);
    const gated = await client.fileDiff(1, "src/big-change.txt", { ignoreWhitespace: false });
    expect(gated.hunks).toBeNull();
    const loaded = await client.fileDiff(1, "src/big-change.txt", {
      ignoreWhitespace: false,
      loadLarge: true,
    });
    expect(loaded.stats).toEqual({ additions: 3000, deletions: 3000 });
  });
});

/** A fake Worker backed by a MessageChannel with a comlink-exposed engine on the other end. */
class FakeWorker extends EventTarget {
  port: MessagePort;
  terminated = false;
  constructor(api: Partial<EngineApi>) {
    super();
    const ch = new MessageChannel();
    Comlink.expose(api, ch.port1);
    this.port = ch.port2;
    this.port.onmessage = (ev) =>
      this.dispatchEvent(new MessageEvent("message", { data: ev.data }));
  }
  postMessage(msg: unknown, transfer?: Transferable[]) {
    this.port.postMessage(msg, transfer ?? []);
  }
  terminate() {
    this.terminated = true;
    this.port.close();
  }
  crash() {
    this.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
  }
}

describe("real worker client (fake worker)", () => {
  it("proxies calls, maps engine JSON errors, and recovers from a crash", async () => {
    const workers: FakeWorker[] = [];
    let opens = 0;
    const api: Partial<EngineApi> = {
      async open(_h, s) {
        opens++;
        s.onProgress({ phase: "refs" });
        return basicInfo as RepoInfo;
      },
      async probe(tier) {
        return `${tier}:1`;
      },
      async reloadRefs() {
        throw { code: "REF_NOT_FOUND", message: "gone", hint: "pick another" };
      },
      computeDiff() {
        return new Promise(() => {}); // never resolves: we crash the worker meanwhile
      },
    };
    const client = createWorkerClient(() => {
      const w = new FakeWorker(api);
      workers.push(w);
      return w as unknown as Worker;
    });
    const progress = vi.fn();
    const info = await client.open(
      { name: "showcase" },
      { onProgress: progress, onStats: () => {}, onWarning: () => {} },
    );
    expect(info.name).toBe("basic");
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith({ phase: "refs" }));
    expect(await client.probe("git")).toBe("git:1");
    await expect(client.reloadRefs()).rejects.toEqual({
      code: "REF_NOT_FOUND",
      message: "gone",
      hint: "pick another",
    });

    const restarted = vi.fn();
    client.onRestart(restarted);
    const pending = client.computeDiff(SRC);
    workers[0]?.crash();
    await expect(pending).rejects.toMatchObject({ code: "WORKER_CRASHED" });
    expect(workers[0]?.terminated).toBe(true);
    await vi.waitFor(() => expect(restarted).toHaveBeenCalledTimes(1));
    expect(restarted.mock.calls[0]?.[0]).toMatchObject({ name: "basic" }); // the fake worker serves the JSON as-is;
    expect(workers.length).toBe(2);
    expect(opens).toBe(2);
    expect(client.lastSource()).toEqual(SRC);
    expect(await client.probe("index")).toBe("index:1");
    client.terminate();
  });
});
