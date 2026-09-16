/**
 * In-memory `DirHandleLike` (T0.4) used by E2E (rehydrated in the worker from a snapshot) and by
 * unit tests that need to mutate a tree between reads (torn index, pack swap, folder deleted).
 *
 * Pure engine code: no Node imports. `src/test/memorySnapshot.ts` builds snapshots from disk.
 */
import {
  type DirHandleLike,
  type FileHandleLike,
  type FileLike,
  handleError,
} from "./dirHandleLike";

/** Cloneable, JSON-able description of a whole tree. Bytes are base64. */
export interface MemorySnapshot {
  id: string;
  name: string;
  dirs: string[]; // every directory path (incl. empty ones), POSIX, no leading/trailing slash
  files: Record<string, { b64: string; mtime: number }>;
}

/** Marker the E2E picker shim resolves to; structured-cloneable so it survives postMessage/IndexedDB. */
export interface MemoryHandleMarker {
  __diffgoelMemoryHandle: true;
  kind: "directory";
  snapshotId: string;
  name: string;
}

export function isMemoryHandleMarker(v: unknown): v is MemoryHandleMarker {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __diffgoelMemoryHandle?: unknown }).__diffgoelMemoryHandle === true &&
    typeof (v as { snapshotId?: unknown }).snapshotId === "string"
  );
}

export type Mutation =
  | { op: "write"; path: string; text?: string; b64?: string; mtime?: number }
  | { op: "remove"; path: string }
  | { op: "touch"; path: string; mtime?: number }
  | { op: "rename"; from: string; to: string }
  | { op: "mkdir"; path: string }
  | { op: "dropRoot" };

interface MemFile {
  kind: "file";
  bytes: Uint8Array;
  mtime: number;
}
interface MemDir {
  kind: "dir";
  children: Map<string, MemNode>;
}
type MemNode = MemFile | MemDir;

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function normalise(path: string): string[] {
  return path.split("/").filter((seg) => seg !== "" && seg !== ".");
}

export class MemoryFs {
  readonly root: MemDir = { kind: "dir", children: new Map() };
  private dropped = false;
  private clock = 1_700_000_000_000;

  static fromSnapshot(snap: MemorySnapshot): MemoryFs {
    const fs = new MemoryFs();
    for (const d of snap.dirs) fs.mkdir(d);
    for (const [p, f] of Object.entries(snap.files)) fs.write(p, base64ToBytes(f.b64), f.mtime);
    return fs;
  }

  static fromEntries(entries: Record<string, Uint8Array | string>, mtime?: number): MemoryFs {
    const fs = new MemoryFs();
    for (const [p, v] of Object.entries(entries)) fs.write(p, v, mtime);
    return fs;
  }

  toSnapshot(id: string, name: string): MemorySnapshot {
    const dirs: string[] = [];
    const files: MemorySnapshot["files"] = {};
    const walk = (dir: MemDir, prefix: string) => {
      for (const [n, node] of dir.children) {
        const p = prefix ? `${prefix}/${n}` : n;
        if (node.kind === "dir") {
          dirs.push(p);
          walk(node, p);
        } else files[p] = { b64: bytesToBase64(node.bytes), mtime: node.mtime };
      }
    };
    walk(this.root, "");
    return { id, name, dirs, files };
  }

  /** Simulates the folder disappearing: every handle operation throws NotFoundError from now on. */
  dropRoot(): void {
    this.dropped = true;
  }
  get isDropped(): boolean {
    return this.dropped;
  }

  private nextMtime(): number {
    this.clock += 1000;
    return this.clock;
  }

  lookup(path: string): MemNode | null {
    let node: MemNode = this.root;
    for (const seg of normalise(path)) {
      if (node.kind !== "dir") return null;
      const next = node.children.get(seg);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  mkdir(path: string): MemDir {
    let node: MemDir = this.root;
    for (const seg of normalise(path)) {
      let next = node.children.get(seg);
      if (!next) {
        next = { kind: "dir", children: new Map() };
        node.children.set(seg, next);
      }
      if (next.kind !== "dir") throw new Error(`not a directory: ${path}`);
      node = next;
    }
    return node;
  }

  write(path: string, content: Uint8Array | string, mtime?: number): void {
    const segs = normalise(path);
    const name = segs.pop();
    if (!name) throw new Error("cannot write the root");
    const dir = this.mkdir(segs.join("/"));
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    dir.children.set(name, { kind: "file", bytes, mtime: mtime ?? this.nextMtime() });
  }

  remove(path: string): boolean {
    const segs = normalise(path);
    const name = segs.pop();
    if (!name) throw new Error("cannot remove the root");
    const parent = this.lookup(segs.join("/"));
    if (parent?.kind !== "dir") return false;
    return parent.children.delete(name);
  }

  touch(path: string, mtime?: number): void {
    const node = this.lookup(path);
    if (node?.kind !== "file") throw new Error(`no such file: ${path}`);
    node.mtime = mtime ?? this.nextMtime();
  }

  rename(from: string, to: string): void {
    const node = this.lookup(from);
    if (!node) throw new Error(`no such entry: ${from}`);
    this.remove(from);
    const segs = normalise(to);
    const name = segs.pop();
    if (!name) throw new Error("cannot rename onto the root");
    this.mkdir(segs.join("/")).children.set(name, node);
  }

  readBytes(path: string): Uint8Array | null {
    const node = this.lookup(path);
    return node && node.kind === "file" ? node.bytes : null;
  }

  apply(mutations: Mutation[]): void {
    for (const m of mutations) {
      switch (m.op) {
        case "write":
          this.write(m.path, m.b64 !== undefined ? base64ToBytes(m.b64) : (m.text ?? ""), m.mtime);
          break;
        case "remove":
          this.remove(m.path);
          break;
        case "touch":
          this.touch(m.path, m.mtime);
          break;
        case "rename":
          this.rename(m.from, m.to);
          break;
        case "mkdir":
          this.mkdir(m.path);
          break;
        case "dropRoot":
          this.dropRoot();
          break;
      }
    }
  }

  handle(name = "memory-root"): MemoryDirHandle {
    return new MemoryDirHandle(this, "", name);
  }
}

class MemoryFileHandle implements FileHandleLike {
  readonly kind = "file" as const;
  constructor(
    private readonly fs: MemoryFs,
    readonly path: string,
    readonly name: string,
  ) {}

  async getFile(): Promise<FileLike> {
    if (this.fs.isDropped) throw handleError("NotFoundError", "root handle is gone");
    const node = this.fs.lookup(this.path);
    if (!node) throw handleError("NotFoundError", `file not found: ${this.path}`);
    if (node.kind !== "file")
      throw handleError("TypeMismatchError", `is a directory: ${this.path}`);
    const bytes = node.bytes;
    return {
      size: bytes.byteLength,
      lastModified: node.mtime,
      async arrayBuffer() {
        return bytes.slice().buffer as ArrayBuffer;
      },
      stream() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            const CHUNK = 1 << 16;
            for (let i = 0; i < bytes.length; i += CHUNK)
              controller.enqueue(bytes.slice(i, i + CHUNK));
            controller.close();
          },
        });
      },
    };
  }
}

class MemoryDirHandle implements DirHandleLike {
  readonly kind = "directory" as const;
  constructor(
    private readonly fs: MemoryFs,
    readonly path: string,
    readonly name: string,
  ) {}

  private dir(): MemDir {
    if (this.fs.isDropped) throw handleError("NotFoundError", "root handle is gone");
    const node = this.path === "" ? this.fs.root : this.fs.lookup(this.path);
    if (!node) throw handleError("NotFoundError", `directory not found: ${this.path}`);
    if (node.kind !== "dir")
      throw handleError("TypeMismatchError", `not a directory: ${this.path}`);
    return node;
  }

  private child(name: string): MemNode {
    if (name === "" || name === "." || name === ".." || name.includes("/")) {
      throw new TypeError(`invalid entry name: ${JSON.stringify(name)}`);
    }
    const node = this.dir().children.get(name);
    if (!node) throw handleError("NotFoundError", `not found: ${this.join(name)}`);
    return node;
  }

  private join(name: string): string {
    return this.path === "" ? name : `${this.path}/${name}`;
  }

  async getDirectoryHandle(name: string): Promise<DirHandleLike> {
    const node = this.child(name);
    if (node.kind !== "dir")
      throw handleError("TypeMismatchError", `not a directory: ${this.join(name)}`);
    return new MemoryDirHandle(this.fs, this.join(name), name);
  }

  async getFileHandle(name: string): Promise<FileHandleLike> {
    const node = this.child(name);
    if (node.kind !== "file")
      throw handleError("TypeMismatchError", `is a directory: ${this.join(name)}`);
    return new MemoryFileHandle(this.fs, this.join(name), name);
  }

  async *entries(): AsyncIterable<[string, DirHandleLike | FileHandleLike]> {
    const dir = this.dir();
    for (const name of [...dir.children.keys()].sort()) {
      const node = dir.children.get(name);
      if (!node) continue;
      yield [
        name,
        node.kind === "dir"
          ? new MemoryDirHandle(this.fs, this.join(name), name)
          : new MemoryFileHandle(this.fs, this.join(name), name),
      ];
    }
  }
}
