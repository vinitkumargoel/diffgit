/**
 * T11.13 — the bisect strip (Design §14.5, atlas tab 15) and the store slice behind it, against the
 * mock worker's recorded `history` bisect: the whole 59 → 30 → 15 → 8 → 4 → 2 → 1 replay, the marks
 * on the commit rows, `g` / `x`, the dirty-working-tree warning and the marks that survive a reload.
 */
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BisectState,
  BisectStep,
  CommitSummary,
  DiffResult,
  FileDiff,
  Oid,
  RepoInfo,
} from "../../engine/types";
import historyDiff from "../../test/recorded/history.diffresult.json";
import historyInfo from "../../test/recorded/history.repoinfo.json";
import historyV2 from "../../test/recorded/history.v2.json";
import type { BisectAction, BisectSlice } from "../bisect";
import { derivedKey, getDerived, resetDerivedStore, setDerived } from "../persistence/derived";
import { DEFAULT_PREFS, type StoreState, setStoreClient, useStore } from "../store";
import { createMockWorkerClient, type MockWorkerClient } from "../workerClient.mock";
import { BisectStrip } from "./BisectStrip";
import { CommitList } from "./CommitList";
import RepoScreen from "./RepoScreen";

const repo = historyInfo as unknown as RepoInfo;
const diff = historyDiff as unknown as DiffResult;
const walk = historyV2.walks.default.commits as unknown as CommitSummary[];
const rounds = historyV2.bisect as unknown as { state: BisectState; step: BisectStep }[];
const first = rounds[0] as { state: BisectState; step: BisectStep };
const GOOD = first.state.good[0] as Oid;
const BAD = first.state.bad;
/** The seven rounds of the recorded replay (the skip round is the one with a `skipped` mark). */
const REPLAY = rounds.filter((r) => r.state.skipped.length === 0);

const initial = useStore.getState();
let derivedSeq = 0;

function slice(over: Partial<BisectSlice> = {}): BisectSlice {
  return {
    good: [GOOD],
    bad: BAD,
    skipped: [],
    candidate: first.step.candidate,
    remaining: first.step.remaining,
    steps: first.step.steps,
    firstBad: null,
    picking: null,
    loading: false,
    error: null,
    ...over,
  };
}

/** The strip with the store's own actions stubbed out; the store has its own block below. */
function seed(overrides: Partial<StoreState> = {}, bisect: BisectSlice | null = slice()) {
  const actions = {
    markBisect: vi.fn(async (_mark: BisectAction, _oid?: Oid) => {}),
    stopBisect: vi.fn(async () => {}),
    showCommit: vi.fn(async (_oid: Oid, _opts?: { extend?: boolean }) => {}),
    loadHistory: vi.fn(async () => {}),
    restoreBisect: vi.fn(async () => {}),
    requestCommitStats: vi.fn(),
    searchCommits: vi.fn(async () => null),
    setHistoryQuery: vi.fn(),
    setHistoryOption: vi.fn(),
    setHistoryTab: vi.fn(),
  };
  useStore.setState(
    {
      ...initial,
      screen: "repo",
      repo,
      repoId: "hist",
      mode: "history",
      diff,
      diffSource: diff.source,
      prefs: DEFAULT_PREFS,
      bisect,
      ...actions,
      ...overrides,
    },
    true,
  );
  return actions;
}

beforeEach(() => {
  derivedSeq++;
  resetDerivedStore(`bisect-derived-${derivedSeq}`);
});

afterEach(() => {
  cleanup();
  setStoreClient(null);
  useStore.setState(initial, true);
  document.documentElement.classList.remove("dark");
});

const strip = () => screen.getByRole("region", { name: "Bisect" });

describe("BisectStrip (Design §14.5)", () => {
  it("is not there at all until a bisect runs", () => {
    seed({}, null);
    const { container } = render(<BisectStrip />);
    expect(container.firstChild).toBeNull();
  });

  it("prints the range, the remaining count, the steps and the commit under test", () => {
    seed();
    render(<BisectStrip />);
    const text = strip().textContent ?? "";
    expect(text).toContain(`good ${GOOD.slice(0, 7)} … bad ${BAD.slice(0, 7)}`);
    expect(text).toContain("59 between");
    expect(text).toContain("≈ 6 steps");
    expect(text).toContain(`test ${(first.step.candidate as Oid).slice(0, 7)}`);
  });

  it("offers the checkout command and says that nothing was written", () => {
    seed();
    render(<BisectStrip />);
    expect(screen.getByText(`git checkout ${first.step.candidate}`)).toBeTruthy();
    expect(strip().textContent).toContain("Nothing is written");
  });

  it("confirms instead of repeating the command once HEAD is the commit under test", () => {
    seed({ repo: { ...repo, headOid: first.step.candidate } });
    render(<BisectStrip />);
    expect(strip().textContent).toContain("You are on the commit under test.");
    expect(screen.queryByText(`git checkout ${first.step.candidate}`)).toBeNull();
  });

  it("warns while the working tree is dirty, because `git checkout` would refuse", () => {
    const dirtyFile = { ...(walk[0] as unknown as FileDiff), id: "f1", layers: ["unstaged"] };
    seed({ diff: { ...diff, files: [dirtyFile] } as unknown as DiffResult });
    render(<BisectStrip />);
    expect(strip().textContent).toContain("git checkout will refuse");
    expect(strip().textContent).toContain("git stash -u");
  });

  it("marks the commit under test from its four buttons", () => {
    const actions = seed();
    render(<BisectStrip />);
    fireEvent.click(screen.getByRole("button", { name: /^Good/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Bad/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(actions.markBisect.mock.calls.map((c) => c[0])).toEqual(["good", "bad", "skip"]);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(actions.stopBisect).toHaveBeenCalled();
  });

  it("is a prompt while the ends are still being picked, and only `Stop` is offered", () => {
    seed(
      {},
      slice({ good: [], bad: "", candidate: null, remaining: 0, steps: 0, picking: "good" }),
    );
    render(<BisectStrip />);
    expect(strip().textContent).toContain("Pick the commit you know was good");
    expect(screen.queryByRole("button", { name: /^Good/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("states the answer with a link to it once one commit is left", () => {
    const actions = seed({}, slice({ candidate: null, remaining: 1, steps: 0, firstBad: BAD }));
    render(<BisectStrip />);
    expect(strip().textContent).toContain(`first bad commit: ${BAD.slice(0, 7)}`);
    expect(screen.queryByRole("button", { name: /^Good/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(actions.showCommit).toHaveBeenCalledWith(BAD);
  });

  it("says so when every commit left was skipped", () => {
    seed({}, slice({ candidate: null, remaining: 0, steps: 0, skipped: [BAD] }));
    render(<BisectStrip />);
    expect(strip().textContent).toContain("Every commit left was skipped");
    expect(strip().textContent).toContain("1 skipped");
  });

  it("is axe-clean in both themes, running and finished", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      for (const s of [slice(), slice({ candidate: null, remaining: 1, firstBad: BAD })]) {
        seed({}, s);
        const { container } = render(<BisectStrip />);
        const results = await axe.run(container, {
          rules: { "color-contrast": { enabled: false } },
        });
        expect(
          results.violations.map((v) => v.id),
          theme,
        ).toEqual([]);
        cleanup();
      }
    }
  });
});

describe("the commit list while a bisect runs (Design §14.5)", () => {
  const rows = () => [...document.querySelectorAll("[data-oid]")] as HTMLElement[];
  const markOn = (oid: Oid) =>
    document
      .querySelector(`[data-oid="${oid}"] [data-bisect-mark]`)
      ?.getAttribute("data-bisect-mark") ?? null;

  it("wears the good / bad / skip / test marks on the rows", () => {
    const skipped = walk[3]?.oid as Oid;
    seed({ history: { ...initial.history, commits: walk } }, slice({ skipped: [skipped] }));
    render(<CommitList />);
    expect(rows().length).toBeGreaterThan(0);
    expect(markOn(GOOD)).toBe("good");
    expect(markOn(BAD)).toBe("bad");
    expect(markOn(skipped)).toBe("skip");
    expect(markOn(first.step.candidate as Oid)).toBe("test");
    expect(markOn(walk[5]?.oid as Oid)).toBeNull();
  });

  it("a click is a mark while the strip is asking for an end, and a selection otherwise", () => {
    const picking = slice({
      good: [],
      bad: "",
      candidate: null,
      remaining: 0,
      steps: 0,
      picking: "good",
    });
    const actions = seed({ history: { ...initial.history, commits: walk } }, picking);
    const view = render(<CommitList />);
    fireEvent.click(document.querySelector(`[data-oid="${GOOD}"]`) as HTMLElement);
    expect(actions.markBisect).toHaveBeenCalledWith("good", GOOD);
    expect(actions.showCommit).not.toHaveBeenCalled();

    useStore.setState({ bisect: null });
    view.rerender(<CommitList />);
    fireEvent.click(document.querySelector(`[data-oid="${GOOD}"]`) as HTMLElement);
    expect(actions.showCommit).toHaveBeenCalledWith(GOOD, { extend: false });
  });
});

describe("store: bisect (T11.13)", () => {
  let mock: MockWorkerClient;
  const open = async () => {
    mock = createMockWorkerClient();
    setStoreClient(mock);
    useStore.setState(initial, true);
    await useStore.getState().openRepo({ name: "history" }, { id: "hist" });
  };
  const settled = async () =>
    waitFor(() => expect(useStore.getState().bisect?.loading).toBe(false));

  it("replays the recorded bisect: seven rounds, 59 → 30 → 15 → 8 → 4 → 2 → 1", async () => {
    await open();
    await useStore.getState().startBisect({ good: GOOD, bad: BAD });
    await settled();
    for (const round of REPLAY) {
      const s = useStore.getState().bisect as BisectSlice;
      expect(s.remaining, `remaining of round ${REPLAY.indexOf(round) + 1}`).toBe(
        round.step.remaining,
      );
      expect(s.candidate, `candidate of round ${REPLAY.indexOf(round) + 1}`).toBe(
        round.step.candidate,
      );
      expect(s.steps).toBe(round.step.steps);
      if (round.step.candidate === null) break;
      // the candidate is selected in the list, so the diff on screen is the commit under test
      expect(useStore.getState().history.selected).toBe(round.step.candidate);
      await useStore.getState().markBisect("good");
      await settled();
    }
    const done = useStore.getState().bisect as BisectSlice;
    expect(done.firstBad).toBe(BAD);
    expect(done.remaining).toBe(1);
  });

  it("a skip takes the midpoint out of the count and asks for the next one", async () => {
    await open();
    await useStore.getState().startBisect({ good: GOOD, bad: BAD });
    await settled();
    const skipped = useStore.getState().bisect?.candidate as Oid;
    await useStore.getState().markBisect("skip");
    await settled();
    const s = useStore.getState().bisect as BisectSlice;
    expect(s.skipped).toEqual([skipped]);
    expect(s.remaining).toBe(rounds[1]?.step.remaining);
    expect(s.candidate).toBe(rounds[1]?.step.candidate);
  });

  it("`Start bisect…` asks for the two ends and arms itself on the second one", async () => {
    await open();
    await useStore.getState().startBisect();
    expect(useStore.getState().mode).toBe("history");
    expect(useStore.getState().bisect?.picking).toBe("good");
    await useStore.getState().markBisect("good", GOOD);
    expect(useStore.getState().bisect?.picking).toBe("bad");
    const spy = vi.spyOn(mock, "bisectStep");
    await useStore.getState().markBisect("bad", BAD);
    await settled();
    expect(spy).toHaveBeenCalledWith(first.state);
    expect(useStore.getState().bisect?.remaining).toBe(59);
  });

  it("the CommitCard's `mark bad` with no bisect running starts one and asks for the good end", async () => {
    await open();
    await useStore.getState().markBisect("bad", BAD);
    expect(useStore.getState().mode).toBe("history");
    expect(useStore.getState().bisect).toMatchObject({ bad: BAD, good: [], picking: "good" });
    // a lone `skip` means nothing, so it does not start anything
    await useStore.getState().stopBisect();
    await useStore.getState().markBisect("skip", BAD);
    expect(useStore.getState().bisect).toBeNull();
  });

  it("remembers the marks per repository and picks them up again", async () => {
    await open();
    await useStore.getState().startBisect({ good: GOOD, bad: BAD });
    await settled();
    await useStore.getState().markBisect("good");
    await settled();
    const marks = await getDerived<BisectState>(derivedKey.bisect("hist"));
    expect(marks?.bad).toBe(BAD);
    expect(marks?.good).toEqual([GOOD, first.step.candidate]);

    // a reload: the slice is empty, the cache is not
    useStore.setState({ bisect: null });
    await useStore.getState().restoreBisect();
    await settled();
    expect(useStore.getState().bisect?.remaining).toBe(rounds[2]?.step.remaining);
    // `Stop` forgets them here and in the cache
    await useStore.getState().stopBisect();
    expect(useStore.getState().bisect).toBeNull();
    expect(await getDerived<BisectState>(derivedKey.bisect("hist"))).toBeNull();
  });

  it("restores nothing when the cache holds no bad end", async () => {
    await open();
    await setDerived(derivedKey.bisect("hist"), { good: [GOOD], bad: "", skipped: [] });
    await useStore.getState().restoreBisect();
    expect(useStore.getState().bisect).toBeNull();
  });

  it("`g` and `x` mark the commit under test from any mode", async () => {
    await open();
    await useStore.getState().startBisect({ good: GOOD, bad: BAD });
    await settled();
    render(<RepoScreen />);
    useStore.getState().setMode("files");
    fireEvent.keyDown(document, { key: "g" });
    await settled();
    expect(useStore.getState().bisect?.good).toEqual([GOOD, first.step.candidate]);
    const before = useStore.getState().bisect?.candidate as Oid;
    fireEvent.keyDown(document, { key: "x" });
    await settled();
    expect(useStore.getState().bisect?.bad).toBe(before);
  });

  it("keeps the marks across a mode switch and drops them with the repository", async () => {
    await open();
    await useStore.getState().startBisect({ good: GOOD, bad: BAD });
    await settled();
    useStore.getState().setMode("branches");
    useStore.getState().setMode("history");
    expect(useStore.getState().bisect?.remaining).toBe(59);
    await useStore.getState().closeRepo();
    expect(useStore.getState().bisect).toBeNull();
  });

  it("keeps the marks when the engine refuses a step, and says why", async () => {
    await open();
    vi.spyOn(mock, "bisectStep").mockRejectedValueOnce(
      Object.assign(new Error("no such commit"), { code: "REV_NOT_FOUND" }),
    );
    await useStore.getState().startBisect({ good: GOOD, bad: BAD });
    await settled();
    const s = useStore.getState().bisect as BisectSlice;
    expect(s.error?.code).toBe("REV_NOT_FOUND");
    expect(s.bad).toBe(BAD);
  });
});
