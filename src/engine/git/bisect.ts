/**
 * Bisect stepping (T10.11, atlas tab 15; Design §14). Given what the user has marked good, bad and
 * skipped, name the commit to test next and how many rounds are left. Nothing is written: the page
 * shows a `git checkout` command, the user runs their own test, and the strip halves (D16).
 *
 * The midpoint is git's, from `bisect.c`:
 *
 *  * the candidate set is `git rev-list <bad> ^<good>…` — reachable from `bad`, not from any
 *    `good`; `revListOrder` below produces it in git's own order (a commit-date priority queue,
 *    newest first, ties by insertion, exactly `commit_list_insert_by_date` + `limit_list`);
 *  * `find_bisection` **reverses** that list before it weighs anything, so the scan runs
 *    oldest-first and a tie goes to the oldest commit — that is why `git rev-list --bisect` over 59
 *    linear commits answers the commit of weight 29 and not the one of weight 30, both of which
 *    score `min(w, 59 − w) = 29`;
 *  * `weight(c)` is how many candidates `c` reaches (itself included) and the commit picked is the
 *    one with the largest `min(weight, total − weight)`, the first such in that reversed order.
 *
 * Two documented divergences from `bisect.c`:
 *
 *  * git's `halfway()` short-circuit is not replicated. It returns the first commit whose weight is
 *    within one of half the set *as the weights are being filled in*, which is always a commit of
 *    maximal distance — the same distance the full scan finds — but in a merge-heavy tie it can be
 *    a different commit of that distance. The full scan is deterministic and easier to explain.
 *  * `skipped` commits are removed from the *count*, per the T10.11 brief, not handled the way
 *    `git bisect skip` does it (git keeps them in the list, then picks a nearby replacement with a
 *    PRNG — `get_prn` in `bisect.c`, which is not reproducible from the outside). They stay in the
 *    graph so the strands they sit on are not cut, they are never returned as `candidate`, and
 *    they do not count towards `remaining` or any weight.
 */
import { EngineError } from "../errors";
import type { BisectState, BisectStep, Oid, RepoWarning } from "../types";
import { throwIfAborted } from "../util/concurrency";
import { type CommitReader, MAX_WALK, reachableFrom } from "./walk";

/** One entry of the date-ordered queue `revListOrder` pops from (git's `prio_queue`). */
interface RevEntry {
  oid: Oid;
  /** Committer date, epoch seconds — the key `git rev-list` sorts on. */
  time: number;
  ctr: number;
}

/** Newest first; equal dates keep insertion order, git's `commit_list_insert_by_date` tie-break. */
function insertByDate(queue: RevEntry[], entry: RevEntry): void {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const other = queue[mid] as RevEntry;
    const before = other.time > entry.time || (other.time === entry.time && other.ctr < entry.ctr);
    if (before) lo = mid + 1;
    else hi = mid;
  }
  queue.splice(lo, 0, entry);
}

export interface RevListOptions {
  /** Commits listed before the walk gives up; default `MAX_WALK`. */
  cap?: number;
  signal?: AbortSignal;
}

export interface RevListResult {
  /** `git rev-list` order: newest first, ties by discovery. */
  oids: Oid[];
  capped: boolean;
}

/**
 * `git rev-list <tips…> ^<excluded…>`, in git's default order.
 *
 * `exclude` is a reachability set the caller already has (`reachableFrom`), which is how git's own
 * `limit_list` prunes: a commit painted UNINTERESTING is neither listed nor expanded. Shared with
 * `preflight.ts`, whose `mergeBase..branch` range is the same walk.
 */
export async function revListOrder(
  reader: CommitReader,
  tips: Oid[],
  exclude: ReadonlySet<Oid>,
  opts: RevListOptions = {},
): Promise<RevListResult> {
  const cap = opts.cap ?? MAX_WALK;
  const { signal } = opts;
  const queue: RevEntry[] = [];
  const seen = new Set<Oid>();
  const oids: Oid[] = [];
  let ctr = 0;
  const push = async (oid: Oid): Promise<void> => {
    if (seen.has(oid) || exclude.has(oid)) return;
    const meta = await reader.meta(oid);
    if (meta === null) return; // a tag on a blob is not a commit git would walk (T10.5b B1)
    seen.add(oid);
    insertByDate(queue, { oid, time: meta.time, ctr: ctr++ });
  };
  for (const tip of tips) {
    throwIfAborted(signal, "revision range walk");
    await push(tip);
  }
  while (queue.length > 0) {
    throwIfAborted(signal, "revision range walk");
    if (oids.length >= cap) return { oids, capped: true };
    const entry = queue.shift() as RevEntry;
    oids.push(entry.oid);
    const meta = await reader.meta(entry.oid);
    if (meta === null) continue;
    for (const parent of meta.parents) await push(parent);
  }
  return { oids, capped: false };
}

export interface BisectDeps {
  reader: CommitReader;
  /** Commits walked per side before the answer becomes approximate; default `MAX_WALK`. */
  cap?: number;
  signal?: AbortSignal;
  warn?: (w: RepoWarning) => void;
}

/**
 * The next commit to test, the number of suspects left, and `ceil(log2)` of that — or, once at most
 * one suspect is left, the first bad commit.
 */
export async function bisectStep(deps: BisectDeps, state: BisectState): Promise<BisectStep> {
  const { reader, signal } = deps;
  const cap = deps.cap ?? MAX_WALK;
  if (!(await reader.isCommit(state.bad)))
    throw new EngineError("REV_NOT_FOUND", `${state.bad.slice(0, 7)} is not a commit.`, {
      hint: "Mark a commit as bad before stepping",
    });

  const good = await reachableFrom(reader, state.good, cap, signal);
  const range = await revListOrder(reader, [state.bad], good.oids, { cap, signal });
  if (good.capped || range.capped) {
    deps.warn?.({
      code: "HISTORY_CAPPED",
      message: `Bisect looked at the newest ${cap.toLocaleString("en")} commits only; the step count is a lower bound.`,
      detail: good.capped ? "good-side reachability" : "candidate list",
    });
  }

  // git reverses the candidate list before weighing it (`find_bisection`), so the scan is
  // oldest-first and a tie goes to the oldest commit.
  const list = range.oids.slice().reverse();
  const inSet = new Set(list);
  const skipped = new Set(state.skipped.filter((oid) => inSet.has(oid)));
  const candidates = list.filter((oid) => !skipped.has(oid));
  const remaining = candidates.length;
  if (remaining === 0) return { candidate: null, remaining: 0, steps: 0, firstBad: state.bad };
  if (remaining === 1)
    return { candidate: null, remaining: 1, steps: 0, firstBad: candidates[0] as Oid };

  const weights = await computeWeights(deps, list, inSet, skipped);
  let best: Oid | null = null;
  let bestDistance = -1;
  for (const oid of list) {
    if (skipped.has(oid)) continue;
    const w = weights.get(oid) ?? 0;
    const distance = Math.min(w, remaining - w);
    if (distance > bestDistance) {
      bestDistance = distance;
      best = oid;
    }
  }
  return { candidate: best, remaining, steps: Math.ceil(Math.log2(remaining)), firstBad: null };
}

/**
 * `weight(c)` per candidate: how many *countable* commits `c` reaches inside the candidate graph,
 * itself included. Skipped commits are traversed but not counted, so removing one from the middle
 * of a strand does not disconnect its ancestors.
 *
 * The three passes are git's: roots get their own weight, merges pay for a full `count_distance`
 * walk (ancestor sets overlap, so a merge's weight is not the sum of its parents'), and everything
 * with a single in-set parent is filled in as `weight(parent) + 1` — the cheap "single strand of
 * pearls" case. The fill loop repeats because the list is in date order, which is not guaranteed
 * to be topological.
 */
async function computeWeights(
  deps: BisectDeps,
  list: Oid[],
  inSet: ReadonlySet<Oid>,
  skipped: ReadonlySet<Oid>,
): Promise<Map<Oid, number>> {
  const { reader, signal } = deps;
  const self = (oid: Oid): number => (skipped.has(oid) ? 0 : 1);
  const parentsIn = new Map<Oid, Oid[]>();
  for (const oid of list) {
    throwIfAborted(signal, "bisect weighting");
    const meta = await reader.meta(oid);
    parentsIn.set(
      oid,
      (meta?.parents ?? []).filter((p) => inSet.has(p)),
    );
  }

  const weights = new Map<Oid, number>();
  const merges: Oid[] = [];
  for (const oid of list) {
    const parents = parentsIn.get(oid) as Oid[];
    if (parents.length === 0) weights.set(oid, self(oid));
    else if (parents.length > 1) merges.push(oid);
  }
  for (const oid of merges) {
    throwIfAborted(signal, "bisect weighting");
    weights.set(oid, countDistance(oid, parentsIn, skipped));
  }
  while (weights.size < list.length) {
    throwIfAborted(signal, "bisect weighting");
    let filled = 0;
    for (const oid of list) {
      if (weights.has(oid)) continue;
      const parent = (parentsIn.get(oid) as Oid[]).find((p) => weights.has(p));
      if (parent === undefined) continue;
      weights.set(oid, (weights.get(parent) as number) + self(oid));
      filled++;
    }
    if (filled > 0) continue;
    // Unreachable for a DAG, but a corrupt graph must not spin: pay for the exact count instead.
    for (const oid of list) {
      if (!weights.has(oid)) weights.set(oid, countDistance(oid, parentsIn, skipped));
    }
  }
  return weights;
}

/** git's `count_distance`: countable commits reachable from `start` inside the candidate graph. */
function countDistance(
  start: Oid,
  parentsIn: ReadonlyMap<Oid, Oid[]>,
  skipped: ReadonlySet<Oid>,
): number {
  const seen = new Set<Oid>([start]);
  const stack: Oid[] = [start];
  let n = 0;
  while (stack.length > 0) {
    const oid = stack.pop() as Oid;
    if (!skipped.has(oid)) n++;
    for (const parent of parentsIn.get(oid) ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push(parent);
    }
  }
  return n;
}
