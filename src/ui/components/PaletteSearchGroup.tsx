import { Command } from "cmdk";
import type { FileDiff, SearchHit } from "../../engine/types";
import { shortOid } from "../history";
import { requestScrollTo } from "../scrollBus";
import {
  CAPPED_LINE,
  emptyLine,
  hitLocation,
  nextWiden,
  notInDiffNote,
  occurrencesLabel,
  type ParsedSearch,
  promptLine,
  resultsHeading,
  scannedLine,
  WORKING_TREE_HIT,
  widenLabel,
} from "../search";
import { useStore } from "../store";
import { filePathOf } from "../treeModel";
import {
  PALETTE_ACCENT_CLASS,
  PALETTE_CAPPED_CLASS,
  PALETTE_MUTED_LINE_CLASS,
  PALETTE_NOTE_CLASS,
  PALETTE_NOTE_DANGER_CLASS,
  PALETTE_OCCURRENCES_CLASS,
  PALETTE_SANS_LINE_CLASS,
} from "./palette.styles";

const EMPTY_FILES: FileDiff[] = [];

export interface PaletteSearchGroupProps {
  parsed: ParsedSearch;
  onRun: (action: () => void) => void;
}

/**
 * Search results group from the engine (`grep:`, `-S`, `>`), hit locations, widen action,
 * scanned duration, and capped search indicators (Design §14.1, atlas tab 05).
 */
export function PaletteSearchGroup({ parsed, onRun }: PaletteSearchGroupProps) {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const addToast = useStore((s) => s.addToast);
  const allFiles = useStore((s) => s.diff?.files) ?? EMPTY_FILES;
  const searchState = useStore((s) => s.search);
  const widenSearch = useStore((s) => s.widenSearch);
  const showCommit = useStore((s) => s.showCommit);

  const current =
    searchState.scope === parsed.scope &&
    searchState.query === parsed.query &&
    searchState.regex === parsed.regex;
  const result = current ? searchState.result : null;
  const searchError = current ? searchState.error : null;
  const searching = parsed.query !== "" && (!current || searchState.loading);
  const hits = result?.hits ?? [];
  const widen = parsed.scope === "pickaxe" && result ? nextWiden(searchState.commits) : null;

  const openHit = (hit: SearchHit) => {
    if (hit.oid !== undefined) {
      setMode("history");
      void showCommit(hit.oid);
      return;
    }
    if (hit.kind === "file" && hit.path !== undefined) {
      const path = hit.path;
      const file = allFiles.find((f) => filePathOf(f) === path);
      if (!file) {
        addToast({ level: "info", message: notInDiffNote(path) });
        return;
      }
      if (mode !== "files") setMode("files");
      setActiveFile(file.id);
      requestScrollTo(file.id, hit.line);
      return;
    }
    if (mode !== "files") setMode("files");
  };

  return (
    <>
      {parsed.query === "" && <p className={PALETTE_NOTE_CLASS}>{promptLine(parsed.scope)}</p>}
      {searchError && (
        <p className={PALETTE_NOTE_DANGER_CLASS}>
          {searchError.message}
          {searchError.hint ? ` — ${searchError.hint}` : ""}
        </p>
      )}
      {searching && <p className={PALETTE_NOTE_CLASS}>Searching…</p>}
      {hits.length > 0 && (
        <Command.Group heading={resultsHeading(parsed.scope, hits.length)}>
          {hits.map((hit, i) => (
            <Command.Item
              // A hit has no id of its own; the engine's order is the answer's order.
              key={`${hit.oid ?? hit.path ?? ""}:${hit.line ?? i}`}
              value={`hit-${i}`}
              onSelect={() => onRun(() => openHit(hit))}
            >
              {hit.kind === "commit" ? (
                <>
                  <span className={PALETTE_ACCENT_CLASS}>
                    {hit.oid === undefined ? WORKING_TREE_HIT : shortOid(hit.oid)}
                  </span>
                  <span className={PALETTE_SANS_LINE_CLASS}>{hit.subject}</span>
                  {hit.delta !== undefined && (
                    <span className={PALETTE_OCCURRENCES_CLASS}>{occurrencesLabel(hit.delta)}</span>
                  )}
                </>
              ) : (
                <>
                  <span className={PALETTE_ACCENT_CLASS}>{hitLocation(hit)}</span>
                  <span className={PALETTE_MUTED_LINE_CLASS}>{hit.text}</span>
                </>
              )}
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {result && hits.length === 0 && (
        <p className={PALETTE_NOTE_CLASS}>{emptyLine(parsed.scope, searchState.query)}</p>
      )}
      {result && (
        <p className={PALETTE_NOTE_CLASS}>
          {scannedLine(parsed.scope, result)}
          {result.capped && (
            <>
              {" · "}
              <span className={PALETTE_CAPPED_CLASS}>{CAPPED_LINE}</span>
            </>
          )}
        </p>
      )}
      {widen !== null && (
        <Command.Item value="widen" onSelect={() => void widenSearch()}>
          <span className={PALETTE_SANS_LINE_CLASS}>{widenLabel(widen)}</span>
        </Command.Item>
      )}
    </>
  );
}
