/**
 * `.gitattributes` lookup (T3.4 amendment): binary / -diff / -text / linguist-generated decide how a
 * file is classified. Precedence, like git: `.git/info/attributes` (highest), then the `.gitattributes`
 * closest to the path, up to the root one. Within a file later lines win. Patterns use gitignore
 * syntax, except negative patterns are not allowed and a pattern matching a directory does not match
 * the paths inside it. `core.attributesFile` lives outside the repo and is not read.
 */

import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";

/** `true` = set, `false` = unset (`-attr`), string = value, `"unspecified"` = `!attr`. */
export type AttrValue = true | false | string | { unspecified: true };
export type AttrMap = Map<string, AttrValue>;

interface Rule {
  match: (relPath: string) => boolean;
  attrs: [string, AttrValue][];
}

interface Layer {
  dir: string; // "" for root
  rules: Rule[];
}

/** git's built-in `binary` macro. */
const BUILTIN_MACROS: Record<string, string> = { binary: "-diff -merge -text" };

/** Converts one gitignore-style pattern into a matcher against a path relative to the pattern's dir. */
export function compilePattern(raw: string): ((relPath: string) => boolean) | null {
  let pattern = raw;
  if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) pattern = pattern.slice(1);
  else if (pattern.startsWith("!")) return null; // negative patterns are forbidden in .gitattributes
  if (pattern.endsWith("/")) return null; // directory-only pattern: never matches a file path
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const before = i === 0 || pattern[i - 1] === "/";
        const after = i + 2 >= pattern.length || pattern[i + 2] === "/";
        if (before && after) {
          if (i + 2 >= pattern.length) {
            re += ".*"; // trailing "/**": everything inside
            i += 2;
          } else {
            re += "(?:.*/)?"; // "**/" : zero or more directories
            i += 3;
          }
          continue;
        }
        re += "[^/]*"; // "**" inside a segment behaves like "*"
        i += 2;
        continue;
      }
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      // find the closing bracket, skipping POSIX classes like [:digit:]
      let j = i + 1;
      if (pattern[j] === "!" || pattern[j] === "^") j++;
      if (pattern[j] === "]") j++; // a leading "]" is literal
      let end = -1;
      while (j < pattern.length) {
        if (pattern[j] === "[" && pattern[j + 1] === ":") {
          const close = pattern.indexOf(":]", j + 2);
          if (close === -1) break;
          j = close + 2;
          continue;
        }
        if (pattern[j] === "]") {
          end = j;
          break;
        }
        j++;
      }
      if (end === -1) {
        re += "\\[";
        i++;
        continue;
      }
      let cls = pattern.slice(i + 1, end);
      if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
      re += `[${cls.replace(/\\/g, "\\\\").replace(/\[:(\w+):\]/g, (_, n: string) => POSIX_CLASSES[n] ?? "")}]`;
      i = end + 1;
    } else if (c === "\\" && i + 1 < pattern.length) {
      re += pattern[i + 1]?.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") ?? "";
      i += 2;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i++;
    }
  }
  const regex = new RegExp(`^${re}$`);
  if (anchored) return (p) => regex.test(p);
  return (p) => regex.test(p.slice(p.lastIndexOf("/") + 1));
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  digit: "0-9",
  lower: "a-z",
  upper: "A-Z",
  space: " \\t\\r\\n\\v\\f",
  punct: "!-/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
};

function parseAttrToken(tok: string): [string, AttrValue] | null {
  if (!tok) return null;
  if (tok.startsWith("-")) return [tok.slice(1), false];
  if (tok.startsWith("!")) return [tok.slice(1), { unspecified: true }];
  const eq = tok.indexOf("=");
  if (eq !== -1) return [tok.slice(0, eq), tok.slice(eq + 1)];
  return [tok, true];
}

/** Splits a line into the pattern (possibly quoted) and the attribute tokens. */
function splitLine(line: string): { pattern: string; tokens: string[] } | null {
  let s = line.replace(/\s+$/, "");
  if (!s || s.startsWith("#")) return null;
  let pattern: string;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end === -1) return null;
    pattern = s.slice(1, end).replace(/\\(.)/g, "$1");
    s = s.slice(end + 1);
  } else {
    const m = /^(\S+)/.exec(s);
    if (!m) return null;
    pattern = m[1] as string;
    s = s.slice(pattern.length);
  }
  return { pattern, tokens: s.trim().split(/\s+/).filter(Boolean) };
}

export function parseAttributes(
  text: string,
  macros: Record<string, string> = { ...BUILTIN_MACROS },
  allowMacroDefs = true,
): Rule[] {
  const rules: Rule[] = [];
  const expand = (tokens: string[], depth = 0): [string, AttrValue][] => {
    const out: [string, AttrValue][] = [];
    for (const tok of tokens) {
      const parsed = parseAttrToken(tok);
      if (!parsed) continue;
      const [name, value] = parsed;
      const macro = macros[name];
      if (macro !== undefined && value === true && depth < 8) {
        out.push(...expand(macro.split(/\s+/), depth + 1));
        out.push([name, true]);
      } else out.push([name, value]);
    }
    return out;
  };
  for (const line of text.split("\n")) {
    const parts = splitLine(line);
    if (!parts) continue;
    if (parts.pattern.startsWith("[attr]")) {
      if (allowMacroDefs) macros[parts.pattern.slice(6)] = parts.tokens.join(" ");
      continue;
    }
    const match = compilePattern(parts.pattern);
    if (!match) continue;
    rules.push({ match, attrs: expand(parts.tokens) });
  }
  return rules;
}

export class GitAttributes {
  private readonly layers = new Map<string, Layer>();
  private readonly loadedDirs = new Set<string>();
  private info: Rule[] = [];
  private readonly macros: Record<string, string> = { ...BUILTIN_MACROS };

  private constructor(private readonly fs: FsaFs) {}

  static async load(fs: FsaFs): Promise<GitAttributes> {
    const a = new GitAttributes(fs);
    await a.loadRoot();
    return a;
  }

  private async readOptional(path: string): Promise<string | null> {
    try {
      return await this.fs.readText(path);
    } catch (e) {
      const c = errorCode(e);
      if (c === "ENOENT" || c === "ENOTDIR" || c === "EISDIR") return null;
      throw e;
    }
  }

  private async loadRoot(): Promise<void> {
    // Macros may only be defined at the root (and in info/attributes); load those first.
    await this.loadDir("");
    const info = await this.readOptional("/.git/info/attributes");
    this.info = info === null ? [] : parseAttributes(info, this.macros, true);
  }

  private async loadDir(dir: string): Promise<void> {
    if (this.loadedDirs.has(dir)) return;
    this.loadedDirs.add(dir);
    const text = await this.readOptional(dir ? `/${dir}/.gitattributes` : "/.gitattributes");
    if (text === null) return;
    this.layers.set(dir, { dir, rules: parseAttributes(text, this.macros, dir === "") });
  }

  /** Effective attributes for a repo-relative path. */
  async attributesFor(path: string): Promise<AttrMap> {
    const segs = path.split("/");
    const dirs: string[] = [""];
    for (let i = 1; i < segs.length; i++) dirs.push(segs.slice(0, i).join("/"));
    for (const d of dirs) await this.loadDir(d);
    const out: AttrMap = new Map();
    const apply = (rules: Rule[], rel: string) => {
      for (const r of rules) if (r.match(rel)) for (const [k, v] of r.attrs) out.set(k, v);
    };
    for (const d of dirs) {
      const layer = this.layers.get(d);
      if (layer) apply(layer.rules, d ? path.slice(d.length + 1) : path);
    }
    apply(this.info, path);
    return out;
  }

  /** git's `diff_filespec_is_binary` attribute part: `-diff` or `-text` (incl. the `binary` macro). */
  async isBinary(path: string): Promise<boolean> {
    const a = await this.attributesFor(path);
    return a.get("diff") === false || a.get("text") === false;
  }

  /** GitHub-style collapse: `linguist-generated` (true) or `-diff`. */
  async isGenerated(path: string): Promise<boolean> {
    const a = await this.attributesFor(path);
    const lg = a.get("linguist-generated");
    return lg === true || lg === "true" || a.get("diff") === false;
  }

  /** Forget everything; the next lookup re-reads the files (T6 refresh). */
  invalidate(): void {
    this.layers.clear();
    this.loadedDirs.clear();
    this.info = [];
    for (const k of Object.keys(this.macros)) delete this.macros[k];
    Object.assign(this.macros, BUILTIN_MACROS);
  }

  async reload(): Promise<void> {
    this.invalidate();
    await this.loadRoot();
  }
}
