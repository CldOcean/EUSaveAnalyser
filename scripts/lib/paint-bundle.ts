/**
 * Bridge between the shared painter and the standalone HTML player.
 *
 * `paint.js` is an ES module so the render scripts can import it; the browser
 * needs it as a plain script. Stripping the `export ` keywords is all it takes,
 * and doing it here means the inlined code can never drift from the imported one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BORDER_DARKEN,
  STRIPE_PERIOD,
  STRIPE_WIDTH,
  battleRamp,
  buildBorderMask,
  darken,
  devRamp,
  hexToPacked,
  institutionRamp,
  navalRamp,
  packRgb,
  packedToHex,
  paintMap,
  techRamp,
} from './paint.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, 'paint.js'), 'utf8');

/**
 * `paint.js` with `export ` removed, safe to drop straight into a `<script>`.
 * Top-level `function`/`const` declarations become globals shared by later
 * scripts on the same page.
 */
export const PAINT_SOURCE: string = raw.replace(/^export /gm, '');

export {
  BORDER_DARKEN,
  STRIPE_PERIOD,
  STRIPE_WIDTH,
  battleRamp,
  buildBorderMask,
  darken,
  devRamp,
  hexToPacked,
  institutionRamp,
  navalRamp,
  packRgb,
  packedToHex,
  paintMap,
  techRamp,
};
