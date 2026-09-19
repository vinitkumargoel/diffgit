/**
 * Ignore rules with directory pruning (T2.3, Plan §5.5 step 3).
 *
 * One `ignore()` instance per directory that has a `.gitignore`, evaluated against paths relative to
 * that directory (so anchored/unanchored semantics are the package's, re-rooted correctly).
 * Precedence, deepest first: `<dir>/.gitignore` … root `.gitignore`, then `.git/info/exclude`, then
 * the built-in defaults. The first file whose rules give a verdict (ignored or negated) wins; a file
 * inside an ignored directory can never be re-included (git rule). `core.excludesFile` cannot be read
 * from the browser → `GLOBAL_EXCLUDES_UNAVAILABLE` warning once.
 *
 * T10.4 adds `explain()`: the same walk, but reporting *which* rule decided, the way
 * `git check-ignore -v` does. Attribution is a second, lazier index over the very same rule text —
 * one single-rule matcher per line, built on first use — because the `ignore` package's `test()`
 * only hands back the rule for a positive match and never for a negation.
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

/** `source` of a match that came from `.git/info/exclude`, spelled as `git check-ignore -v` does. */
export const EXCLUDE_SOURCE = ".git/info/exclude";
/**
 * `source` of a match that came from diffgit's own defaults. git has no such file, so
 * `git check-ignore -v` prints `::` for these paths — the one documented divergence (B10 turns the
 * defaults off, `OpenOptions.builtinExcludes`).
 */
export const BUILTIN_SOURCE = "(built-in excludes)";

/** One rule of a `.gitignore`-shaped file, as `git check-ignore -v` names it (T10.4). */
export interface IgnoreMatch {
  /** `.gitignore`, `src/.gitignore`, `.git/info/exclude` or `BUILTIN_SOURCE`. */
  source: string;
  /** 1-based line inside `source`. */
  line: number;
  /** The rule verbatim, including a leading `!` — git prints it that way. */
  pattern: string;
  negated: boolean;
}

interface RuleLine extends IgnoreMatch {
  /** A matcher holding this one rule: the only way to see a negation match at all. */
  ig: Ignore;
}

interface Layer {
  dir: string; // "" for root
  ig: Ignore;
  text: string; // kept verbatim for `explain()`
}

/** The lines the `ignore` package keeps: not blank, not a comment, not an invalid trailing `\`. */
function isRulePattern(line: string): boolean {
  return line.length > 0 && !/^\s+$/.test(line) && !/(?:[^\\]|^)\\$/.test(line) && line[0] !== "#";
}

export class IgnoreRules {
  private readonly layers = new Map<string, Layer>(); // dir → layer (only dirs with a .gitignore)
  private readonly loadedDirs = new Set<string>(); // dirs whose .gitignore presence was checked
  private exclude: Ignore | null = null; // .git/info/exclude
  private excludeText: string | null = null;
  private builtin: Ignore | null = null;
  private readonly dirVerdicts = new Map<string, boolean>();
  /** `explain()` only: source name → its rules, one single-rule matcher each (built on first use). */
  private readonly ruleCache = new Map<string, RuleLine[]>();
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
    this.excludeText = excl;
    this.exclude = excl === null ? null : this.newIg().add(excl);
    await this.enterDir("");
  }

  /** Lazily reads `<dir>/.gitignore`; idempotent. Call before testing children of `dir`. */
  async enterDir(dirPath: string): Promise<void> {
    const dir = dirPath.replace(/^\/+|\/+$/g, "");
    if (this.loadedDirs.has(dir)) return;
    this.loadedDirs.add(dir);
    const text = await this.readOrNull(dir === "" ? ".gitignore" : `${dir}/.gitignore`);
    if (text !== null) this.layers.set(dir, { dir, ig: this.newIg().add(text), text });
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

  // ---- rule attribution (T10.4) ---------------------------------------------------------------

  /** The rules of one `.gitignore`-shaped source, each behind its own matcher. Cached per source. */
  private ruleLines(source: string, text: string): RuleLine[] {
    const cached = this.ruleCache.get(source);
    if (cached) return cached;
    const rules: RuleLine[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const pattern = lines[i] as string;
      if (!isRulePattern(pattern)) continue;
      rules.push({
        source,
        line: i + 1,
        pattern,
        negated: pattern.startsWith("!"),
        ig: this.newIg().add(pattern),
      });
    }
    this.ruleCache.set(source, rules);
    return rules;
  }

  /** git's "last matching rule in the file wins": scan backwards, first hit answers. */
  private lastMatch(source: string, text: string, rel: string): IgnoreMatch | null {
    const rules = this.ruleLines(source, text);
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i] as RuleLine;
      const t = r.ig.test(rel);
      if (t.ignored || t.unignored)
        return { source: r.source, line: r.line, pattern: r.pattern, negated: r.negated };
    }
    return null;
  }

  /** `verdict()`, but naming the rule: nearest `.gitignore`, then `info/exclude`, then built-ins. */
  private matchRule(path: string, isDir: boolean): IgnoreMatch | null {
    const probe = isDir ? `${path}/` : path;
    let dir = path;
    for (;;) {
      const slash = dir.lastIndexOf("/");
      dir = slash === -1 ? "" : dir.slice(0, slash);
      const layer = this.layers.get(dir);
      if (layer) {
        const rel = dir === "" ? probe : probe.slice(dir.length + 1);
        const m = this.lastMatch(dir === "" ? ".gitignore" : `${dir}/.gitignore`, layer.text, rel);
        if (m) return m;
      }
      if (dir === "") break;
    }
    if (this.excludeText !== null) {
      const m = this.lastMatch(EXCLUDE_SOURCE, this.excludeText, probe);
      if (m) return m;
    }
    if (this.builtin) {
      const m = this.lastMatch(BUILTIN_SOURCE, BUILTIN_EXCLUDES.join("\n"), probe);
      if (m) return m;
    }
    return null;
  }

  /**
   * Which rule decided this path, in `git check-ignore -v` terms, or null when none matched.
   * A negated last match is returned too (`negated: true` — the path is *not* ignored): that is
   * what git prints, and the UI says "re-included by …".
   *
   * git stops at the outermost excluded directory on the way down and reports the rule that
   * excluded *it*, because it never looks inside — so does this. The caller must have loaded the
   * ancestors' `.gitignore` files (`ensureAncestors`), exactly like `isFileIgnored`.
   */
  explain(path: string, isDir = false): IgnoreMatch | null {
    const p = path.replace(/^\/+|\/+$/g, "");
    if (p === "") return null;
    const segs = p.split("/");
    let dir = "";
    for (let i = 0; i < segs.length - 1; i++) {
      dir = dir === "" ? (segs[i] as string) : `${dir}/${segs[i]}`;
      const m = this.matchRule(dir, true);
      if (m && !m.negated) return m;
    }
    return this.matchRule(p, isDir);
  }

  /** Convenience for non-walking callers: loads ancestors first (as `isPathIgnored` does). */
  async explainPath(path: string, kind: "file" | "directory"): Promise<IgnoreMatch | null> {
    await this.ensureAncestors(kind === "directory" ? `${path}/x` : path);
    return this.explain(path, kind === "directory");
  }

  /** Drops every cached `.gitignore` and verdict (T6.1 calls this when ignore files change). */
  invalidate(): void {
    this.layers.clear();
    this.loadedDirs.clear();
    this.dirVerdicts.clear();
    this.ruleCache.clear();
    this.exclude = null;
    this.excludeText = null;
  }

  /** Re-reads root `.gitignore` and `.git/info/exclude` after `invalidate()`. */
  async reload(): Promise<void> {
    this.invalidate();
    await this.loadRoot();
  }
}
