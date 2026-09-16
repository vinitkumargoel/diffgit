/**
 * Experiment only: what @git-diff-view/react would cost if its eager `lowlight(all)` (every
 * highlight.js grammar) were aliased away. Enabled with S1_STUB_LOWLIGHT=1 at build time.
 * Not a supported configuration of the library — it relies on an internal transitive package.
 */
const instance = {
  name: "stub",
  type: "class",
  maxLineToIgnoreSyntax: 0,
  setMaxLineToIgnoreSyntax(): void {},
  ignoreSyntaxHighlightList: [] as (string | RegExp)[],
  setIgnoreSyntaxHighlightList(): void {},
  getAST(): undefined {
    return undefined;
  },
  processAST(): { syntaxFileObject: Record<number, unknown>; syntaxFileLineNumber: number } {
    return { syntaxFileObject: {}, syntaxFileLineNumber: 0 };
  },
  hasRegisteredCurrentLang(): boolean {
    return false;
  },
  getHighlighterEngine(): null {
    return null;
  },
};

export const highlighter = instance;
export const versions = "0.1.7";
export function _getAST(): undefined {
  return undefined;
}
export function processAST(): {
  syntaxFileObject: Record<number, unknown>;
  syntaxFileLineNumber: number;
} {
  return { syntaxFileObject: {}, syntaxFileLineNumber: 0 };
}
