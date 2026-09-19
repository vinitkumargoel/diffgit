import { cleanup, fireEvent, render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffResult, RepoInfo } from "../../engine/types";
import basicDiff from "../../test/recorded/showcase.diffresult.json";
import basic from "../../test/recorded/showcase.repoinfo.json";
import worktreeDiff from "../../test/recorded/showcase-worktree.diffresult.json";
import { DEFAULT_PREFS, useStore } from "../store";
import { BranchPicker } from "./BranchPicker";
import { CommandPalette } from "./CommandPalette";
import { EmptyState } from "./EmptyState";
import ErrorScreen from "./ErrorScreen";
import { HelpDialog } from "./HelpDialog";
import { HomeScreen } from "./HomeScreen";
import { ModeSwitch } from "./ModeSwitch";
import { Sidebar } from "./Sidebar";
import { Toasts } from "./Toasts";
import { WarningBanners } from "./WarningBanners";

if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

const persistence = vi.hoisted(() => ({
  listRepos: vi.fn(async () => [
    {
      id: "r1",
      name: "diffgit",
      handle: { name: "showcase" },
      lastOpenedAt: Date.now() - 3600_000,
      lastTarget: "refs/heads/main",
    },
  ]),
  upsertRepo: vi.fn(async () => ({ id: "x", name: "x", handle: {}, lastOpenedAt: 1 })),
  removeRepo: vi.fn(async () => {}),
  ensurePermission: vi.fn(async () => "granted" as const),
}));
vi.mock("../persistence", () => persistence);

const initial = useStore.getState();
beforeEach(() => {
  useStore.setState(
    {
      ...initial,
      screen: "repo",
      repo: basic as unknown as RepoInfo,
      repoId: "r1",
      handle: { name: "showcase" },
      diff: basicDiff as unknown as DiffResult,
      diffSource: {
        kind: "branches",
        source: "feature",
        target: "main",
        sourceRef: "refs/heads/feature",
        targetRef: "refs/heads/main",
        includeWorktree: true,
      },
      prefs: DEFAULT_PREFS,
      warnings: [
        { code: "AUTOCRLF", message: "m" },
        { code: "SPLIT_INDEX", message: "m" },
      ],
      toasts: [
        {
          id: 1,
          level: "error",
          message: "Refresh failed",
          action: { label: "Retry", onClick() {} },
        },
      ],
      closeRepo: vi.fn(async () => {}),
      openRepo: vi.fn(async () => {}),
    },
    true,
  );
});
afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
});

/** Serious / critical axe violations; colour contrast is measured by `contrast.test.ts` instead. */
async function violations(container: HTMLElement) {
  const result = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    resultTypes: ["violations"],
  });
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

describe("axe (vitest, happy-dom)", () => {
  it("HomeScreen has no serious or critical issues", async () => {
    const { container } = render(<HomeScreen />);
    await new Promise((r) => setTimeout(r, 10));
    expect(await violations(container)).toEqual([]);
  });

  it("EmptyState + WarningBanners have no serious or critical issues", async () => {
    const { container } = render(
      <>
        <WarningBanners />
        <EmptyState />
      </>,
    );
    expect(await violations(container)).toEqual([]);
  });

  it("ErrorScreen has no serious or critical issues", async () => {
    useStore.setState({ screen: "error", error: { code: "PERMISSION", message: "denied" } });
    const { container } = render(<ErrorScreen />);
    expect(await violations(container)).toEqual([]);
  });

  it("Sidebar (grouped) has no serious or critical issues", async () => {
    useStore.setState({ diff: worktreeDiff as unknown as DiffResult });
    const { container } = render(<Sidebar initialRect={{ width: 300, height: 600 }} />);
    // sanity: the five group headers really are on screen (T9.1)
    expect(container.querySelectorAll('[role="treeitem"][aria-level="1"]')).toHaveLength(5);
    expect(await violations(container)).toEqual([]);
  });

  it("ModeSwitch and the open CommandPalette have no serious or critical issues", async () => {
    useStore.setState({ palette: true });
    const { container } = render(
      <>
        <ModeSwitch />
        <CommandPalette />
      </>,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector("[cmdk-item]")).toBeTruthy(); // sanity: the list is up
    expect(await violations(container)).toEqual([]);
  });

  it("the extended BranchPicker popover has no serious or critical issues (T11.2)", async () => {
    const repo = basic as unknown as RepoInfo;
    const { container } = render(
      <BranchPicker
        label="compare"
        value="refs/heads/feature"
        display="feature"
        refs={repo.refs}
        tags={[
          {
            name: "v1.0.0",
            fullName: "refs/tags/v1.0.0",
            oid: "1".repeat(40),
            targetOid: "1".repeat(40),
            annotated: true,
            targetType: "commit",
          },
        ]}
        stashes={[
          {
            index: 0,
            expr: "stash@{0}",
            oid: "2".repeat(40),
            message: "On main: wip",
            timestamp: Date.now() - 60_000,
            baseOid: "3".repeat(40),
            indexOid: "4".repeat(40),
            untrackedOid: null,
            files: 2,
          },
        ]}
        special
        twoDot={false}
        onTwoDot={() => {}}
        onSelect={() => {}}
        onSpecial={() => {}}
        onResolve={async () => {
          throw { code: "REV_NOT_FOUND", message: "no" };
        }}
      />,
    );
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    await new Promise((r) => setTimeout(r, 10));
    // sanity: the three new groups are up before axe looks at them
    expect(container.textContent).toContain("Tags · 1");
    expect(container.textContent).toContain("Stashes · 1");
    expect(container.textContent).toContain("Special");
    expect(await violations(container)).toEqual([]);
  });

  it("HelpDialog and Toasts have no serious or critical issues", async () => {
    const { container } = render(
      <>
        <HelpDialog open onClose={() => {}} />
        <Toasts />
      </>,
    );
    expect(await violations(container)).toEqual([]);
  });
});
