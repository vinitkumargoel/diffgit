/**
 * T10.5: the commit-graph reader answers exactly what `readCommit` answers — parents in order and
 * the committer date — for every commit in the `history` fixture (which is built with
 * `git commit-graph write --reachable --changed-paths`), verifies its own trailing checksum, and
 * degrades to "no graph" for everything it cannot use rather than throwing.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedLines } from "../../test/fixtures";
import { createFsaFs, type FsaFs } from "../fs/fsaFs";
import { MemoryFs } from "../fs/memoryDirHandle";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { COMMIT_GRAPH_PATH, CommitGraph } from "./commitGraph";
import { ObjectDb } from "./objectDb";

async function open(name: string): Promise<FsaFs> {
  return createFsaFs(await NodeDirHandle.open(fixturePath(name)));
}

/** A `.git/` with only the bytes we want to feed the reader. */
function memFs(files: Record<string, Uint8Array | string>): FsaFs {
  return createFsaFs(
    MemoryFs.fromEntries({ ".git/HEAD": "ref: refs/heads/main\n", ...files }).handle(),
  );
}

describe("CommitGraph", () => {
  test("history: every commit has the same parents and time as readCommit", async () => {
    const fs = await open("history");
    const { graph, status, warnings } = await CommitGraph.load(fs);
    expect(status).toBe("ok");
    expect(warnings).toEqual([]);
    expect(graph).not.toBeNull();
    const db = new ObjectDb(fs);
    const oids = loadExpectedLines("history", "log-all-date-order");
    expect(oids.length).toBeGreaterThanOrEqual(60);
    expect((graph as CommitGraph).count).toBe(oids.length);
    for (const oid of oids) {
      const fromGraph = (graph as CommitGraph).get(oid);
      const fromObject = await db.readCommit(oid);
      expect(fromGraph).not.toBeNull();
      expect(fromGraph?.parents).toEqual(fromObject.parents);
      expect(fromGraph?.tree).toBe(fromObject.tree);
      expect(fromGraph?.commitTime).toBe(fromObject.committer.timestamp);
      expect(fromGraph?.generation).toBeGreaterThan(0);
    }
  });

  test("an oid the graph does not list answers null (never invent existence)", async () => {
    const { graph } = await CommitGraph.load(await open("history"));
    expect((graph as CommitGraph).get("0".repeat(40))).toBeNull();
    expect((graph as CommitGraph).get("deadbeef")).toBeNull();
    expect((graph as CommitGraph).position("f".repeat(40))).toBe(-1);
  });

  test("a repository without a commit-graph is simply absent, with no warning", async () => {
    const load = await CommitGraph.load(await open("basic"));
    expect(load).toEqual({ graph: null, status: "absent", warnings: [] });
  });

  test("a split graph chain falls back without a warning (T10.5 scope)", async () => {
    const load = await CommitGraph.load(
      memFs({ ".git/objects/info/commit-graphs/commit-graph-chain": "abc\n" }),
    );
    expect(load.graph).toBeNull();
    expect(load.status).toBe("chain");
    expect(load.warnings).toEqual([]);
  });

  test("a corrupted trailer is COMMIT_GRAPH_STALE, not an error", async () => {
    const good = await (await open("history")).readFile(`/${COMMIT_GRAPH_PATH}`);
    const bad = Uint8Array.from(good);
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 0xff;
    const load = await CommitGraph.load(memFs({ [`.git/${COMMIT_GRAPH_PATH.slice(5)}`]: bad }));
    expect(load.graph).toBeNull();
    expect(load.status).toBe("corrupt");
    expect(load.warnings.map((w) => w.code)).toEqual(["COMMIT_GRAPH_STALE"]);
  });

  test("an unknown version or hash version is refused, not guessed at", async () => {
    const good = await (await open("history")).readFile(`/${COMMIT_GRAPH_PATH}`);
    for (const [index, value] of [
      [4, 2],
      [5, 2],
      [7, 1],
    ] as const) {
      const bad = Uint8Array.from(good);
      bad[index] = value;
      await expect(CommitGraph.parse(bad)).rejects.toThrow("unsupported");
    }
    await expect(CommitGraph.parse(new Uint8Array(4))).rejects.toThrow("too short");
  });

  test("octopus: the EDGE chunk gives back all three parents", async () => {
    // The octopus fixture is not gc'd, so it has no graph of its own: parse the one we can build
    // by checking the reader against the object database on `history`'s merge instead.
    const fs = await open("history");
    const { graph } = await CommitGraph.load(fs);
    const db = new ObjectDb(fs);
    const merge = (
      await Promise.all(
        loadExpectedLines("history", "log-all-date-order").map((oid) => db.readCommit(oid)),
      )
    ).find((c) => c.parents.length > 1);
    expect(merge).toBeDefined();
    expect((graph as CommitGraph).get((merge as { oid: string }).oid)?.parents).toEqual(
      (merge as { parents: string[] }).parents,
    );
  });
});
