/**
 * Worker/engine side of the E2E transport (T0.4): fetches a snapshot for a marker, then keeps the
 * rehydrated `MemoryFs` in sync with test mutations and answers `listRoot` debug requests.
 */
import type { DirHandleLike } from "../fs/dirHandleLike";
import { MemoryFs, type MemoryHandleMarker } from "../fs/memoryDirHandle";
import { E2E_CHANNEL, type E2eMessage, type E2eRequest, isE2eMessage, newReqId } from "./protocol";

let channel: BroadcastChannel | null = null;
/** The memory trees currently alive in this context, keyed by snapshot id. */
const trees = new Map<string, MemoryFs>();

function getChannel(): BroadcastChannel {
  if (channel) return channel;
  channel = new BroadcastChannel(E2E_CHANNEL);
  channel.addEventListener("message", (ev: MessageEvent<unknown>) => {
    const msg = ev.data;
    if (!isE2eMessage(msg)) return;
    handleRequest(msg);
  });
  return channel;
}

function post(msg: E2eMessage): void {
  getChannel().postMessage(msg);
}

function handleRequest(msg: E2eMessage): void {
  switch (msg.type) {
    case "applyMutation": {
      try {
        for (const fs of trees.values()) fs.apply(msg.mutations);
        post({ type: "mutationApplied", reqId: msg.reqId, ok: true });
      } catch (e) {
        post({ type: "mutationApplied", reqId: msg.reqId, ok: false, error: String(e) });
      }
      break;
    }
    case "listRoot": {
      const first = trees.values().next().value as MemoryFs | undefined;
      const entries = first ? [...first.root.children.keys()].sort() : null;
      post({ type: "rootListing", reqId: msg.reqId, entries });
      break;
    }
    default:
      // responses and getSnapshot requests are handled by the shim side
      break;
  }
}

function request<T extends E2eMessage>(
  req: E2eRequest,
  match: (m: E2eMessage) => m is T,
  timeoutMs = 5000,
): Promise<T> {
  const ch = getChannel();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ch.removeEventListener("message", onMessage);
      reject(new Error(`e2e channel: no response to ${req.type} within ${timeoutMs} ms`));
    }, timeoutMs);
    function onMessage(ev: MessageEvent<unknown>) {
      const m = ev.data;
      if (!isE2eMessage(m) || m.reqId !== req.reqId || !match(m)) return;
      clearTimeout(timer);
      ch.removeEventListener("message", onMessage);
      resolve(m);
    }
    ch.addEventListener("message", onMessage);
    ch.postMessage(req);
  });
}

/** Builds (or reuses) the in-memory tree for a marker by asking the shim for its snapshot. */
export async function rehydrateMarker(marker: MemoryHandleMarker): Promise<DirHandleLike> {
  const existing = trees.get(marker.snapshotId);
  if (existing) return existing.handle(marker.name);
  const res = await request(
    { type: "getSnapshot", reqId: newReqId(), snapshotId: marker.snapshotId },
    (m): m is Extract<E2eMessage, { type: "snapshot" }> => m.type === "snapshot",
  );
  if (!res.snapshot) throw new Error(`e2e channel: unknown snapshot ${marker.snapshotId}`);
  const fs = MemoryFs.fromSnapshot(res.snapshot);
  trees.set(marker.snapshotId, fs);
  return fs.handle(marker.name);
}

/** Test hook: forget rehydrated trees and close the channel (used between unit tests). */
export function resetMemoryChannel(): void {
  trees.clear();
  channel?.close();
  channel = null;
}
