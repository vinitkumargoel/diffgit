/**
 * Snapshot mode's page-side half (T11.15, Design §14.6, atlas tab 18).
 *
 * Firefox and Safari will not ship `showDirectoryPicker()`, but both support
 * `<input type="file" webkitdirectory>`, which hands the page one `File` per entry of the folder the
 * user picked. This module turns that list into the cloneable `FileSnapshot` the engine worker
 * rehydrates into a `DirHandleLike` (`src/engine/fs/fileSnapshot.ts`) — the read-once equivalent of a
 * directory handle.
 *
 * Two rules the atlas sets and this module keeps:
 * - **No bytes.** Walking the list reads `name`, `webkitRelativePath` and `size` only; the engine
 *   calls `arrayBuffer()` later, for the files it actually needs.
 * - **Say what is happening, and stop when it is hopeless.** The walk is chunked so the gate's
 *   counter paints, and it refuses folders above `SNAPSHOT_ENTRY_LIMIT` entries with advice instead
 *   of freezing the tab on somebody's `node_modules`.
 */
import type { FileSnapshot, SnapshotEntry } from "../../engine/fs/fileSnapshot";

/** Above this many entries the browser itself is the bottleneck; we stop and say so (atlas risk 1). */
export const SNAPSHOT_ENTRY_LIMIT = 100_000;

/** Entries walked between two counter updates. Small enough to look live, big enough to be cheap. */
const CHUNK = 2_000;

/** What the browser gives us per entry: a `File`, structurally. */
export interface SnapshotInputFile {
  name: string;
  size: number;
  lastModified: number;
  /** `"repo/src/index.ts"` — the picked folder's name is the first segment. */
  webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  stream(): ReadableStream<Uint8Array>;
}

/** Counter state while the list is walked; `bytes` is the folder's size, not bytes read. */
export interface SnapshotProgress {
  entries: number;
  total: number;
  bytes: number;
}

/** Thrown for a folder too big to read this way; `advice` is shown next to the message. */
export class SnapshotTooLargeError extends Error {
  readonly entries: number;
  readonly advice =
    "Pick a repository without node_modules or build output, or open diffgit in Chrome, Edge, Brave or Arc, where the folder is read on demand.";
  constructor(entries: number) {
    super(
      `This folder has more than ${SNAPSHOT_ENTRY_LIMIT.toLocaleString("en-US")} entries, which this browser cannot hand over without freezing the tab.`,
    );
    this.name = "SnapshotTooLargeError";
    this.entries = entries;
  }
}

/** Lets the browser paint the counter between chunks. */
function breathe(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * `"repo/.git/HEAD"` → `".git/HEAD"`: the picked folder itself is the repository root, so its name
 * is stripped from every path. A file without a relative path (some inputs, and every plain file
 * input) keeps its own name.
 */
export function relativePathOf(
  file: { name: string; webkitRelativePath?: string },
  root: string,
): string {
  const rel = file.webkitRelativePath ?? "";
  if (rel === "") return file.name;
  const segs = rel.split("/").filter((s) => s !== "" && s !== ".");
  if (segs[0] === root) segs.shift();
  return segs.join("/");
}

/** The picked folder's name: the first segment of the first entry's relative path. */
export function rootNameOf(files: ArrayLike<{ webkitRelativePath?: string }>): string {
  const first = files.length > 0 ? files[0] : undefined;
  const segs = (first?.webkitRelativePath ?? "").split("/").filter((s) => s !== "");
  return segs.length > 1 ? (segs[0] as string) : "repository";
}

/**
 * Walks what the input handed over and builds the payload for the worker, counting as it goes.
 * Reads no file contents. Rejects with `SnapshotTooLargeError` above the entry limit.
 */
export async function collectSnapshot(
  files: ArrayLike<SnapshotInputFile>,
  opts: {
    onProgress?: (p: SnapshotProgress) => void;
    limit?: number;
    now?: () => number;
  } = {},
): Promise<FileSnapshot> {
  const limit = opts.limit ?? SNAPSHOT_ENTRY_LIMIT;
  const total = files.length;
  const name = rootNameOf(files);
  const entries: SnapshotEntry[] = [];
  let bytes = 0;
  for (let i = 0; i < total; i++) {
    const file = files[i];
    if (!file) continue;
    if (entries.length >= limit) throw new SnapshotTooLargeError(total);
    const path = relativePathOf(file, name);
    if (path !== "") {
      entries.push({ path, file });
      bytes += file.size;
    }
    if ((i + 1) % CHUNK === 0) {
      opts.onProgress?.({ entries: entries.length, total, bytes });
      await breathe();
    }
  }
  opts.onProgress?.({ entries: entries.length, total, bytes });
  return {
    __diffgitFileSnapshot: true,
    kind: "directory",
    name,
    entries,
    readAt: (opts.now ?? Date.now)(),
  };
}

/**
 * The palette's way in: there is no picker to call, so a detached `webkitdirectory` input is created,
 * clicked and dropped again. Resolves with null when the dialog is dismissed — which fires no event
 * in most browsers, so the promise simply stays pending until the window is focused again.
 */
export function promptForRepositoryFiles(): Promise<SnapshotInputFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = "none";
    let settled = false;
    const done = (value: SnapshotInputFile[] | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener("change", () => {
      done(input.files ? Array.from(input.files) : null);
    });
    input.addEventListener("cancel", () => done(null));
    document.body.append(input);
    input.click();
  });
}
