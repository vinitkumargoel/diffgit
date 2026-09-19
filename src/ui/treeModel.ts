/**
 * Sidebar tree model (T4.2 selector, consumed by T5.2): nests files by directory and compacts
 * single-child directory chains into one node (`src/engine/git`), like GitHub's file tree.
 */
import type { ConflictKind } from "../engine/api";
import type { FileDiff } from "../engine/types";

export interface TreeDir {
  kind: "dir";
  name: string; // display name, may contain "/" after compaction
  path: string; // full directory path
  children: TreeNode[]; // dirs first, then files, each alphabetically
}
export interface TreeFile {
  kind: "file";
  name: string;
  path: string;
  file: FileDiff;
}
export type TreeNode = TreeDir | TreeFile;

export function filePathOf(file: FileDiff): string {
  return file.newPath ?? file.oldPath ?? file.id;
}

interface Building {
  dirs: Map<string, Building>;
  files: TreeFile[];
}

export function buildTree(files: readonly FileDiff[]): TreeNode[] {
  const root: Building = { dirs: new Map(), files: [] };
  for (const file of files) {
    const path = filePathOf(file);
    const segs = path.split("/");
    const name = segs.pop() ?? path;
    let node = root;
    for (const seg of segs) {
      let next = node.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.push({ kind: "file", name, path, file });
  }
  return finish(root, "");
}

function finish(node: Building, prefix: string): TreeNode[] {
  const dirs: TreeDir[] = [];
  for (const [seg, child] of [...node.dirs.entries()].sort(([a], [b]) => compare(a, b))) {
    let name = seg;
    let path = prefix ? `${prefix}/${seg}` : seg;
    let cur = child;
    // compact chains of directories that contain exactly one subdirectory and no files
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const [[onlySeg, only]] = [...cur.dirs.entries()];
      name = `${name}/${onlySeg}`;
      path = `${path}/${onlySeg}`;
      cur = only;
    }
    dirs.push({ kind: "dir", name, path, children: finish(cur, path) });
  }
  const files = [...node.files].sort((a, b) => compare(a.name, b.name));
  return [...dirs, ...files];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Flattens the tree to rows (respecting collapsed directories) for virtualised rendering. */
export interface TreeRow {
  node: TreeNode;
  depth: number;
}
/**
 * `prefix` namespaces the collapsed keys (T9.1): grouped sidebars key a directory
 * `"<groupId>:<path>"`, so the same folder can be open in Staged and closed in Unstaged.
 */
export function flattenTree(
  nodes: TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
  prefix = "",
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "dir" && !collapsed.has(prefix + node.path)) {
      rows.push(...flattenTree(node.children, collapsed, depth + 1, prefix));
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ T9.1: sidebar groups */

export type SidebarGroupId = "conflict" | "staged" | "unstaged" | "untracked" | "committed";

/** D1: display order. */
export const GROUP_ORDER: readonly SidebarGroupId[] = [
  "conflict",
  "staged",
  "unstaged",
  "untracked",
  "committed",
];

/** D3: a file appears once, in the least-committed layer it touches. */
const GROUP_PRECEDENCE: readonly SidebarGroupId[] = [
  "conflict",
  "unstaged",
  "staged",
  "untracked",
  "committed",
];

export function groupOf(file: Pick<FileDiff, "layers">): SidebarGroupId {
  for (const id of GROUP_PRECEDENCE) {
    if (file.layers.includes(id)) return id;
  }
  return "committed";
}

export interface FileGroup {
  id: SidebarGroupId;
  files: FileDiff[];
  tree: TreeNode[];
}

/** Non-empty groups in `GROUP_ORDER`; `files` keep the engine (path) order. */
export function groupFiles(files: readonly FileDiff[]): FileGroup[] {
  const buckets = new Map<SidebarGroupId, FileDiff[]>();
  for (const file of files) {
    const id = groupOf(file);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(file);
    else buckets.set(id, [file]);
  }
  const out: FileGroup[] = [];
  for (const id of GROUP_ORDER) {
    const group = buckets.get(id);
    if (group && group.length > 0) out.push({ id, files: group, tree: buildTree(group) });
  }
  return out;
}

export interface LayerCodeInfo {
  x: string;
  y: string;
  label: string;
}

/** The empty column of `git status --short`. */
const EMPTY_COLUMN = "·";
const STATUS_LETTER: Record<FileDiff["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
};

/**
 * T11.3: git's XY column for an unmerged path, which only `ConflictPayload.kind` can tell apart —
 * `UD` and `DU` are both `status: "deleted"` on the row. Until the payload lands (it is fetched as
 * soon as the diff commits) the row says "Unmerged path" without claiming one of the five codes.
 */
export function conflictCode(kind: ConflictKind | undefined): LayerCodeInfo {
  switch (kind) {
    case "both-modified":
      return { x: "U", y: "U", label: "Both modified (UU)" };
    case "both-added":
      return { x: "A", y: "A", label: "Both added (AA)" };
    case "deleted-by-us":
      return { x: "D", y: "U", label: "Deleted by us (DU)" };
    case "deleted-by-them":
      return { x: "U", y: "D", label: "Deleted by them (UD)" };
    case "both-deleted":
      return { x: "D", y: "D", label: "Both deleted (DD)" };
    default:
      return { x: "U", y: "U", label: "Unmerged path" };
  }
}

/** D4: git's `status --short` XY column, or null for a committed-only file. */
export function layerCode(
  file: Pick<FileDiff, "layers" | "status">,
  conflictKind?: ConflictKind,
): LayerCodeInfo | null {
  const layers = file.layers;
  if (layers.includes("conflict")) return conflictCode(conflictKind);
  if (layers.includes("untracked")) return { x: "?", y: "?", label: "Untracked file (??)" };
  const staged = layers.includes("staged");
  const unstaged = layers.includes("unstaged");
  const letter = STATUS_LETTER[file.status];
  if (staged && unstaged) {
    if (file.status === "deleted") return { x: "M", y: "D", label: "Staged, then deleted (MD)" };
    return { x: letter, y: "M", label: `Staged, then edited again (${letter}M)` };
  }
  if (staged)
    return { x: letter, y: EMPTY_COLUMN, label: `Staged only (${letter}${EMPTY_COLUMN})` };
  if (unstaged)
    return { x: EMPTY_COLUMN, y: letter, label: `Unstaged only (${EMPTY_COLUMN}${letter})` };
  return null;
}

/** D7: the summary a collapsed folder row shows. `complete` is false while a countable file
 * inside it (not binary, not `tooLarge`) has no stats yet. */
export function dirSummary(
  node: TreeDir,
  stats: (f: FileDiff) => FileDiff["stats"],
): { files: number; additions: number; deletions: number; complete: boolean } {
  const out = { files: 0, additions: 0, deletions: 0, complete: true };
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const child of nodes) {
      if (child.kind === "dir") {
        walk(child.children);
        continue;
      }
      out.files++;
      const st = stats(child.file);
      if (st) {
        out.additions += st.additions;
        out.deletions += st.deletions;
      } else if (!child.file.binary && !child.file.tooLarge) out.complete = false;
    }
  };
  walk(node.children);
  return out;
}

/** `status:M` / `status:modified` and `layer:staged` tokens (S1: the breakdowns are click targets). */
const STATUS_TOKENS: Record<string, FileDiff["status"][]> = {
  m: ["modified"],
  modified: ["modified"],
  a: ["added"],
  added: ["added"],
  d: ["deleted"],
  deleted: ["deleted"],
  r: ["renamed", "copied"],
  renamed: ["renamed", "copied"],
  c: ["copied"],
  copied: ["copied"],
  t: ["typechange"],
  typechange: ["typechange"],
};
const LAYER_TOKENS = new Set(["staged", "unstaged", "untracked", "conflict", "committed"]);

export interface ParsedFilter {
  /** Free text / glob part, may be empty. */
  path: string;
  statuses: FileDiff["status"][] | null;
  layers: string[] | null;
  generated: boolean | null;
}

/** Splits `status:M layer:staged src/` into its parts; unknown tokens stay in `path`. */
export function parseFilter(filter: string): ParsedFilter {
  const out: ParsedFilter = { path: "", statuses: null, layers: null, generated: null };
  const words: string[] = [];
  for (const w of filter.trim().split(/\s+/)) {
    if (w === "") continue;
    const m = /^(status|layer|is):(.+)$/i.exec(w);
    if (!m) {
      words.push(w);
      continue;
    }
    const key = (m[1] as string).toLowerCase();
    const val = (m[2] as string).toLowerCase();
    if (key === "status" && STATUS_TOKENS[val]) {
      out.statuses = [...(out.statuses ?? []), ...(STATUS_TOKENS[val] as FileDiff["status"][])];
    } else if (key === "layer" && LAYER_TOKENS.has(val)) {
      out.layers = [...(out.layers ?? []), val];
    } else if (key === "is" && val === "generated") {
      out.generated = true;
    } else words.push(w);
  }
  out.path = words.join(" ");
  return out;
}

/** Full file filter: path substring/glob plus `status:` / `layer:` / `is:generated` tokens. */
export function makeFileFilter(filter: string): (f: FileDiff) => boolean {
  const p = parseFilter(filter);
  const path = makePathFilter(p.path);
  return (f) => {
    if (p.statuses && !p.statuses.includes(f.status)) return false;
    if (p.layers && !p.layers.some((l) => (f.layers as string[]).includes(l))) return false;
    if (p.generated !== null && !!f.generated !== p.generated) return false;
    return path(filePathOf(f));
  };
}

/** Substring match (case-insensitive) or glob when the filter contains `*` / `?`. */
export function makePathFilter(filter: string): (path: string) => boolean {
  const f = filter.trim();
  if (f === "") return () => true;
  if (/[*?]/.test(f)) {
    let re = "";
    for (let i = 0; i < f.length; i++) {
      const c = f[i] as string;
      if (c === "*") {
        if (f[i + 1] === "*") {
          re += ".*";
          i++;
          if (f[i + 1] === "/") i++;
        } else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    const anchored = f.includes("/") ? `^${re}$` : `(^|/)${re}$`;
    const rx = new RegExp(anchored, "i");
    return (path) => rx.test(path);
  }
  const needle = f.toLowerCase();
  return (path) => path.toLowerCase().includes(needle);
}
