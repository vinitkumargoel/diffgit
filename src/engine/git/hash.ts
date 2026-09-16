/**
 * Git blob hashing (T2.2): SHA-1 of `"blob <len>\0" + bytes`, via `crypto.subtle` for buffers and a
 * small incremental pure-JS SHA-1 for streams (`crypto.subtle.digest` cannot be fed chunk by chunk).
 */
import type { Oid } from "../types";

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] as number];
  return s;
}

export async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  const buf =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Uint8Array(await crypto.subtle.digest("SHA-1", buf as ArrayBuffer));
}

function blobHeader(size: number): Uint8Array {
  return new TextEncoder().encode(`blob ${size}\0`);
}

/** `git hash-object` of the given content. */
export async function hashBlob(bytes: Uint8Array): Promise<Oid> {
  const header = blobHeader(bytes.byteLength);
  const all = new Uint8Array(header.byteLength + bytes.byteLength);
  all.set(header, 0);
  all.set(bytes, header.byteLength);
  return toHex(await sha1(all));
}

/** Streaming variant for large files (> 8 MB): `size` must be the exact byte length of the stream. */
export async function hashBlobStream(
  stream: ReadableStream<Uint8Array>,
  size: number,
): Promise<Oid> {
  const h = new Sha1();
  h.update(blobHeader(size));
  const reader = stream.getReader();
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    h.update(value);
  }
  if (seen !== size) throw new Error(`hashBlobStream: expected ${size} bytes, streamed ${seen}`);
  return toHex(h.digest());
}

/** Compact incremental SHA-1 (FIPS 180-4). Used only where crypto.subtle cannot stream. */
export class Sha1 {
  private h0 = 0x67452301;
  private h1 = 0xefcdab89;
  private h2 = 0x98badcfe;
  private h3 = 0x10325476;
  private h4 = 0xc3d2e1f0;
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private totalLen = 0;
  private readonly w = new Int32Array(80);

  update(data: Uint8Array): this {
    let i = 0;
    this.totalLen += data.length;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.blockLen = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    const bitLen = this.totalLen * 8;
    const pad = new Uint8Array(this.blockLen < 56 ? 64 - this.blockLen : 128 - this.blockLen);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bitLen / 0x100000000));
    view.setUint32(pad.length - 4, bitLen >>> 0);
    this.update(pad);
    const out = new Uint8Array(20);
    const ov = new DataView(out.buffer);
    ov.setUint32(0, this.h0 >>> 0);
    ov.setUint32(4, this.h1 >>> 0);
    ov.setUint32(8, this.h2 >>> 0);
    ov.setUint32(12, this.h3 >>> 0);
    ov.setUint32(16, this.h4 >>> 0);
    return out;
  }

  private compress(buf: Uint8Array, off: number): void {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] =
        ((buf[j] as number) << 24) |
        ((buf[j + 1] as number) << 16) |
        ((buf[j + 2] as number) << 8) |
        (buf[j + 3] as number);
    }
    for (let t = 16; t < 80; t++) {
      const x =
        ((w[t - 3] as number) ^
          (w[t - 8] as number) ^
          (w[t - 14] as number) ^
          (w[t - 16] as number)) |
        0;
      w[t] = (x << 1) | (x >>> 31);
    }
    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + (w[t] as number)) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
  }
}

export const EMPTY_BLOB_OID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
