import { describe, expect, it, vi } from "vitest";
import { classifyPath, classifyPaths, observerSupported, startObserver } from "./observer";

const rec = (type: string, path: string, from?: string) => ({
  type,
  relativePathComponents: path === "" ? [] : path.split("/"),
  relativePathMovedFrom: from ? from.split("/") : null,
  changedHandle: { kind: "file" },
});

describe("classifier", () => {
  it.each([
    [".git/HEAD", "git"],
    [".git/index", "git"],
    [".git/packed-refs", "git"],
    [".git/ORIG_HEAD", "git"],
    [".git/MERGE_HEAD", "git"],
    [".git/logs/HEAD", "git"],
    [".git/refs/heads/main", "git"],
    [".git/refs/remotes/origin/HEAD", "git"],
    [".git/logs/refs/heads/main", "git"],
    [".git/index.lock", "ignore"],
    [".git/refs/heads/main.lock", "ignore"],
    [".git/objects/ab/cdef", "ignore"],
    [".git/objects/pack/pack-1.pack", "ignore"],
    [".git/COMMIT_EDITMSG", "ignore"],
    [".git/hooks/pre-commit", "ignore"],
    [".git", "ignore"],
    [".git/config", "config"],
    [".git/info/exclude", "config"],
    [".gitignore", "config"],
    ["src/.gitignore", "config"],
    [".gitattributes", "config"],
    ["src/a.ts", "worktree"],
    ["README.md", "worktree"],
    ["src/.a.ts.swp", "ignore"],
    ["src/a.ts~", "ignore"],
    ["src/4913", "ignore"],
    ["notes.tmp", "ignore"],
    ["src/.#lock", "ignore"],
    ["doc.crswap", "ignore"],
  ])("%s → %s", (path, kind) => {
    expect(classifyPath(path)).toBe(kind);
  });

  it("aggregates a git add burst: index.lock appears, index moves → git only", () => {
    const c = classifyPaths([
      rec("appeared", ".git/index.lock"),
      rec("modified", ".git/index.lock"),
      rec("moved", ".git/index", ".git/index.lock"),
    ]);
    expect(c).toMatchObject({ git: true, worktree: [], config: false, fatal: null });
    expect(c.ignored).toBe(3); // two lock records + the moved-from lock path
  });

  it("aggregates a gc burst into nothing actionable", () => {
    const records = Array.from({ length: 200 }, (_, i) =>
      rec(
        i % 2 ? "appeared" : "disappeared",
        `.git/objects/${String(i % 16).padStart(2, "0")}/x${i}`,
      ),
    );
    records.push(rec("modified", ".git/packed-refs.lock"));
    const c = classifyPaths(records);
    expect(c.git).toBe(false);
    expect(c.worktree).toEqual([]);
    expect(c.ignored).toBe(201);
  });

  it("atomic editor save: temp appears then moves onto the file → the target path once", () => {
    const c = classifyPaths([
      rec("appeared", "src/.a.ts.tmp"),
      rec("modified", "src/.a.ts.tmp"),
      rec("moved", "src/a.ts", "src/.a.ts.tmp"),
      rec("modified", "src/a.ts"),
    ]);
    expect(c.worktree).toEqual(["src/a.ts"]);
    expect(c.git).toBe(false);
  });

  it("config edits and checkout: config flag + git flag; worktree paths sorted and unique", () => {
    const c = classifyPaths([
      rec("modified", "b.txt"),
      rec("modified", "a.txt"),
      rec("modified", "b.txt"),
      rec("modified", ".gitignore"),
      rec("modified", ".git/HEAD"),
      rec("appeared", ".git/refs/heads/topic"),
    ]);
    expect(c).toMatchObject({ git: true, config: true, worktree: ["a.txt", "b.txt"] });
  });

  it("errored and root disappeared are fatal", () => {
    expect(classifyPaths([rec("errored", "")]).fatal).toBe("errored");
    expect(classifyPaths([rec("disappeared", "")]).fatal).toBe("disappeared");
    expect(classifyPaths([rec("disappeared", "src/a.ts")])).toMatchObject({
      fatal: null,
      worktree: ["src/a.ts"],
    });
  });
});

describe("startObserver", () => {
  it("returns null when the API is missing", () => {
    expect(observerSupported({})).toBe(false);
    expect(startObserver({}, vi.fn(), vi.fn(), { ctor: undefined })).toBeNull();
  });

  it("observes recursively, forwards classified records, stops on disconnect", async () => {
    let cb: ((records: unknown[], o: unknown) => void) | null = null;
    const observe = vi.fn(async () => {});
    const disconnect = vi.fn();
    class Fake {
      constructor(c: (records: unknown[], o: unknown) => void) {
        cb = c;
      }
      observe = observe;
      disconnect = disconnect;
    }
    const onRecords = vi.fn();
    const onError = vi.fn();
    const handle = { kind: "directory" };
    const stop = startObserver(handle, onRecords, onError, { ctor: Fake as never });
    expect(stop).not.toBeNull();
    expect(observe).toHaveBeenCalledWith(handle, { recursive: true });
    (cb as unknown as (r: unknown[], o: unknown) => void)(
      [rec("modified", "src/a.ts"), rec("modified", ".git/objects/aa/bb")],
      null,
    );
    expect(onRecords).toHaveBeenCalledWith(false, ["src/a.ts"], false);
    (cb as unknown as (r: unknown[], o: unknown) => void)(
      [rec("modified", ".git/objects/aa/bb")],
      null,
    );
    expect(onRecords).toHaveBeenCalledTimes(1); // nothing actionable → no request
    (cb as unknown as (r: unknown[], o: unknown) => void)([rec("disappeared", "")], null);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "HANDLE_GONE" }));
    expect(disconnect).toHaveBeenCalledTimes(1);
    (cb as unknown as (r: unknown[], o: unknown) => void)([rec("modified", "src/b.ts")], null);
    expect(onRecords).toHaveBeenCalledTimes(1); // stopped observers stay silent
    stop?.();
    expect(disconnect).toHaveBeenCalledTimes(1); // idempotent-ish: already disconnected
  });

  it("observe() rejection maps NotAllowedError to PERMISSION", async () => {
    class Fake {
      observe = vi.fn(async () => {
        throw new DOMException("no", "NotAllowedError");
      });
      disconnect = vi.fn();
    }
    const onError = vi.fn();
    startObserver({}, vi.fn(), onError, { ctor: Fake as never });
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "PERMISSION" })),
    );
  });

  it("works against the E2E shim stub (emitObserverRecords → scheduler-shaped callback)", async () => {
    const { installFsaShim } = await import("../../../e2e/fsaShim");
    // the shim installs on `window`; happy-dom provides one
    installFsaShim({ snapshots: [] });
    expect(observerSupported(window)).toBe(true);
    const onRecords = vi.fn();
    const stop = startObserver({ kind: "directory" }, onRecords, vi.fn(), {
      ctor: (window as unknown as { FileSystemObserver: never }).FileSystemObserver,
    });
    expect(window.__diffgit.observerCount()).toBe(1);
    window.__diffgit.emitObserverRecords([
      { type: "modified", relativePathComponents: ["x.txt"], changedHandleKind: "file" },
      { type: "modified", relativePathComponents: [".git", "HEAD"], changedHandleKind: "file" },
    ]);
    expect(onRecords).toHaveBeenCalledWith(true, ["x.txt"], false);
    stop?.();
    expect(window.__diffgit.observerCount()).toBe(0);
  });
});
