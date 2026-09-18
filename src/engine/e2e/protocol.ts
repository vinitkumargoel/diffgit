/**
 * Test-only transport between the Playwright shim (main thread) and the engine worker (T0.4).
 * A `BroadcastChannel("diffgit-e2e")` carries plain messages; every request has a `reqId` and is
 * answered by exactly one response. Production builds never import the client (guarded by
 * `import.meta.env.VITE_E2E === "1"` at the call site).
 */
import type { MemorySnapshot, Mutation } from "../fs/memoryDirHandle";

export const E2E_CHANNEL = "diffgit-e2e";

export type E2eRequest =
  | { type: "getSnapshot"; reqId: string; snapshotId: string }
  | { type: "applyMutation"; reqId: string; mutations: Mutation[] }
  | { type: "listRoot"; reqId: string };

export type E2eResponse =
  | { type: "snapshot"; reqId: string; snapshot: MemorySnapshot | null }
  | { type: "mutationApplied"; reqId: string; ok: boolean; error?: string }
  | { type: "rootListing"; reqId: string; entries: string[] | null };

export type E2eMessage = E2eRequest | E2eResponse;

export function isE2eMessage(v: unknown): v is E2eMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { type?: unknown }).type === "string" &&
    typeof (v as { reqId?: unknown }).reqId === "string"
  );
}

export function newReqId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
