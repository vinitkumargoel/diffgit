/** Content-based binary sniffing, the same rule git uses (`buffer_is_binary`). Attributes are layered on by `classify`. */

/** git inspects at most the first 8000 bytes for a NUL. */
export const BINARY_SNIFF_BYTES = 8000;

export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** @deprecated alias kept for the rename detector; use `isBinary`. */
export const looksBinary = isBinary;

export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
  "avif",
  "apng",
  "tif",
  "tiff",
]);

/** Rendering hint only (SVG is text but still an image). */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
