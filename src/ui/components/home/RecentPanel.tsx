/**
 * H2/H3 — the hero's right column once more than one repository is stored. T11.11 (Design §14.6)
 * turned the hairline rows into the **RepoCard grid**: the same header, filter and footer, with a
 * card per repository carrying the summary the background summariser reads. `RecentRow` itself is
 * unchanged and still serves the nav popover (H5), where there is no room for a card.
 *
 * From seven repositories a filter appears and the grid scrolls inside the column.
 */
import { RefreshCw, Search } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { REFRESH_ALL, REFRESH_ALL_TITLE } from "../../dashboard";
import type { PermissionAnswer, StoredRepo } from "../../persistence";
import type { DashboardEntry } from "../../store";
import { EMPTY_DASHBOARD_ENTRY } from "../../store";
import { RepoCard } from "./RepoCard";
import type { RowState } from "./useRecents";

/** From this many rows up, the column gets a filter and a scroll box (mockup: "up to 6 visible"). */
export const FILTER_FROM = 7;

export interface RecentPanelProps {
  repos: StoredRepo[];
  access: Record<string, PermissionAnswer>;
  state: Record<string, RowState>;
  summaries: Record<string, DashboardEntry>;
  /** True while any card is being read; the `Refresh all` button says so and waits. */
  busy: boolean;
  now: number;
  onOpen(repo: StoredRepo): void;
  onGrant(repo: StoredRepo): void;
  onForget(repo: StoredRepo): void;
  onUndo(repo: StoredRepo): void;
  onChoose(): void;
  onClearAll(): void;
  onRefreshAll(): void;
}

export function RecentPanel({
  repos,
  access,
  state,
  summaries,
  busy,
  now,
  onOpen,
  onGrant,
  onForget,
  onUndo,
  onChoose,
  onClearAll,
  onRefreshAll,
}: RecentPanelProps) {
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const searchable = repos.length >= FILTER_FROM;
  const query = searchable ? filter.trim() : "";
  const shown = query
    ? repos.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()))
    : repos;

  /** ↑ ↓ move between cards, ⏎ opens (native), ⌫ forgets. */
  function moveFocus(from: HTMLElement, delta: number) {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-card-open]") ?? [],
    );
    const at = buttons.indexOf(from as HTMLButtonElement);
    const next = buttons[at + delta];
    if (next) next.focus();
  }

  function onRowKey(e: KeyboardEvent<HTMLButtonElement>, repo: StoredRepo) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      onForget(repo);
    } else if (e.key === "Escape" && searchable) {
      e.preventDefault();
      setFilter("");
    }
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setFilter("");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      listRef.current?.querySelector<HTMLButtonElement>("button[data-card-open]")?.focus();
    }
  }

  return (
    <section className="recent" aria-label="Recent repositories">
      <div className="hd">
        Recent <span className="n">· {repos.length}</span>
        <span className="r">
          <button type="button" title={REFRESH_ALL_TITLE} disabled={busy} onClick={onRefreshAll}>
            <RefreshCw
              className={`ic inline h-3 w-3 ${busy ? "animate-spin" : ""}`}
              aria-hidden="true"
            />{" "}
            {REFRESH_ALL}
          </button>
          <button type="button" onClick={onClearAll}>
            Clear all
          </button>
        </span>
      </div>

      {searchable && (
        <div className="rsearch">
          <Search className="ic" aria-hidden="true" />
          <input
            aria-label="Filter recent"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <kbd>esc</kbd>
        </div>
      )}

      {shown.length === 0 ? (
        <>
          <p className="rempty">
            No recent repository matches <span className="mono">{query}</span>.
            <small>
              Press <kbd>o</kbd> to open a new folder.
            </small>
          </p>
          <div className="rsep" />
        </>
      ) : (
        <div
          // auto-fill: one column in the 360 px hero aside, a real grid wherever there is room.
          className={`grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2 py-2 ${
            searchable ? "max-h-[420px] overflow-auto" : ""
          }`}
          ref={listRef}
        >
          {shown.map((repo) => (
            <RepoCard
              key={repo.id}
              repo={repo}
              access={access[repo.id] ?? "prompt"}
              state={state[repo.id] ?? "idle"}
              entry={summaries[repo.id] ?? EMPTY_DASHBOARD_ENTRY}
              now={now}
              filter={query}
              onOpen={onOpen}
              onGrant={onGrant}
              onForget={onForget}
              onUndo={onUndo}
              onChoose={onChoose}
              onKeyDown={onRowKey}
            />
          ))}
        </div>
      )}

      <div className="ft">
        {searchable ? (
          <span>
            {shown.length} of {repos.length} match
          </span>
        ) : (
          <span>
            <span className="dot g" /> access granted &nbsp; <span className="dot y" /> will ask
            once &nbsp; <span className="dot r" /> missing
          </span>
        )}
        {searchable && shown.length > 0 ? (
          <span className="keys">
            <kbd>↑</kbd> <kbd>↓</kbd> <kbd>⏎</kbd> open · <kbd>⌫</kbd> forget
          </span>
        ) : (
          <span>Stored in this browser only</span>
        )}
      </div>
    </section>
  );
}
