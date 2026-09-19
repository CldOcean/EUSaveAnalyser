/*
 * Game map data, read in the browser.
 *
 * The timeline viewer needs one province id per pixel. On the server that comes
 * from `scripts/lib/map-assets.ts`; this is the browser half of the same job, so
 * the algorithms are deliberately identical (see
 * apps/site/test/game-data.test.ts, which compares both pixel for pixel).
 *
 * The files are the game's own, read once from a folder the user picks:
 *   map/provinces.bmp   5632x2048, 24-bit, rows bottom-up, 4-byte aligned
 *   map/definition.csv  id;r;g;b;name
 *   map/default.map     sea_starts / lakes id lists
 *
 * Everything here is pure functions over bytes/text: no DOM, no storage, so it
 * can run (and be tested) outside a browser too.
 */

const latin1 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
};

/** `map/definition.csv` -> Map<id, {rgb, name}>. */
export function parseDefinitions(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(';');
    if (parts.length < 5) continue;
    const id = Number(parts[0]);
    if (!Number.isInteger(id)) continue;
    out.set(id, { id, rgb: [Number(parts[1]), Number(parts[2]), Number(parts[3])], name: parts[4] ?? '' });
  }
  return out;
}

/** Packed 0xRRGGBB -> province id. */
export function colorToIdMap(definitions) {
  const out = new Map();
  for (const def of definitions.values()) {
    out.set((def.rgb[0] << 16) | (def.rgb[1] << 8) | def.rgb[2], def.id);
  }
  return out;
}

/** Parse a `{ 1 2 3 }` id list out of a map text file, ignoring `#` comments. */
export function parseIdSet(text, key) {
  const out = new Set();
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

/** Which ids the game treats as sea or lakes (`map/default.map`). */
export function parseWaterIds(text) {
  const sea = parseIdSet(text, 'sea_starts');
  const lakes = parseIdSet(text, 'lakes');
  return { sea, lakes, all: new Set([...sea, ...lakes]) };
}

/** BMP header basics: dimensions and the pixel-data offset. */
export function readBmpHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP');
  return {
    dataOffset: view.getUint32(10, true),
    width: view.getInt32(18, true),
    height: Math.abs(view.getInt32(22, true)),
    bottomUp: view.getInt32(22, true) > 0,
    bpp: view.getUint16(28, true),
    compression: view.getUint32(30, true),
  };
}

/**
 * Decode `provinces.bmp` into one province id per pixel (0 = no province).
 * 24-bit, rows bottom-up, each row padded to a 4-byte boundary.
 */
export function decodeProvinceBmp(bytes, colorToId, expected) {
  const header = readBmpHeader(bytes);
  if (header.compression !== 0) throw new Error(`compressed BMP (${header.compression}) is not supported`);
  if (header.bpp !== 24) throw new Error(`expected a 24-bit provinces.bmp, got ${header.bpp}`);
  const width = expected?.width ?? header.width;
  const height = expected?.height ?? header.height;
  if (width !== header.width || height !== header.height) {
    throw new Error(`province map is ${header.width}x${header.height}, expected ${width}x${height}`);
  }
  const stride = Math.ceil((width * header.bpp) / 32) * 4;
  const ids = new Uint16Array(width * height);
  let unmatched = 0;
  for (let y = 0; y < height; y += 1) {
    const row = header.dataOffset + (header.bottomUp ? height - 1 - y : y) * stride;
    const dst = y * width;
    for (let x = 0; x < width; x += 1) {
      const o = row + x * 3;
      const key = (bytes[o + 2] << 16) | (bytes[o + 1] << 8) | bytes[o];
      const id = colorToId.get(key);
      if (id === undefined) unmatched += 1;
      ids[dst + x] = id ?? 0;
    }
  }
  return { width, height, ids, unmatched };
}

/**
 * Shrink the id map.
 *
 * `nearest` matches the server's `downscalePixels` (and therefore the rasters it
 * builds); `majority` is what the viewer's in-page "一半分辨率" switch uses,
 * because nearest sampling drops provinces that are one pixel wide.
 */
export function downscaleIds(ids, width, height, factor, mode = 'nearest') {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (mode === 'majority') {
        const row0 = y * factor * width;
        const row1 = row0 + width;
        const a = ids[row0 + x * factor];
        const b = ids[row0 + x * factor + 1];
        const c = ids[row1 + x * factor];
        const d = ids[row1 + x * factor + 1];
        out[y * w + x] = a === b || a === c || a === d ? a : b === c || b === d ? b : a;
      } else {
        out[y * w + x] = ids[y * factor * width + x * factor];
      }
    }
  }
  return { width: w, height: h, ids: out };
}

/**
 * Everything the viewer needs from the game's map folder.
 * Accepts the three files as byte arrays (however the page obtained them).
 */
export function buildGameMap(files) {
  const definitions = parseDefinitions(latin1(files.definitionCsv));
  const colorToId = colorToIdMap(definitions);
  const water = parseWaterIds(latin1(files.defaultMap));
  const decoded = decodeProvinceBmp(files.provincesBmp, colorToId);
  return {
    width: decoded.width,
    height: decoded.height,
    ids: decoded.ids,
    unmatched: decoded.unmatched,
    definitions,
    water,
  };
}
