import { markEdits, tokenize } from "react-diff-view";
import type { TokenizeInput, TokenizeRequest, TokenizeResponse, TokenizeResult } from "./protocol";

type Tokenizer = (input: TokenizeInput) => Promise<TokenizeResult>;

let override: Tokenizer | null = null;
/** Test seam: replace the worker with a function. */
export function setTokenizer(t: Tokenizer | null): void {
  override = t;
}

/** Word-level marks only, on the calling thread — the fallback when no Worker is available. */
export function inlineTokenize(input: TokenizeInput): TokenizeResult {
  const source = input.oldSource === null ? {} : { oldSource: input.oldSource };
  return {
    tokens: tokenize(input.hunks, {
      highlight: false,
      enhancers: [markEdits(input.hunks, { type: "block" })],
      ...source,
    }),
    highlighted: false,
  };
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (r: TokenizeResult) => void; reject: (e: Error) => void }
>();

function workerAvailable(): boolean {
  return typeof Worker === "function" && import.meta.env.MODE !== "test";
}

function failAll(message: string): void {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (ev: MessageEvent<TokenizeResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.reqId);
    if (!p) return;
    pending.delete(msg.reqId);
    if (msg.type === "tokens") p.resolve({ tokens: msg.tokens, highlighted: msg.highlighted });
    else p.reject(new Error(msg.message));
  };
  w.onerror = () => {
    failAll("HIGHLIGHT_WORKER_CRASHED");
    w.terminate();
    worker = null;
  };
  worker = w;
  return w;
}

/**
 * Tokenises hunks (syntax colours + word-level edit marks) off the main thread. Falls back to
 * marks-only inline tokenisation when Workers are unavailable (tests) or the worker fails.
 */
export function tokenizeHunks(input: TokenizeInput): Promise<TokenizeResult> {
  if (override) return override(input);
  if (!workerAvailable()) return Promise.resolve(inlineTokenize(input));
  return new Promise<TokenizeResult>((resolve, reject) => {
    const reqId = ++seq;
    pending.set(reqId, { resolve, reject });
    const req: TokenizeRequest = { type: "tokenize", reqId, ...input };
    try {
      getWorker().postMessage(req);
    } catch (e) {
      pending.delete(reqId);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  }).catch(() => inlineTokenize(input));
}
