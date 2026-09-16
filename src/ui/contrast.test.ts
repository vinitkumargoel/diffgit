import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  LABEL_PAIRS,
  measure,
  parseColor,
  parseTokenBlock,
  TEXT_PAIRS,
} from "./contrast";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");
const light = parseTokenBlock(css, ":root");
const dark = parseTokenBlock(css, ".dark");

describe("token file", () => {
  it("defines the same tokens in :root and .dark, and every Design §3 token exists", () => {
    const l = Object.keys(light).sort();
    const d = Object.keys(dark).sort();
    expect(d).toEqual(l);
    for (const t of [
      "bg",
      "surface",
      "surface-raised",
      "line",
      "ink",
      "muted",
      "accent",
      "accent-subtle",
      "success",
      "danger",
      "attention",
      "done",
      "diff-add-bg",
      "diff-add-num",
      "diff-add-word",
      "diff-del-bg",
      "diff-del-num",
      "diff-del-word",
      "diff-hunk-bg",
      "diff-hunk-ink",
      "diff-ctx-num",
      "diff-empty",
      "checker-a",
      "checker-b",
      "backdrop",
      "shadow-popover",
    ])
      expect(light[t], t).toBeDefined();
  });

  it("contrast maths matches the WCAG reference points", () => {
    const black = parseColor("#000");
    const white = parseColor("#ffffff");
    if (!black || !white) throw new Error("parse");
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    const gray = parseColor("#767676");
    if (!gray) throw new Error("parse");
    expect(contrastRatio(gray, white)).toBeGreaterThanOrEqual(4.5);
    expect(parseColor("rgba(1, 4, 9, 0.5)")).toEqual({ r: 1, g: 4, b: 9, a: 0.5 });
    expect(parseColor("#ff818266")?.a).toBeCloseTo(0.4, 2);
    expect(parseColor("repeating-linear-gradient(x)")).toBeNull();
  });
});

describe("Design §9 contrast (both themes)", () => {
  it("every text pair is ≥ 4.5:1", () => {
    const results = [...measure(light, "light", TEXT_PAIRS), ...measure(dark, "dark", TEXT_PAIRS)];
    const failing = results
      .filter((r) => !r.ok)
      .map((r) => `${r.theme} --${r.fg} on --${r.bg} = ${r.ratio}`);
    expect(failing).toEqual([]);
  });

  it("every status / chip / badge label is ≥ 4.5:1", () => {
    const results = [
      ...measure(light, "light", LABEL_PAIRS),
      ...measure(dark, "dark", LABEL_PAIRS),
    ];
    const failing = results
      .filter((r) => !r.ok)
      .map((r) => `${r.theme} --${r.fg} on --${r.bg} = ${r.ratio}`);
    expect(failing).toEqual([]);
  });
});
