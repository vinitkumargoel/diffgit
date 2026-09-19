/**
 * Git LFS pointer files (T10.12, atlas tab 19).
 *
 * A file tracked by `filter=lfs` is stored in git as a tiny text stand-in; the real bytes live on
 * an LFS server that this application never contacts (D16 is about writes, but the privacy claim
 * is about reads too: nothing leaves the machine). All the diff can honestly say is "this is a
 * pointer, here is the object it names and how big it claims to be", which is what atlas tab 19's
 * LFS card renders instead of three lines of raw pointer text.
 *
 * The format is the one `git-lfs` documents (`docs/spec.md`):
 *
 * ```
 * version https://git-lfs.github.com/spec/v1
 * oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
 * size 12345
 * ```
 *
 * with `\n` terminators, the `version` line first, the remaining keys sorted, and a total size
 * under 1 KiB. The parser is deliberately strict about `version`, `oid` and `size` and tolerant
 * about everything else (extra keys are allowed by the spec), and it accepts CRLF because a patch
 * or a checkout on Windows may have rewritten the terminators.
 */

/** What a pointer names: the LFS object and the size of the file it stands for, in bytes. */
export interface LfsPointer {
  /** The full `sha256:<64 hex>` object id, exactly as the pointer spells it. */
  oid: string;
  size: number;
}

export const LFS_VERSION_LINE = "version https://git-lfs.github.com/spec/v1";
/** The spec caps a pointer at 1024 bytes; anything larger is a normal file that starts like one. */
export const LFS_POINTER_MAX_BYTES = 1024;

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * The pointer a blob holds, or null when it is not one. Bytes rather than text on purpose: this
 * runs before `describeFile` decides whether the file is binary, so a `-text` attribute (which
 * every real `.gitattributes` LFS line carries) does not hide the pointer.
 */
export function parseLfsPointer(bytes: Uint8Array | null): LfsPointer | null {
  if (bytes === null || bytes.length === 0 || bytes.length > LFS_POINTER_MAX_BYTES) return null;
  // A NUL byte means binary content that happens to be short; never a pointer.
  for (const b of bytes) if (b === 0) return null;
  return parseLfsPointerText(decoder.decode(bytes));
}

/** The same check on already-decoded text (the patch parser has no bytes to hand). */
export function parseLfsPointerText(text: string): LfsPointer | null {
  if (text.length === 0 || text.length > LFS_POINTER_MAX_BYTES) return null;
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 3 || lines[0] !== LFS_VERSION_LINE) return null;
  let oid: string | null = null;
  let size: number | null = null;
  for (const line of lines.slice(1)) {
    const sp = line.indexOf(" ");
    if (sp <= 0) return null; // every line after `version` is `<key> <value>`
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "oid") {
      if (!/^sha256:[0-9a-f]{64}$/.test(value)) return null;
      oid = value;
    } else if (key === "size") {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
      size = Number(value);
    }
  }
  if (oid === null || size === null || !Number.isSafeInteger(size)) return null;
  return { oid, size };
}
