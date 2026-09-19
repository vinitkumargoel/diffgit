/**
 * Three-way conflict payload (T10.3, atlas tab 06, Design §14.3).
 *
 * When a merge, rebase, cherry-pick or revert stops, git keeps up to three versions of each
 * conflicted path in the index — stage 1 (the merge base), stage 2 (ours) and stage 3 (theirs) —
 * and writes the marked-up result into the working tree. `IndexSnapshot.conflicts` already carries
 * those stages (T2.1); this module turns them into the payload the conflict card renders: the three
 * blobs, the base→ours and base→theirs hunks, and the working-tree file with its marker lines
 * located so the UI can highlight them.
 *
 * Read-only throughout (D16): nothing here resolves anything, it only explains the state.
 */

import type { ConflictKind, ConflictMarker, ConflictPayload, HunkModel, SideBlob } from "../api";
import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { IndexEntry } from "../git/indexReader";
import type { ObjectDb } from "../git/objectDb";
import type { FileStatus, Oid, RefSnapshot, RepoOperation, RepoRef } from "../types";
import { throwIfAborted } from "../util/concurrency";
import { isBinary } from "./binary";
import { computeHunks, HUGE_FILE_BYTES, LARGE_FILE_BYTES, type TextDiffOptions } from "./textDiff";

const decoder = new TextDecoder("utf-8");

/** Git writes exactly seven marker characters, then either a space and a label or end-of-line. */
const OURS_RE = /^<{7}(?:[ \t].*)?$/;
const BASE_RE = /^\|{7}(?:[ \t].*)?$/;
const SPLIT_RE = /^={7}(?:[ \t].*)?$/;
const THEIRS_RE = /^>{7}(?:[ \t].*)?$/;

/**
 * Which stages the index kept, named the way `git status` names the pair. Purely structural: the
 * side without a blob is the side that deleted the path. Git's rarer `AU` (stage 2 only) therefore
 * reads as `deleted-by-them` and `UA` (stage 3 only) as `deleted-by-us`, which is what the card
 * renders anyway — one filled column and one "deleted on this side" placeholder.
 */
export function conflictKindOf(stages: readonly IndexEntry[]): ConflictKind {
  const has = (stage: number) => stages.some((e) => e.stage === stage);
  const base = has(1);
  const ours = has(2);
  const theirs = has(3);
  if (ours && theirs) return base ? "both-modified" : "both-added";
  if (ours) return "deleted-by-them";
  if (theirs) return "deleted-by-us";
  return "both-deleted";
}

/** `FileDiff.status` for a conflicted row (T10.3): both-added → added, deleted-by-* → deleted. */
export function conflictStatus(kind: ConflictKind): FileStatus {
  if (kind === "both-added") return "added";
  if (kind === "deleted-by-us" || kind === "deleted-by-them") return "deleted";
  return "modified";
}

/**
 * Locates every `<<<<<<< / ||||||| / ======= / >>>>>>>` block, as 1-based line numbers of the
 * marker lines (see `ConflictMarker`). `diff3` and `zdiff3` styles carry the `|||||||` base section;
 * `merge` style does not.
 *
 * Never throws: odd input (an unterminated block, a `>>>>>>>` with nothing open, a second
 * `<<<<<<<` before the first one closed, a missing separator) is reported as what was actually
 * found rather than rejected — the point of the card is to explain a file that is already strange.
 */
export function parseConflictMarkers(text: string): ConflictMarker[] {
  const out: ConflictMarker[] = [];
  if (text.length === 0) return out;
  const lines = text.split("\n");
  let start = 0;
  let oursEnd = 0;
  let baseEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const n = i + 1;
    if (OURS_RE.test(line)) {
      // A nested/second opener abandons whatever was open: git writes no depth, so the innermost
      // block is the only one we can delimit honestly.
      start = n;
      oursEnd = 0;
      baseEnd = 0;
      continue;
    }
    if (start === 0) continue;
    if (BASE_RE.test(line)) {
      if (oursEnd === 0) oursEnd = n;
      continue;
    }
    if (SPLIT_RE.test(line)) {
      if (oursEnd === 0) oursEnd = n;
      else if (baseEnd === 0) baseEnd = n;
      continue;
    }
    if (THEIRS_RE.test(line)) {
      const marker: ConflictMarker = { start, end: n, oursEnd: oursEnd === 0 ? n : oursEnd };
      if (baseEnd !== 0) marker.baseEnd = baseEnd;
      out.push(marker);
      start = 0;
      oursEnd = 0;
      baseEnd = 0;
    }
  }
  return out; // an unterminated trailing block has no end line and is not reported
}

interface LoadedStage {
  blob: SideBlob;
  bytes: Uint8Array;
}

/** Reads one stage's blob and applies the payload's gates (binary / > 1 MB → `text: null`). */
async function loadStage(
  db: ObjectDb,
  entry: IndexEntry | undefined,
  signal?: AbortSignal,
): Promise<LoadedStage | null> {
  if (!entry) return null;
  throwIfAborted(signal, "conflict");
  const bytes = await db.readBlob(entry.oid);
  const size = bytes.byteLength;
  const binary = isBinary(bytes);
  const gated = binary || size > LARGE_FILE_BYTES;
  return {
    blob: { oid: entry.oid, text: gated ? null : decoder.decode(bytes), size, binary },
    bytes,
  };
}

/** base→side hunks; null when either side is gated (binary/large) or neither side exists. */
function stageHunks(
  base: LoadedStage | null,
  side: LoadedStage | null,
  opts: TextDiffOptions,
): HunkModel | null {
  if (!base && !side) return null;
  if (base?.blob.text === null || side?.blob.text === null) return null;
  return computeHunks({ old: base?.bytes ?? null, new: side?.bytes ?? null }, opts);
}

interface WorktreeFile {
  markers: ConflictMarker[];
  /** null when the bytes were never decoded (absent, binary or over 10 MB). */
  text: string | null;
  size: number;
}

/** The working-tree file, decoded unless it is binary or huge; `null` when it is not there. */
async function readWorktreeFile(
  fs: FsaFs,
  path: string,
  signal?: AbortSignal,
): Promise<WorktreeFile | null> {
  throwIfAborted(signal, "conflict");
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(`/${path}`);
  } catch (e) {
    const code = errorCode(e);
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
    throw e;
  }
  const size = bytes.byteLength;
  if (size > HUGE_FILE_BYTES || isBinary(bytes)) return { markers: [], text: null, size };
  const text = decoder.decode(bytes);
  return { markers: parseConflictMarkers(text), text, size };
}

/** A ref name pointing at `oid` (branches first, as `RepoRef[]` is ordered), else its short oid. */
function displayOid(oid: Oid, refs: readonly RepoRef[]): string {
  const hit = refs.find((r) => r.oid === oid && !r.synthetic);
  return hit ? hit.name : oid.slice(0, 7);
}

/**
 * What to call the two columns. "Ours" is the checked-out side: the branch name, or — during a
 * rebase, where HEAD is detached onto the new base — what the rebase is replaying onto. "Theirs" is
 * the commit git is applying: `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` / the rebase's
 * stopped commit, shown as a ref name when one points at it (`topic`) and as a short oid otherwise
 * (`d424326`) — the same two spellings git puts in the `>>>>>>>` marker.
 */
export function conflictLabels(
  refs: RefSnapshot,
  op: RepoOperation | null,
): { ours: string; theirs: string } {
  const ours =
    refs.headBranch ??
    (op?.kind === "rebase" ? op.ontoDisplay : undefined) ??
    (refs.headOid ? refs.headOid.slice(0, 7) : null) ??
    "HEAD";
  const theirs = op?.current
    ? displayOid(op.current, refs.refs)
    : op?.kind === "rebase" && op.headName
      ? op.headName.replace(/^refs\/heads\//, "")
      : "theirs";
  return { ours, theirs };
}

export interface ConflictSources {
  db: ObjectDb;
  fs: FsaFs;
}

export interface ConflictRequest {
  id: string;
  /** Repo-relative POSIX path of the conflicted file. */
  path: string;
  generation: number;
  /** `IndexSnapshot.conflicts[path]` — the stage 1/2/3 entries, in any order. */
  stages: readonly IndexEntry[];
  refs: RefSnapshot;
  operation: RepoOperation | null;
  /** Hunk options; defaults to the exact (non `-w`) diff with the usual 3 lines of context. */
  diff?: TextDiffOptions;
  signal?: AbortSignal;
}

/** Builds the payload `EngineApi.conflict` returns. */
export async function buildConflictPayload(
  src: ConflictSources,
  req: ConflictRequest,
): Promise<ConflictPayload> {
  const opts: TextDiffOptions = req.diff ?? { ignoreWhitespace: false };
  const stageOf = (stage: 1 | 2 | 3) => req.stages.find((e) => e.stage === stage);
  const [base, ours, theirs] = await Promise.all([
    loadStage(src.db, stageOf(1), req.signal),
    loadStage(src.db, stageOf(2), req.signal),
    loadStage(src.db, stageOf(3), req.signal),
  ]);
  const worktree = await readWorktreeFile(src.fs, req.path, req.signal);
  throwIfAborted(req.signal, "conflict");
  const gatedWorktree =
    worktree === null || worktree.text === null || worktree.size > LARGE_FILE_BYTES;
  return {
    id: req.id,
    generation: req.generation,
    base: base?.blob ?? null,
    ours: ours?.blob ?? null,
    theirs: theirs?.blob ?? null,
    oursHunks: stageHunks(base, ours, opts),
    theirsHunks: stageHunks(base, theirs, opts),
    worktree:
      gatedWorktree || worktree === null || worktree.text === null
        ? null
        : { text: worktree.text, markers: worktree.markers },
    // A file we could not decode (absent, binary, over 10 MB) is never claimed to be resolved.
    resolvedInWorktree:
      worktree !== null && worktree.text !== null && worktree.markers.length === 0,
    kind: conflictKindOf(req.stages),
    labels: conflictLabels(req.refs, req.operation),
  };
}
