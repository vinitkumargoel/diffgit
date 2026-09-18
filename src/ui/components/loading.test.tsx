import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffSource } from "../../engine/types";
import { initialLoading, type StoreState, useStore } from "../store";
import { LoadingScreen, stepStatus } from "./LoadingScreen";

const persistence = vi.hoisted(() => ({
  ensurePermission: vi.fn(async (): Promise<"granted" | "denied"> => "granted"),
  removeRepo: vi.fn(async () => {}),
  listRepos: vi.fn(async () => []),
  upsertRepo: vi.fn(async () => ({ id: "x", name: "x", handle: {}, lastOpenedAt: 1 })),
}));
vi.mock("../persistence", () => persistence);

const source: DiffSource = {
  kind: "branches",
  source: "feat/coupons",
  target: "main",
  sourceRef: "refs/heads/feat/coupons",
  targetRef: "refs/heads/main",
  includeWorktree: true,
};

const initial = useStore.getState();

function seed(overrides: Partial<StoreState> = {}) {
  const actions = {
    closeRepo: vi.fn(async () => {}),
    openRepo: vi.fn(async () => {}),
  };
  useStore.setState(
    {
      ...initial,
      screen: "loading",
      repo: null,
      repoId: "r1",
      handle: { name: "acme-web" },
      diffSource: source,
      warnings: [],
      loading: initialLoading({ step: "refs", startedAt: Date.now() }),
      ...actions,
      ...overrides,
    },
    true,
  );
  return actions;
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

/** Serious / critical axe violations; contrast is measured by `contrast.test.ts` instead. */
async function violations(container: HTMLElement) {
  const result = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    resultTypes: ["violations"],
  });
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

beforeEach(() => {
  persistence.ensurePermission.mockResolvedValue("granted");
  persistence.ensurePermission.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useStore.setState(initial, true);
});

describe("LoadingScreen phases (L1)", () => {
  it("shows done / current / pending phases with counts and cancels", async () => {
    const a = seed({
      loading: initialLoading({
        step: "worktree",
        done: 1240,
        total: 5000,
        completed: ["refs", "index"],
        startedAt: Date.now() - 4200,
        expectedMs: 6000,
        phases: {
          refs: { durationMs: 300, count: 412 },
          index: { durationMs: 400, count: 8120 },
        },
      }),
    });
    render(<LoadingScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("acme-web");
    expect(screen.getAllByLabelText("done").length).toBe(2);
    expect(screen.getAllByLabelText("in progress").length).toBe(1);
    expect(screen.getAllByLabelText("pending").length).toBe(1);
    expect(screen.getByText("1,240 / 5,000")).toBeTruthy();
    expect(screen.getByText("412 refs")).toBeTruthy();
    expect(screen.getByText("8,120 entries")).toBeTruthy();
    expect(screen.getByText("0.3 s")).toBeTruthy();
    expect(screen.getByText("0.4 s")).toBeTruthy();
    expect(stepStatus(useStore.getState().loading, "diff")).toBe("pending");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(a.closeRepo).toHaveBeenCalledTimes(1));
  });

  it("names the pair, the worktree note and the elapsed / expected lines", () => {
    seed({
      loading: initialLoading({
        step: "worktree",
        completed: ["refs", "index"],
        startedAt: Date.now() - 4200,
        expectedMs: 6000,
      }),
    });
    const { container } = render(<LoadingScreen />);
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("feat/coupons")).toBeTruthy();
    expect(screen.getByText("· uncommitted included")).toBeTruthy();
    expect(screen.getByText("4.2 s")).toBeTruthy();
    expect(container.textContent).toContain("usually ~6 s");
    // no total → the count column says "—", not a fake number
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("keeps a finished step's sub-phases once the step advances (the store retains them)", () => {
    seed({
      loading: initialLoading({
        step: "refs",
        startedAt: Date.now(),
        subPhases: ["layout", "config"],
      }),
    });
    const { rerender } = render(<LoadingScreen />);
    act(() => {
      useStore.setState({
        loading: initialLoading({
          step: "index",
          completed: ["refs"],
          startedAt: useStore.getState().loading.startedAt,
          subPhases: ["layout", "config"],
          phases: { refs: { durationMs: 300, count: 412 } },
        }),
      });
    });
    rerender(<LoadingScreen />);
    expect(screen.getByText("layout ok · config ok · 412 refs")).toBeTruthy();
  });

  it("elapsed only appears after 2 s (L2)", () => {
    vi.useFakeTimers();
    const start = Date.now();
    seed({ loading: initialLoading({ step: "refs", startedAt: start }) });
    const { container } = render(<LoadingScreen />);
    expect(container.textContent).toContain("Elapsed appears after 2 s");
    expect(container.textContent).toContain("first open");
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByText("2.5 s")).toBeTruthy();
    expect(container.textContent).not.toContain("Elapsed appears after 2 s");
  });

  it("lists the warnings seen so far in the phase caption and the footer (L6)", () => {
    seed({
      warnings: [
        { code: "SHALLOW", message: "m" },
        { code: "LFS_PRESENT", message: "m" },
        { code: "AUTOCRLF", message: "m" },
        { code: "INDEX_CHECKSUM", message: "m" },
      ],
      loading: initialLoading({
        step: "worktree",
        done: 1910,
        total: 2204,
        completed: ["refs", "index"],
        startedAt: Date.now() - 3100,
        phases: { refs: { durationMs: 600, count: 88 }, index: { durationMs: 900, count: 2204 } },
      }),
    });
    const { container } = render(<LoadingScreen />);
    expect(screen.getByText("shallow · LFS · autocrlf")).toBeTruthy();
    expect(screen.getByText("checksum mismatch, retried")).toBeTruthy();
    expect(container.textContent).toContain("4 warnings so far · shown as banners once open");
  });

  it("puts the untracked cap under the running worktree bar", () => {
    seed({
      warnings: [
        { code: "UNTRACKED_CAPPED", message: "More than 5000 untracked files; the list was cut." },
      ],
      loading: initialLoading({
        step: "worktree",
        completed: ["refs", "index"],
        startedAt: Date.now() - 3000,
      }),
    });
    render(<LoadingScreen />);
    expect(screen.getByText("5,000 untracked files listed — the rest will be capped")).toBeTruthy();
  });
});

describe("LoadingScreen slow (L3)", () => {
  it("shows the callout past 8 s, names the reason, and offers both exits", async () => {
    const a = seed({
      warnings: [
        { code: "PACK_LARGE", message: "m" },
        { code: "UNTRACKED_CAPPED", message: "More than 5000 untracked files" },
      ],
      loading: initialLoading({
        step: "worktree",
        completed: ["refs", "index"],
        startedAt: Date.now() - 23_000,
        expectedMs: 6000,
      }),
    });
    const { container } = render(<LoadingScreen />);
    expect(container.textContent).toContain("Taking longer than usual.");
    expect(container.textContent).toContain(
      "This checkout has large packs and a large untracked area.",
    );
    expect(container.textContent).toContain("Everything still runs locally.");
    expect(container.textContent).toContain("Nothing has been written");

    fireEvent.click(screen.getByRole("button", { name: "Skip uncommitted changes" }));
    await waitFor(() => expect(a.openRepo).toHaveBeenCalledTimes(1));
    expect(a.openRepo).toHaveBeenCalledWith(
      { name: "acme-web" },
      {
        id: "r1",
        lastSource: "refs/heads/feat/coupons",
        lastTarget: "refs/heads/main",
        skipWorktree: true,
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
    expect(container.textContent).not.toContain("Taking longer than usual.");
  });

  it("falls back to a generic reason when no warning explains the wait", () => {
    seed({
      loading: initialLoading({
        step: "worktree",
        completed: ["refs", "index"],
        startedAt: Date.now() - 12_000,
      }),
    });
    const { container } = render(<LoadingScreen />);
    expect(container.textContent).toContain("This repository is large.");
  });
});

describe("LoadingScreen failure (L4)", () => {
  function seedFailed(code: "INDEX_UNSUPPORTED" | "PERMISSION") {
    return seed({
      error: { code, message: "engine says" },
      loading: initialLoading({
        step: "index",
        completed: ["refs"],
        startedAt: Date.now() - 1900,
        phases: { refs: { durationMs: 300, count: 412 }, index: { durationMs: 100 } },
        failed: { code, message: "engine says" },
        failedStep: "index",
      }),
    });
  }

  it("marks the phase, stops the clock and retries with the remembered pair", async () => {
    const a = seedFailed("INDEX_UNSUPPORTED");
    const { container } = render(<LoadingScreen />);
    expect(screen.getAllByLabelText("failed").length).toBe(1);
    expect(screen.getAllByLabelText("done").length).toBe(1);
    expect(screen.getAllByLabelText("pending").length).toBe(2);
    expect(screen.queryByLabelText("in progress")).toBeNull();
    expect(container.textContent).toContain("Unsupported index format · INDEX_UNSUPPORTED");
    expect(container.textContent).toContain("stopped");
    expect(container.textContent).toContain("format version diffgit cannot parse");
    expect(container.querySelector("code")?.textContent).toBe(".git/index");
    expect(stepStatus(useStore.getState().loading, "index")).toBe("failed");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(a.openRepo).toHaveBeenCalledTimes(1));
    expect(a.openRepo).toHaveBeenCalledWith(
      { name: "acme-web" },
      { id: "r1", lastSource: "refs/heads/feat/coupons", lastTarget: "refs/heads/main" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose another folder" }));
    expect(a.closeRepo).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to start" }));
    expect(a.closeRepo).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("copies the report and flips the label back after 1.5 s", async () => {
    seedFailed("INDEX_UNSUPPORTED");
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<LoadingScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(writeText.mock.calls[0]?.[0]).toContain("code: INDEX_UNSUPPORTED");
  });

  it("PERMISSION offers Grant access; denial shows the inline alert", async () => {
    persistence.ensurePermission.mockResolvedValueOnce("denied");
    const a = seedFailed("PERMISSION");
    render(<LoadingScreen />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(persistence.ensurePermission).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Permission denied"),
    );
    expect(a.openRepo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(a.openRepo).toHaveBeenCalledTimes(1));
  });
});

describe("LoadingScreen restart (L5)", () => {
  it("explains the restart and counts the attempt", () => {
    seed({
      loading: initialLoading({
        step: "refs",
        attempt: 2,
        startedAt: Date.now() - 6400,
        expectedMs: 6000,
      }),
    });
    const { container } = render(<LoadingScreen />);
    expect(container.textContent).toContain("The diff engine stopped and was restarted.");
    expect(container.textContent).toContain("Attempt 2 of 3.");
    expect(container.textContent).toContain("attempt 2 of 3");
    expect(screen.getAllByLabelText("in progress").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("pending").length).toBe(3);
  });
});

describe("LoadingScreen shell", () => {
  it("Escape cancels the open", async () => {
    const a = seed();
    render(<LoadingScreen />);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(a.closeRepo).toHaveBeenCalledTimes(1));
  });

  it("snapshots L1 and L4 in both themes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_004_200); // 4.2 s after the open started
    seed({
      loading: initialLoading({
        step: "worktree",
        done: 1240,
        total: 5000,
        completed: ["refs", "index"],
        startedAt: 1_700_000_000_000,
        expectedMs: 6000,
        phases: {
          refs: { durationMs: 300, count: 412 },
          index: { durationMs: 400, count: 8120 },
        },
      }),
    });
    snapshotBothThemes("loading L1", <LoadingScreen />);
    seed({
      error: { code: "INDEX_UNSUPPORTED", message: "engine says" },
      loading: initialLoading({
        step: "index",
        completed: ["refs"],
        startedAt: 1_700_000_002_300, // 1.9 s before the frozen clock
        phases: { refs: { durationMs: 300, count: 412 }, index: { durationMs: 100 } },
        failed: { code: "INDEX_UNSUPPORTED", message: "engine says" },
        failedStep: "index",
      }),
    });
    snapshotBothThemes("loading L4", <LoadingScreen />);
  });

  it("has no serious or critical axe issues in L1 and L4", async () => {
    seed({
      loading: initialLoading({
        step: "worktree",
        done: 1240,
        total: 5000,
        completed: ["refs", "index"],
        startedAt: Date.now() - 4200,
        expectedMs: 6000,
        phases: {
          refs: { durationMs: 300, count: 412 },
          index: { durationMs: 400, count: 8120 },
        },
      }),
    });
    const l1 = render(<LoadingScreen />);
    expect(await violations(l1.container)).toEqual([]);
    cleanup();

    seed({
      error: { code: "INDEX_UNSUPPORTED", message: "engine says" },
      loading: initialLoading({
        step: "index",
        completed: ["refs"],
        startedAt: Date.now() - 1900,
        phases: { refs: { durationMs: 300, count: 412 }, index: { durationMs: 100 } },
        failed: { code: "INDEX_UNSUPPORTED", message: "engine says" },
        failedStep: "index",
      }),
    });
    const l4 = render(<LoadingScreen />);
    expect(await violations(l4.container)).toEqual([]);
  });
});
