import type { GateCause } from "./store";

/**
 * Why this browser can't open a local folder, and what to call it on screen (Design §7.8, B1–B6).
 *
 * Every function takes a window-like object so the six gate pages can be rendered from a fake in
 * tests and so nothing here touches globals implicitly. The raw user-agent string is never
 * returned — only a short product name and major version, which is all the gate shows.
 */

/** The `navigator.userAgentData.brands` entries Chromium reports. */
export interface GateBrand {
  brand: string;
  version: string;
}

export interface GateNavigator {
  userAgent?: string;
  userAgentData?: { brands?: GateBrand[]; mobile?: boolean; platform?: string };
  share?: unknown;
}

/** The subset of `window` the gate reads. `window` itself is assignable to it. */
export interface GateWindow {
  navigator?: GateNavigator;
  isSecureContext?: boolean;
  top?: unknown;
  self?: unknown;
  location?: { href?: string; host?: string; hostname?: string };
  showDirectoryPicker?: unknown;
}

/** `showDirectoryPicker()` shipped in Chromium 86 (October 2020). */
export const MIN_CHROMIUM = 86;

/** GREASE padding Chromium adds to `brands` ("Not_A Brand", " Not;A Brand", "Not)A;Brand", …). */
const GREASE = /not[^a-z0-9]*a[^a-z0-9]*brand/i;

/** Brand → display name, most specific first (Edge and Brave also report "Chromium"). */
const BRAND_NAMES: [RegExp, string][] = [
  [/microsoft edge/i, "Edge"],
  [/brave/i, "Brave"],
  [/opera/i, "Opera"],
  [/google chrome/i, "Chrome"],
  [/chromium/i, "Chromium"],
];

/** UA token → display name, most specific first (Chrome's UA also contains "Safari/"). */
const UA_NAMES: [RegExp, string][] = [
  [/Edg(?:A|iOS)?\/(\d+)/, "Edge"],
  [/OPR\/(\d+)/, "Opera"],
  [/(?:CriOS)\/(\d+)/, "Chrome"],
  [/(?:FxiOS)\/(\d+)/, "Firefox"],
  [/Firefox\/(\d+)/, "Firefox"],
  [/Chrome\/(\d+)/, "Chrome"],
  [/Chromium\/(\d+)/, "Chromium"],
  [/Version\/(\d+)[^ ]* Safari/, "Safari"],
  [/Safari\/(\d+)/, "Safari"],
];

/** Neutral stand-in when nothing in the UA is recognisable; never the raw UA string. */
const UNNAMED = "This browser";

function theWindow(): GateWindow {
  return typeof window === "undefined" ? {} : (window as GateWindow);
}

function uaOf(win: GateWindow): string {
  return win.navigator?.userAgent ?? "";
}

/** `brands` minus the GREASE entries, which are random noise by design. */
function brandsOf(win: GateWindow): GateBrand[] {
  return (win.navigator?.userAgentData?.brands ?? []).filter((b) => !GREASE.test(b.brand));
}

function majorOf(version: string | undefined): string | null {
  const m = /^(\d+)/.exec(version ?? "");
  return m ? m[1] : null;
}

/** Highest Chromium major from `brands`, falling back to the UA (pre-89 Chromium has no brands). */
function chromiumMajor(win: GateWindow): number | null {
  const fromBrands = brandsOf(win)
    .map((b) => Number.parseInt(b.version, 10))
    .filter((n) => Number.isFinite(n));
  if (fromBrands.length > 0) return Math.max(...fromBrands);
  const m = /(?:Chrome|Chromium|CriOS)\/(\d+)/.exec(uaOf(win));
  return m ? Number.parseInt(m[1], 10) : null;
}

function isMobile(win: GateWindow): boolean {
  if (win.navigator?.userAgentData?.mobile === true) return true;
  const ua = uaOf(win);
  return /iPhone|iPad|iPod|Android/.test(ua) && /Mobile/.test(ua);
}

function isFirefox(win: GateWindow): boolean {
  return /Firefox\/|FxiOS\//.test(uaOf(win));
}

/** Safari is "AppleWebKit, and none of the Chromium tells" — brands or a Chrome/Edge/Opera token. */
function isSafari(win: GateWindow): boolean {
  const ua = uaOf(win);
  if (!/Safari\//.test(ua)) return false;
  if (/Chrome\/|Chromium\/|Edg|CriOS\/|OPR\//.test(ua)) return false;
  return brandsOf(win).length === 0;
}

/** True when the page is embedded: `window.top` exists and is not this window. */
function isFramed(win: GateWindow): boolean {
  const self = win.self ?? win;
  return win.top != null && win.top !== self;
}

/** `showDirectoryPicker` is present on this window (the API is simply absent on http and Firefox). */
export function hasDirectoryPicker(win: GateWindow): boolean {
  return typeof win === "object" && win !== null && "showDirectoryPicker" in (win as object);
}

/**
 * The reason the gate is up, or `null` when the picker is available.
 *
 * Order matters: an embedded page is refused even though the API exists; a phone is a phone
 * whatever browser it runs, and a missing API on Firefox/Safari is about the engine rather than
 * the page's origin. `insecure` comes next because it hides an API the browser does have; `old` is the last specific cause and `unknown` the
 * catch-all. The B6 "policy" cause is never detected here — the picker exists and only refuses on
 * the first click — so the store's `gateCause` carries it instead.
 */
export function detectGateCause(win: GateWindow = theWindow()): GateCause | null {
  // An embedded page keeps the API but the picker refuses to open from a frame (B5), so this is
  // decided before the API check.
  if (isFramed(win)) return "iframe";
  if (hasDirectoryPicker(win)) return null;
  if (isMobile(win)) return "mobile";
  if (isFirefox(win)) return "firefox";
  if (isSafari(win)) return "safari";
  if (win.isSecureContext === false) return "insecure";
  const major = chromiumMajor(win);
  if (major !== null && major < MIN_CHROMIUM) return "old";
  return "unknown";
}

/** "iOS" / "Android" for the phone pill ("Chrome on iOS · folder access is desktop-only"). */
export function detectMobileOs(win: GateWindow = theWindow()): "iOS" | "Android" | null {
  const ua = uaOf(win);
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  return null;
}

/**
 * What to call this browser on screen: a product name, its major version and whether it is a
 * hand-held. `brands` is preferred over the UA because Chromium's UA lies about Safari and Chrome.
 */
export function describeBrowser(win: GateWindow = theWindow()): {
  name: string;
  version: string | null;
  platform: "desktop" | "phone";
} {
  const platform = isMobile(win) ? "phone" : "desktop";
  for (const [pattern, name] of BRAND_NAMES) {
    const brand = brandsOf(win).find((b) => pattern.test(b.brand));
    if (brand) return { name, version: majorOf(brand.version), platform };
  }
  const ua = uaOf(win);
  for (const [pattern, name] of UA_NAMES) {
    const m = pattern.exec(ua);
    if (m) return { name, version: m[1], platform };
  }
  return { name: UNNAMED, version: null, platform };
}
