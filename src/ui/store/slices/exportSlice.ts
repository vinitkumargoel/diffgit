import type { FileDiff } from "../../../engine/types";
import { labelOf } from "../../compareSource";
import { toUiError } from "../../errors";
import { copyText, downloadText, HTML_MIME, PATCH_MIME } from "../../export/download";
import {
  COPY_FAILED,
  carriesLines,
  commitPatchName,
  copiedNote,
  exportedPastGate,
  exportFailed,
  exportFileName,
  fileListMarkdown,
  filePatchName,
  savedNote,
  statsLine,
} from "../../export/exportModel";
import { snapshotFor } from "../../export/snapshot";
import { patchBaseName } from "../../patch";
import { redactFindings } from "../../secrets";
import type { WorkerClient } from "../../workerClient";
import { ignoreStale } from "../helpers";
import { isViewed, selectSecretGate, selectSecrets, selectVisibleFiles } from "../selectors";
import { INITIAL_EXPORT, type StoreGet, type StoreSet, type StoreState } from "../types";

let toastSeq = 0;

export type ExportSlice = Pick<
  StoreState,
  | "toasts"
  | "export"
  | "addToast"
  | "dismissToast"
  | "setExportOpen"
  | "requestExport"
  | "confirmExport"
  | "cancelExport"
>;

export function createExportSlice(
  set: StoreSet,
  get: StoreGet,
  client: () => WorkerClient,
): ExportSlice {
  async function renderPatch(generation: number, ids: string[] | null): Promise<string> {
    const s = get();
    if (s.patchOnly) return s.patchSession.text;
    return client().patchText(generation, ids);
  }

  function exportName(s: StoreState): string {
    if (s.patchOnly) return patchBaseName(s.patchSession.name);
    return s.repo?.name ?? "repository";
  }

  return {
    toasts: [],
    export: INITIAL_EXPORT,

    addToast(toast) {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
      return id;
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    // ---- Export (T11.10, Design §14.6, atlas tab 12) ----

    setExportOpen(open) {
      const s = get();
      if (!open) {
        set({ export: { ...s.export, open: false, pending: null } });
        return;
      }
      if (!s.export.open) set({ export: { ...s.export, open: true } });
      const generation = s.diff?.generation ?? null;
      if (generation === null) return;
      // The scope is the current filter: `null` is the whole comparison, an array the rows the
      // sidebar and the pane are showing (Design §14.6 "this comparison · N files").
      const ids = s.filter.trim() === "" ? null : selectVisibleFiles(s).map((f) => f.id);
      const same =
        s.export.generation === generation &&
        (s.export.ids === null) === (ids === null) &&
        (ids === null || (s.export.ids as string[]).join("\u0000") === ids.join("\u0000"));
      if (same && (s.export.status === "ready" || s.export.status === "preparing")) return;
      set({
        export: { ...get().export, status: "preparing", error: null, generation, ids, patch: "" },
      });
      void (async () => {
        try {
          const patch = await renderPatch(generation, ids);
          const cur = get();
          if (cur.diff?.generation !== generation || cur.export.generation !== generation) return;
          const files = ids === null ? cur.diff.files : selectVisibleFiles(cur);
          const snapshot = snapshotFor({
            repo: exportName(cur),
            label: cur.diffSource ? labelOf(cur.diffSource) : "",
            at: Date.now(),
            patch,
            files,
            statsOf: (f) => cur.stats[f.id] ?? f.stats ?? null,
            viewedOf: (f) => isViewed(cur, f),
          });
          set({ export: { ...get().export, status: "ready", patch, snapshot } });
        } catch (e) {
          // A superseded render is normal (one `patchText` in flight per session); a real failure
          // is printed in the menu instead of leaving the sizes blank forever.
          ignoreStale(e);
          const err = toUiError(e);
          if (err.code === "STALE" || err.code === "CANCELLED") return;
          if (get().export.generation !== generation) return;
          set({ export: { ...get().export, status: "failed", error: err.message } });
        }
      })();
    },

    async requestExport(req) {
      const s = get();
      if (!s.diff || s.export.busy !== null) return;
      const generation = s.diff.generation;
      const gate = selectSecretGate(s);
      // `scanned: false` is *unknown*, not clean (contracts `<!-- T11.9 -->`): both it and a real
      // finding stop an export that would carry the lines.
      const clear = gate.scanned && gate.count === 0;
      if (carriesLines(req.kind) && !clear && s.export.confirmed !== generation) {
        set({ export: { ...s.export, open: true, pending: req } });
        return;
      }
      const repo = exportName(s);
      const label = s.diffSource ? labelOf(s.diffSource) : "";
      const at = Date.now();
      const scopeIds = s.filter.trim() === "" ? null : selectVisibleFiles(s).map((f) => f.id);
      const ids = req.ids === undefined ? scopeIds : req.ids;
      const statsOf = (f: FileDiff) => s.stats[f.id] ?? f.stats ?? null;
      const viewedOf = (f: FileDiff) => isViewed(s, f);
      const findings = selectSecrets(s);
      /** True when the menu already rendered exactly these rows of exactly this generation. */
      const prepared =
        s.export.status === "ready" &&
        s.export.generation === generation &&
        (s.export.ids === null) === (ids === null) &&
        (ids === null ||
          (s.export.ids as string[]).join("\u0000") === (ids as string[]).join("\u0000"));
      /** The prepared bytes when they cover exactly this request, a fresh render otherwise. */
      const patchFor = async (): Promise<string> =>
        prepared ? s.export.patch : await renderPatch(generation, ids);
      const tell = (ok: boolean, note: string) =>
        get().addToast(
          ok ? { level: "info", message: note } : { level: "warning", message: COPY_FAILED },
        );
      set({ export: { ...s.export, busy: req.kind, pending: null } });
      try {
        switch (req.kind) {
          case "copy-list": {
            // Text diffgit writes *about* the diff, so Design §14.3's "masked everywhere including
            // copy" applies; the patch and the snapshot below are the user's own lines verbatim,
            // because a masked patch is one `git apply` rejects.
            const list = fileListMarkdown(selectVisibleFiles(s), statsOf, viewedOf);
            tell(await copyText(redactFindings(list, findings)), copiedNote(req.kind));
            break;
          }
          case "copy-stats": {
            const line = statsLine(selectVisibleFiles(s), statsOf);
            tell(await copyText(redactFindings(line, findings)), copiedNote(req.kind));
            break;
          }
          case "copy-patch": {
            tell(await copyText(await patchFor()), copiedNote(req.kind));
            break;
          }
          case "save-patch":
          case "file-patch":
          case "commit-patch": {
            const file =
              req.kind === "file-patch"
                ? s.diff.files.find((f) => f.id === (ids?.[0] ?? ""))
                : undefined;
            const name =
              req.kind === "commit-patch" && req.oid !== undefined
                ? commitPatchName(repo, req.oid, at)
                : file
                  ? filePatchName(repo, file.newPath ?? file.oldPath ?? file.id, at)
                  : exportFileName(repo, label, "patch", at);
            const saved = downloadText(name, await patchFor(), PATCH_MIME);
            tell(saved, savedNote(name));
            break;
          }
          case "snapshot": {
            const patch = await patchFor();
            const files = ids === null ? s.diff.files : selectVisibleFiles(s);
            const html =
              prepared && s.export.snapshot !== "" && clear
                ? s.export.snapshot
                : snapshotFor({
                    repo,
                    label,
                    at,
                    patch,
                    files,
                    statsOf,
                    viewedOf,
                    ...(clear ? {} : { warning: exportedPastGate(gate) }),
                  });
            const name = exportFileName(repo, label, "html", at);
            tell(downloadText(name, html, HTML_MIME), savedNote(name));
            break;
          }
        }
      } catch (e) {
        ignoreStale(e);
        const err = toUiError(e);
        if (err.code !== "STALE" && err.code !== "CANCELLED")
          get().addToast({ level: "warning", message: exportFailed(err.message) });
      } finally {
        set({ export: { ...get().export, busy: null } });
      }
    },

    async confirmExport() {
      const s = get();
      if (!s.diff) return;
      const req = s.export.pending;
      // With no parked request this is the menu's own `Export anyway` link, which unlocks the three
      // line-carrying rows for this generation; with one, it also runs it.
      set({ export: { ...s.export, pending: null, confirmed: s.diff.generation } });
      if (req) await get().requestExport(req);
    },

    cancelExport() {
      set({ export: { ...get().export, pending: null } });
    },
  };
}
