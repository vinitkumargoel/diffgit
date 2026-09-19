/**
 * Submodules (T10.12, atlas tab 19): what the superproject records, and what is actually checked
 * out under the folder the user picked.
 *
 * `git submodule status` answers the same question with three pieces of state:
 *
 *  * the **recorded** commit — the gitlink entry (mode `160000`) in the superproject's HEAD tree;
 *  * the **checked-out** commit — `HEAD` of the repository living at `<path>`, which since git 1.7.8
 *    is usually not a `.git` directory at all but a `.git` *file* holding `gitdir: ../.git/modules/<name>`;
 *  * whether that checkout is dirty, which needs a full status of the submodule's own working tree.
 *
 * The first two are cheap and are computed here. The third is not: it means running the whole
 * scanner against a second index and a second object database, so `SubmoduleInfo.dirty` is null —
 * "not computed", which the contract fixes and atlas tab 19's card never shows.
 *
 * Everything is read through `FsaFs`, so a submodule whose gitdir escapes the picked folder (an
 * absolute `gitdir:` line, or `../../` out of the root) simply has no checked-out commit. That is
 * the honest answer: the browser cannot see it.
 */
import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import { MODE_GITLINK, type Oid, type SubmoduleInfo } from "../types";
import type { FlatTree } from "./objectDb";

/** One `[submodule "<name>"]` section of `.gitmodules`, as far as this reader cares. */
export interface GitmodulesEntry {
  name: string;
  path: string;
  url: string | null;
}

export const GITMODULES_FILE = ".gitmodules";

/**
 * The `[submodule "<name>"]` sections of `.gitmodules`, keyed by their `path` value.
 *
 * `.gitmodules` is a git config file, but `parseGitConfig` answers a fixed, typed `GitConfig`
 * rather than a raw section map, so this is the same grammar restricted to what a submodule
 * section can hold: section headers with a quoted subsection, `key = value`, `#`/`;` comments and
 * quoted values. A section without a `path` is skipped, exactly as `git submodule` skips it.
 */
export function parseGitmodules(text: string): GitmodulesEntry[] {
  const sections = new Map<string, { path?: string; url?: string }>();
  let current: { path?: string; url?: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[\s*submodule\s+"((?:[^"\\]|\\.)*)"\s*\]/i.exec(line);
    if (head) {
      const name = (head[1] as string).replace(/\\(.)/g, "$1");
      current = sections.get(name) ?? {};
      sections.set(name, current);
      continue;
    }
    if (/^\[/.test(line)) {
      current = null; // some other section: [core], [branch "x"], …
      continue;
    }
    if (current === null) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] as string).toLowerCase();
    if (key !== "path" && key !== "url") continue;
    current[key] = unquoteConfigValue(kv[2] as string);
  }
  const out: GitmodulesEntry[] = [];
  for (const [name, s] of sections) {
    if (s.path === undefined || s.path === "") continue;
    out.push({ name, path: normalisePath(s.path), url: s.url ?? null });
  }
  return out;
}

/** git's config value rules, reduced: strip an unquoted trailing comment, unescape, trim. */
function unquoteConfigValue(raw: string): string {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[++i] as string;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
      continue;
    }
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && (c === "#" || c === ";")) break;
    out += c;
  }
  return out.trim();
}

function normalisePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

async function readTextOrNull(fs: FsaFs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (e) {
    const c = errorCode(e);
    if (c === "ENOENT" || c === "EISDIR" || c === "ENOTDIR" || c === "EINVAL") return null;
    throw e;
  }
}

/**
 * Resolve the `gitdir:` line of a submodule's `.git` file against the submodule's own directory,
 * and answer a repo-relative path — or null when it escapes the folder the user picked, which
 * `FsaFs` refuses to leave (`normalizePath` throws `EINVAL` on a `..` that walks out of the root).
 */
export function resolveGitdirLine(submodulePath: string, line: string): string | null {
  const target = line.replace(/^gitdir:\s*/, "").trim();
  if (target === "") return null;
  if (target.startsWith("/")) return null; // absolute: outside the picked folder by construction
  const parts = `${submodulePath}/${target}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null; // walked out of the picked folder
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.length === 0 ? null : stack.join("/");
}

/**
 * `HEAD` of the repository whose git directory is `gitdir`, resolved through that directory's own
 * loose refs and `packed-refs`. A submodule's refs are its own; the superproject's `ObjectDb`
 * knows nothing about them, so this is a deliberately small second resolver rather than a reuse of
 * `RefStore` (which is bound to `/.git`).
 */
export async function readHeadOid(fs: FsaFs, gitdir: string): Promise<Oid | null> {
  const head = await readTextOrNull(fs, `/${gitdir}/HEAD`);
  if (head === null) return null;
  const text = head.trim();
  if (/^[0-9a-f]{40}$/.test(text)) return text;
  const symref = /^ref:\s*(\S+)$/.exec(text);
  if (!symref) return null;
  const ref = symref[1] as string;
  const loose = await readTextOrNull(fs, `/${gitdir}/${ref}`);
  if (loose !== null && /^[0-9a-f]{40}/.test(loose.trim())) return loose.trim().slice(0, 40);
  const packed = await readTextOrNull(fs, `/${gitdir}/packed-refs`);
  if (packed === null) return null;
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const m = /^([0-9a-f]{40})\s+(.+)$/.exec(line.trim());
    if (m && m[2] === ref) return m[1] as string;
  }
  return null;
}

/** The commit checked out at `<path>`, or null when there is no readable repository there. */
export async function checkedOutOid(fs: FsaFs, path: string): Promise<Oid | null> {
  const dotGit = `/${path}/.git`;
  let isDir: boolean;
  try {
    isDir = (await fs.stat(dotGit)).type === "dir";
  } catch (e) {
    const c = errorCode(e);
    if (c === "ENOENT" || c === "ENOTDIR" || c === "EINVAL") return null;
    throw e;
  }
  if (isDir) return readHeadOid(fs, `${path}/.git`);
  const text = await readTextOrNull(fs, dotGit);
  if (text === null || !/^gitdir:/.test(text.trim())) return null;
  const gitdir = resolveGitdirLine(path, text.trim().split("\n")[0] as string);
  return gitdir === null ? null : readHeadOid(fs, gitdir);
}

export interface SubmoduleDeps {
  fs: FsaFs;
  /** Structural, so a test can hand over one tree without building an object database. */
  db: { flattenTree(oid: Oid): Promise<FlatTree> };
}

/**
 * Every gitlink in the HEAD tree, with the URL `.gitmodules` records for it and the commit checked
 * out under the picked folder. Sorted by path, like `git submodule status`.
 *
 * A path listed in `.gitmodules` with no gitlink at HEAD is **not** reported: `git submodule
 * status` walks the index/tree entries too, and a `.gitmodules` entry on its own is a configuration
 * leftover, not a submodule of this commit.
 */
export async function listSubmodules(
  deps: SubmoduleDeps,
  headOid: Oid | null,
): Promise<SubmoduleInfo[]> {
  const modulesText = await readTextOrNull(deps.fs, `/${GITMODULES_FILE}`);
  const urls = new Map<string, string | null>();
  if (modulesText !== null) for (const e of parseGitmodules(modulesText)) urls.set(e.path, e.url);

  const gitlinks: { path: string; oid: Oid }[] = [];
  if (headOid !== null) {
    const tree = await deps.db.flattenTree(headOid);
    for (const [path, entry] of Object.entries(tree)) {
      if (entry.mode === MODE_GITLINK) gitlinks.push({ path, oid: entry.oid });
    }
  }
  gitlinks.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const out: SubmoduleInfo[] = [];
  for (const g of gitlinks) {
    out.push({
      path: g.path,
      url: urls.get(g.path) ?? null,
      recorded: g.oid,
      checkedOut: await checkedOutOid(deps.fs, g.path),
      // Not computed: a real answer needs the submodule's own index and a second worktree scan.
      dirty: null,
    });
  }
  return out;
}
