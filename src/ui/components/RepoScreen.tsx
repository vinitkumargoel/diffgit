import { useState } from "react";
import { useShortcuts } from "../hooks/useShortcuts";
import { useStore } from "../store";
import { BranchesView } from "./BranchesView";
import { CommandPalette } from "./CommandPalette";
import { FilesView } from "./FilesView";
import { HelpDialog } from "./HelpDialog";
import { HistoryView } from "./HistoryView";
import { InsightsView } from "./InsightsView";
import { TopBar } from "./TopBar";
import { WarningBanners } from "./WarningBanners";
import { WorktreesDialog } from "./WorktreesDialog";

/**
 * Repo view shell (Design §6, §14.1): skip link, TopBar (T5.1), WarningBanners (T5.5), then the
 * body of the current mode — `FilesView` is v1's sidebar + diff pane and the default; History,
 * Branches and Insights replace the body (T11.5 / T11.7 / T11.12). Screen-level shortcuts
 * `r` / `s` / `?` and the mode keys `1`–`4` live here; `⌘K` belongs to the palette itself.
 * Default export: lazy chunk.
 */
export default function RepoScreen() {
  const mode = useStore((s) => s.mode);
  const [helpOpen, setHelpOpen] = useState(false);
  useShortcuts({
    r: () => useStore.getState().requestRefresh("manual"),
    R: () => useStore.getState().requestRefresh("force"),
    s: () => {
      const { prefs, setPref } = useStore.getState();
      setPref("viewMode", prefs.viewMode === "split" ? "unified" : "split");
    },
    "?": () => setHelpOpen(true),
    // Design §14.7: `g` / `x` mark the commit under test **while a bisect runs**, in any mode —
    // the strip lives in History, but the marks are the store's and the keys follow them.
    g: () => {
      if (useStore.getState().bisect?.candidate) void useStore.getState().markBisect("good");
    },
    x: () => {
      if (useStore.getState().bisect?.candidate) void useStore.getState().markBisect("bad");
    },
    "1": () => useStore.getState().setMode("files"),
    "2": () => useStore.getState().setMode("history"),
    "3": () => useStore.getState().setMode("branches"),
    "4": () => useStore.getState().setMode("insights"),
  });
  return (
    <main className="flex h-dvh flex-col bg-bg text-ink">
      <a href="#diff" className="skip-link">
        Skip to diff
      </a>
      <TopBar onHelp={() => setHelpOpen(true)} />
      <WarningBanners />
      {mode === "files" && <FilesView />}
      {mode === "history" && <HistoryView />}
      {mode === "branches" && <BranchesView />}
      {mode === "insights" && <InsightsView />}
      <CommandPalette onHelp={() => setHelpOpen(true)} />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      {/* T11.16: `git worktree list` (atlas tab 19), opened from the palette or the repo name. */}
      <WorktreesDialog />
    </main>
  );
}
