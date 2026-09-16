/** Content-based binary sniffing, the same rule git uses (`buffer_is_binary`). T3.4 layers .gitattributes on top. */

/** git inspects at most the first 8000 bytes for a NUL. */
export const BINARY_SNIFF_BYTES = 8000;

export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
