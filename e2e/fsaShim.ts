/**
 * Playwright init script (T0.4): replaces `showDirectoryPicker` with a picker that resolves to a
 * cloneable memory-handle marker, serves snapshots to the worker over `BroadcastChannel`, applies
 * test mutations, and provides a `FileSystemObserver` stub whose records tests can emit.
 *
 * Usage: `await page.addInitScript(installFsaShim, { snapshots: [snap], pick: snap.id })`.
 * The function must stay self-contained (Playwright serialises its source); no imports at runtime.
 */
import type { MemorySnapshot, Mutation } from "../src/engine/fs/memoryDirHandle";

export interface ShimConfig {
  snapshots: MemorySnapshot[];
  /** Which snapshot `showDirectoryPicker` resolves to (default: the first). */
  pick?: string;
  /** Make the picker reject with AbortError (user cancelled). */
  cancel?: boolean;
}

export interface ShimObserverRecord {
  type: "appeared" | "disappeared" | "modified" | "moved" | "unknown" | "errored";
  relativePathComponents: string[];
  changedHandleKind?: "file" | "directory";
}

export interface ShimApi {
  snapshots: Record<string, MemorySnapshot>;
  setPick(id: string): void;
  mutate(mutations: Mutation[]): Promise<void>;
  listRoot(): Promise<string[] | null>;
  emitObserverRecords(records: ShimObserverRecord[]): void;
  observerCount(): number;
  requests: string[];
}

declare global {
  interface Window {
    __diffgit: ShimApi;
  }
}

export function installFsaShim(config: ShimConfig): void {
  const CHANNEL = "diffgit-e2e";
  const snapshots: Record<string, MemorySnapshot> = {};
  for (const s of config.snapshots) snapshots[s.id] = s;
  let pick = config.pick ?? config.snapshots[0]?.id ?? "";
  const channel = new BroadcastChannel(CHANNEL);

  function reqId(): string {
    return `shim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  channel.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data as { type?: string; reqId?: string; snapshotId?: string };
    if (m?.type === "getSnapshot" && typeof m.reqId === "string") {
      channel.postMessage({
        type: "snapshot",
        reqId: m.reqId,
        snapshot: snapshots[m.snapshotId ?? ""] ?? null,
      });
    }
  });

  function request<T>(
    msg: Record<string, unknown>,
    responseType: string,
    timeoutMs = 5000,
  ): Promise<T> {
    const id = reqId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.removeEventListener("message", onMessage);
        reject(new Error(`shim: no ${responseType} within ${timeoutMs} ms`));
      }, timeoutMs);
      function onMessage(ev: MessageEvent) {
        const m = ev.data as { type?: string; reqId?: string };
        if (m?.type !== responseType || m.reqId !== id) return;
        clearTimeout(timer);
        channel.removeEventListener("message", onMessage);
        resolve(m as T);
      }
      channel.addEventListener("message", onMessage);
      channel.postMessage({ ...msg, reqId: id });
    });
  }

  // ---- FileSystemObserver stub ----
  type Callback = (records: ShimObserverRecord[], observer: unknown) => void;
  const observers = new Set<{ cb: Callback }>();
  class FileSystemObserverStub {
    private entry: { cb: Callback };
    constructor(cb: Callback) {
      this.entry = { cb };
    }
    async observe(_handle: unknown, _opts?: unknown): Promise<void> {
      observers.add(this.entry);
    }
    unobserve(_handle: unknown): void {
      observers.delete(this.entry);
    }
    disconnect(): void {
      observers.delete(this.entry);
    }
  }
  (window as unknown as { FileSystemObserver: unknown }).FileSystemObserver =
    FileSystemObserverStub;

  // ---- picker ----
  (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async (opts?: {
    mode?: string;
  }) => {
    window.__diffgit.requests.push(`showDirectoryPicker:${opts?.mode ?? "read"}`);
    if (config.cancel) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }
    const snap = snapshots[pick];
    if (!snap) throw new DOMException("no snapshot selected", "NotFoundError");
    return {
      __diffgitMemoryHandle: true,
      kind: "directory",
      snapshotId: snap.id,
      name: snap.name,
    };
  };

  window.__diffgit = {
    snapshots,
    requests: [],
    setPick(id: string) {
      pick = id;
    },
    async mutate(mutations: Mutation[]) {
      const res = await request<{ ok: boolean; error?: string }>(
        { type: "applyMutation", mutations },
        "mutationApplied",
      );
      if (!res.ok) throw new Error(res.error ?? "mutation failed");
    },
    async listRoot() {
      const res = await request<{ entries: string[] | null }>({ type: "listRoot" }, "rootListing");
      return res.entries;
    },
    emitObserverRecords(records: ShimObserverRecord[]) {
      for (const o of observers) o.cb(records, o);
    },
    observerCount() {
      return observers.size;
    },
  };
}
