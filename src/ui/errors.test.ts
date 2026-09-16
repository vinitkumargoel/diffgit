import { describe, expect, it } from "vitest";
import { PUBLIC_CODES } from "../engine/errors";
import { describeError, toUiError } from "./errors";

describe("describeError", () => {
  it("has copy for exactly every public code", () => {
    for (const code of PUBLIC_CODES) {
      const d = describeError(code);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.message.length).toBeGreaterThan(0);
      expect(d.message).not.toContain(code); // never show raw codes
    }
  });

  it("falls back to INTERNAL for unknown or fs-tier codes", () => {
    expect(describeError("EROFS")).toEqual(describeError("INTERNAL"));
    expect(describeError(undefined)).toEqual(describeError("INTERNAL"));
  });

  it("toUiError normalises engine JSON, Error objects and strings", () => {
    expect(toUiError({ code: "NOT_A_REPO", message: "x", hint: "h" })).toEqual({
      code: "NOT_A_REPO",
      message: "x",
      hint: "h",
    });
    expect(toUiError(new Error("boom"))).toEqual({ code: "INTERNAL", message: "boom" });
    expect(toUiError("str").code).toBe("INTERNAL");
    expect(toUiError({ code: "ENOENT", message: "fs" }).code).toBe("INTERNAL");
  });
});
