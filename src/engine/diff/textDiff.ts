/**
 * Text diff, stats and classification (T3.4, Plan §5.6 steps 7–9, §6.7 limits).
 *
 * Lines are compared by key: the raw line, or with `ignoreWhitespace` the line with every ASCII
 * whitespace removed — `git diff -w` semantics (a missing final newline is whitespace too). The
 * displayed text is always the original line. Linear-space Myers (`myers.ts`) on interned keys after
 * stripping the common prefix/suffix, so a one-line change in a 30k-line file stays cheap.
 */
import type {
  FileClassification,
  FileDiffPayload,
  FileStats,
  Hunk,
  HunkLine,
  HunkModel,
} from "../api";
import type { FileContents, FileDiff, RepoWarning } from "../types";
import { isBinary, isImagePath } from "./binary";
import type { LoadedSides } from "./contentLoader";
import { languageFor } from "./language";
import { parseLfsPointer } from "./lfs";
import { myersDiff } from "./myers";

export const LARGE_FILE_BYTES = 1024 * 1024; // > 1 MB either side → tooLarge (UI gates)
const LARGE_CHANGED_LINES = 3000; // > 3000 changed lines → tooLarge
export const HUGE_FILE_BYTES = 10 * 1024 * 1024; // > 10 MB → never rendered
const DEFAULT_CONTEXT = 3;

// Non-fatal on purpose: like git, we do not know the file's encoding; invalid UTF-8 sequences become
// U+FFFD rather than failing the diff. The binary sniff (NUL in the first 8000 bytes) runs first.
const decoder = new TextDecoder("utf-8");
function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export interface LineSet {
  lines: string[];
  noEol: boolean; // last line has no trailing newline
}

/** git-style line split: "" → 0 lines, "a\n" → ["a"], "a" → ["a"] without EOL. */
export function splitLines(text: string): LineSet {
  if (text.length === 0) return { lines: [], noEol: false };
  const lines = text.split("\n");
  const noEol = lines[lines.length - 1] !== "";
  if (!noEol) lines.pop();
  return { lines, noEol };
}

/** Number of lines in raw bytes without decoding (for one-sided huge files). */
function countLines(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) n++;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) n++;
  return n;
}

// ASCII whitespace as git's isspace(): space, tab, CR, FF, VT (LF never appears inside a line).
const WS = new RegExp(`[ \\t\\r${String.fromCharCode(12)}${String.fromCharCode(11)}]+`, "g");
const NO_EOL_MARK = `${String.fromCharCode(0)}noeol`;

export function lineKeys(set: LineSet, ignoreWhitespace: boolean): string[] {
  const keys = ignoreWhitespace ? set.lines.map((l) => l.replace(WS, "")) : set.lines.slice();
  // A missing final newline is a difference for git, unless whitespace is ignored.
  if (set.noEol && !ignoreWhitespace && keys.length > 0)
    keys[keys.length - 1] = `${keys[keys.length - 1]}${NO_EOL_MARK}`;
  return keys;
}

export interface LineOp {
  type: "eq" | "add" | "del";
  oldStart: number; // 0-based index into the old lines (for eq/del)
  newStart: number; // 0-based index into the new lines (for eq/add)
  count: number;
}

/** Interns string keys as integers so the diff compares numbers. */
function intern(oldKeys: string[], newKeys: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const map = (keys: string[]) => {
    const out = new Int32Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] as string;
      let id = ids.get(k);
      if (id === undefined) {
        id = ids.size;
        ids.set(k, id);
      }
      out[i] = id;
    }
    return out;
  };
  return [map(oldKeys), map(newKeys)];
}

/** Line-level minimal edit script over two key arrays (linear-space Myers). */
export function lineDiff(oldKeys: string[], newKeys: string[]): LineOp[] {
  if (oldKeys.length === 0 && newKeys.length === 0) return [];
  const [a, b] = intern(oldKeys, newKeys);
  return myersDiff(a, b);
}

export function statsFromOps(ops: LineOp[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "add") additions += op.count;
    else if (op.type === "del") deletions += op.count;
  }
  return { additions, deletions };
}

export interface TextDiffOptions {
  ignoreWhitespace: boolean;
  context?: number;
}

function textOps(contents: FileContents, ignoreWhitespace: boolean) {
  const oldSet = splitLines(contents.old ? decodeText(contents.old) : "");
  const newSet = splitLines(contents.new ? decodeText(contents.new) : "");
  const ops = lineDiff(lineKeys(oldSet, ignoreWhitespace), lineKeys(newSet, ignoreWhitespace));
  return { oldSet, newSet, ops };
}

/** `+/-` line counts; `null` for binary content (git numstat's `-`). */
export function computeStats(contents: FileContents, opts: TextDiffOptions): FileStats {
  if ((contents.old && isBinary(contents.old)) || (contents.new && isBinary(contents.new)))
    return null;
  if (!contents.old && !contents.new) return { additions: 0, deletions: 0 };
  if (!contents.old) return { additions: countLines(contents.new as Uint8Array), deletions: 0 };
  if (!contents.new) return { additions: 0, deletions: countLines(contents.old) };
  return statsFromOps(textOps(contents, opts.ignoreWhitespace).ops);
}

/** Unified-diff hunks with `context` lines, merged when the gap between changes is ≤ 2×context. */
export function hunksFromOps(
  ops: LineOp[],
  oldLines: string[],
  newLines: string[],
  context: number,
): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: HunkLine[] | null = null;
  let curOldStart = 0;
  let curNewStart = 0;
  const close = () => {
    if (!cur) return;
    let oldCount = 0;
    let newCount = 0;
    for (const l of cur) {
      if (l.type !== "add") oldCount++;
      if (l.type !== "del") newCount++;
    }
    hunks.push({
      oldStart: oldCount === 0 ? curOldStart : curOldStart + 1,
      oldCount,
      newStart: newCount === 0 ? curNewStart : curNewStart + 1,
      newCount,
      lines: cur,
    });
    cur = null;
  };
  const ctx = (op: LineOp, from: number, to: number) => {
    for (let i = from; i < to; i++)
      (cur as HunkLine[]).push({
        type: "ctx",
        old: op.oldStart + i + 1,
        new: op.newStart + i + 1,
        text: oldLines[op.oldStart + i] as string,
      });
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as LineOp;
    if (op.type === "eq") {
      if (!cur) continue;
      const isLast = i === ops.length - 1;
      if (!isLast && op.count <= 2 * context) {
        ctx(op, 0, op.count);
      } else {
        ctx(op, 0, Math.min(context, op.count));
        close();
      }
      continue;
    }
    if (!cur) {
      cur = [];
      const prev = i > 0 ? (ops[i - 1] as LineOp) : null;
      if (prev && prev.type === "eq") {
        const lead = Math.min(context, prev.count);
        curOldStart = prev.oldStart + prev.count - lead;
        curNewStart = prev.newStart + prev.count - lead;
        ctx(prev, prev.count - lead, prev.count);
      } else {
        curOldStart = op.oldStart;
        curNewStart = op.newStart;
      }
    }
    if (op.type === "del") {
      for (let k = 0; k < op.count; k++)
        cur.push({
          type: "del",
          old: op.oldStart + k + 1,
          text: oldLines[op.oldStart + k] as string,
        });
    } else {
      for (let k = 0; k < op.count; k++)
        cur.push({
          type: "add",
          new: op.newStart + k + 1,
          text: newLines[op.newStart + k] as string,
        });
    }
  }
  close();
  return hunks;
}

export function computeHunks(contents: FileContents, opts: TextDiffOptions): HunkModel {
  const { oldSet, newSet, ops } = textOps(contents, opts.ignoreWhitespace);
  return {
    oldLines: oldSet.lines.length,
    newLines: newSet.lines.length,
    hunks: hunksFromOps(ops, oldSet.lines, newSet.lines, opts.context ?? DEFAULT_CONTEXT),
  };
}

const modeType = (mode: number | null) => (mode === null ? null : mode & 0o170000);

export function isTypeChange(oldMode: number | null, newMode: number | null): boolean {
  const a = modeType(oldMode);
  const b = modeType(newMode);
  return a !== null && b !== null && a !== b;
}

export interface DescribeOptions extends TextDiffOptions {
  /** Compute hunks even when the file is gated as tooLarge. */
  loadLarge?: boolean;
  /** From `.gitattributes` (`GitAttributes.isBinary` / `isGenerated`). */
  attrBinary?: boolean;
  attrGenerated?: boolean;
  /** Skip hunk computation (background stats pass). */
  statsOnly?: boolean;
}

export interface FileDescription {
  classification: FileClassification;
  hunks: HunkModel | null;
  oldText: string | null;
  newText: string | null;
  stats: FileStats;
  language: string;
  submodule?: { oldOid: string | null; newOid: string | null };
  warning?: RepoWarning;
}

/** Everything `EngineApi.fileDiff` needs for one file, computed from loaded sides. */
export function describeFile(
  file: FileDiff,
  loaded: LoadedSides,
  opts: DescribeOptions,
): FileDescription {
  const path = (file.newPath ?? file.oldPath) as string;
  const language = languageFor(path);
  // T10.12: sniffed before anything else, because a real `.gitattributes` LFS line carries `-text`
  // and the pointer would otherwise disappear behind the binary gate. The new side wins when both
  // sides are pointers: the card describes the object the file points at *now*.
  const lfs = parseLfsPointer(loaded.new) ?? parseLfsPointer(loaded.old);
  const base: FileClassification = {
    binary: false,
    image: isImagePath(path),
    tooLarge: false,
    huge: false,
    typechange: isTypeChange(file.oldMode, file.newMode),
    submodule: loaded.kind === "submodule",
    generated: opts.attrGenerated ?? false,
    whitespaceOnly: false,
    oldSize: loaded.old?.length ?? 0,
    newSize: loaded.new?.length ?? 0,
    changedLines: null,
    ...(lfs !== null ? { lfs } : {}),
  };
  let contents: FileContents = loaded;
  if (loaded.kind === "submodule") {
    // git renders gitlinks as one "Subproject commit <oid>" line per side.
    const enc = new TextEncoder();
    const sub = loaded.submodule ?? { oldOid: file.oldOid, newOid: file.newOid };
    contents = {
      old: sub.oldOid ? enc.encode(`Subproject commit ${sub.oldOid}\n`) : null,
      new: sub.newOid ? enc.encode(`Subproject commit ${sub.newOid}\n`) : null,
    };
    const model = computeHunks(contents, opts);
    const stats = computeStats(contents, opts);
    return {
      classification: { ...base, changedLines: stats ? stats.additions + stats.deletions : null },
      hunks: opts.statsOnly ? null : model,
      oldText: contents.old ? decodeText(contents.old) : null,
      newText: contents.new ? decodeText(contents.new) : null,
      stats,
      language: "text",
      submodule: sub,
    };
  }

  if (base.oldSize > HUGE_FILE_BYTES || base.newSize > HUGE_FILE_BYTES) {
    const oneSided = !contents.old || !contents.new;
    const stats = oneSided ? computeStats(contents, opts) : null;
    return {
      classification: {
        ...base,
        huge: true,
        tooLarge: true,
        binary: opts.attrBinary === true,
        changedLines: stats ? stats.additions + stats.deletions : null,
      },
      hunks: null,
      oldText: null,
      newText: null,
      stats,
      language,
      warning: {
        code: "FILE_TOO_LARGE",
        message: `${path} is larger than 10 MB and is not rendered.`,
        detail: path,
      },
    };
  }

  const binary =
    opts.attrBinary === true ||
    (contents.old !== null && isBinary(contents.old)) ||
    (contents.new !== null && isBinary(contents.new));
  if (binary) {
    return {
      classification: {
        ...base,
        binary: true,
        tooLarge: base.oldSize > LARGE_FILE_BYTES || base.newSize > LARGE_FILE_BYTES,
      },
      hunks: null,
      oldText: null,
      newText: null,
      stats: null,
      language,
    };
  }

  const exact = textOps(contents, false);
  const exactStats = statsFromOps(exact.ops);
  const exactChanged = exactStats.additions + exactStats.deletions;
  let chosen = exact;
  let stats = exactStats;
  let whitespaceOnly = false;
  if (exactChanged > 0) {
    // The -w view is needed either because it was requested or to label whitespace-only files.
    const w = textOps(contents, true);
    const wStats = statsFromOps(w.ops);
    whitespaceOnly = wStats.additions + wStats.deletions === 0;
    if (opts.ignoreWhitespace) {
      chosen = w;
      stats = wStats;
    }
  }
  const changedLines = stats.additions + stats.deletions;
  const tooLarge =
    base.oldSize > LARGE_FILE_BYTES ||
    base.newSize > LARGE_FILE_BYTES ||
    exactChanged > LARGE_CHANGED_LINES;
  const wantHunks = !opts.statsOnly && (!tooLarge || opts.loadLarge === true);
  return {
    classification: { ...base, tooLarge, whitespaceOnly, changedLines },
    hunks: wantHunks
      ? {
          oldLines: chosen.oldSet.lines.length,
          newLines: chosen.newSet.lines.length,
          hunks: hunksFromOps(
            chosen.ops,
            chosen.oldSet.lines,
            chosen.newSet.lines,
            opts.context ?? DEFAULT_CONTEXT,
          ),
        }
      : null,
    oldText: wantHunks && contents.old ? decodeText(contents.old) : null,
    newText: wantHunks && contents.new ? decodeText(contents.new) : null,
    stats,
    language,
  };
}

/** Assemble the worker payload (T3.5 fills `generation`). */
export function toPayload(file: FileDiff, d: FileDescription, generation: number): FileDiffPayload {
  return {
    id: file.id,
    generation,
    classification: d.classification,
    hunks: d.hunks,
    oldText: d.oldText,
    newText: d.newText,
    language: d.language,
    stats: d.stats,
    oldMode: file.oldMode,
    newMode: file.newMode,
    ...(d.submodule ? { submodule: d.submodule } : {}),
  };
}
