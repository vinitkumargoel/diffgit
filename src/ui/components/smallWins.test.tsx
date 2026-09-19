/**
 * T11.16 — the four small-win surfaces of atlas tab 19: the submodule card, the worktrees dialog,
 * the LFS card and the `jj colocated` tag.
 *
 * All four run on real recordings. `submodule` and `worktree-main` are `bun run record` output
 * from the fixtures T10.12 built (a gitlink whose checkout was deinit'd, and the main checkout
 * behind `worktree-gitdir`, which is the only way to get a *linked* entry into a list); `lfs`
 * carries a recorded `main…feature` range whose pointers the mock serves as the bytes git really
 * stores; `jj` is a colocated workspace with a detached HEAD.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDiffPayload } from "../../engine/api";
import { LFS_POINTER_MAX_BYTES } from "../../engine/diff/lfs";
import type {
  DiffResult,
  FileDiff,
  RepoInfo,
  SubmoduleInfo,
  WorktreeInfo,
} from "../../engine/types";
import jjInfo from "../../test/recorded/jj.repoinfo.json";
import lfsV2 from "../../test/recorded/lfs.v2.json";
import submoduleDiff from "../../test/recorded/submodule.diffresult.json";
import submoduleInfo from "../../test/recorded/submodule.repoinfo.json";
import submoduleV2 from "../../test/recorded/submodule.v2.json";
import worktreeMainV2 from "../../test/recorded/worktree-main.v2.json";
import { JJ_TAG } from "../jj";
import { canBePointer, NOT_FETCHED, objectLine, shortLfsOid, sizeLine } from "../lfs";
import { Lru } from "../lru";
import { mockPayload, mockTexts } from "../mock/mockContents";
import { DEFAULT_PREFS, type FileDiffEntry, type StoreState, useStore } from "../store";
import { pointerLine, SYNC_LABEL, syncOf } from "../submodules";
import { branchLabel, PRUNABLE, pathLabel, THIS_FOLDER, worktreeCount } from "../worktrees";
import { CommandPalette } from "./CommandPalette";
import { FileCard } from "./FileCard";
import { SubmoduleCard } from "./SubmoduleCard";
import { TopBar } from "./TopBar";
import { WorktreesDialog } from "./WorktreesDialog";

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

const subRepo = submoduleInfo as unknown as RepoInfo;
const subDiff = submoduleDiff as unknown as DiffResult;
const recordedSubmodules = submoduleV2.submodules as unknown as SubmoduleInfo[];
const recordedWorktrees = worktreeMainV2.worktrees as unknown as WorktreeInfo[];
/** The `main…feature` range the recorder captured for the `lfs` fixture. */
const lfsFiles = (lfsV2.ranges as unknown as { result: DiffResult }[])[0]?.result.files ?? [];
const lfsRow = (id: string): FileDiff => {
  const f = lfsFiles.find((x) => x.id === id);
  if (!f) throw new Error(`no recorded lfs row ${id}`);
  return f;
};

/** The mock's `fileBytes`: the same bytes the recorded fixture stores for that side. */
const pointerBytes = vi.fn(async (id: string, side: "old" | "new") => {
  const text = mockTexts(lfsRow(id))[side === "old" ? 0 : 1];
  return text === null ? null : new TextEncoder().encode(text);
});

function entries(list: [string, FileDiffEntry][]): Lru<string, FileDiffEntry> {
  const lru = new Lru<string, FileDiffEntry>(200);
  for (const [k, v] of list) lru.set(k, v);
  return lru;
}
const ready = (file: FileDiff): FileDiffEntry => ({
  status: "ready",
  data: mockPayload(file, 1, false, false) as FileDiffPayload,
});

const initial = useStore.getState();
function seed(overrides: Partial<StoreState> = {}): void {
  useStore.setState(
    {
      ...initial,
      screen: "repo",
      repo: subRepo,
      repoId: "r1",
      handle: { name: "submodule" },
      diff: subDiff,
      diffSource: {
        kind: "branches",
        source: "feature",
        target: "main",
        sourceRef: "refs/heads/feature",
        targetRef: "refs/heads/main",
        includeWorktree: true,
      },
      prefs: DEFAULT_PREFS,
      fileDiffs: entries([]),
      loadFileDiff: vi.fn(async () => {}),
      cancelFileDiff: vi.fn(),
      loadSubmodules: vi.fn(async () => {}),
      loadWorktrees: vi.fn(async () => {}),
      fileBytes: pointerBytes,
      ...overrides,
    },
    true,
  );
}

afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});
beforeEach(() => {
  pointerBytes.mockClear();
});

/** A directory handle deep enough for `probeSubmodule`: `.git` is the kind this map says. */
function fakeRoot(dotGit: "file" | "dir" | "missing", gitdirLine = "gitdir: ../.git/modules/sub") {
  const dir: Record<string, unknown> = {
    async getDirectoryHandle(name: string) {
      if (name === ".git" && dotGit === "dir") return dir;
      return dir;
    },
    async getFileHandle(name: string) {
      if (name === ".git" && dotGit === "file")
        return {
          async getFile() {
            return {
              async text() {
                return `${gitdirLine}\n`;
              },
            };
          },
        };
      throw new Error("NotFoundError");
    },
  };
  return dir;
}

describe("submodule card (atlas tab 19)", () => {
  it("shows the recorded pointer, the deinit'd checkout and why it cannot be opened", async () => {
    seed({ submodules: recordedSubmodules });
    const row = subDiff.files.find((f) => f.id === "sub") as FileDiff;
    render(<FileCard file={row} index={0} />);
    useStore.setState({ fileDiffs: entries([["sub|x", ready(row)]]) });
    render(<FileCard file={row} index={0} />);

    // The pointer line is the diff's own two oids, which is all v1's notice ever knew.
    const info = recordedSubmodules[0] as SubmoduleInfo;
    expect(await screen.findAllByText(pointerLine(row.oldOid, row.newOid))).not.toHaveLength(0);
    // …and the three facts the card adds.
    expect(syncOf(info)).toBe("not-checked-out");
    expect(screen.getAllByText(SYNC_LABEL["not-checked-out"])[0]).toBeTruthy();
    expect(screen.getAllByText(info.url as string)[0]).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByText(/not checked out here, so there is no folder/)[0]).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /Open submodule/ })).toBeNull();
  });

  it("tags in sync and drifted from the recorded and the checked-out commit", async () => {
    const recorded = "339e41b26a605a13b8170dd1eb84e9625955ccf6";
    for (const [checkedOut, label] of [
      [recorded, SYNC_LABEL["in-sync"]],
      ["03fb642000000000000000000000000000000000", SYNC_LABEL.drifted],
    ] as const) {
      seed({
        submodules: [{ path: "sub", url: null, recorded, checkedOut, dirty: null }],
        handle: fakeRoot("dir"),
      });
      render(<SubmoduleCard path="sub" oldOid="03fb642aaa" newOid={recorded} />);
      expect(await screen.findByText(label)).toBeTruthy();
      cleanup();
    }
  });

  it("offers the open action for a `.git` directory and explains a `gitdir:` pointer file", async () => {
    // A nested clone (an old-style submodule): the engine accepts it, so the action is offered.
    seed({
      submodules: [
        {
          path: "sub",
          url: null,
          recorded: "a".repeat(40),
          checkedOut: "a".repeat(40),
          dirty: null,
        },
      ],
      handle: fakeRoot("dir"),
    });
    render(<SubmoduleCard path="sub" oldOid={"b".repeat(40)} newOid={"a".repeat(40)} />);
    expect(await screen.findByRole("button", { name: /Open submodule/ })).toBeTruthy();
    cleanup();

    // What git has written since 1.7.8: the pointer resolves inside the picked folder, which is
    // where `checkedOut` came from — and is still `WORKTREE_GITDIR` on open, so the card says so.
    seed({
      submodules: [
        {
          path: "sub",
          url: null,
          recorded: "a".repeat(40),
          checkedOut: "a".repeat(40),
          dirty: null,
        },
      ],
      handle: fakeRoot("file"),
    });
    render(<SubmoduleCard path="sub" oldOid={"b".repeat(40)} newOid={"a".repeat(40)} />);
    expect(
      await screen.findByText(/\.git\/modules\/sub, inside the folder you picked/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open submodule/ })).toBeNull();
    cleanup();

    // A gitdir that walks out of the root is not followed at all (`resolveGitdirLine` → null).
    seed({
      submodules: [
        {
          path: "sub",
          url: null,
          recorded: "a".repeat(40),
          checkedOut: "a".repeat(40),
          dirty: null,
        },
      ],
      handle: fakeRoot("file", "gitdir: /elsewhere/modules/sub"),
    });
    render(<SubmoduleCard path="sub" oldOid={"b".repeat(40)} newOid={"a".repeat(40)} />);
    expect(await screen.findByText(/outside the folder you picked/)).toBeTruthy();
  });
});

describe("worktrees dialog (atlas tab 19)", () => {
  it("lists the recorded main checkout and its linked worktree", async () => {
    seed({ worktrees: recordedWorktrees, worktreesOpen: true });
    render(<WorktreesDialog />);
    expect(screen.getByText(worktreeCount(2))).toBeTruthy();
    const main = recordedWorktrees[0] as WorktreeInfo;
    const linked = recordedWorktrees[1] as WorktreeInfo;
    expect(main.isThis).toBe(true);
    expect(screen.getByText(pathLabel(main))).toBeTruthy();
    expect(screen.getByText(THIS_FOLDER)).toBeTruthy();
    expect(screen.getByText(pathLabel(linked))).toBeTruthy();
    expect(screen.getByText(branchLabel(linked))).toBe(screen.getByText("feature"));
    expect(screen.queryByText(PRUNABLE)).toBeNull(); // neither recorded entry is prunable
  });

  it("marks a prunable entry and a detached one", () => {
    seed({
      worktrees: [
        { name: "a", path: "../a", head: null, branch: null, prunable: true, isThis: false },
      ],
      worktreesOpen: true,
    });
    render(<WorktreesDialog />);
    expect(screen.getByText(PRUNABLE)).toBeTruthy();
    expect(screen.getByText("detached")).toBeTruthy();
  });

  it("is opened by the palette action, not by anything in the bars", async () => {
    const setWorktreesOpen = vi.fn();
    seed({ palette: true, setWorktreesOpen, worktrees: recordedWorktrees });
    render(<CommandPalette />);
    const row = await screen.findByText("Worktrees of this repository");
    fireEvent.click(row);
    expect(setWorktreesOpen).toHaveBeenCalledWith(true);
  });

  it("is also opened by the repo name in row 1, which gains no new control", () => {
    const setWorktreesOpen = vi.fn();
    seed({ setWorktreesOpen });
    render(<TopBar />);
    const name = screen.getByTitle("Worktrees of this repository");
    expect(name.textContent).toContain(subRepo.name);
    fireEvent.click(name);
    expect(setWorktreesOpen).toHaveBeenCalledWith(true);
  });
});

describe("LFS card (atlas tab 19)", () => {
  it("reads both pointers of a binary row out of the local object database", async () => {
    const row = lfsRow("assets/hero.psd");
    // The fixture marks it with git's `binary` macro, which expands to `-diff` and therefore also
    // reads as `linguist-generated` — so this row arrives behind the generated gate. A canonical
    // `git lfs track` line (`diff=lfs … -text`) is binary without being generated; both reach the
    // same card, this one after the click the gate asks for.
    expect(row.binary).toBe(true);
    expect(row.generated).toBe(true);
    seed({ fileDiffs: entries([["assets/hero.psd|x", ready(row)]]) });
    render(<FileCard file={row} index={0} />);
    fireEvent.click(screen.getByText(/Generated file, click to expand/));
    await waitFor(() => expect(pointerBytes).toHaveBeenCalledWith("assets/hero.psd", "old"));
    const oldP = {
      oid: `sha256:${"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}`,
      size: 12_400_000,
    };
    const newP = {
      oid: `sha256:${"4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393"}`,
      size: 12_900_000,
    };
    expect(await screen.findByText(objectLine(oldP, newP))).toBeTruthy();
    expect(screen.getByText(sizeLine(oldP, newP))).toBeTruthy();
    expect(screen.getByText(NOT_FETCHED)).toBeTruthy();
    // The card replaces the binary notice, never sits beside it.
    expect(screen.queryByText("Binary file not shown")).toBeNull();
  });

  it("shows the one side an added pointer has, and never asks for the missing one", async () => {
    const row = lfsRow("data/table.dat");
    expect(row.oldOid).toBeNull();
    seed({ fileDiffs: entries([["data/table.dat|x", ready(row)]]) });
    render(<FileCard file={row} index={0} />);
    expect(await screen.findByText("5.0 MB")).toBeTruthy();
    expect(screen.getByText(NOT_FETCHED)).toBeTruthy();
    // No "the other side is not a pointer" note: an added row has one side by construction.
    expect(screen.queryByText(/other side is not an LFS pointer/)).toBeNull();
  });

  it("leaves an ordinary file alone", () => {
    const row = lfsRow("notes.txt");
    seed({ fileDiffs: entries([["notes.txt|x", ready(row)]]) });
    render(<FileCard file={row} index={0} />);
    expect(screen.queryByText(NOT_FETCHED)).toBeNull();
  });

  it("never reads a side too big to be a pointer", () => {
    expect(canBePointer(0)).toBe(false);
    expect(canBePointer(LFS_POINTER_MAX_BYTES)).toBe(true);
    expect(canBePointer(LFS_POINTER_MAX_BYTES + 1)).toBe(false);
    expect(
      shortLfsOid("sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
    ).toBe("sha256:9f86d08…f00a08");
  });
});

describe("jj colocated (atlas tab 19)", () => {
  it("tags the repo name and leaves everything else alone", () => {
    const repo = jjInfo as unknown as RepoInfo;
    expect(repo.jj).toBe(true);
    // The engine already spells the detached head jj's way, and raises one *info* warning.
    expect(repo.headDisplay.startsWith("jj working copy @ ")).toBe(true);
    expect(repo.refs.find((r) => r.name === "HEAD")?.name ?? "HEAD").toBe("HEAD");
    seed({ repo });
    render(<TopBar />);
    expect(screen.getByText(JJ_TAG)).toBeTruthy();
    // Design §14.6 / T10.12: there is no detached-HEAD banner to suppress — the engine has no
    // such code — so nothing in the chrome says the repository is broken.
    expect(screen.queryByText(/detached/i)).toBeNull();
  });

  it("does not tag an ordinary repository", () => {
    seed({ repo: { ...subRepo, jj: false } });
    render(<TopBar />);
    expect(screen.queryByText(JJ_TAG)).toBeNull();
  });
});

describe("axe (light and dark)", () => {
  it("the four surfaces have no serious or critical issues in either theme", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      seed({
        submodules: recordedSubmodules,
        worktrees: recordedWorktrees,
        worktreesOpen: true,
        fileDiffs: entries([["assets/hero.psd|x", ready(lfsRow("assets/hero.psd"))]]),
        repo: jjInfo as unknown as RepoInfo,
      });
      const { container } = render(
        <>
          <TopBar />
          <WorktreesDialog />
          <SubmoduleCard path="sub" oldOid={"b".repeat(40)} newOid={"a".repeat(40)} />
          <FileCard file={lfsRow("assets/hero.psd")} index={0} />
        </>,
      );
      fireEvent.click(screen.getByText(/Generated file, click to expand/));
      await waitFor(() => expect(screen.getByText(NOT_FETCHED)).toBeTruthy());
      const result = await axe.run(container, {
        rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
        resultTypes: ["violations"],
      });
      const bad = result.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${dark ? "dark" : "light"}: ${v.id}`);
      expect(bad).toEqual([]);
      cleanup();
    }
  });
});
