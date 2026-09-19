/**
 * The Design §3 colour tokens, read out of `src/index.css` at build time (T11.10).
 *
 * A review snapshot is a standalone document: it carries its own `:root` / `.dark` declarations,
 * because nothing of the app travels with it. Those values may not be re-typed here — Design §10
 * and `scripts/check-guards.sh` allow a literal colour in `src/index.css` and nowhere else — so the
 * stylesheet is imported verbatim with Vite's `?raw` and the two token blocks are lifted out of it.
 * One source of truth, no drift, and the snapshot is themed exactly like the app that wrote it.
 */
import css from "../../index.css?raw";

export interface ThemeTokens {
  /** The body of `:root { … }`: every light-theme token declaration. */
  light: string;
  /** The body of `.dark { … }`: the dark overrides. */
  dark: string;
}

/**
 * The declarations of the first top-level `<selector> { … }` block, with the braces stripped.
 * Brace-counted rather than regexed so a nested block (none today) cannot cut the body short.
 */
export function cssBlock(source: string, selector: string): string {
  const head = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  const found = head.exec(source);
  if (!found) return "";
  const open = source.indexOf("{", found.index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i).trim();
    }
  }
  return "";
}

let cache: ThemeTokens | null = null;

/** The two token blocks, parsed once per session. */
export function designTokens(): ThemeTokens {
  if (!cache) cache = { light: cssBlock(css, ":root"), dark: cssBlock(css, ".dark") };
  return cache;
}
