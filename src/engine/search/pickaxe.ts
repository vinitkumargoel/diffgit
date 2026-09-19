/**
 * The pickaxe (T10.8, atlas tab 05 scope `-S`): `git log -S<query>` over the last `commits`
 * commits of the **first-parent** chain, scoped to a path.
 *
 * git's own rule, from `diffcore-pickaxe.c`: a commit matches when the number of occurrences of
 * the query differs between the two sides of **at least one** changed file — not when the total
 * changed. `SearchHit.delta` is the total anyway, because that is the number the row shows
 * ("+4 occurrences"); the match itself is decided per file.
 *
 * First-parent is not a simplification of git but the same thing git does with `--first-parent`:
 * a merge is diffed against its mainline and can match (`git log --first-parent -S'topic work'`
 * reports the merge that brought the topic branch in, and so does this). It is also what makes the
 * scope affordable — the cost is the blobs a commit actually changed inside `path`, which is why
 * the range size is mandatory (atlas tab 05 "Risks": *no unscoped mode*).
 *
 * Divergences from git, both documented in `docs/v2-contracts.md`:
 *   - rename detection is **not** run before the count, so a `git mv` is a delete plus an add; the
 *     two disagree only for a rename that leaves the occurrence count untouched;
 *   - binary blobs and blobs over `PICKAXE_MAX_BLOB_BYTES` are skipped rather than byte-counted.
 */
import { isBinary } from "../diff/binary";
import { LARGE_FILE_BYTES } from "../diff/textDiff";
import { treeDiff } from "../diff/treeDiff";
import type { FlatTree } from "../git/objectDb";
import { MODE_GITLINK, type Oid, type SearchHit, type SearchRequest } from "../types";
import { throwIfAborted } from "../util/concurrency";
import type { CommitSource } from "./commits";
import { createMatcher, type Matcher, type SearchOutcome } from "./query";

/** The palette's default range (T10.8 deliverables: "default 200 from the UI"). */
export const DEFAULT_PICKAXE_COMMITS = 200;
/** However wide the user widens the range, the engine stops here. */
export const MAX_PICKAXE_COMMITS = 5000;
/** A side bigger than this is not counted; the row says the answer was partial instead. */
export const PICKAXE_MAX_BLOB_BYTES = LARGE_FILE_BYTES;
/** What the working-tree row is called when the uncommitted work changes the count. */
export const WORKTREE_HIT_SUBJECT = "Uncommitted changes";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

export interface PickaxeWorktree {
  /** Paths that differ between HEAD and the working tree (staged or unstaged), in path order. */
  changed: string[];
  /** The HEAD bytes of a path, or null when HEAD does not have it. */
  head(path: string): Promise<Uint8Array | null>;
  /** The working-tree bytes of a path, or null when it is gone. */
  work(path: string): Promise<Uint8Array | null>;
}

export interface PickaxeDeps {
  source: CommitSource;
  /** The flattened tree of a commit (`ObjectDb.flattenTree`). */
  tree(oid: Oid): Promise<FlatTree>;
  blob(oid: Oid): Promise<Uint8Array>;
  /** Null when the caller does not want the uncommitted row (recordings, tests). */
  worktree?: PickaxeWorktree | null;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
}

/** `req.commits` clamped into `[1, MAX_PICKAXE_COMMITS]`, defaulting to `DEFAULT_PICKAXE_COMMITS`. */
export function pickaxeRange(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PICKAXE_COMMITS;
  return Math.max(1, Math.min(Math.floor(requested), MAX_PICKAXE_COMMITS));
}

/** `path` as a scope test: the path itself or anything under it. `undefined` means everything. */
export function pathScope(path: string | undefined): (p: string) => boolean {
  const scope = (path ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (scope.length === 0) return () => true;
  const prefix = `${scope}/`;
  return (p) => p === scope || p.startsWith(prefix);
}

/** Occurrences of the query in one side, or null when the side is absent / not countable. */
function countBytes(matcher: Matcher, bytes: Uint8Array | null): number | null {
  if (bytes === null) return 0; // an absent side has no occurrences, which is what git counts
  if (bytes.byteLength > PICKAXE_MAX_BLOB_BYTES || isBinary(bytes)) return null;
  return matcher.count(decoder.decode(bytes));
}

export async function searchPickaxe(deps: PickaxeDeps, req: SearchRequest): Promise<SearchOutcome> {
  const matcher = createMatcher(req.query, req.regex === true);
  const limit = Math.max(1, req.limit);
  const range = pickaxeRange(req.commits);
  const inScope = pathScope(req.path);

  /** Blob oid → occurrences; a revert brings the same blob back and the count is not free. */
  const counts = new Map<Oid, number | null>();
  const countBlob = async (oid: Oid | null, mode: number | null): Promise<number | null> => {
    if (oid === null) return 0;
    const cached = counts.get(oid);
    if (cached !== undefined) return cached;
    // A gitlink has no blob: git diffs the literal `Subproject commit <oid>` line, and so do we.
    const bytes =
      mode === MODE_GITLINK ? encoder.encode(`Subproject commit ${oid}\n`) : await deps.blob(oid);
    const n = countBytes(matcher, bytes);
    counts.set(oid, n);
    return n;
  };

  const hits: SearchHit[] = [];
  let skipped = 0;
  let hitLimit = false;

  // The uncommitted row comes first: it is newer than every commit below it (atlas tab 05).
  if (deps.worktree) {
    let delta = 0;
    let matched = false;
    for (const path of deps.worktree.changed) {
      throwIfAborted(deps.signal, "pickaxe search");
      if (!inScope(path)) continue;
      const before = countBytes(matcher, await deps.worktree.head(path));
      const after = countBytes(matcher, await deps.worktree.work(path));
      if (before === null || after === null) {
        skipped++;
        continue;
      }
      if (before !== after) matched = true;
      delta += after - before;
    }
    if (matched) hits.push({ kind: "commit", subject: WORKTREE_HIT_SUBJECT, delta });
  }

  const { commits, more } = await deps.source.walk(range, true);
  let scanned = 0;
  for (const c of commits) {
    throwIfAborted(deps.signal, "pickaxe search");
    if (hits.length >= limit) {
      hitLimit = true;
      break;
    }
    scanned++;
    deps.onProgress?.(scanned, commits.length);
    const parent = c.parents[0];
    const before: FlatTree | null = parent === undefined ? null : await deps.tree(parent);
    const after = await deps.tree(c.oid);
    let delta = 0;
    let matched = false;
    for (const [path, change] of Object.entries(treeDiff(before, after))) {
      throwIfAborted(deps.signal, "pickaxe search");
      if (!inScope(path)) continue;
      const oldN = await countBlob(change.oldOid, change.oldMode);
      const newN = await countBlob(change.newOid, change.newMode);
      if (oldN === null || newN === null) {
        skipped++;
        continue;
      }
      if (oldN !== newN) matched = true;
      delta += newN - oldN;
    }
    if (matched) hits.push({ kind: "commit", oid: c.oid, subject: c.subject, delta });
  }
  deps.onProgress?.(scanned, commits.length);

  const notes: string[] = [];
  if (hitLimit) notes.push(`the first ${limit} matching commits`);
  if (more) notes.push(`the newest ${range} commits`);
  if (skipped > 0) notes.push(`${skipped} binary or oversized blobs were not counted`);
  const outcome: SearchOutcome = {
    hits: hits.slice(0, limit),
    scanned,
    capped: hitLimit || more || skipped > 0,
  };
  if (notes.length > 0) outcome.note = `${notes.join("; ")}.`;
  return outcome;
}
