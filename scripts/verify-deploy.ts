/**
 * Check the site folder against Cloudflare Pages' limits before anyone deploys it.
 *
 * `apps/site/public` is the whole deploy output, so the count that matters is the
 * number of files *committed* there. One folder is the trap: `assets/flags/mods/`
 * (the 14,550-file per-mod export) lives in the tree but is gitignored, so a git
 * deploy ships the right set while a direct `wrangler pages deploy` would silently
 * push past the 20,000-file ceiling. This script counts both ways and says so.
 *
 *   node scripts/verify-deploy.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Cloudflare Pages, Free plan: https://developers.cloudflare.com/pages/platform/limits/ */
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const SITE = 'apps/site/public';
/** Present locally, gitignored, and never part of a deploy. */
const LOCAL_ONLY = ['assets/flags/mods/'];

/** Entry points and folders the deployed site must have. */
const REQUIRED_FILES = [
  'index.html',
  'app.js',
  'style.css',
  'viewer.html',
  'viewer.js',
  'viewer-page.js',
  'paint.js',
  'page-theme.js',
  'eu4-parser.js',
  'parser.js',
  'viewer-data.js',
  'viewer-build.js',
  'game-data.js',
  'game-folder.js',
  'game-localisation.js',
  'game-tables.js',
  'wallpapers.json',
];
const REQUIRED_DIRS = [
  'assets/flags/base',
  'assets/flags/modded',
  '背景图',
  // The panel artwork, published by `scripts/export-ui-assets.ts` (one folder per
  // family, every file named after the game key). Each of these is checked for
  // being non-empty below.
  'assets/ui/buildings',
  'assets/ui/great_projects',
  'assets/ui/terrain',
  'assets/ui/religions',
  'assets/ui/institutions',
  'assets/ui/government_reforms',
  'assets/ui/ideas',
  'assets/ui/modifiers',
  'assets/ui/icons',
  // Wave 2 (country panel: estates / privileges / advisors).
  'assets/ui/estates',
  'assets/ui/privileges',
  'assets/ui/advisors',
];

/**
 * Floors, not exact counts: adding artwork must not fail the gate, but losing a
 * family (a `rm -rf`, a bad export, an empty folder in git) must.
 */
const UI_FAMILIES: Array<{ dir: string; min: number; label: string }> = [
  { dir: 'assets/ui/buildings', min: 47, label: 'building icons' },
  { dir: 'assets/ui/great_projects', min: 141, label: 'great project art' },
  { dir: 'assets/ui/terrain', min: 17, label: 'terrain art' },
  { dir: 'assets/ui/religions', min: 28, label: 'religion icons' },
  { dir: 'assets/ui/institutions', min: 8, label: 'institution icons' },
  { dir: 'assets/ui/government_reforms', min: 660, label: 'government reform icons' },
  { dir: 'assets/ui/ideas', min: 28, label: 'idea group icons' },
  { dir: 'assets/ui/modifiers', min: 900, label: 'modifier icons' },
  { dir: 'assets/ui/icons', min: 60, label: 'scalar and diplomacy icons' },
  { dir: 'assets/ui/estates', min: 22, label: 'estate icons and estate glyphs' },
  { dir: 'assets/ui/privileges', min: 420, label: 'estate privilege icons' },
  { dir: 'assets/ui/advisors', min: 130, label: 'advisor portraits' },
];

let failures = 0;
const report = (ok: boolean, label: string, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

if (!existsSync(SITE)) {
  console.log(`FAIL ${SITE} does not exist`);
  process.exit(1);
}

// ---------------------------------------------------------------- inventory ---
const all: Array<{ path: string; size: number }> = [];
for (const entry of readdirSync(SITE, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const parent = entry.parentPath ?? entry.path ?? SITE;
  const path = join(parent, entry.name).slice(SITE.length + 1).replace(/\\/g, '/');
  all.push({ path, size: statSync(join(parent, entry.name)).size });
}

const isLocalOnly = (path: string): boolean => LOCAL_ONLY.some((prefix) => path.startsWith(prefix));
const deployed = all.filter((file) => !isLocalOnly(file.path));
const localOnly = all.filter((file) => isLocalOnly(file.path));
const totalMb = (files: Array<{ size: number }>): string =>
  (files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1);

console.log(`site folder: ${all.length.toLocaleString()} files, ${totalMb(all)} MB on disk`);
console.log(`deployable:  ${deployed.length.toLocaleString()} files, ${totalMb(deployed)} MB`);
if (localOnly.length) {
  console.log(`local only:  ${localOnly.length.toLocaleString()} files, ${totalMb(localOnly)} MB (${LOCAL_ONLY.join(', ')})`);
}

// ------------------------------------------------------------------- limits ---
report(
  deployed.length <= MAX_FILES,
  `file count within ${MAX_FILES.toLocaleString()}`,
  `${deployed.length.toLocaleString()} (${(100 * deployed.length / MAX_FILES).toFixed(1)}% of the limit)`,
);
// The warning that matters: someone deploying the folder directly.
if (all.length > MAX_FILES) {
  console.log(
    `  note: with the local-only folders included this is ${all.length.toLocaleString()} files, over the limit.\n` +
      '  note: deploy through git (Cloudflare Pages + GitHub), never `wrangler pages deploy` on this folder.',
  );
}
const oversized = all.filter((file) => file.size > MAX_FILE_BYTES);
report(
  oversized.length === 0,
  `every file within ${MAX_FILE_BYTES / 1024 / 1024} MiB`,
  oversized.length ? oversized.map((f) => `${f.path} ${(f.size / 1024 / 1024).toFixed(1)} MB`).join(', ') : 'largest ' +
    `${(Math.max(...all.map((f) => f.size)) / 1024 / 1024).toFixed(2)} MB`,
);

// --------------------------------------------------------------- entry points -
const paths = new Set(all.map((file) => file.path));
const missingFiles = REQUIRED_FILES.filter((file) => !paths.has(file));
report(missingFiles.length === 0, 'the site entry points are present', missingFiles.join(', ') || `${REQUIRED_FILES.length} files`);
const missingDirs = REQUIRED_DIRS.filter((dir) => !all.some((file) => file.path.startsWith(`${dir}/`)));
report(missingDirs.length === 0, 'the shared artwork folders are present', missingDirs.join(', ') || REQUIRED_DIRS.length + ' folders');

// ------------------------------------------------------------- panel artwork --
// `scripts/export-ui-assets.ts` writes these; the client builds every URL as
// `/assets/ui/<family>/<gameKey>.png`, so a family that is empty (or lost a chunk
// of its keys) is a broken panel, not a missing nicety. The site total is reported
// alongside because this folder is the biggest thing the deploy grew.
{
  const ui = all.filter((file) => file.path.startsWith('assets/ui/'));
  // The nine artwork families only: `assets/ui/*.json` is the game-file tables'
  // own folder and is not part of this script's artwork accounting.
  const artPaths = new Set(UI_FAMILIES.map((family) => family.dir));
  const art = ui.filter((file) => artPaths.has(file.path.slice(0, file.path.lastIndexOf('/'))));
  const uiBytes = art.reduce((sum, file) => sum + file.size, 0);
  console.log(
    `  ui artwork:  ${art.length.toLocaleString()} files, ${(uiBytes / 1024 / 1024).toFixed(1)} MB ` +
      `(${((100 * uiBytes) / deployed.reduce((sum, file) => sum + file.size, 0)).toFixed(0)}% of the deploy)` +
      ` + ${ui.length - art.length} table file(s) in assets/ui`,
  );
  const empty = UI_FAMILIES.filter(({ dir }) => !art.some((file) => file.path.startsWith(`${dir}/`)));
  report(empty.length === 0, 'every ui family folder is non-empty', empty.map((f) => f.dir).join(', ') || `${UI_FAMILIES.length} families`);
  const short = UI_FAMILIES.map((family) => ({ ...family, count: art.filter((file) => file.path.startsWith(`${family.dir}/`)).length }))
    .filter((family) => family.count < family.min);
  report(
    short.length === 0,
    'every ui family is fully populated',
    short.length
      ? short.map((f) => `${f.label} ${f.count}/${f.min}`).join(', ')
      : UI_FAMILIES.map((f) => `${f.label} ${art.filter((file) => file.path.startsWith(`${f.dir}/`)).length}`).join(', '),
  );
  // File names are the client's contract: `/assets/ui/buildings/` + key + '.png',
  // concatenated verbatim. The rule the artwork has to satisfy is therefore
  // "exactly the game's own key", which is *not* the same as "lowercase": 34
  // tag-specific estate privileges are spelled with an uppercased tag
  // (`estate_church_BYZ_legitimization_of_dynasty`) and the save keeps that casing,
  // so lowercasing them would 404 on the case-sensitive host.
  //
  // What the original lowercase rule actually guards against is two files in one
  // family differing only by case: that breaks on a case-insensitive checkout and
  // resolves differently on Windows and Linux. That is checked directly below.
  //
  // Only the twelve artwork folders are policed: `assets/ui/*.json` (the game-file
  // tables) sits at the root of the same folder and is not this script's business.
  const oddNames = art.filter((file) => !/^assets\/ui\/[A-Za-z0-9_]+\/[A-Za-z0-9_-]+\.png$/.test(file.path));
  report(oddNames.length === 0, 'every ui artwork file name is a game key', oddNames.length ? oddNames.slice(0, 6).map((f) => f.path).join(', ') : `${art.length} artwork files, all [A-Za-z0-9_-]`);
  const byLower = new Map<string, string[]>();
  for (const file of art) {
    const lower = file.path.toLowerCase();
    byLower.set(lower, [...(byLower.get(lower) ?? []), file.path]);
  }
  const collisions = [...byLower.values()].filter((paths) => paths.length > 1);
  report(
    collisions.length === 0,
    'no two ui artwork names differ only by case',
    collisions.length ? collisions.slice(0, 4).map((paths) => paths.join(' vs ')).join('; ') : 'case collisions would break a Windows checkout',
  );
  const mixedCase = art.filter((file) => file.path !== file.path.toLowerCase());
  console.log(`  mixed-case game keys: ${mixedCase.length}${mixedCase.length ? ` (e.g. ${mixedCase.slice(0, 3).map((f) => f.path.split('/').pop()).join(', ')})` : ''}`);
}

// ------------------------------------------------------------------- artwork --
const flagsIn = (dir: string): Set<string> =>
  new Set(
    all
      .filter((file) => file.path.startsWith(`${dir}/`) && file.path.endsWith('.png'))
      .map((file) => file.path.slice(dir.length + 1, -4).toUpperCase()),
  );
const base = flagsIn('assets/flags/base');
const modded = flagsIn('assets/flags/modded');
const hasFlag = (tag: string): boolean => base.has(tag) || modded.has(tag);
report(base.size > 900, 'base flag set', `${base.size} flags`);
report(modded.size > 900, 'modded flag set', `${modded.size} flags`);
// The `colonial/` and `colonial-modded/` composites are retired: a colony is drawn
// as its mother country's flag plus a right-half colour block, in the browser. So
// there is no "colonial flag missing" case left to gate — the artwork that has to
// exist is the *parent's*, which the coverage check below now looks at directly.

/**
 * The tags whose artwork a visitor can actually notice missing.
 *
 * A flag <img> is built in exactly two places: the leaderboard rows (viewer-build.js)
 * and the power-curve legend (viewer.js). Everything else on the map is a colour, so
 * a tag with no artwork there is invisible rather than broken. Reading the generated
 * page is what makes this exact — the alternative, "every tag in the save", counted
 * 395 dynamic K/C/F tags that are never drawn as a flag.
 *
 * A colonial tag (`C##`/`D##`) is drawn with its mother country's flag, so it is
 * covered once that parent has artwork of its own.
 */
const generated = 'tmp/timeline/index.html';
if (!existsSync(generated)) {
  console.log('  note: no tmp/timeline/index.html — run `pnpm timeline` to also check flag coverage');
} else {
  const html = readFileSync(generated, 'utf8');
  const jsonConst = (name: string): unknown => {
    const line = html.split('\n').find((l) => l.startsWith(`const ${name} = `));
    if (!line) throw new Error(`${name} not found in the generated page`);
    return JSON.parse(line.slice(`const ${name} = `.length).replace(/;$/, ''));
  };
  const data = jsonConst('DATA') as { tags: string[]; curves: { tags: number[] } };
  const panels = jsonConst('VIEWER_PANELS') as { leaders: string };
  const parents = (data as unknown as { colonialParent: Record<string, string> }).colonialParent;

  const displayed = new Set<string>();
  for (const match of panels.leaders.matchAll(/data-tag="([A-Za-z0-9_]+)"/g)) displayed.add(match[1] as string);
  for (const index of data.curves.tags) displayed.add(data.tags[index] as string);

  const uncovered = [...displayed].filter((tag) => {
    if (hasFlag(tag)) return false;
    const parent = parents[tag];
    return !(parent && hasFlag(parent));
  });
  report(
    uncovered.length === 0,
    'every flag the page draws exists',
    uncovered.length
      ? `${uncovered.join(', ')} would show no flag`
      : `${displayed.size} tags (leaderboard + curve legend): ${[...displayed].join(' ')}`,
  );

  // Informational: how much of the save's tag list has artwork at all. Every name
  // without one is a dynamic family the game creates at runtime (C = colonial,
  // E = , D = client state, K/F/O = mod or event countries) or the `---` placeholder,
  // never a historical country — the map paints those in their country colour, and a
  // colony draws its mother country's flag instead of one of its own.
  const dynamic = /^(PROV\d+|[A-Z]\d\d|---)$/;
  const withoutArt = data.tags.filter((tag) => !hasFlag(tag));
  const nonDynamic = withoutArt.filter((tag) => !dynamic.test(tag));
  console.log(
    `  tags with no artwork anywhere: ${withoutArt.length}/${data.tags.length}` +
      ` (${withoutArt.filter((t) => /^C\d\d$/.test(t)).length} colonial, ` +
      `${withoutArt.filter((t) => /^PROV\d+$/.test(t)).length} PROV*, ` +
      `the rest dynamic/placeholder; not a historical country among them: ${nonDynamic.length === 0})`,
  );
  if (nonDynamic.length) console.log(`  !! historical-looking tags without artwork: ${nonDynamic.slice(0, 12).join(', ')}`);
}

// ---------------------------------------------------------------- wallpapers --
const wallpaperList = JSON.parse(readFileSync(join(SITE, 'wallpapers.json'), 'utf8')) as string[];
const missingWallpapers = wallpaperList.filter((name) => !paths.has(name));
report(
  missingWallpapers.length === 0,
  'every listed wallpaper is deployed',
  `${wallpaperList.length} listed, ${missingWallpapers.length} missing${missingWallpapers.length ? `: ${missingWallpapers.slice(0, 3).join(', ')}` : ''}`,
);

// The game data the viewer reads from the *visitor's* install must not be here: if it
// ever is, the page should stop asking for the folder (see viewer-page.js).
const gameData = ['map/provinces.bmp', 'map/definition.csv', 'map/default.map', 'assets/map/raster.png'];
const shippedGameData = gameData.filter((file) => paths.has(file));
console.log(
  `  game data shipped: ${shippedGameData.length ? shippedGameData.join(', ') : 'none (the viewer asks for the game folder)'}`,
);

console.log(failures ? `\n${failures} check(s) failed` : '\nthe site folder is ready to deploy');
process.exit(failures ? 1 : 0);
