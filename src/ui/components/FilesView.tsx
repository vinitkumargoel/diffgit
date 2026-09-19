import { useShallow } from "zustand/react/shallow";
import { useShortcuts } from "../hooks/useShortcuts";
import { selectVisibleFiles, useStore } from "../store";
import { DiffPane } from "./DiffPane";
import { EmptyState, FilterEmptyState } from "./EmptyState";
import { Sidebar } from "./Sidebar";

/**
 * Files mode (Design §14.2): v1's body, unchanged — sidebar + diff pane, the EmptyState (T5.5) when
 * the diff has no files and the FilterEmptyState (S6) when the filter matches none of them. It is
 * the default mode and the only one with the file tree (§14, rule 3). It also owns `Shift+H`
 * (Design §14.7), the toggle behind the Hidden group (§14.4).
 */
export function FilesView() {
  const empty = useStore((s) => s.diff !== null && s.diff.files.length === 0);
  const filtering = useStore((s) => s.filter.trim() !== "");
  const visible = useStore(useShallow(selectVisibleFiles));
  const hasFiles = useStore((s) => (s.diff?.files.length ?? 0) > 0);
  const showHidden = useStore((s) => s.prefs.showHidden);
  /** A Hidden group with rows keeps the sidebar up even when nothing changed (§14.4). */
  const hiddenShown = useStore((s) => s.prefs.showHidden && (s.hidden?.length ?? 0) > 0);
  const setPref = useStore((s) => s.setPref);
  useShortcuts({ H: () => setPref("showHidden", !showHidden) });
  const noMatch = hasFiles && filtering && visible.length === 0;
  if ((empty || noMatch) && !hiddenShown) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? <EmptyState /> : <FilterEmptyState />}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <DiffPane />
    </div>
  );
}
