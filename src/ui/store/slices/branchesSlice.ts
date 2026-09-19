import { isWorktreeSource } from "../../../engine/diffSource";
import { BRANCH_CELL_BATCH, type BranchCells } from "../../branches";
import { buildSource, labelOf, revToSide, type SideRev, sideOf } from "../../compareSource";
import { toUiError } from "../../errors";
import { revisionOfRef } from "../../refGroups";
import type { WorkerClient } from "../../workerClient";
import { baseRefOf, findRef, guardWorktree, ignoreStale, tagSide } from "../helpers";
import { getPersistence } from "../persistence";
import {
  INITIAL_BRANCHES,
  INITIAL_PREFLIGHT,
  type StoreGet,
  type StoreSet,
  type StoreState,
} from "../types";

/** The `listTags` + `listStashes` pass for the pickers; one per open (T11.2). */
let pickerSources: Promise<void> | null = null;

/** T11.16: the same one-per-open rule for the two atlas-tab-19 listings. */
let submodulesRead: Promise<void> | null = null;
let worktreesRead: Promise<void> | null = null;

/** T11.7: the same rule for `branchCells` — the table's visible rows queue, one loop drains them. */
const branchCellQueue = new Set<string>();
let branchCellsDraining = false;

export function resetBranchesState(): void {
  pickerSources = null;
  submodulesRead = null;
  worktreesRead = null;
  branchCellQueue.clear();
}

export type BranchesSlice = Pick<
  StoreState,
  | "tags"
  | "stashes"
  | "submodules"
  | "worktrees"
  | "worktreesOpen"
  | "branches"
  | "preflight"
  | "compareBase"
  | "setSource"
  | "setTarget"
  | "setRevision"
  | "setSpecialSource"
  | "setTwoDot"
  | "resolveRevision"
  | "loadPickerSources"
  | "loadSubmodules"
  | "loadWorktrees"
  | "setWorktreesOpen"
  | "applyCompare"
  | "swapBranches"
  | "setIncludeWorktree"
  | "loadBranches"
  | "requestBranchCells"
  | "setBranchFilter"
  | "setBranchQuery"
  | "showBranchHistory"
  | "compareBranchWithBase"
  | "compareTags"
  | "runPreflight"
  | "closePreflight"
>;

export function createBranchesSlice(
  set: StoreSet,
  get: StoreGet,
  client: () => WorkerClient,
): BranchesSlice {
  /**
   * The one place a new `DiffSource` is committed (T11.2): build → D6 worktree guard → remember the
   * pair when it is still a v1 branch pair → recompute. Every picker action funnels through it, so
   * ranges, branches, the two-dot toggle and swap can never drift apart.
   */
  function applySides(from: SideRev, to: SideRev, includeWorktree?: boolean): void {
    const { repo, prefs } = get();
    if (!repo) return;
    const worktree = includeWorktree ?? get().diffSource?.includeWorktree ?? true;
    const built = buildSource(from, to, !prefs.twoDot, worktree);
    if (!built) {
      get().addToast({
        level: "warning",
        message: `Cannot compare ${from.display} … ${to.display}: the compare side has no commit.`,
      });
      return;
    }
    const src = guardWorktree(built, repo);
    // T11.5: a picker change is a new branch pair, so the Stack tab has to walk again. Picking a
    // commit goes through `applyRange` instead and deliberately leaves the stack alone.
    set((s) => ({
      diffSource: src,
      stack: { ...s.stack, ready: false },
      compareBase:
        from.branchRef === null ? s.compareBase : { expr: from.branchRef, display: from.display },
    }));
    if (src.kind === "branches") {
      void getPersistence().touchRepo(get().repoId ?? "", {
        lastSource: src.sourceRef,
        lastTarget: src.targetRef,
      });
    }
    get().requestRefresh("branch-change");
  }

  return {
    tags: null,
    stashes: null,
    submodules: null,
    worktrees: null,
    worktreesOpen: false,
    branches: INITIAL_BRANCHES,
    preflight: INITIAL_PREFLIGHT,
    compareBase: null,

    setSource(refOrName) {
      const { repo } = get();
      if (!repo) return;
      const ref = typeof refOrName === "string" ? findRef(repo, refOrName) : refOrName;
      if (ref) get().setRevision(revisionOfRef(ref), "source");
    },

    setTarget(refOrName) {
      const { repo } = get();
      if (!repo) return;
      const ref = typeof refOrName === "string" ? findRef(repo, refOrName) : refOrName;
      if (ref) get().setRevision(revisionOfRef(ref), "target");
    },

    setRevision(rev, side) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const from = side === "target" ? revToSide(rev) : sideOf(diffSource, "target", repo);
      const to = side === "source" ? revToSide(rev) : sideOf(diffSource, "source", repo);
      applySides(from, to);
    },

    setSpecialSource(kind) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      if (repo.headOid === null) {
        get().addToast({ level: "warning", message: "This branch has no commits yet." });
        return;
      }
      const head: SideRev = {
        expr: "HEAD",
        display: repo.headDisplay,
        oid: repo.headOid,
        branchRef: "HEAD",
      };
      applySides(head, head, true);
      // `Staged only` is the staged layer of that comparison; `Working tree` undoes just that,
      // never a filter the user typed.
      if (kind === "staged") get().setFilter("layer:staged");
      else if (get().filter === "layer:staged") get().setFilter("");
    },

    setTwoDot(on) {
      get().setPref("twoDot", on);
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const already = diffSource.kind === "range" ? !diffSource.threeDot : false;
      if (already === on) return;
      applySides(sideOf(diffSource, "target", repo), sideOf(diffSource, "source", repo));
    },

    resolveRevision(expr) {
      return client().resolveRevision(expr);
    },

    async loadPickerSources() {
      if (!get().repo) return;
      if (pickerSources) {
        await pickerSources;
        return;
      }
      pickerSources = (async () => {
        try {
          // One in-flight call per method (T4.1), so the two listings go one after the other.
          // A tag can name a blob or a tree (T10.5b `TagInfo.targetType`); only a commit can be a
          // side of a diff, so the picker lists the others no more than `git log --all` walks them.
          const tags = (await client().listTags()).filter((t) => t.targetType === "commit");
          const stashes = await client().listStashes();
          set({ tags, stashes });
        } catch (e) {
          // Not fatal: the picker keeps its branch groups and says the others are empty.
          ignoreStale(e);
          set((s) => ({ tags: s.tags ?? [], stashes: s.stashes ?? [] }));
        }
      })();
      await pickerSources;
    },

    /**
     * T11.16: the gitlink card's own source (atlas tab 19). One call per repository — a submodule
     * set changes only with a commit, and `recompute()` would have re-read it for every refresh.
     * A failure is not fatal: the card falls back to the two pointer oids the diff already carries.
     */
    async loadSubmodules() {
      if (!get().repo) return;
      if (submodulesRead) {
        await submodulesRead;
        return;
      }
      submodulesRead = (async () => {
        try {
          set({ submodules: await client().listSubmodules() });
        } catch (e) {
          ignoreStale(e);
          set((s) => ({ submodules: s.submodules ?? [] }));
        }
      })();
      await submodulesRead;
    },

    /** T11.16: the Worktrees dialog's only engine call, once per repository (Design §14.1). */
    async loadWorktrees() {
      if (!get().repo) return;
      if (worktreesRead) {
        await worktreesRead;
        return;
      }
      worktreesRead = (async () => {
        try {
          set({ worktrees: await client().listWorktrees() });
        } catch (e) {
          ignoreStale(e);
          set((s) => ({ worktrees: s.worktrees ?? [] }));
        }
      })();
      await worktreesRead;
    },

    setWorktreesOpen(open) {
      set({ worktreesOpen: open, ...(open ? { palette: false } : {}) });
      if (open) void get().loadWorktrees();
    },

    async applyCompare(spec) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      try {
        const to = await client().resolveRevision(spec.to);
        const from = await client().resolveRevision(spec.from);
        // The link carries the dot mode, so `#compare=a..b` really shows a two-dot diff.
        get().setPref("twoDot", !spec.threeDot);
        applySides(revToSide(from), revToSide(to));
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "STALE" || err.code === "CANCELLED") return;
        get().addToast({
          level: "warning",
          message: `Cannot compare ${spec.from} … ${spec.to}: ${err.message} Showing ${labelOf(diffSource)} instead.`,
        });
      }
    },

    swapBranches() {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const from = sideOf(diffSource, "source", repo);
      const to = sideOf(diffSource, "target", repo);
      if (from.expr === to.expr) return;
      applySides(from, to);
    },

    setIncludeWorktree(on) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      if (on && !isWorktreeSource(diffSource, repo)) return;
      if (diffSource.includeWorktree === on) return;
      set({ diffSource: { ...diffSource, includeWorktree: on } });
      get().requestRefresh("branch-change");
    },

    // ---- Branches mode (T11.7, Design §14.6) ------------------------------------------------
    async loadBranches() {
      const { repo, branches } = get();
      if (!repo || branches.loading || branches.rows !== null) return;
      set((s) => ({ branches: { ...s.branches, loading: true, error: null } }));
      try {
        const rows = await client().branchOverview();
        if (!get().repo) return;
        set((s) => ({ branches: { ...s.branches, rows, loading: false } }));
      } catch (e) {
        const err = toUiError(e);
        const stale =
          err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED";
        set((s) => ({
          branches: { ...s.branches, loading: false, error: stale ? null : err },
        }));
        if (stale) ignoreStale(e);
      }
    },

    requestBranchCells(fullNames) {
      const have = get().branches.cells;
      for (const name of fullNames) if (!(name in have)) branchCellQueue.add(name);
      if (branchCellsDraining || branchCellQueue.size === 0 || !get().repo) return;
      branchCellsDraining = true;
      void (async () => {
        try {
          while (branchCellQueue.size > 0 && get().repo) {
            const batch = [...branchCellQueue].slice(0, BRANCH_CELL_BATCH);
            for (const name of batch) branchCellQueue.delete(name);
            const filled = await client().branchCells(batch);
            if (!get().repo) return;
            // A name the engine did not answer for (a ref that vanished under us) is recorded as
            // "asked and unknown", so the table prints `—` instead of asking again for ever.
            const cells: Record<string, BranchCells> = {};
            for (const name of batch) {
              cells[name] = filled[name] ?? { vsUpstream: null, vsDefault: null, merged: null };
            }
            set((s) => ({ branches: { ...s.branches, cells: { ...s.branches.cells, ...cells } } }));
          }
        } catch (e) {
          // Superseded or stale: the rows keep their skeletons and the next render asks again.
          ignoreStale(e);
        } finally {
          branchCellsDraining = false;
        }
      })();
    },

    setBranchFilter(filter) {
      set((s) => ({ branches: { ...s.branches, filter } }));
    },

    setBranchQuery(query) {
      set((s) => ({ branches: { ...s.branches, query } }));
    },

    showBranchHistory(fullName) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const ref = findRef(repo, fullName);
      if (!ref) return;
      // The compare side is the branch History walks (Design §14.1), so this is the picker's own
      // action — hash, remembered pair and StatsRow follow exactly as if it had been chosen there.
      applySides(sideOf(diffSource, "target", repo), revToSide(revisionOfRef(ref)));
      set((s) => ({ history: { ...s.history, selected: null, rangeStart: null } }));
      get().setMode("history");
      void get().loadHistory(true);
    },

    compareBranchWithBase(fullName) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      const ref = findRef(repo, fullName);
      const base = baseRefOf(get());
      if (!ref || !base || base.fullName === ref.fullName) return;
      applySides(revToSide(revisionOfRef(base)), revToSide(revisionOfRef(ref)));
      get().setMode("files");
    },

    compareTags(previous, tag) {
      const { repo, diffSource } = get();
      if (!repo || !diffSource) return;
      applySides(tagSide(previous), tagSide(tag));
      get().setMode("files");
    },

    async runPreflight(branchRef, ontoRef) {
      if (!get().repo) return;
      get().setMode("branches");
      set({ preflight: { ...INITIAL_PREFLIGHT, branch: branchRef, onto: ontoRef, loading: true } });
      /** The pair this call answers; a second `Preflight rebase…` makes it stale. */
      const current = () => {
        const p = get().preflight;
        return p.branch === branchRef && p.onto === ontoRef;
      };
      try {
        const result = await client().rebasePreflight(branchRef, ontoRef);
        if (!current()) return;
        set({
          preflight: { branch: branchRef, onto: ontoRef, result, loading: false, error: null },
        });
      } catch (e) {
        const err = toUiError(e);
        const stale = err.code === "STALE" || err.code === "CANCELLED";
        if (stale) ignoreStale(e);
        if (!current()) return;
        set({
          preflight: {
            branch: branchRef,
            onto: ontoRef,
            result: null,
            loading: false,
            error: stale ? null : err,
          },
        });
      }
    },

    closePreflight() {
      if (get().preflight === INITIAL_PREFLIGHT) return;
      set({ preflight: INITIAL_PREFLIGHT });
    },
  };
}
