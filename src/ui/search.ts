/**
 * T11.8 — the search scopes of the command palette (Design §14.1 rule 2, "search scopes live in the
 * command palette"; atlas tab 05 "One palette, three scopes").
 *
 * Everything here is pure: the prefix grammar that picks a scope, the request the store sends, and
 * every string the palette prints. The palette itself only renders what these functions return, so
 * the wording and the `git`-side vocabulary (`docs/v2-contracts.md`: `SearchRequest`, `SearchHit`,
 * `SearchResult`) cannot drift apart between the component and its tests.
 *
 * The grammar is a prefix, not a mode: the same box still runs commands and jumps to files, and a
 * query only becomes a search once it starts with one of `SCOPE_PREFIXES`. `regex:` immediately
 * after the prefix sets `SearchRequest.regex`; without it the query is a **literal substring** and
 * the engine builds no regular expression at all (contracts `<!-- T10.8 -->`), which is why a query
 * full of metacharacters is safe to type.
 */
import type { SearchHit, SearchRequest, SearchResult } from "../engine/types";

/** The three scopes of `SearchRequest`; the name comes from the contract, never from the UI. */
export type SearchScope = SearchRequest["scope"];

/** Keystrokes settle before the engine is asked; one search per pause, not per character. */
export const SEARCH_DEBOUNCE_MS = 200;
/** `SearchRequest.limit` for every scope: the head the palette can usefully show. */
export const SEARCH_HIT_LIMIT = 200;
/** `SearchRequest.commits` for the pickaxe scope — mandatory in the UI (contracts `<!-- T10.8 -->`). */
export const PICKAXE_COMMITS = 200;
/** `Widen ×5` multiplies the range by this… */
export const WIDEN_FACTOR = 5;
/** …up to here, the ceiling the task sets for an explicitly widened pickaxe. */
export const PICKAXE_COMMITS_MAX = 5_000;

/** The modifier that turns the query into a regular expression, written after the scope prefix. */
export const REGEX_PREFIX = "regex:";

export interface ScopePrefix {
  prefix: string;
  scope: SearchScope;
  /** The group heading and the Scopes row label. */
  label: string;
  /** What that scope reads, for the Scopes row and the footer. */
  note: string;
  /** True for a spelling that is accepted but not advertised (the atlas mockup's `msg:`). */
  alias?: boolean;
}

/**
 * Order matters only in that the first match wins; the three prefixes cannot collide. `msg:` is the
 * spelling the atlas mockup prints for the commit scope and the task file spells `>`, so both are
 * accepted and only `>` is advertised.
 */
export const SCOPE_PREFIXES: readonly ScopePrefix[] = [
  { prefix: ">", scope: "commits", label: "Commits", note: "messages, authors and SHAs" },
  {
    prefix: "msg:",
    scope: "commits",
    label: "Commits",
    note: "messages, authors and SHAs",
    alias: true,
  },
  {
    prefix: "grep:",
    scope: "worktree",
    label: "Working tree",
    note: "files on disk, ignore rules applied",
  },
  {
    prefix: "-S",
    scope: "pickaxe",
    label: "History contents",
    note: "commits that add or remove the text",
  },
];

/** The rows the palette offers under "Scopes", and the prefixes the footer line names. */
export const ADVERTISED_PREFIXES: readonly ScopePrefix[] = SCOPE_PREFIXES.filter((p) => !p.alias);

export interface ParsedSearch {
  scope: SearchScope;
  /** The prefix that selected the scope, so the palette can echo what it is doing. */
  prefix: string;
  /** What is searched for, already trimmed; empty while only the prefix has been typed. */
  query: string;
  regex: boolean;
}

/**
 * The parsed scope of the palette's input, or `null` when it carries no prefix — in which case the
 * palette is still the command list it was before this task.
 */
export function parseSearch(input: string): ParsedSearch | null {
  for (const p of SCOPE_PREFIXES) {
    if (!input.startsWith(p.prefix)) continue;
    const rest = input.slice(p.prefix.length).replace(/^\s+/, "");
    const regex = rest.toLowerCase().startsWith(REGEX_PREFIX);
    const query = regex ? rest.slice(REGEX_PREFIX.length) : rest;
    return { scope: p.scope, prefix: p.prefix, query: query.trim(), regex };
  }
  return null;
}

export function scopeLabel(scope: SearchScope): string {
  return SCOPE_PREFIXES.find((p) => p.scope === scope)?.label ?? scope;
}

/** The next pickaxe range for `Widen ×5`, or null once the ceiling is reached. */
export function nextWiden(commits: number): number | null {
  if (commits >= PICKAXE_COMMITS_MAX) return null;
  return Math.min(commits * WIDEN_FACTOR, PICKAXE_COMMITS_MAX);
}

/** Atlas tab 05: the widen row says what it will cost, not just that it widens. */
export function widenLabel(next: number): string {
  return `Widen ×${WIDEN_FACTOR} to ${next.toLocaleString("en-US")} commits`;
}

/** `Commits · 3 matches`, `Working tree · 8 matching lines`, `History contents · 33 commits`. */
export function resultsHeading(scope: SearchScope, count: number): string {
  const what =
    scope === "worktree"
      ? `${count.toLocaleString("en-US")} matching ${count === 1 ? "line" : "lines"}`
      : `${count.toLocaleString("en-US")} ${count === 1 ? "commit" : "commits"}`;
  return `${scopeLabel(scope)} · ${what}`;
}

/** `12 ms` / `1.3 s` — the cost the atlas insists is always visible. */
export function formatSearchDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** `Scanned 200 commits · 0.9 s` (atlas tab 05: "the cost is visible and chosen"). */
export function scannedLine(scope: SearchScope, result: SearchResult): string {
  const n = result.scanned;
  const unit = scope === "worktree" ? (n === 1 ? "file" : "files") : n === 1 ? "commit" : "commits";
  const verb = scope === "worktree" ? "Read" : "Scanned";
  return `${verb} ${n.toLocaleString("en-US")} ${unit} · ${formatSearchDuration(result.durationMs)}`;
}

/**
 * `SEARCH_CAPPED` as **one line inside the results** rather than a banner: the answer is partial
 * for exactly one search, and a repository-level banner would outlive it (contracts: `capped` means
 * the answer is incomplete for any reason — the hit limit, the commit cap or a skipped file).
 */
export const CAPPED_LINE = "This answer is partial: the search stopped at one of its limits.";

/** A query that found nothing has to say so; silence reads like a broken box. */
export function emptyLine(scope: SearchScope, query: string): string {
  const where =
    scope === "commits"
      ? "commit message, author or SHA"
      : scope === "worktree"
        ? "file in the working tree"
        : "commit in the scanned range";
  return `No ${where} matches “${query}”.`;
}

/** Shown while only the prefix has been typed. */
export function promptLine(scope: SearchScope): string {
  const p = SCOPE_PREFIXES.find((x) => x.scope === scope);
  return `Type what to look for in ${(p?.label ?? scope).toLowerCase()} — ${p?.note ?? ""}.`;
}

/**
 * The footer line of Design §14.1's escape hatch: the whole grammar in one row, so the three scopes
 * are discoverable without a second surface. `> commits · grep: working tree · …`.
 */
export const FOOTER_LINE = `${ADVERTISED_PREFIXES.map((p) => `${p.prefix} ${p.label.toLowerCase()}`).join(" · ")} · ${REGEX_PREFIX} pattern`;

/** `src/cart/total.ts:42` — where one working-tree hit is. */
export function hitLocation(hit: SearchHit): string {
  const path = hit.path ?? "";
  return hit.line === undefined ? path : `${path}:${hit.line}`;
}

/** `+4 occurrences` / `−1 occurrence`, the pickaxe's `delta` (U+2212 like every other count). */
export function occurrencesLabel(delta: number): string {
  const n = Math.abs(delta);
  return `${delta < 0 ? "−" : "+"}${n.toLocaleString("en-US")} ${n === 1 ? "occurrence" : "occurrences"}`;
}

/** The pickaxe's extra hit for uncommitted work: no `oid`, and it opens Files mode. */
export const WORKING_TREE_HIT = "working";

/** A grep hit outside the current comparison has no card to open; the palette says so. */
export function notInDiffNote(path: string): string {
  return `${path} is not part of the current comparison, so there is no card to open.`;
}
