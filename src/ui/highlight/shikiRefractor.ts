import type { HighlighterCore } from "@shikijs/core";

/** Dual-theme Shiki output (Design §3.5 / §11): both colours travel with the token, CSS picks one. */
export interface ShNode {
  type: "sh";
  /** github-light colour */
  l?: string;
  /** github-dark colour */
  d?: string;
  children: [{ type: "text"; value: string }];
}
export type HastLike = ShNode | { type: "text"; value: string };

const THEMES = { light: "github-light", dark: "github-dark" } as const;
const LIGHT_VAR = "--shiki-light";
const DARK_VAR = "--shiki-dark";

/**
 * Tokenises `text` with Shiki into the flat hast-like node list react-diff-view's `tokenize`
 * expects from a `refractor.highlight` call: one `sh` node per token, lines separated by
 * `"\n"` text nodes (its `normalizeToLines` splits on those).
 */
export function shikiHighlight(hl: HighlighterCore, text: string, lang: string): HastLike[] {
  const { tokens } = hl.codeToTokens(text, { lang, themes: THEMES, defaultColor: false });
  const out: HastLike[] = [];
  tokens.forEach((line, i) => {
    if (i > 0) out.push({ type: "text", value: "\n" });
    for (const t of line) {
      if (t.content === "") continue;
      const style = t.htmlStyle ?? {};
      const node: ShNode = { type: "sh", children: [{ type: "text", value: t.content }] };
      if (style[LIGHT_VAR]) node.l = style[LIGHT_VAR];
      if (style[DARK_VAR]) node.d = style[DARK_VAR];
      out.push(node);
    }
  });
  return out;
}

/** The `refractor` option for react-diff-view's `tokenize({ highlight: true, refractor })`. */
export function makeRefractor(hl: HighlighterCore): {
  highlight: (text: string, lang: string) => HastLike[];
} {
  return { highlight: (text, lang) => shikiHighlight(hl, text, lang) };
}
