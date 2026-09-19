import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import basic from "../../test/recorded/showcase.repoinfo.json";
import type { GateWindow } from "../browserGate";
import { collectSnapshot, type SnapshotInputFile } from "../fs/memoryDirHandle";
import { Lru } from "../lru";
import {
  DEFAULT_PREFS,
  type RefreshHooks,
  type StoreState,
  setRefreshHooks,
  setStoreClient,
  useStore,
} from "../store";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { BrowserGate, canReadOnce } from "./BrowserGate";
import { CommandPalette } from "./CommandPalette";
import { RefreshControl } from "./RefreshControl";
import { StatsRow } from "./StatsRow";

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
const recorded = basicDiff as unknown as DiffResult;
const initial = useStore.getState();

const FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** A window-like object; `showDirectoryPicker` present or absent is the whole question here. */
function win(ua: string, withPicker: boolean): GateWindow {
  return {
    navigator: { userAgent: ua },
    isSecureContext: true,
    location: { href: "https://diffgit.com/", host: "diffgit.com", hostname: "diffgit.com" },
    ...(withPicker ? { showDirectoryPicker: () => undefined } : {}),
  };
}

/** One `File`-shaped entry of a picked folder; nothing here is ever read in these tests. */
function file(path: string, text = "x"): SnapshotInputFile {
  const bytes = new TextEncoder().encode(text);
  return {
    name: path.split("/").pop() ?? "",
    size: bytes.byteLength,
    lastModified: 1,
    webkitRelativePath: path,
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
  };
}

const FILES = [
  file("showcase/.git/HEAD", "ref: refs/heads/main\n"),
  file("showcase/README.md", "# showcase"),
];

let mock: MockWorkerClient;

beforeEach(() => {
  mock = createMockWorkerClient();
  setStoreClient(mock);
  useStore.setState(initial, true);
});

afterEach(() => {
  cleanup();
  setRefreshHooks(null);
  setStoreClient(null);
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

/** Serious / critical axe violations; contrast is `contrast.test.ts`'s job. */
async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    resultTypes: ["violations"],
  });
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => v.id);
}

describe("the gate's read-once offer (Design §14.6)", () => {
  it("is shown on an engine without showDirectoryPicker", () => {
    render(
      <BrowserGate win={win(FIREFOX, false)}>
        <p>the app</p>
      </BrowserGate>,
    );
    expect(screen.getByLabelText("Open a repository once")).toBeTruthy();
    expect(screen.queryByText("the app")).toBeNull();
  });

  it("is not shown at all when the picker exists — the palette owns it there", () => {
    render(
      <BrowserGate win={win(CHROME, true)}>
        <p>the app</p>
      </BrowserGate>,
    );
    expect(screen.getByText("the app")).toBeTruthy();
    expect(screen.queryByLabelText("Open a repository once")).toBeNull();
  });

  it("offers it only for the engines that have no picker at all", () => {
    expect(canReadOnce("firefox")).toBe(true);
    expect(canReadOnce("safari")).toBe(true);
    expect(canReadOnce("unknown")).toBe(true);
    expect(canReadOnce("old")).toBe(true);
    for (const cause of ["mobile", "insecure", "iframe", "policy"] as const)
      expect(canReadOnce(cause)).toBe(false);
  });

  it("steps aside once the folder has been read", () => {
    useStore.setState({ snapshotMode: true });
    render(
      <BrowserGate win={win(FIREFOX, false)}>
        <p>the app</p>
      </BrowserGate>,
    );
    expect(screen.getByText("the app")).toBeTruthy();
  });

  it("opens the repository from the file input and never asks the picker", async () => {
    const openRepo = vi.fn(async () => {});
    useStore.setState({ openRepo });
    const { container } = render(
      <BrowserGate win={win(FIREFOX, false)}>
        <p>the app</p>
      </BrowserGate>,
    );
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    expect(input.webkitdirectory).toBe(true);
    Object.defineProperty(input, "files", { value: FILES, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(openRepo).toHaveBeenCalled());
    const [handle, opts] = openRepo.mock.calls[0] as unknown as [
      { name: string; entries: { path: string }[] },
      { id: string },
    ];
    expect(handle.name).toBe("showcase");
    expect(opts.id).toBe("showcase");
    expect(handle.entries.map((e) => e.path)).toEqual([".git/HEAD", "README.md"]);
  });

  it("has no serious or critical axe violations in either theme", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      const { container } = render(
        <BrowserGate win={win(FIREFOX, false)}>
          <p>the app</p>
        </BrowserGate>,
      );
      expect(await violations(container)).toEqual([]);
      cleanup();
    }
  });
});

describe("snapshot mode in the repo screen", () => {
  function seed(over: Partial<StoreState> = {}) {
    useStore.setState(
      {
        ...initial,
        screen: "repo",
        repo,
        repoId: "showcase",
        handle: { name: "showcase" },
        diffSource: {
          kind: "branches",
          source: "feature",
          target: "main",
          sourceRef: "refs/heads/feature",
          targetRef: "refs/heads/main",
          includeWorktree: true,
        },
        diff: recorded,
        prefs: DEFAULT_PREFS,
        fileDiffs: new Lru(200),
        ...over,
      },
      true,
    );
  }

  it("StatsRow wears the tag with the time the folder was read", () => {
    // 2026-09-19T14:02 local time
    const readAt = new Date(2026, 8, 19, 14, 2).getTime();
    seed({ snapshotMode: true, snapshotReadAt: readAt });
    render(<StatsRow />);
    const tag = screen.getByTestId("snapshot-tag");
    expect(tag.textContent).toContain("Snapshot mode");
    expect(tag.textContent).toContain("read at 14:02");
    expect(screen.getByRole("button", { name: "Re-open to refresh" })).toBeTruthy();
  });

  it("StatsRow wears nothing when the repository was opened with a handle", () => {
    seed();
    render(<StatsRow />);
    expect(screen.queryByTestId("snapshot-tag")).toBeNull();
  });

  it("has no serious or critical axe violations in either theme", async () => {
    seed({ snapshotMode: true, snapshotReadAt: Date.now() });
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      const { container } = render(<StatsRow />);
      expect(await violations(container)).toEqual([]);
      cleanup();
    }
  });

  it("hides the Live dot and word", () => {
    const { rerender } = render(
      <RefreshControl mode="live" busy={false} lastAt={null} onRefresh={() => {}} />,
    );
    expect(screen.getByText("Live")).toBeTruthy();
    rerender(
      <RefreshControl mode="live" busy={false} lastAt={null} hideMode onRefresh={() => {}} />,
    );
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-label")).not.toContain("Live");
  });
});

describe("the palette action (how Chromium exercises snapshot mode)", () => {
  it("offers `Open once (snapshot)` and asks for a folder through a webkitdirectory input", async () => {
    useStore.setState({ palette: true, prefs: DEFAULT_PREFS });
    render(<CommandPalette />);
    const row = await screen.findByText("Open once (snapshot)");
    fireEvent.click(row);
    await waitFor(() =>
      expect(document.querySelector("input[type=file]") as HTMLInputElement | null).toBeTruthy(),
    );
    const input = document.querySelector("input[type=file]") as HTMLInputElement;
    expect(input.webkitdirectory).toBe(true);
    input.remove();
  });
});

describe("opening a snapshot (store)", () => {
  function hooks(): RefreshHooks & { start: ReturnType<typeof vi.fn> } {
    const h = { start: vi.fn(), stop: vi.fn(), request: vi.fn() };
    setRefreshHooks(h);
    return h;
  }

  it("starts no scheduler, remembers nothing and raises SNAPSHOT_MODE", async () => {
    const h = hooks();
    const snapshot = await collectSnapshot(FILES, { now: () => 1_700_000_000_000 });
    await useStore.getState().openRepo(snapshot, { id: snapshot.name });
    const s = useStore.getState();
    expect(s.screen).toBe("repo");
    expect(s.snapshotMode).toBe(true);
    expect(s.snapshotReadAt).toBe(1_700_000_000_000);
    expect(s.warnings.map((w) => w.code)).toContain("SNAPSHOT_MODE");
    expect(h.start).not.toHaveBeenCalled();
    expect(s.refresh.mode).toBe("manual");
  });

  it("still starts the scheduler for a real directory handle", async () => {
    const h = hooks();
    await useStore.getState().openRepo({ name: "showcase" }, { id: "showcase" });
    const s = useStore.getState();
    expect(s.snapshotMode).toBe(false);
    expect(s.snapshotReadAt).toBeNull();
    expect(s.warnings.map((w) => w.code)).not.toContain("SNAPSHOT_MODE");
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the banner when a refresh replaces RepoInfo", async () => {
    hooks();
    await useStore.getState().openRepo(await collectSnapshot(FILES), { id: "showcase" });
    // what the scheduler's `reloadRefs()` does: a fresh RepoInfo that knows nothing about snapshots
    const fresh = useStore.getState().repo as RepoInfo;
    useStore.setState({ repo: { ...fresh, warnings: [] } });
    await useStore.getState().recompute("manual");
    expect(useStore.getState().warnings.map((w) => w.code)).toContain("SNAPSHOT_MODE");
  });

  it("forgets the snapshot when the repository is closed", async () => {
    hooks();
    await useStore.getState().openRepo(await collectSnapshot(FILES), { id: "showcase" });
    await useStore.getState().closeRepo();
    expect(useStore.getState().snapshotMode).toBe(false);
    expect(useStore.getState().snapshotReadAt).toBeNull();
  });
});
