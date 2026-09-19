/**
 * Branches mode, pure part (T11.7, Design §14.6; atlas tab 09).
 *
 * Maths and strings only: which rows a filter keeps, the order the table shows them in, the two
 * widths of the 60 px ahead/behind bar, and every label the table and the tags list print. No
 * React and no engine calls — the store owns those — so `branches.test.ts` can check the rules on
 * the recorded `history` / `octopus` overviews without rendering anything.
 */
import type { AheadBehind, BranchRow, TagInfo } from "../engine/types";

/** Design §14.6 / atlas tab 09: the middle filter is literally `Stale > 90 d`. */
export const STALE_DAYS = 90;
export const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/** `branchCells` is asked for this many rows at a time (T11.7: "50 at a time"). */
export const BRANCH_CELL_BATCH = 50;

/** Width of the two-colour ahead/behind bar, in px (Design §14.6 "a 60 px two-colour bar"). */
export const BAR_W = 60;
/** px of bar per commit, before the pair is squeezed into `BAR_W` (the atlas mockup's own scale). */
const BAR_PER_COMMIT = 10;

export type BranchFilter = "active" | "stale" | "tags";

export const BRANCH_FILTERS: { id: BranchFilter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "stale", label: `Stale > ${STALE_DAYS} d` },
  { id: "tags", label: "Tags" },
];

/** The three cells `branchOverview` leaves null and `branchCells` fills (docs/v2-contracts.md). */
export type BranchCells = Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">;

/**
 * A branch nobody has committed to for 90 days. A row whose tip commit could not be read
 * (`lastCommit === null`, a `HISTORY_DEGRADED` case) has no date, so it is never called stale —
 * "we do not know" must not print as "old".
 */
export function isStale(row: BranchRow, now: number): boolean {
  return row.lastCommit !== null && now - row.lastCommit.timestamp > STALE_MS;
}

/** The search box: branch name, upstream, last subject and last author. */
export function matchesBranch(row: BranchRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    row.ref.name.toLowerCase().includes(q) ||
    (row.upstream ?? "").toLowerCase().includes(q) ||
    (row.lastCommit?.subject ?? "").toLowerCase().includes(q) ||
    (row.lastCommit?.author ?? "").toLowerCase().includes(q) ||
    row.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/**
 * T11.7 "sort by age": most recently committed first. A row with no readable tip sorts last, and
 * equal timestamps fall back to the name so the order never depends on `branchOverview`'s own.
 */
export function sortBranches(rows: readonly BranchRow[]): BranchRow[] {
  return [...rows].sort((a, b) => {
    const at = a.lastCommit?.timestamp ?? Number.NEGATIVE_INFINITY;
    const bt = b.lastCommit?.timestamp ?? Number.NEGATIVE_INFINITY;
    return bt - at || a.ref.name.localeCompare(b.ref.name);
  });
}

/** `Active` / `Stale > 90 d` plus the search box, in the order the table shows them. */
export function filterBranches(
  rows: readonly BranchRow[],
  filter: BranchFilter,
  query: string,
  now: number,
): BranchRow[] {
  const stale = filter === "stale";
  return sortBranches(rows.filter((r) => isStale(r, now) === stale && matchesBranch(r, query)));
}

/**
 * One count of an `AheadBehind`. `capped` means the divergence walk hit its 10,000-commit cap
 * (`docs/v2-contracts.md` T10.5b), so both counts are **lower bounds** — the `≥` says so instead
 * of printing a number that looks exact.
 */
export function countLabel(n: number, capped: boolean): string {
  return `${capped ? "≥" : ""}${n.toLocaleString("en-US")}`;
}

/** `4 ↑ 0 ↓`, or `≥4 ↑ ≥0 ↓` once the walk was capped. */
export function aheadBehindLabel(ab: AheadBehind): string {
  return `${countLabel(ab.ahead, ab.capped)} ↑ ${countLabel(ab.behind, ab.capped)} ↓`;
}

/** The sentence behind a capped pair, so the `≥` is never unexplained. */
export const CAPPED_TITLE =
  "The divergence walk stopped at its 10,000-commit cap, so these counts are lower bounds.";

/**
 * The two segment widths of the 60 px bar, exactly as the atlas mockup draws them: 10 px per
 * commit, the ahead segment first, and the behind segment gets whatever is left of the 60 px.
 * The bar is decorative — the numbers beside it carry the value — so it needs no contrast ratio.
 */
export function barWidths(ab: AheadBehind): { ahead: number; behind: number } {
  const ahead = Math.min(BAR_W, ab.ahead * BAR_PER_COMMIT);
  return { ahead, behind: Math.min(BAR_W - ahead, ab.behind * BAR_PER_COMMIT) };
}

/**
 * Design §14.6: `pull` / `push` are **hints**, never actions — diffgit is read-only (D16), so the
 * tag says what git would do and the title carries the command to run yourself.
 */
export type SyncHint = "pull" | "push" | "diverged" | null;

export function syncHint(ab: AheadBehind | null): SyncHint {
  if (!ab) return null;
  if (ab.ahead > 0 && ab.behind > 0) return "diverged";
  if (ab.behind > 0) return "pull";
  if (ab.ahead > 0) return "push";
  return null;
}

export const SYNC_TITLE: Record<Exclude<SyncHint, null>, string> = {
  pull: "The upstream has commits this branch does not — `git pull` would fast-forward it.",
  push: "This branch has commits its upstream does not — `git push` would publish them.",
  diverged: "Both sides have commits the other does not; a pull would merge or rebase.",
};

export const NO_UPSTREAM = "no upstream";
export const MERGED_TITLE = "Every commit on this branch is already on the base branch.";

/** `annotated` / `lightweight` — the second column of the tags table (T11.7). */
export function tagKindLabel(tag: TagInfo): string {
  return tag.annotated ? "annotated" : "lightweight";
}

/** The first line of an annotated tag's message; a lightweight tag has none. */
export function tagMessageLine(tag: TagInfo): string {
  return (tag.message ?? "").split("\n")[0]?.trim() ?? "";
}

/**
 * Tags newest first. git gives a **lightweight** tag no date of its own (it is a ref, not an
 * object), so a date sort would order half the list by nothing; the name, compared numerically,
 * is the one key every tag has and is what `v1.10.0 > v1.9.0` needs. Annotated tags keep their
 * tagger date in the Age column, which is the only date that is really theirs.
 */
const TAG_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function sortTags(tags: readonly TagInfo[]): TagInfo[] {
  return [...tags].sort((a, b) => TAG_COLLATOR.compare(b.name, a.name));
}

/** The next tag down the sorted list — the `prev` of `Compare with previous tag`. */
export function previousTag(sorted: readonly TagInfo[], index: number): TagInfo | null {
  return sorted[index + 1] ?? null;
}

export function matchesTag(tag: TagInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    tag.name.toLowerCase().includes(q) ||
    tagMessageLine(tag).toLowerCase().includes(q) ||
    (tag.tagger?.name ?? "").toLowerCase().includes(q)
  );
}

/** The tags table, filtered and ordered. */
export function filterTags(tags: readonly TagInfo[], query: string): TagInfo[] {
  return sortTags(tags.filter((t) => matchesTag(t, query)));
}

/** `7 local · 12 remote-tracking · 9 tags` — the header's count line (atlas tab 09). */
export function overviewCounts(rows: readonly BranchRow[], tags: number): string {
  const local = rows.filter((r) => r.ref.kind === "local").length;
  const remote = rows.length - local;
  return `${local} local · ${remote} remote-tracking · ${tags} ${tags === 1 ? "tag" : "tags"}`;
}

/** Copy shown when a filter keeps nothing; the Active case offers the other filter (§14.6). */
export const EMPTY_ACTIVE = `No branch has been committed to in the last ${STALE_DAYS} days.`;
export const EMPTY_STALE = `Every branch has been committed to in the last ${STALE_DAYS} days.`;
export const EMPTY_SEARCH = "No branch matches this search.";
export const EMPTY_TAGS = "This repository has no tags that name a commit.";
