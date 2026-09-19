/**
 * History mode, pure part (T11.5, Design §14.5; atlas tabs 03 / 04).
 *
 * Everything here is maths and strings: the lane geometry the SVG column draws from
 * `CommitSummary.edges`, the `DiffSource` a selected commit or a selected pair turns into, the
 * client-side commit filter, and the copy the CommitCard shows. No React, no engine calls — the
 * store owns those — so `history.test.ts` can check the geometry and the sources on the recorded
 * walks without rendering anything.
 */
import type { CommitSummary, Oid, RangeSource, RefSnapshot, Signature } from "../engine/types";

/** Commits per `walkCommits` page (Design §14.5 "50 of 1,284"). */
export const HISTORY_PAGE = 50;
/** `commitStats` is batched like file stats; one call per this many visible rows. */
export const COMMIT_STATS_BATCH = 50;
/** The Stack tab never walks further than this past the merge base (atlas tab 04 risk row). */
export const STACK_LIMIT = 200;

/** Row height and lane-column width of Design §14.5 ("Rows 30 px: a 44 px SVG lane column"). */
export const ROW_H = 30;
export const LANE_W = 44;
const LANE_X0 = 10;
const LANE_STEP = 14;
/** Half a node plus a hair, so the rightmost lane's circle still fits inside the column. */
const LANE_EDGE = 6;

/**
 * The three validated hues of Design §3.1 in order, then the muted tone, repeating. A lane keeps
 * its colour for as long as the walk keeps the lane, which is what makes a branch readable.
 */
export const LANE_TOKENS = [
  "var(--accent)",
  "var(--success)",
  "var(--done)",
  "var(--muted)",
] as const;

export function laneColor(lane: number): string {
  return LANE_TOKENS[
    ((lane % LANE_TOKENS.length) + LANE_TOKENS.length) % LANE_TOKENS.length
  ] as string;
}

/**
 * Horizontal centre of a lane. Lanes sit 14 px apart until they would leave the 44 px column, and
 * are then squeezed evenly — a wide graph gets tighter rather than clipped.
 */
export function laneX(lane: number, laneCount: number): number {
  const lanes = Math.max(1, laneCount);
  if (lanes === 1) return LANE_X0;
  const step = Math.min(LANE_STEP, (LANE_W - LANE_X0 - LANE_EDGE) / (lanes - 1));
  return LANE_X0 + Math.min(lane, lanes - 1) * step;
}

export type LaneEdge = NonNullable<CommitSummary["edges"]>[number];

/**
 * The `d` of one edge, drawn in the band **below** the node (`docs/v2-contracts.md`, T10.5): from
 * the middle of this row to the top of the next one. A lane that stays put is a straight line; a
 * fork or a merge is a cubic that leaves vertically and arrives vertically, so two rows stacked on
 * top of each other join without a kink.
 */
export function edgePath(edge: LaneEdge, laneCount: number): string {
  const x1 = laneX(edge.from, laneCount);
  const x2 = laneX(edge.to, laneCount);
  const mid = ROW_H / 2;
  if (x1 === x2) return `M${x1} ${mid}V${ROW_H}`;
  return `M${x1} ${mid}C${x1} ${mid + 7} ${x2} ${ROW_H - 7} ${x2} ${ROW_H}`;
}

/** The half-height line above the node, one per lane the previous row handed down. */
export function incomingPath(lane: number, laneCount: number): string {
  const x = laneX(lane, laneCount);
  return `M${x} 0V${ROW_H / 2}`;
}

/**
 * Which lanes arrive at this row from the one above it. `edges` describes the band below a node,
 * so the incoming lanes are the previous row's `to` values; the first row of the page has none.
 */
export function incomingLanes(previous: CommitSummary | undefined): number[] {
  if (!previous?.edges) return [];
  return [...new Set(previous.edges.map((e) => e.to))].sort((a, b) => a - b);
}

/** 7 hex characters, the short oid every surface prints (same rule as `operation.short`). */
export function shortOid(oid: Oid): string {
  return oid.slice(0, 7);
}

/**
 * "Show one commit": the range `parent…commit` (`docs/v2-contracts.md` `RangeSource.commit`). A
 * root commit has no parent, so `fromOid` is null — git's empty tree — and `<oid>^` is what
 * `resolveRevision` answers the empty tree for.
 */
export function commitRange(oid: Oid, firstParent: Oid | null): RangeSource {
  return {
    kind: "range",
    from: firstParent ? shortOid(firstParent) : "(root)",
    to: shortOid(oid),
    fromRef: `${oid}^`,
    toRef: oid,
    fromOid: firstParent,
    toOid: oid,
    // A single commit is a plain tree diff against its parent, never a merge-base walk.
    threeDot: false,
    includeWorktree: false,
    commit: oid,
  };
}

/** Shift-click: the range `older…newer`, two-dot, so the StatsRow counts what the span changed. */
export function spanRange(older: Oid, newer: Oid): RangeSource {
  return {
    kind: "range",
    from: shortOid(older),
    to: shortOid(newer),
    fromRef: older,
    toRef: newer,
    fromOid: older,
    toOid: newer,
    threeDot: false,
    includeWorktree: false,
  };
}

/** Client-side filter over the commits already walked: subject, author, email, short or full oid. */
export function matchesCommit(commit: CommitSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    commit.subject.toLowerCase().includes(q) ||
    commit.author.name.toLowerCase().includes(q) ||
    commit.author.email.toLowerCase().includes(q) ||
    commit.oid.startsWith(q) ||
    commit.refs.some((r) => r.toLowerCase().includes(q))
  );
}

/** Design §14.5 ref badges; a stash selector wears the `T` palette, everything else its own. */
export type RefChipKind = "head" | "branch" | "remote" | "tag" | "stash";

/**
 * `CommitSummary.refs` are display names (`HEAD`, `main`, `origin/main`, `v1.0.0`, `stash@{0}`).
 * Only the ref snapshot can say which is which: a name the snapshot knows is a branch or a remote,
 * `stash@{n}` is a stash, and anything left is a tag (T10.5 lists them after the branches).
 */
export function refChipKind(name: string, refs: RefSnapshot | null): RefChipKind {
  if (name === "HEAD") return "head";
  if (/^stash@\{\d+\}$/.test(name)) return "stash";
  const ref = refs?.refs.find((r) => r.name === name);
  if (ref) return ref.kind === "remote" ? "remote" : "branch";
  return "tag";
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * The commit's own wall-clock time, not the reader's: git records the offset, so
 * `4 Mar 2024, 12:00 +0100` is what `git show` would print. Built from UTC getters on the shifted
 * instant so the string never depends on the machine's locale or zone.
 */
export function formatCommitDate(sig: Signature): string {
  const at = new Date(sig.timestamp - sig.tzOffsetMin * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const abs = Math.abs(sig.tzOffsetMin);
  // `Signature.tzOffsetMin` follows `Date.getTimezoneOffset()`: minutes to add to reach UTC.
  const zone = `${sig.tzOffsetMin <= 0 ? "+" : "−"}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  return (
    `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} ${zone}`
  );
}

/** `Ada Lovelace <ada@example.com>` — the CommitCard's author and committer lines. */
export function formatSignature(sig: Signature): string {
  return `${sig.name} <${sig.email}>`;
}

/** The `…` menu's one command diffgit can offer today; it never runs it (D16). */
export function cherryPickCommand(oid: Oid): string {
  return `git cherry-pick ${oid}`;
}
