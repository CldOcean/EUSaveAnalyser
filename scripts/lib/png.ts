/**
 * Minimal PNG writer (truecolour, 8-bit, no interlacing).
 *
 * Deliberately dependency-free: a PNG is just a signature plus length-prefixed,
 * CRC32-checksummed chunks, and `node:zlib` already provides the deflate stream
 * the IDAT chunk needs.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode an 8-bit image as a PNG.
 *
 * @param data pixel bytes, row-major top-down, 3 (RGB) or 4 (RGBA) per pixel
 * @param channels 3 for truecolour, 4 for truecolour with alpha
 */
export function encodePng(
  width: number,
  height: number,
  data: Uint8Array,
  channels: 3 | 4 = 3,
): Buffer {
  const expected = width * height * channels;
  if (data.length !== expected) {
    throw new Error(`expected ${expected} bytes, got ${data.length}`);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type: truecolour (+ alpha)
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  // Each scanline is prefixed with a filter byte; 0 = "None" keeps it simple and
  // still compresses well, because these maps are made of large flat areas.
  const stride = width * channels;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  const source = Buffer.from(data.buffer, data.byteOffset, data.length);
  for (let y = 0; y < height; y += 1) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    source.copy(raw, dst + 1, y * stride, (y + 1) * stride);
  }

  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
