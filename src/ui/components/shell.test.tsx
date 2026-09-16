import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import basic from "../../test/recorded/showcase.repoinfo.json";
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
    render(<RepoScreen />);
    const dialog = screen.getByRole("dialog", { hidden: true });
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
    expect(rows.length).toBe(11);
    expect(rows.map((r) => r.querySelector("kbd")?.textContent)).toContain("Esc");
    expect(rows.map((r) => r.querySelector("kbd")?.textContent)).toContain("?");
    for (const s of PRIVACY_SENTENCES)
      expect(screen.getByText(/Privacy/).parentElement?.textContent).toContain(s);
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
    seed({ announcement: "Diff updated: 3 files" });
    render(<LiveRegion />);
    const region = screen.getByText("Diff updated: 3 files");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
  });
});
