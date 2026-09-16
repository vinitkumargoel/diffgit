import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, FileDiff, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/basic.diffresult.json";
import basic from "../../test/recorded/basic.repoinfo.json";
import worktreeDiff from "../../test/recorded/worktree.diffresult.json";
import { syntheticLarge } from "../mock/syntheticLarge";
import { onScrollRequest } from "../scrollBus";
import { DEFAULT_PREFS, type StoreState, useStore } from "../store";
import { Sidebar } from "./Sidebar";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

const repo = basic as unknown as RepoInfo;
const diff = basicDiff as unknown as DiffResult;
const wtDiff = worktreeDiff as unknown as DiffResult;

function file(path: string, extra: Partial<FileDiff> = {}): FileDiff {
  return {
    id: path,
    oldPath: path,
    newPath: path,
    status: "modified",
    layers: ["committed"],
    oldOid: "a".repeat(40),
    newOid: "b".repeat(40),
    oldMode: 0o100644,
    newMode: 0o100644,
    binary: false,
    image: false,
    oldSize: 10,
    newSize: 12,
    stats: { additions: 1, deletions: 1 },
    tooLarge: false,
    ...extra,
  };
}

function seed(overrides: Partial<StoreState> = {}) {
  const a = {
    setActiveFile: vi.fn(),
    toggleViewed: vi.fn(),
    prioritise: vi.fn(),
    setPref: vi.fn(),
  };
  useStore.setState({
    screen: "repo",
    repo,
    repoId: "r1",
    diff,
    stats: {},
    viewed: new Set(),
    filter: "",
    activeFileId: null,
    prefs: DEFAULT_PREFS,
    ...a,
    ...overrides,
  });
  return a;
}

// happy-dom has no layout: give the virtualiser a 300 × 600 scroll element.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 600, width: 300, height: 600 };
HTMLElement.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { get: () => 300, configurable: true });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get: () => 600,
  configurable: true,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Sidebar / FileTree", () => {
  it("tree mode compacts single-child chains, dirs first, files alphabetical", () => {
    seed({
      diff: {
        ...diff,
        files: [
          file("README.md"),
          file("src/ui/components/A.tsx"),
          file("src/ui/components/B.tsx"),
          file("src/x.ts"),
        ],
      },
    });
    render(<Sidebar />);
    expect(screen.getByText("(4)").parentElement?.textContent).toBe("Files changed (4)");
    const rows = screen.getAllByRole("treeitem");
    expect(rows.map((r) => r.querySelector(".truncate")?.textContent)).toEqual([
      "src",
      "ui/components",
      "A.tsx",
      "B.tsx",
      "x.ts",
      "README.md",
    ]);
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(rows[2]?.getAttribute("aria-level")).toBe("3");
    // collapse "ui/components"
    fireEvent.click(screen.getByText("ui/components"));
    expect(screen.getAllByRole("treeitem")).toHaveLength(4);
  });

  it("flat mode keeps the engine order and shows dir dimmed + basename", () => {
    seed({ prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" } });
    render(<Sidebar />);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.getAttribute("title"))).toEqual(
      diff.files.map((f) => f.newPath ?? f.oldPath),
    );
    expect(screen.getByRole("listbox").getAttribute("data-virtual")).toBe("false");
  });

  it("shows layer chips per layer, generated chip, — for binary and a skeleton while stats load", () => {
    seed({ diff: wtDiff, prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" } });
    render(<Sidebar />);
    const both = wtDiff.files.find(
      (f) => f.layers.includes("staged") && f.layers.includes("unstaged"),
    );
    const committed = wtDiff.files.find((f) => f.layers.join() === "committed");
    expect(both && committed).toBeTruthy();
    const bothRow = screen.getByTitle(both?.id ?? "");
    expect(bothRow.querySelectorAll('[aria-label="Staged change"]')).toHaveLength(1);
    expect(bothRow.querySelectorAll('[aria-label="Unstaged change"]')).toHaveLength(1);
    const committedRow = screen.getByTitle(committed?.id ?? "");
    expect(
      committedRow.querySelectorAll(
        "[aria-label$='change'], [aria-label$='file'], [aria-label='Merge conflict']",
      ),
    ).toHaveLength(0);
    cleanup();

    seed({
      prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" },
      diff: { ...diff, files: diff.files.map((f) => ({ ...f, stats: null })) },
    });
    render(<Sidebar />);
    expect(
      screen.getByTitle("generated/bundle.js").querySelector('[aria-label="Generated file"]'),
    ).toBeTruthy();
    expect(screen.getByTitle("data/blob.bin").textContent).toContain("—");
    expect(
      screen.getByTitle("docs/guide.md").querySelector('[aria-label="Loading stats"]'),
    ).toBeTruthy();
  });

  it("virtualises above 300 rows: only a window of the 5,000 files is in the DOM", () => {
    const large = syntheticLarge({ info: repo, diff });
    seed({ diff: large.diff, prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" } });
    render(<Sidebar initialRect={{ width: 300, height: 600 }} />);
    const list = screen.getByRole("listbox");
    expect(list.getAttribute("data-total")).toBe("5000");
    expect(list.getAttribute("data-virtual")).toBe("true");
    const rendered = screen.getAllByRole("option").length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(120);
  });

  it("click activates the file and publishes a scroll request; viewed checkbox toggles without activating", () => {
    const a = seed({ prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" } });
    const scrolled: string[] = [];
    const off = onScrollRequest((id) => scrolled.push(id));
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("docs/guide.md"));
    expect(a.setActiveFile).toHaveBeenCalledWith("docs/guide.md");
    expect(scrolled).toEqual(["docs/guide.md"]);
    fireEvent.click(screen.getByLabelText("Viewed: src/a.txt"));
    expect(a.toggleViewed).toHaveBeenCalledWith("src/a.txt");
    expect(a.setActiveFile).toHaveBeenCalledTimes(1);
    off();
  });

  it("j / k move the active file in row order; v toggles viewed on the active file", () => {
    const a = seed({
      prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" },
      activeFileId: "docs/guide.md",
    });
    render(<Sidebar />);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(a.setActiveFile).toHaveBeenLastCalledWith("generated/bundle.js");
    fireEvent.keyDown(document.body, { key: "k" });
    expect(a.setActiveFile).toHaveBeenLastCalledWith("data/blob.bin");
    fireEvent.keyDown(document.body, { key: "v" });
    expect(a.toggleViewed).toHaveBeenCalledWith("docs/guide.md");
    cleanup();
    const b = seed({ prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" }, activeFileId: null });
    render(<Sidebar />);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(b.setActiveFile).toHaveBeenLastCalledWith(diff.files[0]?.id);
  });

  it("arrow keys move focus (roving tabindex), Enter activates, Left collapses a folder", () => {
    const a = seed();
    render(<Sidebar />);
    const tree = screen.getByRole("tree");
    const rows = screen.getAllByRole("treeitem");
    expect(rows.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    const key = (k: string) => fireEvent.keyDown(document.activeElement as Element, { key: k });
    (rows[0] as HTMLElement).focus();
    expect(tree.contains(document.activeElement)).toBe(true);
    key("ArrowDown");
    key("ArrowDown");
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("data-index")).toBe("2");
    key("Enter");
    if (focused.getAttribute("aria-expanded") === null) {
      expect(a.setActiveFile).toHaveBeenCalledWith(focused.getAttribute("title"));
    }
    // first row is the "assets" folder: collapse it with ArrowLeft
    key("Home");
    expect((document.activeElement as HTMLElement).getAttribute("data-index")).toBe("0");
    const before = screen.getAllByRole("treeitem").length;
    key("ArrowLeft");
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(before);
  });

  it("prioritises the visible files (debounced) and reports 'n of m files' while filtering", () => {
    vi.useFakeTimers();
    const a = seed({ filter: "src/", prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" } });
    render(<Sidebar />);
    expect(screen.getByText("of 12 files").parentElement?.textContent).toBe("5 of 12 files");
    vi.advanceTimersByTime(150);
    expect(a.prioritise).toHaveBeenCalledTimes(1);
    expect(a.prioritise.mock.calls[0]?.[0]).toEqual([
      "src/a.txt",
      "src/b.txt",
      "src/big-change.txt",
      "src/link",
      "src/new.txt",
    ]);
  });

  it("resize handle: arrows move 10 px, clamped to 220–480, and the width is written to prefs", () => {
    const a = seed({ prefs: { ...DEFAULT_PREFS, sidebarWidth: 475 } });
    render(<Sidebar />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(handle.getAttribute("aria-valuenow")).toBe("475");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(a.setPref).toHaveBeenCalledWith("sidebarWidth", 480);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(a.setPref).toHaveBeenCalledWith("sidebarWidth", 465);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(a.setPref).toHaveBeenCalledWith("sidebarWidth", 220);
  });

  it("Tree | Flat control writes the layout pref", () => {
    const a = seed();
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Tree" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Flat" }));
    expect(a.setPref).toHaveBeenCalledWith("sidebarLayout", "flat");
  });
});
