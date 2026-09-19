import { Command } from "cmdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { type DerivedSize, derivedSize } from "../persistence/derived";
import { FOOTER_LINE, parseSearch, SEARCH_DEBOUNCE_MS } from "../search";
import { useStore } from "../store";
import { PaletteActionGroup } from "./PaletteActionGroup";
import { PaletteButton, paletteTrigger } from "./PaletteButton";
import { MAX_FILE_ROWS, PaletteFileGroup, subsequence } from "./PaletteFileGroup";
import { PaletteSearchGroup } from "./PaletteSearchGroup";
import { PALETTE_DIALOG_CLASS, PALETTE_FOOTER_CLASS, PALETTE_LIST_CLASS } from "./palette.styles";

export { MAX_FILE_ROWS, PaletteButton, subsequence };

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
  const searchState = useStore((s) => s.search);
  const runSearch = useStore((s) => s.runSearch);
  const cancelSearch = useStore((s) => s.cancelSearch);

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
    // The cache size arrives on a promise; a palette closed (or unmounted) before it answers must
    // not set state, so the answer is dropped once this effect is cleaned up.
    let alive = true;
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      // Where focus goes on close. React has already run `autoFocus` on the input by now, so
      // anything inside the dialog is not a candidate; the trigger button is the fallback.
      const active = document.activeElement;
      returnTo.current = active instanceof HTMLElement && !el.contains(active) ? active : null;
      setSearch("");
      void derivedSize().then((size) => {
        if (alive) setCache(size);
      });
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
    return () => {
      alive = false;
    };
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

  return (
    <dialog
      ref={ref}
      className={PALETTE_DIALOG_CLASS}
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
            <Command.List className={PALETTE_LIST_CLASS}>
              <PaletteSearchGroup parsed={parsed} onRun={run} />
            </Command.List>
          ) : (
            <Command.List className={PALETTE_LIST_CLASS}>
              <Command.Empty>No matching command</Command.Empty>
              <PaletteActionGroup
                search={search}
                cache={cache}
                setCache={setCache}
                onArmPrefix={setSearch}
                onRun={run}
                onHelp={onHelp}
              />
              <PaletteFileGroup search={search} onRun={run} />
            </Command.List>
          )}
          <p className={PALETTE_FOOTER_CLASS}>{FOOTER_LINE}</p>
        </Command>
      )}
    </dialog>
  );
}
