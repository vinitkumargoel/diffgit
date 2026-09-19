/**
 * Blame (T10.6; atlas tab 02, the feature developers name most often when asked why they open a
 * GUI). Reverse-diffing, the way `git blame` itself works:
 *
 *   1. take the newest content — the working-tree file when it is dirty and the caller asked for it,
 *      otherwise the blob at `ref`;
 *   2. walk the path history (`git/pathHistory.ts`, renames followed) newest → oldest and diff each
 *      revision against the one below it with `lineDiff`, the same Myers implementation the diff
 *      pane uses;
 *   3. a line the diff calls an addition was written by that commit, so it is attributed with the
 *      line number and the file name **that commit** had; a line that survives stays unassigned and
 *      moves to its position on the older side;
 *   4. stop as soon as nothing is unassigned (the common case after a handful of revisions) or when
 *      the history runs out — which attributes what is left to the oldest revision seen. A history
 *      the caller cut at `maxRevisions` ends the same way and reports `BLAME_CAPPED`, rather than
 *      walking a changelog to its root.
 *
 * Only two revisions are ever decoded at once (atlas tab 02 "Risks": memory), and with
 * `ignoreWhitespace` every diff compares `-w` keys, so a reindent commit changes nothing and steals
 * no attribution — `fixtures/history/expected/blame-src-indent-w.txt` is exactly that case.
 */
import { EngineError } from "../errors";
import type { ObjectDb } from "../git/objectDb";
import type {
  BlameLine,
  BlamePayload,
  Oid,
  PathHistoryEntry,
  RepoWarning,
  Signature,
} from "../types";
import { throwIfAborted } from "../util/concurrency";
import { HUGE_FILE_BYTES, type LineOp, lineDiff, lineKeys, splitLines } from "./textDiff";

/** Default revision cap; the UI offers a "continue" past it (atlas tab 02 "Risks"). */
export const DEFAULT_MAX_REVISIONS = 500;

export interface BlameOptions {
  ignoreWhitespace: boolean;
  includeWorktree: boolean;
  maxRevisions: number;
}

export interface BlameDeps {
  db: ObjectDb;
  /** The path history, newest first, renames followed (`pathHistory({ follow: true })`). */
  entries: PathHistoryEntry[];
  /** True when that list was cut at `maxRevisions` rather than exhausted. */
  historyCapped: boolean;
  /** The working-tree bytes of `path`, or null when it is absent / unreadable. */
  readWorktree?: (path: string) => Promise<Uint8Array | null>;
  /** `done`/`total` per revision (progress phase `"blame"`). */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface BlameOutcome {
  payload: BlamePayload;
  warnings: RepoWarning[];
}

/** One line of the newest content that has not been given an origin yet. */
interface Pending {
  /** 0-based index in the newest content (the line the UI renders). */
  final: number;
  /** 0-based index in the revision currently under consideration. */
  cur: number;
}

const decoder = new TextDecoder("utf-8");

/**
 * Carries the unassigned lines from the newer side of one diff to the older side.
 *
 * `ops` covers both sides in order and `pending` is ascending by `cur`, so one pass over each is
 * enough. A line inside an `eq` run existed already and moves to its index on the old side; a line
 * inside an `add` run is new in this revision and `onAdded` attributes it.
 */
function carryBack(ops: LineOp[], pending: Pending[], onAdded: (p: Pending) => void): Pending[] {
  const kept: Pending[] = [];
  let i = 0;
  for (const op of ops) {
    if (op.type === "del") continue;
    const end = op.newStart + op.count;
    while (i < pending.length && (pending[i] as Pending).cur < end) {
      const p = pending[i] as Pending;
      i++;
      if (p.cur < op.newStart) continue; // cannot happen for a well-formed script; skip defensively
      if (op.type === "eq") kept.push({ final: p.final, cur: op.oldStart + (p.cur - op.newStart) });
      else onAdded(p);
    }
  }
  for (; i < pending.length; i++) kept.push(pending[i] as Pending); // empty script: nothing moved
  return kept;
}

/** Bytes of the blob `path` had at `commit`; null when the path is absent or not a regular file. */
async function revisionBytes(db: ObjectDb, commit: Oid, path: string): Promise<Uint8Array | null> {
  const entry = (await db.flattenTree(commit))[path];
  if (!entry || (entry.mode & 0o170000) !== 0o100000) return null;
  return db.readBlob(entry.oid);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Attributes every line of `path` at `ref` to the commit that introduced it.
 *
 * `deps.entries` is the path history the caller already resolved — the session owns paging, caching
 * and the `maxRevisions` cut, so this function only has to reverse-diff what it is handed.
 */
export async function blame(
  deps: BlameDeps,
  ref: string,
  path: string,
  opts: BlameOptions,
): Promise<BlameOutcome> {
  const { db, entries } = deps;
  const warnings: RepoWarning[] = [];
  const commits: Record<Oid, { author: Signature; subject: string }> = {};
  const nothing = (): BlameOutcome => ({
    payload: { path, ref, lines: [], commits, revisions: 0, capped: false },
    warnings,
  });
  if (entries.length === 0) return nothing();

  const head = entries[0] as PathHistoryEntry;
  const headBytes = await revisionBytes(db, head.oid, head.path);
  if (headBytes === null) return nothing(); // the newest revision deleted the file

  // The working-tree file wins when it differs: its new lines are "you, uncommitted" (oid null).
  let newest = headBytes;
  let worktreeStep = false;
  if (opts.includeWorktree && deps.readWorktree) {
    const bytes = await deps.readWorktree(path);
    if (bytes !== null && !sameBytes(bytes, headBytes)) {
      newest = bytes;
      worktreeStep = true;
    }
  }
  if (newest.byteLength > HUGE_FILE_BYTES)
    throw new EngineError("TOO_LARGE", `${path} is larger than 10 MB; blame is not computed.`, {
      hint: "Open the file in your editor",
    });

  const newestSet = splitLines(decoder.decode(newest));
  const lines: BlameLine[] = newestSet.lines.map((_, i) => ({
    line: i + 1,
    oid: null,
    origLine: i + 1,
    origPath: path,
  }));
  let pending: Pending[] = newestSet.lines.map((_, i) => ({ final: i, cur: i }));

  const total = entries.length + (worktreeStep ? 1 : 0);
  let done = 0;
  const tick = () => {
    done++;
    deps.onProgress?.(done, total);
  };
  const keys = (bytes: Uint8Array) =>
    lineKeys(splitLines(decoder.decode(bytes)), opts.ignoreWhitespace);

  // Step 0: the working-tree edit, whose additions nobody has committed yet.
  if (worktreeStep) {
    throwIfAborted(deps.signal, "blame");
    pending = carryBack(lineDiff(keys(headBytes), keys(newest)), pending, (p) => {
      const row = lines[p.final] as BlameLine;
      row.oid = null;
      row.origLine = p.cur + 1;
      row.origPath = path;
    });
    tick();
  }

  let revisions = 0;
  let exhausted = false;
  let newerBytes = headBytes;
  for (let i = 0; i < entries.length && pending.length > 0; i++) {
    throwIfAborted(deps.signal, "blame");
    const entry = entries[i] as PathHistoryEntry;
    revisions++;
    commits[entry.oid] = { author: entry.author, subject: entry.subject };
    const attribute = (p: Pending) => {
      const row = lines[p.final] as BlameLine;
      row.oid = entry.oid;
      row.origLine = p.cur + 1;
      row.origPath = entry.path;
    };
    const next = entries[i + 1];
    const olderBytes = next === undefined ? null : await revisionBytes(db, next.oid, next.path);
    if (olderBytes === null) {
      // Nothing older to compare against — the add, the root, a delete below a re-add, or the
      // `maxRevisions` cut. Everything still unassigned was already there, so this commit keeps it.
      for (const p of pending) attribute(p);
      pending = [];
      exhausted = true;
      tick();
      break;
    }
    // A revision that changes nothing under `-w` maps 1:1 and attributes nothing (git's `-w`).
    if (!(opts.ignoreWhitespace && entry.whitespaceOnly))
      pending = carryBack(lineDiff(keys(olderBytes), keys(newerBytes)), pending, attribute);
    newerBytes = olderBytes;
    tick();
  }

  const capped = deps.historyCapped && exhausted;
  if (capped)
    warnings.push({
      code: "BLAME_CAPPED",
      message: `Blame stopped after ${opts.maxRevisions} revisions of ${path}; the oldest lines are attributed to the last one examined.`,
      detail: path,
    });

  // Drop revisions that were examined but never ended up owning a line.
  const used = new Set(lines.map((l) => l.oid).filter((o): o is Oid => o !== null));
  for (const oid of Object.keys(commits)) if (!used.has(oid)) delete commits[oid];

  return { payload: { path, ref, lines, commits, revisions, capped }, warnings };
}
