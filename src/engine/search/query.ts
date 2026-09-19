/**
 * The two match modes every search scope shares (T10.8, atlas tab 05 "Risks": *literal match by
 * default, regex opt-in with a length cap*).
 *
 * Everything here is pure — no I/O, no clock except the explicit `TimeBudget` a caller hands in.
 *
 * **Exact mode never builds a regex at all.** `indexOf` on a case-folded copy is the whole
 * implementation, so a query full of `(`, `*` or `\` is a plain substring and there is no pattern
 * to inject into and no backtracking to trigger. Regex mode is opt-in and hardened three ways:
 * a `REGEX_MAX_LENGTH` cap, the `u` flag (which rejects the sloppy escapes a hand-typed pattern
 * usually gets wrong before the engine ever runs it), and `try`/`catch` around construction so a
 * malformed pattern is an error the palette can show rather than a worker crash.
 *
 * Catastrophic backtracking cannot be detected by inspecting a pattern, so the residual risk is
 * bounded the way the atlas prescribes instead: matching runs in the engine **worker**, every scope
 * checks its `AbortSignal`, and the file scopes give each file a `REGEX_FILE_BUDGET_MS` budget —
 * a file that outruns it is abandoned, counted as skipped and reported through `SEARCH_CAPPED`.
 */
import { EngineError } from "../errors";
import type { SearchHit, SearchRequest } from "../types";

/** A regex a human typed into a palette. Longer than this is a paste, not a search. */
export const REGEX_MAX_LENGTH = 200;
/** A literal may be longer (a pasted line), but not unbounded. */
export const QUERY_MAX_LENGTH = 1024;
/** How long one file may spend matching before it is abandoned (T10.8 deliverables). */
export const REGEX_FILE_BUDGET_MS = 50;
/** `SearchHit.text` is a preview, not the file: git's own `grep` output is trimmed the same way. */
export const HIT_TEXT_MAX = 200;

/** Case-insensitive by design (Design §14: one box, no modifier soup); `count` is non-overlapping. */
export interface Matcher {
  /** True when this matcher was built from a regular expression rather than a literal. */
  readonly regex: boolean;
  /** The query as the caller typed it (for messages). */
  readonly source: string;
  test(text: string): boolean;
  /** Non-overlapping occurrences — the number `git log -S` compares on each side of a change. */
  count(text: string): number;
}

function invalid(message: string, hint: string): EngineError {
  // There is no public code for "the user typed something we cannot use"; phase 10 spells bad
  // input `INTERNAL` with a hint (tasks/phase-10-engine/T10.5b-walker-fixes.md, nit 5).
  return new EngineError("INTERNAL", message, { hint });
}

class LiteralMatcher implements Matcher {
  readonly regex = false;
  private readonly needle: string;

  constructor(readonly source: string) {
    this.needle = source.toLowerCase();
  }

  test(text: string): boolean {
    return text.toLowerCase().includes(this.needle);
  }

  count(text: string): number {
    const hay = text.toLowerCase();
    let n = 0;
    let at = hay.indexOf(this.needle);
    while (at !== -1) {
      n++;
      at = hay.indexOf(this.needle, at + this.needle.length);
    }
    return n;
  }
}

class RegexMatcher implements Matcher {
  readonly regex = true;
  private readonly re: RegExp;

  constructor(readonly source: string) {
    try {
      // `g` so `count` can walk a line, `i` because search is case-insensitive in both modes, and
      // `u` so an unsupported escape is rejected here instead of matching something surprising.
      this.re = new RegExp(source, "giu");
    } catch (e) {
      throw invalid(
        `${source} is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`,
        "Switch off regex mode to search for the text itself",
      );
    }
  }

  test(text: string): boolean {
    this.re.lastIndex = 0;
    return this.re.test(text);
  }

  count(text: string): number {
    this.re.lastIndex = 0;
    let n = 0;
    let m = this.re.exec(text);
    while (m !== null) {
      n++;
      if (this.re.lastIndex === m.index) this.re.lastIndex++; // zero-width guard
      m = this.re.exec(text);
    }
    this.re.lastIndex = 0;
    return n;
  }
}

/**
 * The matcher for one `SearchRequest`. Rejects an empty query, a query over `QUERY_MAX_LENGTH`, a
 * regex over `REGEX_MAX_LENGTH` and a regex that does not compile under the `u` flag.
 */
export function createMatcher(query: string, regex = false): Matcher {
  if (query.length === 0) throw invalid("The search query is empty.", "Type something to find");
  if (query.length > QUERY_MAX_LENGTH) {
    throw invalid(
      `The search query is ${query.length} characters; the limit is ${QUERY_MAX_LENGTH}.`,
      "Search for a shorter phrase",
    );
  }
  if (!regex) return new LiteralMatcher(query);
  if (query.length > REGEX_MAX_LENGTH) {
    throw invalid(
      `A regular expression may be at most ${REGEX_MAX_LENGTH} characters; this one is ${query.length}.`,
      "Shorten the pattern, or search for the text itself",
    );
  }
  return new RegexMatcher(query);
}

/** True when the query could be the start of an object name (`git log <sha>` in the palette). */
export function isOidPrefix(query: string): boolean {
  return /^[0-9a-fA-F]{4,40}$/.test(query);
}

/** One line of a file, as `SearchHit.text`: no `\r`, no newline, at most `HIT_TEXT_MAX` characters. */
export function trimHitText(text: string): string {
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  return line.length > HIT_TEXT_MAX ? line.slice(0, HIT_TEXT_MAX) : line;
}

/**
 * A wall-clock budget for one unit of work (one file). Deliberately a class with an explicit
 * `now`, so tests can drive it without sleeping.
 */
export class TimeBudget {
  private readonly deadline: number;

  constructor(
    ms: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.deadline = this.now() + ms;
  }

  get expired(): boolean {
    return this.now() >= this.deadline;
  }
}

/**
 * What a scope hands back to `RepoSession.search`, which adds `durationMs` and raises
 * `SEARCH_CAPPED`. `note` becomes the warning's `detail` so the banner can say *why* the answer is
 * partial ("the hit limit", "1 file gave up on its regex budget").
 */
export interface SearchOutcome {
  hits: SearchHit[];
  scanned: number;
  capped: boolean;
  note?: string;
}

/**
 * A stable key for one request, so `bun run record` and `workerClient.mock.ts` agree on which
 * recorded `SearchResult` answers it. Not part of the engine's behaviour — only its recordings.
 */
export function searchKey(req: SearchRequest): string {
  return [
    req.scope,
    req.regex === true ? "re" : "lit",
    req.path ?? "",
    req.commits ?? "",
    req.query,
  ].join("|");
}
