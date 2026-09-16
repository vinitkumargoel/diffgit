import { DiffPane } from "./DiffPane";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * Repo view shell (Design §6): TopBar (T5.1), Sidebar (T5.2), DiffPane (T5.3); WarningBanners
 * (T5.5) slot between the bar and the body. Default export: React lazy chunk.
 */
export default function RepoScreen() {
  return (
    <main className="flex h-dvh flex-col bg-bg text-ink">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <DiffPane />
      </div>
    </main>
  );
}
