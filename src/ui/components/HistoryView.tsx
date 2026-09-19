import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { CommitCard } from "./CommitCard";
import { CommitList } from "./CommitList";
import { DiffPane } from "./DiffPane";
import { EmptyState } from "./EmptyState";

/**
 * History mode (Design §14.5): the sidebar becomes the commit list and the diff pane shows the
 * selected commit — a `CommitCard` on top, the same FileCards below it. No new bar chrome: the
 * pickers still choose the branch that is walked, and the StatsRow counts follow the source the
 * selection sets (`parent…commit`, or `older…newer` for a shift-selected range).
 */
export function HistoryView({ initialRect }: { initialRect?: { width: number; height: number } }) {
  const selected = useStore((s) => s.history.selected);
  const repoId = useStore((s) => s.repoId);
  const loadHistory = useStore((s) => s.loadHistory);
  const empty = useStore((s) => s.diff !== null && s.diff.files.length === 0);

  // The first page, once per repository. A ref rather than "commits.length === 0", so a walk that
  // fails asks once and stops instead of re-firing every time `loading` flips back.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (asked.current === repoId) return;
    asked.current = repoId;
    void loadHistory();
  }, [repoId, loadHistory]);

  return (
    <div className="flex min-h-0 flex-1">
      <CommitList initialRect={initialRect} />
      <div className="flex min-h-0 flex-1 flex-col">
        {selected !== null && <CommitCard oid={selected} />}
        {empty ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EmptyState />
          </div>
        ) : (
          <DiffPane initialRect={initialRect} />
        )}
      </div>
    </div>
  );
}
