/**
 * Linked worktrees (T10.12, atlas tab 19): `git worktree list`, as far as a browser can see it.
 *
 * git keeps one directory per linked worktree under `.git/worktrees/<name>/`:
 *
 *  * `HEAD`      — that worktree's HEAD, `ref: refs/heads/x` or a bare oid (detached);
 *  * `gitdir`    — the **absolute** path of the linked checkout's `.git` *file*, which is how git
 *                  finds its way back and how `git worktree prune` decides an entry is stale;
 *  * `commondir` — `../..`, pointing at the shared `.git`.
 *
 * Branch tips live in the shared `refs/`, so the oid of a linked worktree's branch resolves through
 * the session's own `ObjectDb`. Everything else about a linked checkout is outside the folder the
 * user picked, and the File System Access API cannot look there: `FsaFs.normalizePath` throws
 * `EINVAL` on a path that walks out of the root, and a fresh absolute path has no handle at all.
 *
 * So this listing is honest about two things, and the contract note in `docs/v2-contracts.md`
 * (`<!-- T10.12 -->`) says so:
 *
 *  * `path` is the directory the `gitdir` file **names**; it is never verified, because verifying
 *    it would mean reading a sibling folder. A `gitdir` file that is missing or empty leaves
 *    `path: null`.
 *  * `prunable` is therefore only true for the case that *is* visible from inside the repository —
 *    a `.git/worktrees/<name>/` whose `gitdir` file cannot be read. git's own `prunable` reason
 *    ("gitdir file points to non-existent location") cannot be reproduced without leaving the
 *    folder, and reporting every linked worktree as prunable would be worse than reporting none.
 *
 * The main checkout is always the first entry, like `git worktree list`. Its `path` is null for the
 * same reason: a `FileSystemDirectoryHandle` carries a name, not a path.
 */
import { errorCode } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { Oid, RefSnapshot, WorktreeInfo } from "../types";

export const WORKTREES_DIR = "/.git/worktrees";

async function readTextOrNull(fs: FsaFs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (e) {
    const c = errorCode(e);
    if (c === "ENOENT" || c === "EISDIR" || c === "ENOTDIR" || c === "EINVAL") return null;
    throw e;
  }
}

/** `{ branch, oid }` of a worktree `HEAD` file; `branch` is a full ref name or null (detached). */
export function parseWorktreeHead(text: string): { branch: string | null; oid: Oid | null } {
  const line = text.trim();
  const symref = /^ref:\s*(\S+)$/.exec(line);
  if (symref) return { branch: symref[1] as string, oid: null };
  if (/^[0-9a-f]{40}$/.test(line)) return { branch: null, oid: line };
  return { branch: null, oid: null };
}

/** The directory a `.git/worktrees/<name>/gitdir` file points at (it names the `.git` file itself). */
export function worktreePathFromGitdir(text: string): string | null {
  const target = text.trim().split("\n")[0]?.trim() ?? "";
  if (target === "") return null;
  const slash = target.lastIndexOf("/");
  if (slash <= 0) return null;
  return target.slice(0, slash);
}

export interface WorktreeDeps {
  fs: FsaFs;
  /** Structural, so a test can resolve branch tips without building an object database. */
  db: { tryResolveRef(ref: string): Promise<Oid | null> };
}

/**
 * Every worktree of this repository: the main checkout first (`isThis: true`), then one entry per
 * `.git/worktrees/<name>/`, sorted by name — which is the order `git worktree list` prints them in
 * for a repository whose worktrees were added in name order, and a stable order in any case.
 *
 * When the picked folder is itself a **linked** worktree (`.git` is a file), only that worktree can
 * be described, and only by name: its HEAD, its branch and the whole common directory live outside
 * the folder. `RepoSession` refuses such a folder outright with `WORKTREE_GITDIR` (T1.2, Plan §5.2),
 * so this branch is reachable only by calling the module directly; it is implemented and tested so
 * that lifting the refusal does not silently produce a wrong list.
 */
export async function listWorktrees(
  deps: WorktreeDeps,
  refs: RefSnapshot,
  rootName: string,
): Promise<WorktreeInfo[]> {
  const dotGit = await readTextOrNull(deps.fs, "/.git");
  if (dotGit !== null && /^gitdir:/.test(dotGit.trim())) {
    const target = dotGit.trim().slice("gitdir:".length).trim();
    const name =
      target
        .split("/")
        .filter((s) => s !== "")
        .pop() ?? rootName;
    return [{ name, path: null, head: null, branch: null, prunable: false, isThis: true }];
  }

  const out: WorktreeInfo[] = [
    {
      name: rootName,
      path: null,
      head: refs.headOid,
      branch: refs.headBranch === null ? null : `refs/heads/${refs.headBranch}`,
      prunable: false,
      isThis: true,
    },
  ];

  let names: string[] = [];
  try {
    names = (await deps.fs.readdirWithKinds(WORKTREES_DIR))
      .filter((e) => e.kind === "directory")
      .map((e) => e.name)
      .sort();
  } catch (e) {
    const c = errorCode(e);
    if (c !== "ENOENT" && c !== "ENOTDIR") throw e;
    return out;
  }

  for (const name of names) {
    const headText = await readTextOrNull(deps.fs, `${WORKTREES_DIR}/${name}/HEAD`);
    const gitdirText = await readTextOrNull(deps.fs, `${WORKTREES_DIR}/${name}/gitdir`);
    const head = headText === null ? { branch: null, oid: null } : parseWorktreeHead(headText);
    let oid = head.oid;
    if (oid === null && head.branch !== null) oid = await deps.db.tryResolveRef(head.branch);
    const path = gitdirText === null ? null : worktreePathFromGitdir(gitdirText);
    out.push({
      name,
      path,
      head: oid,
      branch: head.branch,
      prunable: path === null,
      isThis: false,
    });
  }
  return out;
}
