/**
 * Theme bootstrap (T4.4; toggle + persistence reconciled in T5.6, Design §11).
 * `prefs.theme` is "system" | "light" | "dark"; "system" follows `prefers-color-scheme`.
 */
import type { Theme } from "./store";

let mediaQuery: MediaQueryList | null = null;
let listener: ((e: MediaQueryListEvent) => void) | null = null;

function setDarkClass(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
}

/** Applies the theme to <html> and keeps following the OS setting while `theme === "system"`. */
export function applyTheme(theme: Theme): void {
  if (mediaQuery && listener) {
    mediaQuery.removeEventListener("change", listener);
    mediaQuery = null;
    listener = null;
  }
  if (theme === "system") {
    if (typeof matchMedia === "function") {
      mediaQuery = matchMedia("(prefers-color-scheme: dark)");
      listener = (e) => setDarkClass(e.matches);
      mediaQuery.addEventListener("change", listener);
      setDarkClass(mediaQuery.matches);
    } else setDarkClass(false);
    return;
  }
  setDarkClass(theme === "dark");
}
