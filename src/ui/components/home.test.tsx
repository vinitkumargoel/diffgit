import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionAnswer, StoredRepo } from "../persistence";
import { setStoreClient, useStore } from "../store";
import { createMockWorkerClient } from "../workerClient.mock";
import { BrowserGate, supportsFileSystemAccess } from "./BrowserGate";
import { HomeScreen } from "./HomeScreen";

const NOW = Date.now();
const repos: StoredRepo[] = [
  {
    id: "r1",
    name: "diffgoel",
    handle: { name: "showcase" } as unknown as FileSystemDirectoryHandle,
    lastOpenedAt: NOW - 3 * 3600 * 1000,
    lastSource: "refs/heads/feat/coupons",
    lastTarget: "refs/heads/main",
  },
  {
    id: "r2",
    name: "other",
    handle: { name: "other" } as unknown as FileSystemDirectoryHandle,
    lastOpenedAt: NOW - 60 * 1000,
  },
];

/** H3 needs seven or more to grow a filter. */
const many: StoredRepo[] = Array.from({ length: 8 }, (_, i) => ({
  id: `m${i}`,
  name: i === 0 ? "news-scrapper" : `project-${i}`,
  handle: { name: `h${i}` } as unknown as FileSystemDirectoryHandle,
  lastOpenedAt: NOW - (i + 1) * 3600 * 1000,
}));

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
  queryPermission: vi.fn(async (_h: unknown): Promise<PermissionAnswer> => "prompt"),
}));
vi.mock("../persistence", () => persistence);

const initial = useStore.getState();
beforeEach(() => {
  setStoreClient(createMockWorkerClient());
  useStore.setState(initial, true);
  persistence.listRepos.mockResolvedValue([]);
  persistence.ensurePermission.mockResolvedValue("granted");
  persistence.queryPermission.mockResolvedValue("prompt");
  persistence.removeRepo.mockClear();
});
afterEach(() => {
  cleanup();
  setStoreClient(null);
  (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;
});

/** Renders Home and waits until the history column has settled. */
async function renderHome(list: StoredRepo[] = []) {
  persistence.listRepos.mockResolvedValue(list);
  const view = render(<HomeScreen />);
  if (list.length > 0) await screen.findByRole("region", { name: "Recent repositories" });
  else await waitFor(() => expect(persistence.listRepos).toHaveBeenCalled());
  return view;
}

describe("BrowserGate", () => {
  it("renders the notice when showDirectoryPicker is missing, children when present", () => {
    expect(supportsFileSystemAccess({})).toBe(false);
    expect(supportsFileSystemAccess({ showDirectoryPicker: () => {} })).toBe(true);
    const { unmount } = render(
      <BrowserGate>
        <p>child</p>
      </BrowserGate>,
    );
    expect(screen.getByRole("heading", { name: /can't open local folders/ })).toBeTruthy();
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

describe("HomeScreen picker", () => {
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

  it("E5.1: a refused picker toasts the browser's error name with a Retry that reopens it", async () => {
    const pick = vi.fn(async () => {
      throw new DOMException("nope", "NotFoundError");
    });
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = pick;
    render(<HomeScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Open repository/ }));
    await waitFor(() => expect(useStore.getState().toasts.length).toBe(1));
    const toast = useStore.getState().toasts[0];
    expect(toast?.message).toBe(
      "Couldn't open the folder. The browser refused the request (NotFoundError).",
    );
    expect(toast?.action?.label).toBe("Retry");
    toast?.action?.onClick();
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(2));
  });

  it("B6: a SecurityError / NotAllowedError raises the gate instead of a toast", async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      throw new DOMException("blocked", "SecurityError");
    };
    render(<HomeScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Open repository/ }));
    await waitFor(() => expect(useStore.getState().gateCause).toBe("policy"));
    expect(useStore.getState().toasts).toEqual([]);
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

describe("Home history (§s1)", () => {
  it("H0: with no history the facts table stays and nothing else appears", async () => {
    const { container } = await renderHome([]);
    expect(container.querySelector<HTMLElement>("#home-facts")?.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>("#home-side")?.hidden).toBe(true);
    expect(screen.queryByRole("region", { name: "Recent repositories" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Recent" })).toBeNull();
  });

  it("H1: one repository becomes the Continue card, and Forget is undoable", async () => {
    persistence.queryPermission.mockResolvedValue("granted");
    const { container } = await renderHome([repos[0] as StoredRepo]);
    expect(container.querySelector<HTMLElement>("#home-facts")?.hidden).toBe(true);
    const card = screen.getByRole("region", { name: "Recent repositories" });
    expect(within(card).getByText("Continue")).toBeTruthy();
    expect(within(card).getByText("opened 3 h ago")).toBeTruthy();
    expect(within(card).getByText("Last compared")).toBeTruthy();
    expect(within(card).getByText("main")).toBeTruthy();
    expect(within(card).getByText("feat/coupons")).toBeTruthy();
    await waitFor(() => expect(within(card).getByText("granted for this session")).toBeTruthy());
    expect(within(card).getByRole("button", { name: "Open diffgoel" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Different folder" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Forget diffgoel" }));
    expect(screen.getByText("Forgotten")).toBeTruthy();
    expect(persistence.removeRepo).not.toHaveBeenCalled(); // 5 s undo, not a confirm dialog
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Open diffgoel" })).toBeTruthy();
  });

  it("H2: two to six repositories are the hairline list, with the access dot and the legend", async () => {
    persistence.queryPermission.mockImplementation(async (h: unknown) =>
      (h as { name: string }).name === "showcase" ? "granted" : "prompt",
    );
    await renderHome(repos);
    const panel = screen.getByRole("region", { name: "Recent repositories" });
    expect(within(panel).getByText("· 2")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Open diffgoel" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Open other" })).toBeTruthy();
    expect(within(panel).getByText("never compared")).toBeTruthy();
    expect(within(panel).getByText("Stored in this browser only")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Clear all" })).toBeTruthy();
    await waitFor(() =>
      expect(within(panel).getAllByRole("img", { name: "Access granted" }).length).toBe(1),
    );
    expect(within(panel).getAllByRole("img", { name: "Will ask for access" }).length).toBe(1);
  });

  it("H3: seven or more grow a filter that marks matches, counts them and can come up empty", async () => {
    await renderHome(many);
    const panel = screen.getByRole("region", { name: "Recent repositories" });
    const input = within(panel).getByLabelText("Filter recent");
    expect(within(panel).getByText("8 of 8 match")).toBeTruthy();

    fireEvent.change(input, { target: { value: "ne" } });
    expect(within(panel).getByText("1 of 8 match")).toBeTruthy();
    expect(panel.querySelector("mark")?.textContent).toBe("ne");
    expect(within(panel).getByText(/open · /)).toBeTruthy();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(within(panel).getByText("0 of 8 match")).toBeTruthy();
    expect(within(panel).getByText(/No recent repository matches/)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(within(panel).getByText("8 of 8 match")).toBeTruthy();
  });

  it("H4: a denied row says so inline, and Forget/Undo stay on the row", async () => {
    persistence.ensurePermission.mockResolvedValue("denied");
    await renderHome(repos);
    const panel = screen.getByRole("region", { name: "Recent repositories" });
    fireEvent.click(within(panel).getByRole("button", { name: "Open other" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Read access was denied.");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(useStore.getState().screen).toBe("home");
    expect(useStore.getState().toasts).toEqual([]);
  });

  it("H4: HANDLE_GONE / NOT_A_REPO come back as a row message, not the error screen", async () => {
    useStore.setState({
      openRepo: async () => {
        useStore.setState({ screen: "error", error: { code: "NOT_A_REPO", message: "no .git" } });
      },
    });
    await renderHome(repos);
    const panel = screen.getByRole("region", { name: "Recent repositories" });
    fireEvent.click(within(panel).getByRole("button", { name: "Open diffgoel" }));
    await waitFor(() => expect(useStore.getState().screen).toBe("home"));
    expect(useStore.getState().recentNotice).toEqual({ repoId: "r1", code: "NOT_A_REPO" });
  });

  it("H4: a pending recentNotice is shown on its row when Home mounts, then consumed", async () => {
    useStore.setState({ recentNotice: { repoId: "r1", code: "HANDLE_GONE" } });
    await renderHome(repos);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Folder not found — moved, renamed or deleted.");
    expect(within(alert).getByRole("button", { name: "Choose it again" })).toBeTruthy();
    expect(useStore.getState().recentNotice).toBeNull();
  });

  it("H5: the nav Recent popover opens with `r`, closes on Escape, and is hidden with no history", async () => {
    await renderHome(repos);
    expect(screen.queryByText(/Show all/)).toBeNull();
    fireEvent.keyDown(document, { key: "r" });
    const popover = await screen.findByRole("button", { name: "Show all 2 ↑" });
    expect(popover).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recent" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText(/Show all/)).toBeNull());
  });

  it("H6: blocked storage replaces the facts row and never toasts on the landing page", async () => {
    useStore.setState({ storageUnavailable: true });
    const { container } = await renderHome([]);
    await waitFor(() =>
      expect(container.querySelector<HTMLElement>("#home-fact-storage")?.hidden).toBe(false),
    );
    expect(container.querySelector<HTMLElement>("#home-fact-matches")?.hidden).toBe(true);
    expect(screen.getByText("not remembered here")).toBeTruthy();
    expect(screen.getByText("Recent repos")).toBeTruthy();
    expect(useStore.getState().toasts).toEqual([]);
  });
});
