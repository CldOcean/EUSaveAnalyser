/**
 * Country flags, read straight out of the game and the save's enabled mods.
 *
 * EU4 ships one TGA per tag in `gfx/flags/<TAG>.tga`, and mods ship their own
 * copies that override the base game. The files are a mix of formats, so the
 * decoder has to handle all of what the game actually uses rather than one case:
 *
 *   * image type 2  — uncompressed true-colour
 *   * image type 10 — RLE true-colour
 *   * 16 / 24 / 32 bits per pixel
 *   * bottom-left origin (the usual case) as well as top-left
 *
 * Mods matter: on this machine 27 workshop mods ship 14,550 flag files covering
 * 7,059 tags, and the save lists which of them were enabled and in what order.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { EU4, WORKSHOP_ROOT } from './map-assets.ts';

export interface FlagImage {
  width: number;
  height: number;
  /** RGBA, top-left origin, `width * height * 4` bytes. */
  rgba: Uint8Array;
}

/**
 * What a flag file actually is. Mod authors ship BMP, PNG and JPEG files with a
 * `.tga` extension, so the content has to be sniffed instead of trusted.
 */
export type FlagFormat = 'tga' | 'bmp' | 'png' | 'jpeg' | 'unknown';

export function sniffFormat(buffer: Buffer): FlagFormat {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length > 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  // TGA has no magic; accept the header shapes the game actually uses.
  const type = buffer[2] as number;
  if ([1, 2, 3, 9, 10, 11].includes(type)) return 'tga';
  return 'unknown';
}

/** Decode an uncompressed or RLE 24/32-bit, 8-bit palette, or 8-bit grey TGA. */
export function decodeTga(buffer: Buffer): FlagImage {
  const idLength = buffer[0] as number;
  const colorMapType = buffer[1] as number;
  const imageType = buffer[2] as number;
  const mapFirst = buffer.readUInt16LE(3);
  const mapLength = buffer.readUInt16LE(5);
  const mapEntrySize = buffer[7] as number;
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  const depth = buffer[16] as number;
  const descriptor = buffer[17] as number;
  const baseType = imageType >= 8 ? imageType - 8 : imageType;
  const rle = imageType >= 9;
  if (baseType === 3 && depth !== 8) throw new Error(`unsupported grey TGA depth ${depth}`);
  if (baseType !== 1 && baseType !== 2 && baseType !== 3) {
    throw new Error(`unsupported TGA image type ${imageType}`);
  }
  if (baseType === 2 && depth !== 16 && depth !== 24 && depth !== 32) {
    throw new Error(`unsupported TGA depth ${depth}`);
  }
  if (baseType === 1 && colorMapType !== 1) throw new Error('indexed TGA without a colour map');
  if (width < 1 || height < 1) throw new Error('empty TGA');

  const bytesPerPixel = baseType === 1 || baseType === 3 ? 1 : depth / 8;
  const rgba = new Uint8Array(width * height * 4);
  // Layout: header (18) -> image id -> colour map -> image data.
  const mapEntryBytes = mapEntrySize / 8;
  const mapBase = 18 + idLength;
  const mapBytes = baseType === 1 ? mapLength * mapEntryBytes : 0;
  let src = mapBase + mapBytes;

  /** Colour map entries use the same BGRA order as pixels. */
  const mapEntry = (index: number): [number, number, number, number] => {
    const offset = mapBase + index * mapEntryBytes;
    if (mapEntrySize === 24) {
      return [buffer[offset + 2] as number, buffer[offset + 1] as number, buffer[offset] as number, 255];
    }
    if (mapEntrySize === 32) {
      return [
        buffer[offset + 2] as number,
        buffer[offset + 1] as number,
        buffer[offset] as number,
        buffer[offset + 3] as number,
      ];
    }
    const value = ((buffer[offset + 1] as number) << 8) | (buffer[offset] as number);
    const scale = (v: number): number => Math.round((v * 255) / 31);
    return [scale((value >> 10) & 0x1f), scale((value >> 5) & 0x1f), scale(value & 0x1f), 255];
  };

  const writePixel = (index: number): void => {
    if (baseType === 1) {
      const [r, g, b, a] = mapEntry((buffer[src] as number) - mapFirst);
      rgba[index * 4] = r;
      rgba[index * 4 + 1] = g;
      rgba[index * 4 + 2] = b;
      rgba[index * 4 + 3] = a;
    } else if (baseType === 3) {
      const grey = buffer[src] as number;
      rgba[index * 4] = grey;
      rgba[index * 4 + 1] = grey;
      rgba[index * 4 + 2] = grey;
      rgba[index * 4 + 3] = 255;
    } else if (depth === 24) {
      rgba[index * 4] = buffer[src + 2] as number;
      rgba[index * 4 + 1] = buffer[src + 1] as number;
      rgba[index * 4 + 2] = buffer[src] as number;
      rgba[index * 4 + 3] = 255;
    } else if (depth === 32) {
      rgba[index * 4] = buffer[src + 2] as number;
      rgba[index * 4 + 1] = buffer[src + 1] as number;
      rgba[index * 4 + 2] = buffer[src] as number;
      rgba[index * 4 + 3] = buffer[src + 3] as number;
    } else {
      const value = ((buffer[src + 1] as number) << 8) | (buffer[src] as number);
      const scale = (v: number): number => Math.round((v * 255) / 31);
      rgba[index * 4] = scale((value >> 10) & 0x1f);
      rgba[index * 4 + 1] = scale((value >> 5) & 0x1f);
      rgba[index * 4 + 2] = scale(value & 0x1f);
      rgba[index * 4 + 3] = descriptor & 0x0f ? ((value >> 15) & 1) * 255 : 255;
    }
    src += bytesPerPixel;
  };

  const total = width * height;
  if (!rle) {
    for (let i = 0; i < total; i += 1) writePixel(i);
  } else {
    let i = 0;
    while (i < total) {
      const packet = buffer[src] as number;
      src += 1;
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        const from = src;
        for (let n = 0; n < count && i < total; n += 1, i += 1) {
          src = from;
          writePixel(i);
        }
        src = from + bytesPerPixel;
      } else {
        for (let n = 0; n < count && i < total; n += 1, i += 1) writePixel(i);
      }
    }
  }

  // Bottom-left is the norm for EU4 flags; bit 5 of the descriptor flips it.
  const topDown = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;
  if (!topDown || rightToLeft) {
    const flipped = new Uint8Array(rgba.length);
    for (let y = 0; y < height; y += 1) {
      const from = topDown ? y : height - 1 - y;
      for (let x = 0; x < width; x += 1) {
        const sx = rightToLeft ? width - 1 - x : x;
        const fromIndex = (from * width + sx) * 4;
        const toIndex = (y * width + x) * 4;
        flipped[toIndex] = rgba[fromIndex] as number;
        flipped[toIndex + 1] = rgba[fromIndex + 1] as number;
        flipped[toIndex + 2] = rgba[fromIndex + 2] as number;
        flipped[toIndex + 3] = rgba[fromIndex + 3] as number;
      }
    }
    return { width, height, rgba: flipped };
  }
  return { width, height, rgba };
}

/** Decode an uncompressed BMP (24/32-bit, or 8-bit palette). */
export function decodeBmp(buffer: Buffer): FlagImage {
  if (buffer[0] !== 0x42 || buffer[1] !== 0x4d) throw new Error('not a BMP');
  const dataOffset = buffer.readUInt32LE(10);
  const headerSize = buffer.readUInt32LE(14);
  if (headerSize < 40) throw new Error('unsupported BMP header');
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const depth = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  if (compression !== 0) throw new Error(`compressed BMP (${compression}) is not supported`);
  if (width < 1 || height < 1) throw new Error('empty BMP');
  if (depth !== 8 && depth !== 24 && depth !== 32) throw new Error(`unsupported BMP depth ${depth}`);

  const rgba = new Uint8Array(width * height * 4);
  const rowBytes = Math.floor((depth * width + 31) / 32) * 4;
  const paletteBase = 14 + headerSize;
  for (let y = 0; y < height; y += 1) {
    const row = topDown ? y : height - 1 - y;
    const rowStart = dataOffset + row * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (depth === 8) {
        const index = buffer[rowStart + x] as number;
        const p = paletteBase + index * 4;
        rgba[o] = buffer[p + 2] as number;
        rgba[o + 1] = buffer[p + 1] as number;
        rgba[o + 2] = buffer[p] as number;
        rgba[o + 3] = 255;
      } else {
        const p = rowStart + x * (depth / 8);
        rgba[o] = buffer[p + 2] as number;
        rgba[o + 1] = buffer[p + 1] as number;
        rgba[o + 2] = buffer[p] as number;
        rgba[o + 3] = depth === 32 ? (buffer[p + 3] as number) : 255;
      }
    }
  }
  return { width, height, rgba };
}

/**
 * Flag directories in override order (lowest priority first): the base game,
 * then each enabled mod in the order the save lists them.
 */
export function flagSearchDirs(modFilenames: readonly string[]): string[] {
  const dirs = [`${EU4}/gfx/flags`];
  for (const filename of modFilenames) {
    // meta lists mods as `mod/ugc_2976470733.mod`; the number is the workshop id.
    const match = /ugc_(\d+)/.exec(filename);
    if (!match) continue;
    const dir = `${WORKSHOP_ROOT}/${match[1]}/gfx/flags`;
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

const flagCache = new Map<string, FlagImage | undefined>();
/** Resolve one tag, letting later (higher priority) directories win. */
export function loadFlag(tag: string, dirs: readonly string[]): FlagImage | undefined {
  const key = `${dirs.length}|${tag}`;
  const cached = flagCache.get(key);
  if (cached !== undefined || flagCache.has(key)) return cached;
  let found: FlagImage | undefined;
  for (const dir of dirs) {
    const file = `${dir}/${tag}.tga`;
    if (!existsSync(file)) continue;
    try {
      found = decodeTga(readFileSync(file));
    } catch {
      // A broken mod flag must not take the whole render down.
    }
  }
  flagCache.set(key, found);
  return found;
}

/** Which flag files exist at all, for coverage reporting. */
export function listFlagTags(dirs: readonly string[]): Set<string> {
  const tags = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.toLowerCase().endsWith('.tga')) tags.add(file.slice(0, -4));
    }
  }
  return tags;
}

/** True when a flag is just padding — some tags ship an empty placeholder. */
export function isBlankFlag(image: FlagImage, threshold = 0.98): boolean {
  const { rgba } = image;
  let transparent = 0;
  for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] as number) < 8) transparent += 1;
  return transparent / (rgba.length / 4) > threshold;
}

/** Box-filter downscale; the flag art is smooth, so nearest looks coarse. */
export function scaleBox(image: FlagImage, width: number, height: number): FlagImage {
  const out = new Uint8Array(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < image.height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < image.width; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          r += image.rgba[i] as number;
          g += image.rgba[i + 1] as number;
          b += image.rgba[i + 2] as number;
          a += image.rgba[i + 3] as number;
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, rgba: out };
}
