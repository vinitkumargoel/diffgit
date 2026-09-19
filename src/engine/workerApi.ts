/**
 * The object exposed over comlink (T3.5). One session at a time; every rejection is a plain
 * `PublicError` so it survives structured cloning with its `code`.
 */
import type { EngineApi, OpenOptions, ProgressSink } from "./api";
import { EngineError } from "./errors";
import type { DirHandleLike } from "./fs/dirHandleLike";
import { resolveHandle } from "./fs/resolveHandle";
import { RepoSession, type SessionOptions, toPublicError } from "./session";

export interface WorkerApiOptions {
  /** Turns whatever the UI posted into a DirHandleLike (default: `resolveHandle`). */
  resolve?: (handle: unknown) => Promise<DirHandleLike>;
  session?: SessionOptions;
}

export function createEngineApi(
  opts: WorkerApiOptions = {},
): EngineApi & { current(): RepoSession | null } {
  let session: RepoSession | null = null;
  const resolve = opts.resolve ?? resolveHandle;

  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toPublicError(e);
    }
  }
  function need(): RepoSession {
    if (!session || session.isClosed) throw new EngineError("INTERNAL", "No repository is open.");
    return session;
  }

  return {
    current: () => session,
    open: (handle, sink: ProgressSink, open?: OpenOptions) =>
      guard(async () => {
        await session?.close();
        session = null;
        const root = await resolve(handle);
        // T10.4: the page's `builtinExcludes` preference (B10) wins over the worker's own default.
        session = await RepoSession.open(root, sink, {
          ...opts.session,
          ...(open?.builtinExcludes !== undefined ? { builtinExcludes: open.builtinExcludes } : {}),
        });
        return session.info();
      }),
    info: () => guard(() => need().info()),
    reloadRefs: () => guard(() => need().reloadRefs()),
    computeDiff: (src) => guard(() => need().computeDiff(src)),
    resolveRevision: (expr) => guard(() => need().resolveRevision(expr)),
    listTags: () => guard(() => need().listTags()),
    listStashes: () => guard(() => need().listStashes()),
    reflog: (expr, limit) => guard(() => need().reflog(expr, limit)),
    operation: () => guard(() => need().operation()),
    fileStats: (generation, ids) => guard(() => need().fileStats(generation, ids)),
    fileDiff: (generation, id, o) => guard(() => need().fileDiff(generation, id, o)),
    cancelFileDiff: (id) => guard(() => need().cancelFileDiff(id)),
    conflict: (generation, id) => guard(() => need().conflict(generation, id)),
    explainPath: (path) => guard(() => need().explainPath(path)),
    listHidden: () => guard(() => need().listHidden()),
    walkCommits: (req) => guard(() => need().walkCommits(req)),
    commitDetails: (oid) => guard(() => need().commitDetails(oid)),
    commitStats: (oids) => guard(() => need().commitStats(oids)),
    aheadBehind: (a, b) => guard(() => need().aheadBehind(a, b)),
    branchOverview: () => guard(() => need().branchOverview()),
    branchCells: (fullNames) => guard(() => need().branchCells(fullNames)),
    markReachable: (oids) => guard(() => need().markReachable(oids)),
    pathHistory: (ref, path, o) => guard(() => need().pathHistory(ref, path, o)),
    blame: (ref, path, o) => guard(() => need().blame(ref, path, o)),
    scanSecrets: (generation) => guard(() => need().scanSecrets(generation)),
    search: (req) => guard(() => need().search(req)),
    fileBytes: (generation, id, side) => guard(() => need().fileBytes(generation, id, side)),
    prioritise: (ids) => guard(() => need().prioritise(ids)),
    probe: (tier) => guard(() => need().probe(tier)),
    invalidate: (scope, paths) => guard(() => need().invalidate(scope, paths)),
    forceRehash: () => guard(() => need().forceRehash()),
    metrics: () => guard(() => need().metrics()),
    close: () =>
      guard(async () => {
        await session?.close();
        session = null;
      }),
  };
}
