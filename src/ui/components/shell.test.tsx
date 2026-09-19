import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import basic from "../../test/recorded/showcase.repoinfo.json";
import { SHORTCUTS, V2_SHORTCUTS } from "../hooks/useShortcuts";
import { DEFAULT_PREFS, type StoreState, useStore } from "../store";
import { HelpDialog, PRIVACY_SENTENCES } from "./HelpDialog";
import { LiveRegion } from "./LiveRegion";
import RepoScreen from "./RepoScreen";
import { nextTheme, ThemeToggle } from "./ThemeToggle";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

const initial = useStore.getState();
function seed(overrides: Partial<StoreState> = {}) {
  const actions = {
    recompute: vi.fn(async () => {}),
    setPref: vi.fn(),
    setSource: vi.fn(),
    setTarget: vi.fn(),
    swapBranches: vi.fn(),
    setIncludeWorktree: vi.fn(),
    setFilter: vi.fn(),
    setRefreshMode: vi.fn(),
    loadFileDiff: vi.fn(async () => {}),
    cancelFileDiff: vi.fn(),
  };
  useStore.setState({
    ...initial,
    screen: "repo",
    repo: basic as unknown as RepoInfo,
    repoId: "r1",
    diff: {
      ...(basicDiff as unknown as DiffResult),
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
    },
    diffSource: {
      kind: "branches",
      source: "feature",
      target: "main",
      sourceRef: "refs/heads/feature",
      targetRef: "refs/heads/main",
      includeWorktree: true,
    },
    prefs: { ...DEFAULT_PREFS, viewMode: "unified" },
    ...actions,
    ...overrides,
  });
  return actions;
}

afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
});

describe("RepoScreen shell (T5.6)", () => {
  it("starts with the skip link targeting the diff pane", () => {
    seed({ diff: basicDiff as unknown as DiffResult });
    const { container } = render(<RepoScreen />);
    const first = container.querySelector("a, button, input, [tabindex]");
    expect(first?.textContent).toBe("Skip to diff");
    expect(first?.getAttribute("href")).toBe("#diff");
    expect(document.getElementById("diff")).toBeTruthy();
  });

  it("`?` and the help button open the HelpDialog; Close closes it; `r` and `s` hit the store", () => {
    const a = seed();
    const { container } = render(<RepoScreen />);
    const dialog = container.querySelector("dialog.help-dialog") as HTMLDialogElement;
    expect(dialog.hasAttribute("open")).toBe(false);
    fireEvent.keyDown(document, { key: "?", shiftKey: true });
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog.hasAttribute("open")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(dialog.hasAttribute("open")).toBe(true);

    fireEvent.keyDown(document, { key: "r" });
    expect(a.recompute).toHaveBeenCalledWith("manual");
    fireEvent.keyDown(document, { key: "s" });
    expect(a.setPref).toHaveBeenCalledWith("viewMode", "split");
  });
});

describe("HelpDialog", () => {
  it("lists every shortcut with a kbd and the three privacy sentences", () => {
    render(<HelpDialog open onClose={() => {}} />);
    const rows = screen.getAllByRole("row");
    // v1 keys (SHORTCUTS) + the v2 section: ⌘K plus every key in V2_SHORTCUTS (T11.1)
    expect(rows.length).toBe(SHORTCUTS.length + V2_SHORTCUTS.length + 1);
    const keys = rows.map((r) => r.querySelector("kbd")?.textContent);
    expect(keys).toContain("Esc");
    expect(keys).toContain("?");
    expect(keys).toContain("⌘K");
    expect(keys).toContain("1");
    expect(keys).toContain("Shift+H");
    // the keys no task has wired yet say so instead of pretending to work (Design §14.7)
    expect(screen.queryAllByText("when available").length).toBe(
      V2_SHORTCUTS.filter((s) => "pending" in s && s.pending).length,
    );
    for (const s of PRIVACY_SENTENCES)
      expect(screen.getByText(/Privacy/).parentElement?.textContent).toContain(s);
  });

  it("shows the derived-cache size and a Clear button (Design §14.1 footer)", async () => {
    render(<HelpDialog open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    // no IndexedDB in happy-dom: `guarded` swallows it and the footer settles on an empty cache
    await waitFor(() =>
      expect(screen.getByTestId("cache-size").textContent).toBe("Cached data: 0 B"),
    );
  });
});

describe("ThemeToggle", () => {
  it("cycles system → light → dark → system and persists through setPref", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
    const a = seed({ prefs: { ...DEFAULT_PREFS, theme: "system" } });
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: "Switch to light theme" });
    expect(btn.getAttribute("data-theme")).toBe("system");
    fireEvent.click(btn);
    expect(a.setPref).toHaveBeenCalledWith("theme", "light");
    cleanup();
    seed({ prefs: { ...DEFAULT_PREFS, theme: "dark" } });
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to system theme" })).toBeTruthy();
  });
});

describe("LiveRegion", () => {
  it("mirrors the store announcement in a polite live region", () => {
    seed({ announcement: "Diff updated: 3 files", announcementSeq: 1 });
    render(<LiveRegion />);
    const text = screen.getByText("Diff updated: 3 files");
    const region = text.closest("output") as HTMLElement;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    // the same text announced again gets a fresh node (T7.5: screen readers re-announce)
    act(() => useStore.setState({ announcement: "Diff updated: 3 files", announcementSeq: 2 }));
    const again = screen.getByText("Diff updated: 3 files");
    expect(again).not.toBe(text);
    expect(again.closest("output")).toBe(region);
  });
});
