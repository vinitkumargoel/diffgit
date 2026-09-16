/**
 * Wraps a `DirHandleLike` tree so tests can count every call per method and prove that nothing
 * write-capable is ever reachable: the wrapper exposes only the read methods of the interface,
 * so none of the browser handle mutators (entry removal, writable streams, create options) exist.
 */
import type { DirHandleLike, FileHandleLike, FileLike } from "../engine/fs/dirHandleLike";

export interface SpyCounts {
  getDirectoryHandle: number;
  getFileHandle: number;
  entries: number;
  getFile: number;
  arrayBuffer: number;
  stream: number;
  /** Any call to `getFileHandle`/`getDirectoryHandle` that passed a second argument (e.g. {create:true}). */
  optionsPassed: number;
  /** Property accesses on the wrapper that are not part of the read interface. */
  unknownAccess: string[];
}

export function newCounts(): SpyCounts {
  return {
    getDirectoryHandle: 0,
    getFileHandle: 0,
    entries: 0,
    getFile: 0,
    arrayBuffer: 0,
    stream: 0,
    optionsPassed: 0,
    unknownAccess: [],
  };
}

const READ_KEYS = new Set([
  "kind",
  "name",
  "getDirectoryHandle",
  "getFileHandle",
  "entries",
  "getFile",
  "then",
]);

function wrapFile(h: FileHandleLike, counts: SpyCounts): FileHandleLike {
  const wrapped: FileHandleLike = {
    kind: "file",
    name: h.name,
    async getFile(): Promise<FileLike> {
      counts.getFile++;
      const f = await h.getFile();
      return {
        size: f.size,
        lastModified: f.lastModified,
        arrayBuffer: () => {
          counts.arrayBuffer++;
          return f.arrayBuffer();
        },
        stream: () => {
          counts.stream++;
          return f.stream();
        },
      };
    },
  };
  return guard(wrapped, counts);
}

function guard<T extends object>(obj: T, counts: SpyCounts): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !READ_KEYS.has(prop) && !(prop in target)) {
        counts.unknownAccess.push(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function spyHandle(
  root: DirHandleLike,
  counts: SpyCounts = newCounts(),
): DirHandleLike & { counts: SpyCounts } {
  function wrapDir(h: DirHandleLike): DirHandleLike {
    const wrapped: DirHandleLike = {
      kind: "directory",
      name: h.name,
      async getDirectoryHandle(name: string, ...rest: unknown[]) {
        counts.getDirectoryHandle++;
        if (rest.length > 0) counts.optionsPassed++;
        return wrapDir(await h.getDirectoryHandle(name));
      },
      async getFileHandle(name: string, ...rest: unknown[]) {
        counts.getFileHandle++;
        if (rest.length > 0) counts.optionsPassed++;
        return wrapFile(await h.getFileHandle(name), counts);
      },
      async *entries() {
        counts.entries++;
        for await (const [name, child] of h.entries()) {
          yield [name, child.kind === "directory" ? wrapDir(child) : wrapFile(child, counts)] as [
            string,
            DirHandleLike | FileHandleLike,
          ];
        }
      },
    };
    return guard(wrapped, counts);
  }
  const wrappedRoot = wrapDir(root);
  return Object.assign(wrappedRoot, { counts });
}
