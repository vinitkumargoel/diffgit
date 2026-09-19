/**
 * T11.7 — Branches mode (Design §14.6, atlas tab 09). The table, the lazily filled ahead/behind
 * cells, the three filters, the search box, the row `…` menu and the tags table, all on the
 * recorded `history` / `octopus` overviews so every number comes from the real engine.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchRow, DiffResult, RepoInfo, TagInfo } from "../../engine/types";
import historyDiff from "../../test/recorded/history.diffresult.json";
import historyInfo from "../../test/recorded/history.repoinfo.json";
import historyV2 from "../../test/recorded/history.v2.json";
import octopusInfo from "../../test/recorded/octopus.repoinfo.json";
import octopusV2 from "../../test/recorded/octopus.v2.json";
import { type BranchCells, STALE_MS } from "../branches";
import { DEFAULT_PREFS, INITIAL_BRANCHES, type StoreState, useStore } from "../store";
import { BranchesView } from "./BranchesView";
import { TopBar } from "./TopBar";

const repo = historyInfo as unknown as RepoInfo;
const diff = historyDiff as unknown as DiffResult;
const rows = historyV2.branches as unknown as BranchRow[];
const tags = historyV2.tags as unknown as TagInfo[];
const octopusRepo = octopusInfo as unknown as RepoInfo;
const octopusRows = octopusV2.branches as unknown as BranchRow[];

/** One day after the newest recorded tip, so every recorded branch counts as Active. */
const NOW = 1710633600000 + 86_400_000;
/** Well past 90 days after every tip, so every recorded branch counts as stale. */
const OLD = 1710633600000 + 4 * STALE_MS;

/** The cells the recording holds, as `branchCells` would hand them back. */
const CELLS: Record<string, BranchCells> = Object.fromEntries(
  rows.map((r) => [
    r.ref.fullName,
    { vsUpstream: r.vsUpstream, vsDefault: r.vsDefault, merged: r.merged },
  ]),
);

const initial = useStore.getState();

function seed(overrides: Partial<StoreState> = {}, branches: Partial<StoreState["branches"]> = {}) {
  const actions = {
    loadBranches: vi.fn(async () => {}),
    loadPickerSources: vi.fn(async () => {}),
    requestBranchCells: vi.fn(),
    showBranchHistory: vi.fn(),
    compareBranchWithBase: vi.fn(),
    compareTags: vi.fn(),
    setSource: vi.fn(),
    setTarget: vi.fn(),
    addToast: vi.fn(() => 0),
  };
  useStore.setState(
    {
      ...initial,
      screen: "repo",
      repo,
      repoId: "hist",
      mode: "branches",
      diff,
      diffSource: diff.source,
      prefs: DEFAULT_PREFS,
      tags,
      compareBase: { expr: "refs/heads/main", display: "main" },
      branches: { ...INITIAL_BRANCHES, rows, cells: CELLS, ...branches },
      ...actions,
      ...overrides,
    },
    true,
  );
  return actions;
}

afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

const rowOf = (name: string) =>
  document.querySelector(`[data-ref="refs/heads/${name}"]`) as HTMLElement;
const bodyRows = () => [...document.querySelectorAll("[data-rows] tr")] as HTMLElement[];

describe("BranchesView table (Design §14.6)", () => {
  it("renders one grid row per branch with badges, last commit, author and age", () => {
    seed();
    render(<BranchesView now={NOW} />);
    expect(screen.getByRole("grid", { name: "Branches" })).toBeTruthy();
    expect(bodyRows().map((r) => r.getAttribute("data-ref"))).toEqual([
      "refs/heads/preflight/a", // sorted by age, newest tip first
      "refs/heads/main",
      "refs/heads/topic",
      "refs/heads/preflight/base",
    ]);
    const main = rowOf("main");
    expect(within(main).getByTitle("Checked-out branch").textContent).toBe("HEAD");
    expect(within(main).getByTitle("Default branch").textContent).toBe("default");
    expect(within(main).getByTitle("Tag: v1.0.0").textContent).toBe("v1.0.0");
    expect(main.textContent).toContain("c59: extend mod4");
    expect(main.textContent).toContain("822313f");
    expect(main.textContent).toContain("test");
    expect(main.textContent).toContain("d ago");
  });

  it("prints the column header of the branch every other branch is counted against", () => {
    seed();
    render(<BranchesView now={NOW} />);
    expect(screen.getByRole("columnheader", { name: "vs main" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "vs upstream" })).toBeTruthy();
  });

  it("shows the recorded counts with a two-colour bar, and `merged` where the engine said so", () => {
    seed();
    render(<BranchesView now={NOW} />);
    const a = within(rowOf("preflight/a")).getByText("3 ↑ 55 ↓");
    expect(a).toBeTruthy();
    // atlas scale: 10 px per commit, the pair squeezed into 60 px
    expect(
      (rowOf("preflight/a").querySelector("[data-bar]") as HTMLElement).getAttribute("data-bar"),
    ).toBe("30/30");
    expect(within(rowOf("topic")).getByTitle(/already on the base branch/).textContent).toBe(
      "merged",
    );
    // the default branch is the one the others are compared with, so it has no cell of its own
    const baseCell = rowOf("main").querySelector('[data-cell="base"]') as HTMLElement;
    expect(baseCell.textContent).toBe("—");
  });

  it("says `no upstream` rather than a zero when a branch tracks nothing", () => {
    seed();
    render(<BranchesView now={NOW} />);
    const cell = rowOf("topic").querySelector('[data-cell="upstream"]') as HTMLElement;
    expect(cell.textContent).toBe("no upstream");
  });

  it("prefixes a capped count with `≥` instead of printing it as exact", () => {
    seed(
      {},
      {
        cells: {
          ...CELLS,
          "refs/heads/topic": {
            vsUpstream: null,
            vsDefault: { ahead: 3, behind: 10_000, mergeBase: null, capped: true },
            merged: false,
          },
        },
      },
    );
    render(<BranchesView now={NOW} />);
    expect(within(rowOf("topic")).getByText("≥3 ↑ ≥10,000 ↓")).toBeTruthy();
  });

  it("fills the cells lazily: skeletons first, then the counts `branchCells` answers", async () => {
    const actions = seed({}, { cells: {} });
    const view = render(<BranchesView now={NOW} />);
    await waitFor(() => expect(actions.requestBranchCells).toHaveBeenCalled());
    expect(actions.requestBranchCells.mock.calls[0]?.[0]).toEqual([
      "refs/heads/preflight/a",
      "refs/heads/main",
      "refs/heads/topic",
      "refs/heads/preflight/base",
    ]);
    expect(rowOf("preflight/a").querySelector("[data-bar]")).toBeNull();
    useStore.setState((s) => ({ branches: { ...s.branches, cells: CELLS } }));
    view.rerender(<BranchesView now={NOW} />);
    expect(within(rowOf("preflight/a")).getByText("3 ↑ 55 ↓")).toBeTruthy();
  });
});

describe("BranchesView filters and search (Design §14.6)", () => {
  it("splits Active from `Stale > 90 d` and offers the other filter when Active is empty", () => {
    seed();
    render(<BranchesView now={OLD} />);
    expect(bodyRows()).toHaveLength(0);
    expect(screen.getByText(/No branch has been committed to in the last 90 days/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show stale branches" }));
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Stale > 90 d" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("narrows the table with the search box", () => {
    seed();
    render(<BranchesView now={NOW} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search branches and tags" }), {
      target: { value: "preflight" },
    });
    expect(bodyRows().map((r) => r.getAttribute("data-ref"))).toEqual([
      "refs/heads/preflight/a",
      "refs/heads/preflight/base",
    ]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search branches and tags" }), {
      target: { value: "nothing-matches" },
    });
    expect(screen.getByText("No branch matches this search.")).toBeTruthy();
  });

  it("counts the repository in the header", () => {
    seed();
    render(<BranchesView now={NOW} />);
    expect(screen.getByText("4 local · 0 remote-tracking · 4 tags")).toBeTruthy();
  });

  it("renders the recorded octopus overview too", () => {
    seed({ repo: octopusRepo, tags: [] }, { rows: octopusRows, cells: {} });
    render(<BranchesView now={1704067200000 + 86_400_000} />);
    expect(bodyRows().map((r) => r.getAttribute("data-ref"))).toEqual([
      "refs/heads/main",
      "refs/heads/side-a",
      "refs/heads/side-b",
    ]);
    expect(screen.getByText("3 local · 0 remote-tracking · 0 tags")).toBeTruthy();
  });
});

describe("BranchesView rows: history, menu and keyboard", () => {
  it("opens the branch in History mode when a row is clicked or Entered", () => {
    const actions = seed();
    render(<BranchesView now={NOW} />);
    fireEvent.click(rowOf("topic"));
    expect(actions.showBranchHistory).toHaveBeenCalledWith("refs/heads/topic");
    fireEvent.keyDown(rowOf("main"), { key: "Enter" });
    expect(actions.showBranchHistory).toHaveBeenLastCalledWith("refs/heads/main");
  });

  it("walks rows with `j` / `k` and never past either end", () => {
    seed();
    render(<BranchesView now={NOW} />);
    const all = bodyRows();
    expect(all[0]?.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(document, { key: "j" });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(document, { key: "k" });
    fireEvent.keyDown(document, { key: "k" });
    expect(document.activeElement).toBe(all[0]);
  });

  it("offers the five row actions and wires four of them", async () => {
    const actions = seed();
    render(<BranchesView now={NOW} />);
    fireEvent.click(within(rowOf("topic")).getByRole("button", { name: "More actions for topic" }));
    const menu = screen.getByRole("menu", { name: "Actions for topic" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((b) => b.textContent),
    ).toEqual([
      "Set as compare",
      "Set as base",
      "Compare with main",
      "Preflight rebase onto main",
      "Copy name",
    ]);
    // T11.13 wired the preflight; it is enabled on a row that is not the base itself
    const preflight = within(menu).getByRole("menuitem", { name: "Preflight rebase onto main" });
    expect((preflight as HTMLButtonElement).disabled).toBe(false);
    expect(preflight.getAttribute("title")).toBe("Report what git rebase -i main would replay");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Compare with main" }));
    expect(actions.compareBranchWithBase).toHaveBeenCalledWith("refs/heads/topic");

    fireEvent.click(within(rowOf("topic")).getByRole("button", { name: "More actions for topic" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Set as compare" }));
    expect(actions.setSource).toHaveBeenCalledWith("refs/heads/topic");

    fireEvent.click(within(rowOf("topic")).getByRole("button", { name: "More actions for topic" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Set as base" }));
    expect(actions.setTarget).toHaveBeenCalledWith("refs/heads/topic");
    // opening the menu must not also open the branch's history
    expect(actions.showBranchHistory).not.toHaveBeenCalled();
  });

  it("copies the branch name and disables `Compare with` on the base branch itself", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    seed();
    render(<BranchesView now={NOW} />);
    fireEvent.click(within(rowOf("main")).getByRole("button", { name: "More actions for main" }));
    const menu = screen.getByRole("menu", { name: "Actions for main" });
    expect(
      (within(menu).getByRole("menuitem", { name: "Compare with main" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy name" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("main"));
  });

  it("closes the menu on Escape", () => {
    seed();
    render(<BranchesView now={NOW} />);
    fireEvent.click(within(rowOf("main")).getByRole("button", { name: "More actions for main" }));
    expect(screen.queryByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("BranchesView tags table (Design §14.6)", () => {
  function openTags() {
    fireEvent.click(screen.getByRole("button", { name: "Tags" }));
  }

  it("lists every tag with its kind, message, tagger and age", () => {
    seed();
    render(<BranchesView now={NOW} />);
    openTags();
    expect(screen.getByRole("grid", { name: "Tags" })).toBeTruthy();
    expect(bodyRows().map((r) => r.getAttribute("data-tag"))).toEqual([
      "v1.0.0",
      "v0.3.0",
      "v0.2.0",
      "v0.1.0",
    ]);
    const annotated = document.querySelector('[data-tag="v1.0.0"]') as HTMLElement;
    expect(annotated.textContent).toContain("annotated");
    expect(annotated.textContent).toContain("annotated release 1.0.0");
    expect(annotated.textContent).toContain("test");
    const light = document.querySelector('[data-tag="v0.1.0"]') as HTMLElement;
    expect(light.textContent).toContain("lightweight");
    expect(within(light).getByTitle(/lightweight tag has no date of its own/).textContent).toBe(
      "—",
    );
  });

  it("compares a tag with the previous one, and says the oldest has none", () => {
    const actions = seed();
    render(<BranchesView now={NOW} />);
    openTags();
    fireEvent.click(screen.getByRole("button", { name: "Compare with v0.3.0" }));
    expect(actions.compareTags).toHaveBeenCalledWith(
      expect.objectContaining({ name: "v0.3.0" }),
      expect.objectContaining({ name: "v1.0.0" }),
    );
    const oldest = screen.getByRole("button", { name: "Compare with previous tag" });
    expect((oldest as HTMLButtonElement).disabled).toBe(true);
    // Enter on a row does the same thing as its button
    fireEvent.keyDown(document.querySelector('[data-tag="v0.2.0"]') as HTMLElement, {
      key: "Enter",
    });
    expect(actions.compareTags).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "v0.1.0" }),
      expect.objectContaining({ name: "v0.2.0" }),
    );
  });

  it("searches the tags too", () => {
    seed();
    render(<BranchesView now={NOW} />);
    openTags();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search branches and tags" }), {
      target: { value: "v0.2" },
    });
    expect(bodyRows().map((r) => r.getAttribute("data-tag"))).toEqual(["v0.2.0"]);
  });

  it("says so when the repository has no tags that name a commit", () => {
    seed({ tags: [] });
    render(<BranchesView now={NOW} />);
    openTags();
    expect(screen.getByText("This repository has no tags that name a commit.")).toBeTruthy();
  });
});

describe("Branches mode chrome (Design §14.1)", () => {
  it("replaces the StatsRow with the page's own header instead of drawing both", () => {
    seed({ mode: "files" });
    const view = render(<TopBar />);
    expect(screen.getByText(/files changed/)).toBeTruthy();
    view.unmount();
    seed();
    render(<TopBar />);
    expect(screen.queryByText(/files changed/)).toBeNull();
    // and nothing was added to row 1: the ModeSwitch is still the only v2 control there
    expect(screen.getByRole("button", { name: "Branches" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});

describe("BranchesView states", () => {
  it("asks for the overview and the tags once per repository", async () => {
    const actions = seed({}, { rows: null });
    const view = render(<BranchesView now={NOW} />);
    await waitFor(() => expect(actions.loadBranches).toHaveBeenCalledTimes(1));
    expect(actions.loadPickerSources).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("Reading the branches");
    view.rerender(<BranchesView now={NOW} />);
    expect(actions.loadBranches).toHaveBeenCalledTimes(1);
  });

  it("shows `HISTORY_DEGRADED` once, inline, when a tip could not be read", () => {
    const broken = rows.map((r) => (r.ref.name === "topic" ? { ...r, lastCommit: null } : r));
    seed({}, { rows: broken });
    render(<BranchesView now={NOW} />);
    const lines = screen.getAllByText(/Part of the history could not be read/);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.parentElement?.textContent).toContain("1 branch has no last commit.");
    // and the row itself says so rather than pretending the branch is old
    expect(
      within(rowOf("topic")).getByTitle("The commit topic points at could not be read."),
    ).toBeTruthy();
  });

  it("reports a failed overview as a Notice instead of an empty table", () => {
    seed({}, { rows: null, error: { code: "IO_ERROR", message: "EIO" } });
    render(<BranchesView now={NOW} />);
    expect(screen.getByText(/Couldn’t list the branches/)).toBeTruthy();
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("is axe-clean in both themes, with branches and with tags", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      seed();
      const { container } = render(<BranchesView now={NOW} />);
      for (const table of ["Branches", "Tags"]) {
        if (table === "Tags") fireEvent.click(screen.getByRole("button", { name: "Tags" }));
        const results = await axe.run(container, {
          rules: { "color-contrast": { enabled: false } },
        });
        expect(
          results.violations.map((v) => v.id),
          `${theme} / ${table}`,
        ).toEqual([]);
      }
      cleanup();
    }
  });
});
