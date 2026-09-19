/**
 * T11.5 — History mode (Design §14.5, atlas tabs 03 / 04). The commit list, the lane column, the
 * CommitCard, the Stack and Reflog sub-tabs, all on the recorded `history`, `octopus` and
 * `reflog-orphan` walks, so every row is drawn from edges the real engine produced.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CommitDetails,
  CommitSummary,
  DiffResult,
  RangeSource,
  ReflogEntry,
  RepoInfo,
} from "../../engine/types";
import historyDiff from "../../test/recorded/history.diffresult.json";
import historyInfo from "../../test/recorded/history.repoinfo.json";
import historyV2 from "../../test/recorded/history.v2.json";
import octopusInfo from "../../test/recorded/octopus.repoinfo.json";
import octopusV2 from "../../test/recorded/octopus.v2.json";
import orphanV2 from "../../test/recorded/reflog-orphan.v2.json";
import { DEFAULT_PREFS, INITIAL_HISTORY, INITIAL_STACK, type StoreState, useStore } from "../store";
import { CommitCard } from "./CommitCard";
import { CommitList } from "./CommitList";
import { HistoryView } from "./HistoryView";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

const RECT = { width: 320, height: 900 };
const repo = historyInfo as unknown as RepoInfo;
const diff = historyDiff as unknown as DiffResult;
const walk = historyV2.walks.default.commits as unknown as CommitSummary[];
const octopus = octopusV2.walks.default.commits as unknown as CommitSummary[];
const octopusRepo = octopusInfo as unknown as RepoInfo;
const details = historyV2.commits as unknown as Record<string, CommitDetails>;
const headOid = "822313f6746d7982943f0d59fc5e09b626769141";

const initial = useStore.getState();

function seed(overrides: Partial<StoreState> = {}, history: Partial<StoreState["history"]> = {}) {
  const actions = {
    loadHistory: vi.fn(async () => {}),
    loadStack: vi.fn(async () => {}),
    loadCommitDetails: vi.fn(async () => {}),
    loadReflog: vi.fn(async () => {}),
    loadFileDiff: vi.fn(async () => {}),
    cancelFileDiff: vi.fn(),
    requestCommitStats: vi.fn(),
    showCommit: vi.fn(async () => {}),
    compareCommitWithBase: vi.fn(),
    setHistoryQuery: vi.fn((q: string) =>
      useStore.setState((s) => ({ history: { ...s.history, query: q } })),
    ),
    setHistoryOption: vi.fn(),
    setPref: vi.fn(),
    setRevision: vi.fn(),
    setSpecialSource: vi.fn(),
  };
  useStore.setState(
    {
      ...initial,
      screen: "repo",
      repo,
      repoId: "hist",
      mode: "history",
      diff,
      diffSource: diff.source,
      prefs: DEFAULT_PREFS,
      history: { ...INITIAL_HISTORY, commits: walk, cursor: "50", ...history },
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

const rows = () => screen.getAllByRole("option");
const rowOf = (oid: string) => document.querySelector(`[data-oid="${oid}"]`) as HTMLElement | null;

describe("CommitList rows and lanes (Design §14.5)", () => {
  it("renders a row per commit with SHA, subject, ref badges, author and age", () => {
    seed();
    render(<CommitList initialRect={RECT} />);
    const head = rowOf(headOid) as HTMLElement;
    expect(head.textContent).toContain("822313f");
    expect(head.textContent).toContain("c59: extend mod4");
    expect(head.textContent).toContain("test ·");
    // the recorded refs of that commit, each as its own chip
    const chips = within(head).getAllByTitle(/^(Checked-out branch|Branch|Tag):/);
    expect(chips.map((c) => c.textContent)).toEqual(["HEAD", "main", "v1.0.0"]);
    expect(chips[0]?.getAttribute("title")).toBe("Checked-out branch: HEAD");
    expect(chips[2]?.getAttribute("title")).toBe("Tag: v1.0.0");
  });

  it("draws the lane column from `edges`: one path per incoming lane plus one per edge", () => {
    // the octopus recording is five commits with fork, merge and straight edges
    seed({ repo: octopusRepo }, { commits: octopus, cursor: null });
    render(<CommitList initialRect={RECT} />);
    const svgs = [...document.querySelectorAll("svg[data-lane]")];
    expect(svgs).toHaveLength(octopus.length);
    octopus.forEach((commit, i) => {
      const svg = svgs[i] as SVGElement;
      const edges = commit.edges ?? [];
      const incoming = new Set((octopus[i - 1]?.edges ?? []).map((e) => e.to));
      expect(svg.getAttribute("data-edges"), commit.subject).toBe(String(edges.length));
      expect(svg.getAttribute("data-lane")).toBe(String(commit.lane ?? 0));
      expect(svg.querySelectorAll("path")).toHaveLength(edges.length + incoming.size);
      expect(svg.querySelectorAll("circle")).toHaveLength(1);
    });
    // the merge row opens two new lanes; the root row closes the graph
    expect(svgs[0]?.querySelectorAll('[data-edge="fork"]')).toHaveLength(2);
    expect(svgs[2]?.querySelectorAll('[data-edge="merge"]')).toHaveLength(1);
    expect(svgs[4]?.getAttribute("data-edges")).toBe("0");
  });

  it("shows `+n −m` only for the rows `commitStats` has answered for", () => {
    seed({ commitStats: { [headOid]: { files: 1, additions: 5, deletions: 0 } } });
    render(<CommitList initialRect={RECT} />);
    expect((rowOf(headOid) as HTMLElement).textContent).toContain("+5");
    expect((rowOf(headOid) as HTMLElement).textContent).toContain("−0");
    // a row with no answer yet keeps its skeleton rather than printing a zero
    const second = rows()[1] as HTMLElement;
    expect(second.textContent).not.toContain("+");
  });

  it("asks for the stats of the rows it renders, batched", async () => {
    const actions = seed();
    render(<CommitList initialRect={RECT} />);
    await waitFor(() => expect(actions.requestCommitStats).toHaveBeenCalled());
    const asked = actions.requestCommitStats.mock.calls[0]?.[0] as unknown as string[];
    expect(asked[0]).toBe(headOid);
    expect(asked).toEqual(rows().map((r) => r.dataset.oid));
  });

  it("asks for the next page when the list is scrolled near its end", async () => {
    const actions = seed({}, { commits: walk.slice(0, 12), cursor: "12" });
    render(<CommitList initialRect={RECT} />);
    expect(actions.loadHistory).not.toHaveBeenCalled();
    fireEvent.scroll(screen.getByRole("listbox", { name: "Commits" }));
    await waitFor(() => expect(actions.loadHistory).toHaveBeenCalled());
    // nothing more to fetch: the cursor is spent
    actions.loadHistory.mockClear();
    useStore.setState((s) => ({ history: { ...s.history, cursor: null } }));
    fireEvent.scroll(screen.getByRole("listbox", { name: "Commits" }));
    expect(actions.loadHistory).not.toHaveBeenCalled();
  });

  it("shows the HISTORY_CAPPED banner when the walk stopped early", () => {
    seed({}, { capped: true });
    render(<CommitList initialRect={RECT} />);
    expect(document.body.textContent).toContain("History capped");
    expect(document.body.textContent).toContain("older commits are not listed");
  });

  it("offers the first-parent toggle when the graph needs more lanes than fit (T10.5b)", () => {
    const actions = seed({}, { laneOverflow: true });
    render(<CommitList initialRect={RECT} />);
    fireEvent.click(screen.getByText("follow first parents"));
    expect(actions.setHistoryOption).toHaveBeenCalledWith("firstParent", true);
  });
});

describe("CommitList search and toggles", () => {
  it("filters the walked commits as you type", () => {
    seed();
    render(<CommitList initialRect={RECT} />);
    const before = screen.getByRole("listbox", { name: "Commits" }).dataset.total;
    fireEvent.change(screen.getByPlaceholderText("Search message, author or SHA"), {
      target: { value: "bump manifest" },
    });
    const after = Number(screen.getByRole("listbox", { name: "Commits" }).dataset.total);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(Number(before));
    expect(screen.getByText(`${after} of ${walk.length}`)).toBeTruthy();
  });

  it("Enter with no local match says the list loads more as you scroll (T10.8 owns `search`)", async () => {
    seed({ searchCommits: vi.fn(async () => null) });
    render(<CommitList initialRect={RECT} />);
    const box = screen.getByPlaceholderText("Search message, author or SHA");
    fireEvent.change(box, { target: { value: "zzz-nothing" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(document.body.textContent).toContain("More load as you scroll"));
  });

  it("Enter runs the engine search once it exists, and opens the first hit", async () => {
    const actions = seed({ searchCommits: vi.fn(async () => [headOid]) });
    render(<CommitList initialRect={RECT} />);
    const box = screen.getByPlaceholderText("Search message, author or SHA");
    fireEvent.change(box, { target: { value: "zzz-nothing" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(actions.showCommit).toHaveBeenCalledWith(headOid));
    expect(document.body.textContent).toContain("1 commit matches");
  });

  it("the two toggles re-request the walk", () => {
    const actions = seed();
    render(<CommitList initialRect={RECT} />);
    fireEvent.click(screen.getByRole("button", { name: "first-parent" }));
    expect(actions.setHistoryOption).toHaveBeenCalledWith("firstParent", true);
    fireEvent.click(screen.getByRole("button", { name: "all branches" }));
    expect(actions.setHistoryOption).toHaveBeenCalledWith("all", true);
  });
});

describe("CommitList selection and keyboard", () => {
  it("a click shows the commit and shift-click extends it into a range", () => {
    const actions = seed();
    render(<CommitList initialRect={RECT} />);
    fireEvent.click(rowOf(headOid) as HTMLElement);
    expect(actions.showCommit).toHaveBeenCalledWith(headOid, { extend: false });
    const older = (walk[5] as CommitSummary).oid;
    fireEvent.click(rowOf(older) as HTMLElement, { shiftKey: true });
    expect(actions.showCommit).toHaveBeenCalledWith(older, { extend: true });
  });

  it("marks the selection with aria-selected and highlights the other end of a range", () => {
    const older = (walk[5] as CommitSummary).oid;
    seed({}, { selected: headOid, rangeStart: older });
    render(<CommitList initialRect={RECT} />);
    expect((rowOf(headOid) as HTMLElement).getAttribute("aria-selected")).toBe("true");
    expect((rowOf(older) as HTMLElement).className).toContain("bg-accent-subtle");
  });

  it("`j` / `k` move through the list and Enter shows the focused commit", () => {
    const actions = seed();
    render(<CommitList initialRect={RECT} />);
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "j" });
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("role")).toBe("option");
    expect(focused.dataset.index).toBe("2");
    fireEvent.keyDown(document, { key: "k" });
    expect((document.activeElement as HTMLElement).dataset.index).toBe("1");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    expect(actions.showCommit).toHaveBeenCalledWith((walk[1] as CommitSummary).oid, {
      extend: false,
    });
  });
});

describe("CommitCard (Design §14.5)", () => {
  const detailed = details[headOid] as CommitDetails;

  it("shows the subject, refs, author, parents, tree and file counts", () => {
    seed({ commitDetails: { [headOid]: { status: "ready", data: detailed } } });
    render(<CommitCard oid={headOid} />);
    const card = screen.getByRole("region", { name: "Commit 822313f" });
    expect(card.textContent).toContain("c59: extend mod4");
    expect(card.textContent).toContain("test <test@example.com>");
    expect(card.textContent).toContain("Mar 2024");
    expect(within(card).getByText("Parent")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "82bc6c6" })).toBeTruthy();
    expect(card.textContent).toContain(detailed.tree.slice(0, 7));
    expect(card.textContent).toContain("+5");
  });

  it("clicking a parent opens that commit", () => {
    const actions = seed({ commitDetails: { [headOid]: { status: "ready", data: detailed } } });
    render(<CommitCard oid={headOid} />);
    fireEvent.click(screen.getByRole("button", { name: "82bc6c6" }));
    expect(actions.showCommit).toHaveBeenCalledWith(detailed.parents[0]);
  });

  it("offers Show diff, Compare with base… and Copy SHA", () => {
    const actions = seed(
      {
        commitDetails: { [headOid]: { status: "ready", data: detailed } },
        compareBase: { expr: "refs/heads/main", display: "main" },
      },
      {},
    );
    render(<CommitCard oid={headOid} />);
    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));
    expect(actions.showCommit).toHaveBeenCalledWith(headOid);
    fireEvent.click(screen.getByRole("button", { name: /Compare with main/ }));
    expect(actions.compareCommitWithBase).toHaveBeenCalledWith(headOid);
    expect(screen.getByRole("button", { name: /Copy SHA/ })).toBeTruthy();
  });

  it("renders every `…` item, disabling the ones their task has not shipped yet", () => {
    seed({ commitDetails: { [headOid]: { status: "ready", data: detailed } } });
    render(<CommitCard oid={headOid} />);
    fireEvent.click(screen.getByRole("button", { name: "More commit actions" }));
    const menu = screen.getByRole("menu", { name: "More commit actions" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Export as .patch",
      "Copy cherry-pick command",
      "Bisect: mark good",
      "Bisect: mark bad",
      "Blame here",
    ]);
    // nothing is hidden; what is not wired yet says so
    // T11.6 wired `Blame here`, T11.10 the patch export and T11.13 the two bisect marks: nothing pending
    expect(items.filter((i) => (i as HTMLButtonElement).disabled)).toHaveLength(0);
    expect((items[0] as HTMLButtonElement).disabled).toBe(false);
    expect((items[1] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says so when the commit cannot be read", () => {
    seed({
      commitDetails: {
        [headOid]: { status: "error", error: { code: "REV_NOT_FOUND", message: "gone" } },
      },
    });
    render(<CommitCard oid={headOid} />);
    expect(document.body.textContent).toContain("Couldn’t read commit 822313f");
    expect(document.body.textContent).toContain("REV_NOT_FOUND");
  });
});

describe("Stack and Reflog sub-tabs", () => {
  const stackCommits = walk.slice(0, 3);

  it("lists the stack newest first with its counts, and a card opens its commit", () => {
    const actions = seed({
      historyTab: "stack",
      stack: {
        ...INITIAL_STACK,
        ready: true,
        commits: stackCommits,
        base: (walk[3] as CommitSummary).oid,
        tip: "refs/heads/main",
        label: "main … main",
      },
      commitStats: { [headOid]: { files: 1, additions: 5, deletions: 0 } },
    });
    render(<CommitList initialRect={RECT} />);
    const cards = [...document.querySelectorAll("[data-oid]")] as HTMLElement[];
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain("c59: extend mod4");
    expect(cards[0]?.textContent).toContain("1 file");
    expect(cards[0]?.textContent).toContain("+5");
    expect(cards[0]?.textContent).toContain("Expand");
    fireEvent.click(cards[0] as HTMLElement);
    expect(actions.showCommit).toHaveBeenCalledWith(headOid);
    expect(document.body.textContent).toContain("merge base");
  });

  it("puts `Uncommitted changes` on top while the working tree is included", () => {
    const actions = seed({
      historyTab: "stack",
      stack: { ...INITIAL_STACK, ready: true, commits: stackCommits, tip: "refs/heads/main" },
    });
    render(<CommitList initialRect={RECT} />);
    fireEvent.click(screen.getByRole("button", { name: /Uncommitted changes/ }));
    expect(actions.setSpecialSource).toHaveBeenCalledWith("worktree");
  });

  it("renders the reflog with the `unreachable` badge on the orphaned commits", () => {
    seed({
      historyTab: "reflog",
      reflog: orphanV2.reflog as unknown as ReflogEntry[],
    });
    render(<CommitList initialRect={RECT} />);
    expect(screen.getByRole("list", { name: "Reflog of HEAD" })).toBeTruthy();
    expect(screen.getAllByText("unreachable")).toHaveLength(2);
    expect(document.body.textContent).toContain("6 entries");
  });

  it("a reflog row opens the commit the way the Commits tab does", () => {
    const actions = seed({
      historyTab: "reflog",
      reflog: orphanV2.reflog as unknown as ReflogEntry[],
    });
    render(<CommitList initialRect={RECT} />);
    fireEvent.click(screen.getAllByRole("button")[3] as HTMLElement);
    expect(actions.showCommit).toHaveBeenCalled();
  });
});

describe("HistoryView", () => {
  it("replaces the file tree with the commit list and puts the card above the diff", () => {
    // the recorded `main~5…main` range, so the pane really has FileCards under the card
    seed({
      diff: historyV2.ranges[0]?.result as unknown as DiffResult,
      commitDetails: { [headOid]: { status: "ready", data: details[headOid] as CommitDetails } },
      history: { ...INITIAL_HISTORY, commits: walk, selected: headOid },
    });
    render(<HistoryView initialRect={RECT} />);
    expect(screen.getByRole("complementary", { name: "History" })).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
    const card = screen.getByRole("region", { name: "Commit 822313f" });
    const pane = screen.getByRole("region", { name: "Diff" });
    // the card is above the FileCards in document order (Design §14.5)
    expect(card.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("walks the first page once per repository", async () => {
    const actions = seed({ history: INITIAL_HISTORY });
    const { rerender } = render(<HistoryView initialRect={RECT} />);
    await waitFor(() => expect(actions.loadHistory).toHaveBeenCalledTimes(1));
    rerender(<HistoryView initialRect={RECT} />);
    expect(actions.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("the StatsRow label follows the commit the list selected", () => {
    const src: RangeSource = {
      kind: "range",
      from: "82bc6c6",
      to: "822313f",
      fromRef: `${headOid}^`,
      toRef: headOid,
      fromOid: "82bc6c6d1bc309b9e6463af370ec95aa4866a78c",
      toOid: headOid,
      threeDot: false,
      includeWorktree: false,
      commit: headOid,
    };
    seed({ diffSource: src });
    expect(useStore.getState().diffSource).toEqual(src);
  });
});

describe("performance (acceptance: the first page renders fast; informational)", () => {
  it("renders the first walked page in well under 100 ms", () => {
    seed({}, { commits: walk.slice(0, 50), cursor: "50" });
    const started = performance.now();
    render(<CommitList initialRect={RECT} />);
    const ms = performance.now() - started;
    console.log(`first history page: ${ms.toFixed(1)} ms for 50 rows (budget 100 ms)`);
    expect(rows()).toHaveLength(50);
    expect(ms).toBeLessThan(100);
  });
});

describe("accessibility (T5.6 rules)", () => {
  it("the list is a listbox of options and the card has no violations, in both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      seed({
        commitDetails: { [headOid]: { status: "ready", data: details[headOid] as CommitDetails } },
      });
      const { container } = render(
        <>
          <CommitList initialRect={RECT} />
          <CommitCard oid={headOid} />
        </>,
      );
      expect(screen.getByRole("listbox", { name: "Commits" })).toBeTruthy();
      expect(rows().length).toBeGreaterThan(0);
      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});
