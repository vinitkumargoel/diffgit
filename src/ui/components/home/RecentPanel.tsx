/**
 * H2/H3 — the Recent list in the hero's right column: hairline rows with the same rhythm as the
 * facts table. From seven repositories a filter appears and the list scrolls inside the column.
 */
import { Search } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import type { PermissionAnswer, StoredRepo } from "../../persistence";
import { RecentRow, RowMessage } from "./RecentRow";
import type { RowState } from "./useRecents";

/** From this many rows up, the column gets a filter and a scroll box (mockup: "up to 6 visible"). */
export const FILTER_FROM = 7;

export interface RecentPanelProps {
  repos: StoredRepo[];
  access: Record<string, PermissionAnswer>;
  state: Record<string, RowState>;
  now: number;
  onOpen(repo: StoredRepo): void;
  onForget(repo: StoredRepo): void;
  onUndo(repo: StoredRepo): void;
  onChoose(): void;
  onClearAll(): void;
}

export function RecentPanel({
  repos,
  access,
  state,
  now,
  onOpen,
  onForget,
  onUndo,
  onChoose,
  onClearAll,
}: RecentPanelProps) {
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const searchable = repos.length >= FILTER_FROM;
  const query = searchable ? filter.trim() : "";
  const shown = query
    ? repos.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()))
    : repos;

  /** ↑ ↓ move between rows, ⏎ opens (native), ⌫ forgets. */
  function moveFocus(from: HTMLElement, delta: number) {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button.nm") ?? [],
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
      listRef.current?.querySelector<HTMLButtonElement>("button.nm")?.focus();
    }
  }

  return (
    <section className="recent" aria-label="Recent repositories">
      <div className="hd">
        Recent <span className="n">· {repos.length}</span>
        <span className="r">
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
        <div className={searchable ? "rlist" : undefined} ref={listRef}>
          {shown.map((repo) => (
            <div key={repo.id}>
              <RecentRow
                repo={repo}
                access={access[repo.id] ?? "prompt"}
                state={state[repo.id] ?? "idle"}
                now={now}
                filter={query}
                onOpen={onOpen}
                onForget={onForget}
                onUndo={onUndo}
                onKeyDown={onRowKey}
              />
              <RowMessage
                repo={repo}
                state={state[repo.id] ?? "idle"}
                onRetry={onOpen}
                onChoose={onChoose}
                onForget={onForget}
              />
              <div className="rsep" />
            </div>
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
