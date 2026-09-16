import { BookBookmark, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ensurePermission,
  listRepos,
  removeRepo,
  type StoredRepo,
  upsertRepo,
} from "../persistence";
import { useStore } from "../store";
import { PRIVACY_LINE } from "./BrowserGate";
import { CenteredColumn } from "./CenteredColumn";
import { RecentRepoList } from "./RecentRepoList";

type Picker = (opts: { mode: "read"; id?: string }) => Promise<FileSystemDirectoryHandle>;

function picker(): Picker | null {
  const w = window as unknown as { showDirectoryPicker?: Picker };
  return typeof w.showDirectoryPicker === "function" ? w.showDirectoryPicker.bind(window) : null;
}

function isAbort(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/** Design §7.8 HomeScreen: logo + name, privacy paragraph, primary "Open repository", recents. */
export function HomeScreen() {
  const openRepo = useStore((s) => s.openRepo);
  const addToast = useStore((s) => s.addToast);
  const [recents, setRecents] = useState<StoredRepo[]>([]);

  const refresh = useCallback(async () => setRecents(await listRepos()), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openPicker = useCallback(async () => {
    const pick = picker();
    if (!pick) return;
    try {
      // D16: read-only access, always.
      const handle = await pick({ mode: "read", id: "diffgoel-repo" });
      const stored = await upsertRepo(handle);
      await openRepo(handle, {
        id: stored.id,
        lastSource: stored.lastSource,
        lastTarget: stored.lastTarget,
      });
    } catch (e) {
      if (isAbort(e)) return; // user cancelled the picker
      addToast({
        level: "error",
        message: `Couldn't open the folder: ${String((e as Error)?.message ?? e)}`,
      });
    }
  }, [openRepo, addToast]);

  // `o` opens the picker while on Home (T4.4 AC); T5.6 centralises shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "o" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void openPicker();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPicker]);

  async function openRecent(repo: StoredRepo): Promise<"granted" | "denied"> {
    const result = await ensurePermission(repo.handle);
    if (result === "denied") return result;
    await openRepo(repo.handle, {
      id: repo.id,
      lastSource: repo.lastSource,
      lastTarget: repo.lastTarget,
    });
    return result;
  }

  async function remove(repo: StoredRepo) {
    await removeRepo(repo.id);
    await refresh();
  }

  return (
    <CenteredColumn label="Open a repository">
      <div className="flex flex-col items-center gap-3">
        <BookBookmark size={32} className="text-accent" aria-hidden="true" />
        <h1 className="text-2xl font-semibold leading-8">diffgoel</h1>
      </div>
      <p className="text-muted">
        Pick a local git repository and read a GitHub-style diff of what a branch adds on top of
        another, including your uncommitted work. {PRIVACY_LINE}
      </p>
      <button type="button" className="btn btn-primary" onClick={() => void openPicker()}>
        <FolderOpen size={16} aria-hidden="true" />
        Open repository
      </button>
      <RecentRepoList repos={recents} onOpen={openRecent} onRemove={(r) => void remove(r)} />
      <p className="text-xs text-muted">
        Press{" "}
        <kbd className="rounded-[3px] border border-line bg-bg px-1 font-mono text-[11px]">o</kbd>{" "}
        to open a repository
      </p>
    </CenteredColumn>
  );
}
