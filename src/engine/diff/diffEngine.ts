/**
 * DiffEngine (T3.2, Plan §5.6 steps 1–5 and 8, D5–D7): merge-base compare plus working-tree
 * layering. Produces the file list with the right old side (merge base) and new side (source tip,
 * index or worktree) and layer badges. Renames, binary flags and stats are filled in by T3.3/T3.4.
 *
 * T10.1 added `RangeSource`: any two points (tags, SHAs, stashes, the empty tree), three-dot
 * (merge base, as branches always did) or two-dot (the `from` tree directly). A stash as the
 * compare side is layered like the working tree it came from — index tree as `staged`, its own tree
 * as `unstaged`, the third parent's tree as `untracked`.
 */

import type { ConflictKind } from "../api";
import { isWorktreeSource } from "../diffSource";
import type { WarningCode } from "../errors";
import { EMPTY_TREE_OID } from "../git/hash";
import type { IndexSnapshot } from "../git/indexReader";
import type { FlatTree, ObjectDb } from "../git/objectDb";
import { readStashCommits } from "../git/stash";
import type { Change, WorktreeScanner, WorktreeStatus } from "../git/worktree";
import type {
  ChangeLayer,
  DiffSource,
  FileDiff,
  Oid,
  RangeSource,
  RefSnapshot,
  RepoWarning,
} from "../types";
import { throwIfAborted } from "../util/concurrency";
import { conflictKindOf, conflictStatus } from "./conflict";
import { comparePaths, treeDiff } from "./treeDiff";

/** Where the new side's content lives (private side-table; not part of FileDiff). */
export type SideKind = "tree" | "index" | "worktree" | "untracked";

export interface OldSide {
  oid: Oid;
  mode: number;
}
export interface NewSide {
  oid: Oid | null; // null: worktree content not hashed yet (large untracked, conflict)
  mode: number;
  kind: SideKind;
  size?: number;
  lastModified?: number;
}
export interface FileSides {
  path: string; // worktree/index/tree path of the new side (or old path when deleted)
  old: OldSide | null;
  new: NewSide | null;
}

export interface DiffComputation {
  files: FileDiff[];
  mergeBase: Oid | null;
  sourceOid: Oid | null;
  targetOid: Oid | null;
  warnings: RepoWarning[];
  worktree?: WorktreeStatus;
  /** id → sides, so T3.4 knows where to load content from. */
  sides: Record<string, FileSides>;
  includeWorktree: boolean; // after the applicability guard
}

const LAYER_ORDER: ChangeLayer[] = ["committed", "staged", "unstaged", "untracked", "conflict"];

function warning(code: WarningCode, message: string, detail?: string): RepoWarning {
  return detail === undefined ? { code, message } : { code, message, detail };
}

/** Resolves a `DiffSource` ref name (`"HEAD"` or a full ref) to an oid; null for an unborn HEAD. */
async function resolveSourceRef(db: ObjectDb, refs: RefSnapshot, ref: string): Promise<Oid | null> {
  if (ref === "HEAD") return refs.headOid;
  return db.resolveRef(ref); // throws REF_NOT_FOUND
}

interface Working {
  old: OldSide | null;
  new: NewSide | null;
  layers: Set<ChangeLayer>;
  /** T10.3: which index stages the path kept, when it is in the `conflict` layer. */
  conflictKind?: ConflictKind;
}

/** The three trees a stash entry carries, once its parents have been read. */
interface StashLayers {
  index: FlatTree;
  work: FlatTree;
  untracked: FlatTree | null;
}

/** What steps 1–4 produce, whichever `DiffSource` kind asked for it. */
interface Resolved {
  sourceOid: Oid | null;
  targetOid: Oid | null;
  mergeBase: Oid | null;
  sourceTree: FlatTree | null;
  baseTree: FlatTree | null;
  stash: StashLayers | null;
  /** Both sides are the same commit and nothing is layered on top: there is nothing to show. */
  nothing: boolean;
}

export class DiffEngine {
  constructor(
    private readonly db: ObjectDb,
    private refs: RefSnapshot,
    private readonly scanner: WorktreeScanner,
    private readonly readIndex: () => Promise<IndexSnapshot>,
    private readonly opts: { shallow?: boolean } = {},
  ) {}

  /** Refs change on refresh; the engine keeps working against the newest snapshot. */
  updateRefs(refs: RefSnapshot): void {
    this.refs = refs;
  }

  async compute(src: DiffSource, signal?: AbortSignal): Promise<DiffComputation> {
    const warnings: RepoWarning[] = [];
    const refs = this.refs;

    // 1. worktree applicability (D6)
    let includeWorktree = src.includeWorktree;
    if (includeWorktree && !isWorktreeSource(src, refs)) {
      includeWorktree = false;
      warnings.push(
        warning(
          "WORKTREE_NOT_APPLICABLE",
          src.kind === "range"
            ? "Uncommitted changes are only shown when the compare side is the checked-out commit."
            : "Uncommitted changes are only shown when the compare branch is the checked-out branch.",
          refs.headDisplay,
        ),
      );
    }

    // 2–4. resolve both sides, the merge base and the trees
    const r =
      src.kind === "range"
        ? await this.resolveRange(src, includeWorktree, warnings, signal)
        : await this.resolveBranches(src, includeWorktree, warnings, signal);
    if (r.nothing) {
      return {
        files: [],
        mergeBase: r.sourceOid,
        sourceOid: r.sourceOid,
        targetOid: r.targetOid,
        warnings,
        sides: {},
        includeWorktree,
      };
    }
    const { sourceOid, targetOid, mergeBase, sourceTree, baseTree, stash } = r;
    throwIfAborted(signal, "Diff");

    // 5. committed layer
    const committed = treeDiff(baseTree, sourceTree);
    const final = new Map<string, Working>();
    for (const [path, c] of Object.entries(committed)) {
      final.set(path, {
        old: c.oldOid !== null ? { oid: c.oldOid, mode: c.oldMode as number } : null,
        new: c.newOid !== null ? { oid: c.newOid, mode: c.newMode as number, kind: "tree" } : null,
        layers: new Set<ChangeLayer>(["committed"]),
      });
    }

    // Layer helpers, shared by the working tree (6) and a stash compare side (6b).
    const get = (path: string): Working => {
      let w = final.get(path);
      if (!w) {
        const b = baseTree?.[path];
        w = { old: b ? { oid: b.oid, mode: b.mode } : null, new: null, layers: new Set() };
        // a path untouched by the committed layer still has a "new" side in the source tree
        const s = sourceTree?.[path];
        if (s) w.new = { oid: s.oid, mode: s.mode, kind: "tree" };
        final.set(path, w);
      }
      return w;
    };
    const applyChange = (path: string, c: Change, kind: SideKind, layer: ChangeLayer) => {
      const w = get(path);
      w.new =
        c.newOid !== null ||
        (kind === "worktree" && c.newMode !== null && c.newOid === null && c.newSize !== undefined)
          ? {
              oid: c.newOid,
              mode: c.newMode as number,
              kind,
              ...(c.newSize !== undefined ? { size: c.newSize } : {}),
              ...(c.newLastModified !== undefined ? { lastModified: c.newLastModified } : {}),
            }
          : null;
      w.layers.add(layer);
    };

    // 6. working-tree layer
    let worktree: WorktreeStatus | undefined;
    if (includeWorktree) {
      const index = await this.readIndex();
      throwIfAborted(signal, "Diff");
      try {
        worktree = await this.scanner.scan(index, sourceTree, signal);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "SPLIT_INDEX") {
          warnings.push(
            warning("SPLIT_INDEX", "Split index is not supported; uncommitted changes are hidden."),
          );
        } else if (code === "INDEX_TOO_LARGE") {
          warnings.push(
            warning(
              "INDEX_TOO_LARGE",
              "The index is too large to scan; uncommitted changes are hidden.",
            ),
          );
        } else throw e;
      }
      if (worktree) {
        for (const w of worktree.warnings) warnings.push(w);
        for (const [path, c] of Object.entries(worktree.staged))
          applyChange(path, c, "index", "staged");
        for (const [path, c] of Object.entries(worktree.unstaged))
          applyChange(path, c, "worktree", "unstaged");
        for (const path of worktree.untracked) {
          const info = worktree.untrackedInfo[path];
          const w = get(path);
          w.new = {
            oid: info?.oid ?? null,
            mode: 0o100644,
            kind: "untracked",
            ...(info ? { size: info.size, lastModified: info.lastModified } : {}),
          };
          w.layers.add("untracked");
        }
        for (const path of worktree.conflicts) {
          const w = get(path);
          w.new = { oid: null, mode: w.new?.mode ?? 0o100644, kind: "worktree" };
          w.layers.add("conflict");
          // T10.3: the stage bits say which side deleted the path, which the tree/worktree
          // comparison alone cannot ("deleted by them" still leaves our version on disk).
          const stages = index.conflicts[path];
          if (stages && stages.length > 0) w.conflictKind = conflictKindOf(stages);
        }
      }
    }

    // 6b. stash compare side: the same three layers, read out of the stash's parents instead of
    // the index and the working tree (this is what makes "3 files (1 untracked)" possible).
    if (stash) {
      for (const [path, c] of Object.entries(treeDiff(sourceTree, stash.index)))
        applyChange(path, c, "index", "staged");
      for (const [path, c] of Object.entries(treeDiff(stash.index, stash.work)))
        applyChange(path, c, "tree", "unstaged");
      if (stash.untracked) {
        for (const [path, entry] of Object.entries(stash.untracked)) {
          const w = get(path);
          w.new = { oid: entry.oid, mode: entry.mode, kind: "tree" };
          w.layers.add("untracked");
        }
      }
    }
    throwIfAborted(signal, "Diff");

    // 7. eliminate no-ops and map to FileDiff
    const files: FileDiff[] = [];
    const sides: Record<string, FileSides> = {};
    for (const path of [...final.keys()].sort(comparePaths)) {
      const w = final.get(path) as Working;
      const untracked = w.layers.has("untracked");
      if (!w.old && !w.new) continue;
      if (
        !untracked &&
        w.old &&
        w.new &&
        w.new.oid !== null &&
        w.old.oid === w.new.oid &&
        w.old.mode === w.new.mode
      ) {
        continue; // e.g. changed on the branch, reverted in the worktree to the base content
      }
      const status =
        w.conflictKind !== undefined
          ? conflictStatus(w.conflictKind)
          : w.old === null
            ? "added"
            : w.new === null
              ? "deleted"
              : "modified";
      files.push({
        id: path,
        oldPath: w.old ? path : null,
        newPath: w.new ? path : null,
        status,
        layers: LAYER_ORDER.filter((l) => w.layers.has(l)),
        oldOid: w.old?.oid ?? null,
        newOid: w.new?.oid ?? null,
        oldMode: w.old?.mode ?? null,
        newMode: w.new?.mode ?? null,
        binary: false,
        image: false,
        oldSize: 0,
        newSize: w.new?.size ?? 0,
        stats: null,
        tooLarge: false,
      });
      sides[path] = { path, old: w.old, new: w.new };
    }

    return { files, mergeBase, sourceOid, targetOid, warnings, worktree, sides, includeWorktree };
  }

  /** Steps 2–4 for a `BranchesSource` (v1 behaviour). `null` = nothing to show. */
  private async resolveBranches(
    src: DiffSource & { kind: "branches" },
    includeWorktree: boolean,
    warnings: RepoWarning[],
    signal?: AbortSignal,
  ): Promise<Resolved> {
    const refs = this.refs;
    const sourceOid = await resolveSourceRef(this.db, refs, src.sourceRef);
    const targetOid = await resolveSourceRef(this.db, refs, src.targetRef);
    throwIfAborted(signal, "Diff");
    const nothing = {
      sourceOid,
      targetOid,
      mergeBase: sourceOid,
      sourceTree: null,
      baseTree: null,
      stash: null,
      nothing: true,
    };
    if (sourceOid === targetOid && !includeWorktree) return nothing;

    const sourceTree: FlatTree | null = sourceOid ? await this.db.flattenTree(sourceOid) : null;
    throwIfAborted(signal, "Diff");
    let mergeBase: Oid | null = null;
    let baseTree: FlatTree | null = null;
    if (sourceOid && targetOid) {
      if (sourceOid === targetOid) {
        mergeBase = sourceOid;
        baseTree = sourceTree;
      } else {
        const mb = await this.mergeBaseOf(sourceOid, targetOid, warnings);
        mergeBase = mb;
        if (mergeBase) baseTree = await this.db.flattenTree(mergeBase);
        else {
          // Two-dot fallback: with no common ancestor we compare source against target directly
          // (an empty base would show the whole source tree as added, which is not what anyone wants).
          baseTree = await this.db.flattenTree(targetOid);
          warnings.push(
            this.opts.shallow
              ? warning(
                  "SHALLOW",
                  "Shallow clone: no merge base is available; showing a direct comparison with the base branch.",
                )
              : warning(
                  "UNRELATED_HISTORIES",
                  "The branches share no history; showing a direct comparison.",
                ),
          );
        }
      }
    } else if (!sourceOid && targetOid) {
      // unborn source (no commits yet): compare index/worktree directly against the target tree
      baseTree = await this.db.flattenTree(targetOid);
      warnings.push(
        warning(
          "UNRELATED_HISTORIES",
          "The compare side has no commits yet; showing a direct comparison.",
        ),
      );
    }
    return { sourceOid, targetOid, mergeBase, sourceTree, baseTree, stash: null, nothing: false };
  }

  /** Steps 2–4 for a `RangeSource` (T10.1). */
  private async resolveRange(
    src: RangeSource,
    includeWorktree: boolean,
    warnings: RepoWarning[],
    signal?: AbortSignal,
  ): Promise<Resolved> {
    const emptyBase = src.fromOid === null || src.fromOid === EMPTY_TREE_OID;
    const targetOid = emptyBase ? null : (src.fromOid as Oid);

    // A stash is a commit whose tree is a working tree: compare from the commit it was made on and
    // layer its index / untracked parents on top. Any other commit is its own compare tip.
    const stashCommits = includeWorktree ? null : await readStashCommits(this.db, src.toOid);
    throwIfAborted(signal, "Diff");
    const sourceOid = stashCommits ? stashCommits.baseOid : src.toOid;
    let stash: StashLayers | null = null;
    if (stashCommits) {
      stash = {
        index: await this.db.flattenTree(stashCommits.indexOid),
        work: await this.db.flattenTree(src.toOid),
        untracked: stashCommits.untrackedOid
          ? await this.db.flattenTree(stashCommits.untrackedOid)
          : null,
      };
      throwIfAborted(signal, "Diff");
    }

    if (sourceOid === targetOid && !includeWorktree && !stash) {
      return {
        sourceOid,
        targetOid,
        mergeBase: sourceOid,
        sourceTree: null,
        baseTree: null,
        stash: null,
        nothing: true,
      };
    }

    const sourceTree = await this.db.flattenTree(sourceOid);
    throwIfAborted(signal, "Diff");
    let mergeBase: Oid | null = null;
    let baseTree: FlatTree | null = null;
    if (emptyBase) {
      baseTree = {}; // git's empty tree: everything on the compare side is an addition
    } else if (!src.threeDot) {
      baseTree = await this.db.flattenTree(targetOid as Oid); // two-dot: the `from` tree itself
    } else if (sourceOid === targetOid) {
      mergeBase = sourceOid;
      baseTree = sourceTree;
    } else {
      mergeBase = await this.mergeBaseOf(sourceOid, targetOid as Oid, warnings);
      if (mergeBase) baseTree = await this.db.flattenTree(mergeBase);
      else {
        baseTree = await this.db.flattenTree(targetOid as Oid);
        warnings.push(
          warning(
            "UNRELATED_HISTORIES",
            "The two sides share no history; showing a direct comparison.",
          ),
        );
      }
    }
    return { sourceOid, targetOid, mergeBase, sourceTree, baseTree, stash, nothing: false };
  }

  /** Merge base with the `MULTIPLE_MERGE_BASES` warning both source kinds emit. */
  private async mergeBaseOf(a: Oid, b: Oid, warnings: RepoWarning[]): Promise<Oid | null> {
    const mb = await this.db.findMergeBase(a, b);
    if (mb.all.length > 1) {
      warnings.push(
        warning(
          "MULTIPLE_MERGE_BASES",
          `The branches have ${mb.all.length} merge bases; using ${(mb.oid ?? "").slice(0, 7)}.`,
          mb.all.join(","),
        ),
      );
    }
    return mb.oid;
  }
}
