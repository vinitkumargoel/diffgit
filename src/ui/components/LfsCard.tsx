import { useEffect, useState } from "react";
import type { FileDiffPayload } from "../../engine/api";
import { type LfsPointer, parseLfsPointer } from "../../engine/diff/lfs";
import type { FileDiff } from "../../engine/types";
import {
  CONTENT_LABEL,
  canBePointer,
  NOT_FETCHED,
  OBJECT_LABEL,
  ONE_SIDE_NOTE,
  objectLine,
  SIZE_LABEL,
  sizeLine,
  UNREADABLE_NOTE,
} from "../lfs";
import { useStore } from "../store";
import { KeyValue, KeyValueRow } from "./KeyValue";

interface Sides {
  old: LfsPointer | null;
  new: LfsPointer | null;
  failed: boolean;
}

/**
 * Both pointers, read out of the **local** object database.
 *
 * `FileClassification.lfs` carries one pointer — the new side wins
 * (`docs/v2-contracts.md` `<!-- T10.12 -->`) — and `FileDiffPayload.oldText`/`newText` are null for
 * a row `.gitattributes` marks binary, which is what a real `git lfs track` line produces. So the
 * card reads each side itself through the same `fileBytes` path `BinaryNotice`'s "View as text"
 * uses, and only where that side's blob is small enough to be a pointer at all (1 KiB, the LFS
 * spec's own cap). No LFS object is ever named to anything outside this machine.
 */
function useLfsSides(file: FileDiff, payload: FileDiffPayload): Sides {
  const fileBytes = useStore((s) => s.fileBytes);
  const { classification: c } = payload;
  const [sides, setSides] = useState<Sides>({ old: null, new: null, failed: false });

  useEffect(() => {
    let live = true;
    const read = async (side: "old" | "new", size: number): Promise<LfsPointer | null> => {
      if (!canBePointer(size)) return null;
      return parseLfsPointer(await fileBytes(file.id, side));
    };
    void (async () => {
      try {
        const oldP = (await read("old", c.oldSize)) ?? parseTextSide(payload.oldText);
        const newP = (await read("new", c.newSize)) ?? parseTextSide(payload.newText);
        if (live) setSides({ old: oldP, new: newP, failed: false });
      } catch {
        // STALE / CANCELLED / a read error: fall back to the one pointer the classification
        // carries, which is always enough to say what this file points at now.
        if (live) setSides({ old: null, new: c.lfs ?? null, failed: true });
      }
    })();
    return () => {
      live = false;
    };
  }, [file.id, payload, c, fileBytes]);

  // Until the reads answer, the classification's own pointer is what the card shows.
  if (sides.old === null && sides.new === null && !sides.failed) {
    return { old: null, new: c.lfs ?? null, failed: false };
  }
  return sides;
}

function parseTextSide(text: string | null): LfsPointer | null {
  if (text === null) return null;
  return parseLfsPointer(new TextEncoder().encode(text));
}

/**
 * The body of a Git LFS row (T11.16, Design §14.3, atlas tab 19): the object the pointer names,
 * the size it claims, and the one sentence that matters — the bytes are not here and diffgit will
 * not go and get them. It replaces three lines of raw pointer text, which is all git stores.
 */
export function LfsCard({ file, payload }: { file: FileDiff; payload: FileDiffPayload }) {
  const sides = useLfsSides(file, payload);
  // Only a note when the *file* has two sides but only one of them parsed as a pointer; an added
  // or deleted row has one side by construction and says so in its status, not here.
  const twoSided = file.oldOid !== null && file.newOid !== null;
  const oneSided = twoSided && (sides.old === null) !== (sides.new === null);
  return (
    <>
      <KeyValue kind="lfs">
        <KeyValueRow label={OBJECT_LABEL}>
          <span
            className="font-mono break-all"
            title={[sides.old?.oid, sides.new?.oid].filter(Boolean).join(" → ")}
          >
            {objectLine(sides.old, sides.new)}
          </span>
        </KeyValueRow>
        <KeyValueRow label={SIZE_LABEL}>
          <span className="tabular-nums">{sizeLine(sides.old, sides.new)}</span>
        </KeyValueRow>
        <KeyValueRow label={CONTENT_LABEL}>
          <span>{NOT_FETCHED}</span>
        </KeyValueRow>
      </KeyValue>
      {(oneSided || sides.failed) && (
        <p className="px-3 pb-3 text-[11.5px] leading-5 text-muted">
          {sides.failed ? UNREADABLE_NOTE : ONE_SIDE_NOTE}
        </p>
      )}
    </>
  );
}
