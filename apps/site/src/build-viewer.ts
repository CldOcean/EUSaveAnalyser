/**
 * Build the timeline viewer for a save that is already in the catalogue, and put
 * the result where the site can serve it.
 *
 * Why this runs locally: generating the viewer needs the game's own files
 * (`map/provinces.bmp`, `map/definition.csv`, `map/default.map`,
 * `common/religions`, localisation) plus a 57 MB inflate. Cloudflare gives a
 * Worker 10 ms of CPU and no filesystem, so this step cannot move there.
 *
 *   node apps/site/src/build-viewer.ts <id> --save "path/to.eu4"
 *   node apps/site/src/build-viewer.ts <id> --save x.eu4 --api https://site --token T
 *
 * Without `--api` the artifact is written straight into the local storage folder
 * (the same layout R2 uses).
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { SaveDocument } from '../../../packages/eu4-parser/src/document.ts';
import { EU4, MOD_LOCALISATION, WORKSHOP_ROOT } from '../../../scripts/lib/map-assets.ts';
import { buildGameMap } from '../public/game-data.js';
import { loadLocalisation, localise } from '../public/game-localisation.js';
import { loadReligionTable } from '../public/game-tables.js';
import { buildViewerData } from '../public/viewer-build.js';
import { SaveDocument as BrowserSaveDocument } from '../public/eu4-parser.js';
import { readMembers } from '../public/parser.js';
import { readIndex, writeIndex, type SaveRecord } from './api.ts';
import { diskStorage } from './storage-disk.ts';

const args = process.argv.slice(2);
const valueOf = (name: string, fallback?: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? (args[at + 1] as string) : fallback;
};
/** Any bare argument that is not a flag's value is treated as the save id. */
const id = args.find((arg, i) => !arg.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));

const savePath = valueOf('save');
const apiBase = valueOf('api');
const token = valueOf('token', process.env.UPLOAD_TOKEN);
const root = valueOf('root', '.dev-storage') as string;
const project = join(import.meta.dirname ?? '.', '..', '..', '..');

if (!savePath) {
  console.error('usage: build-viewer.ts [id] --save <file.eu4> [--api URL --token T] [--root .dev-storage]');
  process.exit(2);
}
if (!existsSync(savePath)) {
  console.error(`save not found: ${savePath}`);
  process.exit(2);
}

const bytes = readFileSync(savePath);
const hash = createHash('sha256').update(bytes).digest('hex');
// Without an explicit id the file names itself: same hash rule the upload API uses.
const saveId = id ?? hash.slice(0, 12);

// A temp copy because the renderer reads a real path and writes a folder.
const work = mkdtempSync(join(tmpdir(), 'eu4-viewer-'));
const localSave = join(work, basename(savePath));
cpSync(savePath, localSave);
const outDir = join(work, 'viewer');
mkdirSync(outDir, { recursive: true });

console.log(`[1/4] rendering timeline for ${saveId} (needs the game's map files)`);
const started = Date.now();
const output = execFileSync(
  process.execPath,
  [join(project, 'scripts', 'render-timeline.ts'), '--save', localSave, '--out', outDir],
  { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
const summary = output.split('\n').filter((line) => /wrote|elapsed/.test(line));
for (const line of summary) console.log(`      ${line.trim()}`);
console.log(`      rendered in ${((Date.now() - started) / 1000).toFixed(1)} s`);

// The parser runs here too, so the offline path produces a fully described record
// (the browser does the same thing for the web upload path).
let info: SaveRecord['info'];
try {
  const doc = await SaveDocument.fromFile(localSave, { sections: [] });
  info = {
    campaignDate: doc.meta.date,
    player: doc.meta.displayedCountryName ?? doc.meta.player,
    playerTag: doc.meta.player,
    version: doc.meta.version?.text,
    dlcCount: doc.meta.dlc?.length,
    mods: doc.meta.mods?.map((mod) => mod.name),
  };
      console.log(`      save info: ${info.campaignDate} / ${info.playerTag} / ${info.version} (${info.mods?.length ?? 0} mods)`);
} catch {
  console.log('      (could not read the save info; the viewer was still built)');
}

// ---------------------------------------------------------------------------
// One data.json, one shape.
//
// A save folder holds exactly one `viewer/data.json`, and the site reads it back
// through `viewer-store.js#loadStoredSave`, which requires the *browser* payload
// `{version, data, panels}` (`stored.data.tags` is its test). render-timeline writes
// its own bare data plane instead, and for a while the two producers overwrote each
// other on the same path: a rebuilt save then fell back to rebuilding in the browser
// (slow, and the card lost its colonial flags). So build the browser object here,
// with the very modules the site serves, prove the two planes agree key by key, and
// only then publish the payload in place of the bare file. A mismatch means the two
// implementations have drifted; publishing either of them would then be a guess, so
// the build fails and the existing file is left alone.
// ---------------------------------------------------------------------------
console.log(`[2/4] rebuilding the data plane with the site's own modules`);
const offlinePath = join(outDir, 'data.json');
const offline = JSON.parse(readFileSync(offlinePath, 'utf8')) as Record<string, unknown>;

// The exact loaders `viewer-build.test.ts` uses for the same comparison: the game's
// map, the Chinese localisation mod, the religions table (base + workshop mods, in
// that order — later files win).
const gameMap = buildGameMap({
  definitionCsv: new Uint8Array(readFileSync(join(EU4, 'map', 'definition.csv'))),
  defaultMap: new Uint8Array(readFileSync(join(EU4, 'map', 'default.map'))),
  provincesBmp: new Uint8Array(readFileSync(join(EU4, 'map', 'provinces.bmp'))),
});
const localisationFiles = [
  join(MOD_LOCALISATION, 'text_l_english.yml'),
  join(MOD_LOCALISATION, 'countries_l_english.yml'),
]
  .filter((path) => existsSync(path))
  .map((path) => ({ text: readFileSync(path, 'utf8'), source: path }));
const names = loadLocalisation(localisationFiles);
const religionSources = [
  { text: readFileSync(join(EU4, 'common', 'religions', '00_religion.txt'), 'utf8'), source: 'base' },
];
for (const dir of existsSync(WORKSHOP_ROOT) ? readdirSync(WORKSHOP_ROOT) : []) {
  const folder = join(WORKSHOP_ROOT, dir, 'common', 'religions');
  if (!existsSync(folder)) continue;
  for (const file of readdirSync(folder)) {
    if (file.endsWith('.txt')) religionSources.push({ text: readFileSync(join(folder, file), 'utf8'), source: `mod ${dir}` });
  }
}
const officialReligions = loadReligionTable(religionSources).colors;

// The detail panels read three static tables published under the site root
// (`apps/site/public/assets/ui/*.json`). `render-timeline.ts` bakes them into the
// offline plane, so the browser plane has to be handed the very same bytes — read as
// text, exactly like the browser's `fetch` path — or the key comparison below fails.
const uiTableText = (name: string): string | undefined => {
  const path = join(project, 'apps', 'site', 'public', 'assets', 'ui', name);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};
const uiTables = {
  uiNames: uiTableText('uiNames.json'),
  provinceTerrain: uiTableText('provinceTerrain.json'),
  area: uiTableText('area.json'),
  advisorIds: uiTableText('advisorIds.json'),
  ledgerSlots: uiTableText('ledgerSlots.json'),
  manaSlots: uiTableText('manaSlots.json'),
};

// The browser's own parser and builder, byte for byte what the page runs.
const doc = BrowserSaveDocument.fromMembers(await readMembers(new Uint8Array(bytes)));
const built = buildViewerData({
  doc,
  map: { ids: gameMap.ids, width: gameMap.width, height: gameMap.height, unmatched: gameMap.unmatched },
  water: gameMap.water,
  localise: (key) => localise(names, key),
  officialReligions,
  // render-timeline defaults to 1 and this script never passes `--scale`; any other
  // value would change `w`/`h` and be caught by the key comparison below.
  scale: 1,
  uiTables,
});
const browser = built.data as Record<string, unknown>;

const mismatched = Object.keys(offline).filter(
  (key) => JSON.stringify(browser[key]) !== JSON.stringify(offline[key]),
);
const extra = Object.keys(browser).filter((key) => !(key in offline));
if (mismatched.length > 0 || extra.length > 0) {
  console.error('      the offline and browser data planes disagree - nothing was published');
  if (mismatched.length > 0) console.error(`      differing keys (${mismatched.length}): ${mismatched.slice(0, 12).join(', ')}`);
  if (extra.length > 0) console.error(`      browser-only keys (${extra.length}): ${extra.slice(0, 12).join(', ')}`);
  console.error(`      ${offlinePath} still holds the offline plane; fix the drift and build again`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
// Same object `viewer-store.js#buildForSave` stores, so the two producers became one.
writeFileSync(offlinePath, JSON.stringify({ version: 2, data: built.data, panels: built.panels }));
console.log(
  `      data.json: payload v2, ${Object.keys(offline).length} data keys + 3 panels + ${built.panels.leaders.length} leaders - ` +
    'identical to the offline plane',
);

const files = readdirSync(outDir).map((name) => ({
  name,
  path: join(outDir, name),
  size: statSync(join(outDir, name)).size,
}));
console.log(`[3/4] uploading ${files.length} artifact(s): ${files.map((f) => f.name).join(', ')}`);

const storage = apiBase ? undefined : diskStorage(root);
for (const file of files) {
  const key = `saves/${saveId}/viewer/${file.name}`;
  const body = readFileSync(file.path);
  if (storage) {
    await storage.put(key, new Uint8Array(body));
  } else {
    const response = await fetch(`${apiBase}/api/saves/${id}/artifact?path=viewer/${encodeURIComponent(file.name)}`, {
      method: 'PUT',
      headers: { ...(token ? { 'x-upload-token': token } : {}) },
      body,
    });
    if (!response.ok) {
      console.error(`      upload failed for ${file.name}: ${response.status} ${await response.text()}`);
      process.exit(1);
    }
  }
  console.log(`      ${file.name}  ${(file.size / 1024 / 1024).toFixed(2)} MB`);
}

// Locally the record has to be marked ready by hand; through the API the html
// upload already did it. Both the per-save meta.json AND index.json are updated,
// otherwise the listing would keep serving its stale copy.
if (storage) {
  const env = { storage };
  const raw = await storage.get(`saves/${saveId}/meta.json`);
  const existing = raw ? (JSON.parse(new TextDecoder().decode(raw)) as SaveRecord) : undefined;
  if (!existing) {
    // Adding a save straight from a file is the offline equivalent of the web
    // upload: same id and layout, so the site picks it up without changes.
    console.log(`      adding ${saveId} to the catalogue (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    await storage.put(`saves/${saveId}/original.eu4`, new Uint8Array(bytes));
  }
  const updated: SaveRecord = {
    ...(existing ?? {
      id: saveId,
      name: basename(savePath),
      size: bytes.length,
      hash,
      uploadedAt: new Date().toISOString(),
      status: 'raw' as const,
    }),
    info: info ?? existing?.info,
    status: 'ready',
    viewer: `/saves/${saveId}/viewer/index.html`,
    // The file just published IS the payload `putArtifact` keys this flag off. The
    // local path writes storage directly (no API), so it has to set the flag itself,
    // otherwise the card would keep offering "generate in the browser".
    viewerData: true,
  };
  await storage.put(`saves/${saveId}/meta.json`, new TextEncoder().encode(JSON.stringify(updated)));
  const saves = await readIndex(env);
  await writeIndex(
    env,
    saves.some((entry) => entry.id === saveId)
      ? saves.map((entry) => (entry.id === saveId ? updated : entry))
      : [...saves, updated],
  );
}

console.log(`[4/4] done - viewer url: /saves/${saveId}/viewer/index.html`);
rmSync(work, { recursive: true, force: true });
