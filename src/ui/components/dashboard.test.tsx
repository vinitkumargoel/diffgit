/**
 * T11.11 — the Home dashboard (Design §14.6, atlas tab 11): the RepoCard grid and the background
 * summariser behind it, against the recorded fixtures through the mock worker. Every number on a
 * card came out of the real engine once (`bun run record` writes `summary` into `<fixture>.v2.json`,
 * T10.10); the handle's `name` is what the mock serves the recording under.
 */
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoSummary } from "../../engine/types";
import historyV2 from "../../test/recorded/history.v2.json";
import type { PermissionAnswer, StoredRepo } from "../persistence";
import { derivedKey, getDerived, resetDerivedStore, setDerived } from "../persistence/derived";
import {
  EMPTY_DASHBOARD_ENTRY,
  INITIAL_DASHBOARD,
  setStoreClient,
  setSummaryClientFactory,
  useStore,
} from "../store";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { HomeScreen } from "./HomeScreen";
import { RepoCard } from "./home/RepoCard";

const NOW = Date.now();
const recorded = historyV2.summary as unknown as RepoSummary;

/** A stored repository whose handle name picks the recording the mock serves. */
function stored(id: string, fixture: string, patch: Partial<StoredRepo> = {}): StoredRepo {
  return {
    id,
    name: fixture,
    handle: { name: fixture } as unknown as FileSystemDirectoryHandle,
    lastOpenedAt: NOW - 3600_000,
    lastSource: "refs/heads/feat/tokens",
    ...patch,
  };
}

/** A handle the cheap stat can answer for: `.git/index` with this `lastModified`. */
function withIndex(repo: StoredRepo, lastModified: number): StoredRepo {
  return {
    ...repo,
    handle: {
      name: (repo.handle as unknown as { name: string }).name,
      getDirectoryHandle: async () => ({
        getFileHandle: async () => ({ getFile: async () => ({ lastModified }) }),
      }),
    } as unknown as FileSystemDirectoryHandle,
  };
}

const persistence = vi.hoisted(() => ({
  listRepos: vi.fn(async (): Promise<StoredRepo[]> => []),
  upsertRepo: vi.fn(async () => ({ id: "new", name: "new", handle: {}, lastOpenedAt: 1 })),
  removeRepo: vi.fn(async () => {}),
  ensurePermission: vi.fn(async (): Promise<"granted" | "denied"> => "granted"),
  queryPermission: vi.fn(async (_h: unknown): Promise<PermissionAnswer> => "granted"),
}));
vi.mock("../persistence", () => persistence);

/**
 * What `queryPermission` answers for every handle but the decoy. One stored repository is the
 * Continue card (H1), so a test about *one* card still needs a second repository to make the grid;
 * the decoy is always `denied`, which is exactly the state the summariser must skip.
 */
let access: PermissionAnswer = "granted";
const decoy = (): StoredRepo => stored("rz", "decoy", { name: "decoy" });

/** Every throw-away session the store asks for, in the order it asked. */
let sessions: { fixture: string; open: number }[] = [];
let liveSessions = 0;
let maxLiveSessions = 0;
let terminated = 0;

function trackingFactory(): MockWorkerClient {
  const client = createMockWorkerClient();
  // A session that resolves in one tick cannot be caught halfway; 3 ms makes the sweep observable.
  client.latency = 3;
  const open = client.open.bind(client);
  const close = client.close.bind(client);
  const terminate = client.terminate.bind(client);
  client.open = async (handle, sink, opts) => {
    sessions.push({ fixture: (handle as { name: string }).name, open: ++liveSessions });
    maxLiveSessions = Math.max(maxLiveSessions, liveSessions);
    return open(handle, sink, opts);
  };
  client.close = async () => {
    liveSessions--;
    return close();
  };
  client.terminate = () => {
    terminated++;
    terminate();
  };
  return client;
}

const initial = useStore.getState();
let derivedSeq = 0;

beforeEach(() => {
  derivedSeq++;
  resetDerivedStore(`dashboard-derived-${derivedSeq}`);
  useStore.setState(initial, true);
  sessions = [];
  liveSessions = 0;
  maxLiveSessions = 0;
  terminated = 0;
  setSummaryClientFactory(trackingFactory);
  access = "granted";
  persistence.listRepos.mockResolvedValue([]);
  persistence.queryPermission.mockImplementation(async (h: unknown) =>
    (h as { name?: string })?.name === "decoy" ? "denied" : access,
  );
  persistence.ensurePermission.mockResolvedValue("granted");
});

afterEach(() => {
  cleanup();
  setSummaryClientFactory(null);
  setStoreClient(null);
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

/** Renders Home with this history and waits for the card grid. */
async function renderHome(list: StoredRepo[]) {
  persistence.listRepos.mockResolvedValue(list);
  const view = render(<HomeScreen />);
  await screen.findByRole("region", { name: "Recent repositories" });
  return view;
}

const card = (name: string) =>
  screen.getByRole("button", { name: `Open ${name}` }).closest("[data-repo-card]") as HTMLElement;

/** `waitFor` polls every 50 ms by default, which is longer than a whole sweep. */
const tick = { interval: 1 } as const;

const fixtures = () => sessions.map((s) => s.fixture);

describe("RepoCard grid (Design §14.6)", () => {
  it("shows the branch, the counts, the operation and the last commit of every card", async () => {
    await renderHome([stored("r1", "worktree"), stored("r2", "rebase-conflict")]);

    // `worktree`: five staged, three unstaged and two untracked rows on `feature`
    await waitFor(() => expect(within(card("worktree")).getByText("5 staged")).toBeTruthy());
    const wt = card("worktree");
    expect(within(wt).getByText("feature")).toBeTruthy();
    expect(within(wt).getByText("3 unstaged")).toBeTruthy();
    expect(within(wt).getByText("2 untracked")).toBeTruthy();

    // `rebase-conflict`: detached mid-rebase, two conflicted paths, its own operation tag
    await waitFor(() =>
      expect(within(card("rebase-conflict")).getByText("2 conflicts")).toBeTruthy(),
    );
    const rb = card("rebase-conflict");
    expect(within(rb).getByText("rebase 2/3")).toBeTruthy();
    expect(within(rb).getByText("HEAD (detached @ 218d022)")).toBeTruthy();
    expect(within(rb).getByText(/^last commit /)).toBeTruthy();
  });

  it("a repository with nothing uncommitted reads `clean`, with its upstream state", async () => {
    await renderHome([stored("r1", "history"), decoy()]);
    await waitFor(() => expect(within(card("history")).getByText("clean")).toBeTruthy());
    const c = card("history");
    expect(within(c).getByText("main")).toBeTruthy();
    // the recorded `history` fixture has no remote, so the summary's `vsUpstream` is null
    expect(within(c).getByText("no upstream")).toBeTruthy();
  });

  it("renders ahead/behind vs upstream, capped counts included", () => {
    const summary: RepoSummary = {
      ...recorded,
      headBranch: "feat/coupons",
      headDisplay: "feat/coupons",
      vsUpstream: { ahead: 4, behind: 0, mergeBase: null, capped: false },
    };
    const { rerender } = render(
      <RepoCard
        repo={stored("r1", "acme-web")}
        access="granted"
        state="idle"
        entry={{ ...EMPTY_DASHBOARD_ENTRY, summary, mtime: summary.indexMtimeMs }}
        now={NOW}
        onOpen={() => {}}
        onGrant={() => {}}
        onForget={() => {}}
        onUndo={() => {}}
        onChoose={() => {}}
      />,
    );
    expect(screen.getByText("4 ↑ 0 ↓")).toBeTruthy();
    rerender(
      <RepoCard
        repo={stored("r1", "acme-web")}
        access="granted"
        state="idle"
        entry={{
          ...EMPTY_DASHBOARD_ENTRY,
          summary: {
            ...summary,
            vsUpstream: { ahead: 4, behind: 0, mergeBase: null, capped: true },
          },
        }}
        now={NOW}
        onOpen={() => {}}
        onGrant={() => {}}
        onForget={() => {}}
        onUndo={() => {}}
        onChoose={() => {}}
      />,
    );
    expect(screen.getByText("≥4 ↑ ≥0 ↓")).toBeTruthy();
  });

  it("is axe-clean in both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      const { container } = await renderHome([
        stored("r1", "worktree"),
        stored("r2", "rebase-conflict"),
      ]);
      await waitFor(() => expect(within(card("worktree")).getByText("5 staged")).toBeTruthy());
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});

describe("the background summariser (atlas tab 11)", () => {
  it("shows the cached summary immediately and never reads a `prompt` repository", async () => {
    access = "prompt";
    await setDerived(derivedKey.summary("r1"), { ...recorded, indexMtimeMs: 5 });
    await renderHome([stored("r1", "history"), decoy()]);

    // the card is filled from `diffgit-derived` alone: no session was opened for it
    await waitFor(() => expect(within(card("history")).getByText("clean")).toBeTruthy());
    expect(within(card("history")).getByText("needs permission")).toBeTruthy();
    expect(sessions).toEqual([]);
  });

  it("reads the repositories one at a time, in the order of the cards", async () => {
    await renderHome([
      stored("r1", "worktree"),
      stored("r2", "rebase-conflict"),
      stored("r3", "history"),
    ]);
    await waitFor(() => expect(fixtures()).toHaveLength(3), tick);
    expect(fixtures()).toEqual(["worktree", "rebase-conflict", "history"]);
    // one throw-away session at a time, each closed and terminated after its summary
    expect(maxLiveSessions).toBe(1);
    await waitFor(() => expect(terminated).toBe(3));
    expect(liveSessions).toBe(0);
  });

  it("writes what it read into `diffgit-derived`", async () => {
    await renderHome([stored("r1", "history"), decoy()]);
    await waitFor(async () =>
      expect(await getDerived<RepoSummary>(derivedKey.summary("r1"))).toBeTruthy(),
    );
    expect((await getDerived<RepoSummary>(derivedKey.summary("r1")))?.headDisplay).toBe("main");
  });

  it("revalidates only when the index mtime differs from the cached summary", async () => {
    await setDerived(derivedKey.summary("r1"), { ...recorded, indexMtimeMs: 5 });
    const { unmount } = await renderHome([withIndex(stored("r1", "history"), 5), decoy()]);
    await waitFor(() => expect(within(card("history")).getByText("clean")).toBeTruthy());
    // the stat agrees with the cache, so the repository is not opened at all
    expect(sessions).toEqual([]);
    unmount();
    cleanup();

    // the index has moved on under the cache: the card is read again
    await renderHome([withIndex(stored("r1", "history"), 9), decoy()]);
    await waitFor(() => expect(fixtures()).toEqual(["history"]), tick);
  });

  it("marks a card stale when the index has moved past the summary it is showing", async () => {
    // Granted, so the index really is stat-ed — and a handle the engine cannot open, so the card
    // keeps the cached answer and says out loud that it is behind the working tree.
    await setDerived(derivedKey.summary("r1"), { ...recorded, indexMtimeMs: 5 });
    await renderHome([withIndex(stored("r1", "gone"), 9), decoy()]);
    await waitFor(() => expect(within(card("gone")).getByText("stale")).toBeTruthy(), tick);
    expect(within(card("gone")).getByText("clean")).toBeTruthy(); // the cached summary, still shown
    await waitFor(() => expect(within(card("gone")).getByText("Folder not found")).toBeTruthy());
  });

  it("`Refresh all` re-reads every granted repository, cache or no cache", async () => {
    await setDerived(derivedKey.summary("r1"), { ...recorded, indexMtimeMs: 5 });
    await renderHome([withIndex(stored("r1", "history"), 5), decoy()]);
    await waitFor(() => expect(within(card("history")).getByText("clean")).toBeTruthy());
    expect(sessions).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Refresh all/ }));
    await waitFor(() => expect(fixtures()).toEqual(["history"]), tick);
  });

  it("`Re-authorise` grants access without opening the repository, and the card then fills", async () => {
    access = "prompt";
    await renderHome([stored("r1", "history"), decoy()]);
    await waitFor(() => expect(within(card("history")).getByText("needs permission")).toBeTruthy());
    expect(sessions).toEqual([]);

    fireEvent.click(within(card("history")).getByRole("button", { name: "Re-authorise" }));
    await waitFor(() => expect(fixtures()).toEqual(["history"]), tick);
    // granting is not opening: the app stayed on Home
    expect(useStore.getState().screen).toBe("home");
    await waitFor(() => expect(within(card("history")).getByText("clean")).toBeTruthy());
  });

  it("stops when Home goes away, and leaves no card spinning", async () => {
    const { unmount } = await renderHome([
      stored("r1", "worktree"),
      stored("r2", "rebase-conflict"),
      stored("r3", "history"),
    ]);
    await waitFor(() => expect(sessions.length).toBeGreaterThan(0), tick);
    unmount();
    const seen = sessions.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(sessions.length).toBe(seen);
    expect(Object.values(useStore.getState().dashboard.summaries).some((e) => e.loading)).toBe(
      false,
    );
  });

  it("a card that cannot be read says so, and the others still fill", async () => {
    await renderHome([stored("r1", "gone"), stored("r2", "history")]);
    await waitFor(() => expect(within(card("gone")).getByText("Folder not found")).toBeTruthy());
    await waitFor(() => expect(within(card("history")).getByText("clean")).toBeTruthy());
    expect(useStore.getState().dashboard.summaries.r1?.error?.code).toBe("HANDLE_GONE");
    expect(useStore.getState().screen).toBe("home");
    expect(useStore.getState().toasts).toEqual([]);
  });
});

describe("store: the dashboard slice (T11.11)", () => {
  it("summarises nothing for an empty list and leaves the slice alone", async () => {
    await useStore.getState().loadSummaries([]);
    expect(useStore.getState().dashboard).toEqual(INITIAL_DASHBOARD);
    expect(sessions).toEqual([]);
  });

  it("cancelSummaries stops the sweep wherever it is", async () => {
    const repos = ["worktree", "rebase-conflict", "history"].map((f, i) => ({
      id: `r${i}`,
      name: f,
      handle: { name: f },
      access: "granted" as const,
    }));
    const sweep = useStore.getState().loadSummaries(repos);
    await waitFor(() => expect(sessions.length).toBeGreaterThan(0), tick);
    useStore.getState().cancelSummaries();
    await sweep;
    expect(sessions.length).toBeLessThan(3);
    expect(Object.values(useStore.getState().dashboard.summaries).some((e) => e.loading)).toBe(
      false,
    );
  });

  it("opening a repository stops the sweep (the dashboard is never in the way)", async () => {
    setStoreClient(createMockWorkerClient());
    const repos = ["worktree", "rebase-conflict", "history"].map((f, i) => ({
      id: `r${i}`,
      name: f,
      handle: { name: f },
      access: "granted" as const,
    }));
    const sweep = useStore.getState().loadSummaries(repos);
    await waitFor(() => expect(sessions.length).toBeGreaterThan(0), tick);
    useStore.getState().cancelSummaries();
    await useStore.getState().openRepo({ name: "showcase" }, { id: "x" });
    await sweep;
    expect(useStore.getState().screen).toBe("repo");
    expect(sessions.length).toBeLessThan(3);
  });
});
