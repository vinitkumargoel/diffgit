import { useStore } from "../store";

/** Placeholder until T5.1–T5.6 build the repo screen. Default export: React lazy chunk. */
export default function RepoScreen() {
  const repo = useStore((s) => s.repo);
  const diff = useStore((s) => s.diff);
  const closeRepo = useStore((s) => s.closeRepo);
  return (
    <main className="flex h-dvh flex-col bg-bg text-ink">
      <header className="flex h-11 items-center gap-3 border-b border-line bg-surface px-4 text-sm font-semibold">
        {repo?.name}
        <span className="text-muted font-normal">
          {diff ? `${diff.files.length} files changed` : ""}
        </span>
        <button type="button" className="btn ml-auto" onClick={() => void closeRepo()}>
          Close
        </button>
      </header>
    </main>
  );
}
