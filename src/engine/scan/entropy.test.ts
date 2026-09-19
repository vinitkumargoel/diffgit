/**
 * T10.7: Shannon entropy in bits/char — the scanner's second signal.
 */
import { describe, expect, test } from "bun:test";
import { shannonEntropy } from "./entropy";

describe("shannonEntropy", () => {
  test("a single repeated character carries no information", () => {
    expect(shannonEntropy("AAAAAAAA")).toBe(0);
    expect(shannonEntropy("A")).toBe(0);
    expect(shannonEntropy("")).toBe(0);
  });

  test("the brief's two anchors: a planted random token > 3.8, AAAAAAAA < 1", () => {
    // The GitHub token planted in the `secrets` fixture.
    expect(shannonEntropy("ghp_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0")).toBeGreaterThan(3.8);
    expect(shannonEntropy("AAAAAAAA")).toBeLessThan(1);
  });

  test("a uniform alphabet is exactly log2(n) bits per character", () => {
    expect(shannonEntropy("ab")).toBeCloseTo(1, 10);
    expect(shannonEntropy("abcd")).toBeCloseTo(2, 10);
    expect(shannonEntropy("abcdefgh")).toBeCloseTo(3, 10);
    expect(shannonEntropy("aabb")).toBeCloseTo(1, 10);
  });

  test("it is scale-free: repeating a string does not change bits/char", () => {
    const s = "sk_live_0aB1cD2eF3gH4iJ5kL6mN7oP";
    expect(shannonEntropy(s.repeat(3))).toBeCloseTo(shannonEntropy(s), 10);
  });

  test("placeholders and prose stay under the 3.8 floor, real tokens clear it", () => {
    for (const weak of ["changeme", "xxxxxxxxxxxx", "your-token-here", "REPLACE_ME_PLEASE"]) {
      expect(shannonEntropy(weak)).toBeLessThan(3.8);
    }
    for (const strong of [
      "sk-ant-api03-7hQ2vLp9XcR4mZ0tK6yB3nW1dS8fA5gJ2eU7iO4rT9qY6xC3",
      "AKIAIOSFODNN7EXAMPLEbut5longer9and2random",
    ]) {
      expect(shannonEntropy(strong)).toBeGreaterThan(3.8);
    }
  });

  test("an 8-character value can never reach the floor (max 3 bits/char)", () => {
    expect(shannonEntropy("abcdefgh")).toBeLessThan(3.8);
  });
});
