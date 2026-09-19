/**
 * Commit search (T10.8, atlas tab 05 scope `msg:`): `git log --grep`, `git log --author` and a
 * bare object-name prefix, folded into the one box the palette gives the user.
 *
 * The walk itself is T10.5's — this module never opens an object database of its own; it takes a
 * `CommitSource` that hands it one capped page of `git log --date-order` and a way to read a
 * commit's full message. That keeps the ordering git's, keeps the commit-graph fast path, and
 * keeps this file out of `walk.ts`.
 *
 * What a commit is matched against, in the order it is cheapest to try:
 *   1. the object name, when the query is a hex prefix (4–40 characters, exact mode only);
 *   2. the subject (`%s`), which the walk already carries;
 *   3. the author's name and email (`git log --author` matches `Name <email>`, so either side hits);
 *   4. the whole message (`%B`), which is the only step that costs an object read.
 */
import type { CommitSummary, Oid, SearchHit, SearchRequest } from "../types";
import { throwIfAborted } from "../util/concurrency";
import { createMatcher, isOidPrefix, type SearchOutcome } from "./query";

/** Commits examined when the request does not say (the palette's own default is the same). */
export const DEFAULT_COMMIT_SCAN = 1000;
/** Never walk more than this for a search, whatever the request asks for (Plan D11). */
export const MAX_COMMIT_SCAN = 20_000;
/** Progress is reported every this many commits, not once at the end. */
const PROGRESS_EVERY = 200;

/**
 * One capped page of history, in `git log --date-order` order. `RepoSession` implements it with
 * T10.5's `walkCommits`; tests implement it with a literal array.
 */
export interface CommitSource {
  /** `more` is true when history continued past `limit`. */
  walk(limit: number, firstParent: boolean): Promise<{ commits: CommitSummary[]; more: boolean }>;
}

export interface CommitSearchDeps {
  source: CommitSource;
  /** `%B` of one commit — read only for the commits nothing cheaper matched. */
  message(oid: Oid): Promise<string>;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
}

/** `req.commits` clamped into `[1, MAX_COMMIT_SCAN]`, defaulting to `DEFAULT_COMMIT_SCAN`. */
export function commitScanLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_COMMIT_SCAN;
  return Math.max(1, Math.min(Math.floor(requested), MAX_COMMIT_SCAN));
}

export async function searchCommits(
  deps: CommitSearchDeps,
  req: SearchRequest,
): Promise<SearchOutcome> {
  const matcher = createMatcher(req.query, req.regex === true);
  const limit = Math.max(1, req.limit);
  const scan = commitScanLimit(req.commits);
  const oidPrefix = !matcher.regex && isOidPrefix(req.query) ? req.query.toLowerCase() : null;

  const { commits, more } = await deps.source.walk(scan, false);
  const hits: SearchHit[] = [];
  let scanned = 0;
  let hitLimit = false;

  for (const c of commits) {
    throwIfAborted(deps.signal, "commit search");
    scanned++;
    if (scanned % PROGRESS_EVERY === 0) deps.onProgress?.(scanned, commits.length);
    let matched =
      (oidPrefix !== null && c.oid.startsWith(oidPrefix)) ||
      matcher.test(c.subject) ||
      matcher.test(c.author.name) ||
      matcher.test(c.author.email);
    // Only now is an object read worth it: `--grep` matches the body too, and most commits in a
    // capped page match nothing at all.
    if (!matched) matched = matcher.test(await deps.message(c.oid));
    if (!matched) continue;
    hits.push({ kind: "commit", oid: c.oid, subject: c.subject });
    if (hits.length >= limit) {
      hitLimit = true;
      break;
    }
  }
  deps.onProgress?.(scanned, commits.length);

  const notes: string[] = [];
  if (hitLimit) notes.push(`the first ${limit} matching commits`);
  if (more) notes.push(`the newest ${scan} commits`);
  const outcome: SearchOutcome = { hits, scanned, capped: hitLimit || more };
  if (notes.length > 0) outcome.note = `Showing ${notes.join(" of ")}.`;
  return outcome;
}
