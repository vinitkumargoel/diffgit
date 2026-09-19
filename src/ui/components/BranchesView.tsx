import { Search } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import {
  BRANCH_FILTERS,
  EMPTY_ACTIVE,
  EMPTY_SEARCH,
  EMPTY_STALE,
  EMPTY_TAGS,
  filterBranches,
  filterTags,
  overviewCounts,
} from "../branches";
import { describeError } from "../errors";
import { useStore } from "../store";
import { WARNING_COPY } from "../warnings";
import { BranchTable } from "./BranchTable";
import { SEGMENT_CLASS } from "./branches.styles";
import { CenteredColumn } from "./CenteredColumn";
import { Notice } from "./Notice";
import { PreflightPanel } from "./PreflightPanel";
import { TagTable } from "./TagTable";

/** The page's own header, which replaces the StatsRow in this mode (Design §14.1). */
function BranchesHeader({ counts }: { counts: string }) {
  const filter = useStore((s) => s.branches.filter);
  const query = useStore((s) => s.branches.query);
  const setBranchFilter = useStore((s) => s.setBranchFilter);
  const setBranchQuery = useStore((s) => s.setBranchQuery);
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-3 py-1 text-[12.5px] leading-5 text-muted">
      <fieldset className="inline-flex rounded-[6px] border border-line bg-surface-raised p-0">
        <legend className="sr-only">Which branches to show</legend>
        {BRANCH_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            className={`${SEGMENT_CLASS} ${filter === f.id ? "pressed" : "text-muted hover:text-ink"}`}
            onClick={() => setBranchFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </fieldset>
      <label className="flex min-w-[10rem] flex-1 items-center gap-1.5">
        <Search size={13} aria-hidden className="shrink-0 text-muted" />
        <span className="sr-only">Search branches and tags</span>
        <input
          type="search"
          value={query}
          placeholder="Search branches and tags"
          className="min-w-0 flex-1 bg-transparent text-[12px] leading-5 text-ink outline-none placeholder:text-muted"
          onChange={(e) => setBranchQuery(e.target.value)}
        />
      </label>
      <span className="shrink-0 tabular-nums">{counts}</span>
    </div>
  );
}

/**
 * Branches mode (Design §14.6, atlas tab 09): the page that answers "what is the state of this
 * repository" — every branch with its ahead/behind against its upstream and against the base
 * branch, and every tag. It replaces the body in mode `3`; its header replaces the StatsRow
 * (§14.1), so the page adds no chrome to the bars.
 *
 * `now` is a prop so the 90-day filter and the Age column can be pinned in tests; it defaults to
 * the wall clock, exactly as the commit list's own `now` does.
 */
export function BranchesView({ now = Date.now() }: { now?: number } = {}) {
  const rows = useStore((s) => s.branches.rows);
  const loading = useStore((s) => s.branches.loading);
  const error = useStore((s) => s.branches.error);
  const filter = useStore((s) => s.branches.filter);
  const query = useStore((s) => s.branches.query);
  const tags = useStore((s) => s.tags);
  const repoId = useStore((s) => s.repoId);
  const loadBranches = useStore((s) => s.loadBranches);
  const loadPickerSources = useStore((s) => s.loadPickerSources);
  const setBranchFilter = useStore((s) => s.setBranchFilter);
  // T11.13: the preflight report is a panel in this body, not a mode (Design §14.6).
  const preflightOpen = useStore((s) => s.preflight.branch !== null);

  // One overview and one tag listing per repository. A ref rather than `rows === null`, so a call
  // that fails asks once and stops instead of re-firing on every render (as `HistoryView` does).
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (asked.current === repoId) return;
    asked.current = repoId;
    void loadBranches();
    void loadPickerSources();
  }, [repoId, loadBranches, loadPickerSources]);

  const visible = useMemo(
    () => filterBranches(rows ?? [], filter, query, now),
    [rows, filter, query, now],
  );
  const visibleTags = useMemo(() => filterTags(tags ?? [], query), [tags, query]);
  const counts = overviewCounts(rows ?? [], tags?.length ?? 0);
  /**
   * `branchOverview` emits `HISTORY_DEGRADED` for a ref whose tip it could not read and hands the
   * row back without a `lastCommit`; the rows are therefore the durable record of it (the warning
   * itself is replaced by the next `recompute`). One inline line, never one per row.
   */
  const degraded = (rows ?? []).filter((r) => r.lastCommit === null).length;

  const table =
    filter === "tags" ? (
      <TagTable tags={visibleTags} now={now} />
    ) : (
      <BranchTable rows={visible} now={now} />
    );
  const empty =
    filter === "tags"
      ? tags !== null && visibleTags.length === 0
      : rows !== null && !loading && visible.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BranchesHeader counts={counts} />
      {degraded > 0 && (
        <p className="shrink-0 border-b border-banner-warning-border bg-banner-warning-bg px-3 py-1.5 text-[11.5px] leading-4 text-ink">
          <b className="font-medium">{WARNING_COPY.HISTORY_DEGRADED.subject}</b> ·{" "}
          {WARNING_COPY.HISTORY_DEGRADED.message} {degraded}{" "}
          {degraded === 1 ? "branch has" : "branches have"} no last commit.
        </p>
      )}
      <div id="diff" className="min-h-0 flex-1 overflow-y-auto">
        {preflightOpen ? (
          <PreflightPanel />
        ) : error !== null ? (
          <CenteredColumn as="section" label="Branches">
            <Notice detail={describeError(error.code).message} code={error.code}>
              Couldn’t list the branches of this repository
            </Notice>
          </CenteredColumn>
        ) : rows === null ? (
          <p role="status" className="px-3 py-3 text-[12.5px] leading-5 text-muted">
            Reading the branches…
          </p>
        ) : (
          <>
            {table}
            {empty && (
              <p className="px-3 py-3 text-[12.5px] leading-5 text-muted">
                {filter === "tags" ? (
                  EMPTY_TAGS
                ) : query.trim() !== "" ? (
                  EMPTY_SEARCH
                ) : filter === "active" ? (
                  <>
                    {EMPTY_ACTIVE}{" "}
                    <button
                      type="button"
                      className="text-accent underline"
                      onClick={() => setBranchFilter("stale")}
                    >
                      Show stale branches
                    </button>
                    .
                  </>
                ) : (
                  EMPTY_STALE
                )}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
