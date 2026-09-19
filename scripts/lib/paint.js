/**
 * Map painting: base fill, occupation hatching, province borders.
 *
 * This file is deliberately plain ES-module JavaScript with no imports, because
 * it is used in two places:
 *
 *   1. server-side, to render PNG snapshots, and
 *   2. inlined verbatim into the standalone HTML player (with the `export`
 *      keyword stripped), so the browser draws pixels with the *same* code.
 *
 * Keeping one implementation is the point: hatching that differs between the
 * preview and the app would be a bug that is very hard to see.
 *
 * Colours are packed 0xRRGGBB ints, and `0` means "no colour" — both palettes
 * are indexed by province id and are rebuilt by the caller for each frame.
 */

/** Hatching geometry: a band of `STRIPE_WIDTH` px every `STRIPE_PERIOD` px. */
export const STRIPE_PERIOD = 10;
export const STRIPE_WIDTH = 4;

/** How much of the base colour survives on a province-border pixel. */
export const BORDER_DARKEN = 0.45;

/**
 * Precompute which pixels sit on a province border.
 *
 * Borders never change over time, so this is computed once and reused for every
 * frame — which is what makes monthly scrubbing cheap.
 *
 * @param {Uint16Array} pixels province id per pixel
 * @param {number} width
 * @param {number} height
 * @param {Set<number>|null} waterIds ids that are sea/lakes (no hatching between two of them)
 * @returns {Uint8Array} 1 for a border pixel, 0 otherwise
 */
export function buildBorderMask(pixels, width, height, waterIds = null) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const id = pixels[i];
      const right = x + 1 < width ? pixels[i + 1] : id;
      const down = y + 1 < height ? pixels[i + width] : id;
      if (id === right && id === down) continue;
      // Sea next to sea is not drawn as a border by the game either.
      if (waterIds && waterIds.has(id) && waterIds.has(right) && waterIds.has(down)) {
        continue;
      }
      mask[i] = 1;
    }
  }
  return mask;
}

/**
 * Paint one frame into an RGBA buffer.
 *
 * @param {Uint16Array} pixels province id per pixel
 * @param {Uint8ClampedArray|Uint8Array} out RGBA output, `width * height * 4`
 * @param {number} width
 * @param {number} height
 * @param {Uint32Array} baseColors packed colour per province id (0 = unpainted)
 * @param {Uint32Array} stripeColors packed hatch colour per province id (0 = no hatch)
 * @param {Uint8Array} borderMask from `buildBorderMask`
 * @param {number} period hatch period in pixels
 * @param {number} band hatch band width in pixels
 * @param {boolean} hatch when false, `stripeColors` is ignored (heat maps)
 */
export function paintMap(
  pixels,
  out,
  width,
  height,
  baseColors,
  stripeColors,
  borderMask,
  period = STRIPE_PERIOD,
  band = STRIPE_WIDTH,
  hatch = true,
) {
  for (let y = 0; y < height; y += 1) {
    const rowBase = y * width;
    // Every row starts at a different phase so the bands read as diagonals.
    const phaseBase = y % period;
    for (let x = 0; x < width; x += 1) {
      const i = rowBase + x;
      const id = pixels[i];
      let color = baseColors[id];
      if (hatch && stripeColors[id] !== 0 && (x + phaseBase) % period < band) {
        color = stripeColors[id];
      }
      if (borderMask[i] !== 0) {
        color = darken(color, BORDER_DARKEN);
      }
      const o = i << 2;
      out[o] = (color >> 16) & 0xff;
      out[o + 1] = (color >> 8) & 0xff;
      out[o + 2] = color & 0xff;
      out[o + 3] = 0xff;
    }
  }
}

/** Multiply a packed colour by a factor (used for province borders). */
export function darken(color, factor) {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

export function packRgb(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

/** `#rrggbb` -> packed int. */
export function hexToPacked(hex) {
  return parseInt(hex.slice(1), 16);
}

/** Packed int -> `#rrggbb`. */
export function packedToHex(color) {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * Development heat ramp: **low is red, high is green**.
 * `t` is 0..1 after any scaling the caller wants (we use sqrt so mid-sized
 * provinces do not all collapse into the red end).
 */
const DEV_RAMP = [
  [176, 44, 40],
  [214, 116, 44],
  [224, 198, 76],
  [128, 182, 78],
  [42, 132, 62],
];

export function devRamp(t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const pos = clamped * (DEV_RAMP.length - 1);
  const i = Math.min(DEV_RAMP.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = DEV_RAMP[i];
  const b = DEV_RAMP[i + 1];
  return packRgb(
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  );
}

function rampAt(stops, t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const pos = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  return packRgb(
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  );
}

/**
 * Technology ramp: **low = red, high = green**, normalised against the strongest
 * and weakest country at that moment. Deliberately a little different from the
 * development ramp (deeper crimson at the bottom, emerald at the top) so the two
 * heat maps are still tellable apart.
 */
const TECH_RAMP = [
  [150, 30, 40],
  [206, 78, 44],
  [228, 178, 74],
  [120, 190, 96],
  [30, 132, 74],
];

export function techRamp(t) {
  return rampAt(TECH_RAMP, t);
}

/**
 * Institution ramp: same red→green direction, tinted differently again
 * (institutions lean lime at the top, violet-red at the bottom).
 */
const INSTITUTION_RAMP = [
  [166, 40, 96],
  [214, 92, 64],
  [226, 186, 92],
  [150, 206, 84],
  [40, 146, 60],
];

export function institutionRamp(t) {
  return rampAt(INSTITUTION_RAMP, t);
}

/**
 * Battle ramp: white (no fighting yet) climbing to deep red. Used for the
 * **cumulative** battle score, so a province darkens as it is fought over again
 * and again across the campaign.
 */
const BATTLE_RAMP = [
  [246, 246, 246],
  [252, 226, 168],
  [246, 176, 92],
  [222, 104, 60],
  [168, 26, 26],
];

export function battleRamp(t) {
  return rampAt(BATTLE_RAMP, t);
}

/**
 * Naval battle ramp: deep blue (quiet) climbing to red, so sea battles are
 * visually distinct from land battles. In this save the split is clean — all 272
 * naval battles sit in a sea province and no land battle does.
 */
const NAVAL_RAMP = [
  [186, 214, 246],
  [130, 172, 224],
  [86, 132, 196],
  [132, 84, 156],
  [168, 26, 26],
];

export function navalRamp(t) {
  return rampAt(NAVAL_RAMP, t);
}
