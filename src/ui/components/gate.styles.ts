import { createElement, Fragment, type ReactNode } from "react";
import type { GateCause } from "../store";

/** The address the gate points people at — never `location.href`, which may be a LAN ip or a frame. */
export const CANONICAL = "https://diffgit.com";

/* ------------------------------------------------------------------ styling */

export const BTN =
  "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-3.5 py-[9px] text-[14px] font-medium leading-5 text-ink hover:bg-surface-raised";
export const BTN_INK =
  "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-ink bg-ink px-3.5 py-[9px] text-[14px] font-medium leading-5 text-bg hover:opacity-90";
export const H1 =
  "m-0 mb-3.5 max-w-[16ch] text-[clamp(28px,3.6vw,40px)] font-medium leading-[1.02] tracking-[-0.04em]";
export const DET =
  "mb-4 inline-flex items-center gap-2 rounded-full border border-line px-2.5 py-[5px] font-mono text-[12.5px] font-medium text-muted";
export const P = "m-0 mb-3 max-w-[52ch] text-[15.5px] leading-6 text-muted";
export const STRONG = "font-medium text-ink";
export const MONO = "font-mono text-[13px] text-ink/80";
export const CARD = "rounded-xl border border-line bg-surface p-4";
export const CARD_TITLE =
  "mb-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted";
export const FACT = "inline-flex items-center gap-1.5";
export const SIDE_P = "m-0 mt-2 text-[13px] text-muted";

export const SIDE_TITLE: Partial<Record<GateCause, string>> = {
  firefox: "Open on a Chromium browser",
  safari: "Open on a Chromium browser",
  unknown: "Open on a Chromium browser",
  mobile: "On your computer",
  insecure: "If this is your own build",
  iframe: "Direct link",
};

/** Causes whose fix is "use a different browser on this machine" — they get the 2 × 2 link grid. */
export function isBrowserCause(cause: GateCause): boolean {
  return cause === "firefox" || cause === "safari" || cause === "unknown";
}

export const BROWSERS: { name: string; note: string; href: string }[] = [
  { name: "Google Chrome", note: "86+", href: "https://www.google.com/chrome/" },
  { name: "Microsoft Edge", note: "86+", href: "https://www.microsoft.com/edge" },
  { name: "Brave", note: "desktop", href: "https://brave.com/download/" },
  { name: "Arc", note: "desktop", href: "https://arc.net/" },
];

/** The `--danger` word in the headline; the one thing that differs between the six pages. */
export const RED_WORD: Record<GateCause, string> = {
  firefox: "browser",
  safari: "browser",
  unknown: "browser",
  mobile: "phone",
  insecure: "address",
  iframe: "frame",
  old: "version",
  policy: "policy",
};

export const STEPS: { id: string; head: ReactNode; note: ReactNode }[] = [
  {
    id: "localhost",
    head: createElement(
      Fragment,
      null,
      "Use ",
      createElement(
        "code",
        { className: "font-mono text-[12.5px] text-ink/80" },
        "http://localhost:4173",
      ),
      " instead of the LAN IP",
    ),
    note: "localhost counts as secure",
  },
  {
    id: "https",
    head: "Or serve it over https",
    note: createElement(
      Fragment,
      null,
      createElement(
        "code",
        { className: "font-mono text-[12.5px] text-ink/80" },
        "vite preview --https",
      ),
      ", or Caddy with a local cert",
    ),
  },
  {
    id: "flag",
    head: "Or allow the origin in Chrome",
    note: createElement(
      "code",
      { className: "font-mono text-[12.5px] text-ink/80" },
      "chrome://flags/#unsafely-treat-insecure-origin-as-secure",
    ),
  },
];

/**
 * Engines that simply do not have `showDirectoryPicker()`. Both of them do have
 * `<input webkitdirectory>`, which is snapshot mode's way in (Design §14.6, atlas tab 18). The other
 * causes are not about the engine — a phone cannot hand over a folder at all, and a framed, plain-http
 * or policy-blocked page has a real fix that is better than reading the folder once.
 */
export function canReadOnce(cause: GateCause): boolean {
  return isBrowserCause(cause) || cause === "old";
}
