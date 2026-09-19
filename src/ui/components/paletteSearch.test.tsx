/**
 * T11.8 — search scopes in the command palette (Design §14.1 rule 2, atlas tab 05).
 *
 * Everything runs against the recorded `history` fixture through the mock worker client: the
 * `commits` scope is answered live from the recorded walk, and the `worktree` / `pickaxe` scopes
 * from the answers `bun run record` captured, keyed by `searchKey(req)` in
 * `src/engine/search/query.ts` — so the requests this palette builds have to be exactly the ones
 * the engine was recorded answering, or the fixture hands back nothing.
 */
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, DiffSource, SearchRequest } from "../../engine/types";
import historyV2 from "../../test/recorded/history.v2.json";
import { onScrollRequest } from "../scrollBus";
import {
  CAPPED_LINE,
  emptyLine,
  FOOTER_LINE,
  nextWiden,
  occurrencesLabel,
  PICKAXE_COMMITS,
  parseSearch,
  resultsHeading,
  SEARCH_HIT_LIMIT,
  scannedLine,
  widenLabel,
} from "../search";
import { setStoreClient, useStore } from "../store";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { CommandPalette } from "./CommandPalette";
import { WarningBanners } from "./WarningBanners";

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

/** `main~5…main`: the only recorded comparison whose files the grep hits can land in. */
const recordedRange = historyV2.ranges[0] as unknown as { source: DiffSource; result: DiffResult };
const HEAD_OID = "822313f6746d7982943f0d59fc5e09b626769141";

const initial = useStore.getState();
let mock: MockWorkerClient;
/** Every `SearchRequest` the palette sent, so the recorded keys can be asserted directly. */
let requests: SearchRequest[];

beforeEach(() => {
  requests = [];
  const base = createMockWorkerClient();
  mock = {
    ...base,
    search: (req) => {
      requests.push(req);
      return base.search(req);
    },
  } as MockWorkerClient;
  setStoreClient(mock);
  useStore.setState(initial, true);
});

afterEach(() => {
  cleanup();
  setStoreClient(null);
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

/** Opens the recorded `history` repository on the range whose files the grep hits belong to. */
async function openHistory() {
  await useStore.getState().openRepo({ name: "history" }, { id: "hist" });
  useStore.setState({ diff: recordedRange.result, diffSource: recordedRange.source });
}

const input = () => screen.getByPlaceholderText("Type a command or a file…") as HTMLInputElement;
const inPalette = () => within(document.querySelector("dialog.palette-dialog") as HTMLElement);

/** Opens the palette and types `text`, then waits for the debounced search to settle. */
async function type(text: string) {
  fireEvent.keyDown(document, { key: "k", metaKey: true });
  fireEvent.change(input(), { target: { value: text } });
  await waitFor(() => expect(useStore.getState().search.loading).toBe(false));
  await waitFor(() => expect(useStore.getState().search.query).toBe(parseSearch(text)?.query));
}

describe("search.ts — the prefix grammar (T11.8)", () => {
  it("only a prefix turns the box into a search", () => {
    expect(parseSearch("Refresh the diff")).toBeNull();
    expect(parseSearch("")).toBeNull();
    expect(parseSearch(">fix login")).toEqual({
      scope: "commits",
      prefix: ">",
      query: "fix login",
      regex: false,
    });
    expect(parseSearch("grep: applyCoupons")?.scope).toBe("worktree");
    expect(parseSearch("-S applyCoupons")?.scope).toBe("pickaxe");
    // the atlas mockup spells the commit scope `msg:`; the task file spells it `>`
    expect(parseSearch("msg:hopper")?.scope).toBe("commits");
  });

  it("`regex:` after the prefix is the only modifier, and only there", () => {
    expect(parseSearch("grep:regex:mod\\d+")).toEqual({
      scope: "worktree",
      prefix: "grep:",
      query: "mod\\d+",
      regex: true,
    });
    // a literal query is never a pattern, whatever it contains (contracts <!-- T10.8 -->)
    expect(parseSearch("grep:(a|b)*")?.regex).toBe(false);
    expect(parseSearch("grep:say regex: here")?.regex).toBe(false);
  });

  it("widening multiplies the pickaxe range by five and then stops", () => {
    expect(nextWiden(PICKAXE_COMMITS)).toBe(1000);
    expect(nextWiden(1000)).toBe(5000);
    expect(nextWiden(5000)).toBeNull();
    expect(widenLabel(1000)).toBe("Widen ×5 to 1,000 commits");
  });
});

describe("CommandPalette search scopes (Design §14.1, atlas tab 05)", () => {
  it("the footer explains the prefixes and the empty box offers the scopes", () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(inPalette().getByText(FOOTER_LINE)).toBeTruthy();
    for (const label of ["Search commits", "Search working tree", "Search history contents"]) {
      expect(inPalette().getByText(label), label).toBeTruthy();
    }
    // choosing a scope arms the box with its prefix and leaves the palette open
    fireEvent.click(inPalette().getByText("Search working tree"));
    expect(input().value).toBe("grep:");
    expect(useStore.getState().palette).toBe(true);
  });

  it("`>` searches commits live and Enter selects the hit in History mode", async () => {
    await openHistory();
    render(<CommandPalette />);
    await type(">extend mod4");

    expect(requests.at(-1)).toEqual({
      scope: "commits",
      query: "extend mod4",
      limit: SEARCH_HIT_LIMIT,
    });
    const result = useStore.getState().search.result;
    if (!result) throw new Error("no result");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(inPalette().getByText(resultsHeading("commits", result.hits.length))).toBeTruthy();
    expect(inPalette().getByText("c59: extend mod4")).toBeTruthy();
    expect(inPalette().getByText(scannedLine("commits", result))).toBeTruthy();

    fireEvent.click(inPalette().getByText("c59: extend mod4"));
    expect(useStore.getState().palette).toBe(false);
    expect(useStore.getState().mode).toBe("history");
    await waitFor(() => expect(useStore.getState().history.selected).toBe(HEAD_OID));
  });

  it("an object-name prefix is a commit lookup in the same box", async () => {
    await openHistory();
    render(<CommandPalette />);
    await type(">822313f6");
    expect(inPalette().getByText("c59: extend mod4")).toBeTruthy();
  });

  it("`grep:` searches the working tree and a hit opens its card at the line", async () => {
    await openHistory();
    const jumps: [string, number | undefined][] = [];
    const off = onScrollRequest((id, line) => jumps.push([id, line]));
    render(<CommandPalette />);
    await type("grep:module");

    expect(requests.at(-1)).toEqual({
      scope: "worktree",
      query: "module",
      limit: SEARCH_HIT_LIMIT,
    });
    const result = useStore.getState().search.result;
    if (!result) throw new Error("no result");
    expect(result.hits[0]).toMatchObject({ kind: "file", path: "src/mod1.txt", line: 1 });
    expect(inPalette().getByText("src/mod1.txt:1")).toBeTruthy();

    fireEvent.click(inPalette().getByText("src/mod1.txt:1"));
    const file = recordedRange.result.files.find((f) => f.newPath === "src/mod1.txt");
    if (!file) throw new Error("the recorded range has no src/mod1.txt");
    expect(useStore.getState().mode).toBe("files");
    expect(useStore.getState().activeFileId).toBe(file.id);
    expect(jumps).toEqual([[file.id, 1]]);
    off();
  });

  it("`capped` is one line inside the results and never a banner", async () => {
    await openHistory();
    render(
      <>
        <WarningBanners />
        <CommandPalette />
      </>,
    );
    await type("grep:module");
    // the recorded answer for `module` stopped at the hit limit
    expect(useStore.getState().search.result?.capped).toBe(true);
    expect(inPalette().getByText(CAPPED_LINE)).toBeTruthy();
    expect(useStore.getState().warnings.some((w) => w.code === "SEARCH_CAPPED")).toBe(true);
    expect(screen.queryByText(/Search capped/)).toBeNull();
  });

  it("a hit outside the current comparison says so instead of opening nothing", async () => {
    await openHistory();
    render(<CommandPalette />);
    await type("grep:guide note");
    expect(useStore.getState().search.result?.hits).toHaveLength(8);
    fireEvent.click(inPalette().getByText("docs/guide.md:4"));
    expect(useStore.getState().activeFileId).toBeNull();
    expect(useStore.getState().toasts.at(-1)?.message).toContain("docs/guide.md");
  });

  it("the file filter's path part scopes the search", async () => {
    await openHistory();
    useStore.getState().setFilter("status:M src");
    render(<CommandPalette />);
    await type("grep:hot");
    expect(requests.at(-1)).toEqual({
      scope: "worktree",
      query: "hot",
      limit: SEARCH_HIT_LIMIT,
      path: "src",
    });
    expect(useStore.getState().search.result?.hits).toHaveLength(60);
    expect(useStore.getState().search.path).toBe("src");
  });

  it("`-S` is the pickaxe over 200 commits, with the occurrence delta and a widen row", async () => {
    await openHistory();
    render(<CommandPalette />);
    await type("-S module");

    expect(requests.at(-1)).toEqual({
      scope: "pickaxe",
      query: "module",
      limit: SEARCH_HIT_LIMIT,
      commits: PICKAXE_COMMITS,
    });
    const result = useStore.getState().search.result;
    if (!result) throw new Error("no result");
    expect(result.hits).toHaveLength(33);
    expect(inPalette().getByText(resultsHeading("pickaxe", 33))).toBeTruthy();
    expect(inPalette().getAllByText(occurrencesLabel(5)).length).toBeGreaterThan(0);

    fireEvent.click(inPalette().getByText(widenLabel(1000)));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual({
      scope: "pickaxe",
      query: "module",
      limit: SEARCH_HIT_LIMIT,
      commits: 1000,
    });
    expect(useStore.getState().search.commits).toBe(1000);
  });

  it("a query with no match says so", async () => {
    await openHistory();
    render(<CommandPalette />);
    await type("grep:zzzznothing");
    expect(useStore.getState().search.result?.hits).toHaveLength(0);
    expect(inPalette().getByText(emptyLine("worktree", "zzzznothing"))).toBeTruthy();
  });

  it("a regex that does not compile is reported in the list, not thrown", async () => {
    await openHistory();
    render(<CommandPalette />);
    // the commits scope is the one the mock runs live, so it is the one that compiles the pattern
    await type(">regex:(unclosed");
    expect(requests.at(-1)).toMatchObject({ scope: "commits", regex: true });
    const error = useStore.getState().search.error;
    expect(error?.code).toBe("INTERNAL");
    expect(inPalette().getByText(/not a valid regular expression/)).toBeTruthy();
  });

  it("Escape cancels the running search first and closes the palette next", async () => {
    await openHistory();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setStoreClient({
      ...mock,
      search: async (req) => {
        await gate;
        return mock.search(req);
      },
    } as MockWorkerClient);
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    fireEvent.change(input(), { target: { value: "grep:module" } });
    await waitFor(() => expect(useStore.getState().search.loading).toBe(true));

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(useStore.getState().search.loading).toBe(false);
    expect(useStore.getState().palette).toBe(true);
    expect(input().value).toBe("grep:");

    // the answer that was already in flight lands nowhere
    release();
    await Promise.resolve();
    expect(useStore.getState().search.result).toBeNull();

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(useStore.getState().palette).toBe(false);
  });

  it("a newer query supersedes the one before it", async () => {
    await openHistory();
    const slow = vi.fn(async (req: SearchRequest) => {
      if (req.query === "module") await new Promise((r) => setTimeout(r, 30));
      return mock.search(req);
    });
    setStoreClient({ ...mock, search: slow } as MockWorkerClient);
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const store = useStore.getState();
    const first = store.runSearch({ scope: "worktree", query: "module", regex: false });
    const second = store.runSearch({ scope: "worktree", query: "guide note", regex: false });
    await Promise.all([first, second]);
    expect(useStore.getState().search.query).toBe("guide note");
    expect(useStore.getState().search.result?.hits).toHaveLength(8);
  });

  it("closing the palette forgets the search", async () => {
    await openHistory();
    render(<CommandPalette />);
    await type("grep:module");
    expect(useStore.getState().search.result).not.toBeNull();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(useStore.getState().palette).toBe(false);
    expect(useStore.getState().search.result).toBeNull();
    expect(useStore.getState().search.scope).toBeNull();
  });

  it("is axe-clean with results in both themes", async () => {
    await openHistory();
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      render(<CommandPalette />);
      await type("-S module");
      const dialog = document.querySelector("dialog.palette-dialog") as HTMLElement;
      const results = await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      useStore.getState().setPalette(false);
      cleanup();
    }
  });
});
