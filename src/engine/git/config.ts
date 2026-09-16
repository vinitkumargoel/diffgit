/**
 * Minimal `.git/config` parser (T1.5, Plan §5.3/§5.5/§5.6). Handles `[section]`,
 * `[section "sub"]`, the deprecated `[section.sub]`, `key = value`, bare `key` (= true), `#`/`;`
 * comments, quoted values with `\"` `\\` `\n` `\t` `\b` escapes, and `\` line continuation.
 * Section and key names are case-insensitive (stored lower-case); subsections are case-sensitive.
 * `include`/`includeIf` cannot be followed (files outside the repo) → warning `CONFIG_INCLUDE_SKIPPED`.
 */
import type { FsaFs } from "../fs/fsaFs";
import type { RepoWarning } from "../types";

export interface GitConfig {
  remotes: string[]; // [remote "x"] sections, in file order
  remoteUrls: Record<string, string>;
  core: {
    autocrlf?: "true" | "false" | "input";
    excludesFile?: string;
    ignoreCase?: boolean;
    symlinks?: boolean;
  };
  diff: { renameLimit?: number; renames?: boolean };
  extensions: { objectFormat?: string; partialClone?: string; refStorage?: string };
  /** "section" or "section.subsection" → lower-case key → last value. */
  raw: Record<string, Record<string, string>>;
  warnings: RepoWarning[];
  get(section: string, key: string, subsection?: string): string | undefined;
}

const TRUE = new Set(["true", "yes", "on", "1"]);
const FALSE = new Set(["false", "no", "off", "0", ""]);

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return undefined;
}

/** Strips comments (outside quotes), joins continuation lines, unescapes quoted text. */
function parseValue(rawValue: string): string {
  let out = "";
  let inQuote = false;
  let protectedUpTo = 0; // length of `out` produced inside quotes or by escapes: never trimmed
  for (let i = 0; i < rawValue.length; i++) {
    const c = rawValue[i] as string;
    if (c === "\\" && i + 1 < rawValue.length) {
      const n = rawValue[++i] as string;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n;
      protectedUpTo = out.length;
      continue;
    }
    if (c === '"') {
      inQuote = !inQuote;
      protectedUpTo = out.length;
      continue;
    }
    if (!inQuote && (c === "#" || c === ";")) break;
    out += c;
    if (inQuote) protectedUpTo = out.length;
  }
  return out.slice(0, protectedUpTo) + out.slice(protectedUpTo).trimEnd();
}

export function parseGitConfig(text: string): GitConfig {
  const raw: Record<string, Record<string, string>> = {};
  const warnings: RepoWarning[] = [];
  let sectionKey: string | null = null;
  let includeWarned = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] as string).trim();
    // continuation: a trailing unescaped backslash joins the next line
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = `${line.slice(0, -1)}${(lines[++i] as string).trim()}`;
    }
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (sec) {
      const name = (sec[1] as string).toLowerCase();
      const quoted = sec[2];
      if (quoted !== undefined) {
        sectionKey = `${name}.${quoted.replace(/\\(.)/g, "$1")}`;
      } else if (name.includes(".")) {
        // deprecated [section.subsection]: whole thing case-insensitive
        sectionKey = name;
      } else sectionKey = name;
      raw[sectionKey] ??= {};
      if ((name === "include" || name === "includeif") && !includeWarned) {
        includeWarned = true;
        warnings.push({
          code: "CONFIG_INCLUDE_SKIPPED",
          message:
            "Config include/includeIf directives were skipped (files outside the repository cannot be read).",
        });
      }
      continue;
    }
    if (sectionKey === null) continue; // keys before any section are invalid; ignore
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv) continue; // malformed line: git would error; we skip it
    const key = (kv[1] as string).toLowerCase();
    const value = kv[2] === undefined ? "true" : parseValue(kv[2]);
    (raw[sectionKey] as Record<string, string>)[key] = value;
  }

  const get = (section: string, key: string, subsection?: string) =>
    raw[
      subsection === undefined ? section.toLowerCase() : `${section.toLowerCase()}.${subsection}`
    ]?.[key.toLowerCase()];

  const remotes = Object.keys(raw)
    .filter((k) => k.startsWith("remote.") && k.length > 7)
    .map((k) => k.slice(7));
  const remoteUrls: Record<string, string> = {};
  for (const r of remotes) {
    const url = get("remote", "url", r);
    if (url !== undefined) remoteUrls[r] = url;
  }
  const autocrlfRaw = get("core", "autocrlf")?.toLowerCase();
  const autocrlf =
    autocrlfRaw === undefined
      ? undefined
      : autocrlfRaw === "input"
        ? "input"
        : parseBool(autocrlfRaw)
          ? "true"
          : "false";
  const renameLimitRaw = get("diff", "renameLimit");
  const renameLimit =
    renameLimitRaw !== undefined && /^\d+$/.test(renameLimitRaw)
      ? Number(renameLimitRaw)
      : undefined;
  const renamesRaw = get("diff", "renames");
  const renames =
    renamesRaw === undefined
      ? undefined
      : renamesRaw.toLowerCase() === "copies" || renamesRaw.toLowerCase() === "copy"
        ? true
        : parseBool(renamesRaw);

  return {
    remotes,
    remoteUrls,
    core: {
      ...(autocrlf !== undefined ? { autocrlf } : {}),
      ...(get("core", "excludesFile") !== undefined
        ? { excludesFile: get("core", "excludesFile") as string }
        : {}),
      ...(parseBool(get("core", "ignoreCase")) !== undefined
        ? { ignoreCase: parseBool(get("core", "ignoreCase")) as boolean }
        : {}),
      ...(parseBool(get("core", "symlinks")) !== undefined
        ? { symlinks: parseBool(get("core", "symlinks")) as boolean }
        : {}),
    },
    diff: {
      ...(renameLimit !== undefined ? { renameLimit } : {}),
      ...(renames !== undefined ? { renames } : {}),
    },
    extensions: {
      ...(get("extensions", "objectFormat") !== undefined
        ? { objectFormat: get("extensions", "objectFormat")?.toLowerCase() }
        : {}),
      ...(get("extensions", "partialClone") !== undefined
        ? { partialClone: get("extensions", "partialClone") }
        : {}),
      ...(get("extensions", "refStorage") !== undefined
        ? { refStorage: get("extensions", "refStorage")?.toLowerCase() }
        : {}),
    },
    raw,
    warnings,
    get,
  };
}

/** Reads `.git/config`; a missing file yields an empty config (git treats it the same). */
export async function loadGitConfig(fs: FsaFs): Promise<GitConfig> {
  let text = "";
  try {
    text = await fs.readText(".git/config");
  } catch (e) {
    // no .git/config, or .git is a file (linked worktree): layout checks report that separately
    const code = (e as { code?: string }).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") throw e;
  }
  return parseGitConfig(text);
}
