import { type SyntheticEvent, useEffect, useState } from "react";
import type { FileDiffPayload } from "../../engine/api";
import type { FileDiff } from "../../engine/types";
import { formatBytes } from "../format";
import { useStore } from "../store";
import { Notice } from "./Notice";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

type Side = "old" | "new";
type Bytes = Promise<Uint8Array | null>;
interface PaneState {
  url: string | null;
  error: boolean;
  width: number | null;
  height: number | null;
}
const EMPTY: PaneState = { url: null, error: false, width: null, height: null };

function ImagePane({
  side,
  path,
  size,
  bytes,
}: {
  side: Side;
  path: string;
  size: number;
  bytes: Bytes;
}) {
  const [state, setState] = useState<PaneState>(EMPTY);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    setState(EMPTY);
    bytes
      .then((data) => {
        if (!alive) return;
        if (!data) {
          setState({ ...EMPTY, error: true });
          return;
        }
        // SVG and everything else go through <img>: never inlined, so embedded scripts cannot run.
        url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeFor(path) }));
        setState({ ...EMPTY, url });
      })
      .catch(() => {
        if (alive) setState({ ...EMPTY, error: true });
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bytes, path]);

  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    setState((s) => ({ ...s, width: naturalWidth, height: naturalHeight }));
  };

  const border = side === "old" ? "border-diff-del-num" : "border-diff-add-num";
  const label = side === "old" ? "Old" : "New";
  return (
    <figure className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <div
        className={`checkerboard flex w-full items-center justify-center rounded-[6px] border p-2 ${border}`}
      >
        {state.url ? (
          <img
            src={state.url}
            alt={`${label} version of ${path}`}
            className="max-h-[480px] max-w-full object-contain"
            onLoad={onLoad}
            onError={() => setState((s) => ({ ...s, error: true }))}
          />
        ) : (
          <span className="py-8 text-xs text-muted">
            {state.error ? "Image unavailable" : "Loading image…"}
          </span>
        )}
      </div>
      <figcaption className="text-xs text-muted tabular-nums">
        {label}
        {state.width !== null && state.height !== null ? ` · ${state.width} × ${state.height}` : ""}
        {` · ${formatBytes(size)}`}
      </figcaption>
    </figure>
  );
}

/**
 * Side-by-side image comparison (Design §7.7); single pane for added / deleted files.
 * Mount with `key={payload.generation}` so a recompute fetches fresh bytes.
 */
export function ImageDiff({ file, payload }: { file: FileDiff; payload: FileDiffPayload }) {
  const fileBytes = useStore((s) => s.fileBytes);
  const showOld = file.oldOid !== null && file.status !== "added";
  const showNew = (file.newOid !== null || file.newPath !== null) && file.status !== "deleted";
  // one request per side; panes create and revoke their own blob URLs
  const [requests, setRequests] = useState<{ old: Bytes; new: Bytes } | null>(null);
  useEffect(() => {
    setRequests({
      old: showOld ? fileBytes(file.id, "old") : Promise.resolve(null),
      new: showNew ? fileBytes(file.id, "new") : Promise.resolve(null),
    });
  }, [fileBytes, file.id, showOld, showNew]);
  if (!requests) return null;
  if (!showOld && !showNew) return <Notice>Image unavailable</Notice>;
  return (
    <div className="flex gap-4 p-4">
      {showOld && (
        <ImagePane
          side="old"
          path={file.oldPath ?? file.id}
          size={payload.classification.oldSize}
          bytes={requests.old}
        />
      )}
      {showNew && (
        <ImagePane
          side="new"
          path={file.newPath ?? file.id}
          size={payload.classification.newSize}
          bytes={requests.new}
        />
      )}
    </div>
  );
}
