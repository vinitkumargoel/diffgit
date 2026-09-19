/**
 * Reflog reader (T10.2, docs/v2-contracts.md; atlas tab 07 "Operation banner and reflog").
 *
 * `.git/logs/HEAD` and `.git/logs/<fullRef>` are append-only text files, oldest line first:
 *
 *     <old-oid> <new-oid> <name> <<email>> <unix-seconds> <±hhmm>\t<message>
 *
 * isomorphic-git has no reflog API, so this is the parser. It is the same format the stash stack
 * uses (`.git/logs/refs/stash`), so `stash.ts` builds `parseStashLog` on `parseReflogLines` here.
 *
 * Parity target: `git reflog --format='%H %gs'` and `git reflog --format='%gd %H %gs'`
 * (recorded per fixture in `expected/reflog.txt` / `expected/reflog-selectors.txt` by T10.0).
 *
 * Reads are torn-read safe the same way the index reader is: git appends a whole line at a time,
 * so a trailing line that cannot be parsed means the read caught a write in flight — wait
 * `REFLOG_RETRY_MS` and read once more (atlas tab 07, "Risks": torn reads while git is mid-write).
 */

import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { Oid, ReflogEntry, RepoWarning, Signature } from "../types";

/** Just enough of `FsaFs` to read a reflog; lets tests drive the retry with a two-answer stub. */
export type ReflogFs = Pick<FsaFs, "readText">;

/** Same rule as `INDEX_RETRY_MS` in the index reader. */
export const REFLOG_RETRY_MS = 150;

/** What `EngineApi.reflog` asks for when the caller does not say (Design §14.5 shows 50 rows). */
export const DEFAULT_REFLOG_LIMIT = 200;

const LINE_RE = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.*?) <([^>]*)> (\d+) ([+-]\d{4})\t(.*)$/;
const ZERO_OID = "0".repeat(40);

/** One parsed reflog line, before it is numbered and given a selector. */
export interface ReflogLine {
  oldOid: Oid | null; // null when git wrote all zeroes (the entry that created the ref)
  newOid: Oid;
  message: string; // git's %gs, verbatim
  who: Signature;
}

/**
 * `+0530` → `-330`: `Signature.tzOffsetMin` follows isomorphic-git's `timezoneOffset`, which is the
 * `Date.getTimezoneOffset()` convention (minutes **west** of UTC), not git's own sign.
 */
function parseTzOffset(tz: string): number {
  const sign = tz[0] === "-" ? -1 : 1;
  const minutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  return minutes === 0 ? 0 : -minutes;
}

/** A single line, or null when it is not shaped like something git wrote. */
export function parseReflogLine(line: string): ReflogLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const oldOid = m[1] as string;
  return {
    oldOid: oldOid === ZERO_OID ? null : oldOid,
    newOid: m[2] as string,
    message: m[7] as string,
    who: {
      name: m[3] as string,
      email: m[4] as string,
      timestamp: Number.parseInt(m[5] as string, 10) * 1000,
      tzOffsetMin: parseTzOffset(m[6] as string),
    },
  };
}

/**
 * Every line of a reflog file, **newest first** (the file is oldest first). Lines git cannot have
 * written are skipped rather than thrown on: a half-written reflog must not break the panel.
 */
export function parseReflogLines(text: string | null): ReflogLine[] {
  if (text === null) return [];
  const lines = text.split("\n");
  const out: ReflogLine[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i] as string;
    if (raw.length === 0) continue;
    const parsed = parseReflogLine(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * True when the file looks like it was read mid-append: the last non-empty line is not a complete
 * reflog line. Git writes one whole line per update, so this only happens on a torn read.
 */
export function isTornReflog(text: string): boolean {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i] as string;
    if (raw.length === 0) continue;
    return parseReflogLine(raw) === null;
  }
  return false; // an empty file is a legitimate state (`git checkout` into a repo with no updates)
}

/** The reflog's `action`: everything before the first `:` of git's `%gs`. */
export function reflogAction(message: string): string {
  const i = message.indexOf(":");
  return i === -1 ? message : message.slice(0, i);
}

/**
 * Paths under `.git/` that could hold the reflog for `ref`, most likely first. Short names are
 * tried as a branch, then a remote-tracking branch, then a tag — git's own precedence.
 */
export function reflogCandidates(ref: string): string[] {
  const r = ref.trim();
  if (r === "" || r === "HEAD") return ["logs/HEAD"];
  if (r.startsWith("refs/")) return [`logs/${r}`];
  if (r === "stash") return ["logs/refs/stash"];
  return [`logs/refs/heads/${r}`, `logs/refs/remotes/${r}`, `logs/refs/tags/${r}`];
}

export interface ReflogOptions {
  /** Newest `limit` entries (default `DEFAULT_REFLOG_LIMIT`). */
  limit?: number;
  /** Torn-read retry delay; 0 disables the retry (tests). */
  retryMs?: number;
}

export interface ReflogResult {
  entries: ReflogEntry[];
  /** `NO_REFLOG` when the repository keeps no log for this ref. */
  warnings: RepoWarning[];
}

function missing(e: unknown): boolean {
  const code = errorCode(e);
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

/** Reads one reflog file, retrying once when the tail says the read was torn. */
async function readWithRetry(fs: ReflogFs, path: string, retryMs: number): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readText(`.git/${path}`);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
  if (retryMs <= 0 || !isTornReflog(text)) return text;
  await new Promise((r) => setTimeout(r, retryMs));
  try {
    return await fs.readText(`.git/${path}`);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/**
 * The reflog of `ref` ("HEAD", "main", "origin/main", "refs/heads/main", "stash"), newest first.
 * A repository that keeps no reflog (`core.logAllRefUpdates=false`, a fresh clone of a bare repo)
 * yields no entries and one `NO_REFLOG` warning rather than an error.
 *
 * `reachable` is null on every entry; T10.5's `markReachable` fills it in, which is what marks the
 * orphaned commit a `git reset` left behind.
 */
export async function readReflog(
  fs: ReflogFs,
  ref: string,
  opts: ReflogOptions = {},
): Promise<ReflogResult> {
  const limit = opts.limit ?? DEFAULT_REFLOG_LIMIT;
  const retryMs = opts.retryMs ?? REFLOG_RETRY_MS;
  const display = ref.trim() === "" ? "HEAD" : ref.trim();
  let text: string | null = null;
  for (const path of reflogCandidates(ref)) {
    text = await readWithRetry(fs, path, retryMs);
    if (text !== null) break;
  }
  if (text === null) {
    return {
      entries: [],
      warnings: [
        {
          code: "NO_REFLOG",
          message: `No reflog is kept for ${display} in this repository.`,
          detail: "Set core.logAllRefUpdates=true to have git record where the ref has been.",
        },
      ],
    };
  }
  const entries: ReflogEntry[] = [];
  const lines = parseReflogLines(text);
  for (let i = 0; i < lines.length && entries.length < limit; i++) {
    const l = lines[i] as ReflogLine;
    entries.push({
      index: i,
      expr: `${display}@{${i}}`,
      oldOid: l.oldOid,
      newOid: l.newOid,
      action: reflogAction(l.message),
      message: l.message,
      who: l.who,
      reachable: null,
    });
  }
  return { entries, warnings: [] };
}
