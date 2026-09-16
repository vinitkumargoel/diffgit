/**
 * UI-owned highlight worker (ADR-001): Shiki 4 with the JavaScript regex engine (no WASM, no
 * network), grammars imported on demand, plus react-diff-view's `tokenize` + `markEdits` so the
 * main thread only receives ready-to-render token arrays. Independent from the engine worker.
 */
import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { markEdits, tokenize } from "react-diff-view";
import { GRAMMARS, type GrammarId, resolveGrammar } from "./grammars";
import type { TokenizeRequest, TokenizeResponse, TokenizeResult } from "./protocol";
import { makeRefractor } from "./shikiRefractor";

let hlPromise: Promise<HighlighterCore> | null = null;
const loaded = new Set<GrammarId>();
const failed = new Set<GrammarId>();

function highlighter(): Promise<HighlighterCore> {
  hlPromise ??= createHighlighterCore({
    themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return hlPromise;
}

async function ensureGrammar(id: GrammarId): Promise<boolean> {
  if (loaded.has(id)) return true;
  if (failed.has(id)) return false;
  try {
    const hl = await highlighter();
    await hl.loadLanguage(GRAMMARS[id]);
    loaded.add(id);
    return true;
  } catch {
    failed.add(id);
    return false;
  }
}

export async function tokenizeRequest(
  req: Pick<TokenizeRequest, "language" | "hunks" | "oldSource">,
): Promise<TokenizeResult> {
  const enhancers = [markEdits(req.hunks, { type: "block" })];
  const source = req.oldSource === null ? {} : { oldSource: req.oldSource };
  const id = resolveGrammar(req.language);
  if (id && (await ensureGrammar(id))) {
    const hl = await highlighter();
    return {
      tokens: tokenize(req.hunks, {
        highlight: true,
        refractor: makeRefractor(hl),
        language: id,
        enhancers,
        ...source,
      }),
      highlighted: true,
    };
  }
  return {
    tokens: tokenize(req.hunks, { highlight: false, enhancers, ...source }),
    highlighted: false,
  };
}

const post = (msg: TokenizeResponse) => (self as unknown as Worker).postMessage(msg);

self.addEventListener("message", (ev: MessageEvent<TokenizeRequest>) => {
  const req = ev.data;
  if (req?.type !== "tokenize") return;
  void tokenizeRequest(req)
    .then(({ tokens, highlighted }) =>
      post({ type: "tokens", reqId: req.reqId, tokens, highlighted }),
    )
    .catch((e: unknown) =>
      post({
        type: "error",
        reqId: req.reqId,
        message: e instanceof Error ? e.message : String(e),
      }),
    );
});
