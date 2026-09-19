/**
 * Per-commit payloads (T10.5, Design §14.5): the CommitCard's `commitDetails` and the `+n −m` the
 * history rows show, `commitStats`.
 *
 * Both are the commit's tree against its **first parent** — a root commit against git's empty tree,
 * a merge against its mainline, which is what `git show --numstat --first-parent` prints and what
 * the "per commit" stack view (atlas tab 04) needs. Rename detection is the one already tested
 * against git in `diff/renames.ts`, so a `git mv` counts as one changed file with the numbers git
 * reports, not as an add plus a delete.
 */
import { detectRenames } from "../diff/renames";
import { computeStats, HUGE_FILE_BYTES } from "../diff/textDiff";
import { treeDiff } from "../diff/treeDiff";
import { EngineError } from "../errors";
import {
  type CommitDetails,
  type CommitSummary,
  type FileDiff,
  MODE_GITLINK,
  type Oid,
} from "../types";
import { throwIfAborted } from "../util/concurrency";
import type { FlatTree, ObjectDb } from "./objectDb";
import { toSignature } from "./tags";
import { bodyOf, type CommitReader, subjectOf } from "./walk";

export type CommitStats = CommitDetails["stats"];

/** Commits per batch (docs/v2-contracts.md: "batched 16 at a time"). */
export const COMMIT_STATS_BATCH = 16;

export interface CommitStatsDeps {
  db: ObjectDb;
  reader: CommitReader;
  /** The session's background-stats concurrency limiter. */
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  /** `diff.renames` / `diff.renameLimit` from the repository's config. */
  renames?: boolean;
  renameLimit?: number;
  signal?: AbortSignal;
}

/**
 * `{ files, additions, deletions }` per commit, against the first parent. A commit whose objects
 * cannot be read answers `null` rather than failing the batch — one unreadable commit must not
 * blank a whole page of rows (the same rule `fileStats` follows).
 */
export async function commitStats(
  deps: CommitStatsDeps,
  oids: Oid[],
): Promise<Record<Oid, CommitStats>> {
  const done = new Map<Oid, CommitStats>();
  for (let i = 0; i < oids.length; i += COMMIT_STATS_BATCH) {
    throwIfAborted(deps.signal, "commit stats");
    const batch = oids.slice(i, i + COMMIT_STATS_BATCH);
    await Promise.all(
      batch.map((oid) =>
        deps.limit(async () => {
          try {
            done.set(oid, await statsForCommit(deps, oid));
          } catch (e) {
            if (e instanceof EngineError && (e.code === "CANCELLED" || e.code === "STALE")) throw e;
            done.set(oid, null);
          }
        }),
      ),
    );
  }
  // Keyed in the caller's order, not the order the batch happened to finish in: the record is a
  // structured-cloneable result, and `bun run record` must be byte-stable (T10.7).
  const out: Record<Oid, CommitStats> = {};
  for (const oid of oids) {
    const stats = done.get(oid);
    if (stats !== undefined) out[oid] = stats;
  }
  return out;
}

async function statsForCommit(deps: CommitStatsDeps, oid: Oid): Promise<CommitStats> {
  const { db } = deps;
  const meta = await deps.reader.meta(oid);
  const parent = meta.parents[0];
  const before: FlatTree | null = parent === undefined ? null : await db.flattenTree(parent);
  const after = await db.flattenTree(oid);
  const changes = treeDiff(before, after);

  const contents = new Map<string, Uint8Array | null>();
  const rows: FileDiff[] = [];
  for (const [path, change] of Object.entries(changes)) {
    throwIfAborted(deps.signal, "commit stats");
    const oldBytes = await sideBytes(db, change.oldOid, change.oldMode, contents, `old:${path}`);
    const newBytes = await sideBytes(db, change.newOid, change.newMode, contents, `new:${path}`);
    rows.push({
      id: path,
      oldPath: change.oldOid === null ? null : path,
      newPath: change.newOid === null ? null : path,
      status: change.oldOid === null ? "added" : change.newOid === null ? "deleted" : "modified",
      layers: ["committed"],
      oldOid: change.oldOid,
      newOid: change.newOid,
      oldMode: change.oldMode,
      newMode: change.newMode,
      binary: false,
      image: false,
      oldSize: oldBytes?.byteLength ?? 0,
      newSize: newBytes?.byteLength ?? 0,
      stats: null,
      tooLarge: false,
    });
  }

  const paired =
    deps.renames === false
      ? rows
      : (
          await detectRenames(
            rows,
            async (f, side) =>
              contents.get(`${side}:${(side === "old" ? f.oldPath : f.newPath) as string}`) ??
              new Uint8Array(),
            {
              ...(deps.renameLimit !== undefined ? { limit: deps.renameLimit } : {}),
              ...(deps.signal ? { signal: deps.signal } : {}),
            },
          )
        ).files;

  let additions = 0;
  let deletions = 0;
  for (const row of paired) {
    const stats = computeStats(
      {
        old: row.oldPath === null ? null : (contents.get(`old:${row.oldPath}`) ?? null),
        new: row.newPath === null ? null : (contents.get(`new:${row.newPath}`) ?? null),
      },
      { ignoreWhitespace: false },
    );
    additions += stats?.additions ?? 0;
    deletions += stats?.deletions ?? 0;
  }
  return { files: paired.length, additions, deletions };
}

/**
 * Bytes of one side, memoised per path. A gitlink has no blob: git diffs the literal
 * `Subproject commit <oid>` line, and so do we. Anything over 10 MB is left out of the counts
 * rather than inflated (§6.7); git would count its lines, which is a divergence we accept for a
 * number that only decorates a row.
 */
async function sideBytes(
  db: ObjectDb,
  oid: Oid | null,
  mode: number | null,
  cache: Map<string, Uint8Array | null>,
  key: string,
): Promise<Uint8Array | null> {
  if (oid === null) {
    cache.set(key, null);
    return null;
  }
  if (mode === MODE_GITLINK) {
    const bytes = new TextEncoder().encode(`Subproject commit ${oid}\n`);
    cache.set(key, bytes);
    return bytes;
  }
  const bytes = await db.readBlob(oid);
  const kept = bytes.byteLength > HUGE_FILE_BYTES ? null : bytes;
  cache.set(key, kept);
  return kept;
}

export interface CommitDetailsDeps extends CommitStatsDeps {
  refsByCommit: Map<Oid, string[]>;
}

/** The CommitCard payload: the summary fields plus body, tree, signature, note and stats. */
export async function commitDetails(deps: CommitDetailsDeps, oid: Oid): Promise<CommitDetails> {
  const commit = await deps.db.readCommit(oid);
  const summary: CommitSummary = {
    oid: commit.oid,
    parents: commit.parents,
    author: toSignature(commit.author),
    committer: toSignature(commit.committer),
    subject: subjectOf(commit.message),
    refs: deps.refsByCommit.get(commit.oid) ?? [],
  };
  const stats = (await commitStats(deps, [commit.oid]))[commit.oid] ?? null;
  return {
    ...summary,
    body: bodyOf(commit.message),
    tree: commit.tree,
    signed: commit.gpgsig !== undefined,
    note: await deps.db.readNote(commit.oid),
    stats,
  };
}
