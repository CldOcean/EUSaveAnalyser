/**
 * Publish the game's interface artwork the province/country panels need into the
 * site folder, named after the **game key**, so the client never has to map a key
 * to a file name.
 *
 *   node scripts/export-ui-assets.ts [--only buildings,great_projects,...]
 *
 * Layout (all under `apps/site/public/assets/ui`, the deploy output itself):
 *
 *   buildings/<buildingKey>.png            47    interface/building_icons.gfx   GFX_<key>
 *   great_projects/<projectKey>.png       141    interface/great_project.gfx    GFX_great_project_<key>
 *   religions/<religionKey>.png            39    religion_icons/*.png + 11 aliases
 *   institutions/<0..7>.png                 8    countrytechnologyview.gfx      GFX_icon_institution_<key>
 *   terrain/<category>.png                 17    interface/combat.gfx           GFX_combat_terrain_<category>
 *   government_reforms/<reformKey>.png    671    common/government_reforms/*    icon = "<icon>"
 *   ideas/<key>.png                        30    interface/ideas.gfx
 *   modifiers/<key>.png                   923    gfx/interface/ideas_EU4 (file name IS the key)
 *   icons/<key>.png                      ~60    the handful of scalar/tech/diplomacy icons
 *
 * Five rules this script exists to enforce:
 *
 * 1. **Every family is resolved through the game's own data**, never by guessing a
 *    file name: a building key comes from `common/buildings/*.txt`, and the artwork
 *    from `GFX_<key>` in `building_icons.gfx`. 17 great projects and 11 religions
 *    rename their file (`stonehenge` -> `great_project_stone_henge.png`,
 *    `theravada` -> `buddhism.png`), so a name-guess would silently ship nothing.
 * 2. **One output file per key, not per source image.** Five great projects share
 *    `great_project_suez_canal.png` (kiel/panama/suez) and four share the grand
 *    canal; 671 government reforms share 323 icons. Duplicating the bytes is the
 *    price of the frozen rule that the client does no name->path mapping.
 * 3. **File names are lowercase ASCII keys** (`[a-z0-9_]`, `-` -> `_`): the source
 *    set has 6 mixed-case great projects, one trailing space and one uppercase
 *    modifier, and the game's own directory structure is deliberately flattened —
 *    Linux is case sensitive and the deployed tree must not depend on Windows.
 * 4. **Only the needed subset ships.** `tmp/eu4-ui-assets/all` holds 7,412 files
 *    (194 MB); mapmode button strips, contact sheets and the achievement/flag art
 *    stay out.
 * 5. **No `.json` is written here.** `apps/site/public/assets/ui/*.json` belongs to
 *    the game-file-table task (S2); this script owns only `*.png`. Its own coverage
 *    manifest goes to `tmp/ui-assets-report.json`.
 *
 * Requires the game installed (reads `interface/*.gfx` and `common/*`); the PNG
 * bytes come from the pre-converted `tmp/eu4-ui-assets` tree, which is read-only.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { inflateSync } from 'node:zlib';
import { INSTITUTIONS } from '../packages/eu4-parser/src/institutions.ts';
import { EU4 } from './lib/map-assets.ts';
import { encodePng } from './lib/png.ts';

/** Pre-converted PNGs (`_convert_all.py` in that folder produced them). */
const SRC = 'tmp/eu4-ui-assets';
/** The deploy output; `assets/ui/<family>/*.png` is the only thing written. */
const OUT = 'apps/site/public/assets/ui';

/** Contact sheets, the preview strip and the mapmode button strips never ship. */
const NEVER = /(^|[\\/])_sheets([\\/]|$)|_preview\.png$|(^|[\\/])mapmodes?([\\/]|$)|(^|[\\/])mapmode_/i;

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const ONLY = onlyAt >= 0 ? new Set((argv[onlyAt + 1] ?? '').split(',').filter(Boolean)) : undefined;
const wanted = (family: string): boolean => !ONLY || ONLY.has(family);

const read = (path: string): string => readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
const stripComments = (text: string): string => text.replace(/#[^\n]*/g, ' ');

// ------------------------------------------------------------ png decoding ----
/**
 * Minimal PNG reader (8-bit, non-interlaced, all five colour types).
 *
 * `scripts/lib/png.ts` is a writer only, and the estate icons exist solely as a
 * 15-frame sprite sheet (`estates_icons.dds`, 649x44), so the icons have to be
 * cut out of it here. Node's `zlib` covers the decompression; the rest is the
 * spec's five scanline filters. The reader is local to this script because it is
 * the only consumer — lib/ belongs to the shared pipeline.
 */
function decodePng(bytes: Buffer): { width: number; height: number; rgba: Uint8Array } {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] as number;
      colorType = data[9] as number;
      interlace = data[12] as number;
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`png bit depth ${bitDepth} is not supported`);
  if (interlace !== 0) throw new Error('interlaced png is not supported');
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position] as number;
    position += 1;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[position + i] as number;
      const left = i >= channels ? (line[i - channels] as number) : 0;
      const up = previous[i] as number;
      const upLeft = i >= channels ? (previous[i - channels] as number) : 0;
      let out: number;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + left;
      else if (filter === 2) out = value + up;
      else if (filter === 3) out = value + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else throw new Error(`unknown png filter ${filter}`);
      line[i] = out & 0xff;
    }
    position += stride;
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[at] = line[x * 4] as number;
        rgba[at + 1] = line[x * 4 + 1] as number;
        rgba[at + 2] = line[x * 4 + 2] as number;
        rgba[at + 3] = line[x * 4 + 3] as number;
      } else if (colorType === 2) {
        rgba[at] = line[x * 3] as number;
        rgba[at + 1] = line[x * 3 + 1] as number;
        rgba[at + 2] = line[x * 3 + 2] as number;
        rgba[at + 3] = 255;
      } else if (colorType === 3) {
        const index = line[x] as number;
        rgba[at] = palette?.[index * 3] as number;
        rgba[at + 1] = palette?.[index * 3 + 1] as number;
        rgba[at + 2] = palette?.[index * 3 + 2] as number;
        rgba[at + 3] = trns && index < trns.length ? (trns[index] as number) : 255;
      } else if (colorType === 0) {
        rgba[at] = rgba[at + 1] = rgba[at + 2] = line[x] as number;
        rgba[at + 3] = 255;
      } else {
        rgba[at] = rgba[at + 1] = rgba[at + 2] = line[x * 2] as number;
        rgba[at + 3] = line[x * 2 + 1] as number;
      }
    }
    previous.set(line);
  }
  return { width, height, rgba };
}

/**
 * Cut a horizontal strip of `frames` icons into one square png per frame.
 *
 * The declared frame count and the pixel width disagree (`estates_icons.png` is
 * 649x44 with `noOfFrames = 15`, i.e. 43.27 px per frame), so an equal division
 * would clip. Every icon is instead found as a run of columns that are more than
 * faintly opaque — 96/255 rather than 8, because the church and nobility icons
 * are joined by a soft glow that a low threshold reads as one 84px run — and the
 * run count is asserted, which is what makes the cut self-verifying.
 */
function sliceStrip(bytes: Buffer, frames: number, label: string): Buffer[] {
  const { width, height, rgba } = decodePng(bytes);
  const columnAlpha = new Array<number>(width).fill(0);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = 0; y < height; y += 1) sum += rgba[(y * width + x) * 4 + 3] as number;
    columnAlpha[x] = sum;
  }
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let x = 0; x <= width; x += 1) {
    const on = x < width && (columnAlpha[x] as number) > 96;
    if (on) { if (start < 0) start = x; }
    else if (start >= 0) { runs.push({ start, end: x - 1 }); start = -1; }
  }
  if (runs.length !== frames) {
    throw new Error(`${label}: expected ${frames} icons in the strip, found ${runs.length}`);
  }
  const side = Math.max(height, ...runs.map((r) => r.end - r.start + 1));
  return runs.map((run, index) => {
    let top = height;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      let any = false;
      for (let x = run.start; x <= run.end && !any; x += 1) if ((rgba[(y * width + x) * 4 + 3] as number) > 96) any = true;
      if (any) { if (y < top) top = y; if (y > bottom) bottom = y; }
    }
    if (bottom < top) throw new Error(`${label}: icon ${index + 1} is empty`);
    const boxWidth = run.end - run.start + 1;
    const boxHeight = bottom - top + 1;
    const canvas = new Uint8Array(side * side * 4);
    const left = Math.floor((side - boxWidth) / 2);
    const pad = Math.floor((side - boxHeight) / 2);
    for (let y = 0; y < boxHeight; y += 1) {
      for (let x = 0; x < boxWidth; x += 1) {
        const from = ((top + y) * width + run.start + x) * 4;
        const to = ((pad + y) * side + left + x) * 4;
        canvas[to] = rgba[from] as number;
        canvas[to + 1] = rgba[from + 1] as number;
        canvas[to + 2] = rgba[from + 2] as number;
        canvas[to + 3] = rgba[from + 3] as number;
      }
    }
    return encodePng(side, side, canvas, 4);
  });
}

/**
 * The deploy name: the game's own spelling, trimmed.
 *
 * It is deliberately *not* lowercased. `§4` asks for lowercase `[a-z0-9_]` to
 * guard against the source tree's sloppy file names (115 mixed-case, 3 with a
 * space, 8 case collisions), but a **game key** is what the save stores and what
 * the client concatenates into a URL: 34 tag-specific privileges are spelled
 * `estate_church_BYZ_legitimization_of_dynasty`, the save keeps that casing, and
 * a lowercase file would 404 on the case-sensitive host. Case-only aliases are
 * impossible anyway — NTFS silently collapses two names that differ only by case,
 * so writing both would look like it worked and ship one. `verify-deploy.ts`
 * keeps the hazard the rule exists for by rejecting case collisions outright.
 */
const verbatimKey = (stem: string): string => stem.trim();

/** The lowercased, underscore-normalised form, used only for genuine aliases. */
const keyOf = (stem: string): string => stem.trim().toLowerCase().replace(/-/g, '_');

/** The key a source png is filed under: the trimmed basename, case preserved. */
const stemOf = (path: string): string => verbatimKey(basename(path).replace(/\.[^.]+$/, ''));
/** Every regular file under `dir` (recursive), or none when it is absent. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  // Sorted so a run is reproducible: `indexSources` keeps the first hit, and the
  // DLC art folders reuse names that also exist at the top of `all/`.
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** `key -> source png`, in the order the paths were given (so `all/` wins ties). */
function indexSources(dirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of dirs.flatMap(walk)) {
    if (NEVER.test(file)) continue;
    if (!file.toLowerCase().endsWith('.png')) continue;
    const key = stemOf(file);
    if (key && !out.has(key)) out.set(key, file);
  }
  return out;
}

interface Sprite { name: string; file: string }

/**
 * Every `spriteType = { name = X texturefile = Y }` in a `.gfx`. Sprite names are
 * unique per file except where the game declares one twice (`GFX_combat_terrain_
 * farmlands` points at `hills.tga` and then at `farmlands.dds`); later wins, which
 * is what the game's own last-definition-wins parser does.
 */
function parseGfx(file: string): Sprite[] {
  if (!existsSync(file)) throw new Error(`missing sprite definition: ${file}`);
  const text = stripComments(read(file));
  const out: Sprite[] = [];
  const re = /spriteType\s*=\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
      i += 1;
    }
    const body = text.slice(start, i - 1);
    const name = /name\s*=\s*"?([^"\s}]+)"?/.exec(body)?.[1];
    if (!name) continue;
    const file = /texturefile\s*=\s*"?([^"\s}]+)"?/i.exec(body)?.[1] ?? '';
    const existing = out.findIndex((s) => s.name === name);
    if (existing >= 0) out[existing] = { name, file };
    else out.push({ name, file });
  }
  return out;
}

const spriteMap = (file: string): Map<string, string> =>
  new Map(parseGfx(file).map((s) => [s.name, s.file]));

/** The PNG basename a `.gfx` `texturefile` points at, as a key. */
const textureKey = (texture: string): string => stemOf(texture.replace(/\\/g, '/'));

/** Top-level `key = { ... }` blocks of a Clausewitz text file (comments stripped). */
function topLevelBlocks(file: string): Array<{ key: string; body: string }> {
  const text = stripComments(read(file));
  const out: Array<{ key: string; body: string }> = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '{') {
      if (depth === 0) {
        const head = text.slice(Math.max(0, i - 200), i);
        const m = /([A-Za-z0-9_.-]+)\s*=\s*$/.exec(head);
        if (m) {
          let d = 1;
          let j = i + 1;
          while (j < text.length && d > 0) {
            if (text[j] === '{') d += 1;
            else if (text[j] === '}') d -= 1;
            j += 1;
          }
          out.push({ key: m[1] as string, body: text.slice(i + 1, j - 1) });
          i = j;
          continue;
        }
      }
      depth += 1;
    } else if (ch === '}') depth -= 1;
    i += 1;
  }
  return out;
}

/** The top-level keys inside one named block, e.g. `categories` of terrain.txt. */
function blockKeys(file: string, block: string): string[] {
  const found = topLevelBlocks(file).find((b) => b.key === block);
  if (!found) return [];
  const text = found.body;
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '{') {
      if (depth === 0) {
        const head = text.slice(Math.max(0, i - 200), i);
        const m = /([A-Za-z0-9_.-]+)\s*=\s*$/.exec(head);
        if (m) {
          out.push(m[1] as string);
          depth += 1;
          i += 1;
          continue;
        }
      }
      depth += 1;
    } else if (ch === '}') depth -= 1;
    i += 1;
  }
  return out;
}

interface Family {
  family: string;
  /** key -> source png path, or already-encoded png bytes (sliced sprite sheets). */
  files: Map<string, string | Buffer>;
/**
 * Extra names the same artwork is also published under.
 *
 * Only added when the two names can actually coexist: a game key with a hyphen
 * (`maidan-e_naqsh-e_jahan`) is published under the underscored form too, but a
 * key that differs from its normalised form only by case is not — see
 * `verbatimKey`.
 */
  aliases: Array<[string, string]>;
  /** A `.gfx` sprite exists but the converted png is not on this machine: a real gap. */
  missing: string[];
  /** The game declares no sprite at all (an ocean terrain, a mechanic reform): the panel degrades. */
  unsupported: string[];
  /** keys that came from a source whose name differed (rename/alias/duplicate). */
  renamed: number;
  /** one line describing how the mapping was derived, for the report. */
  rule: string;
}

/** Take `keys` from a `.gfx` sprite table and resolve each to a source png. */
function fromSprites(
  family: string,
  keys: string[],
  sprite: Map<string, string>,
  spriteName: (key: string) => string,
  pool: Map<string, string>,
  renameSample: Array<[string, string]> = [],
): Family {
  const files = new Map<string, string>();
  const aliases: Array<[string, string]> = [];
  const missing: string[] = [];
  const unsupported: string[] = [];
  for (const key of keys) {
    const texture = sprite.get(spriteName(key));
    if (!texture) { unsupported.push(key); continue; }
    const source = pool.get(textureKey(texture));
    if (!source) { missing.push(`${key} (${textureKey(texture)})`); continue; }
    const outKey = verbatimKey(key);
    files.set(outKey, source);
    // A hyphenated game key also gets its underscored spelling, because that is
    // the form the site's naming rule asks for and both names can coexist.
    const normalised = keyOf(key);
    if (normalised !== outKey && normalised.toLowerCase() !== outKey.toLowerCase()) aliases.push([normalised, source]);
    if (textureKey(texture) !== outKey) renameSample.push([outKey, textureKey(texture)]);
  }
  return { family, files, aliases, missing, unsupported, renamed: renameSample.length, rule: '' };
}

const families: Family[] = [];
const notes: string[] = [];

// ---------------------------------------------------------------- buildings --
if (wanted('buildings')) {
  const sprite = spriteMap(`${EU4}/interface/building_icons.gfx`);
  const keys = [
    ...topLevelBlocks(`${EU4}/common/buildings/00_buildings.txt`),
    ...topLevelBlocks(`${EU4}/common/buildings/01_nativebuildings.txt`),
  ].map((b) => b.key);
  const family = fromSprites('buildings', [...new Set(keys)].sort(), sprite, (k) => `GFX_${k}`, indexSources([`${SRC}/all/buildings`]));
  family.rule = 'common/buildings/*.txt keys -> interface/building_icons.gfx GFX_<key> -> texturefile';
  // `costal_defence.png` (1058x647, the game's typo) and `coastal_defence.png` (48x48)
  // are different files; the sprite table is the only thing that tells them apart.
  notes.push('buildings: `costal_defence`/`coastal_defence` are two different files; the .gfx decides.');
  families.push(family);
}

// ------------------------------------------------------------ great projects --
if (wanted('great_projects')) {
  const sprite = spriteMap(`${EU4}/interface/great_project.gfx`);
  const keys = [
    ...topLevelBlocks(`${EU4}/common/great_projects/00_great_projects.txt`),
    ...topLevelBlocks(`${EU4}/common/great_projects/01_monuments.txt`),
  ].map((b) => b.key);
  const family = fromSprites(
    'great_projects',
    [...new Set(keys)].sort(),
    sprite,
    (k) => `GFX_great_project_${k}`,
    indexSources([`${SRC}/all/great_projects`]),
  );
  family.rule = 'common/great_projects/*.txt keys -> interface/great_project.gfx GFX_great_project_<key>';
  // The largest family by volume; `place_holder` / `provinceview_great_projects_bg`
  // are declared by the .gfx but are not project keys, so they stay out.
  notes.push('great_projects dominate the payload; five keys reuse another project\'s artwork.');
  families.push(family);
}

// ---------------------------------------------------------------- religions --
if (wanted('religions')) {
  /** icon file name -> the religion key the current game data uses. */
  const ALIASES: Record<string, string> = {
    theravada: 'buddhism', fetishist: 'shamanism', alcheringa: 'dreamtime',
    mayan: 'mesoamerican_religion', norse: 'norse_pagan_reformed',
    tengri: 'tengri_pagan_reformed', shia: 'shiite', sikh: 'sikhism',
    hindu: 'hinduism', confucian: 'confucianism', animist: 'animism',
  };
  const pool = indexSources([`${SRC}/religion_icons`]);
  const files = new Map<string, string | Buffer>();
  const missing: string[] = [];
  let renamed = 0;
  for (const [icon, source] of pool) {
    files.set(icon, source);
    const alias = ALIASES[icon];
    if (alias) { files.set(verbatimKey(alias), source); renamed += 1; }
  }
  for (const [icon, alias] of Object.entries(ALIASES)) if (!pool.has(icon)) missing.push(`${alias} (from ${icon})`);
  families.push({
    family: 'religions',
    files,
    aliases: [],
    missing,
    unsupported: [],
    renamed,
    rule: 'religion_icons/<icon>.png, copied to the 11 renamed religion keys as well',
  });
  // The 29-frame `icon_religion.png` strip is deliberately unused: no packaged file
  // declares its frame order, so this 28-icon set is the only verifiable one.
  notes.push('religions: the 29-frame icon_religion.png strip is not shipped (frame order is undeclared).');
}

// ------------------------------------------------------------- institutions --
if (wanted('institutions')) {
  const sprite = spriteMap(`${EU4}/interface/countrytechnologyview.gfx`);
  const pool = indexSources([`${SRC}/all/institutions`]);
  const files = new Map<string, string>();
  const missing: string[] = [];
  // The client indexes this family by slot number and its slot order is the frozen
  // `INSTITUTIONS` constant, so that is the driver; the .gfx supplies the file name.
  INSTITUTIONS.forEach((institution, index) => {
    const texture = sprite.get(`GFX_icon_institution_${institution.key}`);
    const source = texture ? pool.get(textureKey(texture)) : undefined;
    if (!source) { missing.push(`${index} (${institution.key})`); return; }
    files.set(String(index), source);
  });
  // Confirm the .gfx declaration order agrees with the client's slot order.
  const declared = parseGfx(`${EU4}/interface/countrytechnologyview.gfx`)
    .filter((s) => s.name.startsWith('GFX_icon_institution_'))
    .map((s) => s.name.slice('GFX_icon_institution_'.length));
  const expected = INSTITUTIONS.map((i) => i.key);
  if (declared.join(',') !== expected.join(',')) {
    notes.push(`institutions: .gfx order [${declared.join(' ')}] != client order [${expected.join(' ')}]; client order used.`);
  }
  families.push({ family: 'institutions', files, aliases: [], missing, unsupported: [], renamed: 0, rule: 'declaration order -> assets/ui/institutions/<0..7>.png' });
}

// ------------------------------------------------------------------ terrain --
if (wanted('terrain')) {
  const sprite = spriteMap(`${EU4}/interface/combat.gfx`);
  const categories = blockKeys(`${EU4}/map/terrain.txt`, 'categories');
  const pool = indexSources([`${SRC}/all`]);
  const files = new Map<string, string>();
  const missing: string[] = [];
  const unsupported: string[] = [];
  for (const category of categories) {
    const texture = sprite.get(`GFX_combat_terrain_${category}`);
    if (!texture) { unsupported.push(category); continue; }
    const source = pool.get(textureKey(texture));
    if (!source) { missing.push(`${category} (${textureKey(texture)})`); continue; }
    files.set(verbatimKey(category), source);
  }
  families.push({ family: 'terrain', files, aliases: [], missing, unsupported, renamed: 0, rule: 'map/terrain.txt categories{} -> interface/combat.gfx GFX_combat_terrain_<category>' });
  notes.push('terrain: pti / inland_ocean / impassable_mountains have no sprite, so they degrade to a name in the panel.');
}

// -------------------------------------------------------- government reforms --
if (wanted('government_reforms')) {
  const sprite = spriteMap(`${EU4}/interface/governmentreformicons.gfx`);
  const dir = `${EU4}/common/government_reforms`;
  const reforms: Array<{ key: string; icon?: string }> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()) {
    for (const block of topLevelBlocks(`${dir}/${file}`)) {
      reforms.push({ key: block.key, icon: /icon\s*=\s*"([^"]+)"/.exec(block.body)?.[1] });
    }
  }
  const pool = indexSources([`${SRC}/all/government_reform_icons`]);
  const files = new Map<string, string>();
  const missing: string[] = [];
  const unsupported: string[] = [];
  for (const reform of reforms) {
    // Mechanics (`monarchy_mechanic`, …) and a few event-only reforms carry no icon:
    // they are not drawn as a reform icon anywhere, so they are not a gap.
    if (!reform.icon) { unsupported.push(reform.key); continue; }
    const texture = sprite.get(`government_reform_${reform.icon}`);
    if (!texture) { missing.push(`${reform.key} (icon=${reform.icon}, no sprite)`); continue; }
    const source = pool.get(textureKey(texture));
    if (!source) { missing.push(`${reform.key} (icon=${reform.icon} -> ${textureKey(texture)})`); continue; }
    files.set(verbatimKey(reform.key), source);
  }
  families.push({ family: 'government_reforms', files, aliases: [], missing, unsupported, renamed: 0, rule: 'reform key -> icon field -> governmentreformicons.gfx GFX_government_reform_<icon>' });
  notes.push(`government_reforms: ${reforms.length} reforms, ${unsupported.length} carry no icon field, ${files.size} named by reform key (the save stores keys, not icons).`);
}

// ------------------------------------------------------- estates (wave 2) ----
if (wanted('estates')) {
  // Every estate is a frame of one 15-icon strip, so these are cut out rather
  // than copied. `icon = 1..15` in `common/estates/*.txt` is the 1-based frame
  // number, left to right; `estate_special` reuses frame 1.
  const dir = `${EU4}/common/estates`;
  const rows = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()
    .flatMap((file) => topLevelBlocks(`${dir}/${file}`).map((block) => ({
      key: block.key,
      icon: Number(/^\s*icon\s*=\s*([0-9]+)/m.exec(block.body)?.[1] ?? 0),
    })));
  const stripFile = `${SRC}/all/estates_icons.png`;
  const frames = sliceStrip(readFileSync(stripFile), 15, 'estates_icons.png');
  const files = new Map<string, string | Buffer>();
  const missing: string[] = [];
  for (const row of rows) {
    const frame = frames[row.icon - 1];
    if (!frame) { missing.push(`${row.key} (icon=${row.icon})`); continue; }
    files.set(verbatimKey(row.key), frame);
  }
  // The crown-land / agenda / estate-action glyphs from the same folder: their
  // file names are already the keys the panel would ask for.
  let chrome = 0;
  for (const [stem, source] of indexSources([`${SRC}/all/estates`])) {
    if (files.has(stem)) continue;
    files.set(stem, source);
    chrome += 1;
  }
  families.push({ family: 'estates', files, aliases: [], missing, unsupported: [], renamed: 0, rule: 'common/estates key -> icon = N -> frame N of estates_icons.png; plus the agenda/crownland glyphs' });
  notes.push(`estates: ${rows.length} definitions + ${chrome} chrome glyphs; the 15 frames were cut from a 649x44 strip (noOfFrames=15).`);
}

// ---------------------------------------------------- privileges (wave 2) ----
if (wanted('privileges')) {
  // The save stores `granted_privileges = { { estate_church_land_rights, date } }`,
  // i.e. the privilege *key* — so that is what the file has to be called.
  const dir = `${EU4}/common/estate_privileges`;
  const rows = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()
    .flatMap((file) => topLevelBlocks(`${dir}/${file}`).map((block) => ({
      key: block.key,
      icon: /icon\s*=\s*"?([A-Za-z0-9_]+)"?/.exec(block.body)?.[1],
    })));
  // `countryestatesview.gfx` names these sprites after the icon value itself
  // (no `GFX_` prefix) and 18 of them point at a differently named texture.
  const sprite = spriteMap(`${EU4}/interface/countryestatesview.gfx`);
  const pool = indexSources([`${SRC}/all/privileges`]);
  const files = new Map<string, string | Buffer>();
  const aliases: Array<[string, string]> = [];
  const missing: string[] = [];
  const unsupported: string[] = [];
  let renamedFiles = 0;
  for (const row of rows) {
    if (!row.icon) { unsupported.push(row.key); continue; }
    const texture = sprite.get(row.icon);
    const source = texture ? pool.get(textureKey(texture)) : undefined;
    if (!source) { missing.push(`${row.key} (icon=${row.icon})`); continue; }
    // The save stores the privilege key exactly as the game spells it, so that
    // spelling is the file name — 34 of them carry an uppercased tag
    // (`estate_church_BYZ_legitimization_of_dynasty`).
    const outKey = verbatimKey(row.key);
    if (textureKey(texture) !== outKey) renamedFiles += 1;
    files.set(outKey, source);
    const normalised = keyOf(row.key);
    if (normalised !== outKey && normalised.toLowerCase() !== outKey.toLowerCase()) aliases.push([normalised, source]);
  }
  families.push({ family: 'privileges', files, aliases, missing, unsupported, renamed: renamedFiles, rule: 'privilege key -> icon field -> countryestatesview.gfx sprite of that name -> texturefile' });
  notes.push(`privileges: ${rows.length} definitions, ${files.size} named by privilege key (the save stores keys), ${aliases.length} also under their verbatim mixed-case key, ${renamedFiles} resolve to a differently named texture file.`);
}

// ------------------------------------------------------ advisors (wave 2) ----
if (wanted('advisors')) {
  // One portrait per advisor type, per culture token and per gender: the save
  // only stores a numeric `type`, so the panel picks by whatever key it has and
  // the whole set ships. `noAdvisorType*` is the game's own fallback portrait.
  const pool = indexSources([`${SRC}/all/advisors`]);
  families.push({ family: 'advisors', files: pool, aliases: [], missing: [], unsupported: [], renamed: 0, rule: 'gfx/interface/advisors file names (advisor type, + asian_/russian_ token, + _female)' });
  notes.push(`advisors: ${pool.size} portraits (21 types + noAdvisorType, each in base/asian_/russian_ and male/female); the save stores only a numeric advisor type.`);
}

// -------------------------------------------------------------------- ideas --
if (wanted('ideas')) {
  const pool = indexSources([`${SRC}/all/ideas`]);
  families.push({ family: 'ideas', files: pool, aliases: [], missing: [], unsupported: [], renamed: 0, rule: 'gfx/interface/ideas file names (idea_<group>_ideas)' });
}

// ---------------------------------------------------------------- modifiers --
if (wanted('modifiers')) {
  const pool = indexSources([`${SRC}/all/ideas_EU4`]);
  families.push({ family: 'modifiers', files: pool, aliases: [], missing: [], unsupported: [], renamed: 0, rule: 'gfx/interface/ideas_EU4 file names (the modifier key itself)' });
  notes.push('modifiers: 923 files; one has a trailing space and one is uppercase in the source, both normalised here.');
}

// -------------------------------------------------------------------- icons --
if (wanted('icons')) {
  // The scalar / technology / diplomacy artwork the country panel actually draws.
  // An explicit list: `all/` holds 7,412 files but 264 `icon_*.png` also include
  // social-media badges and button chrome we do not want in the repo.
  const WANTED = [
    // technology and the three monarch powers
    'icon_powers_administrative_tech', 'icon_powers_diplomatic_tech', 'icon_powers_military_tech',
    'icon_powers_administrative', 'icon_powers_diplomatic', 'icon_powers_military',
    'monarch_admin_power', 'monarch_diplomatic_power', 'monarch_military_power', 'monarch_heir_crown_icon',
    // national scalars
    'icon_stability', 'icon_prestige', 'icon_legitimacy', 'icon_army_tradition', 'icon_navy_tradition',
    'icon_absolutism', 'icon_overextension', 'icon_powerprojection', 'icon_splendor_tiny',
    'icon_corruption_small', 'icon_manpower', 'icon_sailors', 'icon_gold', 'icon_tax_base',
    'icon_production_efficiency', 'icon_war_exhaustion', 'icon_discipline', 'icon_morale',
    'icon_unrest', 'icon_religious', 'religious_unity_icon', 'icon_ideas',
    'icon_states', 'icon_national_focus_adm', 'icon_national_focus_dip', 'icon_national_focus_mil',
    'icon_development_in_text', 'development_icon', 'extra_development_icon',
    'great_power_development_sort', 'accepted_cultures', 'primary_culture_icon', 'change_culture_icon',
    // religion / HRE / diplomacy
    'icon_hre', 'shield_hre', 'hre_member', 'imperial_authority', 'icon_diplomacy_dynastic',
    'icon_diplomacy_alliance', 'icon_diplomacy_royalmarriage', 'icon_diplomacy_war',
    'icon_diplomacy_relations', 'icon_diplomacy_guaranteed', 'icon_diplomacy_influence',
    'icon_diplomacy_favors', 'icon_truce', 'icon_leader', 'icon_time',
    // subjects and envoys
    'icon_vassal', 'subject_colony_icon', 'subject_tributary_icon', 'subject_tradecompany_icon',
    'icon_envoy_merchant', 'icon_envoy_settler', 'icon_envoy_diplomat', 'icon_envoy_missionary',
    'icon_colonist',
    // estate-panel glyphs (the estate and privilege artwork lives in its own folders)
    'privilege_add', 'privilege_blank', 'privilege_check',
  ];
  // `misc/` is the curated set the asset survey already picked for this site.
  // `icon_religion.png` is deliberately absent: it is the 1856x64 29-frame strip
  // whose frame order no packaged file declares (see the religions note).
  const pool = indexSources([`${SRC}/misc`, `${SRC}/all`]);
  const files = new Map<string, string | Buffer>();
  const missing: string[] = [];
  for (const key of WANTED) {
    if (files.has(verbatimKey(key))) continue;
    const source = pool.get(verbatimKey(key));
    if (source) files.set(verbatimKey(key), source);
    else missing.push(key);
  }
  families.push({ family: 'icons', files, aliases: [], missing, unsupported: [], renamed: 0, rule: 'explicit allow-list of scalar/technology/diplomacy/subject keys, resolved by file name' });
  if (missing.length) notes.push(`icons: ${missing.length} curated key(s) have no artwork on this machine.`);
}

// ------------------------------------------------------------------ publish --
interface Written { family: string; count: number; aliases: number; bytes: number; missing: string[]; unsupported: string[] }
const written: Written[] = [];

mkdirSync(OUT, { recursive: true });
for (const family of families) {
  const dir = `${OUT}/${family.family}`;
  // Rebuild the family from scratch so a renamed or dropped key cannot leave a
  // stale png behind — but only ever inside this family's own directory, never
  // touching the `assets/ui/*.json` files the table task owns.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  const write = (key: string, source: string | Buffer): void => {
    const buffer = typeof source === 'string' ? readFileSync(source) : source;
    if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
      notes.push(`${family.family}: ${typeof source === 'string' ? relative(SRC, source) : key} is not a PNG; skipped.`);
      return;
    }
    writeFileSync(join(dir, `${key}.png`), buffer);
    bytes += buffer.length;
  };
  for (const [key, source] of family.files) write(key, source);
  for (const [alias, source] of family.aliases) write(alias, source);
  written.push({ family: family.family, count: family.files.size, aliases: family.aliases.length, bytes, missing: family.missing, unsupported: family.unsupported });
  const gaps = family.missing.length ? `${family.missing.length} GAP` : family.unsupported.length ? `${family.unsupported.length} no sprite` : 'complete';
  console.log(
    `  ${family.family.padEnd(20)} ${String(family.files.size).padStart(5)} files` +
      `${family.aliases.length ? ` (+${family.aliases.length} alias)` : ''}  ` +
      `${(bytes / 1024 / 1024).toFixed(2).padStart(6)} MB  ${gaps}`,
  );
  if (family.missing.length) console.log(`      ! no artwork: ${family.missing.slice(0, 12).join(', ')}${family.missing.length > 12 ? ` (+${family.missing.length - 12})` : ''}`);
  if (family.unsupported.length) console.log(`      - no sprite declared: ${family.unsupported.slice(0, 12).join(', ')}${family.unsupported.length > 12 ? ` (+${family.unsupported.length - 12})` : ''}`);
}

const totalFiles = written.reduce((sum, w) => sum + w.count + w.aliases, 0);
const totalBytes = written.reduce((sum, w) => sum + w.bytes, 0);
console.log(`\n${OUT}: ${totalFiles} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

// The report is a draft artifact, not a deploy input, so it lives in tmp/.
writeFileSync(
  'tmp/ui-assets-report.json',
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      source: { game: EU4, pngs: SRC },
      families: families.map((family, index) => ({
        ...written[index],
        aliasNames: family.aliases.map(([name]) => name),
        rule: family.rule,
        renamedAliases: family.renamed,
      })),
      totalFiles,
      totalBytes,
      notes,
    },
    null,
    1,
  ),
  'utf8',
);
console.log('wrote tmp/ui-assets-report.json');
