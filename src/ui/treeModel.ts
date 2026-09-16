/**
 * Sidebar tree model (T4.2 selector, consumed by T5.2): nests files by directory and compacts
 * single-child directory chains into one node (`src/engine/git`), like GitHub's file tree.
 */
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
export function flattenTree(
  nodes: TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "dir" && !collapsed.has(node.path)) {
      rows.push(...flattenTree(node.children, collapsed, depth + 1));
    }
  }
  return rows;
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
