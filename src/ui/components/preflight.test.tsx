/**
 * T11.13 — the rebase-preflight panel (Design §14.6, atlas tab 16) on the two reports `bun run
 * record` captured for `history` (T10.11): `preflight/a onto main` (likely / possible / clean) and
 * `main onto preflight/base` (55 rows, one merge, `--rebase-merges`), plus the store slice and the
 * two ways in — the Branches row `…` menu and the palette.
 */
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchRow, DiffResult, PreflightResult, RepoInfo, TagInfo } from "../../engine/types";
import historyDiff from "../../test/recorded/history.diffresult.json";
import historyInfo from "../../test/recorded/history.repoinfo.json";
import historyV2 from "../../test/recorded/history.v2.json";
import { resetDerivedStore } from "../persistence/derived";
import {
  DEFAULT_PREFS,
  INITIAL_BRANCHES,
  INITIAL_PREFLIGHT,
  type StoreState,
  selectPreflightPair,
  setStoreClient,
  useStore,
} from "../store";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { BranchesView } from "./BranchesView";
import { CommandPalette } from "./CommandPalette";
import { PreflightPanel } from "./PreflightPanel";

const repo = historyInfo as unknown as RepoInfo;
const diff = historyDiff as unknown as DiffResult;
const rows = historyV2.branches as unknown as BranchRow[];
const tags = historyV2.tags as unknown as TagInfo[];
const preflights = historyV2.preflights as unknown as Record<string, PreflightResult>;
const A = preflights["preflight/a onto main"] as PreflightResult;
const B = preflights["main onto preflight/base"] as PreflightResult;
/** One day after the newest recorded tip, so every recorded branch counts as Active. */
const NOW = 1710633600000 + 86_400_000;

const initial = useStore.getState();
let derivedSeq = 0;

function seed(
  overrides: Partial<StoreState> = {},
  preflight: Partial<StoreState["preflight"]> = {},
) {
  const actions = {
    loadBranches: vi.fn(async () => {}),
    loadPickerSources: vi.fn(async () => {}),
    requestBranchCells: vi.fn(),
    showBranchHistory: vi.fn(),
    compareBranchWithBase: vi.fn(),
    runPreflight: vi.fn(async () => {}),
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
      branches: { ...INITIAL_BRANCHES, rows },
      preflight: {
        ...INITIAL_PREFLIGHT,
        branch: "preflight/a",
        onto: "main",
        result: A,
        ...preflight,
      },
      ...actions,
      ...overrides,
    },
    true,
  );
  return actions;
}

beforeEach(() => {
  derivedSeq++;
  resetDerivedStore(`preflight-derived-${derivedSeq}`);
});

afterEach(() => {
  cleanup();
  setStoreClient(null);
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

const panel = () => screen.getByRole("region", { name: "Rebase preflight: preflight/a onto main" });
const bodyRows = () => [...document.querySelectorAll("[data-preflight] [data-rows] tr")];

describe("PreflightPanel on `preflight/a onto main` (Design §14.6)", () => {
  it("is a report: one row per commit to replay, in replay order, with no reorder control", () => {
    seed();
    render(<PreflightPanel />);
    expect(bodyRows().map((r) => r.getAttribute("data-oid"))).toEqual(A.rows.map((r) => r.oid));
    expect(bodyRows().map((r) => r.querySelector("td")?.textContent)).toEqual(["1", "2", "3"]);
    // every row's action is `pick`, and there is no button in the table at all
    expect(within(panel()).getAllByText("pick")).toHaveLength(3);
    expect(document.querySelectorAll("[data-rows] button")).toHaveLength(0);
  });

  it("shows the three predictions as chips with their own words", () => {
    seed();
    render(<PreflightPanel />);
    expect(
      [...document.querySelectorAll("[data-prediction]")].map((c) => [
        c.getAttribute("data-prediction"),
        c.textContent,
      ]),
    ).toEqual([
      ["likely", "likely conflict"],
      ["possible", "possible"],
      ["clean", "clean"],
    ]);
  });

  it("names the overlapping path and the onto-side commit that decided it", () => {
    seed();
    render(<PreflightPanel />);
    const overlaps = [...document.querySelectorAll("[data-overlap]")];
    expect(overlaps).toHaveLength(2);
    expect(overlaps[0]?.getAttribute("data-overlap")).toBe("src/hot.txt");
    expect(overlaps[0]?.textContent).toContain("on main changed the same lines");
    expect(overlaps[1]?.textContent).toContain("on main changed another part");
    // the clean row says so rather than leaving the cell blank
    expect(bodyRows()[2]?.textContent).toContain("—");
  });

  it("summarises the replay and the base's own advance", () => {
    seed();
    render(<PreflightPanel />);
    expect(panel().textContent).toContain(
      "3 commits to replay · main moved 55 commits since the merge base · 1 likely conflict · 1 possible",
    );
  });

  it("hands over the command and the todo, and copies the todo", async () => {
    seed();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PreflightPanel />);
    expect(screen.getByText("git rebase -i main")).toBeTruthy();
    expect(panel().textContent).toContain("pick 1b64210 p1: rewrite the top of hot.txt");
    const copy = screen.getByRole("button", { name: "Copy todo" });
    expect(copy.getAttribute("title")).toBe("Copy 3 lines of rebase todo");
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(A.todo));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("says that only textual conflicts are predicted", () => {
    seed();
    render(<PreflightPanel />);
    expect(panel().textContent).toContain("Textual conflicts only");
  });

  it("is axe-clean in both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      seed();
      const { container } = render(<PreflightPanel />);
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});

describe("PreflightPanel on `main onto preflight/base` (the merge case)", () => {
  const seedB = () => seed({}, { branch: "main", onto: "preflight/base", result: B });
  const panelB = () =>
    screen.getByRole("region", { name: "Rebase preflight: main onto preflight/base" });

  it("lists all 55 commits, marks the one merge and switches the command", () => {
    seedB();
    render(<PreflightPanel />);
    expect(bodyRows()).toHaveLength(55);
    expect(document.querySelectorAll('[data-prediction="clean"]')).toHaveLength(55);
    expect(within(panelB()).getAllByTitle(/--rebase-merges/)).not.toHaveLength(0);
    expect(screen.getByText("git rebase -i --rebase-merges preflight/base")).toBeTruthy();
    expect(panelB().textContent).toContain("One commit is a merge");
  });

  it("leaves a base that has not moved out of the summary", () => {
    seedB();
    render(<PreflightPanel />);
    expect(panelB().textContent).toContain("55 commits to replay · no predicted conflict");
    expect(panelB().textContent).not.toContain("since the merge base");
  });
});

describe("the panel's other states", () => {
  it("counts up while the engine is reading", () => {
    seed({}, { result: null, loading: true });
    render(<PreflightPanel />);
    expect(screen.getByRole("status").textContent).toContain("Reading what would be replayed");
  });

  it("shows a Notice rather than an empty table when the call is refused", () => {
    seed({}, { result: null, error: { code: "REV_NOT_FOUND", message: "gone" } });
    render(<PreflightPanel />);
    expect(panel().textContent).toContain(
      "Couldn’t work out what a rebase of preflight/a onto main",
    );
  });

  it("says there is nothing to replay when the branch is already on the base", () => {
    seed({}, { result: { ...A, rows: [], ontoAdvanced: 0 } });
    render(<PreflightPanel />);
    expect(panel().textContent).toContain("there is nothing to rebase");
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy todo" })).toBeNull();
  });

  it("warns when the two branches share no history", () => {
    seed({}, { result: { ...A, mergeBase: null } });
    render(<PreflightPanel />);
    expect(panel().textContent).toContain("share no commit");
  });

  it("closes back to the Branches table", () => {
    seed({ closePreflight: initial.closePreflight });
    render(<BranchesView now={NOW} />);
    expect(screen.queryByRole("grid", { name: "Branches" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useStore.getState().preflight).toEqual(INITIAL_PREFLIGHT);
    expect(screen.getByRole("grid", { name: "Branches" })).toBeTruthy();
  });
});

describe("the two ways into the panel (Design §14.1: a row menu or the palette)", () => {
  it("the Branches row menu asks for that branch onto the base, by its display name", () => {
    const actions = seed({}, INITIAL_PREFLIGHT);
    render(<BranchesView now={NOW} />);
    const row = document.querySelector('[data-ref="refs/heads/preflight/a"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "More actions for preflight/a" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Preflight rebase onto main" }));
    expect(actions.runPreflight).toHaveBeenCalledWith("preflight/a", "main");
  });

  it("the base branch's own row cannot be rebased onto itself", () => {
    seed({}, INITIAL_PREFLIGHT);
    render(<BranchesView now={NOW} />);
    const row = document.querySelector('[data-ref="refs/heads/main"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "More actions for main" }));
    const item = screen.getByRole("menuitem", { name: "Preflight rebase onto main" });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("the palette offers the compare side onto the base", () => {
    const compare = {
      ...diff.source,
      source: "preflight/a",
      sourceRef: "refs/heads/preflight/a",
    };
    const actions = seed({ palette: true, diffSource: compare }, INITIAL_PREFLIGHT);
    expect(selectPreflightPair(useStore.getState())).toEqual({
      branch: "preflight/a",
      onto: "main",
    });
    render(<CommandPalette />);
    fireEvent.click(screen.getByText("Preflight rebase of preflight/a onto main"));
    expect(actions.runPreflight).toHaveBeenCalledWith("preflight/a", "main");
  });

  it("offers nothing when the compare side is not a branch, or is the base itself", () => {
    seed({ palette: true }, INITIAL_PREFLIGHT); // the recorded source is `main`, which is the base
    expect(selectPreflightPair(useStore.getState())).toBeNull();
    render(<CommandPalette />);
    expect(screen.queryByText(/^Preflight rebase of/)).toBeNull();
    // a range is not a branch, so there is nothing to rebase
    useStore.setState({ diffSource: { ...diff.source, kind: "range" } as never });
    expect(selectPreflightPair(useStore.getState())).toBeNull();
  });
});

describe("store: preflight (T11.13)", () => {
  let mock: MockWorkerClient;
  const open = async () => {
    mock = createMockWorkerClient();
    setStoreClient(mock);
    useStore.setState(initial, true);
    await useStore.getState().openRepo({ name: "history" }, { id: "hist" });
  };

  it("asks the engine for the recorded pair and parks the report", async () => {
    await open();
    const spy = vi.spyOn(mock, "rebasePreflight");
    await useStore.getState().runPreflight("preflight/a", "main");
    expect(spy).toHaveBeenCalledWith("preflight/a", "main");
    const p = useStore.getState().preflight;
    expect(p.result?.rows).toHaveLength(3);
    expect(p.loading).toBe(false);
    expect(p.error).toBeNull();
    // opening the panel is what "Branches mode" means for this report
    expect(useStore.getState().mode).toBe("branches");
  });

  it("answers the merge case with `--rebase-merges`", async () => {
    await open();
    await useStore.getState().runPreflight("main", "preflight/base");
    expect(useStore.getState().preflight.result?.command).toBe(
      "git rebase -i --rebase-merges preflight/base",
    );
    expect(useStore.getState().preflight.result?.rows).toHaveLength(55);
  });

  it("keeps a refusal on the panel instead of toasting it", async () => {
    await open();
    await useStore.getState().runPreflight("nope", "main");
    const p = useStore.getState().preflight;
    expect(p.error?.code).toBe("REV_NOT_FOUND");
    expect(p.result).toBeNull();
  });

  it("drops a `STALE` answer without an error, and forgets the report on close", async () => {
    await open();
    vi.spyOn(mock, "rebasePreflight").mockRejectedValueOnce(
      Object.assign(new Error("superseded"), { code: "CANCELLED" }),
    );
    await useStore.getState().runPreflight("preflight/a", "main");
    expect(useStore.getState().preflight.error).toBeNull();
    useStore.getState().closePreflight();
    expect(useStore.getState().preflight).toEqual(INITIAL_PREFLIGHT);
  });

  it("closeRepo drops the report", async () => {
    await open();
    await useStore.getState().runPreflight("preflight/a", "main");
    await useStore.getState().closeRepo();
    expect(useStore.getState().preflight).toEqual(INITIAL_PREFLIGHT);
  });
});
