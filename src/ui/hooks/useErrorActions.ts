import { useState } from "react";
import { describeError, errorReport, type UiError } from "../errors";
import { ensurePermission, removeRepo } from "../persistence";
import { useStore } from "../store";

/**
 * The actions every failure screen offers (Design §7.8, review E1/L4): retry re-opens the same
 * handle with the remembered branch pair, "choose another folder" returns Home, "grant access"
 * re-asks for read permission, "forget" drops the repo from Recent, "copy report" puts a plain-text
 * bug report on the clipboard. Shared by ErrorScreen and the LoadingScreen failure state.
 */
export function useErrorActions() {
  const error = useStore((s) => s.error);
  const handle = useStore((s) => s.handle);
  const repoId = useStore((s) => s.repoId);
  const repoName = useStore(
    (s) => s.repo?.name ?? (s.handle as { name?: string } | null)?.name ?? null,
  );
  const diffSource = useStore((s) => s.diffSource);
  const closeRepo = useStore((s) => s.closeRepo);
  const openRepo = useStore((s) => s.openRepo);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const canReopen = handle !== null && handle !== undefined;
  const description = describeError(error?.code);

  const reopen = async (opts: { skipWorktree?: boolean; defaults?: boolean } = {}) => {
    if (!canReopen) return void closeRepo();
    setBusy(true);
    try {
      await openRepo(handle, {
        ...(repoId ? { id: repoId } : {}),
        ...(diffSource && !opts.defaults
          ? { lastSource: diffSource.sourceRef, lastTarget: diffSource.targetRef }
          : {}),
        ...(opts.skipWorktree ? { skipWorktree: true } : {}),
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

  const copyReport = async () => {
    const text = errorReport(error, repoName ? { repo: repoName } : {});
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied("done");
    } catch {
      setCopied("failed"); // shown on the button; the details block stays selectable
    }
    setTimeout(() => setCopied("idle"), 1500);
  };

  return {
    error: error as UiError | null,
    description,
    repoId,
    repoName,
    busy,
    denied,
    copied,
    canReopen,
    reopen,
    regrant,
    forget,
    copyReport,
    chooseFolder: () => void closeRepo(),
  };
}
