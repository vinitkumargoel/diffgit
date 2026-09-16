import type { DiffResult, FileDiff, FileStatus, RepoInfo } from "../../engine/types";

const STATUSES: FileStatus[] = [
  "modified",
  "modified",
  "added",
  "deleted",
  "renamed",
  "modified",
  "typechange",
];
const AREAS = ["core", "ui", "util", "test"];

function oid(i: number, salt: string): string {
  return `${salt}${i.toString(16)}`.padStart(40, "0");
}

/**
 * A deterministic 5,000-file `DiffResult` (Plan §6.7 "> 1000 changed files") derived from a
 * recorded repo, for the mock engine's `large` handle name. Used by the sidebar virtualisation
 * check (T5.2) and the diff pane's virtualiser (T5.3). Sorted by path like the engine.
 */
export function syntheticLarge(
  base: { info: RepoInfo; diff: DiffResult },
  count = 5000,
): { info: RepoInfo; diff: DiffResult } {
  const files: FileDiff[] = [];
  for (let i = 0; i < count; i++) {
    const dir = `packages/pkg-${String(i % 40).padStart(2, "0")}/src/${AREAS[i % 4]}`;
    const path = `${dir}/module-${String(i).padStart(4, "0")}.ts`;
    const status = STATUSES[i % STATUSES.length] ?? "modified";
    const additions = (i * 7) % 120;
    const deletions = (i * 3) % 60;
    const binary = i % 50 === 0;
    files.push({
      id: path,
      oldPath:
        status === "added" ? null : status === "renamed" ? path.replace(/\.ts$/, ".old.ts") : path,
      newPath: status === "deleted" ? null : path,
      status,
      layers: i % 9 === 0 ? ["unstaged"] : i % 17 === 0 ? ["staged"] : ["committed"],
      ...(status === "renamed" ? { similarity: 80 } : {}),
      oldOid: status === "added" ? null : oid(i, "a"),
      newOid: status === "deleted" ? null : oid(i, "b"),
      oldMode: status === "added" ? null : 0o100644,
      newMode: status === "deleted" ? null : status === "typechange" ? 0o120000 : 0o100644,
      binary,
      image: false,
      oldSize: 1000 + i,
      newSize: 1000 + i + additions - deletions,
      stats: binary ? null : { additions, deletions },
      tooLarge: false,
      ...(i % 97 === 0 ? { generated: true } : {}),
    });
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const totals = files.reduce(
    (t, f) => ({
      files: t.files + 1,
      additions: t.additions + (f.stats?.additions ?? 0),
      deletions: t.deletions + (f.stats?.deletions ?? 0),
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
  return {
    info: { ...base.info, id: "mock-large", name: "large" },
    diff: { ...base.diff, files, totals, warnings: [] },
  };
}
