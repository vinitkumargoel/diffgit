import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffSource } from "../engine/types";
import {
  compareSpecOf,
  formatCompareHash,
  installCompareHash,
  parseCompareHash,
  shortExpr,
} from "./compareHash";
import { setStoreClient, useStore } from "./store";
import { createMockWorkerClient, type MockWorkerClient } from "./workerClient.mock";

const BRANCHES: DiffSource = {
  kind: "branches",
  source: "feature",
  target: "main",
  sourceRef: "refs/heads/feature",
  targetRef: "refs/remotes/origin/main",
  includeWorktree: true,
};

const RANGE: DiffSource = {
  kind: "range",
  from: "v2.3.0",
  to: "stash@{0}",
  fromRef: "refs/tags/v2.3.0",
  toRef: "stash@{0}",
  fromOid: "1".repeat(40),
  toOid: "2".repeat(40),
  threeDot: false,
  includeWorktree: false,
};

let mock: MockWorkerClient;
const initial = useStore.getState();
let stop: (() => void) | null = null;

function setHash(hash: string): void {
  history.replaceState(null, "", `${location.pathname}${hash}`);
}

beforeEach(() => {
  mock = createMockWorkerClient();
  setStoreClient(mock);
  useStore.setState(initial, true);
  setHash("");
});
afterEach(() => {
  stop?.();
  stop = null;
  setStoreClient(null);
});

describe("compareHash: format and parse", () => {
  it("short, resolvable expressions on both sides", () => {
    expect(shortExpr("refs/heads/main")).toBe("main");
    expect(shortExpr("refs/remotes/origin/x")).toBe("origin/x");
    expect(shortExpr("refs/tags/v1.0.0")).toBe("v1.0.0");
    expect(shortExpr("HEAD~3")).toBe("HEAD~3");
    expect(compareSpecOf(BRANCHES)).toEqual({ from: "origin/main", to: "feature", threeDot: true });
    expect(formatCompareHash(BRANCHES)).toBe("#compare=origin/main...feature");
    expect(formatCompareHash(RANGE)).toBe("#compare=v2.3.0..stash@{0}");
  });

  it("parses both separators, decodes what the browser encoded, and refuses anything else", () => {
    expect(parseCompareHash("#compare=main...feature")).toEqual({
      from: "main",
      to: "feature",
      threeDot: true,
    });
    // a tag is full of single dots: the three-dot separator has to win
    expect(parseCompareHash("#compare=v1.0.0...v2.0.0")).toEqual({
      from: "v1.0.0",
      to: "v2.0.0",
      threeDot: true,
    });
    expect(parseCompareHash("#compare=v1.0.0..v2.0.0")).toEqual({
      from: "v1.0.0",
      to: "v2.0.0",
      threeDot: false,
    });
    expect(parseCompareHash("#compare=v2.3.0...stash%40%7B0%7D")?.to).toBe("stash@{0}");
    expect(parseCompareHash("#compare=100%...main")?.from).toBe("100%");
    for (const bad of [
      "",
      "#debug",
      "#compare=",
      "#compare=main",
      "#compare=...main",
      "#x=a...b",
    ]) {
      expect(parseCompareHash(bad)).toBeNull();
    }
  });

  it("round-trips every shape it writes", () => {
    for (const src of [BRANCHES, RANGE, { ...RANGE, threeDot: true }]) {
      const spec = compareSpecOf(src);
      expect(parseCompareHash(formatCompareHash(src))).toEqual(spec);
    }
  });
});

describe("compareHash: the deep link", () => {
  it("writes the hash on every source change once a repository is open", async () => {
    stop = installCompareHash();
    expect(location.hash).toBe("");
    await useStore.getState().openRepo({ name: "tags" }, { id: "tags" });
    expect(location.hash).toBe("#compare=main...main");
    const tag = await useStore.getState().resolveRevision("v0.1.0");
    useStore.getState().setRevision(tag, "target");
    expect(location.hash).toBe("#compare=v0.1.0...main");
    useStore.getState().setTwoDot(true);
    expect(location.hash).toBe("#compare=v0.1.0..main");
  });

  it("leaves `#debug` alone", async () => {
    setHash("#debug");
    stop = installCompareHash();
    await useStore.getState().openRepo({ name: "tags" }, { id: "tags" });
    expect(location.hash).toBe("#debug");
  });

  it("applies the hash present at load to the first repository opened after it", async () => {
    setHash("#compare=v0.1.0..v1.0.0");
    stop = installCompareHash();
    await useStore.getState().openRepo({ name: "tags" }, { id: "tags" });
    await vi.waitFor(() =>
      expect(useStore.getState().diffSource).toMatchObject({
        kind: "range",
        from: "v0.1.0",
        to: "v1.0.0",
        fromOid: "1e919f3681161418fef2e272272c9cb707fa65f6",
        toOid: "8d071c323aa2f4d0c74a425f4105ef2d9d1b57c8",
        threeDot: false,
      }),
    );
    // and it is written back in the same spelling it was read in
    await vi.waitFor(() => expect(location.hash).toBe("#compare=v0.1.0..v1.0.0"));
  });

  it("an unresolvable deep link toasts and keeps the default source", async () => {
    setHash("#compare=gone...main");
    stop = installCompareHash();
    await useStore.getState().openRepo({ name: "tags" }, { id: "tags" });
    await vi.waitFor(() =>
      expect(useStore.getState().toasts.at(-1)?.message).toContain("Cannot compare gone … main"),
    );
    expect(useStore.getState().diffSource).toMatchObject({
      kind: "branches",
      sourceRef: "refs/heads/main",
      targetRef: "refs/heads/main",
    });
  });
});
