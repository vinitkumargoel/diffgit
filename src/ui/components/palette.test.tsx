import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import basic from "../../test/recorded/showcase.repoinfo.json";
import { onScrollRequest } from "../scrollBus";
import { DEFAULT_PREFS, type StoreState, useStore } from "../store";
import { filePathOf } from "../treeModel";
import { CommandPalette, subsequence } from "./CommandPalette";
import { ModeSwitch } from "./ModeSwitch";
import RepoScreen from "./RepoScreen";

// cmdk scrolls the selected item into view and measures the list; happy-dom lacks both.
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
const diff = basicDiff as unknown as DiffResult;

function seed(overrides: Partial<StoreState> = {}) {
  const actions = {
    recompute: vi.fn(async () => {}),
    setPref: vi.fn(),
    setSource: vi.fn(),
    setTarget: vi.fn(),
    swapBranches: vi.fn(),
    setIncludeWorktree: vi.fn(),
    setFilter: vi.fn(),
    loadFileDiff: vi.fn(async () => {}),
    cancelFileDiff: vi.fn(),
    // T11.5: History mode walks on mount; these tests only care about the shell.
    loadHistory: vi.fn(async () => {}),
    loadStack: vi.fn(async () => {}),
  };
  useStore.setState({
    ...initial,
    screen: "repo",
    repo: basic as unknown as RepoInfo,
    repoId: "r1",
    diff,
    diffSource: {
      kind: "branches",
      source: "feature",
      target: "main",
      sourceRef: "refs/heads/feature",
      targetRef: "refs/heads/main",
      includeWorktree: true,
    },
    prefs: DEFAULT_PREFS,
    ...actions,
    ...overrides,
  });
  return actions;
}

afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
});

const paletteButton = () => screen.getByRole("button", { name: "Command palette" });
const input = () => screen.getByPlaceholderText("Type a command or a file…") as HTMLInputElement;
/** Queries scoped to the palette: the HelpDialog also lists "Refresh the diff" and friends. */
const inPalette = () => within(document.querySelector("dialog.palette-dialog") as HTMLElement);

describe("ModeSwitch (Design §14.1)", () => {
  it("renders the four segments with Files pressed and switches the body", () => {
    seed();
    render(<RepoScreen />);
    const group = screen.getByRole("group", { name: "View" });
    const labels = ["Files", "History", "Branches", "Insights"];
    for (const label of labels) expect(screen.getByRole("button", { name: label })).toBeTruthy();
    // the sr-only legend names the group, then the four segments
    expect(group.textContent).toBe(`View${labels.join("")}`);
    expect(screen.getByRole("button", { name: "Files" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(useStore.getState().mode).toBe("history");
    expect(screen.getByRole("button", { name: "History" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Files" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // the body is replaced; the file tree belongs to Files mode only (Design §14 rule 3)
    expect(screen.getByRole("complementary", { name: "History" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Commits" })).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("`1`–`4` switch mode, and not while typing in a field", () => {
    seed();
    render(<RepoScreen />);
    fireEvent.keyDown(document, { key: "2" });
    expect(useStore.getState().mode).toBe("history");
    fireEvent.keyDown(document, { key: "3" });
    expect(useStore.getState().mode).toBe("branches");
    fireEvent.keyDown(document, { key: "4" });
    expect(useStore.getState().mode).toBe("insights");
    fireEvent.keyDown(document, { key: "1" });
    expect(useStore.getState().mode).toBe("files");
    const filter = screen.getByRole("searchbox", { name: "Filter files" });
    filter.focus();
    fireEvent.keyDown(filter, { key: "2" });
    expect(useStore.getState().mode).toBe("files");
  });

  it("is a labelled group even on its own (a11y)", () => {
    seed();
    render(<ModeSwitch />);
    expect(screen.getByRole("group", { name: "View" })).toBeTruthy();
  });
});

describe("CommandPalette (Design §14.1)", () => {
  it("opens with ⌘K and Ctrl+K, closes with Escape, and hands focus back to the trigger", async () => {
    seed();
    render(<RepoScreen />);
    expect(useStore.getState().palette).toBe(false);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(useStore.getState().palette).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(input()));
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(useStore.getState().palette).toBe(false);

    paletteButton().focus();
    fireEvent.click(paletteButton());
    expect(useStore.getState().palette).toBe(true);
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(paletteButton()));

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(useStore.getState().palette).toBe(true);
  });

  it("lists every action of this task in the Actions group", () => {
    seed();
    render(<RepoScreen />);
    fireEvent.click(paletteButton());
    expect(inPalette().getByText("Actions")).toBeTruthy();
    for (const label of [
      "Open a repository…",
      "Refresh the diff",
      "Force refresh: re-read every file",
      "Go to Files",
      "Go to History",
      "Go to Branches",
      "Go to Insights",
      "Use split view",
      "Ignore whitespace changes",
      "Show hidden files",
      "Show reflog",
      "Show keyboard shortcuts",
      "Clear cached data",
    ]) {
      expect(inPalette().getByText(label), label).toBeTruthy();
    }
  });

  it("T11.5: `Show reflog` opens the History sidebar on its Reflog sub-tab", () => {
    seed({ reflog: [] });
    render(<RepoScreen />);
    fireEvent.click(paletteButton());
    fireEvent.click(inPalette().getByText("Show reflog"));
    expect(useStore.getState().palette).toBe(false);
    expect(useStore.getState().mode).toBe("history");
    expect(useStore.getState().historyTab).toBe("reflog");
    expect(screen.getByRole("button", { name: "Reflog" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.body.textContent).toContain("No reflog is kept for this repository");
  });

  it("running an action closes the palette and does the thing", () => {
    seed();
    render(<RepoScreen />);
    fireEvent.click(paletteButton());
    fireEvent.click(inPalette().getByText("Go to Branches"));
    expect(useStore.getState().mode).toBe("branches");
    expect(useStore.getState().palette).toBe(false);
    expect(screen.queryByPlaceholderText("Type a command or a file…")).toBeNull();
  });

  it("filters as you type and Enter runs the highlighted row (keyboard only)", async () => {
    const a = seed();
    render(<RepoScreen />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    fireEvent.change(input(), { target: { value: "force" } });
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][data-selected="true"]')?.textContent).toContain(
        "Force refresh",
      ),
    );
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(a.recompute).toHaveBeenCalledWith("force");
    expect(useStore.getState().palette).toBe(false);
  });

  it("Go to file lists the visible files and jumps to the one chosen", async () => {
    seed();
    const seen: string[] = [];
    const off = onScrollRequest((id) => seen.push(id));
    render(<RepoScreen />);
    fireEvent.click(paletteButton());
    expect(inPalette().getByText("Go to file")).toBeTruthy();
    const target = diff.files[2];
    if (!target) throw new Error("fixture has no third file");
    const path = filePathOf(target);
    fireEvent.change(input(), { target: { value: path } });
    await waitFor(() => expect(inPalette().getByText(path)).toBeTruthy());
    fireEvent.click(inPalette().getByText(path));
    expect(useStore.getState().activeFileId).toBe(target.id);
    expect(seen).toEqual([target.id]);
    expect(useStore.getState().palette).toBe(false);
    off();
  });

  it("a search that matches nothing says so", async () => {
    seed();
    render(<RepoScreen />);
    fireEvent.click(paletteButton());
    fireEvent.change(input(), { target: { value: "zzzzzzzz" } });
    await waitFor(() => expect(inPalette().getByText("No matching command")).toBeTruthy());
  });

  it("renders nothing while closed (the dialog is empty until it opens)", () => {
    seed();
    const { container } = render(<CommandPalette />);
    expect(container.querySelector("dialog")?.textContent).toBe("");
  });

  it("subsequence pre-narrowing matches the way a fuzzy search is typed", () => {
    expect(subsequence("src/engine/git/worktree.ts", "wrkt")).toBe(true);
    expect(subsequence("src/engine/git/worktree.ts", "seg")).toBe(true);
    expect(subsequence("src/engine/git/worktree.ts", "zz")).toBe(false);
    expect(subsequence("anything", "")).toBe(true);
  });
});
