import { FolderOpen, LoaderCircle, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import {
  SNAPSHOT_ENTRY_LIMIT,
  type SnapshotInputFile,
  type SnapshotProgress,
  SnapshotTooLargeError,
} from "../fs/memoryDirHandle";
import { openRepoOnce } from "../openRepo";
import { BTN, BTN_INK, CARD, CARD_TITLE } from "./gate.styles";

const num = (n: number) => n.toLocaleString("en-US");
const mb = (bytes: number) => `${Math.round(bytes / 1048576).toLocaleString("en-US")} MB`;

/**
 * The read-once offer: one `<input type="file" webkitdirectory>` behind a button, a counter while the
 * list is walked, and the refusal with advice when the folder is too big for this to work at all.
 * The Chromium recommendation above it stays where it is (atlas risk 2: snapshot mode must not look
 * like the product).
 */
export function ReadOnceCard({ name }: { name: string }) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SnapshotProgress | null>(null);
  const [failure, setFailure] = useState<{ message: string; advice: string | null } | null>(null);
  const [showDifferences, setShowDifferences] = useState(false);

  const start = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files: SnapshotInputFile[] = Array.from(list);
    setBusy(true);
    setFailure(null);
    setProgress({ entries: 0, total: files.length, bytes: 0 });
    try {
      await openRepoOnce(files, setProgress);
    } catch (e) {
      setProgress(null);
      setFailure(
        e instanceof SnapshotTooLargeError
          ? { message: e.message, advice: e.advice }
          : {
              message: `${name} could not hand the folder over${e instanceof Error && e.message !== "" ? `: ${e.message}` : "."}`,
              advice: null,
            },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${CARD} mt-[26px] max-w-[52ch]`}>
      <div className={CARD_TITLE}>Read it once instead</div>
      <p className="m-0 mb-3 text-[14px] leading-6 text-muted">
        {`${name} does not let a page keep access to a folder, so diffgit reads it a single time. You get the full diff; you do not get live refresh, recent repositories, or files over 1 MB. Chrome, Edge, Brave or Arc give you everything.`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id={inputId}
          type="file"
          multiple
          disabled={busy}
          className="peer sr-only"
          ref={(el) => {
            // `webkitdirectory` is not in the React attribute types; the property is the one the
            // browsers actually read, and setting it here keeps the input a plain controlled node.
            if (el) el.webkitdirectory = true;
          }}
          onChange={(e) => void start(e.currentTarget.files)}
        />
        <label
          htmlFor={inputId}
          className={`${BTN_INK} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${busy ? "pointer-events-none opacity-60" : ""}`}
        >
          {busy ? (
            <LoaderCircle size={15} aria-hidden="true" className="spin shrink-0" />
          ) : (
            <FolderOpen size={15} aria-hidden="true" className="shrink-0" />
          )}
          Open a repository once
        </label>
        <button
          type="button"
          className={BTN}
          aria-expanded={showDifferences}
          onClick={() => setShowDifferences((v) => !v)}
        >
          What is different in snapshot mode
        </button>
      </div>

      {showDifferences && (
        <ul className="m-0 mt-3.5 list-none border-t border-line-subtle p-0 text-[13px] text-muted">
          {[
            "The diff never refreshes itself — re-open the folder to see newer changes.",
            "The repository is not remembered: there is nothing to put in Recent.",
            "Only the files the diff needs are read; everything else is listed, never opened.",
            `Small repositories only: a folder over ${num(SNAPSHOT_ENTRY_LIMIT)} entries is refused.`,
          ].map((line) => (
            <li key={line} className="border-b border-line-subtle py-[7px] leading-5">
              {line}
            </li>
          ))}
        </ul>
      )}

      {progress && (
        <div className="mt-3.5 border-t border-line-subtle pt-3">
          <p role="status" className="m-0 font-mono text-[12.5px] text-ink">
            {`Reading ${num(progress.entries)} of ${num(progress.total)} files · ${mb(progress.bytes)}`}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <span
              className="block h-full bg-accent"
              style={{
                width: `${progress.total === 0 ? 0 : Math.round((progress.entries / progress.total) * 100)}%`,
              }}
            />
          </div>
          <p className="m-0 mt-2 text-[12.5px] text-muted">
            {`${name} lists the whole folder before diffgit sees it; a big folder takes a while.`}
          </p>
        </div>
      )}

      {failure && (
        <div
          role="alert"
          className="mt-3.5 flex gap-2 border-t border-line-subtle pt-3 text-[13px] leading-5"
        >
          <TriangleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-attention" />
          <p className="m-0">
            {failure.message}
            {failure.advice && <span className="block text-muted">{failure.advice}</span>}
          </p>
        </div>
      )}
    </div>
  );
}
