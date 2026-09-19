/**
 * Proof-of-concept flag extraction: build a contact sheet of the flags that
 * belong to the countries this save actually cares about (the great powers and
 * the Empire's roles), resolved through the save's enabled mods.
 *
 *   node scripts/render-flags.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { SaveDocument, countryScalar } from '../packages/eu4-parser/src/document.ts';
import { encodePng } from './lib/png.ts';
import { flagSearchDirs, isBlankFlag, listFlagTags, loadFlag, scaleBox } from './lib/flags.ts';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const BASE_ONLY = process.argv.includes('--no-mods');
const OUT = BASE_ONLY ? 'tmp/flags-preview-base.png' : 'tmp/flags-preview.png';
const TILE = 64;
const GAP = 3;
const COLS = 6;

const doc = await SaveDocument.fromFile(SAVE, { sections: ['empire'] });
const dirs = BASE_ONLY
  ? flagSearchDirs([])
  : flagSearchDirs(doc.meta.mods.map((mod) => mod.filename));
console.log(BASE_ONLY ? 'base game only (mods ignored)' : 'base game + enabled mods');
console.log(`flag lookup order (${dirs.length} dirs):`);
for (const dir of dirs) console.log(`  ${dir}`);

const available = listFlagTags(dirs);
console.log(`flag files reachable: ${available.size} distinct tags`);

// Great powers by score, then the HRE roles, so the sheet shows real names.
const scored = [...doc.countries().entries()]
  .map(([tag, country]) => ({ tag, score: countryScalar(country, 'great_power_score') ?? 0 }))
  .filter((entry) => entry.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 24)
  .map((entry) => entry.tag);

const empire = doc.readSectionView('empire');
const hre = [empire?.string('emperor'), ...(empire?.stringList('electors') ?? [])].filter(
  (tag): tag is string => typeof tag === 'string',
);
const tags = [...new Set([...scored, ...hre])];

const rows = Math.ceil(tags.length / COLS);
const width = COLS * TILE + (COLS + 1) * GAP;
const height = rows * TILE + (rows + 1) * GAP;
const canvas = new Uint8Array(width * height * 4);
// Dark background so transparent corners are obvious.
for (let i = 0; i < canvas.length; i += 4) {
  canvas[i] = 24;
  canvas[i + 1] = 28;
  canvas[i + 2] = 34;
  canvas[i + 3] = 255;
}

let missing: string[] = [];
let blank: string[] = [];
tags.forEach((tag, index) => {
  const image = loadFlag(tag, dirs);
  if (!image) {
    missing.push(tag);
    return;
  }
  if (isBlankFlag(image)) blank.push(tag);
  const tile = scaleBox(image, TILE, TILE);
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  const ox = GAP + col * (TILE + GAP);
  const oy = GAP + row * (TILE + GAP);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const from = (y * TILE + x) * 4;
      const to = ((oy + y) * width + ox + x) * 4;
      const alpha = (tile.rgba[from + 3] as number) / 255;
      // Composite over the background so the sheet is readable either way.
      for (let c = 0; c < 3; c += 1) {
        canvas[to + c] = Math.round(
          (tile.rgba[from + c] as number) * alpha + (canvas[to + c] as number) * (1 - alpha),
        );
      }
      canvas[to + 3] = 255;
    }
  }
});

mkdirSync('tmp', { recursive: true });
writeFileSync(OUT, encodePng(width, height, canvas, 4));
console.log(`\ntiles (${COLS} per row):`);
for (let i = 0; i < tags.length; i += COLS) {
  console.log(`  ${tags.slice(i, i + COLS).map((t) => t.padEnd(4)).join(' ')}`);
}
console.log(`\nwrote ${OUT} (${width}x${height})`);
console.log(`  tags with a flag: ${tags.length - missing.length}/${tags.length}`);
if (missing.length) console.log(`  MISSING: ${missing.join(', ')}`);
if (blank.length) console.log(`  blank/placeholder: ${blank.join(', ')}`);

// Coverage over every country in the save, not just the ones on the sheet.
const allTags = [...doc.countries().keys()];
const covered = allTags.filter((tag) => available.has(tag));
console.log(
  `  coverage over the save's ${allTags.length} countries: ${covered.length} have a flag ` +
    `(${((covered.length / allTags.length) * 100).toFixed(1)}%)`,
);
