/**
 * WCAG 2.x contrast maths over the token file (T5.6, Design §9). Parses the `:root` and `.dark`
 * blocks of `src/index.css` so the test always measures the palette that ships.
 */

export type Rgb = { r: number; g: number; b: number; a: number };

/** 3/4/6/8-digit hex and the rgb / rgba functional notation; anything else → null. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (hex?.[1]) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (fn) {
    return {
      r: Number(fn[1]),
      g: Number(fn[2]),
      b: Number(fn[3]),
      a: fn[4] === undefined ? 1 : Number(fn[4]),
    };
  }
  return null;
}

/** Source-over composite of `fg` (with alpha) on an opaque `bg`. */
export function composite(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

export function relativeLuminance(c: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio, 1..21. `fg` may be translucent; it is composited on `bg` first. */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const f = relativeLuminance(composite(fg, bg));
  const b = relativeLuminance(bg);
  const [hi, lo] = f > b ? [f, b] : [b, f];
  return (hi + 0.05) / (lo + 0.05);
}

export type Palette = Record<string, string>;

/** Extracts `--token: value;` declarations from one CSS block (`:root { … }` or `.dark { … }`). */
export function parseTokenBlock(css: string, selector: string): Palette {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  const end = css.indexOf("\n}", start);
  const block = css.slice(start, end);
  const out: Palette = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    if (m[1] && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

export interface Pair {
  fg: string;
  bg: string;
  /** Minimum ratio this pair must meet (4.5 body text, 3 large text / UI). */
  min: number;
}

/** Design §9 first bullet: every text/background pairing the UI actually renders. */
export const TEXT_PAIRS: Pair[] = [
  { fg: "ink", bg: "bg", min: 4.5 },
  { fg: "ink", bg: "surface", min: 4.5 },
  { fg: "ink", bg: "surface-raised", min: 4.5 },
  { fg: "muted", bg: "bg", min: 4.5 },
  { fg: "muted", bg: "surface", min: 4.5 },
  { fg: "muted", bg: "surface-raised", min: 4.5 },
  { fg: "accent", bg: "bg", min: 4.5 },
  { fg: "accent", bg: "surface", min: 4.5 },
  { fg: "accent", bg: "accent-subtle", min: 4.5 },
  { fg: "success", bg: "bg", min: 4.5 },
  { fg: "danger", bg: "bg", min: 4.5 },
  { fg: "on-accent", bg: "success", min: 4.5 },
  { fg: "ink", bg: "diff-add-bg", min: 4.5 },
  { fg: "ink", bg: "diff-del-bg", min: 4.5 },
  { fg: "ink", bg: "diff-add-num", min: 4.5 },
  { fg: "ink", bg: "diff-del-num", min: 4.5 },
  { fg: "ink", bg: "diff-hunk-bg", min: 4.5 },
  { fg: "diff-hunk-ink", bg: "diff-hunk-bg", min: 4.5 },
  { fg: "ink", bg: "banner-warning-bg", min: 4.5 },
  { fg: "ink", bg: "banner-info-bg", min: 4.5 },
  { fg: "ink", bg: "banner-error-bg", min: 4.5 },
  { fg: "ink", bg: "accent-subtle", min: 4.5 },
];

/** Small coloured labels (status squares, chips, badges): reported, and held to the 4.5 bar too. */
export const LABEL_PAIRS: Pair[] = [
  ...["m", "a", "d", "r", "t"].map((s) => ({
    fg: `status-${s}-fg`,
    bg: `status-${s}-bg`,
    min: 4.5,
  })),
  ...["staged", "unstaged", "untracked", "conflict", "generated"].map((c) => ({
    fg: `chip-${c}-fg`,
    bg: `chip-${c}-bg`,
    min: 4.5,
  })),
  ...["head", "default", "remote"].map((b) => ({
    fg: `badge-${b}-fg`,
    bg: `badge-${b}-bg`,
    min: 4.5,
  })),
];

export interface Measurement extends Pair {
  theme: string;
  ratio: number;
  ok: boolean;
}

export function measure(palette: Palette, theme: string, pairs: Pair[]): Measurement[] {
  return pairs.map((p) => {
    const fg = parseColor(palette[p.fg] ?? "");
    const bg = parseColor(palette[p.bg] ?? "");
    if (!fg || !bg) throw new Error(`${theme}: cannot parse --${p.fg} / --${p.bg}`);
    const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
    return { ...p, theme, ratio, ok: ratio >= p.min };
  });
}
