/**
 * T10.12 — Git LFS pointers (atlas tab 19).
 *
 * `fixtures/lfs` commits the pointer text git really stores (no `git lfs` binary is involved — the
 * filter that would swap a pointer for the real object is exactly what diffgit never runs), with
 * `.gitattributes` marking `*.psd` as `filter=lfs merge=lfs binary` and `*.dat` as `filter=lfs`
 * only. So the fixture covers all three shapes at once: a pointer on both sides of a row that is
 * **binary** as well, a pointer added on one side only in an ordinary text row, and a file that is
 * not a pointer at all and must not be mistaken for one.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath } from "../../test/fixtures";
import type { FileClassification, ProgressSink } from "../api";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { DiffSource, RepoWarning } from "../types";
import {
  LFS_POINTER_MAX_BYTES,
  LFS_VERSION_LINE,
  parseLfsPointer,
  parseLfsPointerText,
} from "./lfs";
import { describeFile } from "./textDiff";

const encoder = new TextEncoder();
const OID_A = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const OID_B = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";
const OID_C = "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752";

function pointer(oid: string, size: number): string {
  return `${LFS_VERSION_LINE}\noid sha256:${oid}\nsize ${size}\n`;
}

const FEATURE_VS_MAIN: DiffSource = {
  kind: "branches",
  source: "feature",
  target: "main",
  sourceRef: "refs/heads/feature",
  targetRef: "refs/heads/main",
  includeWorktree: false,
};

async function classifications(): Promise<{
  rows: Record<string, FileClassification>;
  warnings: RepoWarning[];
}> {
  const warnings: RepoWarning[] = [];
  const sink: ProgressSink = {
    onProgress() {},
    onStats() {},
    onWarning(w) {
      warnings.push(w);
    },
  };
  const session = await RepoSession.open(await NodeDirHandle.open(fixturePath("lfs")), sink, {
    id: "t10-12-lfs",
  });
  warnings.push(...(await session.info()).warnings);
  const result = await session.computeDiff(FEATURE_VS_MAIN);
  const rows: Record<string, FileClassification> = {};
  for (const f of result.files) {
    rows[f.id] = (
      await session.fileDiff(result.generation, f.id, { ignoreWhitespace: false })
    ).classification;
  }
  await session.close();
  return { rows, warnings };
}

describe("describeFile surfaces LFS pointers", () => {
  test("a pointer on both sides reports the new side's object", async () => {
    const { rows } = await classifications();
    expect(rows["assets/hero.psd"]?.lfs).toEqual({ oid: `sha256:${OID_B}`, size: 12_900_000 });
    // The `binary` macro: the row is a binary row *and* an LFS row, which is the card atlas tab
    // 19 draws. The pointer is sniffed before the binary gate, so both survive.
    expect(rows["assets/hero.psd"]?.binary).toBe(true);
  });

  test("a pointer added on one side only is still parsed", async () => {
    const { rows } = await classifications();
    expect(rows["data/table.dat"]?.lfs).toEqual({ oid: `sha256:${OID_C}`, size: 5_242_880 });
    // `*.dat` is only `filter=lfs`, so this is an ordinary text row that happens to be a pointer.
    expect(rows["data/table.dat"]?.binary).toBe(false);
  });

  test("an ordinary file has no `lfs` field at all", async () => {
    const { rows } = await classifications();
    expect(rows["notes.txt"]?.lfs).toBeUndefined();
    expect(Object.hasOwn(rows["notes.txt"] as FileClassification, "lfs")).toBe(false);
  });

  test("the repository still raises LFS_PRESENT on open", async () => {
    const { warnings } = await classifications();
    expect(warnings.filter((w) => w.code === "LFS_PRESENT")).toHaveLength(1);
  });

  test("a deleted LFS file reports the object its old side pointed at", () => {
    // Only the old side is a pointer, which is what a `git rm`'d LFS file looks like.
    const described = describeFile(
      {
        id: "assets/hero.psd",
        oldPath: "assets/hero.psd",
        newPath: null,
        status: "deleted",
        layers: ["committed"],
        oldOid: "1".repeat(40),
        newOid: null,
        oldMode: 0o100644,
        newMode: null,
        binary: false,
        image: false,
        oldSize: 0,
        newSize: 0,
        stats: null,
        tooLarge: false,
      },
      { kind: "file", old: encoder.encode(pointer(OID_A, 12_400_000)), new: null },
      { ignoreWhitespace: false },
    );
    expect(described.classification.lfs).toEqual({ oid: `sha256:${OID_A}`, size: 12_400_000 });
  });
});

describe("parseLfsPointer", () => {
  test("the canonical three-line pointer", () => {
    expect(parseLfsPointer(encoder.encode(pointer(OID_A, 12_400_000)))).toEqual({
      oid: `sha256:${OID_A}`,
      size: 12_400_000,
    });
  });

  test("extra keys are allowed; the required ones are not optional", () => {
    expect(
      parseLfsPointerText(`${LFS_VERSION_LINE}\next-0-sha256 abc\noid sha256:${OID_A}\nsize 7\n`),
    ).toEqual({ oid: `sha256:${OID_A}`, size: 7 });
    expect(parseLfsPointerText(`${LFS_VERSION_LINE}\noid sha256:${OID_A}\n`)).toBeNull();
    expect(parseLfsPointerText(`${LFS_VERSION_LINE}\nsize 7\nzz 1\n`)).toBeNull();
  });

  test("CRLF terminators and a missing final newline", () => {
    expect(
      parseLfsPointerText(`${LFS_VERSION_LINE}\r\noid sha256:${OID_A}\r\nsize 3\r\n`),
    ).not.toBeNull();
    expect(parseLfsPointerText(`${LFS_VERSION_LINE}\noid sha256:${OID_A}\nsize 3`)).not.toBeNull();
  });

  test("rejects anything that is not a pointer", () => {
    expect(parseLfsPointer(null)).toBeNull();
    expect(parseLfsPointer(new Uint8Array())).toBeNull();
    expect(parseLfsPointerText("just some text\n")).toBeNull();
    // a v2 spec URL, a short oid, a non-sha256 algorithm, a negative size
    expect(
      parseLfsPointerText(
        `version https://git-lfs.github.com/spec/v2\noid sha256:${OID_A}\nsize 1\n`,
      ),
    ).toBeNull();
    expect(parseLfsPointerText(`${LFS_VERSION_LINE}\noid sha256:abc\nsize 1\n`)).toBeNull();
    expect(parseLfsPointerText(`${LFS_VERSION_LINE}\noid md5:${OID_A}\nsize 1\n`)).toBeNull();
    expect(parseLfsPointerText(`${LFS_VERSION_LINE}\noid sha256:${OID_A}\nsize -1\n`)).toBeNull();
    expect(parseLfsPointerText(`${LFS_VERSION_LINE}\noid sha256:${OID_A}\nsize 01\n`)).toBeNull();
  });

  test("binary content that starts like a pointer is not one", () => {
    const bytes = encoder.encode(pointer(OID_A, 1));
    bytes[bytes.length - 1] = 0;
    expect(parseLfsPointer(bytes)).toBeNull();
  });

  test("a file over the 1 KiB spec limit is not a pointer", () => {
    const padded = `${pointer(OID_A, 1)}${"x ".repeat(LFS_POINTER_MAX_BYTES)}\n`;
    expect(parseLfsPointer(encoder.encode(padded))).toBeNull();
  });
});
