/**
 * Ignore rules with directory pruning (T2.3, Plan §5.5 step 3).
 *
 * One `ignore()` instance per directory that has a `.gitignore`, evaluated against paths relative to
 * that directory (so anchored/unanchored semantics are the package's, re-rooted correctly).
 * Precedence, deepest first: `<dir>/.gitignore` … root `.gitignore`, then `.git/info/exclude`, then
 * the built-in defaults. The first file whose rules give a verdict (ignored or negated) wins; a file
 * inside an ignored directory can never be re-included (git rule). `core.excludesFile` cannot be read
 * from the browser → `GLOBAL_EXCLUDES_UNAVAILABLE` warning once.
 */
import ignore, { type Ignore } from "ignore";
import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { RepoWarning } from "../types";
import type { GitConfig } from "./config";

export interface IgnoreOptions {
  /** Apply `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini` at lowest precedence (default true). */
  builtinExcludes?: boolean;
  config?: GitConfig;
}

const BUILTIN_EXCLUDES = [".DS_Store", "._*", "Thumbs.db", "desktop.ini"];

interface Layer {
  dir: string; // "" for root
  ig: Ignore;
}

export class IgnoreRules {
  private readonly layers = new Map<string, Layer>(); // dir → layer (only dirs with a .gitignore)
  private readonly loadedDirs = new Set<string>(); // dirs whose .gitignore presence was checked
  private exclude: Ignore | null = null; // .git/info/exclude
  private builtin: Ignore | null = null;
  private readonly dirVerdicts = new Map<string, boolean>();
  readonly warnings: RepoWarning[] = [];
  private readonly ignorecase: boolean;

  private constructor(
    private readonly fs: FsaFs,
    opts: IgnoreOptions,
  ) {
    this.ignorecase = opts.config?.core.ignoreCase ?? false;
    if (opts.builtinExcludes !== false) this.builtin = this.newIg().add(BUILTIN_EXCLUDES);
    if (opts.config?.core.excludesFile) {
      this.warnings.push({
        code: "GLOBAL_EXCLUDES_UNAVAILABLE",
        message: `core.excludesFile (${opts.config.core.excludesFile}) is outside the repository and is not applied; some untracked files may appear that git ignores.`,
      });
    }
  }

  static async load(fs: FsaFs, opts: IgnoreOptions = {}): Promise<IgnoreRules> {
    const rules = new IgnoreRules(fs, opts);
    await rules.loadRoot();
    return rules;
  }

  private newIg(): Ignore {
    return ignore({ ignorecase: this.ignorecase, allowRelativePaths: false });
  }

  private async readOrNull(path: string): Promise<string | null> {
    try {
      return await this.fs.readText(path);
    } catch (e) {
      const c = errorCode(e);
      if (c === "ENOENT" || c === "ENOTDIR" || c === "EISDIR") return null;
      throw e;
    }
  }

  private async loadRoot(): Promise<void> {
    const excl = await this.readOrNull(".git/info/exclude");
    this.exclude = excl === null ? null : this.newIg().add(excl);
    await this.enterDir("");
  }

  /** Lazily reads `<dir>/.gitignore`; idempotent. Call before testing children of `dir`. */
  async enterDir(dirPath: string): Promise<void> {
    const dir = dirPath.replace(/^\/+|\/+$/g, "");
    if (this.loadedDirs.has(dir)) return;
    this.loadedDirs.add(dir);
    const text = await this.readOrNull(dir === "" ? ".gitignore" : `${dir}/.gitignore`);
    if (text !== null) this.layers.set(dir, { dir, ig: this.newIg().add(text) });
  }

  /** Loads every ancestor `.gitignore` of `path` (for callers that did not walk). */
  async ensureAncestors(path: string): Promise<void> {
    const segs = path.split("/").filter(Boolean);
    let dir = "";
    await this.enterDir(dir);
    for (let i = 0; i < segs.length - 1; i++) {
      dir = dir === "" ? (segs[i] as string) : `${dir}/${segs[i]}`;
      await this.enterDir(dir);
    }
  }

  /** Verdict from the layered rules for a path (`isDir` adds the trailing slash git uses). */
  private verdict(path: string, isDir: boolean): boolean {
    const probe = isDir ? `${path}/` : path;
    // deepest .gitignore first
    let dir = path;
    for (;;) {
      const slash = dir.lastIndexOf("/");
      dir = slash === -1 ? "" : dir.slice(0, slash);
      const layer = this.layers.get(dir);
      if (layer) {
        const rel = dir === "" ? probe : probe.slice(dir.length + 1);
        const r = layer.ig.test(rel);
        if (r.ignored) return true;
        if (r.unignored) return false;
      }
      if (dir === "") break;
    }
    if (this.exclude) {
      const r = this.exclude.test(probe);
      if (r.ignored) return true;
      if (r.unignored) return false;
    }
    if (this.builtin) return this.builtin.test(probe).ignored;
    return false;
  }

  /** True when `dirPath` or any ancestor is ignored (so the walker must not descend). */
  isDirIgnored(dirPath: string): boolean {
    const dir = dirPath.replace(/^\/+|\/+$/g, "");
    if (dir === "") return false;
    const cached = this.dirVerdicts.get(dir);
    if (cached !== undefined) return cached;
    const slash = dir.lastIndexOf("/");
    const parentIgnored = slash === -1 ? false : this.isDirIgnored(dir.slice(0, slash));
    const result = parentIgnored || this.verdict(dir, true);
    this.dirVerdicts.set(dir, result);
    return result;
  }

  isFileIgnored(filePath: string): boolean {
    const path = filePath.replace(/^\/+/, "");
    const slash = path.lastIndexOf("/");
    if (slash !== -1 && this.isDirIgnored(path.slice(0, slash))) return true;
    return this.verdict(path, false);
  }

  /** Convenience for non-walking callers: loads ancestors first. */
  async isPathIgnored(path: string, kind: "file" | "directory"): Promise<boolean> {
    await this.ensureAncestors(kind === "directory" ? `${path}/x` : path);
    return kind === "directory" ? this.isDirIgnored(path) : this.isFileIgnored(path);
  }

  /** Drops every cached `.gitignore` and verdict (T6.1 calls this when ignore files change). */
  invalidate(): void {
    this.layers.clear();
    this.loadedDirs.clear();
    this.dirVerdicts.clear();
    this.exclude = null;
  }

  /** Re-reads root `.gitignore` and `.git/info/exclude` after `invalidate()`. */
  async reload(): Promise<void> {
    this.invalidate();
    await this.loadRoot();
  }
}
