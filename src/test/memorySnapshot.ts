/**
 * Node-side helpers for `MemoryDirHandle` (T0.4): load a fixture directory into a snapshot and
 * serialise it for Playwright's `addInitScript`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { bytesToBase64, MemoryFs, type MemorySnapshot } from "../engine/fs/memoryDirHandle";

export interface SnapshotOptions {
  /** Skip paths (POSIX, repo-relative) for which this returns true. */
  exclude?: (path: string) => boolean;
}

/** Walks `dir` (following symlinks like Chrome; dangling links skipped) into a snapshot. */
export async function snapshotFromDisk(
  dir: string,
  id: string,
  name = dir
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? "repo",
  opts: SnapshotOptions = {},
): Promise<MemorySnapshot> {
  const dirs: string[] = [];
  const files: MemorySnapshot["files"] = {};
  async function walk(abs: string, rel: string) {
    for (const entry of (await readdir(abs)).sort()) {
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (opts.exclude?.(relPath)) continue;
      const absPath = join(abs, entry);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(absPath);
      } catch {
        continue; // dangling symlink: invisible to FSA
      }
      if (s.isDirectory()) {
        dirs.push(relPath);
        await walk(absPath, relPath);
      } else if (s.isFile()) {
        files[relPath] = {
          b64: bytesToBase64(new Uint8Array(await readFile(absPath))),
          mtime: Math.floor(s.mtimeMs),
        };
      }
    }
  }
  await walk(dir, "");
  return { id, name, dirs, files };
}

/** JS source that registers the snapshot on `globalThis.__diffgoelSnapshots[id]` (for addInitScript). */
export function toInitScript(snapshot: MemorySnapshot): string {
  const json = JSON.stringify(snapshot).replace(/<\/script/gi, "<\\/script");
  return `(function(){var g=globalThis;g.__diffgoelSnapshots=g.__diffgoelSnapshots||{};g.__diffgoelSnapshots[${JSON.stringify(snapshot.id)}]=${json};})();`;
}

/** Parses the output of `toInitScript` back into a snapshot (round-trip tests). */
export function fromInitScript(script: string): MemorySnapshot {
  const g: { __diffgoelSnapshots?: Record<string, MemorySnapshot> } = {};
  new Function("globalThis", script)(g);
  const snaps = g.__diffgoelSnapshots ?? {};
  const first = Object.values(snaps)[0];
  if (!first) throw new Error("init script registered no snapshot");
  return first;
}

/** Convenience: fixture directory → live in-memory fs. */
export async function memoryFsFromDisk(dir: string, opts?: SnapshotOptions): Promise<MemoryFs> {
  return MemoryFs.fromSnapshot(await snapshotFromDisk(dir, "tmp", undefined, opts));
}
