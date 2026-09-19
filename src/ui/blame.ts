/**
 * Blame and file history, pure part (T11.6, Design §14.1 FileHeader / §14.3 rule 2; atlas tab 02).
 *
 * Everything here is maths and strings: the age ramp the 6 px heat strip buckets revisions into,
 * the runs that let a block of lines from one commit print its author and SHA once, the cache keys
 * the store and `persistence/derived` share, and every word the two card bodies show. No React and
 * no engine calls — the store owns those — so `blame.test.ts` can check all of it against the
 * recorded `history` payloads without rendering anything.
 */
import type { BlameLine, BlamePayload, Oid, PathHistoryEntry } from "../engine/types";

/** Revisions the first `blame()` asks for; `Continue` raises it by `BLAME_REVISION_STEP`. */
export const BLAME_REVISIONS = 200;
export const BLAME_REVISION_STEP = 400;
/** `PathHistoryEntry` rows per `Load more` (the History list's page size reads the same). */
export const PATH_HISTORY_PAGE = 50;

/** Design §3.6, oldest → newest. Index 0 is `--heat1`. */
export const HEAT_CLASS = [
  "bg-heat-1",
  "bg-heat-2",
  "bg-heat-3",
  "bg-heat-4",
  "bg-heat-5",
] as const;
export type Heat = 1 | 2 | 3 | 4 | 5;

export function heatClass(heat: Heat): string {
  return HEAT_CLASS[heat - 1] as string;
}

/** `BlameLine.oid === null` (contracts, T10.6): the working tree changed the line and nothing committed it. */
export const UNCOMMITTED_AUTHOR = "you, uncommitted";
export const UNCOMMITTED_SHA = "working";

export const IGNORE_WS_LABEL = "Ignore whitespace-only commits";
export const FOLLOW_LABEL = "Follow renames";
export const RENAMED_TAG = "renamed";
export const WS_ONLY_TAG = "ws only";
export const LOAD_MORE_LABEL = "Load more";
export const CONTINUE_LABEL = "Continue";

/** 7 hex characters, the short oid every surface prints (same rule as `history.shortOid`). */
export function shortOid(oid: Oid): string {
  return oid.slice(0, 7);
}

/**
 * The distinct author timestamps a blame points at, oldest first — the sample the heat strip
 * buckets against. Lines with no commit (uncommitted) are not in it: they are newer than anything
 * committed, by definition.
 */
export function ageOrder(timestamps: readonly number[]): number[] {
  return [...new Set(timestamps)].sort((a, b) => a - b);
}

/**
 * Which step of the §3.6 ramp a revision gets: 1 = oldest, 5 = newest, `null` (uncommitted) = 5.
 * It is the revision's **age rank** spread across the five steps, which is its age quintile once a
 * file has five or more revisions and still uses the whole ramp when it has fewer — a quintile over
 * the *lines* would not: the recorded `history` blame has 85 % of `src/hot.txt` on one revision, so
 * every line of it would land in the same bucket and the strip would say nothing.
 */
export function heatOf(timestamp: number | null, order: readonly number[]): Heat {
  if (timestamp === null || order.length <= 1) return 5;
  const rank = order.indexOf(timestamp);
  if (rank < 0) return 5;
  return (1 + Math.round((rank * 4) / (order.length - 1))) as Heat;
}

/** One rendered blame row: the engine's line plus what the gutter needs to draw it. */
export interface BlameRow {
  line: BlameLine;
  /** First row of a run of consecutive lines from the same commit — the only one that prints
   * the author and the SHA (Design §14.1: "rows for the same commit collapse the author/SHA"). */
  first: boolean;
  heat: Heat;
  /** The commit's author name, or `UNCOMMITTED_AUTHOR` for a working-tree line. */
  author: string;
  /** `null` for a working-tree line, which has no commit to jump to. */
  oid: Oid | null;
}

/**
 * The rows the table renders, in file order. A run is broken by a different oid, so two separate
 * blocks from the same commit each print their own author and SHA.
 */
export function blameRows(payload: BlamePayload): BlameRow[] {
  const stamps: number[] = [];
  for (const oid of Object.keys(payload.commits)) {
    const c = payload.commits[oid];
    if (c) stamps.push(c.author.timestamp);
  }
  const order = ageOrder(stamps);
  let previous: Oid | null | undefined;
  return payload.lines.map((line) => {
    const commit = line.oid === null ? undefined : payload.commits[line.oid];
    const first = previous === undefined || previous !== line.oid;
    previous = line.oid;
    return {
      line,
      first,
      heat: heatOf(commit?.author.timestamp ?? null, order),
      author: commit?.author.name ?? UNCOMMITTED_AUTHOR,
      oid: line.oid,
    };
  });
}

/** "3 revisions" / "1 revision" — the counter beside the whitespace toggle (atlas tab 02). */
export function revisionsLabel(revisions: number): string {
  return `${revisions.toLocaleString("en-US")} ${revisions === 1 ? "revision" : "revisions"}`;
}

/**
 * The `BLAME_CAPPED` copy, shown as **one inline line** in the card's blame strip rather than a
 * banner: the cap is a property of this one blame, not of the repository.
 */
export function cappedLine(revisions: number): string {
  return `Blame stopped after ${revisions.toLocaleString("en-US")} revisions; everything older is attributed to the oldest commit it reached.`;
}

/** "renamed from src/total.ts" — the rename note a `PathHistoryEntry` carries. */
export function renamedFromLabel(entry: PathHistoryEntry): string | null {
  return entry.renamedFrom === null ? null : `renamed from ${entry.renamedFrom}`;
}

/** Lines of a file, with a trailing newline not starting an extra one (same rule as `lineCount`). */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Store + `persistence/derived` key for one blame. `w` is part of it because `-w` is a different
 * question with a different answer (contracts `<!-- T10.6 -->`), and the oid is what makes the
 * value safe to keep: a commit's content never changes.
 */
export function blameCacheKey(oid: Oid, path: string, ignoreWhitespace: boolean): string {
  return `${oid}:${path}:${ignoreWhitespace ? "w" : "x"}`;
}

/** Store key for one path history; `follow` changes the list, so it is part of the key. */
export function pathHistoryCacheKey(oid: Oid, path: string, follow: boolean): string {
  return `${oid}:${path}:${follow ? "f" : "n"}`;
}
