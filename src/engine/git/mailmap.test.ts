/**
 * T10.9: `.mailmap` parsing, one test per line form of `gitmailmap(5)` plus the behaviour that only
 * `mailmap.c` documents.
 *
 * Every expectation below was taken from `git check-mailmap` on git 2.50 against a scratch
 * repository holding exactly these lines — `check-mailmap` is `map_user`, so it is the same oracle
 * the `history` fixture gives at a larger scale in `insights.parity.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { Mailmap } from "./mailmap";

const map = (file: string, name: string, email: string) => Mailmap.parse(file).map(name, email);

describe("mailmap line forms", () => {
  test("form 1 `Proper Name <commit@email>` fixes the name and keeps the email verbatim", () => {
    const file = "Form1 Proper <f1@commit.example>\n";
    expect(map(file, "Whatever", "f1@commit.example")).toEqual({
      name: "Form1 Proper",
      email: "f1@commit.example",
    });
    // The lookup is case-insensitive but the commit's own spelling of the address survives.
    expect(map(file, "Whatever", "F1@COMMIT.EXAMPLE")).toEqual({
      name: "Form1 Proper",
      email: "F1@COMMIT.EXAMPLE",
    });
  });

  test("form 2 `<proper@email> <commit@email>` fixes the email and keeps the name", () => {
    const file = "<f2proper@x.example> <f2commit@x.example>\n";
    expect(map(file, "Whatever", "f2commit@x.example")).toEqual({
      name: "Whatever",
      email: "f2proper@x.example",
    });
  });

  test("form 3 `Proper Name <proper@email> <commit@email>` fixes both", () => {
    const file = "Form3 Proper <f3proper@x.example> <f3commit@x.example>\n";
    expect(map(file, "Whatever", "f3commit@x.example")).toEqual({
      name: "Form3 Proper",
      email: "f3proper@x.example",
    });
  });

  test("form 4 `Proper <proper@> Commit Name <commit@>` only fires for that commit name", () => {
    const file =
      "Form4 Proper <f4proper@x.example> Form4 Commit <f4commit@x.example>\n" +
      "Default For F4 <f4default@x.example> <f4commit@x.example>\n";
    expect(map(file, "Form4 Commit", "f4commit@x.example")).toEqual({
      name: "Form4 Proper",
      email: "f4proper@x.example",
    });
    // Name matching is case-insensitive …
    expect(map(file, "FORM4 COMMIT", "f4commit@x.example")).toEqual({
      name: "Form4 Proper",
      email: "f4proper@x.example",
    });
    // … but otherwise exact: internal whitespace is not normalised, so this falls through.
    expect(map(file, "Form4   Commit", "f4commit@x.example")).toEqual({
      name: "Default For F4",
      email: "f4default@x.example",
    });
    expect(map(file, "Someone Else", "f4commit@x.example")).toEqual({
      name: "Default For F4",
      email: "f4default@x.example",
    });
  });

  test("a form-4 entry with no email-level fallback leaves an unmatched name alone", () => {
    const file = "Form4 Proper <f4proper@x.example> Form4 Commit <f4commit@x.example>\n";
    expect(map(file, "Someone Else", "f4commit@x.example")).toEqual({
      name: "Someone Else",
      email: "f4commit@x.example",
    });
  });
});

describe("mailmap parsing rules", () => {
  test("a leading `#` is a comment; a `#` later in the line is part of the name", () => {
    // `gitmailmap(5)` says "# begins a comment to the end of line"; mailmap.c only tests the first
    // character, and `git check-mailmap` agrees with the code.
    const file = "# Ignored Name <ignored@x.example>\nMid # hash inside <mid@x.example>\n";
    expect(map(file, "Whatever", "ignored@x.example")).toEqual({
      name: "Whatever",
      email: "ignored@x.example",
    });
    expect(map(file, "Whatever", "mid@x.example").name).toBe("Mid # hash inside");
  });

  test("blank lines, lines with no `<…>`, and an empty first email are ignored", () => {
    const file = "\n   \nNoAngle line without brackets\nEmpty Email <> <ee@x.example>\n";
    expect(Mailmap.parse(file).size).toBe(0);
    expect(map(file, "Whatever", "ee@x.example")).toEqual({
      name: "Whatever",
      email: "ee@x.example",
    });
  });

  test("names are trimmed and a CRLF file parses the same as an LF one", () => {
    const file = "   Leading And Trailing   <ls@x.example>   \r\n";
    expect(map(file, "Whatever", "ls@x.example")).toEqual({
      name: "Leading And Trailing",
      email: "ls@x.example",
    });
  });

  test("a later line replaces field by field, not wholesale", () => {
    const file = "<mapped@x.example> <c@x.example>\nEven Later <c@x.example>\n";
    // The name-only line overrides the name and keeps the email the earlier line mapped.
    expect(map(file, "Whatever", "c@x.example")).toEqual({
      name: "Even Later",
      email: "mapped@x.example",
    });
  });

  test("an unknown email, an empty file and a missing file are all the identity", () => {
    expect(map("Form1 <f1@x.example>\n", "Nobody", "other@x.example")).toEqual({
      name: "Nobody",
      email: "other@x.example",
    });
    expect(Mailmap.parse(null).map("A", "a@x")).toEqual({ name: "A", email: "a@x" });
    expect(Mailmap.parse("").size).toBe(0);
    expect(Mailmap.empty().map("A", "a@x")).toEqual({ name: "A", email: "a@x" });
  });
});
