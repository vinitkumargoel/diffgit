import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, RepoInfo, RepoRef } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import basic from "../../test/recorded/showcase.repoinfo.json";
import { DEFAULT_PREFS, type StoreState, useStore } from "../store";
import { TopBar } from "./TopBar";

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

const repo = basic as unknown as RepoInfo;
const diff = basicDiff as unknown as DiffResult;

const actions = () => ({
  setSource: vi.fn(),
  setTarget: vi.fn(),
  swapBranches: vi.fn(),
  setIncludeWorktree: vi.fn(),
  setFilter: vi.fn(),
  setPref: vi.fn(),
  recompute: vi.fn(async () => {}),
});
type Actions = ReturnType<typeof actions>;

function seed(overrides: Partial<StoreState> = {}): Actions {
  const a = actions();
  useStore.setState({
    screen: "repo",
    repo,
    repoId: "r1",
    diffSource: {
      kind: "branches",
      source: "feature",
      target: "main",
      sourceRef: "refs/heads/feature",
      targetRef: "refs/heads/main",
      includeWorktree: true,
    },
    diff,
    stats: {},
    viewed: new Set(),
    filter: "",
    prefs: DEFAULT_PREFS,
    refresh: { mode: "manual", lastAt: null, busy: false, lastError: null, restarted: false },
    ...a,
    ...overrides,
  });
  return a;
}

const firstArg = (fn: { mock: { calls: unknown[][] } }): RepoRef | undefined =>
  fn.mock.calls[0]?.[0] as RepoRef | undefined;

const baseTrigger = () => screen.getByRole("button", { name: /^base branch:/ });
const compareTrigger = () => screen.getByRole("button", { name: /^compare branch:/ });

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
});

describe("TopBar row 1", () => {
  it("shows base/compare triggers with default and HEAD badges, repo name and summary", () => {
    seed();
    render(<TopBar />);
    expect(screen.getByText("basic")).toBeTruthy();
    expect(baseTrigger().textContent).toContain("main");
    expect(baseTrigger().textContent).toContain("default");
    expect(compareTrigger().textContent).toContain("feature");
    expect(compareTrigger().textContent).toContain("HEAD");
    // Row 2 (StatsRow): the count is `<b>12</b> files changed`, so the number is its own node.
    const count = screen.getByText(/files changed/);
    expect(count.textContent).toBe("12 files changed");
    expect(screen.getByTestId("viewed-count").textContent).toBe("0 / 12 viewed");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  it("v2 adds exactly two controls: ModeSwitch after the repo name, palette before the theme (Design §14.1)", () => {
    seed();
    const { container } = render(<TopBar />);
    const row1 = container.querySelector("header > div") as HTMLElement;
    const children = [...row1.children];
    // the repo name is first, the ModeSwitch immediately after it
    expect(children[0]?.textContent).toBe("basic");
    expect(children[1]?.tagName).toBe("FIELDSET");
    expect(children[1]?.getAttribute("aria-label")).toBe("View");
    // and the last three controls are help, palette, theme — nothing else moved
    const buttons = [...row1.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(buttons.slice(-3)).toEqual([
      "Keyboard shortcuts",
      "Command palette",
      "Switch to light theme",
    ]);
  });

  it("opens the base picker grouped Local / Remote: origin and selecting calls setTarget", async () => {
    const a = seed();
    render(<TopBar />);
    fireEvent.click(baseTrigger());
    const input = screen.getByPlaceholderText("Find a branch…");
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("Local")).toBeTruthy();
    expect(screen.getByText("Remote: origin")).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "featureHEAD",
      "maindefault",
      "topic",
      "origin/featureremote",
      "origin/mainremote",
    ]);
    fireEvent.click(screen.getByText("topic"));
    expect(a.setTarget).toHaveBeenCalledTimes(1);
    expect(firstArg(a.setTarget)?.fullName).toBe("refs/heads/topic");
    await waitFor(() => expect(screen.queryByPlaceholderText("Find a branch…")).toBeNull());
    expect(document.activeElement).toBe(baseTrigger());
  });

  it("filters as you type, Enter selects the highlighted row, Esc closes", async () => {
    const a = seed();
    render(<TopBar />);
    fireEvent.click(compareTrigger());
    const input = screen.getByPlaceholderText("Find a branch…");
    fireEvent.change(input, { target: { value: "origin" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][data-selected="true"]')).toBeTruthy(),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(a.setSource).toHaveBeenCalledTimes(1);
    expect(firstArg(a.setSource)?.kind).toBe("remote");

    fireEvent.click(compareTrigger());
    fireEvent.keyDown(screen.getByPlaceholderText("Find a branch…"), { key: "Escape" });
    expect(screen.queryByPlaceholderText("Find a branch…")).toBeNull();
    expect(document.activeElement).toBe(compareTrigger());
  });

  it("pins the synthetic HEAD entry first and selecting it sets sourceRef HEAD", () => {
    const synthetic: RepoRef = {
      name: "HEAD (detached @ 3f9a1c2)",
      fullName: "HEAD",
      kind: "local",
      oid: "3f9a1c2".padEnd(40, "0"),
      isDefault: false,
      isCheckedOut: true,
      synthetic: true,
    };
    const detached: RepoInfo = {
      ...repo,
      headBranch: null,
      detached: true,
      headDisplay: synthetic.name,
      refs: [synthetic, ...repo.refs.map((r) => ({ ...r, isCheckedOut: false }))],
    };
    const a = seed({
      repo: detached,
      diffSource: {
        kind: "branches",
        source: synthetic.name,
        target: "main",
        sourceRef: "HEAD",
        targetRef: "refs/heads/main",
        includeWorktree: true,
      },
    });
    render(<TopBar />);
    expect(compareTrigger().textContent).toContain("HEAD (detached @ 3f9a1c2)");
    fireEvent.click(compareTrigger());
    const first = screen.getAllByRole("option")[0];
    expect(first?.textContent).toContain("HEAD (detached @ 3f9a1c2)");
    fireEvent.click(first as HTMLElement);
    expect(firstArg(a.setSource)?.fullName).toBe("HEAD");
  });

  it("disables the swap button when base === compare, otherwise swaps", () => {
    const a = seed({
      diffSource: {
        kind: "branches",
        source: "main",
        target: "main",
        sourceRef: "refs/heads/main",
        targetRef: "refs/heads/main",
        includeWorktree: false,
      },
    });
    render(<TopBar />);
    const swap = screen.getByRole("button", { name: "Swap base and compare" }) as HTMLButtonElement;
    expect(swap.disabled).toBe(true);
    cleanup();
    seed();
    render(<TopBar />);
    const swap2 = screen.getByRole("button", {
      name: "Swap base and compare",
    }) as HTMLButtonElement;
    expect(swap2.disabled).toBe(false);
    fireEvent.click(swap2);
    expect(a.swapBranches).not.toHaveBeenCalled(); // first seed's mock
    expect(useStore.getState().swapBranches).toHaveBeenCalledTimes(1);
  });

  it("include-uncommitted is enabled only when compare is the checked-out branch", () => {
    const a = seed();
    render(<TopBar />);
    const box = screen.getByRole("checkbox", {
      name: /Include uncommitted changes/,
    }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(a.setIncludeWorktree).toHaveBeenCalledWith(false);
    cleanup();

    seed({
      diffSource: {
        kind: "branches",
        source: "main",
        target: "topic",
        sourceRef: "refs/heads/main",
        targetRef: "refs/heads/topic",
        includeWorktree: true,
      },
    });
    render(<TopBar />);
    const box2 = screen.getByRole("checkbox", {
      name: /Include uncommitted changes/,
    }) as HTMLInputElement;
    expect(box2.disabled).toBe(true);
    expect(box2.checked).toBe(false);
    expect(box2.closest("label")?.getAttribute("title")).toBe(
      "Only available when the source is the checked-out branch (feature)",
    );
  });

  it("refresh control shows the mode word, last-refreshed tooltip and triggers recompute", () => {
    const now = Date.now();
    const a = seed({
      refresh: {
        mode: "manual",
        lastAt: now - 12_000,
        busy: false,
        lastError: null,
        restarted: false,
      },
    });
    render(<TopBar />);
    const btn = screen.getByRole("button", { name: /^Refresh \(Manual\)/ }) as HTMLButtonElement;
    expect(btn.textContent).toContain("Manual");
    expect(btn.getAttribute("title")).toMatch(/^Last refreshed 1[23] s ago\. Force refresh/);
    fireEvent.click(btn);
    expect(a.recompute).toHaveBeenCalledWith("manual");
    cleanup();
    seed({
      refresh: { mode: "live", lastAt: null, busy: true, lastError: null, restarted: false },
    });
    render(<TopBar />);
    const busy = screen.getByRole("button", { name: /^Refresh \(Live\)/ }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("title")).toMatch(/^Not refreshed yet\. Force refresh/);
    expect(busy.textContent).toContain("Live");
  });

  it('force refresh (T6.4): Shift+click, long-press and Shift+R dispatch "force"; phase shows while busy', () => {
    vi.useFakeTimers();
    try {
      const a = seed({
        refresh: { mode: "manual", lastAt: null, busy: false, lastError: null, restarted: false },
      });
      render(<TopBar />);
      const btn = screen.getByRole("button", { name: /^Refresh \(Manual\)/ }) as HTMLButtonElement;
      expect(btn.getAttribute("title")).toContain("Shift+click, hold, or Shift+R");
      fireEvent.click(btn, { shiftKey: true });
      expect(a.recompute).toHaveBeenLastCalledWith("force");
      fireEvent.click(btn);
      expect(a.recompute).toHaveBeenLastCalledWith("manual");
      // long-press: pointerdown, hold 600 ms → force; the release click is swallowed
      a.recompute.mockClear();
      fireEvent.pointerDown(btn, { button: 0 });
      vi.advanceTimersByTime(599);
      expect(a.recompute).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(a.recompute).toHaveBeenCalledWith("force");
      fireEvent.pointerUp(btn);
      fireEvent.click(btn);
      expect(a.recompute).toHaveBeenCalledTimes(1);
      // a short press cancels the timer
      fireEvent.pointerDown(btn, { button: 0 });
      vi.advanceTimersByTime(100);
      fireEvent.pointerUp(btn);
      vi.advanceTimersByTime(1000);
      expect(a.recompute).toHaveBeenCalledTimes(1);
      cleanup();
      seed({
        refresh: {
          mode: "live",
          lastAt: null,
          busy: true,
          lastError: null,
          restarted: false,
          phase: "worktree",
        },
      });
      render(<TopBar />);
      const busy = screen.getByRole("button", { name: /^Refresh \(Live\)/ }) as HTMLButtonElement;
      expect(busy.textContent).toContain("Scanning working tree…");
      expect(busy.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TopBar row 2", () => {
  it("`/` focuses the filter, typing calls setFilter, clear resets it", () => {
    const a = seed();
    render(<TopBar />);
    const input = screen.getByRole("searchbox", { name: "Filter files" }) as HTMLInputElement;
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "src" } });
    expect(a.setFilter).toHaveBeenCalledWith("src");
    cleanup();
    const b = seed({ filter: "src" });
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(b.setFilter).toHaveBeenCalledWith("");
  });

  it("`/` typed inside another field does not steal focus", () => {
    seed();
    render(
      <div>
        <input aria-label="other" />
        <TopBar />
      </div>,
    );
    const other = screen.getByRole("textbox", { name: "other" });
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
  });

  it("segmented control and whitespace toggle write prefs", () => {
    const a = seed();
    render(<TopBar />);
    const unified = screen.getByRole("button", { name: "Unified" });
    const split = screen.getByRole("button", { name: "Split" });
    expect(unified.getAttribute("aria-pressed")).toBe("true");
    expect(split.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(split);
    expect(a.setPref).toHaveBeenCalledWith("viewMode", "split");
    const ws = screen.getByRole("button", { name: "Ignore whitespace" });
    expect(ws.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(ws);
    expect(a.setPref).toHaveBeenCalledWith("ignoreWhitespace", true);
  });

  it("theme toggle flips between dark and light", () => {
    const a = seed({ prefs: { ...DEFAULT_PREFS, theme: "light" } });
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(a.setPref).toHaveBeenCalledWith("theme", "dark");
  });
});
