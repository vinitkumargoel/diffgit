/**
 * A `DirHandleLike` over the `File` objects an `<input type="file" webkitdirectory>` hands the page
 * (T11.15, Design §14.6, atlas tab 18): Firefox and Safari have no `showDirectoryPicker()`, so the
 * only way to read a repository there is the one-shot file list — "snapshot mode".
 *
 * The payload is structured-cloneable (`File` is; a handle object is not), so the UI posts it to the
 * worker exactly like a real `FileSystemDirectoryHandle` and `resolveHandle` turns it into this tree.
 * Building the tree costs no reads: every node holds the `FileLike` the browser already made, and
 * `arrayBuffer()` / `stream()` only run when the engine asks for that one file. Nothing outside
 * `.git` is read unless the diff needs it.
 *
 * Pure engine code: `File` is used structurally as `FileLike`, no DOM types are imported.
 */
import {
  type DirHandleLike,
  type FileHandleLike,
  type FileLike,
  handleError,
} from "./dirHandleLike";

/** One file of the picked folder, with its path relative to the repository root (POSIX). */
export interface SnapshotEntry {
  path: string;
  file: FileLike;
}

/** What the UI posts to the worker in place of a directory handle. Structured-cloneable. */
export interface FileSnapshot {
  __diffgitFileSnapshot: true;
  kind: "directory";
  /** The picked folder's name — `RepoInfo.name`. */
  name: string;
  entries: SnapshotEntry[];
  /** When the browser handed the list over (epoch ms); the StatsRow tag's "read at". */
  readAt: number;
}

export function isFileSnapshot(v: unknown): v is FileSnapshot {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __diffgitFileSnapshot?: unknown }).__diffgitFileSnapshot === true &&
    Array.isArray((v as { entries?: unknown }).entries)
  );
}

interface SnapNode {
  dirs: Map<string, SnapNode>;
  files: Map<string, FileLike>;
}

function emptyNode(): SnapNode {
  return { dirs: new Map(), files: new Map() };
}

/** Lays the flat list out as directories; no byte is touched. */
function buildTree(entries: readonly SnapshotEntry[]): SnapNode {
  const root = emptyNode();
  for (const entry of entries) {
    const segs = entry.path.split("/").filter((s) => s !== "" && s !== ".");
    const name = segs.pop();
    if (name === undefined) continue;
    let node = root;
    for (const seg of segs) {
      let next = node.dirs.get(seg);
      if (!next) {
        next = emptyNode();
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.set(name, entry.file);
  }
  return root;
}

class SnapshotFileHandle implements FileHandleLike {
  readonly kind = "file" as const;
  constructor(
    readonly name: string,
    private readonly file: FileLike,
  ) {}

  async getFile(): Promise<FileLike> {
    return this.file;
  }
}

class SnapshotDirHandle implements DirHandleLike {
  readonly kind = "directory" as const;
  constructor(
    readonly name: string,
    private readonly node: SnapNode,
    private readonly path: string,
  ) {}

  private join(name: string): string {
    return this.path === "" ? name : `${this.path}/${name}`;
  }

  private check(name: string): void {
    if (name === "" || name === "." || name === ".." || name.includes("/")) {
      throw new TypeError(`invalid entry name: ${JSON.stringify(name)}`);
    }
  }

  async getDirectoryHandle(name: string): Promise<DirHandleLike> {
    this.check(name);
    const dir = this.node.dirs.get(name);
    if (!dir) {
      if (this.node.files.has(name))
        throw handleError("TypeMismatchError", `not a directory: ${this.join(name)}`);
      throw handleError("NotFoundError", `not found: ${this.join(name)}`);
    }
    return new SnapshotDirHandle(name, dir, this.join(name));
  }

  async getFileHandle(name: string): Promise<FileHandleLike> {
    this.check(name);
    const file = this.node.files.get(name);
    if (!file) {
      if (this.node.dirs.has(name))
        throw handleError("TypeMismatchError", `is a directory: ${this.join(name)}`);
      throw handleError("NotFoundError", `not found: ${this.join(name)}`);
    }
    return new SnapshotFileHandle(name, file);
  }

  async *entries(): AsyncIterable<[string, DirHandleLike | FileHandleLike]> {
    for (const name of [...this.node.dirs.keys()].sort()) {
      const dir = this.node.dirs.get(name);
      if (dir) yield [name, new SnapshotDirHandle(name, dir, this.join(name))];
    }
    for (const name of [...this.node.files.keys()].sort()) {
      const file = this.node.files.get(name);
      if (file) yield [name, new SnapshotFileHandle(name, file)];
    }
  }
}

/** The read-once root handle. Building it reads no bytes. */
export function fileSnapshotHandle(snapshot: FileSnapshot): DirHandleLike {
  return new SnapshotDirHandle(snapshot.name, buildTree(snapshot.entries), "");
}
