import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../store";
import {
  clearDerived,
  derivedKey,
  derivedSize,
  getDerived,
  resetDerivedStore,
  setDerived,
} from "./derived";
import { loadPrefs, PREFS_KEY, savePrefs, setPrefsStorage, validatePrefs } from "./prefs";
import {
  ensurePermission,
  listRepos,
  MAX_RECENTS,
  removeRepo,
  resetRepoStore,
  touchRepo,
  upsertRepo,
} from "./repos";
import { onStorageError, resetStorageErrorState } from "./storage";
import { loadViewed, MAX_VIEWED, pruneViewed, resetViewedStore, saveViewed } from "./viewed";

/**
 * Mock FSA directory handle: identity by `path`. Methods live on the prototype so the object survives
 * structured cloning into fake-indexeddb (own-property functions would throw DataCloneError).
 */
class MockHandle {
  kind = "directory" as const;
  constructor(
    public name: string,
    public path = name,
    private perm: PermissionState = "prompt",
  ) {}
  async isSameEntry(other: unknown) {
    return (other as { path?: string }).path === this.path;
  }
  async queryPermission() {
    return this.perm;
  }
  async requestPermission() {
    this.perm = "granted";
    return this.perm;
  }
}
function handle(name: string, path = name, perm: PermissionState = "prompt") {
  return new MockHandle(name, path, perm) as unknown as FileSystemDirectoryHandle;
}

let dbSeq = 0;
beforeEach(() => {
  dbSeq++;
  resetRepoStore(`repos-test-${dbSeq}`);
  resetViewedStore(`viewed-test-${dbSeq}`);
  resetDerivedStore(`derived-test-${dbSeq}`);
  resetStorageErrorState();
  localStorage.clear();
});

describe("repos", () => {
  it("upsert dedupes by isSameEntry, orders newest first, caps at 20, removes", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const a = await upsertRepo(handle("a"));
    now = 2_000_000;
    await upsertRepo(handle("b"));
    now = 3_000_000;
    const a2 = await upsertRepo(handle("a"));
    expect(a2.id).toBe(a.id);
    let list = await listRepos();
    expect(list.map((r) => r.name)).toEqual(["a", "b"]);
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      now = 4_000_000 + i * 1000;
      await upsertRepo(handle(`r${i}`));
    }
    list = await listRepos();
    expect(list.length).toBe(MAX_RECENTS);
    expect(list[0]?.name).toBe(`r${MAX_RECENTS + 4}`);
    expect(list.some((r) => r.name === "a")).toBe(false);
    await removeRepo(list[0]?.id ?? "");
    expect((await listRepos()).length).toBe(MAX_RECENTS - 1);
    clock.mockRestore();
  });

  it("touchRepo patches branches; markers dedupe by snapshotId", async () => {
    const r = await upsertRepo(handle("x"));
    await touchRepo(r.id, { lastTarget: "refs/heads/main" });
    expect((await listRepos())[0]?.lastTarget).toBe("refs/heads/main");
    const m1 = { __diffgitMemoryHandle: true, kind: "directory", snapshotId: "s", name: "m" };
    const m2 = { ...m1, name: "renamed" };
    const s1 = await upsertRepo(m1 as unknown as FileSystemDirectoryHandle);
    const s2 = await upsertRepo(m2 as unknown as FileSystemDirectoryHandle);
    expect(s2.id).toBe(s1.id);
    expect(await ensurePermission(m1)).toBe("granted");
  });

  it("ensurePermission queries then requests", async () => {
    expect(await ensurePermission(handle("p", "p", "granted"))).toBe("granted");
    expect(await ensurePermission(handle("q"))).toBe("granted"); // request grants in the mock
    expect(await ensurePermission({})).toBe("denied");
  });
});

describe("viewed", () => {
  it("round-trips marks and prunes beyond the cap", async () => {
    await saveViewed("k1", true);
    await saveViewed("k2", true);
    await saveViewed("k1", false);
    expect(await loadViewed(["k1", "k2", "k3"])).toEqual(new Set(["k2"]));
    let now = 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let i = 0; i < 30; i++) {
      now = 10_000 + i;
      await saveViewed(`p${i}`, true);
    }
    clock.mockRestore();
    expect(await pruneViewed(10)).toBe(21); // 31 entries → keep the 10 newest (k2 was written "now")
    // survivors: p21..p29 (9 newest fake timestamps) + k2 (real "now")
    expect(await loadViewed(["p0", "p20", "p21", "p29", "k2"])).toEqual(
      new Set(["p21", "p29", "k2"]),
    );
    expect(MAX_VIEWED).toBe(5000);
  });
});

describe("prefs", () => {
  it("defaults on corrupt JSON and validates fields", () => {
    localStorage.setItem(PREFS_KEY, "{not json");
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(
      validatePrefs({
        viewMode: "split",
        sidebarWidth: 9999,
        theme: "purple",
        ignoreWhitespace: true,
      }),
    ).toEqual({ ...DEFAULT_PREFS, viewMode: "split", sidebarWidth: 480, ignoreWhitespace: true });
    savePrefs({ ...DEFAULT_PREFS, theme: "dark" });
    expect(loadPrefs().theme).toBe("dark");
  });

  it("sidebarGroup accepts only 'layer' and 'path' (T9.1)", () => {
    expect(DEFAULT_PREFS.sidebarGroup).toBe("layer");
    expect(validatePrefs({ sidebarGroup: "path" }).sidebarGroup).toBe("path");
    expect(validatePrefs({ sidebarGroup: "layer" }).sidebarGroup).toBe("layer");
    expect(validatePrefs({ sidebarGroup: "status" }).sidebarGroup).toBe("layer");
    expect(validatePrefs({ sidebarGroup: 3 }).sidebarGroup).toBe("layer");
    expect(validatePrefs({}).sidebarGroup).toBe("layer");
    savePrefs({ ...DEFAULT_PREFS, sidebarGroup: "path" });
    expect(loadPrefs().sidebarGroup).toBe("path");
  });

  it("accepts only the v2 keys the contract names (T11.1)", () => {
    expect(DEFAULT_PREFS.mode).toBe("files");
    expect(DEFAULT_PREFS.showHidden).toBe(false);
    expect(DEFAULT_PREFS.builtinExcludes).toBe(true);
    expect(DEFAULT_PREFS.insightsPeriod).toBe("90d");
    expect(DEFAULT_PREFS.twoDot).toBe(false);
    expect(validatePrefs({ mode: "history" }).mode).toBe("history");
    expect(validatePrefs({ mode: "insights" }).mode).toBe("insights");
    expect(validatePrefs({ mode: "stack" }).mode).toBe("files");
    expect(validatePrefs({ showHidden: true }).showHidden).toBe(true);
    expect(validatePrefs({ showHidden: "yes" }).showHidden).toBe(false);
    expect(validatePrefs({ builtinExcludes: false }).builtinExcludes).toBe(false);
    expect(validatePrefs({ builtinExcludes: 0 }).builtinExcludes).toBe(true);
    expect(validatePrefs({ insightsPeriod: "1y" }).insightsPeriod).toBe("1y");
    expect(validatePrefs({ insightsPeriod: "all" }).insightsPeriod).toBe("all");
    expect(validatePrefs({ insightsPeriod: "5y" }).insightsPeriod).toBe("90d");
    expect(validatePrefs({ twoDot: true }).twoDot).toBe(true);
    expect(validatePrefs({ twoDot: "true" }).twoDot).toBe(false);
    savePrefs({ ...DEFAULT_PREFS, showHidden: true, insightsPeriod: "all", twoDot: true });
    const back = loadPrefs();
    expect(back.showHidden).toBe(true);
    expect(back.insightsPeriod).toBe("all");
    expect(back.twoDot).toBe(true);
  });

  it("storage throwing does not throw out and reports once", () => {
    const reports: string[] = [];
    onStorageError((m) => reports.push(m));
    setPrefsStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    } as unknown as Storage);
    savePrefs(DEFAULT_PREFS);
    savePrefs(DEFAULT_PREFS);
    expect(reports).toEqual(["QuotaExceeded"]);
    setPrefsStorage(null);
    expect(loadPrefs()).toEqual(DEFAULT_PREFS); // unavailable storage → defaults, no throw
    setPrefsStorage(undefined);
  });
});

describe("derived cache (T11.1)", () => {
  it("round-trips a value, reports its size and clears", async () => {
    const key = derivedKey.blame("r1", "a".repeat(40), "src/index.ts", false);
    expect(key).toBe(`blame:r1:${"a".repeat(40)}:src/index.ts:x`);
    expect(await getDerived(key)).toBeNull(); // a miss is null, never a throw
    await setDerived(key, { lines: [1, 2, 3] });
    expect(await getDerived<{ lines: number[] }>(key)).toEqual({ lines: [1, 2, 3] });
    await setDerived(derivedKey.summary("r1"), { headBranch: "main" });
    const size = await derivedSize();
    expect(size.entries).toBe(2);
    expect(size.bytes).toBeGreaterThan(key.length);
    await clearDerived(key);
    expect(await getDerived(key)).toBeNull();
    expect((await derivedSize()).entries).toBe(1);
    await clearDerived();
    expect(await derivedSize()).toEqual({ entries: 0, bytes: 0 });
  });

  it("keys name every cached kind (docs/v2-contracts.md § Persistence)", () => {
    const oid = "b".repeat(40);
    expect(derivedKey.history("r1", oid, "a/b.ts")).toBe(`history:r1:${oid}:a/b.ts`);
    // T11.6: `-w` is a different blame, so it is a different key
    expect(derivedKey.blame("r1", oid, "a/b.ts", true)).toBe(`blame:r1:${oid}:a/b.ts:w`);
    expect(derivedKey.insights("r1", oid, "90d")).toBe(`insights:r1:${oid}:90d`);
    expect(derivedKey.summary("r1")).toBe("summary:r1");
    expect(derivedKey.bisect("r1")).toBe("bisect:r1");
  });

  it("a blocked database is reported once and every call falls back", async () => {
    const reports: string[] = [];
    onStorageError((m) => reports.push(m));
    const real = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() {
        throw new Error("blocked by policy");
      },
    });
    try {
      resetDerivedStore(`derived-blocked-${dbSeq}`);
      await setDerived("k", 1);
      expect(await getDerived("k")).toBeNull();
      expect(await derivedSize()).toEqual({ entries: 0, bytes: 0 });
      await clearDerived();
      expect(reports).toEqual(["blocked by policy"]);
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: real });
      resetStorageErrorState();
    }
  });
});
