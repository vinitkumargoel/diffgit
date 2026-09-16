import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { markEdits, tokenize } from "react-diff-view";
import { beforeAll, describe, expect, it } from "vitest";
import { toHunkData } from "../diff/toHunkData";
import { mockHunks } from "../mock/mockContents";
import { GRAMMARS, resolveGrammar } from "./grammars";
import { inlineTokenize } from "./highlightClient";
import { makeRefractor, shikiHighlight } from "./shikiRefractor";

let hl: HighlighterCore;
beforeAll(async () => {
  hl = await createHighlighterCore({
    themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
    langs: [GRAMMARS.typescript],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
});

describe("shikiRefractor", () => {
  it("emits sh nodes with both theme colours and newline text separators", () => {
    const nodes = shikiHighlight(hl, "const a = 1;\nlet b;", "typescript");
    const text = nodes.map((n) => (n.type === "text" ? n.value : n.children[0].value)).join("");
    expect(text).toBe("const a = 1;\nlet b;");
    expect(nodes.filter((n) => n.type === "text" && n.value === "\n")).toHaveLength(1);
    const keyword = nodes.find((n) => n.type === "sh" && n.children[0].value === "const");
    expect(keyword?.type).toBe("sh");
    if (keyword?.type === "sh") {
      expect(keyword.l).toMatch(/^#[0-9a-f]{6}$/i);
      expect(keyword.d).toMatch(/^#[0-9a-f]{6}$/i);
      expect(keyword.l).not.toBe(keyword.d);
    }
  });

  it("feeds react-diff-view's tokenize with highlight + markEdits", () => {
    const oldText = "const a = 1;\nconst b = 2;\nexport { a, b };\n";
    const newText = "const a = 1;\nconst b = 3;\nexport { a, b };\n";
    const hunks = toHunkData(mockHunks(oldText, newText));
    const tokens = tokenize(hunks, {
      highlight: true,
      refractor: makeRefractor(hl),
      language: "typescript",
      oldSource: oldText,
      enhancers: [markEdits(hunks, { type: "block" })],
    });
    // whole-file tokens: one entry per line (the trailing newline yields an empty last line)
    expect(tokens.old.length).toBeGreaterThanOrEqual(3);
    expect(tokens.new.length).toBe(tokens.old.length);
    const flat = JSON.stringify(tokens.new[1]);
    expect(flat).toContain('"type":"sh"');
    expect(flat).toContain('"type":"edit"');
  });

  it("inlineTokenize marks edits without a highlighter; resolveGrammar maps aliases", () => {
    const hunks = toHunkData(mockHunks("a b c\n", "a X c\n"));
    const r = inlineTokenize({ language: "text", hunks, oldSource: null });
    expect(r.highlighted).toBe(false);
    expect(JSON.stringify(r.tokens.new[0])).toContain('"type":"edit"');
    expect(resolveGrammar("ts")).toBe("typescript");
    expect(resolveGrammar("TypeScript")).toBe("typescript");
    expect(resolveGrammar("text")).toBeNull();
    expect(resolveGrammar("bash")).toBe("shellscript");
  });
});
