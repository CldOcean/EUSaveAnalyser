/**
 * Shared loaders for the game's map assets, plus small colour helpers.
 *
 * Used by both the still-map renderer and the timeline renderer so the quirky
 * bits (bottom-up 24-bit BMP rows padded to 4 bytes, province colour table,
 * `sea_starts`/`lakes` lists) live in exactly one place.
 */
import { readFileSync } from 'node:fs';

export const EU4 = String.raw`D:\Software\Steam\Steam\steamapps\common\Europa Universalis IV`;
/** Steam workshop root for EU4 (appid 236850); each subdirectory is a mod. */
export const WORKSHOP_ROOT = String.raw`D:\Software\Steam\Steam\steamapps\workshop\content\236850`;
/** The Chinese Language Mod used by the sample save. */
export const MOD_LOCALISATION = `${WORKSHOP_ROOT}/2976470733/localisation`;

export type RGB = [number, number, number];

export interface ProvinceDef {
  id: number;
  rgb: RGB;
  name: string;
}

/** `map/definition.csv`: `id;r;g;b;internalName;x`. */
export function loadDefinitions(): Map<number, ProvinceDef> {
  const text = readFileSync(`${EU4}/map/definition.csv`, 'latin1');
  const out = new Map<number, ProvinceDef>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(';');
    if (parts.length < 5) continue;
    const id = Number(parts[0]);
    if (!Number.isInteger(id)) continue;
    out.set(id, {
      id,
      rgb: [Number(parts[1]), Number(parts[2]), Number(parts[3])],
      name: parts[4] ?? '',
    });
  }
  return out;
}

/** Packed 0xRRGGBB -> province id. */
export function colorToIdMap(definitions: Map<number, ProvinceDef>): Map<number, number> {
  const out = new Map<number, number>();
  for (const def of definitions.values()) {
    out.set((def.rgb[0] << 16) | (def.rgb[1] << 8) | def.rgb[2], def.id);
  }
  return out;
}

/** Parse a `{ 1 2 3 }` id list out of a map text file, ignoring `#` comments. */
export function parseIdSet(text: string, key: string): Set<number> {
  const out = new Set<number>();
  const start = text.indexOf(key);
  if (start < 0) return out;
  const open = text.indexOf('{', start);
  const close = text.indexOf('}', open);
  if (open < 0 || close < 0) return out;
  const body = text.slice(open + 1, close).replace(/#[^\n]*/g, ' ');
  for (const token of body.split(/\s+/)) {
    const n = Number(token);
    if (Number.isInteger(n)) out.add(n);
  }
  return out;
}

export interface WaterIds {
  sea: Set<number>;
  lakes: Set<number>;
  all: Set<number>;
}

/** Which province ids the game treats as sea or lakes (`map/default.map`). */
export function loadWaterIds(): WaterIds {
  const text = readFileSync(`${EU4}/map/default.map`, 'latin1');
  const sea = parseIdSet(text, 'sea_starts');
  const lakes = parseIdSet(text, 'lakes');
  return { sea, lakes, all: new Set([...sea, ...lakes]) };
}

/**
 * Decode `map/provinces.bmp` into one province id per pixel.
 * 24-bit, rows bottom-up, each row padded to a 4-byte boundary.
 */
export function loadProvincePixels(
  width: number,
  height: number,
  colorToId: Map<number, number>,
  options: { quiet?: boolean } = {},
): Uint16Array {
  const bmp = readFileSync(`${EU4}/map/provinces.bmp`);
  const bpp = bmp.readUInt16LE(28);
  if (bpp !== 24) throw new Error(`expected a 24-bit provinces.bmp, got ${bpp}`);
  const dataOffset = bmp.readUInt32LE(10);
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const ids = new Uint16Array(width * height);
  let unmatched = 0;
  for (let y = 0; y < height; y += 1) {
    const row = dataOffset + (height - 1 - y) * stride;
    const dst = y * width;
    for (let x = 0; x < width; x += 1) {
      const o = row + x * 3;
      const key =
        ((bmp[o + 2] as number) << 16) | ((bmp[o + 1] as number) << 8) | (bmp[o] as number);
      const id = colorToId.get(key);
      if (id === undefined) unmatched += 1;
      ids[dst + x] = id ?? 0;
    }
  }
  if (!options.quiet) {
    const total = width * height;
    console.log(
      `provinces.bmp decoded: ${width}x${height}, unmatched pixels ${unmatched.toLocaleString()} ` +
        `(${((unmatched / total) * 100).toFixed(2)}%)`,
    );
  }
  return ids;
}

/** Nearest-neighbour downsample by an integer factor. */
export function downscalePixels(
  ids: Uint16Array,
  width: number,
  height: number,
  factor: number,
): { ids: Uint16Array; width: number; height: number } {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const src = y * factor * width;
    const dst = y * w;
    for (let x = 0; x < w; x += 1) out[dst + x] = ids[src + x * factor] as number;
  }
  return { ids: out, width: w, height: h };
}

// ------------------------------------------------------------------ colours --

export function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

/** Stable, visually distinct colours for an unordered list of names. */
export function buildPalette(values: readonly string[]): Map<string, RGB> {
  const palette = new Map<string, RGB>();
  values.forEach((value, index) => {
    const hue = (index * 137.508) % 360;
    const saturation = 0.45 + ((index * 7) % 3) * 0.12;
    const lightness = 0.38 + ((index * 11) % 4) * 0.07;
    palette.set(value, hslToRgb(hue, saturation, lightness));
  });
  return palette;
}

/**
 * Fallback colour for a tag with no `map_color` in the save.
 *
 * The polynomial hash alone is *not* spread out: its low bits move almost
 * linearly with the characters, so `C00`..`C17` all landed within a few degrees
 * of each other and every colonial tint came out yellow. Mixing the bits first
 * (murmur3's fmix32) is what makes the hue depend on the whole hash.
 *
 * Keep this byte for byte identical to the copy in `apps/site/public/viewer-build.js`:
 * `viewer-build.test.ts` compares the two data planes key by key.
 */
export function hashColor(tag: string): RGB {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return hslToRgb((h >>> 0) % 360, 0.6, 0.45);
}

export function toHex(c: RGB): string {
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
