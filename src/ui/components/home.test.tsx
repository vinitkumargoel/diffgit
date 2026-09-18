import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredRepo } from "../persistence";
import { setStoreClient, useStore } from "../store";
import { createMockWorkerClient } from "../workerClient.mock";
import { BrowserGate, supportsFileSystemAccess } from "./BrowserGate";
import { HomeScreen } from "./HomeScreen";
import { LoadingScreen, stepStatus } from "./LoadingScreen";
import { RecentRepoList } from "./RecentRepoList";

const repos: StoredRepo[] = [
  {
    id: "r1",
    name: "diffgoel",
    handle: { name: "showcase" } as unknown as FileSystemDirectoryHandle,
    lastOpenedAt: Date.now() - 3 * 3600 * 1000,
    lastTarget: "refs/heads/main",
  },
  {
    id: "r2",
    name: "other",
    handle: { name: "other" } as unknown as FileSystemDirectoryHandle,
    lastOpenedAt: Date.now() - 60 * 1000,
  },
];

const persistence = vi.hoisted(() => ({
  listRepos: vi.fn(async (): Promise<StoredRepo[]> => []),
  upsertRepo: vi.fn(async (h: { name: string }) => ({
    id: "new",
    name: h.name,
    handle: h,
    lastOpenedAt: 1,
  })),
  removeRepo: vi.fn(async () => {}),
  ensurePermission: vi.fn(async (): Promise<"granted" | "denied"> => "granted"),
}));
vi.mock("../persistence", () => persistence);

const initial = useStore.getState();
beforeEach(() => {
  setStoreClient(createMockWorkerClient());
  useStore.setState(initial, true);
  persistence.listRepos.mockResolvedValue(repos);
  persistence.ensurePermission.mockResolvedValue("granted");
});
afterEach(() => {
  cleanup();
  setStoreClient(null);
  (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;
});

describe("BrowserGate", () => {
  it("renders the notice when showDirectoryPicker is missing, children when present", () => {
    expect(supportsFileSystemAccess({})).toBe(false);
    expect(supportsFileSystemAccess({ showDirectoryPicker: () => {} })).toBe(true);
    const { unmount } = render(
      <BrowserGate>
        <p>child</p>
      </BrowserGate>,
    );
    expect(screen.getByText("This browser can't open local folders")).toBeTruthy();
    expect(screen.queryByText("child")).toBeNull();
    unmount();
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = () => {};
    render(
      <BrowserGate>
        <p>child</p>
      </BrowserGate>,
    );
    expect(screen.getByText("child")).toBeTruthy();
  });
});

describe("HomeScreen", () => {
  it("lists recents from persistence and opens one after a permission check", async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByText("diffgoel")).toBeTruthy());
    expect(screen.getByText("opened 3 h ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open diffgoel" }));
    await waitFor(() => expect(useStore.getState().screen).toBe("repo"));
    expect(persistence.ensurePermission).toHaveBeenCalledWith(repos[0]?.handle);
    expect(useStore.getState().repoId).toBe("r1");
    expect(useStore.getState().diffSource?.targetRef).toBe("refs/heads/main");
  });

  it("cancelling the picker (AbortError) shows nothing; success opens the repo read-only", async () => {
    const pick = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = pick;
    render(<HomeScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Open repository/ }));
    await waitFor(() => expect(pick).toHaveBeenCalledWith({ mode: "read", id: "diffgit-repo" }));
    expect(useStore.getState().toasts).toEqual([]);
    expect(useStore.getState().screen).toBe("home");

    pick.mockImplementation(async () => ({ name: "showcase" }) as never);
    fireEvent.click(screen.getByRole("button", { name: /Open repository/ }));
    await waitFor(() => expect(useStore.getState().screen).toBe("repo"));
    expect(persistence.upsertRepo).toHaveBeenCalled();
    expect(useStore.getState().repoId).toBe("new");
  });

  it("other picker errors surface as a toast", async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      throw new Error("kaboom");
    };
    render(<HomeScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Open repository/ }));
    await waitFor(() => expect(useStore.getState().toasts.length).toBe(1));
    expect(useStore.getState().toasts[0]?.message).toContain("kaboom");
  });

  it("`o` opens the picker, but not while typing in an input", async () => {
    const pick = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = pick;
    render(
      <>
        <HomeScreen />
        <input aria-label="typing" />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("typing"), { key: "o" });
    expect(pick).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "o" });
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(1));
  });
});

describe("RecentRepoList", () => {
  it("Enter opens, denied shows the inline message, remove calls back", async () => {
    const onOpen = vi.fn(async () => "denied" as const);
    const onRemove = vi.fn();
    render(<RecentRepoList repos={repos} onOpen={onOpen} onRemove={onRemove} now={Date.now()} />);
    const row = screen.getByRole("button", { name: "Open other" });
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(repos[1]));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Permission denied"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove other from recent repositories" }));
    expect(onRemove).toHaveBeenCalledWith(repos[1]);
    expect(screen.getByText("opened 1 min ago")).toBeTruthy();
  });
});

describe("LoadingScreen", () => {
  it("shows done / current / pending phases with counts and cancels", async () => {
    useStore.setState({
      screen: "loading",
      loading: { step: "worktree", done: 1240, total: 5000, completed: ["refs", "index"] },
    });
    render(<LoadingScreen repoName="basic" />);
    expect(screen.getByText("basic")).toBeTruthy();
    expect(screen.getAllByLabelText("done").length).toBe(2);
    expect(screen.getAllByLabelText("in progress").length).toBe(1);
    expect(screen.getAllByLabelText("pending").length).toBe(1);
    expect(screen.getByText("1,240 / 5,000")).toBeTruthy();
    expect(stepStatus(useStore.getState().loading, "diff")).toBe("pending");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(useStore.getState().screen).toBe("home"));
  });
});
