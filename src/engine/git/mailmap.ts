/**
 * `.mailmap` — author identity folding (T10.9, atlas tab 13 "Author identity splits across emails").
 *
 * Pure: the caller reads the file, this module parses it and maps identities. Nothing here does
 * I/O, so `bun test` can drive it straight from strings.
 *
 * The four line forms of `gitmailmap(5)`:
 *
 * ```
 * Proper Name <commit@email.xx>                                          (1) fix the name
 * <proper@email.xx> <commit@email.xx>                                    (2) fix the email
 * Proper Name <proper@email.xx> <commit@email.xx>                        (3) fix both
 * Proper Name <proper@email.xx> Commit Name <commit@email.xx>            (4) fix both, for one name
 * ```
 *
 * The implementation follows git's `mailmap.c` (`read_mailmap_line`, `add_mapping`, `map_user`)
 * rather than the prose of `gitmailmap(5)`, because git's own output is this task's parity oracle.
 * The two disagree in exactly one place, verified with `git check-mailmap` on git 2.50:
 *
 * - the manual page says "the `#` character begins a comment to the end of line"; `mailmap.c` only
 *   skips a line whose **first** character is `#`. `Mid # hash <mid@x.example>` really does define
 *   a proper name containing a `#`, and `   # indented` is not a comment (it is dropped anyway,
 *   for having no `<`). We match the code.
 *
 * The rest, also verified against `git check-mailmap`:
 *
 * - a line with no `<…>` pair, or whose first email is empty, is ignored;
 * - commit-email lookup is case-insensitive and the replacement keeps the mapped spelling, while a
 *   form-1 line (name only) leaves the commit email exactly as it was written;
 * - the commit **name** of a form-4 line is matched case-insensitively but otherwise exactly
 *   (`  Form4   Commit` does not match `Form4 Commit`);
 * - a later line replaces an earlier one field by field: a form-1 line after a form-2 line for the
 *   same commit email overrides the name and keeps the mapped email;
 * - when an email has only form-4 entries and the commit name matches none of them, nothing is
 *   rewritten.
 */

/** Where git looks for the file, relative to the repository root. */
export const MAILMAP_FILE = ".mailmap";

/** An author or committer identity, before or after mapping. */
export interface Identity {
  name: string;
  email: string;
}

/** What one entry replaces; a null field is left as the commit wrote it. */
interface Replacement {
  name: string | null;
  email: string | null;
}

interface Entry {
  /** The replacement used when no `byName` entry matches (git's "simple" entry). */
  simple: Replacement | null;
  /** Lower-cased commit name → replacement (git's `namemap`, the form-4 entries). */
  byName: Map<string, Replacement>;
}

/**
 * A parsed `.mailmap`. Internal to the engine — it never crosses the worker boundary, so a class
 * with a lookup table is fine (tasks/README.md only constrains the shapes that are cloned).
 */
export class Mailmap {
  /** Lower-cased commit email → entry. */
  private readonly byEmail = new Map<string, Entry>();

  private constructor(lines: readonly string[]) {
    for (const line of lines) this.addLine(line);
  }

  /** An empty map: `map()` is the identity. Used when the repository has no `.mailmap`. */
  static empty(): Mailmap {
    return new Mailmap([]);
  }

  /** Parses the whole file. `null` (no such file) gives the empty map. */
  static parse(text: string | null): Mailmap {
    if (text === null || text.length === 0) return Mailmap.empty();
    return new Mailmap(text.split("\n"));
  }

  /** How many distinct commit emails the file maps; 0 means every `map()` is the identity. */
  get size(): number {
    return this.byEmail.size;
  }

  /**
   * git's `map_user`: look the commit email up, prefer a form-4 entry whose commit name matches,
   * fall back to the email-level entry, and leave anything it does not name untouched.
   */
  map(name: string, email: string): Identity {
    const entry = this.byEmail.get(email.toLowerCase());
    if (entry === undefined) return { name, email };
    const hit = entry.byName.get(name.toLowerCase()) ?? entry.simple;
    if (hit === null) return { name, email };
    return { name: hit.name ?? name, email: hit.email ?? email };
  }

  private addLine(raw: string): void {
    // mailmap.c reads with fgets and only tests buffer[0]; a `\r` from a CRLF file is trailing
    // whitespace after the last `>` and is dropped by the parser below.
    const line = raw.replace(/\r$/, "");
    if (line.length === 0 || line.startsWith("#")) return;

    const first = parseNameAndEmail(line, false);
    if (first === null) return;
    const second = parseNameAndEmail(first.rest, true);

    // git's add_mapping: with no second pair the one email on the line *is* the commit email.
    const newName = first.name;
    const newEmail = second === null ? null : first.email;
    const oldName = second === null ? null : second.name;
    const oldEmail = second === null ? first.email : second.email;

    const key = oldEmail.toLowerCase();
    let entry = this.byEmail.get(key);
    if (entry === undefined) {
      entry = { simple: null, byName: new Map() };
      this.byEmail.set(key, entry);
    }
    if (oldName === null) {
      // Field-by-field replacement, exactly as git does it: a later name-only line keeps the
      // email an earlier line mapped.
      const simple: Replacement = entry.simple ?? { name: null, email: null };
      if (newName !== null) simple.name = newName;
      if (newEmail !== null) simple.email = newEmail;
      entry.simple = simple;
    } else {
      entry.byName.set(oldName.toLowerCase(), { name: newName, email: newEmail });
    }
  }
}

interface Parsed {
  /** Trimmed text before the `<`, or null when there was none. */
  name: string | null;
  /** Between `<` and `>`; empty only when `allowEmptyEmail`. */
  email: string;
  /** What follows the `>`, for the second pair on the line. */
  rest: string;
}

/**
 * git's `parse_name_and_email`. Returns null when there is no `<…>` pair at all, or when the pair
 * is empty and `allowEmptyEmail` is false — which is why `Name <> <commit@x>` maps nothing.
 */
function parseNameAndEmail(buffer: string, allowEmptyEmail: boolean): Parsed | null {
  const left = buffer.indexOf("<");
  if (left < 0) return null;
  const right = buffer.indexOf(">", left + 1);
  if (right < 0) return null;
  if (!allowEmptyEmail && right === left + 1) return null;
  const name = buffer.slice(0, left).trim();
  return {
    name: name.length === 0 ? null : name,
    email: buffer.slice(left + 1, right),
    rest: buffer.slice(right + 1),
  };
}
