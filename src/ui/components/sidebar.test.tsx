import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, FileDiff, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import basic from "../../test/recorded/showcase.repoinfo.json";
import worktreeDiff from "../../test/recorded/showcase-worktree.diffresult.json";
import { Lru } from "../lru";
import { syntheticLarge } from "../mock/syntheticLarge";
import { onScrollRequest } from "../scrollBus";
import { DEFAULT_PREFS, type FileDiffEntry, type StoreState, useStore } from "../store";
import { viewedKey } from "../viewedKey";
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
    setViewed: vi.fn(),
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

  it("no chips on a row; — for binary and a skeleton while stats load", () => {
    seed({ diff: wtDiff, prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" } });
    render(<Sidebar />);
    expect(
      document.querySelectorAll(
        "[aria-label='Staged change'], [aria-label='Unstaged change'], " +
          "[aria-label='Untracked file'], [aria-label='Merge conflict'], " +
          "[aria-label='Generated file']",
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
    ).toBeNull();
    expect(screen.getByTitle("data/blob.bin").textContent).toContain("—");
    expect(
      screen.getByTitle("docs/guide.md").querySelector('[aria-label="Loading stats"]'),
    ).toBeTruthy();
  });

  it("virtualises above 300 rows: only a window of the 5,000 files is in the DOM", () => {
    const large = syntheticLarge({ info: repo, diff });
    seed({
      diff: large.diff,
      prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat", sidebarGroup: "path" },
    });
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

describe("RowStats marks (S3)", () => {
  it("shows a different mark for gated, binary and failed files", () => {
    const files = [
      file("dist/bundle.js", { tooLarge: true, stats: null }),
      file("public/logo.png", { binary: true, stats: null }),
      file("src/api/orders.ts"),
      file("src/pending.ts", { stats: null }),
    ];
    const lru = new Lru<string, FileDiffEntry>(200);
    lru.set("src/api/orders.ts|x", {
      status: "error",
      error: { code: "IO_ERROR", message: "boom" },
    });
    const loadFileDiff = vi.fn(async () => {});
    seed({
      diff: { ...diff, files, totals: { files: 4, additions: 0, deletions: 0 } },
      fileDiffs: lru,
      loadFileDiff,
    });
    render(<Sidebar />);

    const gated = screen.getByTitle("dist/bundle.js");
    expect(gated.textContent).toContain("> 1 MB");
    expect(gated.querySelector('[title="Over 1 MB — Load diff in the card"]')).toBeTruthy();

    expect(
      screen.getByTitle("public/logo.png").querySelector('[aria-label="Binary file"]'),
    ).toBeTruthy();

    const retry = screen
      .getByTitle("src/api/orders.ts")
      .querySelector<HTMLButtonElement>('[aria-label="Stats failed: retry"]');
    expect(retry?.textContent).toBe("retry");
    fireEvent.click(retry as HTMLButtonElement);
    expect(loadFileDiff).toHaveBeenCalledWith("src/api/orders.ts");
    // clicking retry must not also activate the row
    expect(useStore.getState().setActiveFile).not.toHaveBeenCalled();

    expect(
      screen.getByTitle("src/pending.ts").querySelector('[aria-label="Loading stats"]'),
    ).toBeTruthy();
  });
});

/** `showcase-worktree` has all five layers: 1 conflict, 4 staged, 3 unstaged, 2 untracked, 1 committed. */
describe("Sidebar groups (T9.1, D1–D9)", () => {
  /** Group headers are the only rows with an `aria-label`; the label is the accessible name. */
  const headers = () =>
    screen
      .queryAllByRole("treeitem")
      .filter((r) => r.hasAttribute("aria-label"))
      .map((r) => r.getAttribute("aria-label"));

  // T11.3: the label no longer always ends in "(XY)" — an unmerged row whose ConflictPayload has
  // not arrived says "Unmerged path" — so the code is found by its own hook.
  const codeIn = (row: HTMLElement) => row.querySelector("[data-layer-code]");

  /** happy-dom's `.focus()` does not reach React's `onFocus` (a `focusin` listener). */
  const focusRow = (el: HTMLElement) => {
    el.focus();
    fireEvent.focusIn(el);
  };

  it("renders the five groups in D1 order with their counts, dots and totals", () => {
    seed({ diff: wtDiff });
    render(<Sidebar />);
    expect(headers()).toEqual([
      "Conflicts, 1 file",
      "Staged, 4 files",
      "Unstaged, 3 files",
      "Untracked, 2 files",
      "Committed on feature, 1 file",
    ]);
    const staged = screen.getByRole("treeitem", { name: "Staged, 4 files" });
    expect(staged.getAttribute("aria-expanded")).toBe("true");
    expect(staged.textContent).toContain("Staged");
    expect(staged.textContent).toContain("4");
    // group +n −m over its files, and the viewed progress
    expect(staged.textContent).toContain("+2");
    expect(staged.textContent).toContain("−1");
    expect(staged.textContent).toContain("0/4");
    // the second header row is present with the uncommitted count
    expect(screen.getByRole("button", { name: "Layer" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("10 uncommitted")).toBeTruthy();
    // the container is a tree in both layouts while grouped
    expect(screen.getByRole("tree")).toBeTruthy();
  });

  it("hides empty groups and reads `k of n` while a filter is active (D5)", () => {
    seed({ diff: wtDiff, filter: "staged" });
    render(<Sidebar />);
    expect(headers()).toEqual(["Staged, 3 files", "Unstaged, 2 files"]);
    expect(screen.getByRole("treeitem", { name: "Staged, 3 files" }).textContent).toContain(
      "3 of 4",
    );
    expect(screen.getByRole("treeitem", { name: "Unstaged, 2 files" }).textContent).toContain(
      "2 of 3",
    );
  });

  it("a staged+unstaged file sits once under Unstaged with the MM code; committed rows have none", () => {
    seed({ diff: wtDiff });
    render(<Sidebar />);
    const both = screen.getAllByTitle("both.txt");
    expect(both).toHaveLength(1);
    const code = codeIn(both[0] as HTMLElement);
    expect(code?.getAttribute("aria-label")).toBe("Staged, then edited again (MM)");
    expect(code?.textContent).toBe("MM");
    // header already says the layer: single-layer rows carry no code inside a group
    expect(codeIn(screen.getByTitle("staged-mod.txt"))).toBeNull();
    expect(codeIn(screen.getByTitle("untracked.txt"))).toBeNull();
    expect(codeIn(screen.getByTitle("feature-only.txt"))).toBeNull();
  });

  it("path mode shows the code on every uncommitted row and drops the group headers", () => {
    seed({
      diff: wtDiff,
      prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat", sidebarGroup: "path" },
    });
    render(<Sidebar />);
    expect(headers()).toEqual([]);
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(codeIn(screen.getByTitle("staged-mod.txt"))?.getAttribute("aria-label")).toBe(
      "Staged only (M·)",
    );
    expect(codeIn(screen.getByTitle("unstaged-mod.txt"))?.getAttribute("aria-label")).toBe(
      "Unstaged only (·M)",
    );
    expect(codeIn(screen.getByTitle("untracked.txt"))?.getAttribute("aria-label")).toBe(
      "Untracked file (??)",
    );
    // T11.3: no ConflictPayload is loaded here, so the row says it is unmerged and no more.
    expect(codeIn(screen.getByTitle("file.txt"))?.getAttribute("aria-label")).toBe("Unmerged path");
    expect(codeIn(screen.getByTitle("deleted-staged.txt"))?.getAttribute("aria-label")).toBe(
      "Staged only (D·)",
    );
    expect(codeIn(screen.getByTitle("feature-only.txt"))).toBeNull();
  });

  it("`Layer | Path` writes the pref", () => {
    const a = seed({ diff: wtDiff });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Path" }));
    expect(a.setPref).toHaveBeenCalledWith("sidebarGroup", "path");
  });

  it("with a single layer there is no second row and no group header (D2, D9)", () => {
    seed();
    render(<Sidebar />);
    expect(headers()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Layer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Path" })).toBeNull();
    expect(screen.queryByText(/uncommitted$/)).toBeNull();
    expect(screen.getByRole("tree")).toBeTruthy();
    cleanup();
    seed({ prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" } });
    render(<Sidebar />);
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("with no uncommitted layer the rows are today's plain tree, byte for byte", () => {
    seed({ diff: { ...diff, files: [file("README.md"), file("src/x.ts")] } });
    const { container } = render(<Sidebar />);
    expect(container.querySelector('[role="tree"]')?.innerHTML).toMatchInlineSnapshot(
      `"<div role="treeitem" aria-level="1" aria-expanded="true" aria-selected="false" data-index="0" tabindex="0" class="flex h-6 cursor-pointer items-center gap-1 text-xs text-muted select-none hover:bg-surface-raised" style="padding-left: 12px;"><svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down shrink-0" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder shrink-0" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg><span class="truncate">src</span></div><div role="treeitem" aria-level="2" tabindex="-1" aria-selected="false" data-index="1" class="flex h-[26px] cursor-pointer items-center gap-[7px] pr-2 select-none hover:bg-surface-raised " style="padding-left: 26px;" title="src/x.ts"><span role="img" aria-label="Modified" title="Modified" class="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] leading-none font-bold bg-status-m-bg text-status-m-fg">M</span><span class="min-w-0 flex-1 truncate text-[12.5px] leading-5 font-medium">x.ts</span><span class="font-mono text-[11px] tabular-nums whitespace-nowrap"><span class="text-success">+1</span> <span class="text-danger">−1</span></span><input class="size-3.5 shrink-0 accent-success" tabindex="-1" aria-label="Viewed: src/x.ts" type="checkbox"></div><div role="treeitem" aria-level="1" tabindex="-1" aria-selected="false" data-index="2" class="flex h-[26px] cursor-pointer items-center gap-[7px] pr-2 select-none hover:bg-surface-raised " style="padding-left: 12px;" title="README.md"><span role="img" aria-label="Modified" title="Modified" class="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] leading-none font-bold bg-status-m-bg text-status-m-fg">M</span><span class="min-w-0 flex-1 truncate text-[12.5px] leading-5 font-medium">README.md</span><span class="font-mono text-[11px] tabular-nums whitespace-nowrap"><span class="text-success">+1</span> <span class="text-danger">−1</span></span><input class="size-3.5 shrink-0 accent-success" tabindex="-1" aria-label="Viewed: README.md" type="checkbox"></div>"`,
    );
  });

  it("a collapsed folder inside a group shows its file count and +n −m (D7)", () => {
    seed({ diff: wtDiff });
    render(<Sidebar />);
    const folder = screen.getByText("newdir").closest('[role="treeitem"]') as HTMLElement;
    expect(folder.textContent).toBe("newdir"); // open: nothing but the name
    fireEvent.click(folder);
    const collapsed = screen.getByText("newdir").closest('[role="treeitem"]') as HTMLElement;
    expect(collapsed.getAttribute("aria-expanded")).toBe("false");
    expect(collapsed.textContent).toContain("1");
    expect(collapsed.textContent).toContain("+1");
    expect(collapsed.textContent).toContain("−0");
  });

  it("click, Enter and ← → collapse and expand a group header", () => {
    seed({ diff: wtDiff });
    render(<Sidebar />);
    const all = () => screen.getAllByRole("treeitem").length;
    const before = all();
    const staged = screen.getByRole("treeitem", { name: "Staged, 4 files" });
    fireEvent.click(staged);
    expect(all()).toBe(before - 4);
    expect(
      screen.getByRole("treeitem", { name: "Staged, 4 files" }).getAttribute("aria-expanded"),
    ).toBe("false");
    // ArrowRight on a collapsed header re-opens it
    focusRow(screen.getByRole("treeitem", { name: "Staged, 4 files" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(all()).toBe(before);
    // ArrowLeft closes it again, Enter re-opens it
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(all()).toBe(before - 4);
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(all()).toBe(before);
  });

  it("ArrowLeft on a depth-0 row inside a group focuses the group header", () => {
    seed({ diff: wtDiff });
    render(<Sidebar />);
    focusRow(screen.getByTitle("staged-mod.txt"));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(
      "Staged, 4 files",
    );
  });

  it("`v` on a focused header marks the whole group viewed", () => {
    // an active file makes the global `v` observable: it must stay silent
    const a = seed({ diff: wtDiff, activeFileId: "staged-mod.txt" });
    render(<Sidebar />);
    focusRow(screen.getByRole("treeitem", { name: "Staged, 4 files" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "v" });
    expect(a.setViewed).toHaveBeenCalledWith(
      ["deleted-staged.txt", "script.sh", "staged-mod.txt", "staged-new.txt"],
      true,
    );
    // the global `v` must not also fire on the active file
    expect(a.toggleViewed).not.toHaveBeenCalled();
  });

  it("collapsing another group from a row inside it moves focus to that header instead of <body>", () => {
    seed({ diff: wtDiff });
    render(<Sidebar />);
    focusRow(screen.getByRole("treeitem", { name: /both\.txt/ }));
    expect(document.activeElement?.getAttribute("title")).toBe("both.txt");
    // happy-dom does not focus a button on click, so this is the Safari-style stranding case
    const staged = screen.getByRole("treeitem", { name: "Staged, 4 files" });
    fireEvent.click(within(staged).getByRole("button", { name: "Collapse other groups" }));
    expect(staged.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("treeitem", { name: /both\.txt/ })).toBeNull();
    expect(document.activeElement).toBe(staged);
  });

  it("the header actions mark the group viewed and collapse the other groups", () => {
    const a = seed({ diff: wtDiff });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Mark all in Staged viewed" }));
    expect(a.setViewed).toHaveBeenCalledWith(
      ["deleted-staged.txt", "script.sh", "staged-mod.txt", "staged-new.txt"],
      true,
    );
    // clicking an action must not toggle the group
    expect(
      screen.getByRole("treeitem", { name: "Staged, 4 files" }).getAttribute("aria-expanded"),
    ).toBe("true");
    const before = screen.getAllByRole("treeitem").length;
    fireEvent.click(screen.getAllByRole("button", { name: "Collapse other groups" })[1] as Element);
    // only Staged's 4 rows remain under the five headers
    expect(screen.getAllByRole("treeitem").length).toBe(9);
    expect(before).toBeGreaterThan(9);
  });

  it("a fully viewed group shows ✓ k/n and offers 'Clear viewed'", () => {
    const stagedIds = ["deleted-staged.txt", "script.sh", "staged-mod.txt", "staged-new.txt"];
    const viewed = new Set(
      wtDiff.files
        .filter((f) => stagedIds.includes(f.id))
        .map((f) => viewedKey("r1", wtDiff.source, f)),
    );
    seed({ diff: wtDiff, viewed });
    render(<Sidebar />);
    const staged = screen.getByRole("treeitem", { name: "Staged, 4 files" });
    expect(staged.textContent).toContain("✓ 4/4");
    expect(staged.className).toContain("opacity-55");
    expect(screen.getByRole("button", { name: "Clear viewed in Staged" })).toBeTruthy();
  });

  it("j / k still walk files across group boundaries", () => {
    // last file of Staged → first file of Unstaged
    const a = seed({ diff: wtDiff, activeFileId: "staged-new.txt" });
    render(<Sidebar />);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(a.setActiveFile).toHaveBeenLastCalledWith("both.txt");
    cleanup();
    // and back up over the same boundary
    const b = seed({ diff: wtDiff, activeFileId: "both.txt" });
    render(<Sidebar />);
    fireEvent.keyDown(document.body, { key: "k" });
    expect(b.setActiveFile).toHaveBeenLastCalledWith("staged-new.txt");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(b.setActiveFile).toHaveBeenLastCalledWith("deleted-unstaged.txt");
  });

  it("grouped flat layout is still a tree; a deleted name is struck through (D8)", () => {
    seed({ diff: wtDiff, prefs: { ...DEFAULT_PREFS, sidebarLayout: "flat" } });
    render(<Sidebar />);
    expect(screen.getByRole("tree")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(headers()).toHaveLength(5);
    expect(screen.getByTitle("staged-mod.txt").getAttribute("aria-level")).toBe("2");
    const deleted = screen.getByTitle("deleted-staged.txt");
    expect(deleted.querySelector(".line-through")?.textContent).toBe("deleted-staged.txt");
    expect(screen.getByTitle("staged-mod.txt").querySelector(".line-through")).toBeNull();
  });

  it("the same folder can be open in one group and collapsed in another", () => {
    const files = [
      file("src/a.ts", { layers: ["staged"] }),
      file("src/b.ts", { layers: ["unstaged"] }),
    ];
    seed({ diff: { ...wtDiff, files } });
    render(<Sidebar />);
    expect(screen.getAllByText("src")).toHaveLength(2);
    fireEvent.click(screen.getAllByText("src")[0] as Element);
    const dirs = screen
      .getAllByText("src")
      .map((el) => el.closest('[role="treeitem"]')?.getAttribute("aria-expanded"));
    expect(dirs).toEqual(["false", "true"]);
    expect(screen.queryByTitle("src/a.ts")).toBeNull();
    expect(screen.getByTitle("src/b.ts")).toBeTruthy();
  });
});
