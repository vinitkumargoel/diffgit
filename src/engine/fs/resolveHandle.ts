/**
 * Turns whatever the UI handed the worker into a `DirHandleLike` (T0.4 amendment).
 * In E2E builds (`VITE_E2E=1`) a cloneable marker is rehydrated into a `MemoryDirHandle` over the
 * test channel; everywhere else the value must already be a real directory handle and is passed
 * through. The E2E branch is behind a static guard so production builds tree-shake it away.
 */
import type { DirHandleLike } from "./dirHandleLike";
import { fileSnapshotHandle, isFileSnapshot } from "./fileSnapshot";
import { isMemoryHandleMarker } from "./memoryDirHandle";

export async function resolveHandle(value: unknown): Promise<DirHandleLike> {
  // T11.15: Firefox and Safari have no directory handle to post, so snapshot mode posts the
  // cloneable `File` list instead and the tree is laid out here, in the worker. Bytes stay unread.
  if (isFileSnapshot(value)) return fileSnapshotHandle(value);
  if (isMemoryHandleMarker(value)) {
    if (import.meta.env.VITE_E2E === "1") {
      const { rehydrateMarker } = await import("../e2e/memoryChannel");
      return rehydrateMarker(value);
    }
    throw new TypeError("memory-handle markers are only accepted in E2E builds");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "directory" &&
    typeof (value as { getDirectoryHandle?: unknown }).getDirectoryHandle === "function"
  ) {
    return value as DirHandleLike;
  }
  throw new TypeError("expected a directory handle");
}
