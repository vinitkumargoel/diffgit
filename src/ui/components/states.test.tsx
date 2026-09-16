import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_CODES, WARNING_CODES } from "../../engine/errors";
import type { DiffResult, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import basic from "../../test/recorded/showcase.repoinfo.json";
import { describeError } from "../errors";
import { DEFAULT_PREFS, type StoreState, useStore } from "../store";
import { describeWarning, WARNING_COPY } from "../warnings";
import { EmptyState, openBasePicker } from "./EmptyState";
import ErrorScreen from "./ErrorScreen";
import RepoScreen from "./RepoScreen";
import { TOAST_TTL_MS, Toasts } from "./Toasts";
import { WarningBanner, WarningBanners } from "./WarningBanners";

// cmdk / react-virtual need these in happy-dom
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

const persistence = vi.hoisted(() => ({
  ensurePermission: vi.fn(async (): Promise<"granted" | "denied"> => "granted"),
  removeRepo: vi.fn(async () => {}),
  listRepos: vi.fn(async () => []),
  upsertRepo: vi.fn(async () => ({ id: "x", name: "x", handle: {}, lastOpenedAt: 1 })),
}));
vi.mock("../persistence", () => persistence);

const repo = basic as unknown as RepoInfo;
const diff = basicDiff as unknown as DiffResult;
const initial = useStore.getState();

function snapshotBothThemes(name: string, node: ReactNode) {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const { container } = render(node);
    expect(container.firstChild).toMatchSnapshot(`${name} (${theme})`);
    cleanup();
  }
  document.documentElement.classList.remove("dark");
}

function seed(overrides: Partial<StoreState> = {}) {
  const actions = {
    closeRepo: vi.fn(async () => {}),
    openRepo: vi.fn(async () => {}),
    recompute: vi.fn(async () => {}),
    setSource: vi.fn(),
    setTarget: vi.fn(),
    swapBranches: vi.fn(),
    setIncludeWorktree: vi.fn(),
    setPref: vi.fn(),
    setFilter: vi.fn(),
    setRefreshMode: vi.fn(),
    loadFileDiff: vi.fn(async () => {}),
    cancelFileDiff: vi.fn(),
  };
  useStore.setState({
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
    diff,
    prefs: DEFAULT_PREFS,
    warnings: [],
    dismissedWarnings: new Set(),
    toasts: [],
    ...actions,
    ...overrides,
  });
  return actions;
}

beforeEach(() => {
  persistence.ensurePermission.mockResolvedValue("granted");
  persistence.removeRepo.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useStore.setState(initial, true);
});

describe("warning registry", () => {
  it("has copy and a level for every engine warning code, with the §3.4 levels", () => {
    for (const code of WARNING_CODES) {
      const c = WARNING_COPY[code];
      expect(c, code).toBeDefined();
      expect(["info", "warning", "error"]).toContain(c.level);
      expect(c.subject.length, code).toBeGreaterThan(0);
      expect(c.message.length, code).toBeGreaterThan(0);
      expect(c.message, code).not.toContain(code);
    }
    expect(WARNING_COPY.WORKTREE_NOT_APPLICABLE.level).toBe("info");
    expect(WARNING_COPY.SPLIT_INDEX.level).toBe("error");
    expect(WARNING_COPY.INDEX_TOO_LARGE.level).toBe("error");
    expect(WARNING_COPY.AUTOCRLF.level).toBe("warning");
    expect(describeWarning("NOPE").subject).toBe("Warning");
  });

  it("snapshots one banner per code in both themes", () => {
    for (const code of WARNING_CODES) {
      snapshotBothThemes(
        `banner ${code}`,
        <WarningBanner warning={{ code, message: "engine text" }} onDismiss={() => {}} />,
      );
    }
  });

  it("WarningBanners lists undismissed warnings and dismisses independently", () => {
    seed({
      warnings: [
        { code: "AUTOCRLF", message: "m" },
        { code: "SPLIT_INDEX", message: "m", detail: "Run git update-index." },
        { code: "SHALLOW", message: "m" },
      ],
      dismissedWarnings: new Set(["SHALLOW"]),
    });
    render(<WarningBanners />);
    const region = screen.getByRole("region", { name: "Warnings" });
    expect(region.querySelectorAll("[data-level]").length).toBe(2);
    expect(screen.getByRole("alert").textContent).toContain("Split index");
    expect(screen.getByRole("alert").textContent).toContain("Run git update-index.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: Line endings" }));
    expect(useStore.getState().dismissedWarnings.has("AUTOCRLF")).toBe(true);
    expect(region.querySelectorAll("[data-level]").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: Split index" }));
    expect(screen.queryByRole("region", { name: "Warnings" })).toBeNull();
  });
});

describe("EmptyState", () => {
  it("snapshots both themes, with and without the worktree line", () => {
    seed();
    snapshotBothThemes("empty with worktree", <EmptyState />);
    seed({
      diffSource: {
        kind: "branches",
        source: "main",
        target: "main",
        sourceRef: "refs/heads/main",
        targetRef: "refs/heads/main",
        includeWorktree: false,
      },
    });
    snapshotBothThemes("empty same ref", <EmptyState />);
  });

  it("names both branches, shows the clean-tree line, and Change base opens the base picker", () => {
    seed();
    const clicked = vi.fn();
    const { container } = render(
      <>
        <button type="button" aria-label="base branch: main" onClick={clicked}>
          main
        </button>
        <EmptyState />
      </>,
    );
    expect(screen.getByRole("heading").textContent).toBe("No changes between feature and main");
    expect(screen.getByText("Working tree is clean.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change base" }));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(openBasePicker(container)).toBe(true);
    expect(openBasePicker(document.createElement("div"))).toBe(false);
  });

  it("RepoScreen swaps the sidebar + pane for the EmptyState when the diff has no files", () => {
    seed({ diff: { ...diff, files: [], totals: { files: 0, additions: 0, deletions: 0 } } });
    render(<RepoScreen />);
    expect(screen.getByRole("region", { name: "No changes" })).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
    expect(document.getElementById("diff")).toBeNull();
    expect(screen.getByRole("button", { name: /^base branch/ })).toBeTruthy();
  });
});

describe("ErrorScreen", () => {
  it("snapshots the main variants in both themes and never shows a raw code", () => {
    for (const code of [
      "NOT_A_REPO",
      "PERMISSION",
      "HANDLE_GONE",
      "IO_ERROR",
      "CANCELLED",
    ] as const) {
      seed({ screen: "error", error: { code, message: describeError(code).message } });
      snapshotBothThemes(`error ${code}`, <ErrorScreen />);
    }
    for (const code of PUBLIC_CODES) {
      seed({ screen: "error", error: { code, message: "engine says" } });
      const { container } = render(<ErrorScreen />);
      expect(container.textContent).not.toContain(code);
      cleanup();
    }
  });

  it("choose-folder closes the repo; HANDLE_GONE can forget the repo", async () => {
    const a = seed({ screen: "error", error: { code: "HANDLE_GONE", message: "gone" } });
    render(<ErrorScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Choose another folder" }));
    expect(a.closeRepo).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Forget this repo" }));
    await waitFor(() => expect(persistence.removeRepo).toHaveBeenCalledWith("r1"));
    expect(a.closeRepo).toHaveBeenCalledTimes(2);
  });

  it("retry re-opens the same handle with the remembered branches", async () => {
    const a = seed({ screen: "error", error: { code: "IO_ERROR", message: "EIO" } });
    render(<ErrorScreen />);
    expect(screen.getByText("EIO")).toBeTruthy(); // details block carries the engine message
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(a.openRepo).toHaveBeenCalledTimes(1));
    expect(a.openRepo).toHaveBeenCalledWith(
      { name: "showcase" },
      { id: "r1", lastSource: "refs/heads/feature", lastTarget: "refs/heads/main" },
    );
  });

  it("Grant access re-asks for permission; denial shows the inline line", async () => {
    persistence.ensurePermission.mockResolvedValueOnce("denied");
    const a = seed({ screen: "error", error: { code: "PERMISSION", message: "denied" } });
    render(<ErrorScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Permission denied"),
    );
    expect(a.openRepo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(a.openRepo).toHaveBeenCalledTimes(1));
  });
});

describe("Toasts", () => {
  it("renders, runs the action, dismisses, and auto-dismisses after 8 s", () => {
    vi.useFakeTimers();
    seed();
    const onRetry = vi.fn();
    const { addToast } = useStore.getState();
    act(() => {
      addToast({
        level: "error",
        message: "Refresh failed",
        action: { label: "Retry", onClick: onRetry },
      });
      addToast({ level: "info", message: "Just so you know" });
    });
    render(<Toasts />);
    expect(screen.getByRole("alert").textContent).toContain("Refresh failed");
    expect(screen.getByRole("status").textContent).toContain("Just so you know");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(TOAST_TTL_MS + 10);
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(useStore.getState().toasts).toEqual([]);

    act(() => {
      addToast({ level: "warning", message: "Careful" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(useStore.getState().toasts).toEqual([]);
  });

  it("snapshots the three levels in both themes", () => {
    seed({
      toasts: [
        {
          id: 1,
          level: "error",
          message: "Refresh failed: EIO",
          action: { label: "Retry", onClick: () => {} },
        },
        { id: 2, level: "warning", message: "Careful" },
        { id: 3, level: "info", message: "FYI" },
      ],
    });
    snapshotBothThemes("toasts", <Toasts />);
  });
});
