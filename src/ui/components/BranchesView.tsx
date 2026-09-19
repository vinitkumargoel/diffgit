// biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: the two `<table role="grid">`
// tables below are real ARIA grids — their rows are focusable, walked with `j` / `k` and opened
// with Enter (T11.7 / Design §14.6). Biome's alternative, a `div` tree, would lose table layout
// and demand a focusable wrapper per cell without making anything more accessible.
import { MoreHorizontal, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AheadBehind, BranchRow, TagInfo } from "../../engine/types";
import {
  aheadBehindLabel,
  BAR_W,
  BRANCH_FILTERS,
  type BranchCells,
  barWidths,
  CAPPED_TITLE,
  EMPTY_ACTIVE,
  EMPTY_SEARCH,
  EMPTY_STALE,
  EMPTY_TAGS,
  filterBranches,
  filterTags,
  MERGED_TITLE,
  NO_UPSTREAM,
  overviewCounts,
  previousTag,
  SYNC_TITLE,
  syncHint,
  tagKindLabel,
  tagMessageLine,
} from "../branches";
import { describeError } from "../errors";
import { shortOid } from "../history";
import { useShortcuts } from "../hooks/useShortcuts";
import { refBadges } from "../refGroups";
import { selectBranchBase, useStore } from "../store";
import { timeAgo } from "../timeAgo";
import { WARNING_COPY } from "../warnings";
import { Badge } from "./Badge";
import { CenteredColumn } from "./CenteredColumn";
import { MenuItem } from "./MenuItem";
import { Notice } from "./Notice";
import { PreflightPanel } from "./PreflightPanel";

const SEGMENT_CLASS = "rounded-[6px] px-[7px] py-[2px] text-[11px] leading-4 font-medium";
/**
 * Both tables are `role="grid"` (T11.7): a row is focusable, walked with `j` / `k` and opened with
 * Enter, which is what a grid is and a plain table is not. The file-level suppression at the top
 * covers the two — Biome would rather see the role on a `div`, which costs the column alignment
 * and a focusable wrapper per cell for nothing.
 */
const GRID_CLASS = "w-full border-collapse text-[12.5px]";
const TH_CLASS =
  "sticky top-0 z-[1] border-b border-line bg-surface px-3 py-1.5 text-left text-[11px] leading-4 font-medium text-muted";
const TD_CLASS = "border-b border-line-subtle px-3 py-1.5 align-middle";

/** The small `ref`-style tag Design §14.6 uses for `merged` and the `pull` / `push` hints. */
function RefTag({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="ml-1.5 inline-flex h-4 shrink-0 items-center rounded-full border border-line bg-surface-raised px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap"
    >
      {label}
    </span>
  );
}

/**
 * Design §14.6: "a 60 px two-colour bar (`--success` ahead, `--danger` behind) plus numbers". The
 * bar is decorative — `aria-hidden`, because the numbers next to it say the same thing in text.
 */
function AheadBehindCell({ ab }: { ab: AheadBehind }) {
  const w = barWidths(ab);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden
        data-bar={`${w.ahead}/${w.behind}`}
        style={{ width: BAR_W }}
        className="inline-flex h-1.5 shrink-0 overflow-hidden rounded-[3px] bg-surface-raised"
      >
        <i style={{ width: w.ahead }} className="block h-full bg-success" />
        <i style={{ width: w.behind }} className="block h-full bg-danger" />
      </span>
      <span
        className="font-mono text-[11.5px] tabular-nums"
        title={ab.capped ? CAPPED_TITLE : undefined}
      >
        {aheadBehindLabel(ab)}
      </span>
    </span>
  );
}

/** A cell the engine has not been asked for yet — the same skeleton the commit list uses. */
function CellSkeleton() {
  return <span aria-hidden className="inline-block h-2.5 w-16 rounded-[2px] bg-surface-raised" />;
}

/** `—` with a reason, for a cell that was asked for and has no answer. */
function NoValue({ title }: { title: string }) {
  return (
    <span className="text-muted" title={title}>
      —
    </span>
  );
}

/** Row focus for `j` / `k`, shared by the branches and the tags table (keyboard row navigation). */
function useRowNavigation(count: number) {
  const [focusIndex, setFocusIndex] = useState(0);
  const pending = useRef<number | null>(null);
  const focusRow = useCallback(
    (i: number) => {
      const idx = Math.max(0, Math.min(count - 1, i));
      setFocusIndex(idx);
      pending.current = idx;
    },
    [count],
  );
  useEffect(() => {
    if (pending.current === null) return;
    document.querySelector<HTMLElement>(`[data-row-index="${pending.current}"]`)?.focus();
    pending.current = null;
  });
  useShortcuts({ j: () => focusRow(focusIndex + 1), k: () => focusRow(focusIndex - 1) });
  return { focusIndex, setFocusIndex, focusRow };
}

/** The `…` menu of one branch row (Design §14.6). Closes on Escape and on an outside click. */
function RowMenu({
  row,
  base,
}: {
  row: BranchRow;
  base: { fullName: string; display: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const setSource = useStore((s) => s.setSource);
  const setTarget = useStore((s) => s.setTarget);
  const compareBranchWithBase = useStore((s) => s.compareBranchWithBase);
  const runPreflight = useStore((s) => s.runPreflight);
  const addToast = useStore((s) => s.addToast);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  const copyName = async () => {
    setOpen(false);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(row.ref.name);
      setCopied(true);
    } catch {
      // Blocked clipboard (insecure context / permissions): say so rather than pretend it worked.
      addToast({ level: "warning", message: `Could not copy ${row.ref.name} to the clipboard.` });
    }
  };
  const isBase = base !== null && base.fullName === row.ref.fullName;

  return (
    <div ref={ref} className="relative flex justify-end">
      <button
        type="button"
        className="btn btn-icon size-6"
        aria-label={`More actions for ${row.ref.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${row.ref.name}`}
          className="absolute top-full right-0 z-10 mt-1 w-64 rounded-[6px] border border-line bg-surface py-1 shadow-popover"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MenuItem label="Set as compare" onClick={() => run(() => setSource(row.ref.fullName))} />
          <MenuItem label="Set as base" onClick={() => run(() => setTarget(row.ref.fullName))} />
          <MenuItem
            label={`Compare with ${base?.display ?? "base"}`}
            disabled={isBase || base === null}
            title={isBase ? "This branch is the base." : undefined}
            onClick={() => run(() => compareBranchWithBase(row.ref.fullName))}
          />
          <MenuItem
            label={`Preflight rebase onto ${base?.display ?? "base"}`}
            disabled={isBase || base === null}
            title={
              isBase
                ? "This branch is the base."
                : `Report what git rebase -i ${base?.display ?? "base"} would replay`
            }
            onClick={() => run(() => void runPreflight(row.ref.name, base?.display ?? ""))}
          />
          <MenuItem label={copied ? "Copied" : "Copy name"} onClick={() => void copyName()} />
        </div>
      )}
    </div>
  );
}

function BranchRowCells({
  row,
  cells,
  base,
  now,
}: {
  row: BranchRow;
  cells: BranchCells | undefined;
  base: { fullName: string; display: string } | null;
  now: number;
}) {
  const hint = syncHint(cells?.vsUpstream ?? null);
  const isDefault = row.ref.isDefault;
  return (
    <>
      <td className={TD_CLASS}>
        <span className="flex flex-wrap items-center gap-1">
          <span className="font-mono text-[12px] font-semibold text-ink">{row.ref.name}</span>
          {refBadges(row.ref).map((kind) => (
            <Badge key={kind} kind={kind} />
          ))}
          {row.tags.map((t) => (
            <span
              key={t}
              title={`Tag: ${t}`}
              className="inline-flex h-4 items-center rounded-full border border-status-m-fg/40 bg-status-m-bg px-1.5 font-mono text-[10.5px] leading-4 font-semibold text-status-m-fg"
            >
              {t}
            </span>
          ))}
        </span>
      </td>
      <td className={TD_CLASS} data-cell="upstream">
        {row.upstream === null ? (
          <span className="text-muted" title="This branch tracks no remote branch.">
            {NO_UPSTREAM}
          </span>
        ) : cells === undefined ? (
          <CellSkeleton />
        ) : cells.vsUpstream === null ? (
          <NoValue title={`${row.upstream} could not be counted.`} />
        ) : (
          <>
            <AheadBehindCell ab={cells.vsUpstream} />
            {hint !== null && <RefTag label={hint} title={SYNC_TITLE[hint]} />}
          </>
        )}
      </td>
      <td className={TD_CLASS} data-cell="base">
        {isDefault ? (
          <NoValue title="This is the branch the others are compared with." />
        ) : cells === undefined ? (
          <CellSkeleton />
        ) : cells.vsDefault === null ? (
          <NoValue title={`${base?.display ?? "the base branch"} could not be counted.`} />
        ) : (
          <>
            <AheadBehindCell ab={cells.vsDefault} />
            {cells.merged === true && <RefTag label="merged" title={MERGED_TITLE} />}
          </>
        )}
      </td>
      <td className={`${TD_CLASS} max-w-[26rem]`}>
        {row.lastCommit === null ? (
          <NoValue title={`The commit ${row.ref.name} points at could not be read.`} />
        ) : (
          <span className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-[11px] text-accent">
              {shortOid(row.lastCommit.oid)}
            </span>
            <span className="truncate text-ink" title={row.lastCommit.subject}>
              {row.lastCommit.subject}
            </span>
          </span>
        )}
      </td>
      <td className={`${TD_CLASS} whitespace-nowrap text-muted`}>
        {row.lastCommit?.author ?? "—"}
      </td>
      <td className={`${TD_CLASS} whitespace-nowrap text-muted tabular-nums`}>
        {row.lastCommit === null ? "—" : timeAgo(row.lastCommit.timestamp, now)}
      </td>
      <td className={`${TD_CLASS} w-8`}>
        <RowMenu row={row} base={base} />
      </td>
    </>
  );
}

/** The branches table of Design §14.6: a `grid`, one focusable row per branch. */
function BranchTable({ rows, now }: { rows: BranchRow[]; now: number }) {
  const cells = useStore((s) => s.branches.cells);
  const base = useStore(useShallow(selectBranchBase));
  const defaultName = useStore((s) => s.repo?.defaultRef?.name ?? null);
  const requestBranchCells = useStore((s) => s.requestBranchCells);
  const showBranchHistory = useStore((s) => s.showBranchHistory);
  const { focusIndex, setFocusIndex } = useRowNavigation(rows.length);

  // Lazily filled cells: the rows the table is showing, which the store asks for 50 at a time.
  const names = rows.map((r) => r.ref.fullName).join("\n");
  useEffect(() => {
    if (names === "") return;
    requestBranchCells(names.split("\n"));
  }, [names, requestBranchCells]);

  return (
    <table role="grid" aria-label="Branches" className={GRID_CLASS}>
      <thead>
        <tr>
          {[
            "Branch",
            "vs upstream",
            `vs ${defaultName ?? "base"}`,
            "Last commit",
            "Author",
            "Age",
          ].map((label) => (
            <th key={label} scope="col" className={TH_CLASS}>
              {label}
            </th>
          ))}
          <th scope="col" className={TH_CLASS}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody data-rows>
        {rows.map((row, i) => (
          <tr
            key={row.ref.fullName}
            data-row-index={i}
            data-ref={row.ref.fullName}
            tabIndex={i === focusIndex ? 0 : -1}
            title={`Show the history of ${row.ref.name}`}
            className="cursor-pointer hover:bg-surface-raised focus-visible:bg-accent-subtle"
            onFocus={() => setFocusIndex(i)}
            onClick={() => showBranchHistory(row.ref.fullName)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                showBranchHistory(row.ref.fullName);
              }
            }}
          >
            <BranchRowCells row={row} cells={cells[row.ref.fullName]} base={base} now={now} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The tags table of Design §14.6: name, kind, message, tagger, age, `Compare with previous tag`. */
function TagsTable({ tags, now }: { tags: TagInfo[]; now: number }) {
  const compareTags = useStore((s) => s.compareTags);
  const { focusIndex, setFocusIndex } = useRowNavigation(tags.length);
  const compare = (i: number) => {
    const tag = tags[i];
    const prev = previousTag(tags, i);
    if (tag && prev) compareTags(prev, tag);
  };
  return (
    <table role="grid" aria-label="Tags" className={GRID_CLASS}>
      <thead>
        <tr>
          {["Tag", "Kind", "Message", "Tagger", "Age"].map((label) => (
            <th key={label} scope="col" className={TH_CLASS}>
              {label}
            </th>
          ))}
          <th scope="col" className={TH_CLASS}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody data-rows>
        {tags.map((tag, i) => {
          const prev = previousTag(tags, i);
          return (
            <tr
              key={tag.fullName}
              data-row-index={i}
              data-tag={tag.name}
              tabIndex={i === focusIndex ? 0 : -1}
              className="hover:bg-surface-raised focus-visible:bg-accent-subtle"
              onFocus={() => setFocusIndex(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  compare(i);
                }
              }}
            >
              <td className={TD_CLASS}>
                <span className="font-mono text-[12px] font-semibold text-ink">{tag.name}</span>
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted`}>{tagKindLabel(tag)}</td>
              <td className={`${TD_CLASS} max-w-[26rem]`}>
                {tagMessageLine(tag) === "" ? (
                  <NoValue title="A lightweight tag carries no message." />
                ) : (
                  <span className="truncate text-ink">{tagMessageLine(tag)}</span>
                )}
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted`}>
                {tag.tagger?.name ?? "—"}
              </td>
              <div className={`${TD_CLASS} whitespace-nowrap text-muted tabular-nums`}>
                {tag.timestamp === undefined ? (
                  <NoValue title="A lightweight tag has no date of its own; git reads the commit's." />
                ) : (
                  timeAgo(tag.timestamp, now)
                )}
              </div>
              <td className={TD_CLASS}>
                <button
                  type="button"
                  className="btn btn-sm whitespace-nowrap"
                  disabled={prev === null}
                  title={
                    prev === null
                      ? "This is the oldest tag in the list."
                      : `Compare ${prev.name} with ${tag.name}`
                  }
                  onClick={() => compare(i)}
                >
                  {prev === null ? "Compare with previous tag" : `Compare with ${prev.name}`}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

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
      <TagsTable tags={visibleTags} now={now} />
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
