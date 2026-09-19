import { useEffect, useState } from "react";
import type { Oid } from "../../engine/types";
import { openSubmodule, probeSubmodule, type SubmoduleOpenability } from "../openRepo";
import { selectSubmodule, useStore } from "../store";
import {
  CHECKED_OUT_LABEL,
  DIRTY_NOTE,
  NO_FOLDER_NOTE,
  NO_URL,
  OPEN_LABEL,
  OPEN_LABEL_ROW,
  OPEN_TITLE,
  pointerLine,
  RECORDED_LABEL,
  SYNC_LABEL,
  SYNC_TITLE,
  shortSubmoduleOid,
  syncOf,
  URL_LABEL,
  URL_SOURCE_NOTE,
} from "../submodules";
import { KeyValue, KeyValueRow } from "./KeyValue";

/** `in sync` / `drifted` / `not checked out`, in the §3.3 chip palettes (Design §14.3). */
function SyncTag({ sync }: { sync: ReturnType<typeof syncOf> }) {
  const tone =
    sync === "in-sync"
      ? "border-chip-staged-fg/40 bg-chip-staged-bg text-chip-staged-fg"
      : sync === "drifted"
        ? "border-chip-unstaged-fg/40 bg-chip-unstaged-bg text-chip-unstaged-fg"
        : "border-chip-generated-fg/40 bg-chip-generated-bg text-chip-generated-fg";
  return (
    <span
      className={`inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 font-sans text-[11px] leading-4 font-medium ${tone}`}
      title={SYNC_TITLE[sync]}
    >
      {SYNC_LABEL[sync]}
    </span>
  );
}

/**
 * The body of a gitlink card (T11.16, Design §14.3, atlas tab 19). It replaces the one-line
 * `Subproject commit a → b` notice v1 showed, and adds the three things `git submodule status`
 * knows that the pointer alone does not: what is actually checked out under the folder the user
 * picked, where the submodule came from, and whether it can be opened on its own.
 *
 * The extra facts come from `listSubmodules()`, read once per repository. Until it answers — and
 * for a gitlink the superproject's HEAD does not record, which `git submodule status` does not
 * list either — the card is exactly the pointer line, never a claim it cannot back.
 */
export function SubmoduleCard({
  path,
  oldOid,
  newOid,
}: {
  path: string;
  oldOid: Oid | null | undefined;
  newOid: Oid | null | undefined;
}) {
  const info = useStore((s) => selectSubmodule(s, path));
  const loadSubmodules = useStore((s) => s.loadSubmodules);
  const listed = useStore((s) => s.submodules !== null);
  const [probe, setProbe] = useState<SubmoduleOpenability | null>(null);

  useEffect(() => {
    void loadSubmodules();
  }, [loadSubmodules]);

  // One read inside the granted folder, so the card offers the action only where it can work and
  // says why where it cannot — rather than sending the user to a "Linked worktree" error screen.
  useEffect(() => {
    let live = true;
    if (info && info.checkedOut === null) {
      setProbe({ kind: "gitdir-outside", note: NO_FOLDER_NOTE });
      return;
    }
    void probeSubmodule(path).then((p) => {
      if (live) setProbe(p);
    });
    return () => {
      live = false;
    };
  }, [path, info]);

  const sync = info ? syncOf(info) : null;
  return (
    <>
      <KeyValue kind="submodule">
        <KeyValueRow label={RECORDED_LABEL}>
          <span className="font-mono">{pointerLine(oldOid ?? null, newOid ?? null)}</span>
        </KeyValueRow>
        {info && sync && (
          <KeyValueRow label={CHECKED_OUT_LABEL}>
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono">{shortSubmoduleOid(info.checkedOut)}</span>
              <SyncTag sync={sync} />
            </span>
          </KeyValueRow>
        )}
        {info && (
          <KeyValueRow label={URL_LABEL}>
            {info.url === null ? (
              <span className="text-muted">{NO_URL}</span>
            ) : (
              <>
                <span className="font-mono break-all">{info.url}</span>{" "}
                <span className="text-muted">({URL_SOURCE_NOTE})</span>
              </>
            )}
          </KeyValueRow>
        )}
        <KeyValueRow label={OPEN_LABEL_ROW}>
          {probe === null ? (
            <span className="text-muted">…</span>
          ) : probe.kind === "openable" ? (
            <button
              type="button"
              className="btn btn-sm"
              title={OPEN_TITLE}
              onClick={() => void openSubmodule(path)}
            >
              {OPEN_LABEL}
            </button>
          ) : (
            <span className="text-muted">{probe.note}</span>
          )}
        </KeyValueRow>
      </KeyValue>
      {listed && info && (
        <p className="px-3 pb-3 text-[11.5px] leading-5 text-muted">{DIRTY_NOTE}</p>
      )}
    </>
  );
}
