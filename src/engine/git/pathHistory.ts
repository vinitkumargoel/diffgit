/**
 * Path history with rename follow (T10.6; atlas tab 02, Design §14.1 `Diff | Blame | History`).
 *
 * This is `git log --follow -- <path>`: walk first-parent from `ref` and keep the commits where the
 * blob at the path differs from the one the first parent had. git's own `--follow` is first-parent
 * by construction (`diff_tree` against one parent, `try_to_follow_renames` on it), and the default
 * simplification already collapses a merge that is TREESAME to its mainline, so the two agree on
 * every history git itself writes — `fixtures/history/expected/log-path-*.txt` assert it oid for oid.
 *
 * When the path is absent in the parent and `follow` is on, the rename detector from `diff/renames.ts`
 * (the one already tested against `git diff -M`) runs between the two trees restricted to the paths
 * that vanished from the parent and the one path we are looking for. If it pairs them, the walk
 * continues on the old name and the entry records the hop in `renamedFrom`.
 *
 * `blame.ts` consumes this list: each entry's content is the whole "revision" of the file, because
 * every commit in between left the blob untouched.
 */
import { detectRenames } from "../diff/renames";
import { computeStats, HUGE_FILE_BYTES } from "../diff/textDiff";
import type { FileDiff, FileStatus, Oid, PathHistoryEntry } from "../types";
import { throwIfAborted } from "../util/concurrency";
import type { FlatTree, ObjectDb } from "./objectDb";
import { toSignature } from "./tags";
import { type CommitReader, subjectOf } from "./walk";

/** Plan D11: file history is paged like the commit list, never unbounded. */
export const MAX_PATH_HISTORY = 10_000;

export interface PathHistoryOptions {
  follow: boolean;
  limit: number;
  cursor?: string;
}

export interface PathHistoryDeps {
  db: ObjectDb;
  reader: CommitReader;
  /** git's `diff.renameLimit`, forwarded to the rename detector for the follow step. */
  renameLimit?: number;
  signal?: AbortSignal;
}

export interface PathHistoryResult {
  entries: PathHistoryEntry[];
  cursor: string | null;
}

/** Where the next page resumes: a commit **and** the name the file had at it. */
interface CursorState {
  v: 1;
  key: string;
  oid: Oid;
  path: string;
}

function encodeCursor(state: CursorState): string {
  return JSON.stringify(state);
}

function decodeCursor(text: string, key: string): CursorState | null {
  try {
    const parsed = JSON.parse(text) as CursorState;
    if (parsed.v !== 1 || parsed.key !== key || typeof parsed.oid !== "string") return null;
    return parsed;
  } catch {
    return null; // a cursor from another request or another build: start from the top
  }
}

const modeType = (mode: number | null): number | null => (mode === null ? null : mode & 0o170000);

/** The `{oid, mode}` of `path` in a commit's tree, or null when the path is not there. */
async function entryAt(
  db: ObjectDb,
  commit: Oid,
  path: string,
): Promise<{ oid: Oid; mode: number } | null> {
  const tree = await db.flattenTree(commit);
  return tree[path] ?? null;
}

/** Bytes of a blob, or null for a gitlink / a blob over the 10 MB gate (§6.7). */
async function blobBytes(
  db: ObjectDb,
  entry: { oid: Oid; mode: number } | null,
): Promise<Uint8Array | null> {
  if (!entry || modeType(entry.mode) !== 0o100000) return null;
  const bytes = await db.readBlob(entry.oid);
  return bytes.byteLength > HUGE_FILE_BYTES ? null : bytes;
}

/**
 * The name `path` had at `parent`, when this commit renamed it there. Only the one path we are
 * following is offered as the "added" side, and only the paths the commit removed as candidates for
 * the "deleted" side, so a follow step costs one similarity pass over the files that actually
 * vanished — not over the whole tree (atlas tab 02 "Risks": rename follow near the 50 % threshold).
 */
async function renameSource(
  deps: PathHistoryDeps,
  parentTree: FlatTree,
  childTree: FlatTree,
  path: string,
): Promise<{ oldPath: string; oldOid: Oid; oldMode: number } | null> {
  const added = childTree[path];
  if (!added) return null;
  const rows: FileDiff[] = [
    {
      id: path,
      oldPath: null,
      newPath: path,
      status: "added",
      layers: ["committed"],
      oldOid: null,
      newOid: added.oid,
      oldMode: null,
      newMode: added.mode,
      binary: false,
      image: false,
      oldSize: 0,
      newSize: 0,
      stats: null,
      tooLarge: false,
    },
  ];
  for (const [p, e] of Object.entries(parentTree)) {
    if (childTree[p]) continue;
    rows.push({
      id: p,
      oldPath: p,
      newPath: null,
      status: "deleted",
      layers: ["committed"],
      oldOid: e.oid,
      newOid: null,
      oldMode: e.mode,
      newMode: null,
      binary: false,
      image: false,
      oldSize: 0,
      newSize: 0,
      stats: null,
      tooLarge: false,
    });
  }
  if (rows.length === 1) return null;

  // The similarity pass needs real sizes; filling them costs one blob read per candidate, which is
  // the price of the pass anyway (`load` is called for exactly the same blobs).
  const bytes = new Map<string, Uint8Array>();
  for (const row of rows) {
    throwIfAborted(deps.signal, "rename follow");
    const side = row.status === "added" ? "new" : "old";
    const oid = (side === "new" ? row.newOid : row.oldOid) as Oid;
    const b = await deps.db.readBlob(oid);
    bytes.set(`${side}:${(side === "new" ? row.newPath : row.oldPath) as string}`, b);
    if (side === "new") row.newSize = b.byteLength;
    else row.oldSize = b.byteLength;
  }
  const out = await detectRenames(
    rows,
    async (f, side) =>
      bytes.get(`${side}:${(side === "old" ? f.oldPath : f.newPath) as string}`) ??
      new Uint8Array(),
    {
      ...(deps.renameLimit !== undefined ? { limit: deps.renameLimit } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  );
  const pair = out.files.find((f) => f.status === "renamed" && f.newPath === path);
  if (!pair?.oldPath || pair.oldOid === null || pair.oldMode === null) return null;
  return { oldPath: pair.oldPath, oldOid: pair.oldOid, oldMode: pair.oldMode };
}

/**
 * The commits that changed `path`, newest first, starting at `startOid`.
 *
 * `limit` bounds the page; `cursor` continues where the previous page stopped, carrying the name the
 * file had there so a page boundary can fall in the middle of a rename chain.
 */
export async function pathHistory(
  deps: PathHistoryDeps,
  startOid: Oid,
  path: string,
  opts: PathHistoryOptions,
): Promise<PathHistoryResult> {
  const { db } = deps;
  const limit = Math.max(1, Math.min(opts.limit, MAX_PATH_HISTORY));
  const key = JSON.stringify([startOid, path, opts.follow === true]);
  const restored = opts.cursor ? decodeCursor(opts.cursor, key) : null;

  let current: Oid | null = restored?.oid ?? startOid;
  let currentPath = restored?.path ?? path;
  const entries: PathHistoryEntry[] = [];

  while (current !== null && entries.length < limit) {
    throwIfAborted(deps.signal, "path history");
    const oid: Oid = current;
    const meta = await deps.reader.meta(oid);
    const parent = meta.parents[0] ?? null;
    const childTree = await db.flattenTree(oid);
    const mine = childTree[currentPath] ?? null;
    const theirs = parent === null ? null : await entryAt(db, parent, currentPath);

    if (mine === null && theirs === null) {
      current = parent; // the path does not exist on this stretch of history yet
      continue;
    }
    if (mine !== null && theirs !== null && mine.oid === theirs.oid && mine.mode === theirs.mode) {
      current = parent; // TREESAME: git does not show this commit for this path
      continue;
    }

    let renamedFrom: string | null = null;
    let older: { oid: Oid; mode: number } | null = theirs;
    if (theirs === null && parent !== null && opts.follow && mine !== null) {
      const found = await renameSource(deps, await db.flattenTree(parent), childTree, currentPath);
      if (found) {
        renamedFrom = found.oldPath;
        older = { oid: found.oldOid, mode: found.oldMode };
      }
    }

    const status: FileStatus =
      renamedFrom !== null
        ? "renamed"
        : mine === null
          ? "deleted"
          : older === null
            ? "added"
            : modeType(older.mode) !== modeType(mine.mode)
              ? "typechange"
              : "modified";

    // A reindent that changes nothing under `-w` must not steal the blame (atlas tab 02 "Risks").
    let whitespaceOnly = false;
    if (mine !== null && older !== null) {
      const contents = {
        old: await blobBytes(db, older),
        new: await blobBytes(db, mine),
      };
      if (contents.old && contents.new) {
        const stats = computeStats(contents, { ignoreWhitespace: true });
        whitespaceOnly = stats !== null && stats.additions === 0 && stats.deletions === 0;
      }
    }

    const commit = await db.readCommit(oid);
    entries.push({
      oid,
      subject: subjectOf(commit.message),
      author: toSignature(commit.author),
      path: currentPath,
      renamedFrom,
      whitespaceOnly,
      status,
    });
    if (renamedFrom !== null) currentPath = renamedFrom;
    current = parent;
  }

  return {
    entries,
    cursor: current === null ? null : encodeCursor({ v: 1, key, oid: current, path: currentPath }),
  };
}
