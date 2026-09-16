import { TopBar } from "./TopBar";

/**
 * Repo view shell (Design §6): TopBar (T5.1); WarningBanners (T5.5), Sidebar (T5.2) and DiffPane
 * (T5.3) fill the remaining rows. Default export: React lazy chunk.
 */
export default function RepoScreen() {
  return (
    <main className="flex h-dvh flex-col bg-bg text-ink">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <section id="diff" aria-label="Diff" className="min-h-0 flex-1 overflow-y-auto" />
      </div>
    </main>
  );
}
