/**
 * Rename detection (T3.3), modelled on git's diffcore-rename.c / diffcore-delta.c:
 *   1. exact pass — identical blob oids pair up (prefer an unused source, then same basename);
 *   2. similarity pass — spanhash score over bytes, greedy best-first, bounded by renameLimit².
 *
 * Runs after the DiffEngine has layered the working tree, so untracked files count as candidates.
 * The caller supplies content for the similarity pass via `load`; oids come from the FileDiff.
 * Renamed entries take `id = newPath`; content for the old side therefore lives under
 * `sides[oldPath]` in the DiffComputation and the new side under `sides[newPath]`.
 */
import { hashBlob } from "../git/hash";
import type { ChangeLayer, FileDiff, RepoWarning } from "../types";
import { throwIfAborted } from "../util/concurrency";
import { isBinary } from "./binary";
import { comparePaths } from "./treeDiff";

export type RenameSide = "old" | "new";
export type RenameLoader = (file: FileDiff, side: RenameSide) => Promise<Uint8Array>;

export interface RenameOptions {
  /** Minimum similarity percentage, git's `-M<n>` (default 50). */
  threshold?: number;
  /** git's diff.renameLimit (default 1000): similarity pass runs only when limit² ≥ |D|×|A|. */
  limit?: number;
  /** Per-side byte cap for the similarity pass (default 8 MB); larger pairs are skipped with a warning. */
  maxSideBytes?: number;
  signal?: AbortSignal;
}

export interface RenameResult {
  files: FileDiff[];
  warnings: RepoWarning[];
  stats: {
    deleted: number;
    added: number;
    exact: number;
    similar: number;
    pairsScored: number;
    durationMs: number;
  };
}

const DEFAULT_RENAME_LIMIT = 1000;
const DEFAULT_RENAME_THRESHOLD = 50;
const DEFAULT_MAX_SIDE_BYTES = 8 * 1024 * 1024;

/** git's MAX_SCORE; similarity percentages are derived from it exactly as `similarity_index` does. */
const MAX_SCORE = 60000;
const LAYER_ORDER: ChangeLayer[] = ["committed", "staged", "unstaged", "untracked", "conflict"];

/**
 * git's spanhash (diffcore-delta.c `hash_chars`): the file is cut into chunks at `\n` or every
 * 64 bytes, each chunk hashed with git's rolling accumulator, and the byte counts per hash summed.
 * CR before LF is dropped for text files, exactly like git.
 */
export function spanhash(bytes: Uint8Array, isText: boolean): Map<number, number> {
  const out = new Map<number, number>();
  let accum1 = 0;
  let accum2 = 0;
  let n = 0;
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    const c = bytes[i] as number;
    if (isText && c === 13 && i + 1 < len && bytes[i + 1] === 10) continue;
    const old1 = accum1;
    accum1 = ((accum1 << 7) ^ (accum2 >>> 25)) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    accum1 = (accum1 + c) >>> 0;
    n++;
    if (n < 64 && c !== 10) continue;
    out.set(accum1, (out.get(accum1) ?? 0) + n);
    n = 0;
    accum1 = 0;
    accum2 = 0;
  }
  if (n) out.set(accum1, (out.get(accum1) ?? 0) + n);
  return out;
}

/** Bytes of `dst` that also appear in `src` (git's `diffcore_count_changes` → `src_copied`). */
export function sharedBytes(src: Map<number, number>, dst: Map<number, number>): number {
  let copied = 0;
  for (const [h, srcCnt] of src) {
    const dstCnt = dst.get(h);
    if (dstCnt !== undefined) copied += Math.min(srcCnt, dstCnt);
  }
  return copied;
}

/** git's `estimate_similarity` score → percentage, including its two-step integer truncation. */
export function similarityPercent(copied: number, srcSize: number, dstSize: number): number {
  const maxSize = Math.max(srcSize, dstSize);
  if (dstSize === 0 || maxSize === 0) return 0;
  const score = Math.floor((copied * MAX_SCORE) / maxSize);
  return Math.floor((score * 100) / MAX_SCORE);
}

/** git's size pre-filter: `max_size * (MAX_SCORE - minimum_score) < delta_size * MAX_SCORE` → skip. */
export function sizesTooDifferent(a: number, b: number, thresholdPercent: number): boolean {
  const max = Math.max(a, b);
  const delta = max - Math.min(a, b);
  const minimumScore = Math.floor((thresholdPercent * MAX_SCORE) / 100);
  return max * (MAX_SCORE - minimumScore) < delta * MAX_SCORE;
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirDistance = (a: string, b: string): number => {
  const as = a.split("/");
  const bs = b.split("/");
  let i = 0;
  while (i < as.length - 1 && i < bs.length - 1 && as[i] === bs[i]) i++;
  return as.length - 1 - i + (bs.length - 1 - i);
};

const isRegular = (mode: number | null): boolean => mode !== null && (mode & 0o170000) === 0o100000;

function mergeRename(del: FileDiff, add: FileDiff, similarity: number): FileDiff {
  const layerSet = new Set<ChangeLayer>([...del.layers, ...add.layers]);
  return {
    id: add.newPath as string,
    oldPath: del.oldPath,
    newPath: add.newPath,
    status: "renamed",
    layers: LAYER_ORDER.filter((l) => layerSet.has(l)),
    similarity,
    oldOid: del.oldOid,
    newOid: add.newOid,
    oldMode: del.oldMode,
    newMode: add.newMode,
    binary: del.binary || add.binary,
    image: add.image,
    oldSize: del.oldSize,
    newSize: add.newSize,
    stats: null,
    tooLarge: del.tooLarge || add.tooLarge,
  };
}

export async function detectRenames(
  files: FileDiff[],
  load: RenameLoader,
  opts: RenameOptions = {},
): Promise<RenameResult> {
  const t0 = performance.now();
  const threshold = opts.threshold ?? DEFAULT_RENAME_THRESHOLD;
  const limit = opts.limit ?? DEFAULT_RENAME_LIMIT;
  const maxSideBytes = opts.maxSideBytes ?? DEFAULT_MAX_SIDE_BYTES;
  const warnings: RepoWarning[] = [];
  const deleted = files.filter((f) => f.status === "deleted");
  const added = files.filter((f) => f.status === "added");
  const stats = {
    deleted: deleted.length,
    added: added.length,
    exact: 0,
    similar: 0,
    pairsScored: 0,
    durationMs: 0,
  };
  const finish = (out: FileDiff[]): RenameResult => {
    stats.durationMs = performance.now() - t0;
    return { files: out, warnings, stats };
  };
  if (deleted.length === 0 || added.length === 0) return finish(files);

  const usedDel = new Set<FileDiff>();
  const usedAdd = new Set<FileDiff>();
  const renamed: FileDiff[] = [];

  // ---- exact pass ---------------------------------------------------------------------------
  const oidOf = async (f: FileDiff, side: RenameSide): Promise<string | null> => {
    const known = side === "old" ? f.oldOid : f.newOid;
    if (known) return known;
    const size = side === "old" ? f.oldSize : f.newSize;
    if (size > maxSideBytes) return null; // T3.5 hashes those in the background; skip here
    return hashBlob(await load(f, side));
  };
  const byOid = new Map<string, FileDiff[]>();
  for (const d of deleted) {
    throwIfAborted(opts.signal, "rename detection");
    const oid = await oidOf(d, "old");
    if (!oid) continue;
    const list = byOid.get(oid);
    if (list) list.push(d);
    else byOid.set(oid, [d]);
  }
  for (const a of added) {
    throwIfAborted(opts.signal, "rename detection");
    const oid = await oidOf(a, "new");
    const candidates = oid ? byOid.get(oid) : undefined;
    if (!candidates) continue;
    let best: FileDiff | null = null;
    let bestKey: [number, number, number] | null = null;
    for (const d of candidates) {
      if (usedDel.has(d)) continue;
      // non-regular files (symlinks, gitlinks) must keep their mode, like git
      if ((!isRegular(d.oldMode) || !isRegular(a.newMode)) && d.oldMode !== a.newMode) continue;
      const key: [number, number, number] = [
        basename(d.oldPath as string) === basename(a.newPath as string) ? 0 : 1,
        dirDistance(d.oldPath as string, a.newPath as string),
        0,
      ];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        best = d;
        bestKey = key;
      }
    }
    if (!best) continue;
    usedDel.add(best);
    usedAdd.add(a);
    renamed.push(mergeRename(best, a, 100));
    stats.exact++;
  }

  // ---- similarity pass ----------------------------------------------------------------------
  const restDel = deleted.filter((d) => !usedDel.has(d));
  const restAdd = added.filter((a) => !usedAdd.has(a));
  if (restDel.length > 0 && restAdd.length > 0) {
    if (restDel.length * restAdd.length > limit * limit) {
      warnings.push({
        code: "RENAME_LIMIT",
        message: `Rename detection skipped for ${restDel.length}×${restAdd.length} candidates (diff.renameLimit = ${limit}).`,
        detail: `${restDel.length}x${restAdd.length}>${limit}^2`,
      });
    } else {
      const spans = new Map<FileDiff, { span: Map<number, number>; size: number } | null>();
      let sizeSkipped = 0;
      const spanOf = async (f: FileDiff, side: RenameSide) => {
        const cached = spans.get(f);
        if (cached !== undefined) return cached;
        const size = side === "old" ? f.oldSize : f.newSize;
        let value: { span: Map<number, number>; size: number } | null = null;
        if (size <= maxSideBytes) {
          const bytes = await load(f, side);
          value = { span: spanhash(bytes, !isBinary(bytes)), size: bytes.length };
        } else sizeSkipped++;
        spans.set(f, value);
        return value;
      };
      const scored: {
        d: FileDiff;
        a: FileDiff;
        pct: number;
        nameSame: number;
        di: number;
        ai: number;
      }[] = [];
      for (let ai = 0; ai < restAdd.length; ai++) {
        const a = restAdd[ai] as FileDiff;
        for (let di = 0; di < restDel.length; di++) {
          const d = restDel[di] as FileDiff;
          throwIfAborted(opts.signal, "rename detection");
          if ((!isRegular(d.oldMode) || !isRegular(a.newMode)) && d.oldMode !== a.newMode) continue;
          if (sizesTooDifferent(d.oldSize, a.newSize, threshold)) continue;
          const sd = await spanOf(d, "old");
          const sa = await spanOf(a, "new");
          if (!sd || !sa) continue;
          stats.pairsScored++;
          const pct = similarityPercent(sharedBytes(sd.span, sa.span), sd.size, sa.size);
          if (pct < threshold) continue;
          scored.push({
            d,
            a,
            pct,
            nameSame: basename(d.oldPath as string) === basename(a.newPath as string) ? 1 : 0,
            di,
            ai,
          });
        }
      }
      // git's score_compare: higher score, then same basename, then dst index, then src index
      scored.sort((x, y) => y.pct - x.pct || y.nameSame - x.nameSame || x.ai - y.ai || x.di - y.di);
      for (const s of scored) {
        if (usedDel.has(s.d) || usedAdd.has(s.a)) continue;
        usedDel.add(s.d);
        usedAdd.add(s.a);
        renamed.push(mergeRename(s.d, s.a, s.pct));
        stats.similar++;
      }
      if (sizeSkipped > 0) {
        warnings.push({
          code: "RENAME_LIMIT",
          message: `${sizeSkipped} file${sizeSkipped === 1 ? "" : "s"} larger than ${Math.round(maxSideBytes / (1024 * 1024))} MB skipped by rename detection.`,
          detail: "maxSideBytes",
        });
      }
    }
  }

  if (renamed.length === 0) return finish(files);
  const out = files.filter((f) => !usedDel.has(f) && !usedAdd.has(f)).concat(renamed);
  out.sort((x, y) => comparePaths(x.id, y.id));
  return finish(out);
}
