import { describe, expect, test } from "bun:test";
import { type ExpectedHashObject, fixturePath, loadExpected } from "../../test/fixtures";
import { EMPTY_BLOB_OID, hashBlob, hashBlobStream, Sha1, sha1, toHex } from "./hash";

describe("hash", () => {
  test("empty blob", async () => {
    expect(await hashBlob(new Uint8Array(0))).toBe(EMPTY_BLOB_OID);
    expect(await hashBlobStream(new Blob([]).stream() as ReadableStream<Uint8Array>, 0)).toBe(
      EMPTY_BLOB_OID,
    );
  });

  test("hash-object.json parity on fixtures/basic and large", async () => {
    for (const name of ["basic", "large"]) {
      const expected = loadExpected<ExpectedHashObject>(name, "hash-object");
      for (const [path, oid] of Object.entries(expected)) {
        const bytes = await Bun.file(`${fixturePath(name)}/${path}`).bytes();
        expect(await hashBlob(bytes)).toBe(oid);
      }
    }
  });

  test("stream and buffer hashes agree on the 11 MB file", async () => {
    const file = Bun.file(`${fixturePath("large")}/huge.txt`);
    const bytes = await file.bytes();
    expect(bytes.byteLength).toBeGreaterThan(8 * 1024 * 1024);
    const viaStream = await hashBlobStream(
      file.stream() as ReadableStream<Uint8Array>,
      bytes.byteLength,
    );
    expect(viaStream).toBe(await hashBlob(bytes));
    expect(viaStream).toBe(
      loadExpected<ExpectedHashObject>("large", "hash-object")["huge.txt"] as string,
    );
  });

  test("pure-JS Sha1 matches crypto.subtle on awkward chunk boundaries", async () => {
    const data = new Uint8Array(200_003).map((_, i) => (i * 7919 + 13) & 0xff);
    const h = new Sha1();
    let off = 0;
    for (const n of [1, 63, 64, 65, 1000, 4096, 55, 56, 57, 100_000]) {
      h.update(data.subarray(off, off + n));
      off += n;
    }
    h.update(data.subarray(off));
    expect(toHex(h.digest())).toBe(toHex(await sha1(data)));
    // lengths around the padding boundary
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128]) {
      const d = data.subarray(0, len);
      expect(toHex(new Sha1().update(d).digest())).toBe(toHex(await sha1(d)));
    }
  });

  test("sha1 works on subarray views", async () => {
    const big = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(toHex(await sha1(big.subarray(2, 4)))).toBe(toHex(await sha1(new Uint8Array([3, 4]))));
  });

  test("hashBlobStream rejects when the size does not match", async () => {
    await expect(
      hashBlobStream(new Blob(["abc"]).stream() as ReadableStream<Uint8Array>, 5),
    ).rejects.toThrow(/expected 5/);
  });
});
