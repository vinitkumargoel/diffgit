/**
 * H5 — history from the sticky nav: a "Recent" button whose popover lists the three most recent
 * repositories from any scroll position. Hidden when there is no history; `r` opens and closes it.
 */
import { ChevronDown, Clock } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PermissionAnswer, StoredRepo } from "../../persistence";
import { RecentRow } from "./RecentRow";
import type { RowState } from "./useRecents";

/** The popover is a shortcut, not the list: the hero keeps the full history. */
export const NAV_ROWS = 3;

export interface NavRecentProps {
  repos: StoredRepo[];
  access: Record<string, PermissionAnswer>;
  state: Record<string, RowState>;
  now: number;
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenRepo(repo: StoredRepo): void;
  onForget(repo: StoredRepo): void;
  onUndo(repo: StoredRepo): void;
  /** "Show all n ↑" — scrolls the hero's Recent column into view. */
  onShowAll(): void;
}

export function NavRecent({
  repos,
  access,
  state,
  now,
  open,
  onOpenChange,
  onOpenRepo,
  onForget,
  onUndo,
  onShowAll,
}: NavRecentProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  if (repos.length === 0) return null;

  return (
    <span className="navwrap" ref={wrapRef}>
      <button
        type="button"
        className="rec"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => onOpenChange(!open)}
      >
        <Clock className="ic" aria-hidden="true" />
        Recent
        <ChevronDown className="ic chev" aria-hidden="true" />
      </button>
      {open && (
        <div className="navpop">
          <div className="hd">Recent · {repos.length}</div>
          {repos.slice(0, NAV_ROWS).map((repo) => (
            <RecentRow
              key={repo.id}
              repo={repo}
              access={access[repo.id] ?? "prompt"}
              state={state[repo.id] ?? "idle"}
              now={now}
              compact
              onOpen={onOpenRepo}
              onForget={onForget}
              onUndo={onUndo}
            />
          ))}
          <div className="ft">
            <span>
              <kbd>r</kbd> opens this
            </span>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onShowAll();
              }}
            >
              Show all {repos.length} ↑
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
