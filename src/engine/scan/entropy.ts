/**
 * Shannon entropy in **bits per character** (T10.7, atlas tab 14 "How it works offline").
 *
 * The scanner uses it as a *second* signal only: a prefix rule fires first, and the entropy floor
 * (`SecretRule.entropyMin`, 3.8 bits/char) then separates a real random token from a placeholder.
 * Pure arithmetic over the string's own alphabet — no dictionary, no network, no allocation beyond
 * one small count map.
 */

/**
 * `-Σ p·log2(p)` over the characters of `s`, normalised per character.
 *
 * An empty string is 0. A string of one repeated character is 0 (`"AAAAAAAA"` → 0). A uniform
 * random base64url token is ≈ 5.5 and any real key comfortably clears 3.8; English prose sits
 * around 3.2–4.2 for short strings, which is why the floor is only ever applied *after* a shape
 * rule has already matched.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
