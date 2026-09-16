import { useState } from "react";
import type { FileDiffPayload } from "../../engine/api";
import type { FileDiff } from "../../engine/types";
import { formatBytes } from "../format";
import { useStore } from "../store";
import { Notice } from "./Notice";

/** "View as text" is offered below this size (Design §7.7). */
export const VIEW_AS_TEXT_LIMIT = 1024 * 1024;

export function sizesLabel(oldSize: number, newSize: number, status: FileDiff["status"]): string {
  if (status === "added") return formatBytes(newSize);
  if (status === "deleted") return formatBytes(oldSize);
  return `${formatBytes(oldSize)} → ${formatBytes(newSize)}`;
}

/** "Binary file not shown" + sizes + `View as text` escape hatch for small files. */
export function BinaryNotice({ file, payload }: { file: FileDiff; payload: FileDiffPayload }) {
  const fileBytes = useStore((s) => s.fileBytes);
  const { oldSize, newSize } = payload.classification;
  const canView = Math.max(oldSize, newSize) < VIEW_AS_TEXT_LIMIT;
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const side = file.status === "deleted" ? "old" : "new";

  const view = async () => {
    setBusy(true);
    try {
      const bytes = await fileBytes(file.id, side);
      setText(bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : "");
    } catch {
      setText("");
    } finally {
      setBusy(false);
    }
  };

  if (text !== null) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2 text-xs text-muted">
          {side === "old" ? "Old" : "New"} content decoded as UTF-8
          <button type="button" className="btn btn-sm ml-auto" onClick={() => setText(null)}>
            Hide
          </button>
        </div>
        <pre className="max-h-[480px] overflow-auto rounded-[6px] border border-line bg-bg p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-ink">
          {text === "" ? "(empty)" : text}
        </pre>
      </div>
    );
  }
  return (
    <Notice
      detail={sizesLabel(oldSize, newSize, file.status)}
      action={
        canView ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void view()}>
            View as text
          </button>
        ) : undefined
      }
    >
      Binary file not shown
    </Notice>
  );
}
