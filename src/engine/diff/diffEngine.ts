/**
 * DiffEngine (T3.2, Plan §5.6 steps 1–5 and 8, D5–D7): merge-base compare plus working-tree
 * layering. Produces the file list with the right old side (merge base) and new side (source tip,
 * index or worktree) and layer badges. Renames, binary flags and stats are filled in by T3.3/T3.4.
 */

import { isWorktreeSource } from "../diffSource";
import type { WarningCode } from "../errors";
import type { IndexSnapshot } from "../git/indexReader";
import type { FlatTree, ObjectDb } from "../git/objectDb";
import type { Change, WorktreeScanner, WorktreeStatus } from "../git/worktree";
import type { ChangeLayer, DiffSource, FileDiff, Oid, RefSnapshot, RepoWarning } from "../types";
import { throwIfAborted } from "../util/concurrency";
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

    // 1. resolve
    const sourceOid = await resolveSourceRef(this.db, refs, src.sourceRef);
    const targetOid = await resolveSourceRef(this.db, refs, src.targetRef);
    throwIfAborted(signal, "Diff");

    // 2. worktree applicability (D6)
    let includeWorktree = src.includeWorktree;
    if (includeWorktree && !isWorktreeSource(src, refs)) {
      includeWorktree = false;
      warnings.push(
        warning(
          "WORKTREE_NOT_APPLICABLE",
          "Uncommitted changes are only shown when the compare branch is the checked-out branch.",
          refs.headDisplay,
        ),
      );
    }

    // 3. same commit, no worktree → nothing to show
    if (sourceOid === targetOid && !includeWorktree) {
      return {
        files: [],
        mergeBase: sourceOid,
        sourceOid,
        targetOid,
        warnings,
        sides: {},
        includeWorktree,
      };
    }

    // 4. merge base and trees
    const sourceTree: FlatTree | null = sourceOid ? await this.db.flattenTree(sourceOid) : null;
    throwIfAborted(signal, "Diff");
    let mergeBase: Oid | null = null;
    let baseTree: FlatTree | null = null;
    if (sourceOid && targetOid) {
      if (sourceOid === targetOid) {
        mergeBase = sourceOid;
        baseTree = sourceTree;
      } else {
        const mb = await this.db.findMergeBase(sourceOid, targetOid);
        if (mb.all.length > 1) {
          warnings.push(
            warning(
              "MULTIPLE_MERGE_BASES",
              `The branches have ${mb.all.length} merge bases; using ${(mb.oid ?? "").slice(0, 7)}.`,
              mb.all.join(","),
            ),
          );
        }
        mergeBase = mb.oid;
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
            (kind === "worktree" &&
              c.newMode !== null &&
              c.newOid === null &&
              c.newSize !== undefined)
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
      const status = w.old === null ? "added" : w.new === null ? "deleted" : "modified";
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
}
