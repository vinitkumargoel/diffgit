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

    // amendment: exactly one restart per crash, even when `error` and `messageerror` both fire
    workers[1]?.crash();
    workers[1]?.dispatchEvent(new MessageEvent("messageerror"));
    workers[1]?.crash();
    await vi.waitFor(() => expect(restarted).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(workers.length).toBe(3);
    expect(opens).toBe(3);
    expect(workers[2]?.terminated).toBe(false);
    client.terminate();
  });
});

describe("mock worker client: v2 sources (T10.1)", () => {
  it("serves the recorded tags, stashes and revisions", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "tags" }, sink());
    const tags = await client.listTags();
    expect(tags.map((x) => x.name)).toEqual(["v0.1.0", "v0.2.0", "v1.0.0", "v1.1.0"]);
    expect(tags.find((x) => x.name === "v1.0.0")?.annotated).toBe(true);
    expect(await client.resolveRevision("v1.0.0")).toMatchObject({
      kind: "tag",
      display: "v1.0.0",
      fullRef: "refs/tags/v1.0.0",
    });
    await expect(client.resolveRevision("nope")).rejects.toMatchObject({ code: "REV_NOT_FOUND" });
    expect(await client.listStashes()).toEqual([]);
  });

  it("replays a recorded range, including a stash with its untracked file", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "stash" }, sink());
    const stashes = await client.listStashes();
    expect(stashes.map((s) => s.expr)).toEqual(["stash@{0}", "stash@{1}"]);
    expect(stashes[0]?.untrackedOid).not.toBeNull();
    expect(stashes[0]?.files).toBe(2);

    const head = await client.resolveRevision("HEAD");
    const stash = await client.resolveRevision("stash@{0}");
    const range: DiffSource = {
      kind: "range",
      from: head.display,
      to: stash.display,
      fromRef: "HEAD",
      toRef: "stash@{0}",
      fromOid: head.oid,
      toOid: stash.oid as string,
      threeDot: false,
      includeWorktree: false,
    };
    const diff = await client.computeDiff(range);
    expect(diff.source).toEqual(range);
    expect(diff.files.map((f) => [f.id, f.layers])).toEqual([
      ["b.txt", ["unstaged"]],
      ["stashed-untracked.txt", ["untracked"]],
    ]);
    expect(client.lastSource()).toEqual(range);
  });

  it("a fixture without a v2 recording answers with empty lists", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "showcase" }, sink());
    expect(await client.listTags()).toEqual([]);
    expect(await client.listStashes()).toEqual([]);
    await expect(client.resolveRevision("main")).rejects.toMatchObject({ code: "REV_NOT_FOUND" });
  });
});

describe("mock worker client: reflog and operation (T10.2)", () => {
  it("serves the recorded rebase banner and HEAD reflog", async () => {
    const client = createMockWorkerClient();
    const info = await client.open({ name: "rebase-conflict" }, sink());
    expect(info.operation).toMatchObject({
      kind: "rebase",
      step: 2,
      total: 3,
      conflicts: 2,
      ontoDisplay: "main",
      headName: "refs/heads/topic",
      interactive: true,
    });
    expect(info.warnings.map((w) => w.code)).toContain("OPERATION_IN_PROGRESS");
    expect(await client.operation()).toEqual(info.operation);

    const entries = await client.reflog("HEAD", 3);
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.expr)).toEqual(["HEAD@{0}", "HEAD@{1}", "HEAD@{2}"]);
    expect(entries.map((e) => e.action)).toEqual(["rebase (pick)", "rebase (start)", "checkout"]);
    expect(entries[0]?.reachable).toBeNull();
  });

  it("the merge fixture reports a merge with its conflicts", async () => {
    const client = createMockWorkerClient();
    const info = await client.open({ name: "merge-conflict" }, sink());
    expect(info.operation).toMatchObject({ kind: "merge", conflicts: 2 });
    expect((await client.reflog("HEAD", 50)).length).toBe(5);
  });

  it("an idle repository has no operation, and an unrecorded ref warns NO_REFLOG", async () => {
    const warnings: { code: string }[] = [];
    const client = createMockWorkerClient();
    const s = sink();
    const info = await client.open(
      { name: "history" },
      { ...s, onWarning: (w) => void warnings.push(w) },
    );
    expect(info.operation).toBeNull();
    expect(await client.operation()).toBeNull();
    expect((await client.reflog("HEAD", 5)).length).toBe(5);
    expect(await client.reflog("topic", 5)).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain("NO_REFLOG");
  });
});
