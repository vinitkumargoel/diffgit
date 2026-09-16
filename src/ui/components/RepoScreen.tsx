import { useStore } from "../store";
import { DiffPane } from "./DiffPane";
import { EmptyState } from "./EmptyState";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { WarningBanners } from "./WarningBanners";

/**
 * Repo view shell (Design §6): TopBar (T5.1), WarningBanners (T5.5), then Sidebar (T5.2) +
 * DiffPane (T5.3), or the EmptyState (T5.5) when the diff has no files. Default export: lazy chunk.
 */
export default function RepoScreen() {
  const empty = useStore((s) => s.diff !== null && s.diff.files.length === 0);
  return (
    <main className="flex h-dvh flex-col bg-bg text-ink">
      <TopBar />
      <WarningBanners />
      {empty ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <DiffPane />
        </div>
      )}
    </main>
  );
}
