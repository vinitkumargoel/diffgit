import type { FileDiffPayload, HunkModel, PatchResult } from "../../../engine/api";
import { languageFor } from "../../../engine/diff/language";
import { EMPTY_TREE_OID } from "../../../engine/git/hash";
import type { DiffResult, DiffSource, FileDiff } from "../../../engine/types";
import { toUiError } from "../../errors";
import { Lru } from "../../lru";
import { MAX_PATCH_BYTES, tooLargeMessage } from "../../patch";
import type { WorkerClient } from "../../workerClient";
import { cacheKey, ignoreStale } from "../helpers";
import {
  type FileDiffEntry,
  INITIAL_PATCH_SESSION,
  type StoreGet,
  type StoreSet,
  type StoreState,
} from "../types";

/**
 * The `DiffSource` of a patch-only session. Both sides are the file's own name, so the sidebar's
 * committed group reads `Committed on <name>` and the viewed keys are the patch's; the two oids are
 * the empty tree because a patch names no objects and nothing in this mode resolves them (there is
 * no repository to resolve them against).
 */
function patchSourceOf(name: string): DiffSource {
  return {
    kind: "range",
    from: name,
    to: name,
    fromRef: name,
    toRef: name,
    fromOid: null,
    toOid: EMPTY_TREE_OID,
    threeDot: false,
    includeWorktree: false,
  };
}

/** Patch rows belong to no repository generation; one constant keeps `STALE` checks honest. */
const PATCH_GENERATION = 0;

/**
 * One parsed row as the `FileDiffPayload` the card expects. The sides' full text is not in a patch,
 * so `oldText`/`newText` stay null — the card renders the hunks and simply offers no context
 * expansion — and the sizes are the 0 the contract fixes (`<!-- T10.12 -->`).
 */
function payloadOfPatchRow(file: FileDiff, hunks: Record<string, HunkModel>): FileDiffPayload {
  const path = file.newPath ?? file.oldPath ?? file.id;
  return {
    id: file.id,
    generation: PATCH_GENERATION,
    classification: {
      binary: file.binary,
      image: file.image,
      tooLarge: false,
      huge: false,
      typechange: file.status === "typechange",
      submodule: false,
      generated: file.generated === true,
      whitespaceOnly: false,
      oldSize: file.oldSize,
      newSize: file.newSize,
      changedLines: file.stats ? file.stats.additions + file.stats.deletions : null,
    },
    hunks: hunks[file.id] ?? null,
    oldText: null,
    newText: null,
    language: languageFor(path),
    stats: file.stats ?? { additions: 0, deletions: 0 },
    oldMode: file.oldMode,
    newMode: file.newMode,
  };
}

export type PatchSessionSlice = Pick<
  StoreState,
  "patchOnly" | "patchSession" | "openPatchFile" | "openPatchText" | "dismissPatchError"
>;

export function createPatchSessionSlice(
  set: StoreSet,
  get: StoreGet,
  client: () => WorkerClient,
): PatchSessionSlice {
  return {
    patchOnly: false,
    patchSession: INITIAL_PATCH_SESSION,

    async openPatchFile(file) {
      if (file.size > MAX_PATCH_BYTES) {
        set({
          patchSession: {
            ...get().patchSession,
            loading: false,
            error: { code: "TOO_LARGE", message: tooLargeMessage(file.name, file.size) },
          },
        });
        return;
      }
      set({ patchSession: { ...get().patchSession, loading: true, error: null } });
      let text: string;
      try {
        text = await file.text();
      } catch (e) {
        const err = toUiError(e);
        set({ patchSession: { ...get().patchSession, loading: false, error: err } });
        return;
      }
      await get().openPatchText(text, file.name);
    },

    async openPatchText(text, name) {
      set({ patchSession: { ...get().patchSession, loading: true, error: null } });
      let parsed: PatchResult;
      try {
        parsed = await client().parsePatch(text);
      } catch (e) {
        const err = toUiError(e);
        ignoreStale(e);
        // A superseded parse is not an error the user asked about; anything else is printed inline
        // where the file was offered, with the engine's `line <n>: …` detail (T10.12).
        if (err.code === "STALE" || err.code === "CANCELLED") return;
        set({ patchSession: { ...get().patchSession, loading: false, error: err } });
        return;
      }
      // A patch never inherits a repository: close first, then build the session from the answer.
      await get().closeRepo();
      const now = Date.now();
      const diff: DiffResult = {
        source: patchSourceOf(name),
        mergeBase: null,
        files: parsed.files,
        totals: parsed.stats,
        computedAt: now,
        durationMs: 0,
        generation: PATCH_GENERATION,
        warnings: parsed.warnings,
      };
      // The hunks came with the answer, so every card is already loaded: `loadFileDiff` finds a
      // ready entry and never calls an engine that has no repository open. Both whitespace keys are
      // filled — a patch carries what it carries, and `-w` cannot be recomputed from it.
      const fileDiffs = new Lru<string, FileDiffEntry>(200);
      for (const f of parsed.files) {
        const entry: FileDiffEntry = { status: "ready", data: payloadOfPatchRow(f, parsed.hunks) };
        fileDiffs.set(cacheKey(f.id, false), entry);
        fileDiffs.set(cacheKey(f.id, true), entry);
      }
      set({
        screen: "repo",
        patchOnly: true,
        patchSession: { name, text, loading: false, error: null },
        diff,
        fileDiffs,
        warnings: parsed.warnings,
        // Every patch row is `["committed"]` (T10.12), which is exactly the diff the scanner skips
        // without being asked: `[]` is the real answer, and the export gate is clear because of it.
        secrets: [],
        stats: {},
        statsLastAt: null,
        mode: "files",
        activeFileId: parsed.files[0]?.id ?? null,
      });
    },

    dismissPatchError() {
      set({ patchSession: { ...get().patchSession, error: null } });
    },
  };
}
