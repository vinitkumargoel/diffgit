import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileDiffPayload } from "../../engine/api";
import type { DiffResult, FileDiff, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/basic.diffresult.json";
import basic from "../../test/recorded/basic.repoinfo.json";
import { Lru } from "../lru";
import { mockHunks, mockPayload } from "../mock/mockContents";
import { syntheticLarge } from "../mock/syntheticLarge";
import { requestScrollTo } from "../scrollBus";
import { DEFAULT_PREFS, type FileDiffEntry, type StoreState, useStore } from "../store";
import { DiffBody } from "./DiffBody";
import { DiffPane } from "./DiffPane";
import { FileCard } from "./FileCard";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}
const rect = { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 800, width: 900, height: 800 };
HTMLElement.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { get: () => 900, configurable: true });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get: () => 800,
  configurable: true,
});

const repo = basic as unknown as RepoInfo;
const diff = basicDiff as unknown as DiffResult;
const byId = (id: string): FileDiff => {
  const f = diff.files.find((x) => x.id === id);
  if (!f) throw new Error(`no recorded file ${id}`);
  return f;
};

function entries(list: [string, FileDiffEntry][]): Lru<string, FileDiffEntry> {
  const lru = new Lru<string, FileDiffEntry>(200);
  for (const [k, v] of list) lru.set(k, v);
  return lru;
}
const ready = (file: FileDiff, loadLarge = false): FileDiffEntry => ({
  status: "ready",
  data: mockPayload(file, 1, false, loadLarge),
});

function seed(overrides: Partial<StoreState> = {}) {
  const a = {
    loadFileDiff: vi.fn(async () => {}),
    cancelFileDiff: vi.fn(),
    setCollapsed: vi.fn(),
    toggleViewed: vi.fn(),
    setPref: vi.fn(),
  };
  useStore.setState({
    screen: "repo",
    repo,
    repoId: "r1",
    diff,
    stats: {},
    viewed: new Set(),
    collapsed: new Set(),
    filter: "",
    activeFileId: null,
    prefs: DEFAULT_PREFS,
    fileDiffs: entries([]),
    ...a,
    ...overrides,
  });
  return a;
}

const card = (file: FileDiff) => <FileCard file={file} index={0} />;

afterEach(cleanup);

describe("FileCard header", () => {
  it("renders per status: rename with similarity, mode change, typechange, chips, stats", () => {
    seed({ stats: { "lib/util.ts": { additions: 2, deletions: 1 } } });
    render(card(byId("lib/util.ts")));
    const header = screen.getByRole("banner");
    expect(header.textContent).toContain("src/util.ts");
    expect(header.textContent).toContain("→");
    expect(header.textContent).toContain("lib/util.ts");
    expect(header.textContent).toContain("(87%)");
    expect(screen.getByRole("img", { name: "Renamed" })).toBeTruthy();
    expect(header.textContent).toContain("+2");
    expect(header.textContent).toContain("−1");
    cleanup();

    seed();
    render(card(byId("scripts/build.sh")));
    expect(screen.getByRole("banner").textContent).toContain("100644 → 100755");
    cleanup();

    seed();
    render(card(byId("src/link")));
    expect(screen.getByRole("banner").textContent).toContain("type changed");
    expect(screen.getByRole("img", { name: "Type changed" })).toBeTruthy();
    cleanup();

    seed();
    render(card(byId("generated/bundle.js")));
    expect(screen.getByRole("img", { name: "Generated file" })).toBeTruthy();
    expect(screen.getByText(/Generated file, click to expand/)).toBeTruthy();
    cleanup();

    seed();
    render(card(byId("data/blob.bin")));
    expect(screen.getByRole("img", { name: "Binary file" })).toBeTruthy();
  });

  it("collapse chevron and Viewed checkbox call the store; a collapsed card has no body", () => {
    const a = seed();
    render(card(byId("docs/guide.md")));
    fireEvent.click(screen.getByRole("button", { name: "Collapse docs/guide.md" }));
    expect(a.setCollapsed).toHaveBeenCalledWith("docs/guide.md", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Viewed" }));
    expect(a.toggleViewed).toHaveBeenCalledWith("docs/guide.md");
    cleanup();

    const b = seed({ collapsed: new Set(["docs/guide.md"]) });
    render(card(byId("docs/guide.md")));
    expect(
      screen.getByRole("button", { name: "Expand docs/guide.md" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(b.loadFileDiff).not.toHaveBeenCalled();
  });
});

describe("FileCard body states", () => {
  it("requests the diff on mount, shows the skeleton, then error with Retry", () => {
    const a = seed();
    render(card(byId("docs/guide.md")));
    expect(a.loadFileDiff).toHaveBeenCalledWith("docs/guide.md");
    expect(screen.getByRole("status", { name: "Loading diff" })).toBeTruthy();
    cleanup();

    const b = seed({
      fileDiffs: entries([
        ["docs/guide.md|x", { status: "error", error: { code: "INTERNAL", message: "boom" } }],
      ]),
    });
    render(card(byId("docs/guide.md")));
    expect(screen.getByText("Couldn't load this diff")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(b.loadFileDiff).toHaveBeenCalledWith("docs/guide.md");
  });

  it("re-requests when the whitespace pref flips (both variants cached separately)", () => {
    const f = byId("docs/guide.md");
    const a = seed({ fileDiffs: entries([["docs/guide.md|x", ready(f)]]) });
    render(card(f));
    expect(a.loadFileDiff).not.toHaveBeenCalled();
    act(() => useStore.setState({ prefs: { ...DEFAULT_PREFS, ignoreWhitespace: true } }));
    expect(a.loadFileDiff).toHaveBeenCalledWith("docs/guide.md");
  });

  it("renders the diff table for a ready payload and 'Expand all' removes hunk headers", async () => {
    const f = byId("docs/guide.md");
    seed({ fileDiffs: entries([["docs/guide.md|x", ready(f)]]) });
    render(card(f));
    const table = await screen.findByRole("table");
    expect(table.querySelectorAll("tr.diff-line").length).toBeGreaterThan(2);
    expect(table.querySelectorAll(".diff-code-insert").length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(table.querySelectorAll(".diff-code-edit").length).toBeGreaterThan(0),
    );
  });

  it("gates tooLarge files behind Load diff and shows notices for binary / submodule", () => {
    const big = byId("src/big-change.txt");
    const a = seed({ fileDiffs: entries([["src/big-change.txt|x", ready(big)]]) });
    render(card(big));
    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    expect(a.loadFileDiff).toHaveBeenCalledWith("src/big-change.txt", { loadLarge: true });
    cleanup();

    const bin = byId("data/blob.bin");
    seed({ fileDiffs: entries([["data/blob.bin|x", ready(bin)]]) });
    render(card(bin));
    expect(screen.getByText("Binary file not shown")).toBeTruthy();
    cleanup();

    const sub = byId("vendor/sub");
    seed({ fileDiffs: entries([["vendor/sub|x", ready(sub)]]) });
    render(card(sub));
    expect(screen.getByText(/^Submodule/)).toBeTruthy();
  });

  it("generated cards start collapsed and open on click", () => {
    const g = byId("generated/bundle.js");
    const a = seed({ fileDiffs: entries([["generated/bundle.js|x", ready(g)]]) });
    render(card(g));
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByText(/Generated file, click to expand/));
    expect(screen.getByRole("table")).toBeTruthy();
    expect(a.loadFileDiff).not.toHaveBeenCalled();
  });
});

describe("DiffBody", () => {
  function payloadFor(
    oldText: string,
    newText: string,
  ): FileDiffPayload & { hunks: NonNullable<FileDiffPayload["hunks"]> } {
    const hunks = mockHunks(oldText, newText);
    return {
      id: "x.ts",
      generation: 1,
      classification: {
        binary: false,
        image: false,
        tooLarge: false,
        huge: false,
        typechange: false,
        submodule: false,
        generated: false,
        whitespaceOnly: false,
        oldSize: oldText.length,
        newSize: newText.length,
      },
      hunks,
      oldText,
      newText,
      language: "typescript",
      stats: { additions: 1, deletions: 1 },
      oldMode: 0o100644,
      newMode: 0o100644,
    } as FileDiffPayload & { hunks: NonNullable<FileDiffPayload["hunks"]> };
  }
  const lines = (n: number, changeAt: number | null) =>
    `${Array.from({ length: n }, (_, i) => (i + 1 === changeAt ? `changed ${i + 1}` : `line ${i + 1}`)).join("\n")}\n`;
  const file: FileDiff = {
    ...byId("src/a.txt"),
    id: "x.ts",
    oldPath: "x.ts",
    newPath: "x.ts",
  };

  it("shows a hunk header with ↑ ↓ all above a gap; ↑ reveals 20 lines; all removes the header", () => {
    const p = payloadFor(lines(60, null), lines(60, 30));
    const { container } = render(
      <DiffBody file={file} payload={p} viewType="unified" expandAllToken={0} />,
    );
    const rows = () => container.querySelectorAll("tr.diff-line").length;
    expect(rows()).toBe(8); // 3 context + del + ins + 3 context
    expect(container.querySelector(".diff-decoration")?.textContent).toContain("@@ -27,7 +27,7 @@");
    const up = screen.getAllByRole("button", { name: "Expand up" })[0] as HTMLButtonElement;
    expect(up.disabled).toBe(false);
    // first hunk: nothing above the previous hunk to expand downward into
    expect(
      (screen.getAllByRole("button", { name: "Expand down" })[0] as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(up);
    expect(rows()).toBe(28);
    fireEvent.click(screen.getAllByRole("button", { name: "Expand all" })[0]);
    // gap above is gone; the tail decoration (lines 34–60) remains
    expect(container.querySelector(".diff-decoration")?.textContent).not.toContain("@@");
    fireEvent.click(screen.getAllByRole("button", { name: "Expand all" })[0]);
    expect(container.querySelectorAll(".diff-decoration")).toHaveLength(0);
    expect(rows()).toBe(61);
  });

  it("the expandAllToken prop expands everything; split view renders both sides", () => {
    const p = payloadFor(lines(60, null), lines(60, 30));
    const { container, rerender } = render(
      <DiffBody file={file} payload={p} viewType="split" expandAllToken={0} />,
    );
    expect(container.querySelector("table")?.className).toContain("diff-split");
    rerender(<DiffBody file={file} payload={p} viewType="split" expandAllToken={1} />);
    expect(container.querySelectorAll(".diff-decoration")).toHaveLength(0);
    expect(container.querySelectorAll("tr.diff-line").length).toBe(60);
  });
});

describe("DiffPane", () => {
  it("mounts only cards near the viewport and loads just those diffs", () => {
    const large = syntheticLarge({ info: repo, diff });
    const a = seed({ diff: large.diff });
    render(<DiffPane initialRect={{ width: 900, height: 800 }} />);
    const cards = screen.getAllByRole("article");
    expect(cards.length).toBeGreaterThan(1);
    expect(cards.length).toBeLessThan(30);
    expect(screen.getByRole("region", { name: "Diff" }).getAttribute("data-count")).toBe("5000");
    expect(a.loadFileDiff).toHaveBeenCalledTimes(cards.length);
  });

  it("scroll requests from the sidebar target the card index", () => {
    seed();
    render(<DiffPane initialRect={{ width: 900, height: 800 }} />);
    const pane = screen.getByRole("region", { name: "Diff" });
    const before = pane.scrollTop;
    act(() => requestScrollTo("vendor/sub"));
    expect(pane.scrollTop).toBeGreaterThanOrEqual(before);
  });

  it("[ and ] collapse / expand the active card", () => {
    const a = seed({ activeFileId: "docs/guide.md" });
    render(<DiffPane initialRect={{ width: 900, height: 800 }} />);
    fireEvent.keyDown(document.body, { key: "[" });
    expect(a.setCollapsed).toHaveBeenCalledWith("docs/guide.md", true);
    fireEvent.keyDown(document.body, { key: "]" });
    expect(a.setCollapsed).toHaveBeenCalledWith("docs/guide.md", false);
  });
});
