/**
 * T11.4 — the Hidden group, the WhyHidden popover and the built-in-excludes setting (Design §14.1,
 * §14.3, §14.4, §14.7; atlas tab 08). Everything runs on the recorded `hidden` fixture: the rows,
 * the tags and every reason the popover prints are what the real engine produced for it.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, HiddenEntry, PathExplanation, RepoInfo } from "../../engine/types";
import hiddenDiff from "../../test/recorded/hidden.diffresult.json";
import hiddenInfo from "../../test/recorded/hidden.repoinfo.json";
import hiddenV2 from "../../test/recorded/hidden.v2.json";
import { DEFAULT_PREFS, type StoreState, useStore } from "../store";
import { FilesView } from "./FilesView";
import { HelpDialog } from "./HelpDialog";
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
// happy-dom has no layout: give the virtualiser and the popover anchor a 300 × 600 box.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 600, width: 300, height: 600 };
HTMLElement.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect });

const repo = hiddenInfo as unknown as RepoInfo;
const diff = hiddenDiff as unknown as DiffResult;
const entries = hiddenV2.hidden as HiddenEntry[];
const explanations = hiddenV2.explanations as unknown as Record<string, PathExplanation>;

const initial = useStore.getState();

function seed(overrides: Partial<StoreState> = {}) {
  const actions = {
    setPref: vi.fn((key: string, value: unknown) => {
      useStore.setState((s) => ({ prefs: { ...s.prefs, [key]: value } }));
    }),
    loadHidden: vi.fn(async () => {}),
    explainPath: vi.fn(
      async (path: string): Promise<PathExplanation> =>
        explanations[path] ?? { path, shown: true, reasons: [] },
    ),
    setActiveFile: vi.fn(),
    toggleViewed: vi.fn(),
    setViewed: vi.fn(),
    prioritise: vi.fn(),
    loadFileDiff: vi.fn(async () => {}),
    reopenSession: vi.fn(async () => {}),
  };
  useStore.setState(
    {
      ...initial,
      screen: "repo",
      repo,
      repoId: "hidden",
      handle: { name: "hidden" },
      diff,
      diffSource: diff.source,
      prefs: { ...DEFAULT_PREFS, showHidden: true },
      hidden: entries,
      ...actions,
      ...overrides,
    },
    true,
  );
  return actions;
}

const sidebar = () => render(<Sidebar initialRect={{ width: 300, height: 600 }} />);
const groupHeader = (name: RegExp) => screen.getByRole("treeitem", { name });
/** Rows are keyed by path: the accessible name is `<path>[, n entries] — <sentence>`. */
const hiddenRow = (path: string): HTMLElement => {
  const row = [...document.querySelectorAll<HTMLElement>("[data-hidden-kind]")].find(
    (el) => (el.getAttribute("aria-label") ?? "").split(/,| — /)[0] === path,
  );
  if (!row) throw new Error(`no Hidden row for ${path}`);
  return row;
};
/** happy-dom's `.focus()` does not reach React's `onFocus` (a `focusin` listener). */
const focusRow = (el: HTMLElement) => {
  el.focus();
  fireEvent.focusIn(el);
};

afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

describe("Hidden group (Design §14.4)", () => {
  it("is appended after the layer groups only while the toggle is on", () => {
    seed({ prefs: { ...DEFAULT_PREFS, showHidden: false }, hidden: null });
    const { unmount } = sidebar();
    const headers = () =>
      [...document.querySelectorAll('[role="treeitem"][aria-level="1"]')].map(
        (el) => el.textContent?.replace(/\d+$/, "") ?? "",
      );
    expect(headers().some((h) => h.startsWith("Hidden"))).toBe(false);
    unmount();

    seed();
    sidebar();
    const labels = [...document.querySelectorAll('[role="treeitem"][aria-level="1"]')].map((el) =>
      el.getAttribute("aria-label"),
    );
    // Unstaged, Untracked, then Hidden — always last (Design §14.4 order).
    expect(labels.at(-1)).toBe("Hidden, 7 paths");
    expect(labels.filter((l) => l?.startsWith("Hidden"))).toHaveLength(1);
  });

  it("is appended in Path mode too", () => {
    seed({ prefs: { ...DEFAULT_PREFS, showHidden: true, sidebarGroup: "path" } });
    sidebar();
    expect(screen.getByRole("treeitem", { name: "Hidden, 7 paths" })).toBeTruthy();
    expect(document.querySelectorAll("[data-hidden-kind]")).toHaveLength(7);
    // Path mode has no layer groups at all; the Hidden header is the only section header.
    expect(document.querySelectorAll("[data-group]")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Untracked");
  });

  it("renders one row per entry with the tag of its kind, directories as a single counted row", () => {
    seed();
    sidebar();
    const rows = [...document.querySelectorAll("[data-hidden-kind]")].map((el) => ({
      kind: el.getAttribute("data-hidden-kind"),
      text: el.textContent,
    }));
    // `expected/` holds the parity files the fixture scripts write; its count grows with every
    // engine task, so read it from the recording rather than pinning a number.
    const expectedDir = entries.find((e) => e.path === "expected");
    expect(expectedDir?.kind).toBe("ignored-dir");
    expect(rows).toEqual([
      { kind: "ignored", text: "·.DS_Storeignored" },
      { kind: "ignored", text: "·.env.localignored" },
      { kind: "too-large", text: "·big.txt> 10 MB" },
      { kind: "ignored-dir", text: "·dist/3ignored" },
      { kind: "ignored-dir", text: `·expected/${expectedDir?.count}ignored` },
      { kind: "assume-unchanged", text: "·src/assumed.txtassume-unchanged" },
      { kind: "skip-worktree", text: "·src/skipped.txtskip-worktree" },
    ]);
    // An ignored directory never expands: no chevron, no aria-expanded, no children.
    expect(hiddenRow("dist").getAttribute("aria-expanded")).toBe("false"); // the popover, not a subtree
    expect(within(hiddenRow("dist")).queryByRole("treeitem")).toBeNull();
  });

  it("collapses like any other group and says so when nothing is hidden", () => {
    seed();
    sidebar();
    fireEvent.click(groupHeader(/^Hidden, 7 paths$/));
    expect(document.querySelectorAll("[data-hidden-kind]")).toHaveLength(0);
    cleanup();

    seed({ hidden: [] });
    sidebar();
    expect(screen.getByRole("treeitem", { name: "Hidden, 0 paths" })).toBeTruthy();
    expect(document.body.textContent).toContain("Nothing is hidden in this repository");
  });

  it("narrows with the path filter and counts `k of n`", () => {
    seed({ filter: "src/" });
    sidebar();
    const header = screen.getByRole("treeitem", { name: "Hidden, 2 paths" });
    expect(header.textContent).toContain("2 of 7");
    expect(document.querySelectorAll("[data-hidden-kind]")).toHaveLength(2);
  });
});

describe("Sidebar toggle and Shift+H (Design §14.1, §14.7)", () => {
  it("row 1 carries the eye-off toggle after Tree | Flat and writes the pref", () => {
    const actions = seed({ prefs: { ...DEFAULT_PREFS, showHidden: false }, hidden: null });
    sidebar();
    const toggle = screen.getByRole("button", { name: "Show hidden files" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(actions.setPref).toHaveBeenCalledWith("showHidden", true);
    expect(
      screen.getByRole("button", { name: "Show hidden files" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("Shift+H toggles the pref from anywhere in Files mode (Design §14.7)", () => {
    const actions = seed({ prefs: { ...DEFAULT_PREFS, showHidden: false }, hidden: null });
    render(<FilesView />);
    fireEvent.keyDown(document.body, { key: "H", shiftKey: true });
    expect(actions.setPref).toHaveBeenLastCalledWith("showHidden", true);
    fireEvent.keyDown(document.body, { key: "H", shiftKey: true });
    expect(actions.setPref).toHaveBeenLastCalledWith("showHidden", false);
  });

  it("keeps the sidebar up for the Hidden group even when nothing changed", () => {
    seed({ diff: { ...diff, files: [], totals: { files: 0, additions: 0, deletions: 0 } } });
    render(<FilesView />);
    expect(screen.getByRole("treeitem", { name: "Hidden, 7 paths" })).toBeTruthy();
  });
});

describe("WhyHiddenPopover (Design §14.3, atlas tab 08)", () => {
  const open = async (path: string) => {
    fireEvent.click(hiddenRow(path));
    return await screen.findByTestId("why-hidden");
  };

  beforeEach(() => {
    seed();
  });

  it("explains an ignored file: rule file, line, pattern and the check-ignore command", async () => {
    sidebar();
    const pop = await open(".env.local");
    expect(pop.querySelector("h2")?.textContent).toBe(".env.local is not in the diff");
    expect(pop.textContent).toContain("Ignored by");
    expect(pop.textContent).toContain(".gitignore line 2: .env.local");
    expect(
      within(pop).getByRole("button", { name: "Copy: git check-ignore -v .env.local" }),
    ).toBeTruthy();
  });

  it("names the built-in excludes and the setting that turns them off", async () => {
    sidebar();
    const pop = await open(".DS_Store");
    expect(pop.textContent).toContain("Ignored by diffgit's built-in excludes");
    expect(pop.textContent).toContain("Apply built-in excludes");
  });

  it("explains skip-worktree, assume-unchanged and the size gate", async () => {
    sidebar();
    let pop = await open("src/skipped.txt");
    expect(pop.querySelector("h2")?.textContent).toBe(
      "src/skipped.txt is tracked but its edits are not shown",
    );
    expect(
      within(pop).getByRole("button", {
        name: "Copy: git update-index --no-skip-worktree src/skipped.txt",
      }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    pop = await open("src/assumed.txt");
    expect(pop.textContent).toContain("assume-unchanged");
    fireEvent.keyDown(document, { key: "Escape" });

    pop = await open("big.txt");
    expect(pop.textContent).toContain("Over 10 MB");
    // The size gate has no command to undo it, so no Copy button is offered.
    expect(within(pop).queryByRole("button", { name: /^Copy/ })).toBeNull();
  });

  it("opens on a focused row with `?` and on a right-click, and closes on Escape", async () => {
    sidebar();
    const row = hiddenRow(".env.local");
    focusRow(row);
    fireEvent.keyDown(row, { key: "?" });
    expect(await screen.findByTestId("why-hidden")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("why-hidden")).toBeNull());

    fireEvent.contextMenu(hiddenRow("big.txt"));
    expect((await screen.findByTestId("why-hidden")).textContent).toContain("big.txt");
  });

  it("answers for a visible file too: `?` on a file row says it is in the diff", async () => {
    sidebar();
    const fileRow = screen.getByTitle("notes.txt");
    focusRow(fileRow);
    fireEvent.keyDown(fileRow, { key: "?" });
    const pop = await screen.findByTestId("why-hidden");
    expect(pop.querySelector("h2")?.textContent).toBe("notes.txt is in the diff");
    expect(pop.textContent).toContain("Nothing hides this path");
  });

  it("explains a clean tracked file that never reaches the diff", async () => {
    sidebar();
    const row = hiddenRow(".env.local");
    focusRow(row);
    useStore.setState({
      explainPath: vi.fn(async () => explanations["README.md"] as PathExplanation),
    });
    fireEvent.keyDown(row, { key: "?" });
    const pop = await screen.findByTestId("why-hidden");
    expect(pop.textContent).toContain("nothing to show");
  });

  it("adds the global-excludes note only when the engine reported that gap", async () => {
    seed({
      warnings: [{ code: "GLOBAL_EXCLUDES_UNAVAILABLE", message: "core.excludesFile unreadable" }],
    });
    sidebar();
    const pop = await open(".env.local");
    expect(pop.textContent).toContain("Global excludes");
    cleanup();

    seed();
    sidebar();
    expect((await open(".env.local")).textContent).not.toContain("Global excludes");
  });

  it("has no axe violations in either theme", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      seed();
      const { container } = sidebar();
      fireEvent.click(hiddenRow(".env.local"));
      await screen.findByTestId("why-hidden");
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});

describe("Apply built-in excludes (HelpDialog settings, backlog B10)", () => {
  it("is checked by default and writes the pref when unticked", () => {
    const actions = seed();
    render(<HelpDialog open onClose={() => {}} />);
    const box = screen.getByRole("checkbox", { name: /Apply built-in excludes/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    expect(actions.setPref).toHaveBeenCalledWith("builtinExcludes", false);
    expect(document.body.textContent).toContain("re-opens the repository");
  });
});
