/**
 * Commit walker, lanes, reachability and ahead/behind (T10.5; atlas tabs 03, 09, 20;
 * Design §14.5/§14.6).
 *
 * Ordering is git's own: a priority queue over commit dates, newest first, ties broken by insertion
 * order — exactly `prio_queue` + `compare_commits_by_commit_date` in revision.c, whose tie-break is
 * the queue's insertion counter. That is what `git log --date-order` prints, and the fixtures assert
 * it oid for oid.
 *
 * Parents and commit times come from the commit-graph when there is one (`commitGraph.ts`); an oid
 * the graph does not list falls back to `ObjectDb.readCommit`, which is also the only read done for
 * the rows actually emitted (author, subject). A page is `limit` commits plus an opaque cursor that
 * carries the frontier, the oids already queued and the lane table, so the next page continues the
 * same graph drawing without recomputing anything.
 */
import type { CommitEdge, CommitSummary, Oid, RepoWarning, WalkPage, WalkRequest } from "../types";
import { throwIfAborted } from "../util/concurrency";
import type { CommitGraph } from "./commitGraph";
import type { ObjectDb } from "./objectDb";
import { toSignature } from "./tags";

/** Plan D11 / atlas tab 03: history is paged and capped, never unbounded. */
export const MAX_WALK = 50_000;
/** Each side of `aheadBehind` (docs/v2-contracts.md). */
export const AHEAD_BEHIND_CAP = 10_000;
/** Lanes beyond this are unreadable; the UI offers `first-parent` (atlas tab 03 "Risks"). */
export const MAX_LANES = 12;

/** What the walk needs about a commit before it decides to emit it. */
export interface CommitMeta {
  parents: Oid[];
  /** Committer date, epoch seconds (git's unit, and the commit-graph's). */
  time: number;
}

/**
 * Parents and commit time, from the commit-graph where possible. Memoised for the session: a walk
 * asks for the same commit once per page boundary and `aheadBehind` re-walks shared history.
 */
export class CommitReader {
  private readonly metas = new Map<Oid, CommitMeta>();

  constructor(
    private readonly db: ObjectDb,
    private readonly graph: CommitGraph | null,
  ) {}

  /** True when a commit-graph was parsed; `WalkPage.graphAvailable` reflects it. */
  get graphAvailable(): boolean {
    return this.graph !== null;
  }

  async meta(oid: Oid): Promise<CommitMeta> {
    const cached = this.metas.get(oid);
    if (cached) return cached;
    const fromGraph = this.graph?.get(oid);
    const meta: CommitMeta = fromGraph
      ? { parents: fromGraph.parents, time: fromGraph.commitTime }
      : await this.fromObject(oid);
    this.metas.set(oid, meta);
    return meta;
  }

  private async fromObject(oid: Oid): Promise<CommitMeta> {
    const c = await this.db.readCommit(oid);
    return { parents: c.parents, time: c.committer.timestamp };
  }
}

// ---- lanes --------------------------------------------------------------------------------

/**
 * First-fit lane assignment, the algorithm gitk and Git Graph use: `lanes[i]` is the oid lane `i`
 * is currently reserved for. A commit takes the lane that was reserved for it (or the first free
 * one), hands that lane to its first parent, and opens a lane per further parent.
 *
 * Serialised into the walk cursor so page 2 draws the same picture page 1 would have.
 */
export type LaneTable = (Oid | null)[];

export interface LaneRow {
  lane: number;
  laneCount: number;
  edges: CommitEdge[];
}

function firstFree(lanes: LaneTable): number {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
}

function trimLanes(lanes: LaneTable): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
}

/**
 * Places one commit in the lane table and returns the row the UI draws: the node's lane, the row
 * width, and the lines in the band **below** it (`from` is a lane at this row, `to` at the next).
 */
export function placeCommit(
  lanes: LaneTable,
  commit: { oid: Oid; parents: Oid[] },
  firstParent: boolean,
): LaneRow {
  let lane = lanes.indexOf(commit.oid);
  if (lane === -1) {
    lane = firstFree(lanes);
    lanes[lane] = commit.oid; // a tip: nothing pointed at it yet
  }
  const before = lanes.slice();
  const parents = firstParent ? commit.parents.slice(0, 1) : commit.parents;

  lanes[lane] = null; // the node consumes its lane; the first parent usually takes it straight back
  const parentLanes: number[] = [];
  const reused: boolean[] = [];
  for (let k = 0; k < parents.length; k++) {
    const parent = parents[k] as Oid;
    const existing = lanes.indexOf(parent);
    if (existing !== -1) {
      parentLanes[k] = existing;
      reused[k] = true;
      continue;
    }
    const target = k === 0 ? lane : firstFree(lanes);
    lanes[target] = parent;
    parentLanes[k] = target;
    reused[k] = false;
  }
  trimLanes(lanes);

  const edges: CommitEdge[] = [];
  for (let k = 0; k < parentLanes.length; k++) {
    const to = parentLanes[k] as number;
    const kind: CommitEdge["kind"] =
      to === lane ? "straight" : reused[k] === true ? "merge" : "fork";
    edges.push({ from: lane, to, kind });
  }
  // Every other lane that was waiting for the same commit before and after this row carries on
  // straight down — including a lane a parent edge lands in, whose vertical line the UI still has
  // to draw above the point where the merge arrives.
  for (let i = 0; i < before.length; i++) {
    if (i === lane) continue;
    if (before[i] != null && lanes[i] === before[i])
      edges.push({ from: i, to: i, kind: "straight" });
  }
  let laneCount = lane + 1;
  for (const e of edges) laneCount = Math.max(laneCount, e.from + 1, e.to + 1);
  return { lane, laneCount, edges };
}

// ---- cursor -------------------------------------------------------------------------------

interface CursorState {
  v: 2;
  /** Request signature: a cursor is only valid for the request that produced it. */
  key: string;
  /** The eligible queue, already ordered (newest first, ties by `ctr`). */
  frontier: { oid: Oid; time: number; ctr: number }[];
  ctr: number;
  /** Every oid discovered so far, concatenated 40-hex (a separator would double the size). */
  seen: string;
  /** oid → how many discovered-but-unemitted commits still name it as a parent (git's indegree). */
  blocked: Record<Oid, number>;
  lanes: LaneTable;
  walked: number;
}

function requestKey(req: WalkRequest, seeds: Oid[]): string {
  return JSON.stringify([seeds, req.firstParent === true, req.all === true, req.path ?? null]);
}

function encodeCursor(state: CursorState): string {
  return JSON.stringify(state);
}

function decodeCursor(text: string, key: string): CursorState | null {
  try {
    const parsed = JSON.parse(text) as CursorState;
    if (parsed.v !== 2 || parsed.key !== key || !Array.isArray(parsed.frontier)) return null;
    return parsed;
  } catch {
    return null; // a cursor from another request or another build: start over rather than throw
  }
}

function seenSet(packed: string): Set<Oid> {
  const out = new Set<Oid>();
  for (let i = 0; i + 40 <= packed.length; i += 40) out.add(packed.slice(i, i + 40));
  return out;
}

// ---- the walk -----------------------------------------------------------------------------

export interface WalkDeps {
  db: ObjectDb;
  reader: CommitReader;
  /** oid → the ref names that point at it, already in badge order. */
  refsByCommit: Map<Oid, string[]>;
  signal?: AbortSignal;
}

export interface WalkOutcome {
  page: WalkPage;
  warnings: RepoWarning[];
}

interface Entry {
  oid: Oid;
  time: number;
  ctr: number;
}

/** Newest first; equal dates keep insertion order, which is git's `prio_queue` tie-break. */
function insertEntry(frontier: Entry[], entry: Entry): void {
  let lo = 0;
  let hi = frontier.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const other = frontier[mid] as Entry;
    const before = other.time > entry.time || (other.time === entry.time && other.ctr < entry.ctr);
    if (before) lo = mid + 1;
    else hi = mid;
  }
  frontier.splice(lo, 0, entry);
}

/**
 * One page of history, ordered exactly like `git log --date-order`.
 *
 * `--date-order` is git's *topological* order with a commit-date tie-break (revision.c sets
 * `topo_order` for it), so a commit is never shown before all of its children: the queue only holds
 * commits whose discovered children have all been emitted (git's indegree, commit.c
 * `sort_in_topological_order`), and among those the newest wins, ties going to whichever became
 * eligible first — git's `prio_queue` insertion counter.
 *
 * `seeds` are already-resolved commit oids in the order git would list the refs (the session sorts
 * them by ref name for `all`). Streaming, so the indegree is over the commits discovered so far
 * rather than a whole pre-walk; the two agree whenever commit dates do not increase towards the
 * parents, which is every history git itself writes.
 */
export async function walkCommits(
  deps: WalkDeps,
  req: WalkRequest,
  seeds: Oid[],
): Promise<WalkOutcome> {
  const { db, reader, refsByCommit, signal } = deps;
  const limit = Math.max(1, Math.min(req.limit, MAX_WALK));
  const key = requestKey(req, seeds);
  const restored = req.cursor ? decodeCursor(req.cursor, key) : null;

  let ctr = restored?.ctr ?? 0;
  const frontier: Entry[] = restored ? restored.frontier.slice() : [];
  const seen = seenSet(restored?.seen ?? "");
  const blocked = new Map<Oid, number>(Object.entries(restored?.blocked ?? {}));
  // Everything discovered that is no longer blocked has already been queued (and possibly emitted);
  // deriving the set keeps the cursor to one copy of the oids.
  const queued = new Set<Oid>([...seen].filter((oid) => !blocked.has(oid)));
  const lanes: LaneTable = restored ? restored.lanes.slice() : [];
  let walked = restored?.walked ?? 0;

  /** Parents to follow and whether the row is shown; pure, so it survives a cursor restore. */
  const nodes = new Map<Oid, { meta: CommitMeta; follow: Oid[]; visible: boolean }>();
  const nodeOf = async (oid: Oid) => {
    const cached = nodes.get(oid);
    if (cached) return cached;
    const meta = await reader.meta(oid);
    const step = req.path
      ? await simplifyPath(db, oid, meta.parents, req.path, req.firstParent === true)
      : {
          visible: true,
          follow: req.firstParent === true ? meta.parents.slice(0, 1) : meta.parents,
        };
    const node = { meta, ...step };
    nodes.set(oid, node);
    return node;
  };
  /** First sight of a commit: it now blocks every parent it will be followed into. */
  const discover = async (oid: Oid): Promise<void> => {
    if (seen.has(oid)) return;
    seen.add(oid);
    for (const parent of (await nodeOf(oid)).follow) {
      // A parent already on its way out cannot be held back by a child found later; that is the
      // one place a streaming indegree differs from git's pre-walk, and it keeps the walk finite.
      if (queued.has(parent)) continue;
      blocked.set(parent, (blocked.get(parent) ?? 0) + 1);
    }
  };
  const enqueue = async (oid: Oid): Promise<void> => {
    blocked.delete(oid);
    queued.add(oid);
    insertEntry(frontier, { oid, time: (await nodeOf(oid)).meta.time, ctr: ctr++ });
  };
  /** One child emitted: the parent joins the queue once nothing unemitted points at it any more. */
  const release = async (oid: Oid): Promise<void> => {
    if (queued.has(oid)) return;
    const left = (blocked.get(oid) ?? 1) - 1;
    if (left > 0) {
      blocked.set(oid, left);
      return;
    }
    await enqueue(oid);
  };

  if (!restored) {
    // git's two passes: discover every tip first, then queue the ones nothing else points at.
    for (const oid of seeds) await discover(oid);
    for (const oid of seeds) if ((blocked.get(oid) ?? 0) === 0) await enqueue(oid);
  }

  const commits: CommitSummary[] = [];
  let capped = false;
  while (commits.length < limit && frontier.length > 0) {
    throwIfAborted(signal, "history walk");
    if (walked >= MAX_WALK) {
      capped = true;
      break;
    }
    const entry = frontier.shift() as Entry;
    walked++;
    const node = await nodeOf(entry.oid);
    if (node.visible) {
      // A path-filtered walk skips commits, so a lane reserved for a parent that is never emitted
      // would hang around for ever: the graph column belongs to the unfiltered list (Design §14.5),
      // and file history draws its own (T10.6). Lanes are therefore only assigned without `path`.
      const row = req.path
        ? null
        : placeCommit(
            lanes,
            { oid: entry.oid, parents: node.meta.parents },
            req.firstParent === true,
          );
      commits.push(await summarise(db, entry.oid, node.meta, refsByCommit, row));
    }
    for (const parent of node.follow) await discover(parent);
    for (const parent of node.follow) await release(parent);
  }

  const state: CursorState = {
    v: 2,
    key,
    frontier,
    ctr,
    seen: [...seen].join(""),
    blocked: Object.fromEntries(blocked),
    lanes,
    walked,
  };
  const warnings: RepoWarning[] = capped
    ? [
        {
          code: "HISTORY_CAPPED",
          message: `History stops after ${MAX_WALK.toLocaleString("en")} commits; diffgit is not a monorepo archaeology tool (Plan D11).`,
        },
      ]
    : [];
  return {
    page: {
      commits,
      cursor: frontier.length === 0 || capped ? null : encodeCursor(state),
      graphAvailable: reader.graphAvailable,
      capped,
    },
    warnings,
  };
}

async function summarise(
  db: ObjectDb,
  oid: Oid,
  meta: CommitMeta,
  refsByCommit: Map<Oid, string[]>,
  row: LaneRow | null,
): Promise<CommitSummary> {
  const commit = await db.readCommit(oid);
  return {
    oid,
    parents: meta.parents,
    author: toSignature(commit.author),
    committer: toSignature(commit.committer),
    subject: subjectOf(commit.message),
    refs: refsByCommit.get(oid) ?? [],
    ...(row ? { lane: row.lane, laneCount: row.laneCount, edges: row.edges } : {}),
  };
}

/** git's `%s`: the first line of the message. */
export function subjectOf(message: string): string {
  const end = message.indexOf("\n");
  return (end === -1 ? message : message.slice(0, end)).trim();
}

/** git's `%b`: everything after the subject line and the blank line that follows it. */
export function bodyOf(message: string): string {
  const end = message.indexOf("\n");
  return end === -1
    ? ""
    : message
        .slice(end + 1)
        .replace(/^\n+/, "")
        .trimEnd();
}

// ---- path filter --------------------------------------------------------------------------

/** `{oid}:{mode}` of a path in a commit's tree, or null when the path is absent. */
async function pathEntry(db: ObjectDb, commit: Oid, path: string): Promise<string | null> {
  const tree = await db.flattenTree(commit);
  const entry = tree[path];
  return entry ? `${entry.oid}:${entry.mode}` : null;
}

/**
 * git's default history simplification for `git log -- <path>` (`revision.c: simplify_commit`):
 * a commit that leaves the path exactly as one of its parents left it is not shown, and the walk
 * follows only that parent. A commit that differs from every parent is shown and every parent is
 * followed. A root commit is shown when it has the path at all.
 *
 * Rename following is T10.6; this is `git log -- <path>` without `--follow`.
 */
async function simplifyPath(
  db: ObjectDb,
  oid: Oid,
  parents: Oid[],
  path: string,
  firstParent: boolean,
): Promise<{ visible: boolean; follow: Oid[] }> {
  const considered = firstParent ? parents.slice(0, 1) : parents;
  const mine = await pathEntry(db, oid, path);
  if (considered.length === 0) return { visible: mine !== null, follow: [] };
  for (const parent of considered) {
    if ((await pathEntry(db, parent, path)) === mine) return { visible: false, follow: [parent] };
  }
  return { visible: true, follow: considered };
}

// ---- reachability and ahead/behind ----------------------------------------------------------

export interface ReachableResult {
  oids: Set<Oid>;
  capped: boolean;
}

/**
 * Every commit reachable from `tips`, up to `cap`. Memoised by the caller (the session keys the
 * "reachable from any ref" set on the refs it was built from).
 */
export async function reachableFrom(
  reader: CommitReader,
  tips: Oid[],
  cap: number,
  signal?: AbortSignal,
): Promise<ReachableResult> {
  const oids = new Set<Oid>();
  const stack: Oid[] = [];
  for (const tip of tips) {
    if (oids.has(tip)) continue;
    oids.add(tip);
    stack.push(tip);
  }
  while (stack.length > 0) {
    throwIfAborted(signal, "reachability walk");
    if (oids.size >= cap) return { oids, capped: true };
    const oid = stack.pop() as Oid;
    for (const parent of (await reader.meta(oid)).parents) {
      if (oids.has(parent)) continue;
      oids.add(parent);
      stack.push(parent);
    }
  }
  return { oids, capped: false };
}

/**
 * `git rev-list --left-right --count a...b`: `ahead` counts commits reachable from `a` and not from
 * `b`, `behind` the other way round. Both sides are bounded by `AHEAD_BEHIND_CAP`; when a cap is
 * hit the counts are lower bounds and `capped` says so (atlas tab 09 "Risks": cap at 1,000+ with a
 * hint rather than walking a stale remote forever).
 *
 * The two full sets are computed rather than pruning at the merge base, because a commit reachable
 * from the base can also be reached on a path that never passes through it, and git counts it as
 * common either way.
 */
export async function aheadBehind(
  db: ObjectDb,
  reader: CommitReader,
  a: Oid,
  b: Oid,
  signal?: AbortSignal,
): Promise<{ ahead: number; behind: number; mergeBase: Oid | null; capped: boolean }> {
  const base = await db.findMergeBase(a, b);
  if (a === b) return { ahead: 0, behind: 0, mergeBase: base.oid, capped: false };
  const left = await reachableFrom(reader, [a], AHEAD_BEHIND_CAP, signal);
  const right = await reachableFrom(reader, [b], AHEAD_BEHIND_CAP, signal);
  let ahead = 0;
  let behind = 0;
  for (const oid of left.oids) if (!right.oids.has(oid)) ahead++;
  for (const oid of right.oids) if (!left.oids.has(oid)) behind++;
  return { ahead, behind, mergeBase: base.oid, capped: left.capped || right.capped };
}
