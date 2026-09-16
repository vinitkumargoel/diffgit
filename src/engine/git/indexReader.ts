/**
 * IndexReader (T2.1, Plan §5.4): our own `.git/index` parser for formats 2, 3 and 4, conflict stages,
 * the extensions that change semantics (`link` = split index, `sdir` = sparse index) and the trailer
 * checksum. Read-only; `readIndex` retries once after 150 ms on a torn read.
 */
import { EngineError } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { Oid } from "../types";
import { sha1, toHex } from "./hash";

export interface IndexEntry {
  path: string; // POSIX, no trailing "/" (sparse dirs are flagged instead)
  oid: Oid;
  mode: number;
  size: number;
  mtimeSec: number;
  mtimeNsec: number;
  ctimeSec: number;
  ctimeNsec: number;
  stage: 0 | 1 | 2 | 3;
  assumeValid: boolean;
  skipWorktree: boolean;
  intentToAdd: boolean;
  isSparseDir: boolean;
}

export interface IndexSnapshot {
  version: 2 | 3 | 4;
  entries: IndexEntry[]; // on-disk order (path, stage)
  byPath: Record<string, IndexEntry>; // stage-0 entries only
  conflicts: Record<string, IndexEntry[]>; // path → stage 1/2/3 entries
  extensions: string[];
  hasSplitIndex: boolean;
  hasSparseIndex: boolean;
  checksumOk: boolean;
  indexMtimeMs: number; // lastModified of .git/index (0 for parse-only)
  tooLarge: boolean; // > MAX_INDEX_ENTRIES
}

export const MAX_INDEX_ENTRIES = 200_000;
export const INDEX_RETRY_MS = 150;

const FLAG_ASSUME_VALID = 0x8000;
const FLAG_EXTENDED = 0x4000;
const FLAG_STAGE_MASK = 0x3000;
const FLAG_NAME_MASK = 0x0fff;
const EXT_SKIP_WORKTREE = 0x4000;
const EXT_INTENT_TO_ADD = 0x2000;

/** git's "offset encoding" varint (varint.c): MSB continuation, +1 per continuation before shifting. */
export function readOffsetVarint(bytes: Uint8Array, pos: number): { value: number; next: number } {
  let i = pos;
  let c = bytes[i++] as number;
  let value = c & 0x7f;
  while (c & 0x80) {
    value += 1;
    c = bytes[i++] as number;
    value = value * 128 + (c & 0x7f);
  }
  return { value, next: i };
}

function emptySnapshot(indexMtimeMs: number): IndexSnapshot {
  return {
    version: 2,
    entries: [],
    byPath: {},
    conflicts: {},
    extensions: [],
    hasSplitIndex: false,
    hasSparseIndex: false,
    checksumOk: true,
    indexMtimeMs,
    tooLarge: false,
  };
}

const decoder = new TextDecoder();

/** Pure parser. Throws `INDEX_UNSUPPORTED` for unknown versions or a truncated/garbled file. */
export async function parseIndex(bytes: Uint8Array, indexMtimeMs = 0): Promise<IndexSnapshot> {
  if (bytes.byteLength < 12 + 20) {
    throw new EngineError("INDEX_UNSUPPORTED", "The git index file is too short to be valid.", {
      hint: "Run `git status` once to let git rewrite it",
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    String.fromCharCode(
      bytes[0] as number,
      bytes[1] as number,
      bytes[2] as number,
      bytes[3] as number,
    ) !== "DIRC"
  ) {
    throw new EngineError("INDEX_UNSUPPORTED", "The git index file has an unknown signature.", {
      hint: "Run `git status` once to let git rewrite it",
    });
  }
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3 && version !== 4) {
    throw new EngineError(
      "INDEX_UNSUPPORTED",
      `Git index format ${version} is not supported (only 2, 3 and 4 are).`,
      {
        hint: "Run `git update-index --index-version 4`",
      },
    );
  }
  const count = view.getUint32(8);
  const end = bytes.byteLength - 20;

  const entries: IndexEntry[] = [];
  const byPath: Record<string, IndexEntry> = {};
  const conflicts: Record<string, IndexEntry[]> = {};
  let hasSparseIndex = false;
  let pos = 12;
  let prevPath = "";
  const truncated = () =>
    new EngineError("INDEX_UNSUPPORTED", "The git index file is truncated.", {
      hint: "Retry after git finishes writing",
    });

  for (let n = 0; n < count; n++) {
    const start = pos;
    if (pos + 62 > end) throw truncated();
    const ctimeSec = view.getUint32(pos);
    const ctimeNsec = view.getUint32(pos + 4);
    const mtimeSec = view.getUint32(pos + 8);
    const mtimeNsec = view.getUint32(pos + 12);
    const mode = view.getUint32(pos + 24);
    const size = view.getUint32(pos + 36);
    const oid = toHex(bytes.subarray(pos + 40, pos + 60));
    const flags = view.getUint16(pos + 60);
    pos += 62;
    let skipWorktree = false;
    let intentToAdd = false;
    if (version >= 3 && flags & FLAG_EXTENDED) {
      if (pos + 2 > end) throw truncated();
      const ext = view.getUint16(pos);
      skipWorktree = (ext & EXT_SKIP_WORKTREE) !== 0;
      intentToAdd = (ext & EXT_INTENT_TO_ADD) !== 0;
      pos += 2;
    }
    let path: string;
    if (version === 4) {
      const { value: strip, next } = readOffsetVarint(bytes, pos);
      pos = next;
      let nul = pos;
      while (nul < end && bytes[nul] !== 0) nul++;
      if (nul >= end) throw truncated();
      const suffix = decoder.decode(bytes.subarray(pos, nul));
      if (strip > prevPath.length) throw truncated();
      path = prevPath.slice(0, prevPath.length - strip) + suffix;
      pos = nul + 1;
    } else {
      const nameLen = flags & FLAG_NAME_MASK;
      let nul: number;
      if (nameLen < FLAG_NAME_MASK) {
        nul = pos + nameLen;
        if (nul >= end || bytes[nul] !== 0) throw truncated();
      } else {
        nul = pos;
        while (nul < end && bytes[nul] !== 0) nul++;
        if (nul >= end) throw truncated();
      }
      path = decoder.decode(bytes.subarray(pos, nul));
      // entry is padded with NULs to a multiple of 8 bytes (counting from entry start, incl. ≥ 1 NUL)
      const entryLen = nul + 1 - start;
      pos = start + Math.ceil(entryLen / 8) * 8;
      if (pos > end) throw truncated();
    }
    prevPath = path;

    const isSparseDir = mode === 0o40000 && path.endsWith("/");
    if (isSparseDir) {
      hasSparseIndex = true;
      path = path.slice(0, -1);
    }
    const entry: IndexEntry = {
      path,
      oid,
      mode,
      size,
      mtimeSec,
      mtimeNsec,
      ctimeSec,
      ctimeNsec,
      stage: ((flags & FLAG_STAGE_MASK) >> 12) as 0 | 1 | 2 | 3,
      assumeValid: (flags & FLAG_ASSUME_VALID) !== 0,
      skipWorktree,
      intentToAdd,
      isSparseDir,
    };
    entries.push(entry);
    if (entry.stage === 0) byPath[path] = entry;
    else {
      const group = conflicts[path] ?? [];
      group.push(entry);
      conflicts[path] = group;
    }
  }

  // extensions: 4-byte signature + u32 length + payload, until the trailer
  const extensions: string[] = [];
  let hasSplitIndex = false;
  while (pos + 8 <= end) {
    const sig = String.fromCharCode(
      bytes[pos] as number,
      bytes[pos + 1] as number,
      bytes[pos + 2] as number,
      bytes[pos + 3] as number,
    );
    const len = view.getUint32(pos + 4);
    if (pos + 8 + len > end) break; // garbled extension area: stop, checksum will tell
    extensions.push(sig);
    if (sig === "link") hasSplitIndex = true;
    if (sig === "sdir") hasSparseIndex = true;
    pos += 8 + len;
  }

  const expected = toHex(bytes.subarray(end, end + 20));
  const actual = toHex(await sha1(bytes.subarray(0, end)));

  return {
    version,
    entries,
    byPath,
    conflicts,
    extensions,
    hasSplitIndex,
    hasSparseIndex,
    checksumOk: expected === actual,
    indexMtimeMs,
    tooLarge: entries.length > MAX_INDEX_ENTRIES,
  };
}

function code(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

/**
 * Reads and parses `.git/index`. A missing index (fresh `git init`) yields an empty snapshot.
 * When the checksum fails or the file vanished (git writes `index.lock` then renames), waits
 * `INDEX_RETRY_MS` and retries once; a still-bad checksum is returned with `checksumOk = false`.
 */
export async function readIndex(fs: FsaFs, retryMs = INDEX_RETRY_MS): Promise<IndexSnapshot> {
  const attempt = async (): Promise<IndexSnapshot | null> => {
    let file: Awaited<ReturnType<FsaFs["openFile"]>>;
    try {
      file = await fs.openFile(".git/index");
    } catch (e) {
      if (code(e) === "ENOENT") return null;
      throw e;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return await parseIndex(bytes, file.lastModified);
    } catch (e) {
      // a truncated file mid-write parses as garbage; treat like a bad checksum and retry
      if (code(e) === "INDEX_UNSUPPORTED" && /truncated|too short/.test((e as Error).message)) {
        return { ...emptySnapshot(file.lastModified), checksumOk: false };
      }
      throw e;
    }
  };
  const snap = await attempt();
  if (snap?.checksumOk) return snap;
  await new Promise((r) => setTimeout(r, retryMs));
  const again = await attempt();
  if (again === null) return snap ?? emptySnapshot(0);
  return again;
}
