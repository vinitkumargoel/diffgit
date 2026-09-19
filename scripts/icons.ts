/**
 * T11.14: writes the PWA's PNG icons from the same geometry as `public/favicon.svg`.
 *
 * Chrome's install criteria want raster icons at 192 and 512 px plus a maskable one; the repository
 * has no rasteriser and adds no dependency for three files, so the four shapes of the favicon are
 * rendered here analytically (distance fields, 1-pixel antialiasing) and encoded as PNG with
 * `node:zlib`. Re-run with `bun run scripts/icons.ts` after editing `public/favicon.svg`; the
 * output is committed, because the build must not depend on this script.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../public/icons");

/** The favicon's three colours (`public/favicon.svg`; Design §3 `--bg`, `--ink`, `--success`). */
const INK: RGB = [0xe6, 0xed, 0xf3];
const BG: RGB = [0x0d, 0x11, 0x17];
const GREEN: RGB = [0x3f, 0xb9, 0x50];

type RGB = [number, number, number];
type Point = [number, number];

/** Distance from `p` to the segment `a`–`b`, in viewBox units. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const [px, py] = p;
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = px - a[0];
  const wy = py - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return Math.hypot(dx, dy);
}

/** The cubic `M22 12.6 c0 6 -12 3.4 -12 9` of the favicon, flattened to a polyline. */
function branchCurve(): Point[] {
  const p0: Point = [22, 12.6];
  const p1: Point = [22, 18.6];
  const p2: Point = [10, 16];
  const p3: Point = [10, 21.6];
  const points: Point[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const u = 1 - t;
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return points;
}

const CURVE = branchCurve();

/** Signed distance to a rounded rectangle centred on the 32-unit viewBox. */
function roundedRect(p: Point, half: number, radius: number): number {
  const qx = Math.abs(p[0] - 16) - (half - radius);
  const qy = Math.abs(p[1] - 16) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Signed distance to the polyline stroke (round caps and joins, like the SVG). */
function curveDistance(p: Point): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < CURVE.length; i++) {
    const d = segmentDistance(p, CURVE[i - 1] as Point, CURVE[i] as Point);
    if (d < best) best = d;
  }
  return best;
}

/** Paints one pixel: the layers of `favicon.svg`, back to front, with 1-pixel coverage blending. */
function shade(p: Point, unitsPerPixel: number, maskable: boolean): RGB {
  const aa = (distance: number): number => Math.min(1, Math.max(0, 0.5 - distance / unitsPerPixel));
  // A maskable icon must survive a circular crop, so its background is the whole square.
  const background = maskable ? 1 : aa(roundedRect(p, 16, 7));
  let colour: RGB = [
    Math.round(BG[0] * background),
    Math.round(BG[1] * background),
    Math.round(BG[2] * background),
  ];
  const over = (layer: RGB, coverage: number): void => {
    if (coverage <= 0) return;
    colour = [
      Math.round(colour[0] * (1 - coverage) + layer[0] * coverage),
      Math.round(colour[1] * (1 - coverage) + layer[1] * coverage),
      Math.round(colour[2] * (1 - coverage) + layer[2] * coverage),
    ];
  };
  over(INK, aa(segmentDistance(p, [10, 10.5], [10, 21.5]) - 1.2));
  over(GREEN, aa(curveDistance(p) - 1.2));
  over(INK, aa(Math.hypot(p[0] - 10, p[1] - 8) - 2.6));
  over(INK, aa(Math.hypot(p[0] - 10, p[1] - 24) - 2.6));
  over(GREEN, aa(Math.hypot(p[0] - 22, p[1] - 10) - 2.6));
  return colour;
}

/** RGBA pixels of one icon; `inset` shrinks the artwork into a maskable icon's safe zone. */
function render(size: number, maskable: boolean): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const scale = maskable ? 0.7 : 1; // 80 % safe zone, with a little air
  const unitsPerPixel = 32 / size / scale;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p: Point = [
        ((x + 0.5) / size - 0.5) * (32 / scale) + 16,
        ((y + 0.5) / size - 0.5) * (32 / scale) + 16,
      ];
      const [r, g, b] = shade(p, unitsPerPixel, maskable);
      const at = (y * size + x) * 4;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
      // Only the rounded corners are transparent; a maskable icon is opaque everywhere.
      pixels[at + 3] = maskable
        ? 255
        : Math.round(255 * Math.min(1, Math.max(0, 0.5 - roundedRect(p, 16, 7) / unitsPerPixel)));
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/** Minimal 8-bit RGBA PNG: one IHDR, one deflated IDAT, one IEND. */
function encodePng(size: number, pixels: Uint8Array): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, size);
  header.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const ICONS = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
] as const;

mkdirSync(OUT, { recursive: true });
for (const icon of ICONS) {
  const png = encodePng(icon.size, render(icon.size, icon.maskable));
  writeFileSync(resolve(OUT, icon.file), png);
  console.log(
    `${icon.file}  ${icon.size}×${icon.size}  ${png.length} B  sha256:${createHash("sha256")
      .update(png)
      .digest("hex")
      .slice(0, 12)}`,
  );
}
