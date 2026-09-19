/**
 * Rebase preflight (T10.11, atlas tab 16; Design §14). "Will this rebase conflict?" answered from
 * the object database alone: the commits that would be replayed, which of them touch a file the
 * onto side also touched, the exact `git rebase -i` command, and the todo list to paste. Nothing is
 * written — the todo is text on the clipboard (D16).
 *
 * How a row is graded. A rebase replays each commit as a patch, so both sides are read as patches:
 *
 *  * the row's own change is `commit` vs its **first parent** (the patch git would apply);
 *  * an onto-side commit's change is that commit vs **its** first parent, which is also what names
 *    the `theirs` oid the UI shows ("77b2e10 edited lines 40–46; you edited 41–44");
 *  * both sets of line ranges are the **old side** of `computeHunks(context: 0)` — the pre-image
 *    region the three-way merge has to reconcile — read in each patch's own coordinates, which
 *    agree with the merge base's wherever neither side changed the line count above the other's
 *    hunk. That is an approximation, and the prediction is a heuristic on purpose: overlapping or
 *    adjacent (≤ `ADJACENT_LINES`) ranges are `likely`, the same file at disjoint ranges is
 *    `possible`, and a path the onto side never touched is `clean`. `clean` is trustworthy — a
 *    textual conflict needs both sides to touch the file — and `possible` is the honest middle.
 *
 * The brief's phrasing was "`computeHunks` of each side vs the merge base", i.e. per **path** at
 * the two tips. That cannot produce the answer the fixture records: `preflight/a`'s p2 keeps p1's
 * edit to the top of `src/hot.txt`, so tip-vs-base ranges would grade p2 `likely`, while the real
 * `git rebase --onto main p2^ p2` recorded in `expected/preflight-outcome.txt` applies it cleanly.
 * Per-commit patches reproduce the recorded outcome (likely / possible / clean); the merge base is
 * still what bounds both ranges and what `rows` and `ontoAdvanced` are counted from.
 *
 * Renames are mapped through `detectRenames` between the merge base and each tip, so a file the
 * onto side renamed still matches the name the replayed commit uses. `overlaps[].path` is always
 * the branch-side name — the one in the row's own diff.
 */
import { isBinary } from "../diff/binary";
import { detectRenames } from "../diff/renames";
import { computeHunks, HUGE_FILE_BYTES } from "../diff/textDiff";
import { treeDiff } from "../diff/treeDiff";
import {
  type FileDiff,
  MODE_GITLINK,
  type Oid,
  type PreflightResult,
  type PreflightRow,
  type RepoWarning,
} from "../types";
import { throwIfAborted } from "../util/concurrency";
import { revListOrder } from "./bisect";
import type { ObjectDb } from "./objectDb";
import { type CommitReader, MAX_WALK, reachableFrom, subjectOf } from "./walk";
import type { Change } from "./worktree";

/** Commits read per side before the report says so (`HISTORY_CAPPED`); a rebase this long is a mistake. */
export const PREFLIGHT_COMMIT_CAP = 500;
/** Ranges this close on the two sides are `likely`; git's merge needs a common line between them. */
export const ADJACENT_LINES = 1;

/** A resolved end of the comparison: the oid to walk from and the name to print in `command`. */
export interface RevName {
  oid: Oid;
  display: string;
}

export interface PreflightDeps {
  db: ObjectDb;
  reader: CommitReader;
  /** `diff.renames` / `diff.renameLimit` from the repository's config. */
  renames?: boolean;
  renameLimit?: number;
  /** Commits read per side; default `PREFLIGHT_COMMIT_CAP`. */
  cap?: number;
  signal?: AbortSignal;
  warn?: (w: RepoWarning) => void;
}

/** Old-side line ranges of one patch, or why they could not be taken. */
type SideRanges =
  | { kind: "ranges"; ranges: [number, number][] }
  | { kind: "binary" }
  | { kind: "unreadable" };

/** One onto-side commit's change to one path, kept until a row asks for its ranges. */
interface OntoChange {
  oid: Oid;
  change: Change;
}

export async function rebasePreflight(
  deps: PreflightDeps,
  branch: RevName,
  onto: RevName,
): Promise<PreflightResult> {
  const { db, reader, signal } = deps;
  const cap = deps.cap ?? PREFLIGHT_COMMIT_CAP;
  const mergeBase = (await db.findMergeBase(branch.oid, onto.oid)).oid;
  if (mergeBase === null) {
    deps.warn?.({
      code: "UNRELATED_HISTORIES",
      message: `${branch.display} and ${onto.display} have no common ancestor; every commit would be replayed.`,
    });
  }
  const baseSet = mergeBase
    ? (await reachableFrom(reader, [mergeBase], MAX_WALK, signal)).oids
    : new Set<Oid>();

  const replayed = await revListOrder(reader, [branch.oid], baseSet, { cap, signal });
  const advanced = await revListOrder(reader, [onto.oid], baseSet, { cap, signal });
  if (replayed.capped || advanced.capped) {
    deps.warn?.({
      code: "HISTORY_CAPPED",
      message: `The preflight looked at the newest ${cap.toLocaleString("en")} commits per side only.`,
      detail: replayed.capped
        ? `${branch.display} since the merge base`
        : `${onto.display} since the merge base`,
    });
  }

  const blobs = new Map<Oid, Uint8Array | null>();
  const [branchRenames, ontoRenames] = await Promise.all([
    renameMap(deps, mergeBase, branch.oid, blobs),
    renameMap(deps, mergeBase, onto.oid, blobs),
  ]);

  // path at the merge base → the onto-side commits that changed it, newest first (walk order).
  const ontoByPath = new Map<string, OntoChange[]>();
  for (const oid of advanced.oids) {
    throwIfAborted(signal, "rebase preflight");
    for (const [path, change] of Object.entries(await changesOf(db, reader, oid))) {
      const key = ontoRenames.get(path) ?? path;
      const list = ontoByPath.get(key);
      if (list) list.push({ oid, change });
      else ontoByPath.set(key, [{ oid, change }]);
    }
  }

  const rows: PreflightRow[] = [];
  // Oldest first: the order a rebase replays them in, and the order the todo lists them in.
  for (const oid of replayed.oids.slice().reverse()) {
    throwIfAborted(signal, "rebase preflight");
    const commit = await db.readCommit(oid);
    const changes = await changesOf(db, reader, oid);
    const overlaps: PreflightRow["overlaps"] = [];
    for (const [path, change] of Object.entries(changes)) {
      const theirs = ontoByPath.get(branchRenames.get(path) ?? path);
      if (!theirs || theirs.length === 0) continue;
      const mine = await sideRanges(deps, change, blobs);
      let worst: { prediction: "likely" | "possible"; theirs: Oid } | null = null;
      for (const other of theirs) {
        const prediction = predict(mine, await sideRanges(deps, other.change, blobs));
        if (worst === null || (worst.prediction === "possible" && prediction === "likely")) {
          worst = { prediction, theirs: other.oid };
        }
        if (worst.prediction === "likely") break;
      }
      if (worst) overlaps.push({ path, prediction: worst.prediction, theirs: worst.theirs });
    }
    rows.push({
      oid,
      subject: subjectOf(commit.message),
      files: Object.keys(changes).length,
      merge: commit.parents.length > 1,
      signed: commit.gpgsig !== undefined,
      overlaps,
      prediction: overlaps.some((o) => o.prediction === "likely")
        ? "likely"
        : overlaps.length > 0
          ? "possible"
          : "clean",
    });
  }

  const hasMerge = rows.some((r) => r.merge);
  return {
    branch: branch.display,
    onto: onto.display,
    mergeBase,
    ontoAdvanced: advanced.oids.length,
    rows,
    command: hasMerge
      ? `git rebase -i --rebase-merges ${onto.display}`
      : `git rebase -i ${onto.display}`,
    // git's own todo separates the oneline with `# ` since 2.46; `pick <sha7> <subject>` is what
    // docs/v2-contracts.md fixes and what every git parses, so that is what the clipboard gets.
    todo:
      rows.length === 0
        ? ""
        : `${rows.map((r) => `pick ${r.oid.slice(0, 7)} ${r.subject}`).join("\n")}\n`,
  };
}

/** One commit against its first parent, path-level (a root against the empty tree). No blob reads. */
async function changesOf(
  db: ObjectDb,
  reader: CommitReader,
  oid: Oid,
): Promise<Record<string, Change>> {
  const meta = await reader.meta(oid);
  const parent = meta?.parents[0];
  const before = parent === undefined ? null : await db.flattenTree(parent);
  return treeDiff(before, await db.flattenTree(oid));
}

/**
 * `path at <tip>` → `path at <mergeBase>` for every file renamed on that side, so the two sides can
 * be matched on the name they shared at the base. Empty when `diff.renames` is off, when there is
 * no merge base, or when the side has no add/delete pair for the detector to consider.
 */
async function renameMap(
  deps: PreflightDeps,
  mergeBase: Oid | null,
  tip: Oid,
  blobs: Map<Oid, Uint8Array | null>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (deps.renames === false || mergeBase === null || mergeBase === tip) return out;
  const changes = treeDiff(await deps.db.flattenTree(mergeBase), await deps.db.flattenTree(tip));
  const rows: FileDiff[] = [];
  for (const [path, change] of Object.entries(changes)) {
    if (change.oldOid !== null && change.newOid !== null) continue; // only adds and deletes pair up
    rows.push({
      id: path,
      oldPath: change.oldOid === null ? null : path,
      newPath: change.newOid === null ? null : path,
      status: change.oldOid === null ? "added" : "deleted",
      layers: ["committed"],
      oldOid: change.oldOid,
      newOid: change.newOid,
      oldMode: change.oldMode,
      newMode: change.newMode,
      binary: false,
      image: false,
      oldSize: 0,
      newSize: 0,
      stats: null,
      tooLarge: false,
    });
  }
  const paired = await detectRenames(
    rows,
    async (file, side) =>
      (await blobBytes(deps, side === "old" ? file.oldOid : file.newOid, blobs)) ??
      new Uint8Array(),
    {
      ...(deps.renameLimit !== undefined ? { limit: deps.renameLimit } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  );
  for (const w of paired.warnings) deps.warn?.(w);
  for (const file of paired.files) {
    if (file.status === "renamed" && file.oldPath && file.newPath)
      out.set(file.newPath, file.oldPath);
  }
  return out;
}

/** The blob, `null` for an absent side, memoised; over 10 MB it is not transferred (§6.7). */
async function blobBytes(
  deps: PreflightDeps,
  oid: Oid | null,
  blobs: Map<Oid, Uint8Array | null>,
): Promise<Uint8Array | null> {
  if (oid === null) return null;
  const cached = blobs.get(oid);
  if (cached !== undefined) return cached;
  let bytes: Uint8Array | null = null;
  try {
    const read = await deps.db.readBlob(oid);
    bytes = read.byteLength > HUGE_FILE_BYTES ? null : read;
  } catch (e) {
    deps.warn?.({
      code: "HISTORY_DEGRADED",
      message: `${oid.slice(0, 7)} could not be read; the prediction for that file is a guess.`,
      detail: `IO_ERROR: ${oid} (${e instanceof Error ? e.message : String(e)})`,
    });
  }
  blobs.set(oid, bytes);
  return bytes;
}

/** Old-side line ranges of one patch, 1-based and inclusive; a pure insertion is a single point. */
async function sideRanges(
  deps: PreflightDeps,
  change: Change,
  blobs: Map<Oid, Uint8Array | null>,
): Promise<SideRanges> {
  // A gitlink has no blob to merge: git records the pointer and conflicts whenever both sides moved
  // it, so it is graded like binary content.
  if (change.oldMode === MODE_GITLINK || change.newMode === MODE_GITLINK) return { kind: "binary" };
  const oldBytes = await blobBytes(deps, change.oldOid, blobs);
  const newBytes = await blobBytes(deps, change.newOid, blobs);
  if (
    (change.oldOid !== null && oldBytes === null) ||
    (change.newOid !== null && newBytes === null)
  )
    return { kind: "unreadable" };
  if ((oldBytes && isBinary(oldBytes)) || (newBytes && isBinary(newBytes)))
    return { kind: "binary" };
  const model = computeHunks(
    { old: oldBytes, new: newBytes },
    { ignoreWhitespace: false, context: 0 },
  );
  const ranges: [number, number][] = model.hunks.map((h) =>
    h.oldCount === 0 ? [h.oldStart, h.oldStart] : [h.oldStart, h.oldStart + h.oldCount - 1],
  );
  return { kind: "ranges", ranges };
}

/** The atlas's three grades, from the two patches' pre-image ranges. */
function predict(mine: SideRanges, theirs: SideRanges): "likely" | "possible" {
  // Two changes to the same binary file (or submodule pointer) always stop a rebase.
  if (mine.kind === "binary" || theirs.kind === "binary") return "likely";
  // A side we could not read: the file is shared, which is all we can honestly say.
  if (mine.kind === "unreadable" || theirs.kind === "unreadable") return "possible";
  for (const [aStart, aEnd] of mine.ranges) {
    for (const [bStart, bEnd] of theirs.ranges) {
      if (bStart <= aEnd + ADJACENT_LINES && aStart <= bEnd + ADJACENT_LINES) return "likely";
    }
  }
  return "possible";
}
