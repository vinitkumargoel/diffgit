import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeLayer, DiffResult, FileDiff, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import basic from "../../test/recorded/showcase.repoinfo.json";
import { Lru } from "../lru";
import { onScrollRequest } from "../scrollBus";
import { DEFAULT_PREFS, type FileDiffEntry, type StoreState, useStore } from "../store";
import RepoScreen from "./RepoScreen";
import { notCountedTitle, StatsRow, toggleFilterToken } from "./StatsRow";

// cmdk / react-virtual need these in happy-dom.
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
const recorded = basicDiff as unknown as DiffResult;
const initial = useStore.getState();

const byId = (id: string): FileDiff => {
  const f = recorded.files.find((x) => x.id === id);
  if (!f) throw new Error(`no recorded file ${id}`);
  return f;
};
const layered = (id: string, layers: ChangeLayer[]): FileDiff => ({ ...byId(id), layers });

/** M / A / D / R, one of each layer, every file counted: the S1 "ready" row. */
const READY: FileDiff[] = [
  layered("docs/guide.md", ["staged"]),
  layered("src/new.txt", ["untracked"]),
  layered("src/b.txt", ["unstaged"]),
  layered("lib/util.ts", ["committed"]),
];

function diffOf(files: FileDiff[]): DiffResult {
  return { ...recorded, files, totals: { files: files.length, additions: 0, deletions: 0 } };
}

const actions = () => ({
  setFilter: vi.fn(),
  setPref: vi.fn(),
  setActiveFile: vi.fn(),
  requestRefresh: vi.fn(),
  loadFileDiff: vi.fn(async () => {}),
  cancelFileDiff: vi.fn(),
  prioritise: vi.fn(),
  toggleViewed: vi.fn(),
  setCollapsed: vi.fn(),
  swapBranches: vi.fn(),
});
type Actions = ReturnType<typeof actions>;

function seed(overrides: Partial<StoreState> = {}): Actions {
  const a = actions();
  useStore.setState(
    {
      ...initial,
      screen: "repo",
      repo,
      repoId: "r1",
      handle: { name: "showcase" },
      diffSource: {
        kind: "branches",
        source: "feature",
        target: "main",
        sourceRef: "refs/heads/feature",
        targetRef: "refs/heads/main",
        includeWorktree: true,
      },
      diff: diffOf(READY),
      stats: {},
      statsLastAt: null,
      viewed: new Set(),
      collapsed: new Set(),
      filter: "",
      prefs: DEFAULT_PREFS,
      fileDiffs: new Lru<string, FileDiffEntry>(200),
      refresh: { mode: "manual", lastAt: null, busy: false, lastError: null, restarted: false },
      ...a,
      ...overrides,
    },
    true,
  );
  return a;
}

function snapshotBothThemes(name: string, node: ReactNode) {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const { container } = render(node);
    expect(container.firstChild).toMatchSnapshot(`${name} (${theme})`);
    cleanup();
  }
  document.documentElement.classList.remove("dark");
}

const countText = () => screen.getByText(/files changed|match/).textContent;

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useStore.setState(initial, true);
});

describe("filter-token helpers", () => {
  it("toggleFilterToken adds, removes and keeps the rest of the query", () => {
    expect(toggleFilterToken("", "status:M")).toBe("status:M");
    expect(toggleFilterToken("src/", "status:M")).toBe("src/ status:M");
    expect(toggleFilterToken("src/ status:M", "status:M")).toBe("src/");
    expect(toggleFilterToken("STATUS:m layer:staged", "status:M")).toBe("layer:staged");
  });

  it("notCountedTitle omits the zero parts", () => {
    expect(notCountedTitle({ tooLarge: 2, binary: 3, failed: 1 })).toBe(
      "2 files over 1 MB, 3 binary, 1 read error",
    );
    expect(notCountedTitle({ tooLarge: 0, binary: 3, failed: 0 })).toBe("3 binary");
    expect(notCountedTitle({ tooLarge: 1, binary: 0, failed: 2 })).toBe(
      "1 file over 1 MB, 2 read errors",
    );
  });
});

describe("S1 ready", () => {
  it("prints the count, totals, both breakdowns and the viewed counter", () => {
    seed();
    render(<StatsRow />);
    expect(countText()).toBe("4 files changed");
    expect(screen.getByText("+5")).toBeTruthy();
    expect(screen.getByText("−7")).toBeTruthy();
    // no streaming / stalled / refreshing markers when every file is counted
    expect(screen.queryByLabelText("Counting changes")).toBeNull();
    expect(screen.queryByText(/^stats /)).toBeNull();
    expect(screen.queryByText("updating")).toBeNull();

    expect(screen.getByTitle("1 modified, 1 added, 1 deleted, 1 renamed").textContent).toBe(
      "M1A1D1R1",
    );
    expect(screen.getByTitle("1 staged, 1 unstaged, 1 untracked").textContent).toBe(
      "staged1unstaged1untracked1",
    );
    expect(screen.getByTestId("viewed-count").textContent).toBe("0 / 4 viewed");
    expect(screen.getByRole("progressbar", { name: "Files viewed" })).toBeTruthy();
  });

  it("folds both breakdowns into the file-count tooltip for narrow viewports", () => {
    seed();
    render(<StatsRow />);
    const count = screen.getByText(/files changed/);
    expect(count.getAttribute("title")).toBe(
      "1 modified, 1 added, 1 deleted, 1 renamed · 1 staged, 1 unstaged, 1 untracked",
    );
    // the groups themselves are hidden below 1100 px
    expect(screen.getByTitle("1 modified, 1 added, 1 deleted, 1 renamed").className).toContain(
      "min-[1100px]:inline-flex",
    );
  });

  it("snapshots both themes", () => {
    seed();
    snapshotBothThemes("S1 ready", <StatsRow />);
  });

  it("has no serious axe violations", async () => {
    seed();
    const { container } = render(<StatsRow />);
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
      resultTypes: ["violations"],
    });
    expect(
      result.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => v.id),
    ).toEqual([]);
  });
});

describe("breakdown toggles", () => {
  it("a status square writes and clears its `status:` token, keeping the rest", () => {
    const a = seed();
    render(<StatsRow />);
    const m = screen.getByRole("button", { name: "Filter: modified (1)" });
    expect(m.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(m);
    expect(a.setFilter).toHaveBeenCalledWith("status:M");
    cleanup();

    const b = seed({ filter: "docs/ status:M" });
    render(<StatsRow />);
    const pressed = screen.getByRole("button", { name: /^Filter: modified/ });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(b.setFilter).toHaveBeenCalledWith("docs/");
  });

  it("a layer chip writes and clears its `layer:` token", () => {
    const a = seed();
    render(<StatsRow />);
    const staged = screen.getByRole("button", { name: "Filter: staged (1)" });
    expect(staged.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(staged);
    expect(a.setFilter).toHaveBeenCalledWith("layer:staged");
    cleanup();

    const b = seed({ filter: "layer:staged" });
    render(<StatsRow />);
    const on = screen.getByRole("button", { name: /^Filter: staged/ });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(on);
    expect(b.setFilter).toHaveBeenCalledWith("");
  });
});

describe("S2 streaming", () => {
  it("replaces the totals with skeletons and counts the stream", () => {
    const pending = READY.map((f) =>
      f.id === "src/b.txt" || f.id === "lib/util.ts" ? { ...f, stats: null } : f,
    );
    seed({ diff: diffOf(pending) });
    render(<StatsRow />);
    expect(countText()).toBe("4 files changed");
    expect(screen.getByLabelText("Counting changes")).toBeTruthy();
    expect(screen.getByText("stats 2 / 4")).toBeTruthy();
    // never a partial total dressed up as final
    expect(screen.queryByText(/^\+/)).toBeNull();
    // the status breakdown is exact from the tree diff and still shown
    expect(screen.getByTitle("1 modified, 1 added, 1 deleted, 1 renamed")).toBeTruthy();
  });
});

describe("S3 partial", () => {
  const partial = () => [
    ...READY,
    byId("assets/logo.png"),
    byId("data/blob.bin"),
    byId("src/big-change.txt"),
  ];

  it("counts what could not be counted and says why", () => {
    seed({ diff: diffOf(partial()) });
    render(<StatsRow />);
    const warn = screen.getByRole("button", { name: "3 not counted" });
    expect(warn.closest("[title]")?.getAttribute("title")).toBe("1 file over 1 MB, 2 binary");
  });

  it("the link jumps to the first uncounted file", () => {
    const a = seed({ diff: diffOf(partial()) });
    const scrolled: string[] = [];
    const off = onScrollRequest((id) => scrolled.push(id));
    render(<StatsRow />);
    fireEvent.click(screen.getByRole("button", { name: "3 not counted" }));
    expect(a.setActiveFile).toHaveBeenCalledWith("assets/logo.png");
    expect(scrolled).toEqual(["assets/logo.png"]);
    off();
  });

  it("counts a failed file read as not counted", () => {
    const lru = new Lru<string, FileDiffEntry>(200);
    lru.set("docs/guide.md|x", { status: "error", error: { code: "IO_ERROR", message: "boom" } });
    seed({ diff: diffOf(partial()), fileDiffs: lru });
    render(<StatsRow />);
    const warn = screen.getByRole("button", { name: "4 not counted" });
    expect(warn.closest("[title]")?.getAttribute("title")).toBe(
      "1 file over 1 MB, 2 binary, 1 read error",
    );
  });

  it("snapshots both themes", () => {
    seed({ diff: diffOf(partial()) });
    snapshotBothThemes("S3 partial", <StatsRow />);
  });
});

describe("S4 refreshing", () => {
  it("dims the numbers and says `updating`, never flashing to zero", () => {
    seed({
      refresh: { mode: "live", lastAt: null, busy: true, lastError: null, restarted: false },
    });
    render(<StatsRow />);
    expect(screen.getByText("updating")).toBeTruthy();
    expect(screen.getByText("+5")).toBeTruthy();
    expect(screen.getByText(/files changed/).className).toContain("opacity-55");
    expect(screen.getByTitle("1 modified, 1 added, 1 deleted, 1 renamed").className).toContain(
      "opacity-55",
    );
  });
});

describe("S5 filtered", () => {
  it("counts the match, keeps the whole-diff totals in the tooltip and rings the input", () => {
    seed({ filter: "status:M" });
    render(<StatsRow />);
    expect(countText()).toBe("1 of 4 match");
    expect(screen.getByText(/match/).getAttribute("title")).toContain("4 files · +5 −7 in total");
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByTestId("viewed-count").textContent).toBe("0 / 1 viewed");
    const input = screen.getByRole("searchbox", { name: "Filter files" });
    expect(input.parentElement?.className).toContain("ring-accent");
  });
});

describe("S6 filter matches nothing", () => {
  it("RepoScreen swaps the tree + pane for the FilterEmptyState", () => {
    const a = seed({ filter: "payments/" });
    render(<RepoScreen />);
    const region = screen.getByRole("region", { name: "No files match" });
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("No files match payments/");
    expect(screen.getByText(/files changed in this diff/).textContent).toBe(
      "4 files changed in this diff. Filters match on path, status:M and layer:staged.",
    );
    expect(screen.getByText(/of 4 match/).textContent).toBe("0 of 4 match");
    fireEvent.click(within(region).getByRole("button", { name: "Clear filter" }));
    expect(a.setFilter).toHaveBeenCalledWith("");
  });

  it("Escape clears the filter from anywhere on the screen", () => {
    const a = seed({ filter: "payments/" });
    render(<RepoScreen />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(a.setFilter).toHaveBeenCalledWith("");
  });
});

describe("S7 no changes", () => {
  it("keeps row 2 with +0 −0, `nothing to view` and disabled controls", () => {
    seed({ diff: diffOf([]) });
    render(<StatsRow />);
    expect(countText()).toBe("0 files changed");
    expect(screen.getByText("+0")).toBeTruthy();
    expect(screen.getByText("−0")).toBeTruthy();
    expect(screen.getByText("nothing to view")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(
      (screen.getByRole("searchbox", { name: "Filter files" }) as HTMLInputElement).disabled,
    ).toBe(true);
    // the view controls are inert (out of the tab order) and at 50 %
    const controls = screen.getByText("Unified").closest("div[inert]");
    expect(controls).toBeTruthy();
    expect(controls?.className).toContain("opacity-50");
  });

  it("the EmptyState names the base, the merge-base rule and can swap", () => {
    const a = seed({ diff: diffOf([]) });
    render(<RepoScreen />);
    expect(screen.getByRole("region", { name: "No changes" })).toBeTruthy();
    expect(screen.getByRole("heading").textContent).toBe("No changes between feature and main");
    expect(screen.getByText("Working tree is clean.")).toBeTruthy();
    expect(screen.getByText(/after the merge base/).textContent).toBe(
      "Commits on main after the merge base are not shown by design.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Swap ⇄" }));
    expect(a.swapBranches).toHaveBeenCalledTimes(1);
  });
});

describe("S8 stalled", () => {
  it("dims the partial totals after 10 s and offers a forced re-count", () => {
    vi.useFakeTimers();
    try {
      const pending = READY.map((f) =>
        f.id === "src/b.txt" || f.id === "lib/util.ts" ? { ...f, stats: null } : f,
      );
      const a = seed({ diff: diffOf(pending), statsLastAt: Date.now() });
      render(<StatsRow />);
      expect(screen.getByText("stats 2 / 4")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(11_000);
      });
      expect(screen.queryByText("stats 2 / 4")).toBeNull();
      expect(screen.getByText(/stats stopped at 2 \/ 4/)).toBeTruthy();
      // the partial totals come back, dimmed
      expect(screen.getByText("+3").parentElement?.className).toContain("opacity-55");
      fireEvent.click(screen.getByRole("button", { name: "re-count" }));
      expect(a.requestRefresh).toHaveBeenCalledWith("force");
    } finally {
      vi.useRealTimers();
    }
  });
});
