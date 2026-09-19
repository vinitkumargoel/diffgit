/**
 * Working-tree grep (T10.8, atlas tab 05 scope `grep:`): `git grep -n` over the files the scanner
 * already knows about — tracked entries plus the untracked files the ignore rules let through.
 *
 * The walk is not repeated here: `RepoSession` hands over the path list it gets from
 * `WorktreeScanner`, so the ignore rules, the pruning of `node_modules` and the embedded-repo rule
 * are the ones the sidebar already uses. This module only decides what is worth reading and what a
 * line matches.
 *
 * Skipped without a hit, each for its own reason:
 *   - `generated` files (lockfiles, minified bundles) — the same classifier the diff pane uses;
 *   - files over `GREP_MAX_FILE_BYTES` — read as *skipped*, which makes the result `capped`;
 *   - binary files, by the existing sniffer;
 *   - in regex mode, a file that outruns `REGEX_FILE_BUDGET_MS` — abandoned mid-file and skipped.
 *
 * Files are read in path order in fixed-size batches through the session's concurrency limiter, so
 * the hit list is already sorted by (path, line) and the first `limit` hits are the first `limit`
 * hits git would print, not whichever file's read happened to finish first.
 */
import { isBinary } from "../diff/binary";
import { LARGE_FILE_BYTES } from "../diff/textDiff";
import type { SearchHit, SearchRequest } from "../types";
import { throwIfAborted } from "../util/concurrency";
import {
  createMatcher,
  type Matcher,
  REGEX_FILE_BUDGET_MS,
  type SearchOutcome,
  TimeBudget,
  trimHitText,
} from "./query";

/** Bigger than this is not a file a human greps (atlas tab 05: "reading text files under 1 MB"). */
export const GREP_MAX_FILE_BYTES = LARGE_FILE_BYTES;
/** Files read concurrently per round; the round boundary is what keeps the order deterministic. */
export const GREP_BATCH = 16;

export interface WorktreeSearchDeps {
  /** Candidate paths, already ignore-filtered and scoped, in ascending path order. */
  paths: string[];
  /** File bytes, or null when the path has vanished or cannot be read. */
  read(path: string): Promise<Uint8Array | null>;
  /** `linguist-generated` / the built-in generated classification. */
  isGenerated(path: string): Promise<boolean>;
  /** The session's background-stats concurrency limiter. */
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
  /** Injectable clock for the regex budget (tests). */
  now?: () => number;
}

const decoder = new TextDecoder("utf-8");

interface FileOutcome {
  hits: SearchHit[];
  /** The file's text was examined (fully or until the budget ran out). */
  read: boolean;
  /** The file could not be finished: too large, or the regex budget ran out. */
  skipped: boolean;
}

const NOT_READ: FileOutcome = { hits: [], read: false, skipped: false };

async function scanFile(
  deps: WorktreeSearchDeps,
  matcher: Matcher,
  path: string,
): Promise<FileOutcome> {
  if (await deps.isGenerated(path)) return NOT_READ;
  const bytes = await deps.read(path);
  if (bytes === null) return NOT_READ;
  if (bytes.byteLength > GREP_MAX_FILE_BYTES) return { hits: [], read: false, skipped: true };
  if (isBinary(bytes)) return NOT_READ;

  const lines = decoder.decode(bytes).split("\n");
  // A trailing newline is a terminator, not an empty last line: `git grep -n` never numbers one.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const budget = matcher.regex ? new TimeBudget(REGEX_FILE_BUDGET_MS, deps.now) : null;
  const hits: SearchHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Checked *between* lines: one regex call is not interruptible, so this bounds the file, and
    // `GREP_MAX_FILE_BYTES` bounds the line.
    if (budget?.expired === true) return { hits, read: true, skipped: true };
    const text = lines[i] as string;
    if (matcher.test(text)) {
      hits.push({ kind: "file", path, line: i + 1, text: trimHitText(text) });
    }
  }
  return { hits, read: true, skipped: false };
}

export async function searchWorktree(
  deps: WorktreeSearchDeps,
  req: SearchRequest,
): Promise<SearchOutcome> {
  const matcher = createMatcher(req.query, req.regex === true);
  const limit = Math.max(1, req.limit);
  const hits: SearchHit[] = [];
  let scanned = 0;
  let skipped = 0;
  let hitLimit = false;

  for (let i = 0; i < deps.paths.length; i += GREP_BATCH) {
    throwIfAborted(deps.signal, "working-tree search");
    const batch = deps.paths.slice(i, i + GREP_BATCH);
    const outcomes = await Promise.all(
      batch.map((path) => deps.limit(() => scanFile(deps, matcher, path))),
    );
    for (const o of outcomes) {
      if (o.read) scanned++;
      if (o.skipped) skipped++;
      hits.push(...o.hits);
    }
    deps.onProgress?.(Math.min(i + GREP_BATCH, deps.paths.length), deps.paths.length);
    if (hits.length >= limit) {
      hitLimit = true;
      break;
    }
  }

  const notes: string[] = [];
  if (hitLimit) notes.push(`the first ${limit} matching lines`);
  if (skipped > 0) {
    notes.push(
      skipped === 1
        ? "1 file was too large or ran out of its regex budget"
        : `${skipped} files were too large or ran out of their regex budget`,
    );
  }
  const outcome: SearchOutcome = {
    hits: hits.slice(0, limit),
    scanned,
    capped: hitLimit || skipped > 0,
  };
  if (notes.length > 0) outcome.note = `${notes.join("; ")}.`;
  return outcome;
}
