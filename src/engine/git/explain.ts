/**
 * "Why is this file hidden" (T10.4, atlas tab 08, Design §14.3): one path, every reason diffgit has
 * for not showing it. Pure lookup over things the session already holds — the ignore chain, the
 * index flags, the size gate and `.gitattributes` — so it costs one stat at most and never walks.
 *
 * The five answers a developer is actually asking about are `ignored` (which rule, in
 * `git check-ignore -v` terms), `skip-worktree`, `assume-unchanged`, `sparse` and `too-large`;
 * `generated` and `clean` are the two "it is not hidden, it just looks like it" answers.
 */
import { HUGE_FILE_BYTES } from "../diff/textDiff";
import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { FileDiff, PathExplanation } from "../types";
import type { GitAttributes } from "./attributes";
import type { IgnoreRules } from "./ignoreRules";
import type { IndexSnapshot } from "./indexReader";

/** What `explainPath` needs from the session (`RepoSession` supplies each field). */
export interface ExplainContext {
  fs: FsaFs;
  ignore: IgnoreRules;
  attrs: GitAttributes;
  index: IndexSnapshot;
  /** Rows of the current diff by path; null when no diff has been computed yet. */
  files: Map<string, FileDiff> | null;
}

type Reason = PathExplanation["reasons"][number];

/** The reasons that actually hide a path; `generated` and `clean` do not. */
const HIDING: ReadonlySet<Reason["kind"]> = new Set([
  "ignored",
  "skip-worktree",
  "assume-unchanged",
  "sparse",
  "too-large",
]);

/** Repo-relative POSIX, no leading or trailing slash (tasks/README.md path convention). */
export function normaliseExplainPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/** Shell-quotes a path for the copyable command, the way a user would have to type it. */
function q(path: string): string {
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

async function isDirectory(fs: FsaFs, path: string): Promise<boolean> {
  try {
    await fs.getDirHandle(`/${path}`);
    return true;
  } catch (e) {
    const c = errorCode(e);
    if (c === "ENOENT" || c === "ENOTDIR" || c === "EISDIR") return false;
    throw e;
  }
}

/** Working-tree size, or null when the path is not a readable file. */
async function worktreeSize(fs: FsaFs, path: string): Promise<number | null> {
  try {
    return (await fs.stat(`/${path}`)).size;
  } catch (e) {
    const c = errorCode(e);
    if (c === "ENOENT" || c === "ENOTDIR" || c === "EISDIR") return null;
    throw e;
  }
}

/**
 * Every reason `path` is not in the diff (or, when it is, that it is not rendered).
 *
 * Precedence follows how a user would fix it: an ignore rule first (it also explains why git itself
 * says nothing), then the index flags, then the sparse checkout, then the size gate.
 */
export async function explainPath(ctx: ExplainContext, rawPath: string): Promise<PathExplanation> {
  const path = normaliseExplainPath(rawPath);
  const reasons: Reason[] = [];
  const entry = ctx.index.byPath[path];
  const row = ctx.files?.get(path) ?? null;
  const isDir = entry === undefined && row === null && (await isDirectory(ctx.fs, path));

  const match = await ctx.ignore.explainPath(path, isDir ? "directory" : "file");
  if (match && !match.negated) {
    reasons.push({
      kind: "ignored",
      source: match.source,
      line: match.line,
      pattern: match.pattern,
      command: `git check-ignore -v ${q(path)}`,
    });
  }
  if (entry?.skipWorktree) {
    reasons.push({
      kind: "skip-worktree",
      command: `git update-index --no-skip-worktree ${q(path)}`,
    });
  }
  if (entry?.assumeValid) {
    reasons.push({
      kind: "assume-unchanged",
      command: `git update-index --no-assume-unchanged ${q(path)}`,
    });
  }
  if (entry?.isSparseDir || underSparseDir(ctx.index, path)) reasons.push({ kind: "sparse" });

  const size = row
    ? Math.max(row.oldSize, row.newSize)
    : ((await worktreeSize(ctx.fs, path)) ?? entry?.size ?? 0);
  if (size > HUGE_FILE_BYTES) reasons.push({ kind: "too-large" });

  if (!isDir && (await ctx.attrs.isGenerated(path))) reasons.push({ kind: "generated" });

  const hidden = reasons.some((r) => HIDING.has(r.kind));
  // Tracked, nothing hiding it, and no row: it simply has not changed on either side.
  if (!hidden && row === null && entry !== undefined) reasons.push({ kind: "clean" });
  return { path, shown: row !== null && !hidden, reasons };
}

/** True when a sparse-checkout directory entry covers this path (its contents are opaque). */
function underSparseDir(index: IndexSnapshot, path: string): boolean {
  if (!index.hasSparseIndex) return false;
  for (const e of index.entries) {
    if (e.isSparseDir && path.startsWith(`${e.path}/`)) return true;
  }
  return false;
}
