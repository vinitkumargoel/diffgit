/**
 * Spike S1 side measurement: cost of Shiki 4 with the JavaScript regex engine (no WASM, no
 * network) — bundle size of core + engine + two themes, per-language chunk size, and time to
 * tokenise the 200-line TypeScript case. This is the highlighting stack the chosen renderer uses.
 */
import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { CASES } from "./cases";

const out = document.getElementById("out");
const t0 = performance.now();
const highlighter = await createHighlighterCore({
  themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
  langs: [import("@shikijs/langs/typescript")],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});
const t1 = performance.now();
const ts = CASES[0];
if (!ts) throw new Error("no case");
const tokens = highlighter.codeToTokensBase(ts.newText, {
  lang: "typescript",
  theme: "github-light",
});
const t2 = performance.now();
const result = {
  initMs: +(t1 - t0).toFixed(1),
  tokeniseMs: +(t2 - t1).toFixed(1),
  lines: tokens.length,
  tokens: tokens.reduce((n, l) => n + l.length, 0),
};
if (out) out.textContent = JSON.stringify(result, null, 2);
(window as unknown as { __hl: typeof result }).__hl = result;
