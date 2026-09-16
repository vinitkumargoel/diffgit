import { useState } from "react";
import { useShortcuts } from "../hooks/useShortcuts";
import { useStore } from "../store";
import { DiffPane } from "./DiffPane";
import { EmptyState } from "./EmptyState";
import { HelpDialog } from "./HelpDialog";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { WarningBanners } from "./WarningBanners";

/**
 * Repo view shell (Design §6): skip link, TopBar (T5.1), WarningBanners (T5.5), then Sidebar
 * (T5.2) + DiffPane (T5.3), or the EmptyState (T5.5) when the diff has no files. Screen-level
 * shortcuts `r` / `s` / `?` live here (T5.6). Default export: lazy chunk.
 */
export default function RepoScreen() {
  const empty = useStore((s) => s.diff !== null && s.diff.files.length === 0);
  const [helpOpen, setHelpOpen] = useState(false);
  useShortcuts({
    r: () => useStore.getState().requestRefresh("manual"),
    s: () => {
      const { prefs, setPref } = useStore.getState();
      setPref("viewMode", prefs.viewMode === "split" ? "unified" : "split");
    },
    "?": () => setHelpOpen(true),
  });
  return (
    <main className="flex h-dvh flex-col bg-bg text-ink">
      <a href="#diff" className="skip-link">
        Skip to diff
      </a>
      <TopBar onHelp={() => setHelpOpen(true)} />
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
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
}
