import { Command } from "cmdk";
import { Command as CommandGlyph } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { FileDiff, SearchHit } from "../../engine/types";
import { formatBytes } from "../format";
import { shortOid } from "../history";
import { openRepoOnce, pickAndOpenRepo } from "../openRepo";
import { clearDerived, type DerivedSize, derivedSize } from "../persistence/derived";
import { requestScrollTo } from "../scrollBus";
import {
  ADVERTISED_PREFIXES,
  CAPPED_LINE,
  emptyLine,
  FOOTER_LINE,
  hitLocation,
  nextWiden,
  notInDiffNote,
  occurrencesLabel,
  parseSearch,
  promptLine,
  resultsHeading,
  SEARCH_DEBOUNCE_MS,
  scannedLine,
  WORKING_TREE_HIT,
  widenLabel,
} from "../search";
import { selectPreflightPair, selectVisibleFiles, useStore } from "../store";
import { filePathOf } from "../treeModel";
import { MODES } from "./ModeSwitch";

/** How many "Go to file" rows are handed to cmdk; it scores and orders what it gets. */
export const MAX_FILE_ROWS = 50;

/** Subsequence match, the cheap pre-narrowing in front of cmdk's scorer (case-insensitive). */
export function subsequence(haystack: string, needle: string): boolean {
  if (needle === "") return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return false;
}

/** The trigger button, so Escape can hand focus back to it wherever the palette was opened from. */
let paletteTrigger: HTMLButtonElement | null = null;

/** A stable empty list, so the "no diff open" case does not re-render the palette every time. */
const EMPTY_FILES: FileDiff[] = [];

interface Action {
  id: string;
  label: string;
  /** Extra words the search matches on. */
  keywords?: string[];
  /** Right-aligned hint: the single-key shortcut, or a size. */
  hint?: string;
  run: () => void;
}

/**
 * Design §14.1: "anything not visible is one keystroke away". `⌘K` / `Ctrl+K` or the `lucide:command`
 * button at the end of TopBar row 1 opens it; Escape closes it and focus goes back where it was.
 * Built on cmdk, like the BranchPicker, so the keyboard behaviour and the list styling are shared.
 *
 * T11.8 adds the search scopes (Design §14, rule 2; atlas tab 05): a query that starts with `>`,
 * `grep:` or `-S` stops being a command filter and becomes one `search(req)` in that scope, run in
 * the engine worker after the keystrokes settle. The results are cmdk rows like every other row, so
 * the arrow keys and Enter already work; the cost (`scanned`, the duration, `capped`) is one line
 * inside them, never a banner, and the pickaxe's range can be widened from a row of its own.
 */
export function CommandPalette({ onHelp }: { onHelp?: () => void } = {}) {
  const open = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const setHistoryTab = useStore((s) => s.setHistoryTab);
  const prefs = useStore((s) => s.prefs);
  const setPref = useStore((s) => s.setPref);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const addToast = useStore((s) => s.addToast);
  const requestRefresh = useStore((s) => s.requestRefresh);
  const scanSecrets = useStore((s) => s.scanSecrets);
  const setExportOpen = useStore((s) => s.setExportOpen);
  const files = useStore(useShallow(selectVisibleFiles));
  // T11.8: a grep hit names a path anywhere in the working tree, so the card it opens is looked up
  // in the whole comparison, not in the filtered sidebar view.
  const allFiles = useStore((s) => s.diff?.files) ?? EMPTY_FILES;
  const searchState = useStore((s) => s.search);
  const runSearch = useStore((s) => s.runSearch);
  const widenSearch = useStore((s) => s.widenSearch);
  const cancelSearch = useStore((s) => s.cancelSearch);
  const showCommit = useStore((s) => s.showCommit);
  const startBisect = useStore((s) => s.startBisect);
  const stopBisect = useStore((s) => s.stopBisect);
  const bisecting = useStore((s) => s.bisect !== null);
  const runPreflight = useStore((s) => s.runPreflight);
  const preflightPair = useStore(useShallow(selectPreflightPair));
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [search, setSearch] = useState("");
  const [cache, setCache] = useState<DerivedSize | null>(null);
  /** Null while the box holds a command filter; a scope as soon as it holds a search prefix. */
  const parsed = useMemo(() => parseSearch(search), [search]);

  // `⌘K` / `Ctrl+K` toggles from anywhere on the screen, including from inside the filter field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key !== "k" && e.key !== "K") return;
      e.preventDefault();
      useStore.getState().setPalette(!useStore.getState().palette);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      // Where focus goes on close. React has already run `autoFocus` on the input by now, so
      // anything inside the dialog is not a candidate; the trigger button is the fallback.
      const active = document.activeElement;
      returnTo.current = active instanceof HTMLElement && !el.contains(active) ? active : null;
      setSearch("");
      void derivedSize().then(setCache);
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
      // A search belongs to the palette that is open, not to the repository: closing forgets it
      // (and makes a reply that is still in flight land nowhere).
      useStore.getState().cancelSearch();
      (returnTo.current ?? paletteTrigger)?.focus();
      returnTo.current = null;
    }
  }, [open]);

  /**
   * One search per pause in the typing, and only while the palette is open. The cleanup cancels the
   * pending timer, so a query is never sent for an input the user has already changed; the store's
   * own ticket covers the calls that are already in the worker.
   */
  useEffect(() => {
    if (!open) return;
    if (parsed === null || parsed.query === "") {
      cancelSearch();
      return;
    }
    const { scope, query, regex } = parsed;
    const timer = setTimeout(() => void runSearch({ scope, query, regex }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, parsed, runSearch, cancelSearch]);

  const close = () => setPalette(false);
  const run = (fn: () => void) => {
    close();
    fn();
  };

  const actions = useMemo<Action[]>(() => {
    const list: Action[] = [
      {
        id: "open",
        label: "Open a repository…",
        keywords: ["folder", "choose", "pick"],
        hint: "o",
        run: () => void pickAndOpenRepo(),
      },
      {
        id: "refresh",
        label: "Refresh the diff",
        keywords: ["reload"],
        hint: "r",
        run: () => requestRefresh("manual"),
      },
      {
        id: "force-refresh",
        label: "Force refresh: re-read every file",
        keywords: ["reload", "recount"],
        hint: "Shift+R",
        run: () => requestRefresh("force"),
      },
      ...MODES.map((m) => ({
        id: `mode-${m.mode}`,
        label: `Go to ${m.label}`,
        keywords: ["mode", "view", m.label],
        hint: m.key,
        run: () => setMode(m.mode),
      })),
      {
        id: "view-mode",
        label: prefs.viewMode === "split" ? "Use unified view" : "Use split view",
        keywords: ["diff", "side by side", "unified", "split"],
        hint: "s",
        run: () => setPref("viewMode", prefs.viewMode === "split" ? "unified" : "split"),
      },
      {
        id: "whitespace",
        label: prefs.ignoreWhitespace ? "Show whitespace changes" : "Ignore whitespace changes",
        keywords: ["blank", "indent"],
        run: () => setPref("ignoreWhitespace", !prefs.ignoreWhitespace),
      },
      {
        id: "hidden",
        label: prefs.showHidden ? "Hide hidden files" : "Show hidden files",
        keywords: ["ignored", "skip-worktree", "excluded"],
        hint: "Shift+H",
        run: () => setPref("showHidden", !prefs.showHidden),
      },
      {
        // T11.5: the Reflog list is the History sidebar's third sub-tab (Design §14.5).
        id: "reflog",
        label: "Show reflog",
        keywords: ["HEAD", "history", "lost commit", "orphan", "undo"],
        run: () => {
          setHistoryTab("reflog");
          setMode("history");
        },
      },
      {
        // T11.9: the scan runs itself after every compute; this is the "look again" for a working
        // tree that changed outside a refresh, and the only way to hear "nothing found".
        id: "scan-secrets",
        label: "Re-scan for secrets",
        keywords: ["credential", "key", "token", "leak", "password"],
        run: () => void scanSecrets({ announce: true }),
      },
      {
        // T11.13: the bisect strip and the preflight panel are reached from here or from a row
        // `…` menu — never from the bars (Design §14.1's last paragraph).
        id: "bisect",
        label: bisecting ? "Stop the bisect" : "Start bisect…",
        keywords: ["bisect", "regression", "broke", "midpoint", "git bisect"],
        run: () => void (bisecting ? stopBisect() : startBisect()),
      },
      ...(preflightPair
        ? [
            {
              id: "preflight",
              label: `Preflight rebase of ${preflightPair.branch} onto ${preflightPair.onto}`,
              keywords: ["rebase", "conflict", "replay", "todo", "preflight"],
              run: () => void runPreflight(preflightPair.branch, preflightPair.onto),
            },
          ]
        : []),
      {
        // T11.10: Design §14.6's menu is in the StatsRow; the palette is how it opens from anywhere.
        id: "export",
        label: "Export…",
        keywords: ["patch", "diff", "snapshot", "download", "save", "copy", "markdown"],
        hint: "e",
        run: () => setExportOpen(true),
      },
      {
        id: "help",
        label: "Show keyboard shortcuts",
        keywords: ["help", "keys"],
        hint: "?",
        run: () => onHelp?.(),
      },
      {
        id: "clear-cache",
        label: "Clear cached data",
        keywords: ["cache", "blame", "insights", "storage"],
        ...(cache ? { hint: formatBytes(cache.bytes) } : {}),
        run: () => {
          void clearDerived().then(() => {
            setCache({ entries: 0, bytes: 0 });
            addToast({ level: "info", message: "Cached blame, history and insights cleared." });
          });
        },
      },
      {
        // T11.15: the read-once flow Firefox and Safari get from the gate, available everywhere —
        // which is how snapshot mode is exercised on a Chromium browser.
        id: "open-once",
        label: "Open once (snapshot)",
        keywords: ["folder", "read once", "firefox", "safari", "webkitdirectory", "no refresh"],
        run: () =>
          void openRepoOnce().catch((e: unknown) =>
            addToast({
              level: "error",
              message: e instanceof Error ? e.message : "Couldn't read the folder.",
            }),
          ),
      },
    ];
    return list;
  }, [
    prefs,
    cache,
    setMode,
    setHistoryTab,
    setPref,
    requestRefresh,
    scanSecrets,
    setExportOpen,
    addToast,
    onHelp,
    bisecting,
    startBisect,
    stopBisect,
    runPreflight,
    preflightPair,
  ]);

  // Pre-narrowed so a 5,000-file diff never renders 5,000 rows; cmdk ranks the survivors.
  const fileRows = useMemo(
    () => files.filter((f) => subsequence(filePathOf(f), search)).slice(0, MAX_FILE_ROWS),
    [files, search],
  );

  /**
   * The store keeps the answer to the last query it sent; while the debounce is still pending that
   * is the *previous* query, and showing its hits under a newer one would be a lie. So the results
   * are rendered only while the slice describes exactly what is in the box.
   */
  const current =
    parsed !== null &&
    searchState.scope === parsed.scope &&
    searchState.query === parsed.query &&
    searchState.regex === parsed.regex;
  const result = current ? searchState.result : null;
  const searchError = current ? searchState.error : null;
  const searching = parsed !== null && parsed.query !== "" && (!current || searchState.loading);
  const hits = result?.hits ?? [];
  const widen = parsed?.scope === "pickaxe" && result ? nextWiden(searchState.commits) : null;

  /**
   * Design §14.1 / atlas tab 05: a commit hit selects it in History, a working-tree hit opens its
   * card in Files and scrolls to the line, and the pickaxe's `Uncommitted changes` row — the one
   * hit with no `oid` — is the working tree, which is Files mode with nothing else to point at.
   */
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
    <dialog
      ref={ref}
      className="palette-dialog"
      aria-label="Command palette"
      onClose={close}
      onCancel={close}
      onMouseDown={(e) => {
        if (e.target === ref.current) close(); // click on the backdrop
      }}
    >
      {open && (
        // In a scope the rows are the engine's answer in its own order, so cmdk must not re-rank
        // or hide them: the query is the search, not a filter over it.
        <Command label="Command palette" loop shouldFilter={parsed === null}>
          <Command.Input
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder="Type a command or a file…"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                // Atlas tab 05: Escape is the cancel button for a running search. It throws the
                // answer away and puts the box back to the armed prefix, so the next Escape — with
                // nothing left to stop — closes the palette as it always did.
                if (parsed !== null && searchState.loading) {
                  cancelSearch();
                  setSearch(parsed.prefix);
                  return;
                }
                close();
              }
            }}
          />
          {parsed !== null ? (
            <Command.List className="max-h-[50vh] overflow-y-auto p-1">
              {parsed.query === "" && <p className="palette-note">{promptLine(parsed.scope)}</p>}
              {searchError && (
                <p className="palette-note text-danger">
                  {searchError.message}
                  {searchError.hint ? ` — ${searchError.hint}` : ""}
                </p>
              )}
              {searching && <p className="palette-note">Searching…</p>}
              {hits.length > 0 && (
                <Command.Group heading={resultsHeading(parsed.scope, hits.length)}>
                  {hits.map((hit, i) => (
                    <Command.Item
                      // A hit has no id of its own; the engine's order is the answer's order.
                      key={`${hit.oid ?? hit.path ?? ""}:${hit.line ?? i}`}
                      value={`hit-${i}`}
                      onSelect={() => run(() => openHit(hit))}
                    >
                      {hit.kind === "commit" ? (
                        <>
                          <span className="shrink-0 font-mono text-accent">
                            {hit.oid === undefined ? WORKING_TREE_HIT : shortOid(hit.oid)}
                          </span>
                          <span className="truncate font-sans">{hit.subject}</span>
                          {hit.delta !== undefined && (
                            <span className="ml-auto shrink-0 text-muted tabular-nums">
                              {occurrencesLabel(hit.delta)}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="shrink-0 font-mono text-accent">{hitLocation(hit)}</span>
                          <span className="truncate text-muted">{hit.text}</span>
                        </>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {result && hits.length === 0 && (
                <p className="palette-note">{emptyLine(parsed.scope, searchState.query)}</p>
              )}
              {result && (
                <p className="palette-note">
                  {scannedLine(parsed.scope, result)}
                  {result.capped && (
                    <>
                      {" · "}
                      <span className="text-attention">{CAPPED_LINE}</span>
                    </>
                  )}
                </p>
              )}
              {widen !== null && (
                <Command.Item value="widen" onSelect={() => void widenSearch()}>
                  <span className="truncate font-sans">{widenLabel(widen)}</span>
                </Command.Item>
              )}
            </Command.List>
          ) : (
            <Command.List className="max-h-[50vh] overflow-y-auto p-1">
              <Command.Empty>No matching command</Command.Empty>
              {/* Only on the empty box: the scopes are an offer, and once a command is being
                  typed they would compete with it for the highlighted row. */}
              {search === "" && (
                <Command.Group heading="Scopes">
                  {ADVERTISED_PREFIXES.map((p) => (
                    <Command.Item
                      key={p.prefix}
                      value={`scope-${p.scope}`}
                      keywords={["search", "find", p.prefix, p.label, p.note]}
                      // Not a command: it arms the box with the prefix and leaves the palette open.
                      onSelect={() => setSearch(p.prefix.endsWith(":") ? p.prefix : `${p.prefix} `)}
                    >
                      <kbd className="kbd shrink-0" aria-hidden>
                        {p.prefix}
                      </kbd>
                      <span className="truncate font-sans">Search {p.label.toLowerCase()}</span>
                      <span className="ml-auto truncate pl-2 text-muted">{p.note}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Actions">
                {actions.map((a) => (
                  <Command.Item
                    key={a.id}
                    value={a.id}
                    keywords={[a.label, ...(a.keywords ?? [])]}
                    onSelect={() => run(a.run)}
                  >
                    <span className="truncate font-sans">{a.label}</span>
                    {a.hint && (
                      <kbd className="kbd ml-auto" aria-hidden>
                        {a.hint}
                      </kbd>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
              {fileRows.length > 0 && (
                <Command.Group heading="Go to file">
                  {fileRows.map((f) => (
                    <Command.Item
                      key={f.id}
                      value={`file:${f.id}`}
                      keywords={[filePathOf(f)]}
                      onSelect={() =>
                        run(() => {
                          if (mode !== "files") setMode("files");
                          setActiveFile(f.id);
                          requestScrollTo(f.id);
                        })
                      }
                    >
                      <span className="truncate">{filePathOf(f)}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          )}
          <p className="palette-footer">{FOOTER_LINE}</p>
        </Command>
      )}
    </dialog>
  );
}

/** The `lucide:command` trigger that sits before the theme toggle (Design §14.1). */
export function PaletteButton() {
  const setPalette = useStore((s) => s.setPalette);
  const open = useStore((s) => s.palette);
  return (
    <button
      ref={(el) => {
        paletteTrigger = el;
      }}
      type="button"
      className="btn btn-icon"
      aria-label="Command palette"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Command palette (⌘K)"
      onClick={() => setPalette(true)}
    >
      <CommandGlyph size={16} aria-hidden />
    </button>
  );
}
