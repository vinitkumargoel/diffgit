/**
 * View preferences in localStorage (T4.3): schema-validated JSON with defaults; every read/write is
 * wrapped so private mode / blocked storage never throws out.
 */
import { DEFAULT_PREFS, type Prefs } from "../store";
import { reportStorageError } from "./storage";

export const PREFS_KEY = "diffgit.prefs.v1";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Keeps only valid fields; anything missing or malformed falls back to the default. */
export function validatePrefs(raw: unknown): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS };
  if (!isRecord(raw)) return out;
  if (raw.viewMode === "unified" || raw.viewMode === "split") out.viewMode = raw.viewMode;
  if (typeof raw.ignoreWhitespace === "boolean") out.ignoreWhitespace = raw.ignoreWhitespace;
  if (raw.theme === "system" || raw.theme === "light" || raw.theme === "dark")
    out.theme = raw.theme;
  if (typeof raw.sidebarWidth === "number" && Number.isFinite(raw.sidebarWidth)) {
    out.sidebarWidth = Math.min(480, Math.max(220, Math.round(raw.sidebarWidth)));
  }
  if (raw.sidebarLayout === "tree" || raw.sidebarLayout === "flat")
    out.sidebarLayout = raw.sidebarLayout;
  if (raw.sidebarGroup === "layer" || raw.sidebarGroup === "path")
    out.sidebarGroup = raw.sidebarGroup;
  return out;
}

let override: Storage | null | undefined;
/** Test hook: substitute the backing Storage (`null` = unavailable, `undefined` = real localStorage). */
export function setPrefsStorage(s: Storage | null | undefined): void {
  override = s;
}

function storage(): Storage | null {
  if (override !== undefined) return override;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = storage()?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return validatePrefs(JSON.parse(raw));
  } catch (e) {
    reportStorageError(e);
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(validatePrefs(prefs)));
  } catch (e) {
    reportStorageError(e);
  }
}
