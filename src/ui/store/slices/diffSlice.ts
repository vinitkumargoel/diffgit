import type { FileStats } from "../../../engine/api";
import type { BlamePayload, FileDiff } from "../../../engine/types";
import {
  BLAME_REVISIONS,
  blameCacheKey,
  PATH_HISTORY_PAGE,
  pathHistoryCacheKey,
} from "../../blame";
import { toUiError } from "../../errors";
import { Lru } from "../../lru";
import { derivedKey, getDerived, setDerived } from "../../persistence/derived";
import {
  foundNote,
  hasUncommittedLayer,
  NO_FINDINGS_NOTE,
  NOTHING_TO_SCAN_NOTE,
} from "../../secrets";
import { viewedKey } from "../../viewedKey";
import type { WorkerClient } from "../../workerClient";
import { cacheKey, ignoreStale, statsSettled } from "../helpers";
import { getPersistence } from "../persistence";
import { blameTarget } from "../selectors";
import type { StoreGet, StoreSet, StoreState } from "../types";

/**
 * T11.9: the generation whose secret scan is still waiting for its stats, or null. The scan and
 * the stats pump both read file content in the engine, so the banner waits for the counts rather
 * than racing them (the brief: "after stats complete").
 */
let secretsAfterStats: number | null = null;

export function setSecretsAfterStats(generation: number | null): void {
  secretsAfterStats = generation;
}

export function maybeScanSecrets(
  files: readonly FileDiff[],
  stats: Record<string, FileStats>,
  generation: number,
  get: StoreGet,
): void {
  if (secretsAfterStats !== generation) return;
  if (!statsSettled(files, stats)) return;
  secretsAfterStats = null;
  void get().scanSecrets();
}

export type DiffSlice = Pick<
  StoreState,
  | "cardModes"
  | "blames"
  | "pathHistories"
  | "conflicts"
  | "secrets"
  | "hidden"
  | "fileDiffs"
  | "viewed"
  | "loadFileDiff"
  | "cancelFileDiff"
  | "prioritise"
  | "fileBytes"
  | "toggleViewed"
  | "setViewed"
  | "loadConflict"
  | "loadHidden"
  | "explainPath"
  | "scanSecrets"
  | "loadBlame"
  | "loadPathHistory"
  | "setCardMode"
>;

export function createDiffSlice(
  set: StoreSet,
  get: StoreGet,
  client: () => WorkerClient,
): DiffSlice {
  return {
    cardModes: {},
    blames: {},
    pathHistories: {},
    conflicts: {},
    secrets: null,
    hidden: null,
    fileDiffs: new Lru(200),
    viewed: new Set(),

    async loadFileDiff(id, opts = {}) {
      const s = get();
      if (!s.diff) return;
      const key = cacheKey(id, s.prefs.ignoreWhitespace);
      const existing = s.fileDiffs.get(key);
      if (existing && existing.status !== "error") {
        if (
          existing.status === "ready" &&
          opts.loadLarge &&
          existing.data.hunks === null &&
          existing.data.classification.tooLarge
        ) {
          // fall through: user asked to load a gated diff
        } else return;
      }
      const controller = new AbortController();
      const generation = s.diff.generation;
      const next = s.fileDiffs.clone();
      next.set(key, { status: "loading", controller });
      set({ fileDiffs: next });
      try {
        const data = await client().fileDiff(generation, id, {
          ignoreWhitespace: s.prefs.ignoreWhitespace,
          loadLarge: opts.loadLarge === true,
        });
        const cur = get();
        if (!cur.diff || cur.diff.generation !== generation || controller.signal.aborted) return;
        const updated = cur.fileDiffs.clone();
        updated.set(key, { status: "ready", data });
        set({ fileDiffs: updated });
      } catch (e) {
        const err = toUiError(e);
        const cur = get();
        if (
          err.code === "STALE" ||
          err.code === "CANCELLED" ||
          err.code === "WORKER_CRASHED" ||
          controller.signal.aborted
        ) {
          if (cur.fileDiffs.get(key)?.status === "loading") {
            const updated = cur.fileDiffs.clone();
            updated.delete(key);
            set({ fileDiffs: updated });
          }
          return;
        }
        const updated = cur.fileDiffs.clone();
        updated.set(key, { status: "error", error: err });
        set({ fileDiffs: updated });
      }
    },

    cancelFileDiff(id) {
      const s = get();
      const key = cacheKey(id, s.prefs.ignoreWhitespace);
      const entry = s.fileDiffs.get(key);
      if (entry?.status === "loading") {
        entry.controller.abort();
        const updated = s.fileDiffs.clone();
        updated.delete(key);
        set({ fileDiffs: updated });
        void client().cancelFileDiff(id).catch(ignoreStale);
      }
    },

    prioritise(ids) {
      if (!get().diff) return;
      void client().prioritise(ids).catch(ignoreStale);
    },

    async fileBytes(id, side) {
      const s = get();
      if (!s.diff) return null;
      return client().fileBytes(s.diff.generation, id, side);
    },

    toggleViewed(id) {
      const s = get();
      const file = s.diff?.files.find((f) => f.id === id);
      if (!file || !s.diff) return;
      const key = viewedKey(s.repoId ?? "", s.diff.source, file);
      const viewed = new Set(s.viewed);
      const collapsed = new Set(s.collapsed);
      const nowViewed = !viewed.has(key);
      if (nowViewed) {
        viewed.add(key);
        collapsed.add(id);
      } else {
        viewed.delete(key);
        collapsed.delete(id);
      }
      set({ viewed, collapsed });
      void getPersistence().saveViewed(key, nowViewed);
    },

    setViewed(ids, nowViewed) {
      const s = get();
      if (!s.diff) return;
      const byId = new Map(s.diff.files.map((f) => [f.id, f]));
      const viewed = new Set(s.viewed);
      const collapsed = new Set(s.collapsed);
      const keys: string[] = [];
      for (const id of ids) {
        const file = byId.get(id);
        if (!file) continue;
        const key = viewedKey(s.repoId ?? "", s.diff.source, file);
        if (nowViewed) {
          viewed.add(key);
          collapsed.add(id);
        } else {
          viewed.delete(key);
          collapsed.delete(id);
        }
        keys.push(key);
      }
      if (keys.length === 0) return;
      set({ viewed, collapsed });
      for (const key of keys) void getPersistence().saveViewed(key, nowViewed);
    },

    async loadConflict(id) {
      const s = get();
      if (!s.diff) return;
      const existing = s.conflicts[id];
      if (existing && existing.status !== "error") return;
      const generation = s.diff.generation;
      set((cur) => ({ conflicts: { ...cur.conflicts, [id]: { status: "loading" } } }));
      try {
        const data = await client().conflict(generation, id);
        const cur = get();
        if (!cur.diff || cur.diff.generation !== generation) return;
        set((c) => ({ conflicts: { ...c.conflicts, [id]: { status: "ready", data } } }));
      } catch (e) {
        const err = toUiError(e);
        const cur = get();
        if (err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED") {
          if (cur.conflicts[id]?.status === "loading") {
            const { [id]: _dropped, ...rest } = cur.conflicts;
            set({ conflicts: rest });
          }
          return;
        }
        set((c) => ({ conflicts: { ...c.conflicts, [id]: { status: "error", error: err } } }));
      }
    },

    async loadHidden() {
      if (!get().repo) return;
      try {
        const entries = await client().listHidden();
        // The toggle may have gone off (or the repo closed) while the walk was running.
        if (!get().repo || !get().prefs.showHidden) return;
        set({ hidden: entries });
      } catch (e) {
        // A superseded or stale call is normal (one in-flight per method); anything else leaves the
        // group empty rather than blocking the sidebar — the toggle can be pressed again.
        ignoreStale(e);
        if (get().prefs.showHidden && get().hidden === null) set({ hidden: [] });
      }
    },

    explainPath(path) {
      return client().explainPath(path);
    },

    async scanSecrets(opts = {}) {
      const s = get();
      if (!s.diff) return;
      const generation = s.diff.generation;
      // T10.7 skips these rows without reading a byte; the store skips the round trip as well, so
      // a committed-only diff never wakes the scanner (the task's "scan is not called" case).
      if (!s.diff.files.some(hasUncommittedLayer)) {
        secretsAfterStats = null;
        set({ secrets: [] });
        if (opts.announce) get().addToast({ level: "info", message: NOTHING_TO_SCAN_NOTE });
        return;
      }
      try {
        const found = await client().scanSecrets(generation);
        const cur = get();
        if (!cur.diff || cur.diff.generation !== generation) return;
        set({ secrets: found });
        if (opts.announce) {
          get().addToast(
            found.length === 0
              ? { level: "info", message: NO_FINDINGS_NOTE }
              : { level: "warning", message: foundNote(found.length) },
          );
        }
      } catch (e) {
        const err = toUiError(e);
        // A superseded or stale scan is normal (one call in flight per method): the next compute
        // asks again and the banner keeps whatever it had.
        ignoreStale(e);
        if (opts.announce && err.code !== "STALE" && err.code !== "CANCELLED") {
          get().addToast({ level: "warning", message: `Secret scan failed: ${err.message}` });
        }
      }
    },

    async loadBlame(path, opts) {
      const s = get();
      const target = blameTarget(s, opts.at);
      if (!target || !s.repo) return;
      const max = opts.maxRevisions ?? BLAME_REVISIONS;
      const key = blameCacheKey(target.oid, path, opts.ignoreWhitespace);
      const existing = s.blames[key];
      if (existing?.status === "loading") return;
      if (existing?.status === "ready" && existing.maxRevisions >= max) return;
      set((cur) => ({ blames: { ...cur.blames, [key]: { status: "loading" } } }));
      // The derived cache is keyed by a commit oid, so it may only hold answers that a commit fully
      // determines: a blame that carries working-tree lines is not one of those.
      const cacheable = !target.includeWorktree && s.repoId !== null;
      const derived = cacheable
        ? derivedKey.blame(s.repoId as string, target.oid, path, opts.ignoreWhitespace)
        : null;
      if (derived !== null) {
        const hit = await getDerived<{
          data: BlamePayload;
          maxRevisions: number;
        }>(derived);
        if (hit && hit.maxRevisions >= max) {
          if (get().blames[key]?.status !== "loading") return;
          set((cur) => ({
            blames: {
              ...cur.blames,
              [key]: { status: "ready", data: hit.data, maxRevisions: hit.maxRevisions },
            },
          }));
          return;
        }
      }
      try {
        const data = await client().blame(target.ref, path, {
          ignoreWhitespace: opts.ignoreWhitespace,
          includeWorktree: target.includeWorktree,
          maxRevisions: max,
        });
        if (!get().repo) return;
        set((cur) => ({
          blames: { ...cur.blames, [key]: { status: "ready", data, maxRevisions: max } },
        }));
        if (derived !== null) void setDerived(derived, { data, maxRevisions: max });
      } catch (e) {
        const err = toUiError(e);
        if (err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED") {
          // A superseded blame is normal (one in flight per method): drop the placeholder and let
          // the card ask again rather than showing a failure the user did not cause.
          set((cur) => {
            const { [key]: dropped, ...rest } = cur.blames;
            return dropped?.status === "loading" ? { blames: rest } : {};
          });
          return;
        }
        set((cur) => ({ blames: { ...cur.blames, [key]: { status: "error", error: err } } }));
      }
    },

    async loadPathHistory(path, opts) {
      const s = get();
      const target = blameTarget(s, opts.at);
      if (!target || !s.repo) return;
      const key = pathHistoryCacheKey(target.oid, path, opts.follow);
      const existing = s.pathHistories[key];
      if (existing?.loading) return;
      if (!opts.more && existing && existing.entries.length > 0) return;
      if (opts.more && existing && existing.cursor === null) return;
      const cursor = opts.more ? (existing?.cursor ?? undefined) : undefined;
      set((cur) => ({
        pathHistories: {
          ...cur.pathHistories,
          [key]: {
            ...(cur.pathHistories[key] ?? {
              entries: [],
              cursor: null,
              loading: false,
              error: null,
            }),
            loading: true,
            error: null,
          },
        },
      }));
      try {
        const page = await client().pathHistory(target.ref, path, {
          follow: opts.follow,
          limit: PATH_HISTORY_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!get().repo) return;
        set((cur) => {
          const before = cur.pathHistories[key] ?? {
            entries: [],
            cursor: null,
            loading: false,
            error: null,
          };
          return {
            pathHistories: {
              ...cur.pathHistories,
              [key]: {
                entries: cursor === undefined ? page.entries : [...before.entries, ...page.entries],
                cursor: page.cursor,
                loading: false,
                error: null,
              },
            },
          };
        });
      } catch (e) {
        const err = toUiError(e);
        const stale =
          err.code === "STALE" || err.code === "CANCELLED" || err.code === "WORKER_CRASHED";
        set((cur) => {
          const before = cur.pathHistories[key] ?? {
            entries: [],
            cursor: null,
            loading: false,
            error: null,
          };
          return {
            pathHistories: {
              ...cur.pathHistories,
              [key]: { ...before, loading: false, error: stale ? null : err },
            },
          };
        });
        if (stale) ignoreStale(e);
      }
    },

    setCardMode(id, cardMode) {
      set((s) =>
        s.cardModes[id] === cardMode ? {} : { cardModes: { ...s.cardModes, [id]: cardMode } },
      );
    },
  };
}
