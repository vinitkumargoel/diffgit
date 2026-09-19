/**
 * T11.12 — Insights mode (Design §14.6, atlas tab 13). The page on the recorded `history` pass (48
 * first-parent commits, three mapped identities plus `renovate[bot]`, 14 paths) and the store slice
 * behind it against the mock worker, so every number on screen came out of the real engine once.
 */
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, DiffResult, InsightsResult, RepoInfo } from "../../engine/types";
import historyDiff from "../../test/recorded/history.diffresult.json";
import historyInfo from "../../test/recorded/history.repoinfo.json";
import historyV2 from "../../test/recorded/history.v2.json";
import { DAY_MS, INSIGHTS_LIMIT } from "../insights";
import { derivedKey, resetDerivedStore, setDerived } from "../persistence/derived";
import {
  DEFAULT_PREFS,
  INITIAL_INSIGHTS,
  type StoreState,
  setStoreClient,
  useStore,
} from "../store";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { InsightsView } from "./InsightsView";
import { TopBar } from "./TopBar";

const repo = historyInfo as unknown as RepoInfo;
const diff = historyDiff as unknown as DiffResult;
const recorded = historyV2.insights as unknown as InsightsResult;
const walk = historyV2.walks.default.commits as unknown as CommitSummary[];
const HEAD = repo.headOid as string;

const initial = useStore.getState();
let derivedSeq = 0;

/** The view with the store's own actions stubbed out; the store's behaviour has its own block. */
function seed(overrides: Partial<StoreState> = {}, insights: Partial<StoreState["insights"]> = {}) {
  const actions = {
    loadInsights: vi.fn(async () => {}),
    setInsightsPeriod: vi.fn(),
    showHotspot: vi.fn(),
  };
  useStore.setState(
    {
      ...initial,
      screen: "repo",
      repo,
      repoId: "hist",
      mode: "insights",
      diff,
      diffSource: diff.source,
      prefs: DEFAULT_PREFS,
      insights: { ...INITIAL_INSIGHTS, result: recorded, tip: HEAD, period: "90d", ...insights },
      ...actions,
      ...overrides,
    },
    true,
  );
  return actions;
}

beforeEach(() => {
  derivedSeq++;
  resetDerivedStore(`insights-derived-${derivedSeq}`);
});

afterEach(() => {
  cleanup();
  setStoreClient(null);
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

const hotspotRows = () => [...document.querySelectorAll("[data-path]")] as HTMLElement[];
const cells = () =>
  [...document.querySelectorAll("rect[data-count]")] as unknown as SVGRectElement[];

describe("InsightsView sections (Design §14.6)", () => {
  it("ranks the hotspots, greys the manifests and keeps them out of the ranking", () => {
    seed();
    render(<InsightsView />);
    const rows = hotspotRows();
    expect(rows).toHaveLength(14);
    expect(rows.slice(0, 3).map((r) => r.getAttribute("data-path"))).toEqual([
      "src/mod4.txt",
      "src/mod3.txt",
      "src/mod2.txt",
    ]);
    // the manifest is last, in its own group, with the grey bar and the note
    const manifests = document.querySelector("[data-manifests]") as HTMLElement;
    const manifestRow = within(manifests).getByRole("button");
    expect(manifestRow.getAttribute("data-path")).toBe("package.json");
    expect((manifestRow.querySelector("i") as HTMLElement).className).toContain("bg-muted");
    expect(screen.getByText(/excluded from the ranking/)).toBeTruthy();
    // the ranked bars are the accent, widest first, and the numbers are beside them
    const first = rows[0] as HTMLElement;
    expect((first.querySelector("i") as HTMLElement).className).toContain("bg-accent");
    expect((first.querySelector("i") as HTMLElement).style.width).toBe("100%");
    expect(first.textContent).toContain("9 commits · 631 B");
  });

  it("clicking a hotspot asks for that file in Files mode", () => {
    const actions = seed();
    render(<InsightsView />);
    fireEvent.click(hotspotRows()[0] as HTMLElement);
    expect(actions.showHotspot).toHaveBeenCalledWith("src/mod4.txt");
  });

  it("draws 10 weeks of 7 labelled cells with a text alternative", () => {
    seed();
    render(<InsightsView />);
    expect(cells()).toHaveLength(70);
    // every cell carries its own date and count as a `<title>` (the tooltip and its label)
    for (const cell of cells()) {
      const title = cell.querySelector("title")?.textContent ?? "";
      expect(title).toMatch(/^(No commits|\d+ commits?) on \d+ \w+ \d{4}$/);
      const count = Number(cell.getAttribute("data-count"));
      expect(title.startsWith(count === 0 ? "No commits" : `${count} commit`)).toBe(true);
      expect(cell.getAttribute("class")).toBe(count === 0 ? "fill-surface-raised" : "fill-heat-5");
    }
    expect(
      screen.getByRole("img", { name: /Commits per day over 10 weeks, 48 in total/ }),
    ).toBeTruthy();
    // the `sr-only` weekly table is the alternative to the grid, one row per column
    const table = screen.getByRole("table", { name: "Commits per week" });
    expect(within(table).getAllByRole("row")).toHaveLength(10);
    expect(within(table).getAllByRole("rowheader")[0]?.textContent).toMatch(/^Week of /);
  });

  it("keeps contributors behind a closed disclosure with the bots line and the .mailmap note", () => {
    seed();
    render(<InsightsView />);
    const details = document.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText("Show contributors")).toBeTruthy();
    fireEvent.click(screen.getByText("Show contributors"));
    const rows = [...document.querySelectorAll("[data-author]")] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("data-author"))).toEqual([
      "Ada Lovelace",
      "Grace Hopper",
      "test",
    ]);
    expect(rows[0]?.textContent).toContain("19");
    const grace = rows[1] as HTMLElement;
    expect((grace.querySelector("i") as HTMLElement).style.width).toBe("79%");
    expect(screen.getByText(/8 commits by bots/)).toBeTruthy();
    expect(
      screen.getByText(/Identities are folded through the repository’s \.mailmap/),
    ).toBeTruthy();
    // no bot is listed as a contributor
    expect(screen.queryByText("renovate[bot]")).toBeNull();
  });

  it("prints what was walked, and the cap as one inline line rather than a banner", () => {
    seed({}, { cached: true });
    const view = render(<InsightsView />);
    expect(screen.getByText("Walked 48 first-parent commits from HEAD · cached")).toBeTruthy();
    expect(screen.queryByText(/sample of the newest history/)).toBeNull();
    view.unmount();
    seed({}, { result: { ...recorded, capped: true, walked: 50_000 } });
    render(<InsightsView />);
    expect(screen.getByText(/The walk stopped at 50,000 commits/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Warnings" })).toBeNull();
  });
});

describe("InsightsView header and states (Design §14.1)", () => {
  it("replaces the StatsRow with the page's own header instead of drawing both", () => {
    seed({ mode: "files" });
    const view = render(<TopBar />);
    expect(screen.getByText(/files changed/)).toBeTruthy();
    view.unmount();
    seed();
    render(<TopBar />);
    expect(screen.queryByText(/files changed/)).toBeNull();
    // and nothing was added to row 1: the ModeSwitch is still the only v2 control there
    expect(screen.getByRole("button", { name: "Insights" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("shows the three period chips, pressed on the pref, and re-asks on a click", () => {
    const actions = seed({ prefs: { ...DEFAULT_PREFS, insightsPeriod: "1y" } });
    render(<InsightsView />);
    const chip = (label: string) => screen.getByRole("button", { name: label });
    expect(["90 d", "1 y", "All"].map((l) => chip(l).getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(screen.getByText("48 commits · 3 authors")).toBeTruthy();
    fireEvent.click(chip("All"));
    expect(actions.setInsightsPeriod).toHaveBeenCalledWith("all");
  });

  it("counts the walk up in the skeleton while it runs", () => {
    seed({}, { result: null, loading: true, walked: 1500 });
    render(<InsightsView />);
    expect(screen.getByRole("status").textContent).toContain("1,500 commits");
    expect(screen.queryByText(/Walked/)).toBeNull();
  });

  it("says so when the repository has no commits, and offers the whole history when the period is empty", () => {
    const empty = {
      ...recorded,
      commits: 0,
      walked: 0,
      authors: [],
      hotspots: [],
      activity: [],
      bots: 0,
    };
    seed({}, { result: empty });
    const first = render(<InsightsView />);
    expect(screen.getByText(/No commits yet/)).toBeTruthy();
    first.unmount();
    const actions = seed({}, { result: { ...empty, walked: 48 } });
    render(<InsightsView />);
    expect(screen.getByText(/No commits in the last 90 days/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show the whole history" }));
    expect(actions.setInsightsPeriod).toHaveBeenCalledWith("all");
  });

  it("shows a Notice when the walk failed", () => {
    seed({}, { result: null, error: { code: "IO_ERROR", message: "disk went away" } });
    render(<InsightsView />);
    expect(screen.getByText("Couldn’t summarise this repository")).toBeTruthy();
    expect(screen.getByText("IO_ERROR")).toBeTruthy();
  });

  it("is axe-clean in both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      seed();
      const { container } = render(<InsightsView />);
      fireEvent.click(screen.getByText("Show contributors"));
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});

describe("store: insights (T11.12)", () => {
  let mock: MockWorkerClient;
  const open = async () => {
    mock = createMockWorkerClient();
    setStoreClient(mock);
    useStore.setState(initial, true);
    await useStore.getState().openRepo({ name: "history" }, { id: "hist" });
  };

  it("asks for the period window at the top limit and keeps the answer", async () => {
    await open();
    const spy = vi.spyOn(mock, "insights");
    const before = Date.now();
    await useStore.getState().loadInsights();
    const req = spy.mock.calls[0]?.[0];
    expect(req?.limit).toBe(INSIGHTS_LIMIT);
    // no commit date is known yet, so the window is anchored on the clock
    expect(req?.sinceMs ?? 0).toBeGreaterThanOrEqual(before - 90 * DAY_MS);
    const s = useStore.getState().insights;
    expect(s.result?.commits).toBe(48);
    expect(s.tip).toBe(HEAD);
    expect(s.period).toBe("90d");
    expect(s.cached).toBe(false);
    // the mock honours `limit`: 12 real files and the one manifest
    expect(s.result?.hotspots.filter((h) => !h.manifest)).toHaveLength(12);
    // a second call for the same tip and period does not walk again
    await useStore.getState().loadInsights();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("anchors the window on the newest commit it knows about", async () => {
    await open();
    await useStore.getState().loadHistory();
    const spy = vi.spyOn(mock, "insights");
    await useStore.getState().loadInsights();
    const tip = walk[0]?.author.timestamp as number;
    expect(spy.mock.calls[0]?.[0].sinceMs).toBe(tip - 90 * DAY_MS);
  });

  it("re-asks on a period switch, and sends no window for `All`", async () => {
    await open();
    await useStore.getState().loadInsights();
    const spy = vi.spyOn(mock, "insights");
    useStore.getState().setInsightsPeriod("all");
    await waitFor(() => expect(useStore.getState().insights.period).toBe("all"));
    await waitFor(() => expect(useStore.getState().insights.loading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].sinceMs).toBeUndefined();
    expect(useStore.getState().prefs.insightsPeriod).toBe("all");
  });

  it("answers from the derived cache without walking, keyed by tip and period", async () => {
    await open();
    const cached = { ...recorded, commits: 7 };
    await setDerived(derivedKey.insights("hist", HEAD, "90d"), cached);
    const spy = vi.spyOn(mock, "insights");
    await useStore.getState().loadInsights();
    expect(spy).not.toHaveBeenCalled();
    expect(useStore.getState().insights.result?.commits).toBe(7);
    expect(useStore.getState().insights.cached).toBe(true);
    // the other period is a different key, so it is a real walk
    useStore.getState().setInsightsPeriod("1y");
    await waitFor(() => expect(useStore.getState().insights.result?.commits).toBe(48));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("writes what it walked into the derived cache", async () => {
    await open();
    await useStore.getState().loadInsights();
    useStore.setState({ insights: INITIAL_INSIGHTS });
    const spy = vi.spyOn(mock, "insights");
    await useStore.getState().loadInsights();
    expect(spy).not.toHaveBeenCalled();
    expect(useStore.getState().insights.cached).toBe(true);
  });

  it("a hotspot click filters Files mode down to that path", async () => {
    await open();
    useStore.getState().setMode("insights");
    useStore.getState().showHotspot("src/mod4.txt");
    expect(useStore.getState().filter).toBe("src/mod4.txt");
    expect(useStore.getState().mode).toBe("files");
  });

  it("closeRepo drops the answer", async () => {
    await open();
    await useStore.getState().loadInsights();
    await useStore.getState().closeRepo();
    expect(useStore.getState().insights).toEqual(INITIAL_INSIGHTS);
  });
});
