/**
 * T11.3 — operation banner, conflict card, reflog list (Design §14.3, §14.5; atlas tabs 06 / 07).
 * Everything here runs on the recorded `rebase-conflict` / `merge-conflict` / `cherry-pick-conflict`
 * fixtures: the wording and the three-way panes must match what the real engine produced.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConflictPayload } from "../../engine/api";
import type {
  DiffResult,
  ReflogEntry,
  RepoInfo,
  RepoOperation,
  RepoWarning,
} from "../../engine/types";
import cherryInfo from "../../test/recorded/cherry-pick-conflict.repoinfo.json";
import cherryV2 from "../../test/recorded/cherry-pick-conflict.v2.json";
import mergeDiff from "../../test/recorded/merge-conflict.diffresult.json";
import mergeInfo from "../../test/recorded/merge-conflict.repoinfo.json";
import mergeV2 from "../../test/recorded/merge-conflict.v2.json";
import rebaseDiff from "../../test/recorded/rebase-conflict.diffresult.json";
import rebaseInfo from "../../test/recorded/rebase-conflict.repoinfo.json";
import rebaseV2 from "../../test/recorded/rebase-conflict.v2.json";
import orphanV2 from "../../test/recorded/reflog-orphan.v2.json";
import { type ConflictEntry, DEFAULT_PREFS, type StoreState, useStore } from "../store";
import { FileCard } from "./FileCard";
import { OperationBanner } from "./OperationBanner";
import { ReflogList } from "./ReflogList";
import { WarningBanners } from "./WarningBanners";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

const rebaseRepo = rebaseInfo as unknown as RepoInfo;
const mergeRepo = mergeInfo as unknown as RepoInfo;
const cherryRepo = cherryInfo as unknown as RepoInfo;
const rebaseResult = rebaseDiff as unknown as DiffResult;
const mergeResult = mergeDiff as unknown as DiffResult;
const rebaseOp = rebaseV2.operation as unknown as RepoOperation;
const mergeOp = mergeV2.operation as unknown as RepoOperation;
const cherryOp = cherryV2.operation as unknown as RepoOperation;
const conflictsOf = (v2: { conflicts: Record<string, unknown> }): Record<string, ConflictEntry> =>
  Object.fromEntries(
    Object.entries(v2.conflicts).map(([id, data]) => [
      id,
      { status: "ready", data: data as ConflictPayload } as ConflictEntry,
    ]),
  );

const initial = useStore.getState();

function seed(overrides: Partial<StoreState> = {}) {
  const actions = {
    loadConflict: vi.fn(async () => {}),
    loadReflog: vi.fn(async () => {}),
    loadFileDiff: vi.fn(async () => {}),
    cancelFileDiff: vi.fn(),
    setCollapsed: vi.fn(),
    toggleViewed: vi.fn(),
    setPref: vi.fn(),
    setRevision: vi.fn(),
    dismissWarning: vi.fn(),
  };
  useStore.setState(
    {
      ...initial,
      screen: "repo",
      repo: rebaseRepo,
      repoId: "r1",
      handle: { name: "rebase-conflict" },
      diff: rebaseResult,
      diffSource: rebaseResult.source,
      prefs: DEFAULT_PREFS,
      warnings: [],
      dismissedWarnings: new Set(),
      operation: rebaseOp,
      conflicts: conflictsOf(rebaseV2),
      ...actions,
      ...overrides,
    },
    true,
  );
  return actions;
}

afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

describe("OperationBanner (Design §14.3, atlas tab 07)", () => {
  it("names the step, what is being replayed, and warns while files conflict", () => {
    seed();
    render(<OperationBanner />);
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-level")).toBe("warning");
    expect(banner.getAttribute("data-operation")).toBe("rebase");
    expect(banner.textContent).toContain("Rebase in progress");
    expect(banner.textContent).toContain("step 2 of 3");
    expect(banner.textContent).toContain("replaying d424326 onto main");
    expect(banner.textContent).toContain("2 files conflict");
    expect(banner.textContent).toContain("resolving happens in your editor");
  });

  it("merge and cherry-pick recordings get their own wording", () => {
    seed({ repo: mergeRepo, diff: mergeResult, operation: mergeOp, conflicts: {} });
    render(<OperationBanner />);
    expect(screen.getByRole("alert").textContent).toContain("Merge in progress");
    cleanup();

    seed({ repo: cherryRepo, operation: cherryOp, conflicts: {} });
    render(<OperationBanner />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Cherry-pick in progress");
    expect(banner.textContent).toContain("1 file conflicts");
  });

  it("drops to info level with no conflicts, and cannot be dismissed either way", () => {
    seed({ operation: { ...rebaseOp, conflicts: 0 } });
    render(<OperationBanner />);
    const banner = screen.getAllByRole("status")[0] as HTMLElement;
    expect(banner.getAttribute("data-operation")).toBe("rebase");
    expect(banner.getAttribute("data-level")).toBe("info");
    // §14.3: no dismiss affordance — the only way out is finishing or aborting the operation
    expect(within(banner).queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  it("Show steps lists done ✓ / current ▶ / remaining with both copyable commands", async () => {
    seed();
    render(<OperationBanner />);
    const trigger = screen.getByRole("button", { name: "Show steps" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const popover = screen.getByRole("dialog", { name: "Steps of this operation" });
    const rows = within(popover).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["done", "current", "remaining"]);
    expect(rows[1]?.textContent).toContain("d424326");
    expect(within(popover).getByText("git rebase --continue")).toBeTruthy();
    expect(within(popover).getByText("git rebase --abort")).toBeTruthy();
    // Escape closes it and hands focus back to the link
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Steps of this operation" })).toBeNull(),
    );
  });

  it("adds the detached-HEAD info banner during an operation, and only then", () => {
    seed();
    render(<OperationBanner />);
    const detached = screen.getByTestId("detached-banner");
    expect(detached.textContent).toContain("Detached HEAD");
    expect(detached.textContent).toContain("d424326");
    expect(detached.textContent).toContain("topic"); // headName, the branch being replayed
    cleanup();

    // merge-conflict is on `main`: no second banner
    seed({ repo: mergeRepo, diff: mergeResult, operation: mergeOp, conflicts: {} });
    render(<OperationBanner />);
    expect(screen.queryByTestId("detached-banner")).toBeNull();
  });

  it("is absent when nothing is running (§14 rule 1: the screen looks like v1)", () => {
    seed({ operation: null, repo: { ...rebaseRepo, detached: false } });
    const { container } = render(<OperationBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("replaces the engine's one-shot OPERATION_IN_PROGRESS warning row in the stack", () => {
    const warnings = rebaseRepo.warnings as RepoWarning[];
    expect(warnings.map((w) => w.code)).toContain("OPERATION_IN_PROGRESS");
    seed({ warnings: [...warnings, { code: "AUTOCRLF", message: "core.autocrlf is true" }] });
    render(<WarningBanners />);
    expect(screen.getByRole("alert").textContent).toContain("Rebase in progress");
    expect(document.body.textContent).toContain("Line endings");
    expect(document.body.textContent).not.toContain("Operation in progress");
  });

  it("has no axe violations in either theme", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      seed();
      const { container } = render(<WarningBanners />);
      fireEvent.click(screen.getByRole("button", { name: "Show steps" }));
      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});

describe("ConflictBody (Design §14.3, atlas tab 06)", () => {
  const cardOf = (id: string) => {
    const file = useStore.getState().diff?.files.find((f) => f.id === id);
    if (!file) throw new Error(`no recorded file ${id}`);
    return <FileCard file={file} index={0} />;
  };

  it("renders Base · Ours · Theirs over the working tree with the markers tinted", () => {
    seed();
    render(cardOf("file.txt"));
    // three panes, each labelled with its stage
    expect(screen.getByText("Base").textContent).toBe("Base");
    expect(screen.getByText(/^stage 1 · /)).toBeTruthy();
    expect(screen.getByText("stage 2 · main")).toBeTruthy();
    expect(screen.getByText("stage 3 · d424326")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Base of file.txt" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Ours of file.txt" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Theirs of file.txt" })).toBeTruthy();

    // the working-tree file, with exactly the three marker lines of the recording tinted
    const marked = document.querySelectorAll("tr[data-marker]");
    expect([...marked].map((r) => r.querySelector("td")?.textContent)).toEqual(["3", "5", "7"]);
    expect(marked[0]?.textContent).toContain("<<<<<<< HEAD");
    expect(marked[2]?.textContent).toContain(">>>>>>> d424326");
  });

  it("the card header wears the conflict kind as a ref-style tag", () => {
    seed();
    render(cardOf("file.txt"));
    expect(screen.getByLabelText("Conflict: both modified")).toBeTruthy();
    cleanup();

    seed();
    render(cardOf("both-added.txt"));
    expect(screen.getByLabelText("Conflict: both added")).toBeTruthy();
    // both-added has no stage 1: the header says so and the pane is the hatched placeholder
    expect(screen.getAllByText("no common ancestor")).toHaveLength(2);
  });

  it("offers the next command, naming the operation that is actually running", () => {
    seed();
    render(cardOf("file.txt"));
    expect(screen.getByText("git add file.txt && git rebase --continue")).toBeTruthy();
    expect(document.body.textContent).toContain("diffgit shows conflicts");
  });

  it("says resolved-but-unstaged once the markers are gone (merge-conflict's gone.txt)", () => {
    seed({
      repo: mergeRepo,
      diff: mergeResult,
      diffSource: mergeResult.source,
      operation: mergeOp,
      conflicts: conflictsOf(mergeV2),
      handle: { name: "merge-conflict" },
    });
    render(cardOf("gone.txt"));
    expect(screen.getByText("Resolved in the working tree, not yet staged")).toBeTruthy();
    expect(screen.getByText("git add gone.txt && git merge --continue")).toBeTruthy();
    // theirs deleted it: the header says so and the pane still shows the lines that disappeared
    expect(screen.getByText("deleted on this side")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Theirs of gone.txt" })).toBeTruthy();
    expect(screen.getByLabelText("Conflict: deleted by them")).toBeTruthy();
  });

  it("asks the engine for the payload when the card has none yet", () => {
    const actions = seed({ conflicts: {} });
    render(cardOf("file.txt"));
    expect(actions.loadConflict).toHaveBeenCalledWith("file.txt");
    expect(actions.loadFileDiff).not.toHaveBeenCalled(); // a conflict is never a two-way diff
  });

  it("has no axe violations in either theme", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      seed();
      const { container } = render(cardOf("file.txt"));
      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});

describe("ReflogList (Design §14.5)", () => {
  const entries = rebaseV2.reflog as unknown as ReflogEntry[];

  beforeEach(() => {
    seed({ reflog: entries });
  });

  it("lists HEAD@{n}, the short oid, git's own message and the age", () => {
    render(<ReflogList />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(entries.length);
    expect(rows[0]?.textContent).toContain("HEAD@{0}");
    expect(rows[0]?.textContent).toContain("218d022");
    expect(rows[0]?.textContent).toContain("rebase (pick): t1: clean commit");
  });

  it("marks the orphaned commits `unreachable`, and says nothing while reachability is unknown", () => {
    // T11.5: `reflog-orphan` is a real reset that orphaned two commits, and T10.5's `reflog()`
    // fills `reachable`, so the badge is driven by recorded data rather than a hand-made row.
    seed({ reflog: orphanV2.reflog as unknown as ReflogEntry[] });
    render(<ReflogList />);
    expect(screen.getAllByText("unreachable")).toHaveLength(2);
    cleanup();

    // A reader that has not computed reachability leaves it null; the badge stays off.
    seed({ reflog: entries.map((e) => ({ ...e, reachable: null })) });
    render(<ReflogList />);
    expect(screen.queryAllByText("unreachable")).toHaveLength(0);
  });

  it("a row becomes the compare source (T11.2 setRevision)", () => {
    const actions = seed({ reflog: entries });
    render(<ReflogList />);
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    expect(actions.setRevision).toHaveBeenCalledWith(
      { expr: entries[0]?.newOid, oid: entries[0]?.newOid, kind: "commit", display: "218d022" },
      "source",
    );
  });

  it("says so when the repository keeps no reflog, and reads it once when it has none yet", () => {
    seed({ reflog: [] });
    render(<ReflogList />);
    expect(document.body.textContent).toContain("No reflog is kept for this repository");
    cleanup();

    const actions = seed({ reflog: null });
    render(<ReflogList />);
    expect(actions.loadReflog).toHaveBeenCalled();
  });

  it("has no axe violations in either theme", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      seed({ reflog: [{ ...(entries[0] as ReflogEntry), reachable: false }, ...entries.slice(1)] });
      const { container } = render(<ReflogList />);
      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(
        results.violations.map((v) => v.id),
        theme,
      ).toEqual([]);
      cleanup();
    }
  });
});
