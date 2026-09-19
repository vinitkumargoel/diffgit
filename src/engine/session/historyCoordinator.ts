import type { BlameRequest, PathHistoryOptions, Progress } from "../api";
import { blame as runBlame } from "../diff/blame";
import { EngineError } from "../errors";
import type { FsaFs } from "../fs/fsaFs";
import { bisectStep as computeBisectStep } from "../git/bisect";
import { branchCells, branchOverview } from "../git/branches";
import { CommitGraph } from "../git/commitGraph";
import { commitDetails, commitStats } from "../git/commits";
import type { GitConfig } from "../git/config";
import { MAILMAP_FILE, Mailmap } from "../git/mailmap";
import type { ObjectDb } from "../git/objectDb";
import { pathHistory as runPathHistory } from "../git/pathHistory";
import { rebasePreflight as computePreflight } from "../git/preflight";
import { readReflog } from "../git/reflog";
import { resolveRevision } from "../git/revisions";
import { countStashFiles, listStashes } from "../git/stash";
import { listTags } from "../git/tags";
import {
  CommitReader,
  aheadBehind as computeAheadBehind,
  MAX_WALK,
  type ReachableResult,
  reachableFrom,
  walkCommits as runWalk,
  type WalkState,
  walkRequestKey,
} from "../git/walk";
import { computeInsights } from "../insights/insights";
import type {
  AheadBehind,
  BisectState,
  BisectStep,
  BlamePayload,
  BranchRow,
  CommitDetails,
  InsightsRequest,
  InsightsResult,
  Oid,
  PathHistoryEntry,
  PreflightResult,
  ReflogEntry,
  RefSnapshot,
  RepoWarning,
  ResolvedRevision,
  StashInfo,
  TagInfo,
  WalkPage,
  WalkRequest,
} from "../types";
import { STASH_FILE_COUNT_LIMIT } from "./types";

export interface HistoryCoordinatorDeps {
  fs: FsaFs;
  db: ObjectDb;
  cfg: GitConfig;
  getRefs: () => RefSnapshot;
  statsLimit: <T>(fn: () => Promise<T>) => Promise<T>;
  progress: (p: Progress) => void;
  emitWarning: (w: RepoWarning) => void;
  onRepoWarning: (w: RepoWarning) => void;
  withRootCheck: <T>(fn: () => Promise<T>) => Promise<T>;
  assertOpen: () => void;
  single: <T>(method: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  readWorktreeBytes: (path: string) => Promise<Uint8Array | null>;
  readTextOrNull: (path: string) => Promise<string | null>;
}

export class HistoryCoordinator {
  /** T10.5: parents + commit time, from the commit-graph when there is a usable one. */
  private reader: CommitReader | null = null;
  /** T10.5: oid → ref/tag/stash labels for the history badges; rebuilt when refs move. */
  private refsIndex: Promise<Map<Oid, string[]>> | null = null;
  /** T10.5: "reachable from any ref", cached per refs snapshot (`markReachable`). */
  private reachable: { key: string; result: ReachableResult } | null = null;
  /**
   * T10.5b S4: the walk state a `WalkPage.cursor` names. The cursor is an opaque token into this
   * map rather than a serialised frontier (which was ~47 B per commit walked, per page); a token
   * this session does not hold — a worker restart, a refs change, an evicted older page — answers
   * `STALE` and the UI restarts the list.
   */
  private readonly walkStates = new Map<string, WalkState>();
  private walkTokens = 0;
  private readonly walkPrefix = `w${Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0")}`;
  /** T10.5b S3: `aheadBehind` memoised per ordered pair; dropped with the other history caches. */
  private readonly aheadBehindCache = new Map<string, AheadBehind>();

  /** The number of walk cursors the session keeps alive; older ones answer `STALE`. */
  private static readonly WALK_STATES = 8;
  private static readonly WALK_TOKEN = /^w[0-9a-f]{8}\.[1-9][0-9]*$/;

  constructor(private readonly deps: HistoryCoordinatorDeps) {}

  /**
   * The commit reader, built once per session. A usable commit-graph makes the walk read one static
   * file instead of inflating every commit object (atlas tab 20); anything wrong with the file is a
   * `COMMIT_GRAPH_STALE` warning and an object-read fallback, never an error.
   */
  async commitReader(): Promise<CommitReader> {
    if (this.reader) return this.reader;
    const load = await this.deps.withRootCheck(() => CommitGraph.load(this.deps.fs));
    for (const w of load.warnings) {
      this.deps.onRepoWarning(w);
    }
    this.reader = new CommitReader(this.deps.db, load.graph);
    return this.reader;
  }

  /** Everything cached off the refs snapshot; dropped whenever refs or objects may have moved. */
  dropHistoryCaches(): void {
    this.reader = null;
    this.refsIndex = null;
    this.reachable = null;
    // Every outstanding cursor described a walk of refs that have since moved (T10.5b S2/S4).
    this.walkStates.clear();
    this.aheadBehindCache.clear();
  }

  /**
   * oid → the labels the history rows wear, in badge order: `HEAD`, then branch and remote names in
   * RefStore's order, then tags, then stash selectors (Design §14.5).
   */
  refsByCommit(): Promise<Map<Oid, string[]>> {
    this.refsIndex ??= (async () => {
      const map = new Map<Oid, string[]>();
      const add = (oid: Oid | null | undefined, label: string) => {
        if (!oid) return;
        const list = map.get(oid) ?? [];
        if (!list.includes(label)) list.push(label);
        map.set(oid, list);
      };
      const refs = this.deps.getRefs();
      add(refs.headOid, "HEAD");
      for (const r of refs.refs) if (!r.synthetic) add(r.oid, r.name);
      for (const t of await listTags(this.deps.db)) add(t.targetOid, t.name);
      for (const s of await listStashes(this.deps.fs, this.deps.db)) add(s.oid, s.expr);
      return map;
    })().catch((e) => {
      this.refsIndex = null;
      throw e;
    });
    return this.refsIndex;
  }

  /**
   * The commits `walkCommits` starts from: the request's expressions, then — for `all` — every ref
   * in the repository followed by HEAD, which is the order `git log --all` seeds its walk in
   * (`for_each_ref` is ref-name sorted, and `handle_refs(head_ref)` comes after it). The order only
   * decides ties between commits of the same date, but a fixture built with a fixed
   * `GIT_COMMITTER_DATE` is nothing but ties.
   */
  async walkSeeds(req: WalkRequest, reader: CommitReader): Promise<Oid[]> {
    const seeds: Oid[] = [];
    const taken = new Set<Oid>(); // T10.5b nit 6: O(1) dedup, not `includes` per ref
    const add = async (oid: Oid | null | undefined): Promise<void> => {
      if (!oid || taken.has(oid)) return;
      taken.add(oid);
      // T10.5b B1: a tag can name a blob or a tree; `git log --all` leaves such a ref out.
      if (!(await reader.isCommit(oid))) return;
      seeds.push(oid);
    };
    const refs = this.deps.getRefs();
    for (const expr of req.from) await add((await resolveRevision(this.deps.db, refs, expr)).oid);
    if (req.all === true) {
      const named: { fullName: string; oid: Oid }[] = [];
      for (const r of refs.refs) if (!r.synthetic) named.push(r);
      for (const t of await listTags(this.deps.db)) {
        if (t.targetType !== "commit") continue;
        named.push({ fullName: t.fullName, oid: t.targetOid });
      }
      for (const s of await listStashes(this.deps.fs, this.deps.db)) {
        named.push({ fullName: `refs/stash@{${s.index}}`, oid: s.oid });
      }
      named.sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
      for (const r of named) await add(r.oid);
      await add(refs.headOid);
    }
    if (seeds.length === 0) await add(refs.headOid); // an unborn branch has no history
    return seeds;
  }

  /**
   * T10.5b S2/S4: the cursor is a token this session issued. A token it never issued, or one it
   * has dropped (refs moved, worker restarted, eight pages ago), is `STALE` — the UI restarts the
   * list, which is the only safe answer while refs move. Anything that is not a token at all is a
   * caller bug and answers `INTERNAL`.
   */
  private resumeWalk(cursor: string, key: string): WalkState {
    if (!HistoryCoordinator.WALK_TOKEN.test(cursor))
      throw new EngineError("INTERNAL", "The history cursor is not a cursor this engine issued.", {
        detail: cursor.slice(0, 64),
      });
    const state = this.walkStates.get(cursor);
    if (!state)
      throw new EngineError("STALE", "The history cursor is no longer valid.", {
        hint: "Reload the history list",
        detail: cursor,
      });
    if (state.key !== key) {
      this.walkStates.delete(cursor);
      throw new EngineError("STALE", "The history cursor belongs to a different query.", {
        hint: "Reload the history list",
        detail: cursor,
      });
    }
    return state;
  }

  private issueWalkToken(state: WalkState): string {
    this.walkTokens += 1;
    const token = `${this.walkPrefix}.${this.walkTokens}`;
    this.walkStates.set(token, state);
    while (this.walkStates.size > HistoryCoordinator.WALK_STATES) {
      const oldest = this.walkStates.keys().next().value as string;
      this.walkStates.delete(oldest);
    }
    return token;
  }

  // ---- revisions, tags, stashes (T10.1) --------------------------------------------------------

  async resolveRevision(expr: string): Promise<ResolvedRevision> {
    this.deps.assertOpen();
    return this.deps.single("resolveRevision", () =>
      resolveRevision(this.deps.db, this.deps.getRefs(), expr),
    );
  }

  async listTags(): Promise<TagInfo[]> {
    this.deps.assertOpen();
    return this.deps.single("listTags", () => listTags(this.deps.db));
  }

  async listStashes(): Promise<StashInfo[]> {
    this.deps.assertOpen();
    return this.deps.single("listStashes", async () => {
      const stashes = await listStashes(this.deps.fs, this.deps.db);
      // The picker shows a file count per stash (Design §14.1); it costs two tree flattens each,
      // so only the stack a human would scroll gets one.
      for (const s of stashes.slice(0, STASH_FILE_COUNT_LIMIT)) {
        s.files = await countStashFiles(this.deps.db, s);
      }
      return stashes;
    });
  }

  /**
   * The reflog of `expr`, newest first (T10.2). A repository that keeps none answers with `[]` and
   * a `NO_REFLOG` warning on the sink rather than an error.
   */
  async reflog(expr: string, limit: number): Promise<ReflogEntry[]> {
    this.deps.assertOpen();
    return this.deps.single("reflog", async () => {
      const out = await readReflog(this.deps.fs, expr, { limit });
      for (const w of out.warnings) this.deps.emitWarning(w);
      // T10.5: one batched reachability walk fills every `reachable`, which is what marks the
      // commit a `git reset` orphaned (Design §14.5: the `unreachable` badge).
      if (out.entries.length > 0) {
        const set = await this.reachableSet();
        for (const e of out.entries) e.reachable = set.oids.has(e.newOid);
      }
      return out.entries;
    });
  }

  async walkCommits(req: WalkRequest): Promise<WalkPage> {
    this.deps.assertOpen();
    return this.deps.single("walkCommits", async (signal) => {
      const t0 = performance.now();
      const reader = await this.commitReader();
      const seeds = await this.walkSeeds(req, reader);
      const refsByCommit = await this.refsByCommit();
      const key = walkRequestKey(req, seeds);
      const resume = req.cursor === undefined ? null : this.resumeWalk(req.cursor, key);
      if (req.cursor !== undefined) this.walkStates.delete(req.cursor);
      const out = await runWalk(
        {
          db: this.deps.db,
          reader,
          refsByCommit,
          signal,
          // T10.5b S5: a long walk reports as it goes instead of once, at the end.
          onProgress: (walked) => this.deps.progress({ phase: "history", done: walked }),
        },
        req,
        seeds,
        resume,
      );
      for (const w of out.warnings) this.deps.emitWarning(w);
      const page: WalkPage = {
        ...out.page,
        cursor: out.state === null ? null : this.issueWalkToken(out.state),
      };
      this.deps.progress({
        phase: "history",
        done: page.commits.length,
        durationMs: performance.now() - t0,
      });
      return page;
    });
  }

  /** Shared by `commitStats`, `commitDetails` and the history rows' `+n −m`. */
  private async statsDeps(signal?: AbortSignal) {
    return {
      db: this.deps.db,
      reader: await this.commitReader(),
      limit: this.deps.statsLimit,
      warn: (w: RepoWarning) => this.deps.emitWarning(w),
      ...(signal ? { signal } : {}),
      ...(this.deps.cfg.diff.renames !== undefined ? { renames: this.deps.cfg.diff.renames } : {}),
      ...(this.deps.cfg.diff.renameLimit !== undefined
        ? { renameLimit: this.deps.cfg.diff.renameLimit }
        : {}),
    };
  }

  async commitDetails(oid: Oid): Promise<CommitDetails> {
    this.deps.assertOpen();
    return this.deps.single("commitDetails", async (signal) =>
      commitDetails(
        { ...(await this.statsDeps(signal)), refsByCommit: await this.refsByCommit() },
        (await resolveRevision(this.deps.db, this.deps.getRefs(), oid)).oid ?? oid,
      ),
    );
  }

  async commitStats(oids: Oid[]): Promise<Record<Oid, CommitDetails["stats"]>> {
    this.deps.assertOpen();
    return this.deps.single("commitStats", async (signal) =>
      commitStats(await this.statsDeps(signal), oids),
    );
  }

  async aheadBehind(a: string, b: string): Promise<AheadBehind> {
    this.deps.assertOpen();
    return this.deps.single("aheadBehind", async (signal) => {
      const refs = this.deps.getRefs();
      const left = await resolveRevision(this.deps.db, refs, a);
      const right = await resolveRevision(this.deps.db, refs, b);
      if (left.oid === null || right.oid === null)
        throw new EngineError("REV_NOT_FOUND", `Cannot compare "${a}" with "${b}".`, {
          hint: "Both sides must be commits.",
        });
      return this.memoisedAheadBehind(left.oid, right.oid, signal);
    });
  }

  /**
   * T10.5b S3: one `(a, b)` pair is walked once per refs generation. `branchCells` asks for two
   * comparisons per row and a 50-branch table shares almost all of that work.
   */
  async memoisedAheadBehind(a: Oid, b: Oid, signal?: AbortSignal): Promise<AheadBehind> {
    const key = `${a}|${b}`;
    const hit = this.aheadBehindCache.get(key);
    if (hit) return hit;
    const out = await computeAheadBehind(
      this.deps.db,
      await this.commitReader(),
      a,
      b,
      signal ? { signal } : {},
    );
    this.aheadBehindCache.set(key, out);
    // The mirror image is free, and `branchCells` asks for it whenever two branches track each other.
    this.aheadBehindCache.set(`${b}|${a}`, {
      ahead: out.behind,
      behind: out.ahead,
      mergeBase: out.mergeBase,
      capped: out.capped,
    });
    return out;
  }

  /** The shared `BranchDeps`: refs, config, the memoised comparison and the warning sink. */
  private async branchDeps(signal?: AbortSignal) {
    return {
      db: this.deps.db,
      reader: await this.commitReader(),
      cfg: this.deps.cfg,
      refs: this.deps.getRefs(),
      warn: (w: RepoWarning) => this.deps.emitWarning(w),
      aheadBehind: (a: Oid, b: Oid) => this.memoisedAheadBehind(a, b, signal),
      ...(signal ? { signal } : {}),
    };
  }

  async branchOverview(): Promise<BranchRow[]> {
    this.deps.assertOpen();
    return this.deps.single("branchOverview", async (signal) =>
      branchOverview(await this.branchDeps(signal), await listTags(this.deps.db)),
    );
  }

  async branchCells(
    fullNames: string[],
  ): Promise<Record<string, Pick<BranchRow, "vsUpstream" | "vsDefault" | "merged">>> {
    this.deps.assertOpen();
    return this.deps.single("branchCells", async (signal) =>
      branchCells(await this.branchDeps(signal), fullNames),
    );
  }

  async markReachable(oids: Oid[]): Promise<Record<Oid, boolean>> {
    this.deps.assertOpen();
    return this.deps.single("markReachable", async (signal) => {
      const set = await this.reachableSet(signal);
      const out: Record<Oid, boolean> = {};
      for (const oid of oids) out[oid] = set.oids.has(oid);
      return out;
    });
  }

  /** One walk from every ref (`git rev-list --all`), cached until the refs snapshot changes. */
  async reachableSet(signal?: AbortSignal): Promise<ReachableResult> {
    const refs = this.deps.getRefs();
    const key = `${refs.headOid ?? "-"}|${refs.refs.map((r) => `${r.fullName}=${r.oid}`).join(",")}`;
    if (this.reachable?.key === key) return this.reachable.result;
    const reader = await this.commitReader();
    const tips: Oid[] = [];
    const taken = new Set<Oid>(); // T10.5b nit 6
    const add = (oid: Oid | null | undefined) => {
      if (!oid || taken.has(oid)) return;
      taken.add(oid);
      tips.push(oid);
    };
    add(refs.headOid);
    for (const r of refs.refs) if (!r.synthetic) add(r.oid);
    // T10.5b B1: a tag on a blob or a tree is not a tip `rev-list --all` would ever walk.
    for (const t of await listTags(this.deps.db)) if (t.targetType === "commit") add(t.targetOid);
    for (const s of await listStashes(this.deps.fs, this.deps.db)) add(s.oid);
    const result = await reachableFrom(reader, tips, MAX_WALK, signal);
    if (result.capped) {
      this.deps.emitWarning({
        code: "HISTORY_CAPPED",
        message: `Reachability was computed from the newest ${MAX_WALK.toLocaleString("en")} commits only; older entries may be marked unreachable.`,
      });
    }
    this.reachable = { key, result };
    return result;
  }

  // ---- file history and blame (T10.6) ----------------------------------------------------------

  /** What `pathHistory` and the rename-follow step need; the rename limit is git's own config. */
  private async historyDeps(signal: AbortSignal) {
    return {
      db: this.deps.db,
      reader: await this.commitReader(),
      ...(this.deps.cfg.diff.renameLimit !== undefined
        ? { renameLimit: this.deps.cfg.diff.renameLimit }
        : {}),
      signal,
    };
  }

  async resolveCommit(ref: string): Promise<Oid> {
    const resolved = await resolveRevision(this.deps.db, this.deps.getRefs(), ref);
    if (resolved.oid === null)
      throw new EngineError("REV_NOT_FOUND", `"${ref}" does not name a commit.`, {
        hint: "Pick a branch, tag or commit",
      });
    return resolved.oid;
  }

  /** `git log [--follow] -- <path>` for one path, newest first (T10.6). */
  async pathHistory(
    ref: string,
    path: string,
    opts: PathHistoryOptions,
  ): Promise<{ entries: PathHistoryEntry[]; cursor: string | null }> {
    this.deps.assertOpen();
    return this.deps.single("pathHistory", async (signal) =>
      runPathHistory(await this.historyDeps(signal), await this.resolveCommit(ref), path, opts),
    );
  }

  /**
   * Who wrote each line of `path` at `ref` (T10.6). The path history is resolved first (renames
   * followed) so the reverse-diff has both the revision list and the rename hops; `maxRevisions + 1`
   * entries are asked for so the cut can be told apart from a history that simply ended.
   */
  async blame(ref: string, path: string, opts: BlameRequest): Promise<BlamePayload> {
    this.deps.assertOpen();
    return this.deps.single("blame", async (signal) => {
      const t0 = performance.now();
      const maxRevisions = Math.max(1, opts.maxRevisions);
      const deps = await this.historyDeps(signal);
      const history = await runPathHistory(deps, await this.resolveCommit(ref), path, {
        follow: true,
        limit: maxRevisions + 1,
      });
      if (history.entries.length === 0)
        throw new EngineError("REF_NOT_FOUND", `${path} does not exist in ${ref}.`, {
          hint: "Check the path and the branch",
        });
      const historyCapped = history.entries.length > maxRevisions;
      const out = await runBlame(
        {
          db: this.deps.db,
          entries: history.entries.slice(0, maxRevisions),
          historyCapped,
          readWorktree: (p) => this.deps.readWorktreeBytes(p),
          onProgress: (done, total) => this.deps.progress({ phase: "blame", done, total }),
          signal,
        },
        ref,
        path,
        opts,
      );
      for (const w of out.warnings) this.deps.emitWarning(w);
      this.deps.progress({
        phase: "blame",
        done: out.payload.revisions,
        total: out.payload.revisions,
        durationMs: performance.now() - t0,
      });
      return out.payload;
    });
  }

  // ---- insights (T10.9, atlas tab 13) ----------------------------------------------------------

  /**
   * Activity, contributors and hotspots from one first-parent walk of `HEAD` (`src/engine/insights`).
   *
   * `.mailmap` is re-read on every call, as `scanSecrets` re-reads its allowlist: it is a
   * working-tree file the user may be editing, and it costs one small read. The walk itself goes
   * through `walkCommits`, so it shares the commit-graph reader, the cap and the cancellation the
   * history list already has; only the per-commit path-level tree diff is new work.
   */
  async insights(req: InsightsRequest): Promise<InsightsResult> {
    this.deps.assertOpen();
    return this.deps.single("insights", async (signal) => {
      const t0 = performance.now();
      const reader = await this.commitReader();
      const seeds = await this.walkSeeds({ from: ["HEAD"], firstParent: true, limit: 1 }, reader);
      const mailmap = Mailmap.parse(await this.deps.readTextOrNull(MAILMAP_FILE));
      this.deps.progress({ phase: "insights", done: 0 });
      const out = await computeInsights(
        {
          db: this.deps.db,
          reader,
          mailmap,
          refsByCommit: await this.refsByCommit(),
          signal,
          onProgress: (walked) => this.deps.progress({ phase: "insights", done: walked }),
        },
        seeds,
        req,
      );
      for (const w of out.warnings) this.deps.emitWarning(w);
      this.deps.progress({
        phase: "insights",
        done: out.result.walked,
        total: out.result.walked,
        durationMs: performance.now() - t0,
      });
      return out.result;
    });
  }

  // ---- bisect and rebase preflight (T10.11) ----------------------------------------------------

  /**
   * The next commit to test (atlas tab 15). The marks arrive as oids, but any revision expression
   * resolves too, so the UI may hand over what the user typed. Nothing is written (D16).
   */
  async bisectStep(state: BisectState): Promise<BisectStep> {
    this.deps.assertOpen();
    return this.deps.single("bisectStep", async (signal) => {
      const deps = {
        reader: await this.commitReader(),
        warn: (w: RepoWarning) => this.deps.emitWarning(w),
        signal,
      };
      return computeBisectStep(deps, {
        bad: await this.resolveCommit(state.bad),
        good: await Promise.all(state.good.map((g) => this.resolveCommit(g))),
        skipped: await Promise.all(state.skipped.map((s) => this.resolveCommit(s))),
      });
    });
  }

  /** What a `git rebase branchRef onto ontoRef` would replay, and where it would stop (tab 16). */
  async rebasePreflight(branchRef: string, ontoRef: string): Promise<PreflightResult> {
    this.deps.assertOpen();
    return this.deps.single("rebasePreflight", async (signal) => {
      const refs = this.deps.getRefs();
      const branch = await resolveRevision(this.deps.db, refs, branchRef);
      const onto = await resolveRevision(this.deps.db, refs, ontoRef);
      if (branch.oid === null || onto.oid === null)
        throw new EngineError(
          "REV_NOT_FOUND",
          `Cannot plan a rebase of "${branchRef}" onto "${ontoRef}".`,
          { hint: "Both sides must be commits." },
        );
      return computePreflight(
        {
          db: this.deps.db,
          reader: await this.commitReader(),
          warn: (w: RepoWarning) => this.deps.emitWarning(w),
          signal,
          ...(this.deps.cfg.diff.renames !== undefined
            ? { renames: this.deps.cfg.diff.renames }
            : {}),
          ...(this.deps.cfg.diff.renameLimit !== undefined
            ? { renameLimit: this.deps.cfg.diff.renameLimit }
            : {}),
        },
        { oid: branch.oid, display: branch.display },
        { oid: onto.oid, display: onto.display },
      );
    });
  }
}
