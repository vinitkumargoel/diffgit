import type { InvalidateScope, ProbeTier, Progress } from "../api";
import { sourceRefs } from "../diffSource";
import { errorCode } from "../errors";
import type { DirHandleLike } from "../fs/dirHandleLike";
import type { FsaFs } from "../fs/fsaFs";
import type { GitAttributes } from "../git/attributes";
import { sha1, toHex } from "../git/hash";
import type { IgnoreRules } from "../git/ignoreRules";
import { type IndexSnapshot, readIndex } from "../git/indexReader";
import type { ObjectDb } from "../git/objectDb";
import { OPERATION_FILES } from "../git/operation";
import type { WorktreeScanner } from "../git/worktree";
import type { DiffSource } from "../types";

export async function digest(s: string): Promise<string> {
  return toHex(await sha1(new TextEncoder().encode(s))).slice(0, 16);
}

export interface WatchOrchestratorDeps {
  root: DirHandleLike;
  fs: FsaFs;
  db: ObjectDb;
  ignore: IgnoreRules;
  attrs: GitAttributes;
  scanner: WorktreeScanner;
  getHeadBranch: () => string | null;
  getLastSource: () => DiffSource | null;
  progress: (p: Progress) => void;
  dropHistoryCaches: () => void;
  assertOpen: () => void;
}

export class WatchOrchestrator {
  constructor(private readonly deps: WatchOrchestratorDeps) {}

  async probe(tier: ProbeTier): Promise<string> {
    this.deps.assertOpen();
    const t0 = performance.now();
    let sig: string;
    if (tier === "git") sig = await this.probeGit();
    else if (tier === "index") sig = await this.probeIndex();
    else sig = await this.probeUntracked();
    this.deps.progress({ phase: "probe", tier, durationMs: performance.now() - t0 });
    return sig;
  }

  private async statSig(path: string): Promise<string> {
    try {
      const s = await this.deps.fs.stat(path);
      return `${path}=${s.mtimeMs}:${s.size}`;
    } catch (e) {
      if (errorCode(e) === "ENOENT" || errorCode(e) === "ENOTDIR") return `${path}=-`;
      throw e;
    }
  }

  private async probeGit(): Promise<string> {
    const paths = new Set<string>([
      "/.git/HEAD",
      "/.git/index",
      "/.git/packed-refs",
      "/.git/config",
      "/.git/info/exclude",
      "/.git/ORIG_HEAD",
      // T10.2: the banner must follow git live, so every operation state file is in the signature
      ...OPERATION_FILES.map((f) => `/.git/${f}`),
    ]);
    const headBranch = this.deps.getHeadBranch();
    if (headBranch) paths.add(`/.git/refs/heads/${headBranch}`);
    const lastSource = this.deps.getLastSource();
    const last = lastSource ? sourceRefs(lastSource) : null;
    for (const ref of [last?.sourceRef, last?.targetRef]) {
      // only full ref names are files under .git; a range may name a SHA or `stash@{0}`
      if (ref?.startsWith("refs/")) paths.add(`/.git/${ref}`);
    }
    try {
      for (const remote of await this.deps.fs.readdirWithKinds("/.git/refs/remotes")) {
        if (remote.kind === "directory") paths.add(`/.git/refs/remotes/${remote.name}/HEAD`);
      }
    } catch (e) {
      if (errorCode(e) !== "ENOENT" && errorCode(e) !== "ENOTDIR") throw e;
      /* missing refs/remotes is normal */
    }
    const parts = await Promise.all([...paths].sort().map((p) => this.statSig(p)));
    return `git:${await digest(parts.join("\n"))}`;
  }

  private async probeIndex(): Promise<string> {
    let index: IndexSnapshot;
    try {
      index = await readIndex(this.deps.fs);
    } catch (e) {
      if (errorCode(e) === "ENOENT") return "index:none";
      throw e;
    }
    const parts: string[] = [];
    for (const e of index.entries) {
      if (e.stage !== 0) continue;
      parts.push(`${e.path}\t${e.size}\t${e.mtimeSec}.${e.mtimeNsec}\t${e.oid}`);
    }
    return `index:${index.entries.length}:${await digest(parts.join("\n"))}`;
  }

  /** Ignore-pruned walk of untracked paths straight off the handles (no FsaFs cache), count + hash. */
  private async probeUntracked(): Promise<string> {
    let tracked = new Set<string>();
    try {
      const index = await readIndex(this.deps.fs);
      tracked = new Set(index.entries.map((e) => e.path));
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
      /* repo with no index yet */
    }
    const found: string[] = [];
    const walk = async (dir: DirHandleLike, prefix: string): Promise<void> => {
      if (prefix) await this.deps.ignore.enterDir(prefix);
      for await (const [name, h] of dir.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (h.kind === "directory") {
          if (path === ".git" || this.deps.ignore.isDirIgnored(path)) continue;
          await walk(h, path);
        } else if (!tracked.has(path) && !this.deps.ignore.isFileIgnored(path)) found.push(path);
      }
    };
    await this.deps.ignore.enterDir("");
    await walk(this.deps.root, "");
    found.sort();
    return `untracked:${found.length}:${await digest(found.join("\n"))}`;
  }

  async invalidate(scope: InvalidateScope, paths?: string[]): Promise<void> {
    this.deps.assertOpen();
    if (scope === "refs") {
      this.deps.db.dropCaches(true);
      this.deps.fs.invalidatePath("/.git");
      this.deps.dropHistoryCaches();
      return;
    }
    if (scope === "worktree") {
      if (paths && paths.length > 0) {
        for (const p of paths) this.deps.fs.invalidatePath(`/${p.replace(/^\/+/, "")}`);
        this.deps.scanner.forgetPaths(paths);
        if (paths.some((p) => /(^|\/)\.gitignore$/.test(p))) this.deps.ignore.invalidate();
        if (paths.some((p) => /(^|\/)\.gitattributes$/.test(p))) this.deps.attrs.invalidate();
      } else {
        this.deps.fs.invalidateAll();
        this.deps.ignore.invalidate();
        this.deps.attrs.invalidate();
      }
      return;
    }
    this.deps.fs.invalidateAll();
    this.deps.db.dropCaches(true);
    this.deps.ignore.invalidate();
    this.deps.attrs.invalidate();
    this.deps.dropHistoryCaches();
  }

  async forceRehash(): Promise<void> {
    this.deps.assertOpen();
    this.deps.scanner.forgetStatCache();
    this.deps.fs.invalidateAll();
    this.deps.db.dropCaches(true);
    this.deps.ignore.invalidate();
    this.deps.attrs.invalidate();
    this.deps.dropHistoryCaches();
  }
}
