import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiffResult,
  RepoInfo,
  RepoRef,
  ResolvedRevision,
  StashInfo,
  TagInfo,
} from "../../engine/types";
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
  // T11.2: the pickers put a resolved revision on one side; setSource/setTarget delegate to this.
  setRevision: vi.fn(),
  setSpecialSource: vi.fn(),
  setTwoDot: vi.fn(),
  loadPickerSources: vi.fn(async () => {}),
  resolveRevision: vi.fn(
    async (expr: string): Promise<ResolvedRevision> => ({
      expr,
      oid: "a".repeat(40),
      kind: "commit",
      display: expr,
    }),
  ),
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

/** The revision the picker handed `setRevision`, and which side it was for. */
const picked = (fn: { mock: { calls: unknown[][] } }, i = 0) => ({
  rev: fn.mock.calls[i]?.[0] as ResolvedRevision | undefined,
  side: fn.mock.calls[i]?.[1] as string | undefined,
});

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
    expect(a.setRevision).toHaveBeenCalledTimes(1);
    expect(picked(a.setRevision)).toMatchObject({
      rev: { fullRef: "refs/heads/topic", kind: "branch", display: "topic" },
      side: "target",
    });
    await waitFor(() => expect(screen.queryByPlaceholderText("Find a branch…")).toBeNull());
    expect(document.activeElement).toBe(baseTrigger());
  });

  it("filters as you type, Enter selects the highlighted row, Esc closes", async () => {
    const a = seed();
    render(<TopBar />);
    fireEvent.click(compareTrigger());
    const input = screen.getByPlaceholderText("Find a branch…");
    fireEvent.change(input, { target: { value: "origin" } });
    // the two origin/* branches plus the force-mounted "Use origin" row (T11.2)
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][data-selected="true"]')).toBeTruthy(),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(a.setRevision).toHaveBeenCalledTimes(1);
    expect(picked(a.setRevision)).toMatchObject({ rev: { kind: "remote" }, side: "source" });

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
    expect(picked(a.setRevision).rev?.fullRef).toBe("HEAD");
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

// ---------------------------------------------------------------- T11.2 pickers
const TAGS: TagInfo[] = [
  {
    name: "v0.1.0",
    fullName: "refs/tags/v0.1.0",
    oid: "1".repeat(40),
    targetOid: "1".repeat(40),
    annotated: false,
  },
  {
    name: "v1.0.0",
    fullName: "refs/tags/v1.0.0",
    oid: "2".repeat(40),
    targetOid: "3".repeat(40),
    annotated: true,
    message: "release",
    timestamp: 1704067200000,
  },
];
const STASHES: StashInfo[] = [
  {
    index: 0,
    expr: "stash@{0}",
    oid: "4".repeat(40),
    message: "On main: wip: with untracked",
    timestamp: Date.now() - 3600_000,
    baseOid: "5".repeat(40),
    indexOid: "6".repeat(40),
    untrackedOid: "7".repeat(40),
    files: 3,
  },
  {
    index: 1,
    expr: "stash@{1}",
    oid: "8".repeat(40),
    message: "On main: wip: tracked only",
    timestamp: Date.now() - 9 * 86400_000,
    baseOid: "5".repeat(40),
    indexOid: "6".repeat(40),
    untrackedOid: null,
    files: 1,
  },
];

describe("TopBar row 1 — compare anything (T11.2, Design §14.1)", () => {
  it("adds Tags / Stashes / Special groups with counts, loaded lazily on first open", () => {
    const a = seed({ tags: null, stashes: null });
    const { rerender } = render(<TopBar />);
    fireEvent.click(compareTrigger());
    expect(a.loadPickerSources).toHaveBeenCalledTimes(1);
    // nothing listed yet: only the branch groups plus Special (compare picker only)
    expect(screen.queryByText(/^Tags · /)).toBeNull();
    expect(screen.getByText("Special")).toBeTruthy();

    useStore.setState({ tags: TAGS, stashes: STASHES });
    rerender(<TopBar />);
    expect(screen.getByText("Tags · 2")).toBeTruthy();
    expect(screen.getByText("Stashes · 2")).toBeTruthy();
    expect(screen.getByText("On main: wip: with untracked")).toBeTruthy();
    expect(screen.getByText("3 files · 1 h ago")).toBeTruthy();
    // and the base picker has no Special group
    fireEvent.keyDown(screen.getByPlaceholderText("Find a branch…"), { key: "Escape" });
    fireEvent.click(baseTrigger());
    expect(screen.queryByText("Special")).toBeNull();
    expect(screen.getByText("Tags · 2")).toBeTruthy();
  });

  it("picking a tag or a stash hands setRevision a resolved revision for that side", () => {
    const a = seed({ tags: TAGS, stashes: STASHES });
    render(<TopBar />);
    fireEvent.click(baseTrigger());
    fireEvent.click(screen.getByText("v1.0.0"));
    expect(picked(a.setRevision)).toMatchObject({
      rev: { kind: "tag", display: "v1.0.0", oid: "3".repeat(40), peeledFrom: "2".repeat(40) },
      side: "target",
    });
    cleanup();

    const b = seed({ tags: TAGS, stashes: STASHES });
    render(<TopBar />);
    fireEvent.click(compareTrigger());
    fireEvent.click(screen.getByText("stash@{0}"));
    expect(picked(b.setRevision)).toMatchObject({
      rev: { kind: "stash", display: "stash@{0}", oid: "4".repeat(40) },
      side: "source",
    });
  });

  it("the Special rows ask the store for the working tree / staged-only comparison", () => {
    const a = seed({ tags: TAGS, stashes: STASHES });
    render(<TopBar />);
    fireEvent.click(compareTrigger());
    fireEvent.click(screen.getByText("Staged only"));
    expect(a.setSpecialSource).toHaveBeenCalledWith("staged");
  });

  it("free text offers a Use row that resolves on Enter", async () => {
    const a = seed({ tags: TAGS, stashes: STASHES });
    render(<TopBar />);
    fireEvent.click(compareTrigger());
    const input = screen.getByPlaceholderText("Find a branch…");
    fireEvent.change(input, { target: { value: "HEAD~3" } });
    await waitFor(() => expect(screen.getByText("Use HEAD~3")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(a.resolveRevision).toHaveBeenCalledWith("HEAD~3"));
    await waitFor(() =>
      expect(picked(a.setRevision)).toMatchObject({
        rev: { expr: "HEAD~3", kind: "commit" },
        side: "source",
      }),
    );
    // an exact ref name is not offered twice
    cleanup();
    seed({ tags: TAGS, stashes: STASHES });
    render(<TopBar />);
    fireEvent.click(compareTrigger());
    fireEvent.change(screen.getByPlaceholderText("Find a branch…"), { target: { value: "topic" } });
    await waitFor(() => expect(screen.getByText("topic")).toBeTruthy());
    expect(screen.queryByText("Use topic")).toBeNull();
  });

  it("renders REV_NOT_FOUND / REV_AMBIGUOUS inline, with the candidates from `detail`", async () => {
    const a = seed({ tags: TAGS, stashes: STASHES });
    a.resolveRevision.mockRejectedValueOnce({
      code: "REV_NOT_FOUND",
      message: 'Cannot resolve "zzz".',
    });
    render(<TopBar />);
    fireEvent.click(compareTrigger());
    const input = screen.getByPlaceholderText("Find a branch…");
    fireEvent.change(input, { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("Use zzz")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('Cannot resolve "zzz".');
    expect(a.setRevision).not.toHaveBeenCalled();

    // REV_AMBIGUOUS: the candidate oids become buttons that resolve the full SHA
    a.resolveRevision.mockRejectedValueOnce({
      code: "REV_AMBIGUOUS",
      message: '"5772d43" matches 2 objects.',
      detail: `${"a".repeat(40)},${"b".repeat(40)}`,
    });
    fireEvent.change(input, { target: { value: "5772d43" } });
    await waitFor(() => expect(screen.getByText("Use 5772d43")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Enter" });
    const ambiguous = await screen.findByRole("alert");
    expect(ambiguous.textContent).toContain("matches 2 objects");
    const candidate = screen.getByRole("button", { name: "a".repeat(10) });
    fireEvent.click(candidate);
    await waitFor(() => expect(a.resolveRevision).toHaveBeenLastCalledWith("a".repeat(40)));
  });

  it("the footer holds the three-dot / two-dot toggle with a merge-base tooltip", () => {
    const a = seed({ tags: TAGS, stashes: STASHES });
    render(<TopBar />);
    fireEvent.click(compareTrigger());
    const three = screen.getByRole("button", { name: "three-dot …" });
    const two = screen.getByRole("button", { name: "two-dot .." });
    expect(three.getAttribute("aria-pressed")).toBe("true");
    expect(two.getAttribute("aria-pressed")).toBe("false");
    expect(three.getAttribute("title")).toContain("merge base");
    expect(two.getAttribute("title")).toContain("ignoring the merge base");
    fireEvent.click(two);
    expect(a.setTwoDot).toHaveBeenCalledWith(true);
  });

  it("a range source labels its trigger by noun and disables the worktree toggle off HEAD", () => {
    seed({
      tags: TAGS,
      stashes: STASHES,
      diffSource: {
        kind: "range",
        from: "v0.1.0",
        to: "stash@{0}",
        fromRef: "refs/tags/v0.1.0",
        toRef: "stash@{0}",
        fromOid: "1".repeat(40),
        toOid: "4".repeat(40),
        threeDot: true,
        includeWorktree: true,
      },
    });
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "base tag: v0.1.0" }).textContent).toContain("tag");
    expect(screen.getByRole("button", { name: "compare stash: stash@{0}" })).toBeTruthy();
    const box = screen.getByRole("checkbox", {
      name: /Include uncommitted changes/,
    }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    // and the StatsRow names what is being compared
    expect(screen.getByTestId("compare-label").textContent).toBe("v0.1.0 … stash@{0}");
  });
});
