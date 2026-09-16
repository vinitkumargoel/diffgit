/**
 * `DirHandleLike` over the Node filesystem — test-only (imports `node:fs`), excluded from the
 * engine tsconfig. Mirrors Chrome's File System Access semantics:
 *  - symlinks are followed (`stat`, not `lstat`): FSA cannot see links, so a symlink to a file is a
 *    file whose bytes are the target's bytes; a dangling symlink is invisible in `entries()`.
 *  - `lastModified` is an integer millisecond value like `File.lastModified`.
 */
import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type DirHandleLike,
  type FileHandleLike,
  type FileLike,
  handleError,
} from "./dirHandleLike";

export class NodeFileHandle implements FileHandleLike {
  readonly kind = "file" as const;
  constructor(
    readonly name: string,
    readonly path: string,
  ) {}

  async getFile(): Promise<FileLike> {
    const s = await stat(this.path).catch((e: NodeJS.ErrnoException) => {
      throw e.code === "ENOENT" ? handleError("NotFoundError", `file not found: ${this.path}`) : e;
    });
    const path = this.path;
    return {
      size: s.size,
      lastModified: Math.floor(s.mtimeMs),
      async arrayBuffer() {
        const buf = await readFile(path);
        // Copy into a standalone ArrayBuffer (Node Buffers may share a larger pool).
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      },
      stream() {
        const nodeStream = Readable.toWeb(
          Readable.from(
            (async function* () {
              const fh = await open(path, "r");
              try {
                const chunk = new Uint8Array(1 << 16);
                for (;;) {
                  const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
                  if (bytesRead === 0) break;
                  yield chunk.slice(0, bytesRead);
                }
              } finally {
                await fh.close();
              }
            })(),
          ),
        );
        return nodeStream as unknown as ReadableStream<Uint8Array>;
      },
    };
  }
}

export class NodeDirHandle implements DirHandleLike {
  readonly kind = "directory" as const;
  constructor(
    readonly name: string,
    readonly path: string,
  ) {}

  /** Opens an existing directory path as the root handle. */
  static async open(path: string): Promise<NodeDirHandle> {
    const s = await stat(path).catch(() => {
      throw handleError("NotFoundError", `directory not found: ${path}`);
    });
    if (!s.isDirectory()) throw handleError("TypeMismatchError", `not a directory: ${path}`);
    const name =
      path
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? path;
    return new NodeDirHandle(name, path);
  }

  private async statChild(name: string) {
    if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new TypeError(`invalid entry name: ${JSON.stringify(name)}`);
    }
    const p = join(this.path, name);
    try {
      return { p, s: await stat(p) };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR")
        throw handleError("NotFoundError", `not found: ${p}`);
      if (code === "EACCES" || code === "EPERM")
        throw handleError("NotAllowedError", `not allowed: ${p}`);
      throw e;
    }
  }

  async getDirectoryHandle(name: string): Promise<DirHandleLike> {
    const { p, s } = await this.statChild(name);
    if (!s.isDirectory()) throw handleError("TypeMismatchError", `not a directory: ${p}`);
    return new NodeDirHandle(name, p);
  }

  async getFileHandle(name: string): Promise<FileHandleLike> {
    const { p, s } = await this.statChild(name);
    if (s.isDirectory()) throw handleError("TypeMismatchError", `is a directory: ${p}`);
    return new NodeFileHandle(name, p);
  }

  async *entries(): AsyncIterable<[string, DirHandleLike | FileHandleLike]> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(this.path, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw handleError("NotFoundError", `not found: ${this.path}`);
      throw e;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      const p = join(this.path, d.name);
      let isDir = d.isDirectory();
      let isFile = d.isFile();
      if (d.isSymbolicLink()) {
        // follow symlinks like FSA would; dangling links are invisible
        try {
          const s = await stat(p);
          isDir = s.isDirectory();
          isFile = s.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) yield [d.name, new NodeDirHandle(d.name, p)];
      else if (isFile) yield [d.name, new NodeFileHandle(d.name, p)];
    }
  }
}
