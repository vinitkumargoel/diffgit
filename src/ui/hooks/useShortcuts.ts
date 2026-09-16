import { useEffect, useRef } from "react";

/** The single-key shortcuts (Plan §6.5, Design §7.9); the HelpDialog renders this table. */
export const SHORTCUTS = [
  { key: "o", description: "Open a repository" },
  { key: "r", description: "Refresh the diff" },
  { key: "R", label: "Shift+R", description: "Force refresh: re-read every file" },
  { key: "j", description: "Next file" },
  { key: "k", description: "Previous file" },
  { key: "v", description: "Toggle viewed on the active file" },
  { key: "[", description: "Collapse the active file" },
  { key: "]", description: "Expand the active file" },
  { key: "/", description: "Focus the file filter" },
  { key: "s", description: "Switch between split and unified view" },
  { key: "?", description: "Show keyboard shortcuts" },
  { key: "Escape", label: "Esc", description: "Close the branch picker, filter or dialog" },
] as const;

export type ShortcutKey = (typeof SHORTCUTS)[number]["key"];
export type ShortcutHandlers = Partial<Record<ShortcutKey, (e: KeyboardEvent) => void>>;

/** True when the event originates from a text field or an editable element. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
  );
}

/**
 * Registers global single-key shortcuts: fires the handler for `e.key` when no ⌘/Ctrl/Alt modifier
 * is held, the event was not already handled, and the user is not typing in a field. The
 * handlers object may be recreated every render; the listener always calls the latest one.
 */
export function useShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      const handler = latest.current[e.key as ShortcutKey];
      if (!handler) return;
      e.preventDefault();
      handler(e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
