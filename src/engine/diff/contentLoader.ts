/**
 * Loads both sides of a FileDiff using the DiffEngine's side table (T3.4).
 * tree/index sides → `db.readBlob(oid)`; worktree/untracked sides → the working-tree file.
 * Gitlinks (mode 160000) have no bytes: `kind: "submodule"` carries the two commit oids instead.
 */
import type { FsaFs } from "../fs/fsaFs";
import type { ObjectDb } from "../git/objectDb";
import { type FileContents, type FileDiff, MODE_GITLINK } from "../types";
import { throwIfAborted } from "../util/concurrency";
import type { FileSides } from "./diffEngine";

export interface ContentSources {
  db: ObjectDb;
  fs: FsaFs;
}

export interface LoadedSides extends FileContents {
  kind: "file" | "submodule";
  submodule?: { oldOid: string | null; newOid: string | null };
}

const isGitlink = (mode: number | null) => mode !== null && (mode & 0o170000) === MODE_GITLINK;

function sidesFor(
  file: FileDiff,
  sides: Record<string, FileSides>,
): { old: FileSides["old"]; new: FileSides["new"] } {
  const oldEntry = file.oldPath ? sides[file.oldPath] : undefined;
  const newEntry = file.newPath ? sides[file.newPath] : undefined;
  return { old: oldEntry?.old ?? null, new: newEntry?.new ?? null };
}

export async function loadSide(
  file: FileDiff,
  side: "old" | "new",
  sides: Record<string, FileSides>,
  src: ContentSources,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  throwIfAborted(signal, "content load");
  const s = sidesFor(file, sides);
  if (side === "old") {
    if (!s.old || isGitlink(s.old.mode)) return null;
    return src.db.readBlob(s.old.oid);
  }
  if (!s.new || isGitlink(s.new.mode)) return null;
  if (s.new.kind === "tree" || s.new.kind === "index") {
    if (!s.new.oid) return null;
    return src.db.readBlob(s.new.oid);
  }
  return src.fs.readFile(`/${file.newPath as string}`);
}

export async function loadSides(
  file: FileDiff,
  sides: Record<string, FileSides>,
  src: ContentSources,
  signal?: AbortSignal,
): Promise<LoadedSides> {
  if (isGitlink(file.oldMode) || isGitlink(file.newMode)) {
    return {
      old: null,
      new: null,
      kind: "submodule",
      submodule: { oldOid: file.oldOid, newOid: file.newOid },
    };
  }
  const [oldBytes, newBytes] = await Promise.all([
    loadSide(file, "old", sides, src, signal),
    loadSide(file, "new", sides, src, signal),
  ]);
  return { old: oldBytes, new: newBytes, kind: "file" };
}
