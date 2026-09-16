import { CircleX } from "lucide-react";
import { useState } from "react";
import { describeError } from "../errors";
import { ensurePermission, removeRepo } from "../persistence";
import { useStore } from "../store";
import { CenteredColumn } from "./CenteredColumn";

/**
 * Design §7.8 / T5.5: title + hint from `describeError`, actions per its `action`:
 * choose another folder (→ Home), retry (re-open the same handle), re-grant permission.
 * `HANDLE_GONE` also offers "Forget this repo". Default export: lazy chunk.
 */
export default function ErrorScreen() {
  const error = useStore((s) => s.error);
  const handle = useStore((s) => s.handle);
  const repoId = useStore((s) => s.repoId);
  const diffSource = useStore((s) => s.diffSource);
  const closeRepo = useStore((s) => s.closeRepo);
  const openRepo = useStore((s) => s.openRepo);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = describeError(error?.code);
  const canReopen = handle !== null && handle !== undefined;

  const reopen = async () => {
    if (!canReopen) return void closeRepo();
    setBusy(true);
    try {
      await openRepo(handle, {
        ...(repoId ? { id: repoId } : {}),
        ...(diffSource
          ? { lastSource: diffSource.sourceRef, lastTarget: diffSource.targetRef }
          : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  const regrant = async () => {
    if (!canReopen) return void closeRepo();
    setBusy(true);
    try {
      const result = await ensurePermission(handle as FileSystemDirectoryHandle);
      if (result === "denied") {
        setDenied(true);
        return;
      }
      setDenied(false);
      await reopen();
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (repoId) await removeRepo(repoId);
    await closeRepo();
  };

  const chooseFolder = (
    <button type="button" className="btn" onClick={() => void closeRepo()}>
      Choose another folder
    </button>
  );

  let actions: React.ReactNode;
  switch (d.action) {
    case "retry":
      actions = (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void reopen()}
          >
            Retry
          </button>
          {chooseFolder}
        </>
      );
      break;
    case "reopen-permission":
      actions = (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void regrant()}
          >
            Grant access
          </button>
          {chooseFolder}
        </>
      );
      break;
    case "choose-folder":
      actions = (
        <>
          <button type="button" className="btn btn-primary" onClick={() => void closeRepo()}>
            Choose another folder
          </button>
          {error?.code === "HANDLE_GONE" && repoId && (
            <button type="button" className="btn" onClick={() => void forget()}>
              Forget this repo
            </button>
          )}
        </>
      );
      break;
    default:
      actions = (
        <button type="button" className="btn btn-primary" onClick={() => void closeRepo()}>
          Back to start
        </button>
      );
  }

  return (
    <CenteredColumn label="Error">
      <CircleX size={32} className="text-danger" aria-hidden="true" />
      <h1 className="text-2xl font-semibold leading-8">{d.title}</h1>
      <p className="text-muted">{d.message}</p>
      {error?.hint && <p className="text-muted">{error.hint}</p>}
      {denied && (
        <p className="text-danger" role="alert">
          Permission denied. Try again, or choose another folder.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>
      {error?.message && error.message !== d.message && (
        <details className="w-full text-left text-xs text-muted">
          <summary className="cursor-pointer select-none text-center">Details</summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded-[6px] border border-line bg-surface p-3 font-mono whitespace-pre-wrap break-all">
            {error.message}
          </pre>
        </details>
      )}
    </CenteredColumn>
  );
}
