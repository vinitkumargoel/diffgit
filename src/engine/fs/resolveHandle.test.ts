import { afterEach, describe, expect, test } from "bun:test";
import { E2E_CHANNEL, type E2eMessage, isE2eMessage } from "../e2e/protocol";
import { MemoryFs, type MemorySnapshot } from "./memoryDirHandle";
import { NodeDirHandle } from "./nodeDirHandle";
import { resolveHandle } from "./resolveHandle";

/** Minimal shim-side responder, mirroring e2e/fsaShim.ts, running in the same Bun process. */
function startShim(snapshots: Record<string, MemorySnapshot>) {
  const ch = new BroadcastChannel(E2E_CHANNEL);
  ch.onmessage = (ev: MessageEvent<unknown>) => {
    const m = ev.data;
    if (!isE2eMessage(m) || m.type !== "getSnapshot") return;
    ch.postMessage({ type: "snapshot", reqId: m.reqId, snapshot: snapshots[m.snapshotId] ?? null });
  };
  function request(msg: Record<string, unknown>, responseType: string): Promise<E2eMessage> {
    const reqId = `t-${Math.random()}`;
    return new Promise((resolve) => {
      const c2 = new BroadcastChannel(E2E_CHANNEL);
      c2.onmessage = (ev: MessageEvent<unknown>) => {
        const m = ev.data;
        if (isE2eMessage(m) && m.type === responseType && m.reqId === reqId) {
          c2.close();
          resolve(m);
        }
      };
      c2.postMessage({ ...msg, reqId });
    });
  }
  return { close: () => ch.close(), request };
}

describe("resolveHandle", () => {
  const prev = process.env.VITE_E2E;
  afterEach(async () => {
    process.env.VITE_E2E = prev;
    const { resetMemoryChannel } = await import("../e2e/memoryChannel");
    resetMemoryChannel();
  });

  test("passes a real directory handle through untouched", async () => {
    const h = await NodeDirHandle.open(process.cwd());
    expect(await resolveHandle(h)).toBe(h);
  });

  test("rejects non-handles", async () => {
    await expect(resolveHandle({ kind: "file" })).rejects.toBeInstanceOf(TypeError);
    await expect(resolveHandle(null)).rejects.toBeInstanceOf(TypeError);
  });

  test("rejects markers outside E2E builds", async () => {
    process.env.VITE_E2E = "0";
    await expect(
      resolveHandle({
        __diffgoelMemoryHandle: true,
        kind: "directory",
        snapshotId: "s",
        name: "n",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("E2E: rehydrates a marker over the channel; mutations and listRoot work", async () => {
    process.env.VITE_E2E = "1";
    const snap = MemoryFs.fromEntries({
      ".git/HEAD": "ref: refs/heads/main\n",
      "README.md": "hi",
    }).toSnapshot("s1", "repo");
    const shim = startShim({ s1: snap });
    try {
      const root = await resolveHandle({
        __diffgoelMemoryHandle: true,
        kind: "directory",
        snapshotId: "s1",
        name: "repo",
      });
      expect(root.kind).toBe("directory");
      const git = await root.getDirectoryHandle(".git");
      const names: string[] = [];
      for await (const [n] of git.entries()) names.push(n);
      expect(names).toEqual(["HEAD"]);

      const listing = await shim.request({ type: "listRoot" }, "rootListing");
      expect(listing.type === "rootListing" && listing.entries).toEqual([".git", "README.md"]);

      const applied = await shim.request(
        {
          type: "applyMutation",
          mutations: [
            { op: "write", path: "new.txt", text: "n" },
            { op: "remove", path: "README.md" },
          ],
        },
        "mutationApplied",
      );
      expect(applied.type === "mutationApplied" && applied.ok).toBe(true);
      const after: string[] = [];
      for await (const [n] of root.entries()) after.push(n);
      expect(after).toEqual([".git", "new.txt"]);

      // same marker again reuses the tree (mutations persist)
      const again = await resolveHandle({
        __diffgoelMemoryHandle: true,
        kind: "directory",
        snapshotId: "s1",
        name: "repo",
      });
      await expect(again.getFileHandle("new.txt")).resolves.toBeDefined();
    } finally {
      shim.close();
    }
  });
});
