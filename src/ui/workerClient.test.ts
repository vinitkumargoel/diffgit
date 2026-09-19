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
    // `blob-tag` / `tree-tag` are the T10.5b B1 fixtures: refs that do not name a commit.
    expect(tags.map((x) => x.name)).toEqual([
      "blob-tag",
      "tree-tag",
      "v0.1.0",
      "v0.2.0",
      "v1.0.0",
      "v1.1.0",
    ]);
    expect(tags.map((x) => x.targetType)).toEqual([
      "blob",
      "tree",
      "commit",
      "commit",
      "commit",
      "commit",
    ]);
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
    // T10.5: `reflog()` now fills `reachable` itself, so the recording carries it too.
    expect(entries.every((e) => typeof e.reachable === "boolean")).toBe(true);
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

describe("mock worker client: conflict payloads (T10.3)", () => {
  /** The three interrupted fixtures are recorded with `includeWorktree`, like `bun run record`. */
  async function openConflicted(name: string) {
    const client = createMockWorkerClient();
    const info = await client.open({ name }, sink());
    const src: DiffSource = {
      kind: "branches",
      source: info.headBranch ?? "HEAD",
      target: info.defaultRef?.name ?? "main",
      sourceRef: info.headBranch ? `refs/heads/${info.headBranch}` : "HEAD",
      targetRef: info.defaultRef?.fullName ?? "refs/heads/main",
      includeWorktree: true,
    };
    const diff = await client.computeDiff(src);
    return { client, diff };
  }

  it("serves the recorded three-way view of a both-modified file", async () => {
    const { client, diff } = await openConflicted("merge-conflict");
    const p = await client.conflict(diff.generation, "file.txt");
    expect(p.generation).toBe(diff.generation);
    expect(p.kind).toBe("both-modified");
    expect(p.labels).toEqual({ ours: "main", theirs: "topic" });
    expect(p.base?.oid).toBe("f98585722413e2775399bf49fd987a837d5aad5a");
    expect(p.ours?.oid).toBe("d941f5e5752df0ae61ccc7a23d6c576b9d86ec62");
    expect(p.theirs?.oid).toBe("52fb50c425d12a5d4111ba2e15e03075f2a19bbc");
    expect(p.worktree?.markers).toEqual([{ start: 3, end: 7, oursEnd: 5 }]);
    expect(p.resolvedInWorktree).toBe(false);
    expect(p.oursHunks?.hunks.length).toBeGreaterThan(0);
  });

  it("a modify/delete conflict has no theirs side and reads as resolved on disk", async () => {
    const { client, diff } = await openConflicted("merge-conflict");
    const p = await client.conflict(diff.generation, "gone.txt");
    expect(p.kind).toBe("deleted-by-them");
    expect(p.theirs).toBeNull();
    expect(p.worktree?.markers).toEqual([]);
    expect(p.resolvedInWorktree).toBe(true);
    expect(diff.files.find((f) => f.id === "gone.txt")?.status).toBe("deleted");
  });

  it("the rebase and cherry-pick fixtures carry their own labels and kinds", async () => {
    const rebase = await openConflicted("rebase-conflict");
    const added = await rebase.client.conflict(rebase.diff.generation, "both-added.txt");
    expect(added.kind).toBe("both-added");
    expect(added.base).toBeNull();
    expect(added.labels).toEqual({ ours: "main", theirs: "d424326" });
    expect(rebase.diff.files.find((f) => f.id === "both-added.txt")?.status).toBe("added");

    const cherry = await openConflicted("cherry-pick-conflict");
    const p = await cherry.client.conflict(cherry.diff.generation, "file.txt");
    expect(p.kind).toBe("both-modified");
    expect(p.worktree?.markers).toEqual([{ start: 4, end: 8, oursEnd: 6 }]);
  });

  it("rejects a stale generation, an unknown id and a file with no stages", async () => {
    const { client, diff } = await openConflicted("rebase-conflict");
    await expect(client.conflict(diff.generation - 1, "file.txt")).rejects.toMatchObject({
      code: "STALE",
    });
    await expect(client.conflict(diff.generation, "nope.txt")).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(client.conflict(diff.generation, "one.txt")).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});

describe("mock worker client: why hidden (T10.4)", () => {
  it("serves the recorded Hidden group, with ignored directories collapsed to one row", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "hidden" }, sink());
    const hidden = await client.listHidden();
    expect(hidden.map((h) => h.path)).toEqual([...hidden.map((h) => h.path)].sort());
    expect(hidden.find((h) => h.path === "dist")).toEqual({
      path: "dist",
      kind: "ignored-dir",
      count: 3,
    });
    expect(hidden.some((h) => h.path.startsWith("dist/"))).toBe(false);
    expect(hidden.find((h) => h.path === "src/skipped.txt")?.kind).toBe("skip-worktree");
    expect(hidden.find((h) => h.path === "src/assumed.txt")?.kind).toBe("assume-unchanged");
    expect(hidden.find((h) => h.path === "big.txt")?.kind).toBe("too-large");
  });

  it("explains a path with the rule that matched and the command that undoes it", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "hidden" }, sink());
    expect(await client.explainPath(".env.local")).toEqual({
      path: ".env.local",
      shown: false,
      reasons: [
        {
          kind: "ignored",
          source: ".gitignore",
          line: 2,
          pattern: ".env.local",
          command: "git check-ignore -v .env.local",
        },
      ],
    });
    expect((await client.explainPath("src/skipped.txt")).reasons[0]).toEqual({
      kind: "skip-worktree",
      command: "git update-index --no-skip-worktree src/skipped.txt",
    });
    expect((await client.explainPath("big.txt")).reasons).toEqual([{ kind: "too-large" }]);
    expect(await client.explainPath("notes.txt")).toEqual({
      path: "notes.txt",
      shown: true,
      reasons: [],
    });
    // a fixture with no recording behaves like a repository that hides nothing
    expect(await client.explainPath("/never/recorded.txt")).toEqual({
      path: "never/recorded.txt",
      shown: true,
      reasons: [],
    });
  });

  it("passes the builtinExcludes preference through the real client's open()", async () => {
    const seen: unknown[] = [];
    const client = createWorkerClient(
      () =>
        new FakeWorker({
          async open(_h, _s, o) {
            seen.push(o);
            return basicInfo as RepoInfo;
          },
        }) as unknown as Worker,
    );
    await client.open({ name: "x" }, sink(), { builtinExcludes: false });
    expect(seen).toEqual([{ builtinExcludes: false }]);
    client.terminate();
  });
});

describe("mock worker client: history, lanes and branches (T10.5)", () => {
  it("pages the recorded history with lanes, refs and a continuing cursor", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "history" }, sink());

    const first = await client.walkCommits({ from: ["HEAD"], firstParent: false, limit: 10 });
    expect(first.commits.length).toBe(10);
    expect(first.graphAvailable).toBe(true);
    expect(first.capped).toBe(false);
    expect(first.cursor).not.toBeNull();
    for (const row of first.commits) {
      expect(row.lane).toBeGreaterThanOrEqual(0);
      expect(row.laneCount).toBeGreaterThan(row.lane as number);
      expect(row.edges).toBeDefined();
      expect(row.subject.length).toBeGreaterThan(0);
    }
    expect(first.commits[0]?.refs).toContain("HEAD");

    const second = await client.walkCommits({
      from: ["HEAD"],
      firstParent: false,
      limit: 10,
      cursor: first.cursor as string,
    });
    expect(second.commits.length).toBe(10);
    const seen = new Set([...first.commits, ...second.commits].map((c) => c.oid));
    expect(seen.size).toBe(20);
  });

  it("serves the first-parent, --all and path variants separately", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "history" }, sink());
    const plain = await client.walkCommits({ from: ["HEAD"], firstParent: false, limit: 500 });
    const firstParent = await client.walkCommits({ from: ["HEAD"], firstParent: true, limit: 500 });
    const all = await client.walkCommits({ from: [], firstParent: false, all: true, limit: 500 });
    const path = await client.walkCommits({
      from: ["HEAD"],
      firstParent: false,
      limit: 500,
      path: "src/hot.txt",
    });
    expect(firstParent.commits.length).toBeLessThan(plain.commits.length);
    expect(all.commits.length).toBeGreaterThan(plain.commits.length);
    expect(path.commits.length).toBe(3);
    expect(path.cursor).toBeNull();
  });

  it("serves commit details and batched stats for the rows it walked", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "history" }, sink());
    const page = await client.walkCommits({ from: ["HEAD"], firstParent: false, limit: 5 });
    const oids = page.commits.map((c) => c.oid);
    const details = await client.commitDetails(oids[0] as string);
    expect(details.oid).toBe(oids[0] as string);
    expect(details.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(details.signed).toBe(false);
    expect(details.note).toBeNull();
    expect(details.stats?.files).toBeGreaterThan(0);
    const stats = await client.commitStats(oids);
    expect(Object.keys(stats).sort()).toEqual([...oids].sort());
    expect(stats[oids[0] as string]).toEqual(details.stats);
    await expect(client.commitDetails("0".repeat(40))).rejects.toMatchObject({
      code: "REV_NOT_FOUND",
    });
  });

  it("serves the Branches table with lazily filled cells", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "history" }, sink());
    const rows = await client.branchOverview();
    expect(rows.map((r) => r.ref.name).sort()).toEqual([
      "main",
      "preflight/a",
      "preflight/base",
      "topic",
    ]);
    for (const row of rows) {
      expect(row.vsUpstream).toBeNull();
      expect(row.vsDefault).toBeNull();
      expect(row.merged).toBeNull();
    }
    const cells = await client.branchCells(rows.map((r) => r.ref.fullName));
    expect(cells["refs/heads/topic"]?.merged).toBe(true);
    expect(cells["refs/heads/preflight/a"]?.merged).toBe(false);
    expect(cells["refs/heads/preflight/a"]?.vsDefault?.ahead).toBe(3);
  });

  it("serves ahead/behind and reachability", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "history" }, sink());
    expect(await client.aheadBehind("main", "topic")).toMatchObject({ ahead: 36, behind: 0 });
    const page = await client.walkCommits({ from: ["HEAD"], firstParent: false, limit: 3 });
    const oids = page.commits.map((c) => c.oid);
    const reachable = await client.markReachable([...oids, "0".repeat(40)]);
    for (const oid of oids) expect(reachable[oid]).toBe(true);
    expect(reachable["0".repeat(40)]).toBe(false);
  });

  it("the octopus fixture draws a three-parent merge", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "octopus" }, sink());
    const page = await client.walkCommits({ from: [], firstParent: false, all: true, limit: 50 });
    expect(page.graphAvailable).toBe(true); // T10.5b nit 1: the fixture now carries a commit-graph
    expect(page.laneOverflow).toBe(false);
    const merge = page.commits.find((c) => c.parents.length === 3);
    expect(merge).toBeDefined();
    expect(merge?.edges?.filter((e) => e.from === (merge?.lane as number))).toHaveLength(3);
  });

  it("a fixture with no v2 recording answers an empty history", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "showcase" }, sink());
    const page = await client.walkCommits({ from: ["HEAD"], firstParent: false, limit: 50 });
    expect(page).toEqual({
      commits: [],
      cursor: null,
      graphAvailable: false,
      capped: false,
      laneOverflow: false,
    });
    expect(await client.branchOverview()).toEqual([]);
  });
});

describe("mock worker client: file history and blame (T10.6)", () => {
  it("pages the recorded path history and stops at the rename hop without follow", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "history" }, sink());

    const followed = await client.pathHistory("HEAD", "src/renamed-to.txt", {
      follow: true,
      limit: 100,
    });
    expect(followed.entries.map((e) => [e.status, e.path, e.renamedFrom])).toEqual([
      ["modified", "src/renamed-to.txt", null],
      ["renamed", "src/renamed-to.txt", "src/renamed-from.txt"],
      ["modified", "src/renamed-from.txt", null],
      ["added", "src/renamed-from.txt", null],
    ]);
    expect(followed.cursor).toBeNull();

    const plain = await client.pathHistory("HEAD", "src/renamed-to.txt", {
      follow: false,
      limit: 100,
    });
    expect(plain.entries.map((e) => e.oid)).toEqual(followed.entries.slice(0, 2).map((e) => e.oid));

    const first = await client.pathHistory("HEAD", "src/renamed-to.txt", {
      follow: true,
      limit: 2,
    });
    expect(first.entries.length).toBe(2);
    const rest = await client.pathHistory("HEAD", "src/renamed-to.txt", {
      follow: true,
      limit: 2,
      cursor: first.cursor as string,
    });
    expect([...first.entries, ...rest.entries].map((e) => e.oid)).toEqual(
      followed.entries.map((e) => e.oid),
    );
    expect(rest.cursor).toBeNull();
  });

  it("serves blame per path, with a separate -w attribution and a progress message", async () => {
    const client = createMockWorkerClient();
    const s = sink();
    const progress: string[] = [];
    await client.open({ name: "history" }, { ...s, onProgress: (p) => progress.push(p.phase) });

    const blame = await client.blame("main", "src/renamed-to.txt", {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 500,
    });
    expect(blame.ref).toBe("main");
    expect(blame.lines.length).toBe(21);
    expect(blame.capped).toBe(false);
    expect(blame.lines.every((l) => l.oid !== null)).toBe(true);
    // The oldest lines keep the name the file had before the rename.
    expect(blame.lines[0]?.origPath).toBe("src/renamed-from.txt");
    expect(blame.lines[20]?.origPath).toBe("src/renamed-to.txt");
    expect(Object.keys(blame.commits).length).toBe(3);
    expect(progress).toContain("blame");

    const plain = await client.blame("main", "src/indent.txt", {
      ignoreWhitespace: false,
      includeWorktree: false,
      maxRevisions: 500,
    });
    const ignored = await client.blame("main", "src/indent.txt", {
      ignoreWhitespace: true,
      includeWorktree: false,
      maxRevisions: 500,
    });
    expect(Object.values(plain.commits)[0]?.subject).toContain("reindent");
    expect(Object.values(ignored.commits)[0]?.subject).toContain("root commit");

    await expect(
      client.blame("main", "nope.txt", {
        ignoreWhitespace: false,
        includeWorktree: false,
        maxRevisions: 500,
      }),
    ).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
  });
});

describe("mock worker client: secret scan (T10.7)", () => {
  async function openSecrets() {
    const warnings: { code: string; detail?: string }[] = [];
    const client = createMockWorkerClient();
    const s = sink();
    const info = await client.open(
      { name: "secrets" },
      { ...s, onWarning: (w) => void warnings.push(w) },
    );
    const src: DiffSource = {
      kind: "branches",
      source: info.headBranch ?? "HEAD",
      target: info.defaultRef?.name ?? "main",
      sourceRef: info.headBranch ? `refs/heads/${info.headBranch}` : "HEAD",
      targetRef: info.defaultRef?.fullName ?? "refs/heads/main",
      includeWorktree: true,
    };
    const diff = await client.computeDiff(src);
    return { client, diff, warnings };
  }

  it("serves the recorded findings and the SECRETS_FOUND warning", async () => {
    const { client, diff, warnings } = await openSecrets();
    const findings = await client.scanSecrets(diff.generation);
    expect(findings.map((f) => [f.path, f.line, f.rule, f.layer])).toEqual([
      ["config/deploy.sh", 3, "anthropic-api-key", "staged"],
      ["config/id_rsa", 1, "private-key-rsa", "staged"],
      ["config/settings.ini", 4, "aws-access-key-id", "unstaged"],
      ["config/settings.ini", 5, "github-personal-access-token", "unstaged"],
    ]);
    expect(findings.every((f) => f.masked.includes("…") || f.masked.includes("•"))).toBe(true);
    expect(warnings.filter((w) => w.code === "SECRETS_FOUND")[0]?.detail).toBe("4");
  });

  it("rejects a stale generation and answers [] for a fixture with no recording", async () => {
    const { client, diff } = await openSecrets();
    await expect(client.scanSecrets(diff.generation + 1)).rejects.toMatchObject({ code: "STALE" });

    const clean = createMockWorkerClient();
    await clean.open({ name: "showcase" }, sink());
    const cleanDiff = await clean.computeDiff(SRC);
    expect(await clean.scanSecrets(cleanDiff.generation)).toEqual([]);
  });
});

describe("mock worker client: insights (T10.9)", () => {
  it("serves the recorded whole-history pass and honours `limit`", async () => {
    const progress: { phase: string }[] = [];
    const client = createMockWorkerClient();
    const s = sink();
    await client.open({ name: "history" }, { ...s, onProgress: (p) => void progress.push(p) });

    const out = await client.insights({ limit: 3 });
    expect(out.walked).toBe(48);
    expect(out.commits).toBe(48);
    expect(out.capped).toBe(false);
    expect(out.bots).toBe(8);
    expect(out.authors.map((a) => a.name)).toEqual(["Ada Lovelace", "Grace Hopper", "test"]);
    expect(out.authors.some((a) => a.name === "renovate[bot]")).toBe(false);
    // Three real hotspots, then the manifests, which the UI greys out.
    expect(out.hotspots.filter((h) => !h.manifest)).toHaveLength(3);
    expect(out.hotspots.filter((h) => h.manifest).map((h) => h.path)).toEqual(["package.json"]);
    expect(out.activity.every((w) => w.days.length === 7)).toBe(true);
    expect(out.activity.reduce((n, w) => n + w.days.reduce((a, b) => a + b, 0), 0)).toBe(
      out.commits,
    );
    expect(progress.some((p) => p.phase === "insights")).toBe(true);
  });

  it("answers an empty result for a fixture with no v2 recording", async () => {
    const client = createMockWorkerClient();
    await client.open({ name: "showcase" }, sink());
    expect(await client.insights({ limit: 10 })).toEqual({
      commits: 0,
      authors: [],
      hotspots: [],
      activity: [],
      walked: 0,
      capped: false,
      bots: 0,
    });
  });
});
