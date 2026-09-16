/**
 * Torn-state helpers (T0.3 amendment, landed with T0.4): mutations for a memory handle that
 * simulate git writing concurrently, `git gc` swapping packs, or the folder disappearing.
 */
import {
  base64ToBytes,
  bytesToBase64,
  type MemorySnapshot,
  type Mutation,
} from "../engine/fs/memoryDirHandle";

/** Writes `.git/index` cut in half (a torn read while git rewrites it). */
export function truncateIndex(snap: MemorySnapshot): Mutation[] {
  const idx = snap.files[".git/index"];
  if (!idx) throw new Error("snapshot has no .git/index");
  const bytes = base64ToBytes(idx.b64);
  return [
    { op: "write", path: ".git/index", b64: bytesToBase64(bytes.subarray(0, bytes.length >> 1)) },
  ];
}

/** Restores the original `.git/index` bytes from the snapshot. */
export function restoreIndex(snap: MemorySnapshot): Mutation[] {
  const idx = snap.files[".git/index"];
  if (!idx) throw new Error("snapshot has no .git/index");
  return [{ op: "write", path: ".git/index", b64: idx.b64, mtime: idx.mtime + 5000 }];
}

/** Renames every pack (and its .idx/.rev) to a new name, as `git gc` does. */
export function swapPack(snap: MemorySnapshot): Mutation[] {
  const muts: Mutation[] = [];
  for (const p of Object.keys(snap.files)) {
    const m = /^\.git\/objects\/pack\/pack-([0-9a-f]{40})\.(pack|idx|rev)$/.exec(p);
    if (!m) continue;
    const newName = m[1].split("").reverse().join("");
    muts.push({ op: "rename", from: p, to: `.git/objects/pack/pack-${newName}.${m[2]}` });
  }
  if (muts.length === 0) throw new Error("snapshot has no packfile");
  return muts;
}

/** The folder was deleted or moved: every access fails with NotFoundError. */
export function dropRoot(): Mutation[] {
  return [{ op: "dropRoot" }];
}
