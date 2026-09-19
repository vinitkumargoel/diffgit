/**
 * Stash listing (T10.1, docs/v2-contracts.md; atlas tab "Compare anything").
 *
 * The stash stack is a reflog: `.git/logs/refs/stash`, oldest line first. `stash@{0}` is therefore
 * the **last** line. Each entry is an ordinary commit whose
 *   - first parent is HEAD when the stash was made (`baseOid`),
 *   - second parent is a commit of the index at that moment (`indexOid`),
 *   - third parent, present only for `git stash -u`, holds the untracked files (`untrackedOid`),
 *   - own tree is the working-tree state of the tracked files.
 *
 * Parity target: `git stash list --format='%gd %H %s'` and `git rev-list --parents -n 1 stash@{n}`
 * (recorded per fixture in `expected/stash-list.txt` / `expected/stash-parents.txt` by T10.0).
 */

import { treeDiff } from "../diff/treeDiff";
import { EngineError, errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { Oid, StashInfo } from "../types";
import type { ObjectDb } from "./objectDb";

/** Path of the stash reflog, relative to `.git/`. */
export const STASH_LOG_PATH = "logs/refs/stash";

/** One parsed line of a reflog file. */
export interface StashLogEntry {
  index: number; // 0 = newest (last line)
  oid: Oid; // the "new" oid of the reflog line
  message: string; // the part after the tab
  timestamp: number; // epoch ms
}

const LINE_RE = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.*?) <([^>]*)> (\d+) ([+-]\d{4})\t(.*)$/;

/**
 * Parses `.git/logs/refs/stash` newest-first. Lines git cannot have written are skipped rather
 * than throwing: a half-written reflog must not break the picker.
 */
export function parseStashLog(text: string | null): StashLogEntry[] {
  if (text === null) return [];
  const lines = text.split("\n").filter((l) => l.length > 0);
  const out: StashLogEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = LINE_RE.exec(lines[i] as string);
    if (!m) continue;
    out.push({
      index: out.length,
      oid: m[2] as string,
      message: m[7] as string,
      timestamp: Number.parseInt(m[5] as string, 10) * 1000,
    });
  }
  return out;
}

/** The three commits a stash entry is built from. */
export interface StashCommits {
  baseOid: Oid;
  indexOid: Oid;
  untrackedOid: Oid | null;
}

/**
 * Reads the parents of a stash commit. Returns null when `oid` is not shaped like one (so callers
 * can fall back to an ordinary commit diff when a raw SHA is pasted).
 */
export async function readStashCommits(db: ObjectDb, oid: Oid): Promise<StashCommits | null> {
  const commit = await db.readCommit(oid);
  const [base, index, untracked] = commit.parents;
  if (base === undefined || index === undefined || commit.parents.length > 3) return null;
  const indexCommit = await db.readCommit(index);
  if (!indexCommit.message.startsWith("index on ")) return null;
  return { baseOid: base, indexOid: index, untrackedOid: untracked ?? null };
}

/** Every stash, newest first (`stash@{0}` is index 0). `files` is null until it is counted. */
export async function listStashes(fs: FsaFs, db: ObjectDb): Promise<StashInfo[]> {
  let text: string | null;
  try {
    text = await fs.readText(`.git/${STASH_LOG_PATH}`);
  } catch (e) {
    const code = errorCode(e);
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") throw e;
    return []; // no stash has ever been pushed in this repository
  }
  const out: StashInfo[] = [];
  for (const entry of parseStashLog(text)) {
    const commits = await readStashCommits(db, entry.oid);
    if (!commits) continue; // the reflog names something that is not a stash commit
    out.push({
      index: entry.index,
      expr: `stash@{${entry.index}}`,
      oid: entry.oid,
      message: entry.message,
      timestamp: entry.timestamp,
      baseOid: commits.baseOid,
      indexOid: commits.indexOid,
      untrackedOid: commits.untrackedOid,
      files: null,
    });
  }
  return out;
}

/**
 * How many files the stash touches: the tree diff of its base against the stashed working tree,
 * plus the untracked files it kept. Separate from `listStashes` because it costs two tree flattens
 * per stash; `StashInfo.files` stays null when it is not worth it (or when a read fails).
 */
export async function countStashFiles(db: ObjectDb, stash: StashInfo): Promise<number | null> {
  try {
    const base = await db.flattenTree(stash.baseOid);
    const tip = await db.flattenTree(stash.oid);
    let n = Object.keys(treeDiff(base, tip)).length;
    if (stash.untrackedOid !== null) {
      n += Object.keys(await db.flattenTree(stash.untrackedOid)).length;
    }
    return n;
  } catch (e) {
    if (e instanceof EngineError && e.code === "CANCELLED") throw e;
    return null; // a missing object must not fail the whole list; the UI shows no count
  }
}
