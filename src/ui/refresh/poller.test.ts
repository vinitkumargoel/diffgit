import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeTier } from "../../engine/api";
import { POLL_DEFAULTS, startPoller } from "./poller";

class FakeDoc {
  hidden = false;
  private listeners = new Set<() => void>();
  addEventListener(_t: string, l: () => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: string, l: () => void) {
    this.listeners.delete(l);
  }
  setHidden(h: boolean) {
    this.hidden = h;
    for (const l of this.listeners) l();
  }
}

function fakeClient(
  sigs: Record<ProbeTier, string>,
  delayMs: Partial<Record<ProbeTier, number>> = {},
) {
  const calls: ProbeTier[] = [];
  return {
    calls,
    sigs,
    probe: vi.fn(async (tier: ProbeTier) => {
      calls.push(tier);
      const d = delayMs[tier] ?? 0;
      if (d) await new Promise((r) => setTimeout(r, d));
      return sigs[tier];
    }),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("poller", () => {
  it("baselines all tiers at start, then probes git every 3 s, index every 10 s, untracked every 30 s", async () => {
    const c = fakeClient({ git: "g1", index: "i1", untracked: "u1" });
    const doc = new FakeDoc();
    const stop = startPoller(c, vi.fn(), vi.fn(), { isBusy: () => false, doc });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls.sort()).toEqual(["git", "index", "untracked"]);
    c.calls.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    const count = (t: ProbeTier) => c.calls.filter((x) => x === t).length;
    expect(count("git")).toBe(10);
    expect(count("index")).toBe(3);
    expect(count("untracked")).toBe(1);
    stop();
    c.calls.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.calls).toEqual([]);
  });

  it("a changed signature requests the matching reason exactly once per change", async () => {
    const c = fakeClient({ git: "g1", index: "i1", untracked: "u1" });
    const onChange = vi.fn();
    const stop = startPoller(c, onChange, vi.fn(), { isBusy: () => false, doc: new FakeDoc() });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onChange).not.toHaveBeenCalled();
    c.sigs.git = "g2";
    await vi.advanceTimersByTimeAsync(3000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("poll:git");
    await vi.advanceTimersByTimeAsync(3000);
    expect(onChange).toHaveBeenCalledTimes(1); // unchanged since → silent
    c.sigs.index = "i2";
    c.sigs.untracked = "u2";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onChange.mock.calls.filter((a) => a[0] === "poll:worktree")).toHaveLength(2);
    stop();
  });

  it("does not probe while a compute is busy and resumes afterwards", async () => {
    const c = fakeClient({ git: "g1", index: "i1", untracked: "u1" });
    let busy = false;
    const stop = startPoller(c, vi.fn(), vi.fn(), { isBusy: () => busy, doc: new FakeDoc() });
    await vi.advanceTimersByTimeAsync(0);
    c.calls.length = 0;
    busy = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.calls).toEqual([]);
    busy = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.calls).toContain("git");
    stop();
  });

  it("hidden tab triples every interval; becoming visible probes git immediately", async () => {
    const c = fakeClient({ git: "g1", index: "i1", untracked: "u1" });
    const doc = new FakeDoc();
    const stop = startPoller(c, vi.fn(), vi.fn(), { isBusy: () => false, doc });
    await vi.advanceTimersByTimeAsync(0);
    doc.setHidden(true);
    c.calls.length = 0;
    await vi.advanceTimersByTimeAsync(9000);
    expect(c.calls.filter((t) => t === "git")).toHaveLength(1); // 9 s hidden → one 9 s tick
    expect(c.calls.filter((t) => t === "index")).toHaveLength(0); // 30 s while hidden
    c.calls.length = 0;
    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toEqual(["git"]);
    stop();
  });

  it("index tier backs off to 30 s while sweeps take > 500 ms and recovers", async () => {
    const c = fakeClient({ git: "g1", index: "i1", untracked: "u1" }, { index: 800 });
    const probes: [ProbeTier, number][] = [];
    const stop = startPoller(c, vi.fn(), vi.fn(), {
      isBusy: () => false,
      doc: new FakeDoc(),
      onProbe: (tier, ms) => probes.push([tier, ms]),
    });
    await vi.advanceTimersByTimeAsync(1000); // first (slow) index sweep completes → back-off ×2
    c.calls.length = 0;
    await vi.advanceTimersByTimeAsync(19_000);
    expect(c.calls.filter((t) => t === "index")).toHaveLength(0); // 20 s interval now
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.calls.filter((t) => t === "index")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000); // second slow sweep → 30 s (capped)
    const slowCount = c.calls.filter((t) => t === "index").length;
    expect(slowCount).toBeGreaterThanOrEqual(2);
    expect(probes.filter(([t]) => t === "index").every(([, ms]) => ms >= 800)).toBe(true);
    // fast sweeps restore the 10 s interval
    c.probe.mockImplementation(async (tier: ProbeTier) => {
      c.calls.push(tier);
      return c.sigs[tier];
    });
    await vi.advanceTimersByTimeAsync(31_000);
    c.calls.length = 0;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(c.calls.filter((t) => t === "index")).toHaveLength(2);
    stop();
  });

  it("probe errors reach onError with a public code and polling continues", async () => {
    const c = fakeClient({ git: "g1", index: "i1", untracked: "u1" });
    const onError = vi.fn();
    c.probe.mockRejectedValueOnce({ code: "PERMISSION", message: "denied" });
    const stop = startPoller(c, vi.fn(), onError, { isBusy: () => false, doc: new FakeDoc() });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "PERMISSION" }));
    c.calls.length = 0;
    await vi.advanceTimersByTimeAsync(POLL_DEFAULTS.gitMs);
    expect(c.calls).toContain("git");
    stop();
  });
});
