import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../store";
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
