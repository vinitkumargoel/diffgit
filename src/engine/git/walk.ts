/**
 * Commit walker, lanes, reachability and ahead/behind (T10.5; atlas tabs 03, 09, 20;
 * Design §14.5/§14.6).
 *
 * Ordering is git's own `--date-order`: topological order with a commit-date priority. git computes
 * it in two passes (revision.c `limit_list`, then commit.c `sort_in_topological_order`): first the
 * whole candidate list, then an indegree over that list, then a `prio_queue` keyed on commit date
 * whose tie-break is the queue's insertion counter. T10.5b makes this walk do the same two passes
 * over a **window**: at least `limit + LOOKAHEAD` commits are discovered before any of them is
 * released, so a commit is never emitted before a child that a later discovery would have found
 * (`docs/v2-contracts.md`, T10.5b, states the exact guarantee).
 *
 * Parents and commit times come from the commit-graph when there is one (`commitGraph.ts`); an oid
 * the graph does not list falls back to `ObjectDb.readCommit`, which is also the only read done for
 * the rows actually emitted (author, subject). A page is `limit` commits plus a `WalkState` the
 * session keeps under an opaque token (T10.5b S4) — the cursor the UI carries is that token.
 */
import { EngineError } from "../errors";
import type { CommitEdge, CommitSummary, Oid, RepoWarning, WalkPage, WalkRequest } from "../types";
import { throwIfAborted } from "../util/concurrency";
import type { CommitGraph } from "./commitGraph";
import type { ObjectDb } from "./objectDb";
import { toSignature } from "./tags";

/** Plan D11 / atlas tab 03: history is paged and capped, never unbounded. */
export const MAX_WALK = 50_000;
/** Each side of `aheadBehind` (docs/v2-contracts.md); overridable per call for the tests. */
export const AHEAD_BEHIND_CAP = 10_000;
/** Lanes beyond this are unreadable; the UI offers `first-parent` (atlas tab 03 "Risks"). */
export const MAX_LANES = 12;
/**
 * How far ahead of the emission point the walk discovers commits (T10.5b S1). git discovers the
 * whole list; a window of this many commits makes the streaming walk agree with it unless a commit
 * is older than a parent by more than `limit + LOOKAHEAD` commits of history — far beyond the
 * few-hour clock skew `git log` itself tolerates (revision.c's own `SLOP` is 5 commits).
 */
export const LOOKAHEAD = 512;

/** What the walk needs about a commit before it decides to emit it. */
export interface CommitMeta {
  parents: Oid[];
  /** Committer date, epoch seconds (git's unit, and the commit-graph's). */
  time: number;
}

/**
 * Parents and commit time, from the commit-graph where possible. Memoised for the session: a walk
 * asks for the same commit once per page boundary and `aheadBehind` re-walks shared history.
 *
 * `meta` answers **null** for an oid that is not a commit (T10.5b B1): a lightweight tag can point
 * at a blob or a tree — git.git's own `refs/tags/junio-gpg-pub` is a blob — and `git log --all`
 * skips such a ref rather than failing on it.
 */
export class CommitReader {
  private readonly metas = new Map<Oid, CommitMeta | null>();

  constructor(
    private readonly db: ObjectDb,
    private readonly graph: CommitGraph | null,
  ) {}

  /** True when a commit-graph was parsed; `WalkPage.graphAvailable` reflects it. */
  get graphAvailable(): boolean {
    return this.graph !== null;
  }

  async meta(oid: Oid): Promise<CommitMeta | null> {
    const cached = this.metas.get(oid);
    if (cached !== undefined) return cached;
    const fromGraph = this.graph?.get(oid);
    const meta: CommitMeta | null = fromGraph
      ? { parents: fromGraph.parents, time: fromGraph.commitTime }
      : await this.fromObject(oid);
    this.metas.set(oid, meta);
    return meta;
  }

  /** `meta(oid) !== null`, spelled for the places that only need the type check. */
  async isCommit(oid: Oid): Promise<boolean> {
    return (await this.meta(oid)) !== null;
  }

  private async fromObject(oid: Oid): Promise<CommitMeta | null> {
    // A commit-graph never lists a non-commit, so the type check only costs the fallback path.
    if ((await this.db.objectType(oid)) !== "commit") return null;
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
 * Carried in the session's `WalkState` so page 2 draws the same picture page 1 would have.
 */
export type LaneTable = (Oid | null)[];

export interface LaneRow {
  lane: number;
  laneCount: number;
  edges: CommitEdge[];
  /** A lane past `maxLanes` was folded into the last one (T10.5b nit 4). */
  overflow: boolean;
}

export interface PlaceOptions {
  /**
   * Commits already emitted on this or an earlier page. A parent in this set gets no lane and no
   * edge: its line closed rows ago, so an edge into it is one the SVG can never finish (T10.5b S1).
   */
  emitted?: ReadonlySet<Oid>;
  /** Default `MAX_LANES`. */
  maxLanes?: number;
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
 *
 * Lanes are capped at `maxLanes`: everything that would open lane 13 shares lane 12 instead and the
 * row reports `overflow`, which `WalkPage.laneOverflow` surfaces so the UI can offer `first-parent`
 * rather than drawing a picture nobody can read (atlas tab 03 "Risks").
 */
export function placeCommit(
  lanes: LaneTable,
  commit: { oid: Oid; parents: Oid[] },
  firstParent: boolean,
  opts: PlaceOptions = {},
): LaneRow {
  const maxLanes = Math.max(1, opts.maxLanes ?? MAX_LANES);
  const emitted = opts.emitted;
  let overflow = false;

  /** The lane a new reservation goes in, folding everything past `maxLanes` into the last one. */
  const reserve = (preferred: number, oid: Oid): number => {
    if (preferred < maxLanes) {
      lanes[preferred] = oid;
      return preferred;
    }
    overflow = true;
    const last = maxLanes - 1;
    if (lanes[last] == null) lanes[last] = oid; // free: the fold gets a real reservation
    return last; // otherwise the lane is shared and the line is drawn over its neighbour's
  };

  let lane = lanes.indexOf(commit.oid);
  if (lane === -1) lane = reserve(firstFree(lanes), commit.oid); // a tip: nothing pointed at it yet
  const before = lanes.slice();

  const considered = firstParent ? commit.parents.slice(0, 1) : commit.parents;
  const parents = emitted ? considered.filter((p) => !emitted.has(p)) : considered;

  if (lanes[lane] === commit.oid) lanes[lane] = null; // the node consumes its lane …
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
    // … which the first parent usually takes straight back.
    parentLanes[k] = reserve(k === 0 && lanes[lane] == null ? lane : firstFree(lanes), parent);
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
  return { lane, laneCount: Math.min(laneCount, maxLanes), edges, overflow };
}

// ---- the walk -----------------------------------------------------------------------------

export interface WalkDeps {
  db: ObjectDb;
  reader: CommitReader;
  /** oid → the ref names that point at it, already in badge order. */
  refsByCommit: Map<Oid, string[]>;
  signal?: AbortSignal;
  /** Called every `PROGRESS_EVERY` commits discovered, so a long walk is not silent (T10.5b S5). */
  onProgress?: (walked: number) => void;
}

/** Commits discovered between two `"history"` progress messages (T10.5b S5). */
export const PROGRESS_EVERY = 500;

interface Entry {
  oid: Oid;
  time: number;
  ctr: number;
}

interface WalkNode {
  meta: CommitMeta;
  follow: Oid[];
  visible: boolean;
}

/**
 * Everything a page boundary has to remember. T10.5b S4: this lives in the session under an opaque
 * token instead of being serialised into the cursor, which was O(commits walked) bytes per page.
 * It holds `Set`/`Map`s and is never structured-cloned.
 */
export interface WalkState {
  /** Request signature: a token is only valid for the request that produced it. */
  key: string;
  ctr: number;
  /** Eligible (indegree 0), date-ordered newest first, ties by `ctr`. */
  frontier: Entry[];
  /** Discovered but not yet expanded, same order — the discovery half of git's two passes. */
  pending: Entry[];
  seen: Set<Oid>;
  explored: Set<Oid>;
  queued: Set<Oid>;
  emitted: Set<Oid>;
  /** oid → how many explored-but-unemitted commits still name it as a parent (git's indegree). */
  blocked: Map<Oid, number>;
  nodes: Map<Oid, WalkNode>;
  lanes: LaneTable;
  capped: boolean;
}

export interface WalkOutcome {
  page: WalkPage;
  warnings: RepoWarning[];
  /** Null when the walk is finished (or capped): there is no next page. */
  state: WalkState | null;
}

/** The signature a `WalkState` is valid for; the session compares it before resuming a token. */
export function walkRequestKey(req: WalkRequest, seeds: Oid[]): string {
  return JSON.stringify([seeds, req.firstParent === true, req.all === true, req.path ?? null]);
}

/** Newest first; equal dates keep insertion order, which is git's `prio_queue` tie-break. */
function insertEntry(queue: Entry[], entry: Entry): void {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const other = queue[mid] as Entry;
    const before = other.time > entry.time || (other.time === entry.time && other.ctr < entry.ctr);
    if (before) lo = mid + 1;
    else hi = mid;
  }
  queue.splice(lo, 0, entry);
}

/** nit 5: a limit that is not a positive integer is a caller bug, not something to round away. */
function checkedLimit(limit: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || Math.floor(limit) !== limit)
    throw new EngineError("INTERNAL", "walkCommits: limit must be an integer.", {
      detail: String(limit),
    });
  if (limit <= 0)
    throw new EngineError("INTERNAL", "walkCommits: limit must be greater than zero.", {
      detail: String(limit),
    });
  return Math.min(limit, MAX_WALK);
}

/**
 * One page of history, ordered exactly like `git log --date-order`.
 *
 * `--date-order` is git's *topological* order with a commit-date tie-break (revision.c sets
 * `topo_order` for it), so a commit is never shown before all of its children. git gets that by
 * building the whole candidate list first; this walk builds a window of it — `limit + LOOKAHEAD`
 * commits are discovered (and their indegrees counted) before the first of them is released — and
 * then releases exactly as git does: newest first, ties going to whichever became eligible first.
 *
 * `seeds` are already-resolved commit oids in the order git would list the refs (the session sorts
 * them by ref name for `all`, and drops any that is not a commit — T10.5b B1).
 */
export async function walkCommits(
  deps: WalkDeps,
  req: WalkRequest,
  seeds: Oid[],
  resume?: WalkState | null,
): Promise<WalkOutcome> {
  const { db, reader, refsByCommit, signal } = deps;
  const limit = checkedLimit(req.limit);
  const key = walkRequestKey(req, seeds);

  const state: WalkState = resume ?? {
    key,
    ctr: 0,
    frontier: [],
    pending: [],
    seen: new Set<Oid>(),
    explored: new Set<Oid>(),
    queued: new Set<Oid>(),
    emitted: new Set<Oid>(),
    blocked: new Map<Oid, number>(),
    nodes: new Map<Oid, WalkNode>(),
    lanes: [],
    capped: false,
  };

  /** Parents to follow and whether the row is shown; null when the oid is not a commit. */
  const nodeOf = async (oid: Oid): Promise<WalkNode | null> => {
    const cached = state.nodes.get(oid);
    if (cached) return cached;
    const meta = await reader.meta(oid);
    if (meta === null) return null; // a tag on a blob or a tree: git log --all skips it
    const step = req.path
      ? await simplifyPath(db, oid, meta.parents, req.path, req.firstParent === true)
      : {
          visible: true,
          follow: req.firstParent === true ? meta.parents.slice(0, 1) : meta.parents,
        };
    const node: WalkNode = { meta, ...step };
    state.nodes.set(oid, node);
    return node;
  };

  /** False when the oid is not a commit (a tag on a blob or a tree): it never enters the walk. */
  const discover = async (oid: Oid): Promise<boolean> => {
    if (state.seen.has(oid)) return true;
    const node = await nodeOf(oid);
    if (node === null) return false; // git log --all skips such a ref
    state.seen.add(oid);
    insertEntry(state.pending, { oid, time: node.meta.time, ctr: state.ctr++ });
    return true;
  };

  /** A commit whose indegree has reached zero joins the release queue. */
  const enqueue = (oid: Oid, node: WalkNode): void => {
    if (state.queued.has(oid)) return;
    state.queued.add(oid);
    insertEntry(state.frontier, { oid, time: node.meta.time, ctr: state.ctr++ });
  };
  const maybeEnqueue = async (oid: Oid): Promise<void> => {
    if (!state.explored.has(oid) || state.queued.has(oid)) return;
    if ((state.blocked.get(oid) ?? 0) > 0) return;
    const node = await nodeOf(oid);
    if (node !== null) enqueue(oid, node);
  };

  let progressed = state.explored.size;
  /** git's `limit_list`: expand one commit, counting the indegree of every parent it follows. */
  const exploreOne = async (): Promise<void> => {
    const entry = state.pending.shift() as Entry;
    const oid = entry.oid;
    state.explored.add(oid);
    const node = await nodeOf(oid);
    if (node !== null) {
      for (const parent of node.follow) {
        if (!(await discover(parent))) continue;
        // A parent already emitted cannot be held back by a child found later; that is the one
        // place a windowed indegree can still differ from git's whole-list one.
        if (state.emitted.has(parent)) continue;
        state.blocked.set(parent, (state.blocked.get(parent) ?? 0) + 1);
      }
    }
    await maybeEnqueue(oid);
    if (state.explored.size - progressed >= PROGRESS_EVERY) {
      progressed = state.explored.size;
      deps.onProgress?.(state.explored.size);
    }
  };

  /**
   * Keep at least `limit + LOOKAHEAD` discovered-but-unemitted commits ahead of the release point,
   * and never release while the frontier is empty but discovery could still fill it.
   */
  const ensureWindow = async (): Promise<void> => {
    while (state.pending.length > 0 && !state.capped) {
      throwIfAborted(signal, "history walk");
      const ahead = state.explored.size - state.emitted.size;
      if (ahead >= limit + LOOKAHEAD && state.frontier.length > 0) return;
      if (state.explored.size >= MAX_WALK) {
        state.capped = true;
        return;
      }
      await exploreOne();
    }
  };

  if (!resume) {
    for (const oid of seeds) await discover(oid);
  }

  const commits: CommitSummary[] = [];
  let laneOverflow = false;
  while (commits.length < limit) {
    throwIfAborted(signal, "history walk");
    await ensureWindow();
    if (state.frontier.length === 0) break;
    const entry = state.frontier.shift() as Entry;
    // A child discovered after this commit became eligible put it back under an indegree; git's
    // whole-list pass would never have queued it, so neither do we (it returns when they release).
    if ((state.blocked.get(entry.oid) ?? 0) > 0) {
      state.queued.delete(entry.oid);
      continue;
    }
    state.emitted.add(entry.oid);
    const node = await nodeOf(entry.oid);
    if (node === null) continue;
    if (node.visible) {
      // A path-filtered walk skips commits, so a lane reserved for a parent that is never emitted
      // would hang around for ever: the graph column belongs to the unfiltered list (Design §14.5),
      // and file history draws its own (T10.6). Lanes are therefore only assigned without `path`.
      const row = req.path
        ? null
        : placeCommit(
            state.lanes,
            { oid: entry.oid, parents: node.meta.parents },
            req.firstParent === true,
            { emitted: state.emitted, maxLanes: MAX_LANES },
          );
      if (row?.overflow === true) laneOverflow = true;
      commits.push(await summarise(db, entry.oid, node.meta, refsByCommit, row));
    }
    for (const parent of node.follow) {
      if (!state.seen.has(parent)) continue;
      const left = state.blocked.get(parent);
      if (left !== undefined) {
        if (left > 1) state.blocked.set(parent, left - 1);
        else state.blocked.delete(parent);
      }
      await maybeEnqueue(parent);
    }
  }
  deps.onProgress?.(state.explored.size);

  const exhausted = state.frontier.length === 0 && state.pending.length === 0;
  const warnings: RepoWarning[] = state.capped
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
      cursor: null, // the session replaces this with its token (T10.5b S4)
      graphAvailable: reader.graphAvailable,
      capped: state.capped,
      laneOverflow,
    },
    warnings,
    state: exhausted || state.capped ? null : state,
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
 * Every commit reachable from `tips`, up to `cap`. A tip that is not a commit (a tag on a blob) is
 * skipped, exactly as `git rev-list --all` skips it. Memoised by the caller (the session keys the
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
    throwIfAborted(signal, "reachability walk");
    if (oids.has(tip)) continue;
    if (!(await reader.isCommit(tip))) continue;
    oids.add(tip);
    stack.push(tip);
  }
  while (stack.length > 0) {
    throwIfAborted(signal, "reachability walk");
    if (oids.size >= cap) return { oids, capped: true };
    const oid = stack.pop() as Oid;
    const meta = await reader.meta(oid);
    if (meta === null) continue;
    for (const parent of meta.parents) {
      if (oids.has(parent)) continue;
      oids.add(parent);
      stack.push(parent);
    }
  }
  return { oids, capped: false };
}

export interface AheadBehindOptions {
  /** Commits walked before the counts become lower bounds; default `AHEAD_BEHIND_CAP`. */
  cap?: number;
  signal?: AbortSignal;
}

const LEFT = 1;
const RIGHT = 2;
const BOTH = LEFT | RIGHT;

/**
 * `git rev-list --left-right --count a...b`: `ahead` counts commits reachable from `a` and not from
 * `b`, `behind` the other way round.
 *
 * T10.5b S3: this is git's own algorithm, not two truncated reachability sets. One date-ordered
 * priority queue is seeded `LEFT` and `RIGHT`; popping newest first means every flag a commit can
 * get has arrived by the time it is popped (the invariant `--date-order` rests on), a commit that
 * carries both flags is COMMON and is counted for neither side, and the walk stops the moment
 * nothing but COMMON commits is left — revision.c's `still_interesting` /
 * `everybody_uninteresting`. Two branches off a 10,000-commit trunk therefore cost a walk of their
 * divergence, not of the trunk, and the counts are exact where the old version was arbitrary.
 *
 * `capped` means `cap` commits were walked before that happened; the counts are then lower bounds.
 */
export async function aheadBehind(
  db: ObjectDb,
  reader: CommitReader,
  a: Oid,
  b: Oid,
  opts: AheadBehindOptions = {},
): Promise<{ ahead: number; behind: number; mergeBase: Oid | null; capped: boolean }> {
  const { signal } = opts;
  const cap = opts.cap ?? AHEAD_BEHIND_CAP;
  const base = await db.findMergeBase(a, b);
  if (a === b) return { ahead: 0, behind: 0, mergeBase: base.oid, capped: false };

  const flags = new Map<Oid, number>();
  const queue: Entry[] = [];
  const inQueue = new Set<Oid>();
  let ctr = 0;
  let interesting = 0;

  const push = async (oid: Oid, flag: number): Promise<void> => {
    const previous = flags.get(oid) ?? 0;
    const next = previous | flag;
    if (next === previous) return; // nothing new to propagate
    flags.set(oid, next);
    if (!inQueue.has(oid)) {
      const meta = await reader.meta(oid);
      if (meta === null) return; // not a commit: never a seed of a real range
      inQueue.add(oid);
      insertEntry(queue, { oid, time: meta.time, ctr: ctr++ });
      if (next !== BOTH) interesting++;
    } else if (next === BOTH) {
      interesting--; // already queued on one side, now common: no longer worth walking for
    }
  };

  await push(a, LEFT);
  await push(b, RIGHT);

  let ahead = 0;
  let behind = 0;
  let walked = 0;
  let capped = false;
  while (queue.length > 0 && interesting > 0) {
    throwIfAborted(signal, "ahead/behind");
    if (walked >= cap) {
      capped = true;
      break;
    }
    const entry = queue.shift() as Entry;
    walked++;
    inQueue.delete(entry.oid);
    const flag = flags.get(entry.oid) as number;
    if (flag !== BOTH) {
      interesting--;
      if (flag === LEFT) ahead++;
      else behind++;
    }
    const meta = await reader.meta(entry.oid);
    if (meta === null) continue;
    for (const parent of meta.parents) await push(parent, flag);
  }
  return { ahead, behind, mergeBase: base.oid, capped };
}
