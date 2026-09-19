import type { Progress } from "../api";
import { EngineError } from "../errors";
import type { GitAttributes } from "../git/attributes";
import type { IndexSnapshot } from "../git/indexReader";
import type { ObjectDb } from "../git/objectDb";
import { type CommitReader, walkCommits as runWalk } from "../git/walk";
import type { WorktreeScanner } from "../git/worktree";
import { type CommitSource, searchCommits } from "../search/commits";
import { type PickaxeWorktree, pathScope, searchPickaxe } from "../search/pickaxe";
import type { SearchOutcome } from "../search/query";
import { searchWorktree } from "../search/worktree";
import type { RepoWarning, SearchRequest, SearchResult, WalkRequest } from "../types";
import { MODE_GITLINK, type Oid } from "../types";

export interface SearchRunnerDeps {
  db: ObjectDb;
  attrs: GitAttributes;
  scanner: WorktreeScanner;
  statsLimit: <T>(fn: () => Promise<T>) => Promise<T>;
  commitReader: () => Promise<CommitReader>;
  refsByCommit: () => Promise<Map<Oid, string[]>>;
  walkSeeds: (req: WalkRequest, reader: CommitReader) => Promise<Oid[]>;
  currentIndex: () => Promise<IndexSnapshot>;
  readWorktreeBytes: (path: string) => Promise<Uint8Array | null>;
  getHeadOid: () => Oid | null;
  progress: (p: Progress) => void;
  emitWarning: (w: RepoWarning) => void;
  withRootCheck: <T>(fn: () => Promise<T>) => Promise<T>;
  assertOpen: () => void;
  single: <T>(method: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}

export class SearchRunner {
  constructor(private readonly deps: SearchRunnerDeps) {}

  /**
   * One capped page of `git log --date-order`, for the two commit-shaped scopes. T10.5's walker is
   * used exactly as it is exported: one call, one page, `limit` commits — no cursor, so the search
   * never has to know how the walker carries its state.
   */
  async commitSource(signal: AbortSignal, from: string[]): Promise<CommitSource> {
    const reader = await this.deps.commitReader();
    const refsByCommit = await this.deps.refsByCommit();
    return {
      walk: async (limit, firstParent) => {
        const req: WalkRequest = { from, firstParent, limit };
        const seeds = await this.deps.walkSeeds(req, reader);
        const out = await runWalk({ db: this.deps.db, reader, refsByCommit, signal }, req, seeds);
        for (const w of out.warnings) this.deps.emitWarning(w);
        return {
          commits: out.page.commits,
          // T10.5b: the page's cursor is a session token issued by `walkCommits`, not by this seam;
          // a non-null walk state is what says history continued past `limit`.
          more: out.state !== null || out.page.capped,
        };
      },
    };
  }

  /** The index and the HEAD tree the two working-tree scopes both start from. */
  async worktreeState(signal: AbortSignal) {
    const index = await this.deps.currentIndex();
    const headOid = this.deps.getHeadOid();
    const headTree = headOid ? await this.deps.db.flattenTree(headOid) : null;
    const status = await this.deps.withRootCheck(() =>
      this.deps.scanner.scan(index, headTree, signal),
    );
    for (const w of status.warnings) this.deps.emitWarning(w);
    return { index, headTree, status };
  }

  /**
   * What `git grep` would look at: the stage-0 index entries that exist in the working tree, plus
   * the untracked files the scanner's ignore rules let through. Symlinks and gitlinks have no
   * text to grep, a `skip-worktree` entry is not on disk, and a sparse directory is opaque.
   */
  async searchPaths(signal: AbortSignal, scope: string | undefined): Promise<string[]> {
    const { status, index } = await this.worktreeState(signal);
    const inScope = pathScope(scope);
    const paths = new Set<string>();
    for (const [path, e] of Object.entries(index.byPath)) {
      if (e.skipWorktree || e.isSparseDir) continue;
      if (e.mode === MODE_GITLINK || (e.mode & 0o170000) === 0o120000) continue;
      if (inScope(path)) paths.add(path);
    }
    for (const path of status.untracked) if (inScope(path)) paths.add(path);
    return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** The uncommitted row of the pickaxe: HEAD versus what is on disk right now. */
  async pickaxeWorktree(signal: AbortSignal): Promise<PickaxeWorktree> {
    const { status, headTree } = await this.worktreeState(signal);
    const changed = new Set<string>([
      ...Object.keys(status.staged),
      ...Object.keys(status.unstaged),
      ...status.untracked,
    ]);
    return {
      changed: [...changed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      head: async (path) => {
        const e = headTree?.[path];
        if (!e || e.mode === MODE_GITLINK) return null;
        return this.deps.db.readBlob(e.oid);
      },
      work: (path) => this.deps.readWorktreeBytes(path),
    };
  }

  /**
   * One search in one of the palette's three scopes (T10.8). Single in-flight like every phase-10
   * method: typing in the palette supersedes the previous query, which stops reading objects and
   * rejects with `CANCELLED`.
   */
  async search(req: SearchRequest): Promise<SearchResult> {
    this.deps.assertOpen();
    return this.deps.single("search", async (signal) => {
      const t0 = performance.now();
      this.deps.progress({ phase: "search", done: 0, total: 0 });
      const onProgress = (done: number, total: number) =>
        this.deps.progress({ phase: "search", done, total });
      const outcome = await this.runSearch(req, signal, onProgress);
      const durationMs = performance.now() - t0;
      if (outcome.capped) {
        this.deps.emitWarning({
          code: "SEARCH_CAPPED",
          message: "The search stopped at its limit; there may be more matches.",
          ...(outcome.note !== undefined ? { detail: outcome.note } : {}),
        });
      }
      this.deps.progress({
        phase: "search",
        done: outcome.scanned,
        total: outcome.scanned,
        durationMs,
      });
      return {
        hits: outcome.hits,
        scanned: outcome.scanned,
        capped: outcome.capped,
        durationMs,
      };
    });
  }

  private async runSearch(
    req: SearchRequest,
    signal: AbortSignal,
    onProgress: (done: number, total: number) => void,
  ): Promise<SearchOutcome> {
    switch (req.scope) {
      case "commits":
        return searchCommits(
          {
            source: await this.commitSource(signal, ["HEAD"]),
            message: async (oid) => (await this.deps.db.readCommit(oid)).message,
            signal,
            onProgress,
          },
          req,
        );
      case "worktree":
        return searchWorktree(
          {
            paths: await this.searchPaths(signal, req.path),
            read: (path) => this.deps.readWorktreeBytes(path),
            isGenerated: (path) => this.deps.attrs.isGenerated(path),
            limit: this.deps.statsLimit,
            signal,
            onProgress,
          },
          req,
        );
      case "pickaxe":
        return searchPickaxe(
          {
            source: await this.commitSource(signal, ["HEAD"]),
            tree: (oid) => this.deps.db.flattenTree(oid),
            blob: (oid) => this.deps.db.readBlob(oid),
            worktree: await this.pickaxeWorktree(signal),
            signal,
            onProgress,
          },
          req,
        );
      default:
        throw new EngineError("INTERNAL", `Unknown search scope ${String(req.scope)}.`, {
          hint: "Pick commits, worktree or pickaxe",
        });
    }
  }
}
