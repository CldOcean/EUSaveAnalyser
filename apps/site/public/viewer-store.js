/*
 * Build the viewer's data in the browser and keep it in the archive.
 *
 * The heavy part of opening a viewer is reconstructing the timeline, which needs the
 * game's map and localisation files. Rather than repeat that on every visit, the data
 * is built once — right after the upload — and stored beside the save:
 *
 *   saves/<id>/viewer/data.json    DATA + the panels (roughly 2 MB)
 *   saves/<id>/viewer/raster.png   the province-id raster (roughly 0.5 MB)
 *   saves/<id>/viewer/thumb.png    the card's little map (704 px wide, ~0.1 MB)
 *
 * The page itself is NOT stored. Keeping one shared `viewer.html`/`viewer.js` on the
 * site means a viewer improvement reaches every save at once, instead of leaving a
 * frozen copy per save that would all have to be rebuilt.
 *
 * This module is used by both ends of that flow: the catalogue builds and uploads, the
 * viewer page reads back what is there (and stores it too, when it had to build).
 */

import { STRIPE_PERIOD, STRIPE_WIDTH, buildViewerData } from './viewer-build.js';
import { readMembers } from './parser.js';
import { SaveDocument } from './eu4-parser.js';

/** Where one save's generated data lives, relative to the storage root. */
export const DATA_PATH = 'viewer/data.json';
export const RASTER_PATH = 'viewer/raster.png';
export const THUMB_PATH = 'viewer/thumb.png';

/** Width of that image. The height follows the map, so 5632x2048 gives 704x256. */
export const THUMB_WIDTH = 704;

/** Turn the packed raster into a PNG blob, ready to store. */
async function rasterBlob(raster) {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(raster.width, raster.height);
  const out = image.data;
  for (let i = 0, p = 0; i < raster.rgb.length; i += 3, p += 4) {
    // Opaque alpha matters: the player reads the ids back with getImageData, and a
    // transparent or premultiplied pixel would corrupt every id under it.
    out[p] = raster.rgb[i];
    out[p + 1] = raster.rgb[i + 1];
    out[p + 2] = 0;
    out[p + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))), 'image/png');
  });
}

/**
 * Box-filter a painted frame down to the thumbnail size.
 *
 * Hand-written instead of `canvas.drawImage`: the offline generator has no canvas, and
 * a browser-only smoothing filter would make the two versions of the same file differ.
 * Averaging whole source rectangles is something both sides can agree on exactly.
 */
export function downscaleRgba(rgba, width, height, outWidth, outHeight) {
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    const y0 = Math.floor((y * height) / outHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));
    for (let x = 0; x < outWidth; x += 1) {
      const x0 = Math.floor((x * width) / outWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let i = (sy * width + x0) * 4;
        for (let sx = x0; sx < x1; sx += 1, i += 4) {
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
        }
      }
      const pixels = (y1 - y0) * (x1 - x0);
      const o = (y * outWidth + x) * 4;
      out[o] = Math.round(r / pixels);
      out[o + 1] = Math.round(g / pixels);
      out[o + 2] = Math.round(b / pixels);
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Paint the card thumbnail: the political frame `buildViewerData` computed, drawn with
 * the shared painter (`paint.js`, loaded as a classic script — its top-level function
 * declarations are the only thing a module can reach, so `globalThis.paintMap` it is)
 * and shrunk to `THUMB_WIDTH`.
 *
 * @param {{ ids: Uint16Array, width: number, height: number, water: Set<number>, frame: { base: Uint32Array, hatch: Uint32Array } }} input
 */
async function thumbBlob({ ids, width, height, water, frame }) {
  const paintMap = globalThis.paintMap;
  const buildBorderMask = globalThis.buildBorderMask;
  if (typeof paintMap !== 'function' || typeof buildBorderMask !== 'function') {
    throw new Error('paint.js is not loaded');
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  paintMap(ids, rgba, width, height, frame.base, frame.hatch, buildBorderMask(ids, width, height, water), STRIPE_PERIOD, STRIPE_WIDTH, true);

  const outWidth = THUMB_WIDTH;
  const outHeight = Math.max(1, Math.round((outWidth * height) / width));
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  canvas.getContext('2d').putImageData(new ImageData(downscaleRgba(rgba, width, height, outWidth, outHeight), outWidth, outHeight), 0, 0);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))), 'image/png');
  });
}

/**
 * Where the game-file conversation publishes the static UI tables
 * (`uiNames.json`, `provinceTerrain.json`, `area.json`).
 */
export const UI_TABLE_PATH = '/assets/ui';

/**
 * Fetch those three tables as **raw text**, which is what `buildViewerData` takes: the
 * offline generator hands it the bytes of the same files, so both planes normalise
 * them through one piece of code. A missing table is normal (they are published by a
 * separate script) and simply leaves that category empty.
 *
 * @returns {Promise<{ uiNames?: string, provinceTerrain?: string, area?: string }>}
 */
export async function loadUiTables(base = UI_TABLE_PATH) {
  const read = async (name) => {
    try {
      const response = await fetch(`${base}/${name}`);
      return response.ok ? await response.text() : undefined;
    } catch {
      return undefined;
    }
  };
  const [uiNames, provinceTerrain, area, advisorIds, ledgerSlots, manaSlots] = await Promise.all([
    read('uiNames.json'),
    read('provinceTerrain.json'),
    read('area.json'),
    read('advisorIds.json'),
    read('ledgerSlots.json'),
    read('manaSlots.json'),
  ]);
  return { uiNames, provinceTerrain, area, advisorIds, ledgerSlots, manaSlots };
}

/**
 * Build everything one save needs, from bytes the caller already has.
 *
 * @param {{ bytes: Uint8Array, map: object, tables: object, localise: Function,
 *           officialReligions: Map,
 *           uiTables?: { uiNames?: string, provinceTerrain?: string, area?: string } }} input
 */
export async function buildForSave({ bytes, map, tables, localise, officialReligions, uiTables }) {
  const members = await readMembers(bytes);
  const doc = SaveDocument.fromMembers(members);
  // The detail tables are optional; the catalogue's upload path passes nothing and
  // gets them from the site, exactly like the viewer page does.
  const detailTables = uiTables ?? (await loadUiTables());
  const built = buildViewerData({
    doc,
    map,
    water: map.water,
    localise,
    officialReligions,
    scale: 1,
    uiTables: detailTables,
  });
  const blob = await rasterBlob(built.raster);
  // The thumbnail is a convenience, never a reason to fail a build: a save whose card
  // image could not be drawn still gets its viewer data, exactly like before.
  let thumb;
  try {
    thumb = await thumbBlob({
      ids: map.ids,
      width: map.width,
      height: map.height,
      water: new Set([...map.water.sea, ...map.water.lakes]),
      frame: built.thumb,
    });
  } catch (error) {
    console.warn('the card thumbnail could not be painted', error);
  }
  return {
    // One file holds both: the data plane and the three panel tables, so reading it
    // back is a single request.
    payload: { version: 2, data: built.data, panels: built.panels },
    raster: blob,
    thumb,
    diagnostics: built.diagnostics,
    doc,
  };
}

/** The bytes of one generated file, as the archive stores it. */
const jsonBlob = (value) => new Blob([JSON.stringify(value)], { type: 'application/json' });

/**
 * Upload the generated files.
 *
 * A failure here must never look like a failed upload: the save itself is already
 * stored, so the worst case is that opening the viewer rebuilds instead.
 */
export async function storeBuiltSave(id, { payload, raster, thumb }, headers = {}) {
  const upload = async (path, body) => {
    const response = await fetch(`/api/saves/${encodeURIComponent(id)}/artifact?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers,
      body,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(`${path} 上传失败：HTTP ${response.status} ${detail.error ?? ''}`.trim());
    }
    return response.json();
  };
  await upload(DATA_PATH, jsonBlob(payload));
  await upload(RASTER_PATH, raster);
  // Same rule as the paint itself: a missing card image must not fail the build that
  // produced a perfectly good viewer.
  if (thumb) {
    try {
      await upload(THUMB_PATH, thumb);
    } catch (error) {
      console.warn('the card thumbnail could not be uploaded', error);
    }
  }
}

/** Read back what a previous visit stored, or undefined when there is nothing. */
export async function loadStoredSave(id) {
  try {
    const response = await fetch(`/saves/${encodeURIComponent(id)}/${DATA_PATH}`, { cache: 'no-cache' });
    if (!response.ok) return undefined;
    const stored = await response.json();
    if (!stored?.data?.tags) return undefined;
    return {
      data: stored.data,
      panels: stored.panels ?? { header: {}, leaderHtml: '', cityHtml: '', institutionHtml: '' },
      rasterUrl: `/saves/${encodeURIComponent(id)}/${RASTER_PATH}`,
      version: stored.version ?? 1,
    };
  } catch {
    return undefined;
  }
}
