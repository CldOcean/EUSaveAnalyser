/**
 * Export country flags as PNG so the website never needs the game installed.
 *
 * Layout (inside the site's own folder — that folder IS the deploy output, so the
 * artwork ships without a copy step):
 *
 *   apps/site/public/assets/flags/base/<TAG>.png          the game's own artwork, native size
 *   apps/site/public/assets/flags/modded/<TAG>.png        base + the sample save's enabled mods
 *   apps/site/public/assets/flags/mods/<modId>/<TAG>.png  each workshop mod's own artwork (64px)
 *   apps/site/public/assets/flags/manifest.json           counts, sizes and provenance
 *
 * `mods/` is gitignored and must stay that way: it is 14,550 files, which alone would
 * blow Cloudflare Pages' 20,000-file limit. Only `base/`, `modded/` and the two
 * `colonial*` folders are deployed.
 *
 * Why not one global "everything applied" set: the 27 flag mods on this machine
 * are mutually exclusive art packs (one replaces every flag with anime
 * portraits, another is a historical pack). Merging them by mod id would build a
 * set no campaign ever saw. A real save resolves its own mod list in load order,
 * so the per-mod folders are what make an arbitrary save correct; `modded/` is
 * the ready-made resolution for the sample save.
 *
 * 64px is used for the per-mod folders because those are exhaustive (14,550
 * files) and the photographic art packs would otherwise dominate the disk.
 *
 *   node scripts/export-flags.ts [--size 64] [--only base|modded|mods]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { SaveDocument } from '../packages/eu4-parser/src/document.ts';
import { EU4, WORKSHOP_ROOT } from './lib/map-assets.ts';
import { decodeBmp, decodeTga, listFlagTags, scaleBox, sniffFormat, type FlagImage } from './lib/flags.ts';
import { encodePng } from './lib/png.ts';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const OUT = 'apps/site/public/assets/flags';
const BASE_DIR = `${EU4}/gfx/flags`;

const argOf = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const MOD_SIZE = argOf('size', 64);
const onlyAt = process.argv.indexOf('--only');
const ONLY = onlyAt > 0 ? process.argv[onlyAt + 1] : undefined;

interface SetStat { files: number; bytes: number; skipped: number }
const stats: Record<string, SetStat> = {};
/** tag -> stored file name, for the few flags that are not PNG. */
const fileNames: Record<string, Record<string, string>> = {};
/** tag -> what the source file really was (before conversion). */
const formats: Record<string, Record<string, string>> = {};

/**
 * Store one flag. Mod authors ship BMP, PNG and JPEG files renamed to `.tga`, so
 * the content decides how it is handled: real raster formats are converted, and
 * PNG/JPEG are copied through untouched (the browser reads them natively, which
 * also avoids re-encoding compressed art).
 */
function store(sourceFile: string, dir: string, tag: string, size: number): { bytes: number; name: string; format: string } | undefined {
  const buffer = readFileSync(sourceFile);
  const format = sniffFormat(buffer);
  if (format === 'png') {
    writeFileSync(`${dir}/${tag}.png`, buffer);
    return { bytes: buffer.length, name: `${tag}.png`, format };
  }
  if (format === 'jpeg') {
    writeFileSync(`${dir}/${tag}.jpg`, buffer);
    return { bytes: buffer.length, name: `${tag}.jpg`, format };
  }
  let image: FlagImage;
  if (format === 'bmp') image = decodeBmp(buffer);
  else if (format === 'tga') image = decodeTga(buffer);
  else return undefined;
  if (size > 0 && image.width !== size) image = scaleBox(image, size, size);
  const png = encodePng(image.width, image.height, image.rgba, 4);
  writeFileSync(`${dir}/${tag}.png`, png);
  return { bytes: png.length, name: `${tag}.png`, format };
}

/**
 * Export one set. `layers` is lowest-priority-first, so the last directory that
 * holds the tag wins — the same rule the game applies to mod overrides.
 */
function exportSet(name: string, layers: string[], tags: string[], size: number): SetStat {
  const dir = `${OUT}/${name}`;
  mkdirSync(dir, { recursive: true });
  const stat: SetStat = { files: 0, bytes: 0, skipped: 0 };
  for (const tag of tags) {
    let winner: string | undefined;
    for (const layer of layers) if (existsSync(`${layer}/${tag}.tga`)) winner = layer;
    if (!winner) {
      stat.skipped += 1;
      continue;
    }
    try {
      const stored = store(`${winner}/${tag}.tga`, dir, tag, size);
      if (!stored) {
        stat.skipped += 1;
        continue;
      }
      stat.bytes += stored.bytes;
      stat.files += 1;
      (fileNames[name] ??= {})[tag] = stored.name;
      (formats[name] ??= {})[tag] = stored.format;
    } catch {
      stat.skipped += 1;
    }
  }
  stats[name] = stat;
  console.log(
    `  ${name}: ${stat.files} files, ${(stat.bytes / 1024 / 1024).toFixed(1)} MB` +
      (stat.skipped ? `, ${stat.skipped} skipped` : ''),
  );
  return stat;
}

/** Every workshop mod that ships flags, in a stable order. */
function workshopFlagMods(): Array<{ id: string; dir: string }> {
  const out: Array<{ id: string; dir: string }> = [];
  for (const id of readdirSync(WORKSHOP_ROOT).sort()) {
    const dir = `${WORKSHOP_ROOT}/${id}/gfx/flags`;
    if (existsSync(dir)) out.push({ id, dir });
  }
  return out;
}

const started = Date.now();
mkdirSync(OUT, { recursive: true });
const baseTags = [...listFlagTags([BASE_DIR])].sort();

// --- 1. the game's own set -------------------------------------------------
if (!ONLY || ONLY === 'base') {
  console.log(`base: ${baseTags.length} flags at native size`);
  exportSet('base', [BASE_DIR], baseTags, 0);
}

// --- 2. the sample save's own resolution ----------------------------------
if (!ONLY || ONLY === 'modded') {
  const doc = await SaveDocument.fromFile(SAVE, { sections: [] });
  const enabled = doc.meta.mods
    .map((mod) => /ugc_(\d+)/.exec(mod.filename)?.[1])
    .filter((id): id is string => typeof id === 'string');
  const mods = workshopFlagMods();
  const layers = [BASE_DIR];
  const used: string[] = [];
  for (const id of enabled) {
    const found = mods.find((mod) => mod.id === id);
    if (found) {
      layers.push(found.dir);
      used.push(id);
    }
  }
  // The union of what this save can actually show: base tags plus the mods'.
  const tags = [...new Set([...baseTags, ...used.flatMap((id) => [...listFlagTags([`${WORKSHOP_ROOT}/${id}/gfx/flags`])])])].sort();
  console.log(`\nmodded: ${used.length} enabled flag mods (${used.join(', ')}), ${tags.length} tags`);
  exportSet('modded', layers, tags, 0);

  // Provenance for the merged set: which layer supplied each tag.
  const provenance: Record<string, string> = {};
  for (const tag of tags) {
    let source = 'base';
    for (const id of used) if (existsSync(`${WORKSHOP_ROOT}/${id}/gfx/flags/${tag}.tga`)) source = id;
    provenance[tag] = source;
  }
  writeFileSync(`${OUT}/modded-source.json`, JSON.stringify(provenance), 'utf8');
  const counts = new Map<string, number>();
  for (const source of Object.values(provenance)) counts.set(source, (counts.get(source) ?? 0) + 1);
  console.log('  artwork source:', [...counts.entries()].map(([k, n]) => `${k}=${n}`).join(' '));
}

// --- 3. every mod's own artwork -------------------------------------------
if (!ONLY || ONLY === 'mods') {
  const mods = workshopFlagMods();
  console.log(`\nper-mod export at ${MOD_SIZE}px (${mods.length} mods)`);
  for (const mod of mods) {
    const tags = [...listFlagTags([mod.dir])].sort();
    exportSet(`mods/${mod.id}`, [mod.dir], tags, MOD_SIZE);
  }
}

// --- manifest -------------------------------------------------------------
writeFileSync(
  `${OUT}/manifest.json`,
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      source: { game: EU4, workshop: WORKSHOP_ROOT },
      note: 'base and modded keep the native flag size; mods/ is box-filtered to a smaller size',
      modSize: MOD_SIZE,
      sets: Object.fromEntries(
        Object.entries(stats).map(([name, stat]) => [
          name,
          { files: stat.files, bytes: stat.bytes, skipped: stat.skipped },
        ]),
      ),
      // Only the tags whose stored file is not `<TAG>.png` need recording; PNG
      // and JPEG sources are copied as-is (`.jpg`), everything else becomes PNG.
      fileNames: Object.fromEntries(
        Object.entries(fileNames)
          .map(([set, map]) => [
            set,
            Object.fromEntries(Object.entries(map).filter(([tag, file]) => file !== `${tag}.png`)),
          ])
          .filter(([, map]) => Object.keys(map as object).length > 0),
      ),
      sourceFormats: formats,
    },
    null,
    1,
  ),
  'utf8',
);

let totalFiles = 0;
let totalBytes = 0;
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path);
    else {
      totalFiles += 1;
      totalBytes += statSync(path).size;
    }
  }
};
walk(OUT);
console.log(
  `\n${OUT}: ${totalFiles} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
