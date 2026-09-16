import { describe, expect, test } from "bun:test";
import {
  EngineError,
  errorCode,
  FS_CODES,
  fsError,
  INTERNAL_CODES,
  isEngineError,
  PUBLIC_CODES,
  WARNING_CODES,
} from "./errors";

describe("error registry", () => {
  test("code sets are disjoint between fs-tier and public-tier", () => {
    for (const c of FS_CODES) expect(PUBLIC_CODES).not.toContain(c);
    for (const c of INTERNAL_CODES) expect(PUBLIC_CODES).not.toContain(c);
  });

  test("no duplicate codes in any list", () => {
    for (const list of [FS_CODES, PUBLIC_CODES, WARNING_CODES]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  test("EngineError serialises to a plain object with code/message/hint", () => {
    const e = new EngineError("NOT_A_REPO", "no .git here", { hint: "Choose the repo root" });
    expect(e.toJSON()).toEqual({
      name: "EngineError",
      code: "NOT_A_REPO",
      message: "no .git here",
      hint: "Choose the repo root",
    });
    expect(isEngineError(e)).toBe(true);
    expect(isEngineError(JSON.parse(JSON.stringify(e)))).toBe(true);
    expect(errorCode(e)).toBe("NOT_A_REPO");
  });

  test("fsError is Node-shaped", () => {
    const e = fsError("ENOENT", ".git/HEAD", "open");
    expect(e.code).toBe("ENOENT");
    expect(e.errno).toBe(-2);
    expect(e.syscall).toBe("open");
    expect(e.path).toBe(".git/HEAD");
    expect(e).toBeInstanceOf(EngineError);
    expect(e.message).toContain("ENOENT");
  });
});
