import { CircleX, FileQuestion, Scale } from "lucide-react";
import { useEffect, useMemo } from "react";
import type {
  ConflictMarker,
  ConflictPayload,
  FileDiffPayload,
  HunkModel,
  SideBlob,
} from "../../engine/api";
import type { FileDiff } from "../../engine/types";
import { describeError } from "../errors";
import { formatBytes } from "../format";
import { conflictCommand, short } from "../operation";
import { useStore } from "../store";
import { filePathOf } from "../treeModel";
import { CopyCommand } from "./CopyCommand";
import { DiffBody } from "./DiffBody";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { Notice } from "./Notice";

/** Every line of `text` as one all-context hunk: the base pane shows the file, not a diff. */
export function contextOnly(text: string): HunkModel {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body === "" ? [] : body.split("\n");
  if (lines.length === 0) return { oldLines: 0, newLines: 0, hunks: [] };
  return {
    oldLines: lines.length,
    newLines: lines.length,
    hunks: [
      {
        oldStart: 1,
        oldCount: lines.length,
        newStart: 1,
        newCount: lines.length,
        lines: lines.map((t, i) => ({ type: "ctx" as const, old: i + 1, new: i + 1, text: t })),
      },
    ],
  };
}

/**
 * T10.3 numbers the marker lines themselves, 1-based: `start` is `<<<<<<<`, `oursEnd` is `|||||||`
 * in diff3 style and `=======` otherwise, `baseEnd` the `=======` when a `|||||||` was found, and
 * `end` the `>>>>>>>`. Those four line numbers are the ones the working-tree pane tints.
 */
export function markerLines(markers: readonly ConflictMarker[]): Set<number> {
  const out = new Set<number>();
  for (const m of markers) {
    out.add(m.start);
    out.add(m.oursEnd);
    if (m.baseEnd !== undefined) out.add(m.baseEnd);
    out.add(m.end);
  }
  return out;
}

/** A side pane that has no diff to show, said in the same words §7.7 uses elsewhere. */
function SideNotice({ blob, absent }: { blob: SideBlob | null; absent: string }) {
  if (blob === null) {
    return (
      <div className="dg-hatch flex min-h-20 items-center justify-center p-6 text-center text-[13px] text-muted">
        {absent}
      </div>
    );
  }
  if (blob.binary) {
    return (
      <Notice icon={<FileQuestion size={22} aria-hidden />} detail={formatBytes(blob.size)}>
        Binary file not shown
      </Notice>
    );
  }
  // `conflict()` takes no `loadLarge` (unlike `fileDiff`), so there is no button to offer here.
  return (
    <Notice
      icon={<Scale size={22} aria-hidden />}
      detail={`${formatBytes(blob.size)} in the index.`}
    >
      Too large to show
    </Notice>
  );
}

interface SideProps {
  file: FileDiff;
  title: string;
  stage: string;
  blob: SideBlob | null;
  absent: string;
  /** null for the base pane, which is rendered as context only. */
  hunks: HunkModel | null;
  baseText: string | null;
  generation: number;
}

/** One column of the three-way grid: `Base · stage 1` etc. above the pane. */
function ConflictSide({
  file,
  title,
  stage,
  blob,
  absent,
  hunks,
  baseText,
  generation,
}: SideProps) {
  const viewMode = useStore((s) => s.prefs.viewMode);
  const suffix = title.toLowerCase();
  const sideFile = useMemo<FileDiff>(
    () => ({
      ...file,
      id: `${file.id}#${suffix}`,
      status: baseText === null ? "added" : blob === null ? "deleted" : "modified",
    }),
    [file, suffix, baseText, blob],
  );
  const payload = useMemo<(FileDiffPayload & { hunks: HunkModel }) | null>(() => {
    const model =
      hunks ?? (blob?.text !== null && blob?.text !== undefined ? contextOnly(blob.text) : null);
    if (model === null) return null;
    return {
      id: sideFile.id,
      generation,
      classification: {
        binary: false,
        image: false,
        tooLarge: false,
        huge: false,
        typechange: false,
        submodule: false,
        generated: false,
        whitespaceOnly: false,
        oldSize: 0,
        newSize: blob?.size ?? 0,
        changedLines: null,
      },
      hunks: model,
      // The base pane diffs nothing, so expanding context has no source to expand from.
      oldText: hunks === null ? null : baseText,
      newText: blob?.text ?? null,
      language: "text",
      stats: null,
      oldMode: null,
      newMode: null,
    };
  }, [hunks, blob, baseText, sideFile.id, generation]);

  return (
    <section className="min-w-0 border-line max-[899px]:border-t min-[900px]:not-first:border-l">
      <header className="flex items-baseline gap-2 border-b border-line bg-surface-raised px-3 py-1.5 text-xs leading-5">
        <b className="font-semibold text-ink">{title}</b>
        <span className="truncate font-mono text-[11px] text-muted">{stage}</span>
        {/* The index kept no blob for this side; the pane below still shows what disappeared. */}
        {blob === null && <span className="shrink-0 text-[11px] text-done">{absent}</span>}
      </header>
      {payload === null ? (
        <SideNotice blob={blob} absent={absent} />
      ) : (
        <DiffBody
          file={sideFile}
          payload={payload}
          viewType={viewMode === "split" ? "split" : "unified"}
          expandAllToken={0}
          label={`${title} of ${filePathOf(file)}`}
        />
      )}
    </section>
  );
}

/** The working-tree file with the `<<<<<<< / ======= / >>>>>>>` lines tinted (Design §14.3). */
function WorkingTree({ text, markers }: { text: string; markers: readonly ConflictMarker[] }) {
  const lines = useMemo(() => {
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    return body === "" ? [] : body.split("\n");
  }, [text]);
  const tinted = useMemo(() => markerLines(markers), [markers]);
  return (
    <div className="dg-diff overflow-x-auto font-mono text-xs leading-5">
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">Working tree with the conflict markers</caption>
        <tbody>
          {lines.map((line, i) => {
            const n = i + 1;
            const marker = tinted.has(n);
            return (
              <tr
                key={n}
                data-marker={marker ? "" : undefined}
                className={marker ? "bg-status-t-bg font-semibold text-done" : undefined}
              >
                <td className="w-12 pr-2 text-right align-top text-muted select-none">{n}</td>
                <td className="w-auto pr-3 whitespace-pre">{line}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConflictNotice({ payload, path }: { payload: ConflictPayload; path: string }) {
  const operation = useStore((s) => s.operation);
  const command = conflictCommand(operation, path);
  if (payload.resolvedInWorktree) {
    return (
      <Notice
        detail="diffgit re-reads the file as you edit it. Stage it to finish the step."
        action={<CopyCommand command={command} />}
      >
        Resolved in the working tree, not yet staged
      </Notice>
    );
  }
  return (
    <Notice
      detail="diffgit shows conflicts; resolving happens in your editor."
      action={<CopyCommand command={command} />}
    >
      Edit the file, then stage it
    </Notice>
  );
}

/**
 * Design §14.3 / atlas tab 06: the body of a card in the `conflict` layer. Base · Ours · Theirs as
 * three `DiffBody` columns (3-column grid ≥ 900 px, stacked below), then the working-tree file with
 * its marker lines tinted, then the next command. Read-only throughout: diffgit never resolves.
 */
export function ConflictBody({ file }: { file: FileDiff }) {
  const entry = useStore((s) => s.conflicts[file.id]);
  const loadConflict = useStore((s) => s.loadConflict);
  const path = filePathOf(file);
  useEffect(() => {
    if (!entry) void loadConflict(file.id);
  }, [entry, file.id, loadConflict]);

  if (!entry || entry.status === "loading") return <LoadingSkeleton />;
  if (entry.status === "error") {
    return (
      <Notice
        tone="danger"
        icon={<CircleX size={22} aria-hidden />}
        detail={describeError(entry.error.code).message}
        code={`${entry.error.code} · ${entry.error.message}`}
        action={
          <button type="button" className="btn btn-sm" onClick={() => void loadConflict(file.id)}>
            Retry
          </button>
        }
      >
        Couldn't read the conflict stages
      </Notice>
    );
  }

  const p = entry.data;
  const baseText = p.base?.text ?? null;
  return (
    <div>
      <div className="grid grid-cols-1 min-[900px]:grid-cols-3">
        <ConflictSide
          file={file}
          title="Base"
          stage={`stage 1 · ${short(p.base?.oid) || "none"}`}
          blob={p.base}
          absent="no common ancestor"
          hunks={null}
          baseText={null}
          generation={p.generation}
        />
        <ConflictSide
          file={file}
          title="Ours"
          stage={`stage 2 · ${p.labels.ours}`}
          blob={p.ours}
          absent="deleted on this side"
          hunks={p.oursHunks}
          baseText={baseText}
          generation={p.generation}
        />
        <ConflictSide
          file={file}
          title="Theirs"
          stage={`stage 3 · ${p.labels.theirs}`}
          blob={p.theirs}
          absent="deleted on this side"
          hunks={p.theirsHunks}
          baseText={baseText}
          generation={p.generation}
        />
      </div>
      <header className="flex items-baseline gap-2 border-t border-line bg-surface-raised px-3 py-1.5 text-xs leading-5">
        <b className="font-semibold text-ink">Working tree</b>
        <span className="text-muted">what your editor sees right now</span>
      </header>
      {p.worktree === null ? (
        <Notice detail={`${path} is binary, too large, or no longer on disk.`}>
          Working tree file not shown
        </Notice>
      ) : (
        <WorkingTree text={p.worktree.text} markers={p.worktree.markers} />
      )}
      <ConflictNotice payload={p} path={path} />
    </div>
  );
}
