/**
 * Commit-graph reader (T10.5, atlas tab 20 "Engine foundations").
 *
 * `.git/objects/info/commit-graph` is a static, append-only index git writes on `gc` and (since
 * 2.24) on `fetch`. It answers "parents and commit time of this oid" without inflating the commit
 * object, which is the whole cost of a log walk: isomorphic-git has no commit-graph support at all
 * (atlas tab 20), so `walkCommits` reads one file instead of N objects and only falls back to
 * `ObjectDb.readCommit` for the message/author of the rows it actually emits.
 *
 * Format: https://git-scm.com/docs/gitformat-commit-graph
 *
 *   header      "CGPH" | version (1) | hash version (1 = SHA-1) | #chunks | #base graphs
 *   chunk table (#chunks + 1) × { 4-byte id, 8-byte offset }, terminated by id 0
 *   OIDF        256 × 4-byte cumulative fanout over the first oid byte
 *   OIDL        N × 20-byte oids, ascending
 *   CDAT        N × 36 bytes: root tree (20) | parent 1 (4) | parent 2 (4) | generation+time (8)
 *   EDGE        4-byte parent positions for the 3rd..nth parents of octopus merges
 *   trailer     20-byte SHA-1 of everything before it
 *
 * Deliberately **not** trusted for existence: an oid the graph does not list is read from the
 * object database instead (atlas tab 20 "Risks": a graph can lag a history rewrite). A split graph
 * (`commit-graphs/commit-graph-chain`), a SHA-256 repository, an unknown version or a checksum
 * mismatch all degrade to "no graph" — `COMMIT_GRAPH_STALE` is a warning, never an error.
 */
import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { Oid, RepoWarning } from "../types";
import { sha1, toHex } from "./hash";

/** The single-file graph. */
export const COMMIT_GRAPH_PATH = ".git/objects/info/commit-graph";
/** A split graph chain; T10.5 does not read these (atlas tab 20 "Risks": fall back, add later). */
export const COMMIT_GRAPH_CHAIN_PATH = ".git/objects/info/commit-graphs/commit-graph-chain";

const OID_LEN = 20;
/** tree (20) + parent 1 (4) + parent 2 (4) + generation/commit-time (8). */
const CDAT_ROW = OID_LEN + 16;
const CHUNK_ENTRY = 12;
const HEADER_LEN = 8;
const TRAILER_LEN = 20;
const FANOUT_LEN = 256 * 4;

/** `GRAPH_PARENT_NONE`: the parent slot is empty. */
const PARENT_NONE = 0x70000000;
/** `GRAPH_EXTRA_EDGES_NEEDED` in a CDAT slot, `GRAPH_LAST_EDGE` inside the EDGE chunk. */
const EXTRA_EDGES = 0x80000000;
/** `GRAPH_EDGE_LAST_MASK`: the position bits of an EDGE/parent value. */
const POSITION_MASK = 0x7fffffff;

/** An octopus with more parents than this is a corrupt EDGE chunk, not a commit. */
const MAX_PARENTS = 64;

const CHUNK_OIDF = 0x4f494446; // "OIDF"
const CHUNK_OIDL = 0x4f49444c; // "OIDL"
const CHUNK_CDAT = 0x43444154; // "CDAT"
const CHUNK_EDGE = 0x45444745; // "EDGE"

/** What the graph knows about one commit. */
export interface GraphCommit {
  tree: Oid;
  parents: Oid[];
  /** Committer date, epoch **seconds** (git's own unit in this file). */
  commitTime: number;
  /** Generation number (0 when the graph was written without them). */
  generation: number;
}

/** Why `load` produced no graph; `"ok"` means one was parsed and verified. */
export type CommitGraphStatus = "ok" | "absent" | "chain" | "unsupported" | "corrupt";

export interface CommitGraphLoad {
  graph: CommitGraph | null;
  status: CommitGraphStatus;
  /** `COMMIT_GRAPH_STALE` when a file exists but cannot be used; empty otherwise. */
  warnings: RepoWarning[];
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function hexAt(bytes: Uint8Array, offset: number): Oid {
  let out = "";
  for (let i = 0; i < OID_LEN; i++) out += HEX[bytes[offset + i] as number] as string;
  return out;
}

/** Big-endian u64 as a JS number; commit-graph offsets never exceed 2^53. */
function readU64(view: DataView, offset: number): number {
  return view.getUint32(offset) * 0x1_0000_0000 + view.getUint32(offset + 4);
}

class ParseError extends Error {}

function fail(what: string): never {
  throw new ParseError(what);
}

/**
 * A parsed, checksum-verified single-file commit graph. Lookup is a fanout-narrowed binary search
 * over OIDL, so `get` is O(log n) with a 256-way head start.
 */
export class CommitGraph {
  private constructor(
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
    private readonly fanout: number,
    private readonly lookup: number,
    private readonly cdat: number,
    private readonly edge: number | null,
    private readonly edgeEnd: number,
    /** Number of commits in the graph. */
    readonly count: number,
  ) {}

  /**
   * Reads and verifies `.git/objects/info/commit-graph`. Never throws for a graph it cannot use:
   * the caller falls back to object reads and `WalkPage.graphAvailable` stays false.
   */
  static async load(fs: FsaFs): Promise<CommitGraphLoad> {
    const none = (status: CommitGraphStatus, warnings: RepoWarning[] = []): CommitGraphLoad => ({
      graph: null,
      status,
      warnings,
    });
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(`/${COMMIT_GRAPH_PATH}`);
    } catch (e) {
      // No graph, or it vanished mid-read: both mean "walk the objects". T10.5b nit 2: anything
      // other than "not there" is an I/O failure the user should be told about, not swallowed.
      const chain = await fs.exists(`/${COMMIT_GRAPH_CHAIN_PATH}`);
      const code = errorCode(e);
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR")
        return chain ? none("chain") : none("absent");
      return none(chain ? "chain" : "absent", [
        {
          code: "HISTORY_DEGRADED",
          message: "The commit-graph file could not be read; history is walked from the objects.",
          detail: `IO_ERROR: ${COMMIT_GRAPH_PATH} (${code ?? "unknown"})`,
        },
      ]);
    }
    try {
      const graph = await CommitGraph.parse(bytes);
      return { graph, status: "ok", warnings: [] };
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return none(e.message === "unsupported" ? "unsupported" : "corrupt", [
        {
          code: "COMMIT_GRAPH_STALE",
          message: `The commit-graph file could not be used (${e.message}); history is read from the objects instead.`,
          detail: COMMIT_GRAPH_PATH,
        },
      ]);
    }
  }

  /** Parses raw bytes (exposed for the byte-level tests). @throws ParseError */
  static async parse(bytes: Uint8Array): Promise<CommitGraph> {
    if (bytes.length < HEADER_LEN + CHUNK_ENTRY + TRAILER_LEN) fail("file is too short");
    if (bytes[0] !== 0x43 || bytes[1] !== 0x47 || bytes[2] !== 0x50 || bytes[3] !== 0x48)
      fail("signature is not CGPH");
    if (bytes[4] !== 1) fail("unsupported");
    if (bytes[5] !== 1) fail("unsupported"); // hash version 2 = SHA-256, refused with the repo
    const chunkCount = bytes[6] as number;
    if ((bytes[7] as number) !== 0) fail("unsupported"); // base graphs: a chain, handled above

    // The trailer covers everything before it; a mismatch means a torn or rewritten file.
    const body = bytes.subarray(0, bytes.length - TRAILER_LEN);
    const want = toHex(bytes.subarray(bytes.length - TRAILER_LEN));
    if (toHex(await sha1(body)) !== want) fail("checksum mismatch");

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tableEnd = HEADER_LEN + (chunkCount + 1) * CHUNK_ENTRY;
    if (tableEnd > body.length) fail("chunk table is truncated");
    const chunks = new Map<number, { start: number; end: number }>();
    let prevId = -1;
    let prevStart = -1;
    for (let i = 0; i <= chunkCount; i++) {
      const at = HEADER_LEN + i * CHUNK_ENTRY;
      const id = view.getUint32(at);
      const start = readU64(view, at + 4);
      if (start > body.length) fail("chunk offset is past the end of the file");
      if (prevId !== -1) chunks.set(prevId, { start: prevStart, end: start });
      if (id === 0) break;
      prevId = id;
      prevStart = start;
    }

    const fanout = chunks.get(CHUNK_OIDF);
    const lookup = chunks.get(CHUNK_OIDL);
    const cdat = chunks.get(CHUNK_CDAT);
    if (!fanout || !lookup || !cdat) fail("a required chunk is missing");
    if (fanout.end - fanout.start < FANOUT_LEN) fail("OIDF chunk is truncated");
    const count = view.getUint32(fanout.start + 255 * 4);
    if (lookup.end - lookup.start < count * OID_LEN) fail("OIDL chunk is truncated");
    if (cdat.end - cdat.start < count * CDAT_ROW) fail("CDAT chunk is truncated");
    const edge = chunks.get(CHUNK_EDGE) ?? null;

    return new CommitGraph(
      bytes,
      view,
      fanout.start,
      lookup.start,
      cdat.start,
      edge ? edge.start : null,
      edge ? edge.end : 0,
      count,
    );
  }

  /** Position of `oid` in the lookup chunk, or -1 when the graph does not list it. */
  position(oid: Oid): number {
    if (oid.length !== 40) return -1;
    const first = Number.parseInt(oid.slice(0, 2), 16);
    if (!Number.isFinite(first)) return -1;
    // T10.5b nit 9: a corrupt (but checksum-valid) fanout could point past OIDL; clamp so the
    // binary search can only ever read rows the chunk-length checks in `parse` covered.
    let lo = Math.min(
      first === 0 ? 0 : this.view.getUint32(this.fanout + (first - 1) * 4),
      this.count,
    );
    let hi = Math.min(this.view.getUint32(this.fanout + first * 4), this.count);
    if (hi < lo) hi = lo;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = compareHex(oid, this.bytes, this.lookup + mid * OID_LEN);
      if (cmp === 0) return mid;
      if (cmp < 0) hi = mid;
      else lo = mid + 1;
    }
    return -1;
  }

  /** The oid at a lookup position (used for parents, which the graph stores as positions). */
  oidAt(position: number): Oid | null {
    if (position < 0 || position >= this.count) return null;
    return hexAt(this.bytes, this.lookup + position * OID_LEN);
  }

  /** Tree, parents, commit time and generation, or null when the graph does not list `oid`. */
  get(oid: Oid): GraphCommit | null {
    const pos = this.position(oid);
    return pos === -1 ? null : this.at(pos);
  }

  /** Same as `get`, addressed by lookup position. */
  at(position: number): GraphCommit | null {
    if (position < 0 || position >= this.count) return null;
    const row = this.cdat + position * CDAT_ROW;
    const tree = hexAt(this.bytes, row);
    const p1 = this.view.getUint32(row + OID_LEN);
    const p2 = this.view.getUint32(row + OID_LEN + 4);
    const packed = this.view.getUint32(row + OID_LEN + 8);
    const time = this.view.getUint32(row + OID_LEN + 12);
    const parents: Oid[] = [];
    if (p1 !== PARENT_NONE) {
      const first = this.oidAt(p1 & POSITION_MASK);
      if (first === null) return null; // a position outside the graph: treat as "not listed"
      parents.push(first);
      if (p2 !== PARENT_NONE) {
        if ((p2 & EXTRA_EDGES) !== 0) {
          if (!this.readEdges(p2 & POSITION_MASK, parents)) return null;
        } else {
          const second = this.oidAt(p2 & POSITION_MASK);
          if (second === null) return null;
          parents.push(second);
        }
      }
    }
    return {
      tree,
      parents,
      // The low 2 bits of the packed word are the 33rd/34th bits of the commit time.
      commitTime: (packed & 0b11) * 0x1_0000_0000 + time,
      generation: packed >>> 2,
    };
  }

  /** Appends the 2nd..nth parents of an octopus merge from the EDGE chunk. False = corrupt. */
  private readEdges(start: number, into: Oid[]): boolean {
    if (this.edge === null) return false;
    for (let i = start; into.length < MAX_PARENTS; i++) {
      const at = this.edge + i * 4;
      if (at + 4 > this.edgeEnd) return false;
      const value = this.view.getUint32(at);
      const parent = this.oidAt(value & POSITION_MASK);
      if (parent === null) return false;
      into.push(parent);
      if ((value & EXTRA_EDGES) !== 0) return true;
    }
    return false;
  }
}

/** Compares a 40-hex oid with 20 raw bytes, git's byte order. */
function compareHex(oid: Oid, bytes: Uint8Array, offset: number): number {
  for (let i = 0; i < OID_LEN; i++) {
    const a = Number.parseInt(oid.slice(i * 2, i * 2 + 2), 16);
    const b = bytes[offset + i] as number;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}
