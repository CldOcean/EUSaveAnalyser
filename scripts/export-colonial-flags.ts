/**
 * Build-time composites for colonial nations that have no flag artwork.
 *
 * DEPRECATED — superseded by the runtime overlay.
 *
 * The viewer now draws a colony entirely in the DOM: the mother country's flag
 * (from `base`/`modded`) with the right half covered by a plain colour block
 * (`.flagBox` + `.flagTint`). Nothing is fetched from `colonial/` any more, and
 * that is deliberate — `C##`/`D##` are reusable slots, so the same tag belongs
 * to a different mother country in a different save (34 tags in practice) and a
 * static image would show the wrong parent. The overlay reads the parent from
 * the save that is being viewed, so it is always right, and no rebuild is needed
 * when a new save shows up.
 *
 * This script is kept only for the case where somebody wants the static images
 * again (offline mock-ups, a fallback sprite sheet). `apps/site/public/assets/
 * flags/colonial/` and `colonial-modded/` no longer exist in the repository; run
 * this and they come back under its own name — nothing reads them.
 *
 *   node scripts/export-colonial-flags.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SaveDocument, countryScalar } from '../packages/eu4-parser/src/document.ts';
import { EU4, WORKSHOP_ROOT, hashColor } from './lib/map-assets.ts';
import { decodeBmp, decodeTga, sniffFormat, type FlagImage } from './lib/flags.ts';
import { encodePng } from './lib/png.ts';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const OUT = 'apps/site/public/assets/flags';
const BASE_DIR = `${EU4}/gfx/flags`;

/** Resolve a tag's source artwork in one layer directory. */
function sourceOf(tag: string, dirs: string[]): FlagImage | undefined {
  let winner: string | undefined;
  for (const dir of dirs) if (existsSync(`${dir}/${tag}.tga`)) winner = dir;
  if (!winner) return undefined;
  const buffer = readFileSync(`${winner}/${tag}.tga`);
  const format = sniffFormat(buffer);
  try {
    if (format === 'tga') return decodeTga(buffer);
    if (format === 'bmp') return decodeBmp(buffer);
  } catch {
    return undefined;
  }
  return undefined; // PNG/JPEG parents are copied elsewhere; nothing to composite here
}

const doc = await SaveDocument.fromFile(SAVE, { sections: [] });
const colonies: Array<{ tag: string; parent: string }> = [];
for (const [tag, country] of doc.countries()) {
  const parent = countryScalar(country, 'colonial_parent');
  if (parent) colonies.push({ tag, parent });
}

const enabledMods = doc.meta.mods
  .map((mod) => /ugc_(\d+)/.exec(mod.filename)?.[1])
  .filter((id): id is string => typeof id === 'string')
  .map((id) => `${WORKSHOP_ROOT}/${id}/gfx/flags`)
  .filter((dir) => existsSync(dir));

const layers: Array<{ name: string; dirs: string[] }> = [
  { name: 'colonial', dirs: [BASE_DIR] },
  { name: 'colonial-modded', dirs: [BASE_DIR, ...enabledMods] },
];

console.log(`colonial nations: ${colonies.length}`);
let made = 0;
let skippedNoArt = 0;
let skippedHasOwn = 0;

for (const layer of layers) {
  const dir = `${OUT}/${layer.name}`;
  mkdirSync(dir, { recursive: true });
  for (const { tag, parent } of colonies) {
    // A colony that HAS artwork keeps it; the composite is only a fallback.
    if (existsSync(`${OUT}/${layer.name === 'colonial' ? 'base' : 'modded'}/${tag}.png`)) {
      skippedHasOwn += 1;
      continue;
    }
    const flag = sourceOf(parent, layer.dirs);
    if (!flag) {
      skippedNoArt += 1;
      continue;
    }
    const fill = hashColor(tag);
    const half = Math.floor(flag.width / 2);
    for (let y = 0; y < flag.height; y += 1) {
      for (let x = half; x < flag.width; x += 1) {
        const o = (y * flag.width + x) * 4;
        flag.rgba[o] = fill[0];
        flag.rgba[o + 1] = fill[1];
        flag.rgba[o + 2] = fill[2];
        flag.rgba[o + 3] = 255;
      }
    }
    // Self-check: the right half must be exactly the fill colour everywhere.
    let bad = 0;
    for (let y = 0; y < flag.height; y += 1) {
      for (let x = half; x < flag.width; x += 1) {
        const o = (y * flag.width + x) * 4;
        if (flag.rgba[o] !== fill[0] || flag.rgba[o + 1] !== fill[1] || flag.rgba[o + 2] !== fill[2]) bad += 1;
      }
    }
    if (bad) throw new Error(`${layer.name}/${tag}: ${bad} pixels outside the fill colour`);
    writeFileSync(`${dir}/${tag}.png`, encodePng(flag.width, flag.height, flag.rgba, 4));
    made += 1;
  }
}

console.log(`  composites written: ${made}`);
console.log(`  skipped (colony already had a flag): ${skippedHasOwn}`);
console.log(`  skipped (parent artwork unreadable): ${skippedNoArt}`);
if (made) {
  const sample = colonies.find((c) => existsSync(`${OUT}/colonial/${c.tag}.png`));
  if (sample) {
    console.log(`  example: ${sample.tag} (child of ${sample.parent}) -> ${OUT}/colonial/${sample.tag}.png`);
  }
}
