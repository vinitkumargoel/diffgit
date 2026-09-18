import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useShortcuts } from "../hooks/useShortcuts";
import {
  ensurePermission,
  listRepos,
  removeRepo,
  type StoredRepo,
  upsertRepo,
} from "../persistence";
import { useStore } from "../store";
import { Logo } from "./Logo";
import { RecentRepoList } from "./RecentRepoList";

type Picker = (opts: { mode: "read"; id?: string }) => Promise<FileSystemDirectoryHandle>;

function picker(): Picker | null {
  const w = window as unknown as { showDirectoryPicker?: Picker };
  return typeof w.showDirectoryPicker === "function" ? w.showDirectoryPicker.bind(window) : null;
}

function isAbort(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/** Hairline label/value list under the CTA. Every value is a fact from README.md, not a claim. */
const FACTS: { label: string; value: string; good?: boolean }[] = [
  { label: "Uploaded", value: "nothing, ever", good: true },
  { label: "Written to disk", value: "nothing, read-only", good: true },
  { label: "Kept in this browser", value: "recent folders, prefs" },
  { label: "Diff range", value: "base...compare" },
  { label: "License", value: "MIT" },
];

/**
 * Design §7.8 HomeScreen, "Precision" direction: brand lockup, eyebrow, headline, lede,
 * the "Open repository" CTA with its `o` hint, a hairline facts list, recents and the
 * browser-support line.
 */
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
      const handle = await pick({ mode: "read", id: "diffgit-repo" });
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

  // `o` opens the picker while on Home (T4.4 AC)
  useShortcuts({ o: () => void openPicker() });

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
    <main
      aria-label="Open a repository"
      className="flex min-h-full justify-center overflow-y-auto bg-bg px-5 py-10 text-[13px] leading-5 text-ink sm:px-8 sm:py-14"
    >
      <div className="my-auto w-full max-w-[640px]">
        <div className="flex items-center gap-2.5">
          <Logo size={28} />
          <span className="text-[17px] font-semibold leading-6 tracking-[-0.01em]">
            diff<span className="text-success">git</span>
          </span>
        </div>

        <p className="mt-8 flex items-center gap-2 font-mono text-[11px] leading-4 text-muted">
          <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-success" />
          local · read-only · no network
        </p>

        <h1 className="mt-3 max-w-[17ch] text-[30px] font-medium leading-[1.06] tracking-[-0.032em] sm:text-[36px]">
          Everything your branch changes,{" "}
          <em className="not-italic text-success">including what you haven't committed.</em>
        </h1>

        <p className="mt-4 max-w-[54ch] text-[14px] leading-[22px] text-muted">
          Open a repository on your disk and read{" "}
          <span className="font-mono text-[13px] text-ink">base...compare</span> the way a pull
          request shows it, with your staged, unstaged and untracked work layered on top.{" "}
          <span className="font-medium text-ink">
            Nothing is uploaded and nothing is written to disk.
          </span>
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            className="btn rounded-[8px] border-ink bg-ink px-4 py-2.5 text-[14px] leading-5 text-bg hover:bg-ink hover:opacity-90"
            onClick={() => void openPicker()}
          >
            <FolderOpen size={16} aria-hidden="true" />
            Open repository
          </button>
          <span className="text-xs text-muted">
            Press <kbd className="kbd">o</kbd>
          </span>
        </div>

        <dl className="mt-9 border-t border-line-subtle">
          {FACTS.map((fact) => (
            <div
              key={fact.label}
              className="flex items-baseline justify-between gap-4 border-b border-line-subtle py-2"
            >
              <dt className="text-muted">{fact.label}</dt>
              <dd
                className={`m-0 truncate font-mono text-[12px] ${fact.good ? "text-success" : "text-ink"}`}
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>

        {recents.length > 0 && (
          <div className="mt-9">
            <RecentRepoList repos={recents} onOpen={openRecent} onRemove={(r) => void remove(r)} />
          </div>
        )}

        <p className="mt-9 text-xs leading-[18px] text-muted">
          Works in Chrome, Edge, Brave and Arc on the desktop — the browsers that can open a local
          folder. Firefox and Safari cannot.
        </p>
      </div>
    </main>
  );
}
