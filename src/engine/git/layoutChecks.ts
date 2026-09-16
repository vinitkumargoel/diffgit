/**
 * Layout checks (T1.2, Plan §5.2): classify the folder before any git operation and either refuse
 * with a precise public error code or proceed with recorded warnings and capabilities.
 * Never throws for I/O reasons other than permission (`EACCES` → `PERMISSION`).
 */
import { EngineError } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import type { RepoCapabilities, RepoWarning } from "../types";
import type { GitConfig } from "./config";

export type LayoutFatalCode =
  | "NOT_A_REPO"
  | "WORKTREE_GITDIR"
  | "BARE_REPO"
  | "REFTABLE"
  | "OBJECT_FORMAT_SHA256"
  | "ALTERNATES"
  | "PARTIAL_CLONE"
  | "PACK_TOO_LARGE";

export interface LayoutReport {
  ok: boolean;
  fatal?: { code: LayoutFatalCode; message: string; hint: string };
  capabilities: RepoCapabilities;
  warnings: RepoWarning[];
  /** Total bytes of `.git/objects/pack/*.pack` (0 when none). */
  packBytes: number;
}

export interface LayoutOptions {
  /** Warn above this many pack bytes (default 300 MB). */
  packLargeBytes?: number;
  /** Refuse above this many pack bytes (default 1 GB). */
  packTooLargeBytes?: number;
}

export const PACK_LARGE_BYTES = 300 * 1024 * 1024;
export const PACK_TOO_LARGE_BYTES = 1024 * 1024 * 1024;

const FATAL_TEXT: Record<LayoutFatalCode, { message: string; hint: string }> = {
  NOT_A_REPO: {
    message: "This folder is not a git repository.",
    hint: "Choose the folder that contains .git",
  },
  WORKTREE_GITDIR: {
    message: "This folder is a linked worktree (.git is a file pointing elsewhere).",
    hint: "Open the main repository folder",
  },
  BARE_REPO: {
    message: "This is a bare repository (no working tree).",
    hint: "Open a normal clone with a working tree",
  },
  REFTABLE: {
    message: "This repository uses the reftable ref storage, which is not supported.",
    hint: "Open a repository that uses the files ref format",
  },
  OBJECT_FORMAT_SHA256: {
    message: "This repository uses SHA-256 objects, which are not supported.",
    hint: "Open a SHA-1 repository",
  },
  ALTERNATES: {
    message: "Objects live outside this folder (.git/objects/info/alternates).",
    hint: "Open a repository whose objects are self-contained",
  },
  PARTIAL_CLONE: {
    message: "This is a partial clone; missing objects cannot be fetched from the browser.",
    hint: "Run `git fetch --refetch` or open a full clone",
  },
  PACK_TOO_LARGE: {
    message: "Pack files exceed 1 GB; they cannot be loaded in the browser.",
    hint: "Open a smaller repository",
  },
};

function code(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

function ioMissing(e: unknown): boolean {
  const c = code(e);
  return c === "ENOENT" || c === "ENOTDIR" || c === "EISDIR" || c === "EINVAL";
}

function permission(e: unknown): never {
  throw new EngineError("PERMISSION", "Permission to read the folder was denied.", { cause: e });
}

/** Probe helper: resolves to the kind of the entry, or null when absent. Permission errors escalate. */
async function kindOf(fs: FsaFs, path: string): Promise<"file" | "dir" | null> {
  try {
    return (await fs.stat(path)).type;
  } catch (e) {
    if (ioMissing(e)) return null;
    if (code(e) === "EACCES") permission(e);
    return null; // EIO etc.: treat as absent; later stages surface real read failures
  }
}

async function readTextOrNull(fs: FsaFs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (e) {
    if (ioMissing(e)) return null;
    if (code(e) === "EACCES") permission(e);
    return null;
  }
}

export async function checkLayout(
  fs: FsaFs,
  config: GitConfig,
  opts: LayoutOptions = {},
): Promise<LayoutReport> {
  const warnings: RepoWarning[] = [];
  const capabilities: RepoCapabilities = {
    indexVersion: 2,
    hasSplitIndex: false,
    hasSparseIndex: false,
    isWorktreeGitdir: false,
    hasReftable: false,
  };
  const report = (fatal?: LayoutFatalCode, packBytes = 0): LayoutReport =>
    fatal
      ? {
          ok: false,
          fatal: { code: fatal, ...FATAL_TEXT[fatal] },
          capabilities,
          warnings,
          packBytes,
        }
      : { ok: true, capabilities, warnings, packBytes };

  const dotGit = await kindOf(fs, ".git");
  if (dotGit === null) {
    // bare repo opened directly?
    if (
      (await kindOf(fs, "HEAD")) === "file" &&
      (await kindOf(fs, "objects")) === "dir" &&
      (await kindOf(fs, "refs")) === "dir"
    ) {
      return report("BARE_REPO");
    }
    return report("NOT_A_REPO");
  }
  if (dotGit === "file") {
    const text = (await readTextOrNull(fs, ".git")) ?? "";
    if (/^gitdir:/m.test(text)) {
      capabilities.isWorktreeGitdir = true;
      return report("WORKTREE_GITDIR");
    }
    return report("NOT_A_REPO");
  }
  if ((await kindOf(fs, ".git/HEAD")) !== "file") return report("NOT_A_REPO");

  if (config.extensions.objectFormat === "sha256") return report("OBJECT_FORMAT_SHA256");

  if (
    config.extensions.refStorage === "reftable" ||
    (await kindOf(fs, ".git/reftable")) === "dir"
  ) {
    capabilities.hasReftable = true;
    return report("REFTABLE");
  }
  // reftable's marker layout: refs/heads is a *file* and refs/tables.list is not used by files format
  if (
    (await kindOf(fs, ".git/refs/heads")) === "file" ||
    (await kindOf(fs, ".git/refs/tables.list")) === "file"
  ) {
    capabilities.hasReftable = true;
    return report("REFTABLE");
  }

  if ((await kindOf(fs, ".git/objects/info/alternates")) === "file") return report("ALTERNATES");

  const promisorRemote = config.remotes.some((r) => {
    const v = config.get("remote", "promisor", r)?.toLowerCase();
    return v === "true" || v === "yes" || v === "on" || v === "1";
  });
  if (config.extensions.partialClone !== undefined || promisorRemote)
    return report("PARTIAL_CLONE");

  // pack directory: promisor packs, sizes, multi-pack-index
  let packBytes = 0;
  if ((await kindOf(fs, ".git/objects/pack")) === "dir") {
    let entries: { name: string; kind: "file" | "directory" }[] = [];
    try {
      entries = await fs.readdirWithKinds(".git/objects/pack");
    } catch (e) {
      if (code(e) === "EACCES") permission(e);
    }
    if (entries.some((e) => e.kind === "file" && e.name.endsWith(".promisor")))
      return report("PARTIAL_CLONE");
    for (const e of entries) {
      if (e.kind !== "file" || !e.name.endsWith(".pack")) continue;
      try {
        packBytes += (await fs.stat(`.git/objects/pack/${e.name}`)).size;
      } catch (err) {
        if (code(err) === "EACCES") permission(err);
      }
    }
    if (packBytes > (opts.packTooLargeBytes ?? PACK_TOO_LARGE_BYTES))
      return report("PACK_TOO_LARGE", packBytes);
    if (packBytes > (opts.packLargeBytes ?? PACK_LARGE_BYTES)) {
      warnings.push({
        code: "PACK_LARGE",
        message: `Pack files total ${(packBytes / (1024 * 1024)).toFixed(0)} MB; loading them may use a lot of memory.`,
      });
    }
    if (entries.some((e) => e.kind === "file" && e.name === "multi-pack-index")) {
      warnings.push({
        code: "MULTI_PACK_INDEX",
        message: "Repository has a multi-pack-index; it is ignored and packs are read directly.",
      });
    }
  }

  if ((await kindOf(fs, ".git/shallow")) === "file") {
    warnings.push({
      code: "SHALLOW",
      message: "Shallow clone: the merge base may be missing from history.",
    });
  }

  const attrs = await readTextOrNull(fs, ".gitattributes");
  if (attrs !== null && /filter\s*=\s*lfs/.test(attrs)) {
    warnings.push({
      code: "LFS_PRESENT",
      message: "Git LFS is in use; LFS pointer files are shown as-is.",
    });
  }

  if (config.core.autocrlf === "true" || config.core.autocrlf === "input") {
    warnings.push({
      code: "AUTOCRLF",
      message: `core.autocrlf is ${config.core.autocrlf}; line-ending-only changes may appear (no normalisation in v1).`,
    });
  }

  return report(undefined, packBytes);
}
