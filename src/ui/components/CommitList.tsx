import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { markOf } from "../bisect";
import { ROW_H } from "../history";
import { useShortcuts } from "../hooks/useShortcuts";
import { useSidebarResize } from "../hooks/useSidebarResize";
import { type HistoryTab, selectHistoryRows, useStore } from "../store";
import { WARNING_COPY } from "../warnings";
import { CommitRow } from "./CommitRow";
import { ReflogList } from "./ReflogList";
import { StackList } from "./StackList";

const TABS: { id: HistoryTab; label: string }[] = [
  { id: "commits", label: "Commits" },
  { id: "stack", label: "Stack" },
  { id: "reflog", label: "Reflog" },
];

const SEGMENT_CLASS = "rounded-[6px] px-[7px] py-[2px] text-[11px] leading-4 font-medium";
/** Rows above this count are virtualised, exactly as the file tree is (T5.2, Plan §6.7). */
const VIRTUALISE_ABOVE = 300;
/** Rows left below the viewport before the next page is asked for. */
const PREFETCH_ROWS = 10;
/** How close to the bottom of the list a scroll has to get before the next page is asked for. */
const PREFETCH_PX = 200;

/**
 * History sidebar (Design §14.5): row 1 the `Commits | Stack | Reflog` control and the count, row 2
 * the search box and the `first-parent` / `all branches` toggles, then the virtualised commit list
 * with its lane column. It replaces the file tree in History mode — §14 rule 3 keeps the tree for
 * Files only.
 */
export function CommitList({ initialRect }: { initialRect?: { width: number; height: number } }) {
  const tab = useStore((s) => s.historyTab);
  const setHistoryTab = useStore((s) => s.setHistoryTab);
  const width = useStore((s) => s.prefs.sidebarWidth);
  const setPref = useStore((s) => s.setPref);
  const { shown, handleProps } = useSidebarResize(width, (w) => setPref("sidebarWidth", w));

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-line bg-surface-sunken text-ink"
      style={{ width: shown }}
      aria-label="History"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <fieldset className="inline-flex rounded-[6px] border border-line bg-surface-raised p-0">
          <legend className="sr-only">History view</legend>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              className={`${SEGMENT_CLASS} ${
                tab === t.id ? "pressed" : "text-muted hover:text-ink"
              }`}
              onClick={() => setHistoryTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </fieldset>
        <HistoryCount tab={tab} />
      </div>
      {tab === "commits" && <CommitsTab initialRect={initialRect} />}
      {tab === "stack" && <StackList />}
      {tab === "reflog" && <ReflogTab />}
      <hr {...handleProps} />
    </aside>
  );
}

/** Row 1's right-hand count: `50 of 1,284` in Design §14.5, honest about what has been walked. */
function HistoryCount({ tab }: { tab: HistoryTab }) {
  const loaded = useStore((s) => s.history.commits.length);
  const complete = useStore((s) => s.history.cursor === null);
  const matching = useStore(selectHistoryRows).length;
  const stack = useStore((s) => s.stack.commits.length);
  const reflog = useStore((s) => s.reflog?.length ?? 0);
  if (tab === "stack")
    return <span className="ml-auto text-[11px] text-muted">{stack} commits</span>;
  if (tab === "reflog")
    return <span className="ml-auto text-[11px] text-muted">{reflog} entries</span>;
  return (
    <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
      {matching === loaded
        ? `${loaded} ${complete ? "commits" : "loaded"}`
        : `${matching} of ${loaded}`}
    </span>
  );
}

/** The Reflog sub-tab: T11.3's list, with a row opening the commit the way the Commits tab does. */
function ReflogTab() {
  const showCommit = useStore((s) => s.showCommit);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ReflogList onSelect={(oid) => void showCommit(oid)} />
    </div>
  );
}

function CommitsTab({ initialRect }: { initialRect?: { width: number; height: number } }) {
  const rows = useStore(useShallow(selectHistoryRows));
  const loaded = useStore((s) => s.history.commits.length);
  const cursor = useStore((s) => s.history.cursor);
  const loading = useStore((s) => s.history.loading);
  const capped = useStore((s) => s.history.capped);
  const laneOverflow = useStore((s) => s.history.laneOverflow);
  const query = useStore((s) => s.history.query);
  const firstParent = useStore((s) => s.history.firstParent);
  const all = useStore((s) => s.history.all);
  const selected = useStore((s) => s.history.selected);
  const rangeStart = useStore((s) => s.history.rangeStart);
  const statsMap = useStore((s) => s.commitStats);
  const refs = useStore((s) => s.repo);
  const setHistoryQuery = useStore((s) => s.setHistoryQuery);
  const setHistoryOption = useStore((s) => s.setHistoryOption);
  const loadHistory = useStore((s) => s.loadHistory);
  const showCommit = useStore((s) => s.showCommit);
  const searchCommits = useStore((s) => s.searchCommits);
  const requestCommitStats = useStore((s) => s.requestCommitStats);
  // T11.13: the marks live in the store, so they survive every mode switch and every re-walk.
  const bisect = useStore(useShallow((s) => s.bisect));
  const markBisect = useStore((s) => s.markBisect);

  const [focusIndex, setFocusIndex] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const now = useMemo(() => Date.now(), []);

  const virtual = rows.length > VIRTUALISE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (i) => rows[i]?.oid ?? i,
    overscan: 10,
    ...(initialRect ? { initialRect } : {}),
  });
  const items = virtualizer.getVirtualItems();

  // `commitStats` for the rows on screen, batched the way file stats are prioritised (§7.2).
  const visibleKey = (virtual ? items.map((v) => rows[v.index]) : rows)
    .map((c) => c?.oid ?? "")
    .join("\n");
  useEffect(() => {
    if (visibleKey === "") return;
    const t = setTimeout(() => requestCommitStats(visibleKey.split("\n").filter(Boolean)), 100);
    return () => clearTimeout(t);
  }, [visibleKey, requestCommitStats]);

  /** Infinite scroll: the next page is asked for before the last rows reach the fold. */
  const more = useCallback(() => {
    if (useStore.getState().history.cursor === null) return;
    if (useStore.getState().history.loading) return;
    void loadHistory();
  }, [loadHistory]);
  const lastVisible = items.length > 0 ? (items[items.length - 1]?.index ?? 0) : 0;
  useEffect(() => {
    if (!virtual || cursor === null || loading) return;
    if (rows.length - lastVisible <= PREFETCH_ROWS) more();
  }, [virtual, cursor, loading, rows.length, lastVisible, more]);

  const focusRow = useCallback(
    (i: number) => {
      const idx = Math.max(0, Math.min(rows.length - 1, i));
      setFocusIndex(idx);
      pendingFocus.current = idx;
      if (virtual) virtualizer.scrollToIndex(idx, { align: "auto" });
    },
    [rows.length, virtual, virtualizer],
  );
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-index="${pendingFocus.current}"]`,
    );
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });
  useShortcuts({
    j: () => focusRow(focusIndex + 1),
    k: () => focusRow(focusIndex - 1),
  });

  const onSelect = (oid: string, extend: boolean) => {
    setNote(null);
    // Design §14.5's `Start bisect…`: while the strip is asking for an end, a click in the list is
    // that mark rather than a selection. The strip says which end it wants, so nothing is implicit.
    const picking = bisect?.picking ?? null;
    if (picking !== null) {
      void markBisect(picking, oid);
      return;
    }
    void showCommit(oid, { extend });
  };

  const onSearchEnter = async () => {
    if (rows.length > 0 || query.trim() === "") return;
    const hits = await searchCommits(query.trim());
    if (hits === null) {
      setNote("diffgit searched the commits it has walked. More load as you scroll.");
      return;
    }
    if (hits.length === 0) {
      setNote("No commit in this repository matches.");
      return;
    }
    setNote(`${hits.length} ${hits.length === 1 ? "commit matches" : "commits match"}.`);
    const first = hits[0];
    if (first) void showCommit(first);
  };

  return (
    <>
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line px-3">
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <Search size={13} aria-hidden className="shrink-0 text-muted" />
          <span className="sr-only">Search commits</span>
          <input
            type="search"
            value={query}
            placeholder="Search message, author or SHA"
            className="min-w-0 flex-1 bg-transparent text-[12px] leading-5 text-ink outline-none placeholder:text-muted"
            onChange={(e) => {
              setNote(null);
              setHistoryQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onSearchEnter();
              }
            }}
          />
        </label>
        <button
          type="button"
          aria-pressed={firstParent}
          title="Follow only the first parent of every merge"
          className={`${SEGMENT_CLASS} shrink-0 rounded-[6px] border border-line ${
            firstParent ? "pressed" : "text-muted hover:text-ink"
          }`}
          onClick={() => setHistoryOption("firstParent", !firstParent)}
        >
          first-parent
        </button>
        <button
          type="button"
          aria-pressed={all}
          title="Walk every branch, tag and stash, not just this one"
          className={`${SEGMENT_CLASS} shrink-0 rounded-[6px] border border-line ${
            all ? "pressed" : "text-muted hover:text-ink"
          }`}
          onClick={() => setHistoryOption("all", !all)}
        >
          all branches
        </button>
      </div>
      {capped && (
        <p className="shrink-0 border-b border-banner-warning-border bg-banner-warning-bg px-3 py-1.5 text-[11.5px] leading-4 text-ink">
          <b className="font-medium">{WARNING_COPY.HISTORY_CAPPED.subject}</b> ·{" "}
          {WARNING_COPY.HISTORY_CAPPED.message}
        </p>
      )}
      {laneOverflow && !firstParent && (
        <p className="shrink-0 border-b border-line-subtle px-3 py-1.5 text-[11.5px] leading-4 text-muted">
          Too many branches to draw side by side —{" "}
          <button
            type="button"
            className="text-accent underline"
            onClick={() => setHistoryOption("firstParent", true)}
          >
            follow first parents
          </button>
          .
        </p>
      )}
      {note && (
        <p role="status" className="shrink-0 px-3 py-1.5 text-[11.5px] leading-4 text-muted">
          {note}
        </p>
      )}
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Commits"
        data-total={rows.length}
        data-virtual={virtual ? "true" : "false"}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight <= PREFETCH_PX) more();
        }}
      >
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-[12.5px] leading-5 text-muted">
            {loading
              ? "Walking the history…"
              : loaded === 0
                ? "This branch has no commits yet."
                : "No walked commit matches. Press Enter to search further."}
          </p>
        ) : (
          <div
            style={
              virtual ? { height: virtualizer.getTotalSize(), position: "relative" } : undefined
            }
          >
            {(virtual ? items : rows.map((_, index) => ({ key: index, index, start: 0 }))).map(
              (v) => {
                const commit = rows[v.index];
                if (!commit) return null;
                return (
                  <CommitRow
                    key={v.key}
                    commit={commit}
                    previous={v.index > 0 ? rows[v.index - 1] : undefined}
                    refs={refs}
                    stats={statsMap[commit.oid]}
                    selected={commit.oid === selected}
                    inRange={commit.oid === rangeStart}
                    mark={markOf(bisect, commit.oid)}
                    focused={v.index === focusIndex}
                    index={v.index}
                    now={now}
                    onSelect={onSelect}
                    onFocus={setFocusIndex}
                    style={
                      virtual
                        ? {
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            transform: `translateY(${v.start}px)`,
                          }
                        : undefined
                    }
                  />
                );
              },
            )}
          </div>
        )}
        {loading && rows.length > 0 && (
          <p role="status" className="px-3 py-2 text-[11.5px] leading-4 text-muted">
            Loading more commits…
          </p>
        )}
      </div>
    </>
  );
}
