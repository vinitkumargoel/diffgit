import { Command } from "cmdk";
import { Command as CommandGlyph } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { formatBytes } from "../format";
import { pickAndOpenRepo } from "../openRepo";
import { clearDerived, type DerivedSize, derivedSize } from "../persistence/derived";
import { requestScrollTo } from "../scrollBus";
import { selectVisibleFiles, useStore } from "../store";
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
 * Search scopes (§14.5) are added by T11.8.
 */
export function CommandPalette({
  onHelp,
  onReflog,
}: {
  onHelp?: () => void;
  onReflog?: () => void;
} = {}) {
  const open = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const prefs = useStore((s) => s.prefs);
  const setPref = useStore((s) => s.setPref);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const addToast = useStore((s) => s.addToast);
  const requestRefresh = useStore((s) => s.requestRefresh);
  const files = useStore(useShallow(selectVisibleFiles));
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [search, setSearch] = useState("");
  const [cache, setCache] = useState<DerivedSize | null>(null);

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
      (returnTo.current ?? paletteTrigger)?.focus();
      returnTo.current = null;
    }
  }, [open]);

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
        // T11.3: the Reflog list ships now; T11.5 gives it the History sidebar sub-tab of §14.5.
        id: "reflog",
        label: "Show reflog",
        keywords: ["HEAD", "history", "lost commit", "orphan", "undo"],
        run: () => onReflog?.(),
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
    ];
    return list;
  }, [prefs, cache, setMode, setPref, requestRefresh, addToast, onHelp, onReflog]);

  // Pre-narrowed so a 5,000-file diff never renders 5,000 rows; cmdk ranks the survivors.
  const fileRows = useMemo(
    () => files.filter((f) => subsequence(filePathOf(f), search)).slice(0, MAX_FILE_ROWS),
    [files, search],
  );

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
        <Command label="Command palette" loop>
          <Command.Input
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder="Type a command or a file…"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
          <Command.List className="max-h-[50vh] overflow-y-auto p-1">
            <Command.Empty>No matching command</Command.Empty>
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
