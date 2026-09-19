/**
 * Tests for the flag TGA decoder.
 *
 * The decoder has to cope with every variant the game and its mods actually
 * ship — uncompressed and RLE, 16/24/32 bits, either origin — so the synthetic
 * cases below pin down each of those, and the last test checks the real files
 * when the game is installed on this machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { decodeBmp, decodeTga, isBlankFlag, scaleBox, sniffFormat } from '../../../scripts/lib/flags.ts';
import { EU4, WORKSHOP_ROOT } from '../../../scripts/lib/map-assets.ts';

function header(width: number, height: number, depth: number, imageType: number, descriptor: number): Buffer {
  const buf = Buffer.alloc(18);
  buf[2] = imageType;
  buf.writeUInt16LE(width, 12);
  buf.writeUInt16LE(height, 14);
  buf[16] = depth;
  buf[17] = descriptor;
  return buf;
}

const px = (r: number, g: number, b: number, a = 255): number[] =>
  depthOf24(r, g, b, a);

function depthOf24(r: number, g: number, b: number, _a = 255): number[] {
  return [b, g, r]; // TGA stores BGR
}

test('decodes uncompressed 24-bit TGA and flips a bottom-left origin', () => {
  // 2x2. In the file the bottom row comes first: (0,0,255) (0,255,0) / then the
  // top row: (255,0,0) (255,255,255).
  const body = Buffer.from([
    ...px(0, 0, 255), ...px(0, 255, 0),
    ...px(255, 0, 0), ...px(255, 255, 255),
  ]);
  const image = decodeTga(Buffer.concat([header(2, 2, 24, 2, 0x00), body]));
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  const at = (x: number, y: number): number[] => {
    const i = (y * 2 + x) * 4;
    return [...image.rgba.slice(i, i + 4)];
  };
  assert.deepEqual(at(0, 0), [255, 0, 0, 255], 'top-left must be the red pixel');
  assert.deepEqual(at(1, 0), [255, 255, 255, 255]);
  assert.deepEqual(at(0, 1), [0, 0, 255, 255], 'bottom row must come last');
  assert.deepEqual(at(1, 1), [0, 255, 0, 255]);
});

test('decodes a top-left origin without flipping', () => {
  const body = Buffer.from([...px(255, 0, 0), ...px(0, 0, 255)]);
  // Descriptor bit 5 set = top-left origin.
  const image = decodeTga(Buffer.concat([header(2, 1, 24, 2, 0x20), body]));
  assert.deepEqual([...image.rgba.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...image.rgba.slice(4, 8)], [0, 0, 255, 255]);
});

test('decodes RLE packets, both raw and repeated', () => {
  // 3x1: one raw packet of 3 pixels (header 0x02), then a run of 2 identical
  // pixels (header 0x81 = RLE, count 2). Total 5 pixels -> use a 5x1 image.
  const body = Buffer.from([
    0x02, ...px(255, 0, 0), ...px(0, 255, 0), ...px(0, 0, 255),
    0x81, ...px(16, 32, 48),
  ]);
  const image = decodeTga(Buffer.concat([header(5, 1, 24, 10, 0x20), body]));
  assert.deepEqual([...image.rgba.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...image.rgba.slice(4, 8)], [0, 255, 0, 255]);
  assert.deepEqual([...image.rgba.slice(8, 12)], [0, 0, 255, 255]);
  assert.deepEqual([...image.rgba.slice(12, 16)], [16, 32, 48, 255], 'the run repeats');
  assert.deepEqual([...image.rgba.slice(16, 20)], [16, 32, 48, 255]);
});

test('decodes 32-bit alpha and 16-bit 5-5-5 colour', () => {
  const rgba = Buffer.from([9, 8, 7, 128]); // BGRA
  const image32 = decodeTga(Buffer.concat([header(1, 1, 32, 2, 0x20), rgba]));
  assert.deepEqual([...image32.rgba], [7, 8, 9, 128]);

  // 0x7C00 = opaque red in A1R5G5B5.
  const sixteen = Buffer.from([0x00, 0x7c]);
  const image16 = decodeTga(Buffer.concat([header(1, 1, 16, 2, 0x20), sixteen]));
  assert.deepEqual([...image16.rgba], [255, 0, 0, 255]);
});

test('decodes 8-bit palette and 8-bit grey TGAs (both appear in real mods)', () => {
  // Colour-mapped: 2x1, an 8-bit index per pixel, a 2-entry 24-bit colour map
  // that sits between the image id and the pixel data.
  const paletteHeader = header(2, 1, 8, 1, 0x20);
  paletteHeader[1] = 1; // colorMapType
  paletteHeader.writeUInt16LE(2, 5); // map length
  paletteHeader[7] = 24; // map entry size
  const paletteBody = Buffer.from([
    ...px(255, 0, 0), ...px(0, 0, 255), // map[0] red, map[1] blue
    1, 0, // pixels: index 1 then 0
  ]);
  const palette = decodeTga(Buffer.concat([paletteHeader, paletteBody]));
  assert.deepEqual([...palette.rgba.slice(0, 4)], [0, 0, 255, 255]);
  assert.deepEqual([...palette.rgba.slice(4, 8)], [255, 0, 0, 255]);

  // Greyscale (image type 3): one byte per pixel, replicated across RGB.
  const grey = decodeTga(Buffer.concat([header(2, 1, 8, 3, 0x20), Buffer.from([0, 200])]));
  assert.deepEqual([...grey.rgba.slice(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...grey.rgba.slice(4, 8)], [200, 200, 200, 255]);
});

test('sniffs the real format, because mods ship BMP/PNG/JPEG named .tga', () => {
  assert.equal(sniffFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
  assert.equal(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), 'jpeg');
  assert.equal(sniffFormat(Buffer.from([0x42, 0x4d, 0x38, 0xc0, 0, 0])), 'bmp');
  assert.equal(sniffFormat(header(2, 2, 24, 2, 0)), 'tga');
  assert.equal(sniffFormat(Buffer.from([1, 2, 7, 4, 5, 6])), 'unknown');
});

test('decodes an uncompressed 24-bit BMP', () => {
  // 2x2 BMP, bottom-up: file rows are bottom (blue, green) then top (red, white).
  // Each row is padded to a 4-byte boundary, so 2 pixels of 24bpp need 2 pad bytes.
  const pad = [0, 0];
  const pixels = Buffer.from([
    ...px(0, 0, 255), ...px(0, 255, 0), ...pad,
    ...px(255, 0, 0), ...px(255, 255, 255), ...pad,
  ]);
  const head = Buffer.alloc(14);
  head.write('BM', 0, 'latin1');
  head.writeUInt32LE(54 + pixels.length, 2);
  head.writeUInt32LE(54, 10);
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(2, 4); // width
  info.writeInt32LE(2, 8); // height (positive = bottom-up)
  info.writeUInt16LE(1, 12); // planes
  info.writeUInt16LE(24, 14); // bits per pixel
  const image = decodeBmp(Buffer.concat([head, info, pixels]));
  const at = (x: number, y: number): number[] => [...image.rgba.slice((y * 2 + x) * 4, (y * 2 + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [255, 0, 0, 255], 'top-left is red');
  assert.deepEqual(at(1, 0), [255, 255, 255, 255]);
  assert.deepEqual(at(0, 1), [0, 0, 255, 255], 'bottom row last');
  assert.deepEqual(at(1, 1), [0, 255, 0, 255]);
});

test('rejects formats the game never uses instead of returning garbage', () => {
  const badDepth = header(1, 1, 8, 2, 0);
  assert.throws(() => decodeTga(Buffer.concat([badDepth, Buffer.from([0])])), /depth/);
  const badType = header(1, 1, 24, 4, 0);
  assert.throws(() => decodeTga(Buffer.concat([badType, Buffer.from([0, 0, 0])])), /image type/);
  assert.throws(() => decodeBmp(Buffer.from([1, 2, 3, 4])), /not a BMP/);
});

test('scaleBox averages instead of sampling, and keeps the aspect of flat art', () => {
  // 2x2 checker of black and white downscaled to 1x1 must be mid grey.
  const image = decodeTga(
    Buffer.concat([
      header(2, 2, 24, 2, 0x20),
      Buffer.from([...px(255, 255, 255), ...px(0, 0, 0), ...px(0, 0, 0), ...px(255, 255, 255)]),
    ]),
  );
  const scaled = scaleBox(image, 1, 1);
  assert.deepEqual([...scaled.rgba], [128, 128, 128, 255]);
});

// ------------------------------------------------------------- real files ----
const GAME_FLAG = `${EU4}/gfx/flags/RUS.tga`;
const MOD_FLAG = `${WORKSHOP_ROOT}/3340627985/gfx/flags/RUS.tga`;

test('decodes the real game flags when the game is installed', { skip: !existsSync(GAME_FLAG) }, () => {
  const image = decodeTga(readFileSync(GAME_FLAG));
  assert.equal(image.width, 128);
  assert.equal(image.height, 128);
  assert.equal(image.rgba.length, 128 * 128 * 4);
  assert.equal(isBlankFlag(image), false, 'Russia must not decode to an empty flag');
  // A flag is colourful art, not a flat fill.
  const distinct = new Set<string>();
  for (let i = 0; i < image.rgba.length; i += 4) {
    distinct.add(`${image.rgba[i]},${image.rgba[i + 1]},${image.rgba[i + 2]}`);
  }
  assert.ok(distinct.size > 2, `expected real artwork, got ${distinct.size} colours`);
});

test('mod flags are a different image from the game ones', { skip: !existsSync(MOD_FLAG) }, () => {
  const base = readFileSync(GAME_FLAG);
  const modded = readFileSync(MOD_FLAG);
  const a = decodeTga(base);
  const b = decodeTga(modded);
  let same = a.rgba.length === b.rgba.length;
  if (same) {
    for (let i = 0; i < a.rgba.length; i += 1) {
      if (a.rgba[i] !== b.rgba[i]) {
        same = false;
        break;
      }
    }
  }
  assert.equal(same, false, 'the mod is expected to override at least one flag');
});
