import type { HunkData, HunkTokens } from "react-diff-view";

/** Main thread → highlight worker. */
export interface TokenizeRequest {
  type: "tokenize";
  reqId: number;
  /** Engine language id ("typescript", "text", …). */
  language: string;
  hunks: HunkData[];
  /**
   * Full old-side text when available and small enough: react-diff-view then tokenises whole
   * files (better grammar context, and expansions need no re-tokenising). Null → hunk text only.
   */
  oldSource: string | null;
}

export type TokenizeResponse =
  | { type: "tokens"; reqId: number; tokens: HunkTokens; highlighted: boolean }
  | { type: "error"; reqId: number; message: string };

export interface TokenizeResult {
  tokens: HunkTokens;
  /** False when the language has no grammar (word-level marks only). */
  highlighted: boolean;
}

export type TokenizeInput = Omit<TokenizeRequest, "type" | "reqId">;
