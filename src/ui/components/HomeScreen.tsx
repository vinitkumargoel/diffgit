import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
// The landing page, verbatim from the approved "Precision" mockup (docs/mockups/e-precision.html).
// Kept as raw assets outside src/ui so the design's literal colours don't trip the token guard;
// the CSS is injected as a scoped <style> that unmounts with the screen, and the demo script — which
// the CSP forbids inline — runs from precisionDemo.ts instead.
import precisionCss from "../../marketing/precision.css?raw";
import precisionHtml from "../../marketing/precision.html?raw";
import type { DashboardRepo } from "../dashboard";
import { useNow } from "../hooks/useNow";
import { useShortcuts } from "../hooks/useShortcuts";
import { pickAndOpenRepo } from "../openRepo";
import { EMPTY_DASHBOARD_ENTRY, useStore } from "../store";
import { ContinueCard } from "./home/ContinueCard";
import { NavRecent } from "./home/NavRecent";
import { initPrecisionDemo } from "./home/precisionDemo";
import { RecentPanel } from "./home/RecentPanel";
import { useRecents } from "./home/useRecents";

/** The mockup's footer carries a hard-coded build id; show the real one this bundle was built at. */
const HTML = precisionHtml.replace("build 11648ff", `build ${__BUILD_ID__}`);

/** The static markup's mount points for the parts of Home that are React (§s1 H0–H6). */
interface Mounts {
  facts: HTMLElement;
  side: HTMLElement;
  nav: HTMLElement;
  matches: HTMLElement;
  storage: HTMLElement;
}

/**
 * The home screen is the "Precision" landing page (Direction E) rendered as-is: its nav, hero,
 * interactive demo, chapters, privacy table, FAQ and footer. Every "Open a repository" CTA and the
 * `o` shortcut open the read-only directory picker, which hands off to the app (App switches to the
 * repo screen). The marketing markup and styles are static, in-repo assets — never user input.
 *
 * History (mockup §s1) is the one thing that changes: once a repository has been opened, the hero's
 * facts table gives way to the Continue card (H1) or the Recent list (H2/H3), the nav grows a
 * "Recent" popover (H5), and a blocked IndexedDB becomes a row in the facts table (H6). All of it
 * is portalled into the static markup so the landing page itself stays verbatim.
 */
export function HomeScreen() {
  const storageUnavailable = useStore((s) => s.storageUnavailable);
  const rootRef = useRef<HTMLDivElement>(null);
  const [mounts, setMounts] = useState<Mounts | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const recents = useRecents();
  const hasHistory = recents.loaded && recents.repos.length > 0;
  const now = useNow(60_000, hasHistory);
  const summaries = useStore((s) => s.dashboard.summaries);
  const loadSummaries = useStore((s) => s.loadSummaries);
  const cancelSummaries = useStore((s) => s.cancelSummaries);
  const busy = Object.values(summaries).some((e) => e.loading);

  /**
   * T11.11 — the cards the background summariser walks. Rebuilt when the list or the browser's
   * permission answers change, which is also what makes a `Re-authorise` click fill that card:
   * the sweep restarts and skips everything whose index has not moved since its cached summary.
   */
  const cards = useMemo<DashboardRepo[]>(
    () =>
      recents.repos.map((r) => ({
        id: r.id,
        name: r.name,
        handle: r.handle,
        access: recents.access[r.id] ?? "prompt",
      })),
    [recents.repos, recents.access],
  );

  // Only while Home is visible (atlas tab 11): leaving the screen — including opening a repository
  // — cancels the sweep wherever it is, so nothing reads a repository the user has moved on from.
  useEffect(() => {
    if (cards.length === 0) return;
    void loadSummaries(cards);
    return () => cancelSummaries();
  }, [cards, loadSummaries, cancelSummaries]);

  const refreshAll = useCallback(() => {
    void loadSummaries(cards, { force: true });
  }, [cards, loadSummaries]);

  // The picker flow lives in `openRepo.ts` so Home, the `o` key and the command palette share it.
  const openPicker = useCallback(() => pickAndOpenRepo(), []);

  // `o` opens the picker while on Home (T4.4 AC); `r` toggles the nav's Recent popover (H5).
  useShortcuts({ o: () => void openPicker(), r: () => setNavOpen((v) => !v) });

  // Find the mount points the static markup reserves for React.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const find = (id: string) => root.querySelector<HTMLElement>(`#${id}`);
    const facts = find("home-facts");
    const side = find("home-side");
    const nav = find("home-nav-recent");
    const matches = find("home-fact-matches");
    const storage = find("home-fact-storage");
    if (facts && side && nav && matches && storage) {
      setMounts({ facts, side, nav, matches, storage });
    }
  }, []);

  // H0 ⇄ H1/H2/H3: the hero's right column is the facts table until there is history.
  useEffect(() => {
    if (!mounts) return;
    mounts.facts.hidden = hasHistory;
    mounts.side.hidden = !hasHistory;
  }, [mounts, hasHistory]);

  // H6: storage blocked or full replaces the "Matches → git diff -M" row.
  useEffect(() => {
    if (!mounts) return;
    mounts.matches.hidden = storageUnavailable;
    mounts.storage.hidden = !storageUnavailable;
  }, [mounts, storageUnavailable]);

  // Wire every "Open a repository" CTA in the injected markup to the picker (never our own).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = () => void openPicker();
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button.btn-ink")).filter(
      (b) => !b.closest("#home-side, #home-nav-recent"),
    );
    for (const b of buttons) b.addEventListener("click", onClick);
    return () => {
      for (const b of buttons) b.removeEventListener("click", onClick);
    };
  }, [openPicker]);

  // Run the self-contained diff demo in the `#demo` section.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return initPrecisionDemo(root);
  }, []);

  const showAll = useCallback(() => {
    mounts?.side.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [mounts]);
  const choose = useCallback(() => void openPicker(), [openPicker]);
  const only = recents.repos[0];

  return (
    <>
      {/* Component-scoped: removed from the DOM when the screen unmounts, so it never leaks into the app. */}
      <style>{precisionCss}</style>
      <div
        ref={rootRef}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static in-repo marketing asset, not user input.
        dangerouslySetInnerHTML={{ __html: HTML }}
      />
      {mounts &&
        hasHistory &&
        only &&
        createPortal(
          recents.repos.length === 1 ? (
            <ContinueCard
              repo={only}
              access={recents.access[only.id] ?? "prompt"}
              state={recents.state[only.id] ?? "idle"}
              entry={summaries[only.id] ?? EMPTY_DASHBOARD_ENTRY}
              now={now}
              onOpen={recents.open}
              onGrant={recents.grant}
              onForget={recents.forget}
              onUndo={recents.undo}
              onChoose={choose}
            />
          ) : (
            <RecentPanel
              repos={recents.repos}
              access={recents.access}
              state={recents.state}
              summaries={summaries}
              busy={busy}
              now={now}
              onOpen={recents.open}
              onGrant={recents.grant}
              onForget={recents.forget}
              onUndo={recents.undo}
              onChoose={choose}
              onClearAll={recents.clearAll}
              onRefreshAll={refreshAll}
            />
          ),
          mounts.side,
        )}
      {mounts &&
        hasHistory &&
        createPortal(
          <NavRecent
            repos={recents.repos}
            access={recents.access}
            state={recents.state}
            now={now}
            open={navOpen}
            onOpenChange={setNavOpen}
            onOpenRepo={recents.open}
            onForget={recents.forget}
            onUndo={recents.undo}
            onShowAll={showAll}
          />,
          mounts.nav,
        )}
      {mounts &&
        storageUnavailable &&
        createPortal(
          <>
            <span>Recent repos</span>
            <span
              className="warn"
              title="Storage is blocked or full in this browser (private window?). Repositories still open normally; they just won't be listed next time."
            >
              <TriangleAlert className="ic" aria-hidden="true" />
              not remembered here
            </span>
          </>,
          mounts.storage,
        )}
    </>
  );
}
