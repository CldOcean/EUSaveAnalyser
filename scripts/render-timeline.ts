/**
 * Build the monthly timeline player.
 *
 *   node scripts/render-timeline.ts [--scale 1]
 *
 * `--scale 1` keeps the raster at the game's native 5632x2048; larger values
 * shrink it (and the embedded PNG) at the cost of visible detail.
 *
 * Monthly resolution (1444.11 → the save's date is ~1,560 frames) and per-pixel
 * hatching make pre-rendered PNG frames impossible: that would be thousands of
 * multi-megabyte images. So, exactly like PDX Tools, the *server* ships data and
 * the *browser* draws:
 *
 *   raster.png   province id per pixel, id split across the R and G channels
 *   index.html   a self-contained player: the raster as a data URI, the province
 *                and country event logs inline, and `scripts/lib/paint.js`
 *                inlined so preview and app share one painter.
 *
 * The event logs are tiny because they are diffs, so scrubbing a month costs one
 * cursor step plus one repaint.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib/png.ts';
import { loadLocalisation, localise } from './lib/localisation.ts';
import { loadReligionTable, toHex as religionHex } from './lib/religions.ts';
import {
  EU4,
  MOD_LOCALISATION,
  WORKSHOP_ROOT,
  buildPalette,
  colorToIdMap,
  downscalePixels,
  hashColor,
  hslToRgb,
  loadDefinitions,
  loadProvincePixels,
  loadWaterIds,
  toHex,
  type RGB,
} from './lib/map-assets.ts';
import {
  PAINT_SOURCE,
  STRIPE_PERIOD,
  STRIPE_WIDTH,
  battleRamp,
  buildBorderMask,
  institutionRamp,
  packRgb,
  paintMap,
  techRamp,
} from './lib/paint-bundle.ts';
import { BlockView, SaveDocument, countryGroup, countryScalar } from '../packages/eu4-parser/src/document.ts';
import { SUBJECT_SHADE, familyTargets, isPlaceholderColour, shadeRgb, foreignTintFlags } from '../packages/eu4-parser/src/colours.ts';
import type { CountryRecord } from '../packages/eu4-parser/src/types.ts';
import { ClausewitzReader } from '../packages/eu4-parser/src/clausewitz.ts';
import { readInstitutionProgress, institutionLabel, INSTITUTIONS } from '../packages/eu4-parser/src/institutions.ts';
import {
  CountryTimelinePlayer,
  TimelinePlayer,
  buildCountryTimeline,
  buildTagAliases,
  buildTimeline,
  frameMonths,
  resolveTag,
  resolveTagLatest,
  timelineStats,
} from '../packages/eu4-parser/src/timeline.ts';
import { extractWars, warStats } from '../packages/eu4-parser/src/wars.ts';
import { buildDetailTables } from '../packages/eu4-parser/src/details.ts';
import { readSubjectLedger } from '../packages/eu4-parser/src/subjects.ts';
import { parseGameDate } from '../packages/eu4-parser/src/value.ts';
const argv = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};
const stringFlag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
};
/** Input save and output folder; the site's builder passes both explicitly. */
/**
 * The viewer's client script is a shared static asset: the hosted page loads the
 * same file, so the two hosts cannot drift apart.
 */
const VIEWER_SOURCE = readFileSync('apps/site/public/viewer.js', 'utf8');
/**
 * The shared background/theme component, inlined as a classic script.
 *
 * page-theme.js is an ES module: the catalogue imports it and viewer-page.js copies its
 * exports onto globalThis. Neither helps one self-contained HTML file, so strip the
 * `export ` keywords — exactly what scripts/lib/paint-bundle.ts does for paint.js — and
 * its declarations become the globals the player already reads on the hosted page.
 */
const THEME_SOURCE = readFileSync('apps/site/public/page-theme.js', 'utf8').replace(/^export /gm, '');
const SAVE = stringFlag('save', '存档示例/mp_俄罗斯1574_11_12.eu4');
const OUT = stringFlag('out', 'tmp/timeline');
const SCALE = Math.max(1, flag('scale', 1));
mkdirSync(OUT, { recursive: true });

const SEA: RGB = [26, 52, 84];
const LAKE: RGB = [42, 88, 128];
const UNOWNED: RGB = [88, 92, 98];
const NO_PROVINCE: RGB = [12, 12, 18];
const REBEL: RGB = [140, 30, 30];

/** Province fields the player replays. */
const PROVINCE_FIELDS = [
  'owner',
  'controller',
  'religion',
  'culture',
  'base_tax',
  'base_production',
  'base_manpower',
  /** Whether the province belongs to the Holy Roman Empire (`yes`/`no`). */
  'hre',
] as const;
/**
 * Country fields the player replays. `dynasty` is derived from the dated
 * `monarch` blocks in the country history.
 */
const COUNTRY_FIELDS = ['religion', 'dynasty'] as const;

/** Holy Roman Empire entity colours (there is no game-provided palette). */
const HRE_COLORS = {
  emperor: [216, 178, 58] as RGB,
  elector: [139, 92, 246] as RGB,
  freeCity: [59, 130, 246] as RGB,
  member: [107, 127, 106] as RGB,
  /** HRE land held by a country outside the empire. */
  foreign: [138, 109, 74] as RGB,
};

mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ assets ---
const definitions = loadDefinitions();
const water = loadWaterIds();
const fullPixels = loadProvincePixels(5632, 2048, colorToIdMap(definitions), { quiet: true });
const scaled = downscalePixels(fullPixels, 5632, 2048, SCALE);
const pixels = scaled.ids;
const width = scaled.width;
const height = scaled.height;
const borderMask = buildBorderMask(pixels, width, height, water.all);
console.log(`raster ${width}x${height} (1/${SCALE}), ${pixels.length.toLocaleString()} px`);

const doc = await SaveDocument.fromFile(SAVE);
const provinces = doc.provinces();
const countries = doc.countries();
const aliases = buildTagAliases(doc);
const names = loadLocalisation([
  `${MOD_LOCALISATION}/text_l_english.yml`,
  `${MOD_LOCALISATION}/countries_l_english.yml`,
]);

// --------------------------------------------------------------- timelines ---
const t0 = performance.now();
const timeline = buildTimeline(doc);
const countryTimeline = buildCountryTimeline(doc);
const stats = timelineStats(timeline);
console.log(
  `timeline: ${stats.provincesWithHistory} provinces / ${stats.eventCount.toLocaleString()} events / ` +
    `${stats.changeCount.toLocaleString()} changes (${(performance.now() - t0).toFixed(0)} ms)`,
);

const start = timeline.campaignStart ?? stats.startDate;
const months = frameMonths(start, doc.meta.date);
console.log(`frames: ${months.length} monthly steps (${start} -> ${doc.meta.date})`);

// ------------------------------------------------------------- colours -------
function countryColorRaw(tag: string): RGB {
  if (tag === 'REB') return REBEL;
  const country = countries.get(tag);
  const colors = country ? countryGroup(country, 'colors') : undefined;
  const raw = colors?.['map_color'] ?? colors?.['country_color'] ?? colors?.['color'];
  if (raw) {
    const n = raw.trim().split(/\s+/).map(Number);
    if (n.length >= 3 && n.slice(0, 3).every(Number.isFinite)) {
      return [n[0] as number, n[1] as number, n[2] as number];
    }
  }
  return hashColor(tag);
}

const tagList: string[] = [];
const tagIndex = new Map<string, number>();
function tagId(tag: string): number {
  let id = tagIndex.get(tag);
  if (id === undefined) {
    id = tagList.length;
    tagList.push(tag);
    tagIndex.set(tag, id);
  }
  return id;
}
const tagColors: number[] = [];
function tagColorOf(tag: string): number {
  const id = tagId(tag);
  tagColors[id] ??= packRgb(...countryColorRaw(tag));
  return tagColors[id] as number;
}

function buildDict(values: readonly string[]): { dict: string[]; index: Map<string, number> } {
  const dict = [...values];
  return { dict, index: new Map(dict.map((v, i) => [v, i])) };
}

const provinceDicts = new Map<string, { dict: string[]; index: Map<string, number> }>();
for (const field of PROVINCE_FIELDS) {
  const raw = new Set<string>();
  for (const history of timeline.provinces.values()) {
    for (const change of history.initial) if (change.field === field) raw.add(change.value);
    for (const event of history.events) {
      for (const change of event.changes) if (change.field === field) raw.add(change.value);
    }
  }
  if (field === 'religion') {
    // The religion dictionary must be **shared** between provinces and
    // countries: the viewer compares the province's religion index against the
    // owner's state religion index, so both have to come from one table. Two
    // separate dictionaries silently produced stripes almost everywhere.
    for (const country of countries.values()) {
      const own = countryScalar(country, 'religion');
      if (own) raw.add(own);
    }
    for (const history of countryTimeline.countries.values()) {
      for (const change of history.initial) if (change.field === 'religion') raw.add(change.value);
      for (const event of history.events) {
        for (const change of event.changes) if (change.field === 'religion') raw.add(change.value);
      }
    }
  }
  provinceDicts.set(field, buildDict([...raw].sort()));
}

const countryDicts = new Map<string, { dict: string[]; index: Map<string, number> }>();
for (const field of COUNTRY_FIELDS) {
  // Religion shares the province dictionary so indices are directly comparable.
  const shared = provinceDicts.get(field);
  if (shared) {
    countryDicts.set(field, shared);
    continue;
  }
  // `dynasty` only exists on countries, and comes out of the monarch blocks.
  const raw = new Set<string>();
  for (const history of countryTimeline.countries.values()) {
    for (const event of history.events) {
      for (const change of event.changes) {
        if (change.field === 'monarch' && change.detail?.['dynasty']) {
          raw.add(change.detail['dynasty']);
        }
      }
    }
  }
  countryDicts.set(field, buildDict([...raw].sort()));
}

// ------------------------------------------------------------ event packing ---
const provinceFieldIdx = new Map(PROVINCE_FIELDS.map((f, i) => [f, i]));

/**
 * Encode one province change as `[provinceId, fieldIdx, valueIdx]`.
 *
 * `owner`/`controller` hold a **tag index** (so the viewer can index the colour
 * table and follow tag aliases directly), while the remaining fields hold an
 * index into that field's value dictionary.
 *
 * Rebel control is deliberately encoded as "no controller": EU4 leaves
 * `controller=REB` in a province's log long after the revolt, so in this save 84
 * provinces had been "rebel-occupied" for over a century, which showed up as
 * permanent red hatching. Rebels are not a country, so they are not drawn.
 */
function encodeChange(id: number, field: string, value: string): number[] | undefined {
  const fi = provinceFieldIdx.get(field as (typeof PROVINCE_FIELDS)[number]);
  if (fi === undefined) return undefined;
  if (field === 'owner') {
    return [id, fi, value === '---' || value === 'REB' ? -1 : tagId(value)];
  }
  if (field === 'controller') {
    return [id, fi, value === '---' || value === 'REB' ? -1 : tagId(value)];
  }
  const vi = provinceDicts.get(field)?.index.get(value);
  return vi === undefined ? undefined : [id, fi, vi];
}

const initRows: number[][] = [];
for (const history of timeline.provinces.values()) {
  for (const change of history.initial) {
    const row = encodeChange(history.id, change.field, change.value);
    if (row) initRows.push(row);
  }
}

const eventRows: number[][] = [];
for (const event of timeline.events) {
  for (const change of event.changes) {
    const row = encodeChange(event.provinceId, change.field, change.value);
    if (row) eventRows.push([event.ordinal, ...row]);
  }
}

/**
 * Close occupations the game never closed.
 *
 * EU4 records when a province is occupied but frequently **not** when the
 * occupation ends, so the replayed controller drifts: in this save 503 provinces
 * disagree with the save's own `controller` field. The history is all we have for
 * the past, but for the present the save is authoritative, so a correction is
 * appended at the final date. Appending keeps `eventRows` sorted (the save date
 * is the largest ordinal), and later entries win for the same field.
 */
{
  const controllerField = provinceFieldIdx.get('controller') as number;
  const saveOrdinal = parseGameDate(doc.meta.date)!.ordinal;
  const replay = new TimelinePlayer(timeline, ['controller']);
  replay.advanceTo(saveOrdinal);
  let corrected = 0;
  let rebelCleared = 0;
  for (const province of provinces.values()) {
    const replayed = replay.valueOf('controller', province.id) ?? '';
    const current = province.controller ?? '';
    if (replayed === current) continue;
    if (replayed === 'REB') rebelCleared += 1;
    const value =
      current === '' || current === '---' || current === 'REB' ? -1 : tagId(current);
    eventRows.push([saveOrdinal, province.id, controllerField, value]);
    corrected += 1;
  }
  console.log(
    `controller corrections at ${doc.meta.date}: ${corrected} provinces ` +
      `(${rebelCleared} were stale rebel occupations)`,
  );
}

const countryFieldIdx = new Map(COUNTRY_FIELDS.map((f, i) => [f, i]));
const countryInitRows: number[][] = [];
const countryEventRows: number[][] = [];
{
  /**
   * Only the *surviving* tag of a rename carries the timeline: the game moves the
   * predecessor's whole history onto the successor (RUS holds Muscovy's entries
   * back to 1389). Processing both would have each write to the same viewer slot,
   * and the stale entry would win — Bavaria ends up Catholic because LBV->BAV
   * overwrote it.
   */
  const renamedFrom = new Set(aliases.map((a) => a.from));
  const campaignStartOrdinal = parseGameDate(
    timeline.campaignStart ?? doc.meta.date,
  )!.ordinal;
  const saveOrdinalForInitials = parseGameDate(doc.meta.date)!.ordinal;
  // A country's faith is only known once its own history begins. Countries
  // founded after the Reformation (colonial nations) must not be painted
  // Protestant in 1444, when they did not exist. A country with an entirely
  // empty dated history is only knowable at the present.
  const GRACE = 62; // ~2 months after the campaign start still counts as "at the start"

  for (const history of countryTimeline.countries.values()) {
    if (renamedFrom.has(history.tag)) continue;
    const latest = resolveTagLatest(aliases, history.tag);
    const firstOrdinal = history.events[0]?.ordinal;
    const initialFrom =
      firstOrdinal === undefined
        ? saveOrdinalForInitials
        : firstOrdinal <= campaignStartOrdinal + GRACE
          ? campaignStartOrdinal
          : firstOrdinal;

    for (const field of COUNTRY_FIELDS) {
      const fi = countryFieldIdx.get(field) as number;
      const dict = countryDicts.get(field);
      const initial = history.initial.find((c) => c.field === field);
      if (!initial) continue;
      const vi = dict?.index.get(initial.value);
      if (vi !== undefined) countryEventRows.push([initialFrom, tagId(latest), fi, vi]);
    }
    for (const event of history.events) {
      for (const change of event.changes) {
        const fi = countryFieldIdx.get(change.field as (typeof COUNTRY_FIELDS)[number]);
        if (fi === undefined) {
          // Monarch accessions carry the dynasty; there is no separate field.
          if (change.field === 'monarch' && change.detail?.['dynasty']) {
            const dynastyIdx = countryDicts.get('dynasty')?.index.get(change.detail['dynasty']);
            if (dynastyIdx !== undefined) {
              countryEventRows.push([
                event.ordinal,
                tagId(latest),
                countryFieldIdx.get('dynasty') as number,
                dynastyIdx,
              ]);
            }
          }
          continue;
        }
        const vi = countryDicts.get(change.field)?.index.get(change.value);
        if (vi === undefined) continue;
        countryEventRows.push([event.ordinal, tagId(latest), fi, vi]);
      }
    }
  }

  /**
   * Countries that converted have a dated event, but a country's faith *now* is
   * the save's own scalar. Appending it at the final date — instead of seeding it
   * as every country's initial value — is what keeps the map honest in both
   * directions: 87 countries have dated conversions (Sweden 1526.3.2, Prussia
   * 1517.8.28, …) while colonial nations founded after the Reformation simply
   * have no faith before they existed.
   */
  const saveOrdinal = parseGameDate(doc.meta.date)!.ordinal;
  let corrected = 0;
  for (const [tag, country] of countries) {
    if (renamedFrom.has(tag)) continue; // the successor carries the truth
    const latest = resolveTagLatest(aliases, tag);
    for (const field of COUNTRY_FIELDS) {
      const value = countryScalar(country, field);
      if (!value) continue;
      const fi = countryFieldIdx.get(field) as number;
      const vi = countryDicts.get(field)?.index.get(value);
      if (vi === undefined) continue;
      countryEventRows.push([saveOrdinal, tagId(latest), fi, vi]);
      corrected += 1;
    }
  }
  // Stable sort keeps the order above for equal dates: initial, then dated
  // events, then the save-date correction (which must win).
  countryEventRows.sort((a, b) => (a[0] as number) - (b[0] as number));
  console.log(`country faith corrections at ${doc.meta.date}: ${corrected}`);
}
console.log(
  `packed: ${initRows.length} province initial / ${eventRows.length} province events / ` +
    `${countryEventRows.length} country events / ${tagList.length} tags`,
);

// Tag changes, as [fromIdx, ordinal, toIdx] so the viewer can resolve aliases.
const tagAlias = aliases.map((a) => [tagId(a.from), a.ordinal, tagId(a.to)]);

// religions and cultures for the palettes.
// Religion colours come from the game's own table (`common/religions/*.txt`),
// with the generated palette only as a fallback for religions no file defines.
const officialReligions = (() => {
  const sources: Array<{ path: string; source: string }> = [
    { path: `${EU4}/common/religions/00_religion.txt`, source: 'base' },
  ];
  for (const dir of existsSync(WORKSHOP_ROOT) ? readdirSync(WORKSHOP_ROOT) : []) {
    const folder = `${WORKSHOP_ROOT}/${dir}/common/religions`;
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder)) {
      if (file.endsWith('.txt')) sources.push({ path: `${folder}/${file}`, source: `mod ${dir}` });
    }
  }
  return loadReligionTable(sources).colors;
})();
const religionDict = provinceDicts.get('religion')!.dict;
const cultureDict = provinceDicts.get('culture')!.dict;
const generatedReligions = buildPalette([...religionDict].sort());
const generatedCultures = buildPalette([...cultureDict].sort());
const religionColorOf = (name: string): RGB =>
  officialReligions.get(name) ?? generatedReligions.get(name) ?? UNOWNED;
const cultureColorOf = (name: string): RGB => generatedCultures.get(name) ?? UNOWNED;
console.log(
  `religion colours: ${officialReligions.size} official definitions, ` +
    `${religionDict.filter((r) => officialReligions.has(r)).length}/${religionDict.length} used religions resolved`,
);

// ------------------------------------------------------ most-occupied month ---
// Occupancy must be measured on month boundaries and with tag aliases applied:
// a province flips from "occupied by RUS" to "owned by RUS" the moment MOS is
// renamed, with no province event at all. Counting month by month keeps that
// honest; resolving each distinct tag once per month keeps it fast.
const ownerById: Array<string | undefined> = new Array(70_000);
const controllerById: Array<string | undefined> = new Array(70_000);
for (const history of timeline.provinces.values()) {
  for (const change of history.initial) {
    if (change.field === 'owner') ownerById[history.id] = change.value;
    else if (change.field === 'controller') controllerById[history.id] = change.value;
  }
}
let bestCount = -1;
let bestMonth = 0;
{
  let cursor = 0;
  const provinceIds = [...provinces.keys()];
  for (let i = 0; i < months.length; i += 1) {
    const month = months[i] as { ordinal: number; date: string };
    while (cursor < timeline.events.length) {
      const event = timeline.events[cursor] as (typeof timeline.events)[number];
      if (event.ordinal > month.ordinal) break;
      cursor += 1;
      for (const change of event.changes) {
        if (change.field === 'owner') ownerById[event.provinceId] = change.value;
        else if (change.field === 'controller') controllerById[event.provinceId] = change.value;
      }
    }
    const cache = new Map<string, string>();
    const resolved = (tag: string): string => {
      let value = cache.get(tag);
      if (value === undefined) {
        value = resolveTag(aliases, tag, month.ordinal);
        cache.set(tag, value);
      }
      return value;
    };
    let count = 0;
    for (const id of provinceIds) {
      const owner = ownerById[id];
      if (!owner || owner === '---' || owner === 'REB') continue;
      const controller = controllerById[id];
      // Rebels are not a country, so rebel control is not an occupation here
      // either — otherwise it would contradict what the map draws.
      if (!controller || controller === '---' || controller === 'REB') continue;
      if (resolved(controller) !== resolved(owner)) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      bestMonth = i;
    }
  }
}
console.log(`peak occupation: ${bestCount} provinces at ${months[bestMonth]?.date}`);

// ------------------------------------------------------------------- wars -----
const wars = extractWars(doc);
const wstats = warStats(wars);
console.log(`wars: ${wstats.total} (${wstats.ongoing} ongoing), ${wstats.battles.toLocaleString()} battles`);

// ------------------------------------------------------------- battle scores --
// The battle view is **cumulative**: a province darkens as it is fought over
// again and again, so it needs a running total rather than one month's snapshot.
// Each battle therefore contributes "one battle" plus a reduced share of its
// intensity — the user asked for battle count to dominate over bloodiness.
const BATTLE_COUNT_WEIGHT = 1;
const BATTLE_INTENSITY_WEIGHT = 0.3;
const battleRows: number[][] = [];
{
  const sumUnits = (units: Record<string, number>): number => {
    let total = 0;
    for (const value of Object.values(units)) total += value;
    return total;
  };
  let maxLosses = 1;
  for (const war of wars) {
    for (const battle of war.battles) {
      const losses = (battle.attacker.losses ?? 0) + (battle.defender.losses ?? 0);
      if (losses > maxLosses) maxLosses = losses;
    }
  }
  for (const war of wars) {
    for (const battle of war.battles) {
      if (battle.location === undefined) continue;
      const parts = battle.date.split('.').map(Number);
      const year = parts[0] ?? 0;
      const month = parts[1] ?? 1;
      const engaged = sumUnits(battle.attacker.units) + sumUnits(battle.defender.units);
      const losses = (battle.attacker.losses ?? 0) + (battle.defender.losses ?? 0);
      const lethality = engaged > 0 ? losses / engaged : 0;
      // Logarithmic in size: the worst battle is 40k+ casualties, so a linear
      // scale would make an ordinary 3-5k battle look identical to no battle.
      const size = Math.log(1 + losses) / Math.log(1 + maxLosses);
      const intensity = 0.7 * size + 0.3 * Math.min(1, lethality);
      const contribution =
        BATTLE_COUNT_WEIGHT + BATTLE_INTENSITY_WEIGHT * Math.min(1, intensity);
      battleRows.push([
        year * 12 + (month - 1),
        battle.location,
        Math.round(contribution * 100), // x100 keeps it an integer
        battle.attacker.country ? tagId(battle.attacker.country) : -1,
        battle.defender.country ? tagId(battle.defender.country) : -1,
        losses,
        // 1 for a sea battle, 0 for a land battle: the viewer colours the two
        // with different ramps (white->red vs blue->red).
        battle.naval ? 1 : 0,
      ]);
    }
  }
  console.log(
    `battle scores: ${battleRows.length} located battles, worst single battle ${maxLosses.toLocaleString()} casualties`,
  );
}

/** Highest cumulative battle score any province reaches, for normalisation. */
function maxCumulativeBattleScore(naval: boolean): number {
  const totals = new Map<number, number>();
  let best = 1;
  for (const row of battleRows) {
    if ((row[6] as number) === 1 !== naval) continue;
    const total = (totals.get(row[1] as number) ?? 0) + (row[2] as number);
    totals.set(row[1] as number, total);
    if (total > best) best = total;
  }
  return best;
}
const maxBattleScore = maxCumulativeBattleScore(false);
const maxNavalScore = maxCumulativeBattleScore(true);

// --------------------------------------------------------------- tech levels --
// There is no usable dated tech log (in this save every country history holds
// only ~11 tech events), so technology is a single snapshot at the save date,
// scored **relatively**: the weakest country is the reddest, the strongest the
// greenest, and if everyone is equal the map goes green.
const tagTech: number[] = [];
let techMin = Number.POSITIVE_INFINITY;
let techMax = 0;
{
  for (const [tag, country] of countries) {
    const tech = countryGroup(country, 'technology') ?? {};
    const level =
      (Number(tech['adm_tech']) || 0) +
      (Number(tech['dip_tech']) || 0) +
      (Number(tech['mil_tech']) || 0);
    tagTech[tagId(tag)] = level;
    if (level > 0) {
      if (level < techMin) techMin = level;
      if (level > techMax) techMax = level;
    }
  }
  if (!Number.isFinite(techMin)) techMin = 0;
  console.log(`tech snapshot: ${techMax > 0 ? `${techMin}..${techMax}` : 'none'}`);
}

// -------------------------------------------------------------- institutions --
// Like technology, institution embracement is a snapshot (province history
// carries no institution events), scored relatively. A province is greener the
// more advanced the institution it holds, and hatched while one is in progress.
const provinceInstitutions: number[][] = [];
let instMin = Number.POSITIVE_INFINITY;
let instMax = 0;
{
  for (const province of provinces.values()) {
    const progress = readInstitutionProgress(province.institutions);
    provinceInstitutions.push([province.id, progress.embraced, progress.embracing]);
    if (progress.embraced < instMin) instMin = progress.embraced;
    if (progress.embraced > instMax) instMax = progress.embraced;
  }
  if (!Number.isFinite(instMin)) instMin = 0;
  console.log(`institution snapshot: embraced range ${instMin}..${instMax}`);
}

// ---------------------------------------------------------- detail tables -----
/**
 * The three static tables the game-file conversation publishes under
 * `apps/site/public/assets/ui/`. They are read as **text** and handed to the shared
 * assembler, exactly like the browser's `fetch` path, so both planes normalise them
 * through one piece of code. A missing file is not an error: that category simply
 * stays empty and the panel falls back to the raw game key.
 */
const detailTableText = (name: string): string | undefined => {
  const path = `apps/site/public/assets/ui/${name}`;
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};
const detailTables = buildDetailTables({
  doc,
  provinces,
  tagId,
  saveDate: doc.meta.date,
  startDate: start,
  wars,
  // The monarch board's 在位发展度 replays province ownership month by month; the one
  // shared implementation lives in `details.ts`, so both planes hand in the timeline
  // they already built (第四对话任务书 §3.5).
  timeline,
  tables: {
    uiNames: detailTableText('uiNames.json'),
    provinceTerrain: detailTableText('provinceTerrain.json'),
    area: detailTableText('area.json'),
    advisorIds: detailTableText('advisorIds.json'),
    ledgerSlots: detailTableText('ledgerSlots.json'),
    manaSlots: detailTableText('manaSlots.json'),
  },
});
/**
 * S2's name table, baked (省份国家界面阶段任务书 §6.8.3).
 *
 * The panels read names out of the data plane and never fetch a file at run time — the
 * offline self-contained page has no server to fetch from. `uiNames` keeps the family
 * shape of the file; `cultureNames` / `personalityNames` are the shapes the panel code
 * indexes directly (a culture's dictionary slot, and the personality keys a ruler
 * carries).
 */
const uiNames = detailTables.uiNames;
const cultureNames = cultureDict.map((key) => uiNames['cultures']?.[key] ?? '');
const personalityNames = uiNames['personalities'] ?? {};
const nameCoverage = Object.entries(uiNames)
  .map(([family, entries]) => `${family}=${Object.keys(entries).length}`)
  .join(' ');
console.log(`detail tables: ${Object.keys(detailTables.countryDetail).length} countries, ` +
  `${detailTables.provinceBuildings.rows.length} provinces with buildings ` +
  `(${detailTables.provinceBuildings.dict.length} keys), ` +
  `${detailTables.provinceClaims.rows.length} with claims, ` +
  `${detailTables.provinceGreatProjects.rows.length} with great projects, ` +
  `${detailTables.provinceTerrain.byId.filter((index) => index >= 0).length} with terrain, ` +
  `${Object.keys(detailTables.areaDetail).length} areas`);
console.log(`uiNames: ${nameCoverage} (cultureNames ${cultureNames.filter((n) => n).length}/${cultureNames.length})`);

// Every tag seen anywhere now has an index, so materialise colours for all of
// them; the browser indexes these arrays directly.
for (const tag of tagList) tagColorOf(tag);

// ------------------------------------------------------------- dynasties ------
/**
 * The game ships **no** dynasty colour table (`common/dynasties/` does not even
 * exist; the save's `dynasty` section is a random-name pool grouped by culture).
 * So every dynasty gets a deterministic generated colour, spread by the golden
 * angle in alphabetical order so that dynasties appearing together on the map
 * stay visually distinct.
 */
const dynastyDict = countryDicts.get('dynasty')!.dict;
const dynastyColors = dynastyDict.map((name, index) => {
  const hue = (index * 137.508) % 360;
  const saturation = 0.42 + ((index * 5) % 3) * 0.13;
  const lightness = 0.36 + ((index * 7) % 4) * 0.075;
  return packRgb(...hslToRgb(hue, saturation, lightness));
});

// ------------------------------------------------------------------- HRE ------
const hreInfo = (() => {
  const empire = doc.readSectionView('empire');
  const emperorTag = empire?.string('emperor');
  const electorTags = empire?.stringList('electors') ?? [];
  const saveOrdinal = parseGameDate(doc.meta.date)!.ordinal;

  // `old_emperor` repeats, each with the date the previous emperor died.
  const emperorEvents: number[][] = [];
  const seen = new Set<string>();
  for (const node of empire?.all('old_emperor') ?? []) {
    const view = BlockView.from(node);
    const tag = view?.string('country');
    const date = view?.scalar('date');
    if (!tag || !date) continue;
    const ordinal = parseGameDate(date)?.ordinal;
    if (ordinal === undefined) continue;
    emperorEvents.push([ordinal, tagId(tag)]);
    seen.add(tag);
  }
  emperorEvents.sort((a, b) => (a[0] as number) - (b[0] as number));
  if (emperorTag) emperorEvents.push([saveOrdinal, tagId(emperorTag)]);

  const freeCities = [...countries.entries()]
    .filter(([, country]) => /free_city/i.test(countryScalar(country, 'government_name') ?? ''))
    .map(([tag]) => tagId(tag));

  // A country belongs to the empire when its capital province is HRE land.
  const capitals: number[][] = [];
  for (const [tag, country] of countries) {
    const capital = Number(countryScalar(country, 'capital') ?? '0');
    if (capital > 0) capitals.push([tagId(tag), capital]);
  }

  console.log(
    `HRE: emperor ${emperorTag ?? '?'} (${emperorEvents.length} dated changes), ` +
      `${electorTags.length} electors, ${freeCities.length} free cities, ${capitals.length} capitals`,
  );
  return {
    emperor: emperorTag ? tagId(emperorTag) : -1,
    emperorEvents,
    electors: electorTags.map((t) => tagId(t)),
    freeCities,
    capitals,
  };
})();

// ------------------------------------------------------------- power curves ---
/**
 * Per-month development and province count for the strongest countries, derived
 * from the province timeline. This is the one long-run "how is my empire doing"
 * series the save genuinely supports: income and army exist only as snapshots
 * (and the ledger keeps ~45 years), but ownership and development are dated.
 */
const curves = (() => {
  const TOP_N = 12;
  const MAX_ID = 70_000;
  const taxById = new Float64Array(MAX_ID);
  const prodById = new Float64Array(MAX_ID);
  const mpById = new Float64Array(MAX_ID);
  const ownerById = new Array<string | undefined>(MAX_ID);
  const provinceIds = [...provinces.keys()];
  for (const province of provinces.values()) {
    taxById[province.id] = province.baseTax ?? 0;
    prodById[province.id] = province.baseProduction ?? 0;
    mpById[province.id] = province.baseManpower ?? 0;
    if (province.owner && province.owner !== '---' && province.owner !== 'REB') {
      ownerById[province.id] = province.owner;
    }
  }

  /**
   * Apply one change to the running state; returns true when it moved the owner.
   * Shared by the undated initial overlay and the dated sweep so both agree.
   */
  const applyChange = (provinceId: number, field: string, value: string): boolean => {
    if (field === 'owner') {
      ownerById[provinceId] = value === '---' || value === 'REB' ? undefined : value;
      return true;
    }
    if (field === 'base_tax') {
      taxById[provinceId] = Number(value) || 0;
    } else if (field === 'base_production') {
      prodById[provinceId] = Number(value) || 0;
    } else if (field === 'base_manpower') {
      mpById[provinceId] = Number(value) || 0;
    }
    return false;
  };

  /**
   * The province blocks hold the campaign's *final* values, so the loop below
   * starts from the save date and rewinds. That works only because every dated
   * change is replayed on top — but 2,450 provinces keep their starting owner in
   * the *undated* initial state instead, so without this overlay they would sit
   * at their 1574 owner for all 1,562 months and the chart would be flat.
   */
  const applyInitialState = (): void => {
    for (const history of timeline.provinces.values()) {
      for (const change of history.initial) {
        applyChange(history.id, change.field, change.value);
      }
    }
  };

  // Rank by the final state, so the chart shows the countries that mattered.
  const finalDev = new Map<string, number>();
  for (const id of provinceIds) {
    const owner = ownerById[id];
    if (!owner) continue;
    finalDev.set(owner, (finalDev.get(owner) ?? 0) + taxById[id]! + prodById[id]! + mpById[id]!);
  }
  const names = [...finalDev.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([t]) => t);
  const slotOf = new Map<string, number>();
  names.forEach((tag, slot) => slotOf.set(tag, slot));
  const tagIdx = names.map((tag) => tagId(resolveTag(aliases, tag, parseGameDate(doc.meta.date)!.ordinal)));

  // Only now rewind to 1444: the ranking above must see the save-date state.
  applyInitialState();

  /**
   * province id -> chart slot (or -1).
   *
   * Slots are keyed by **identity**, not by the tag of the day: a country that
   * changes tag keeps one continuous curve. Venice becoming Sardinia-Piedmont
   * (VEN -> SPI) must not restart at zero on the day of the change, which is
   * exactly what the date-aware resolution used to do — the provinces were
   * labelled VEN before the rename but only SPI existed as a slot, so the whole
   * series appeared out of nowhere. Identity is also time-invariant, so the slot
   * table only has to be rebuilt when a province changes hands, not on rename
   * dates.
   */
  const slotById = new Int8Array(MAX_ID).fill(-1);
  const slotForOwner = (owner: string | undefined): number =>
    owner === undefined ? -1 : (slotOf.get(resolveTagLatest(aliases, owner)) ?? -1);
  const rebuildSlots = (): void => {
    for (const id of provinceIds) slotById[id] = slotForOwner(ownerById[id]);
  };
  rebuildSlots();

  const devSeries = names.map(() => [] as number[]);
  const provinceSeries = names.map(() => [] as number[]);
  let cursor = 0;

  for (const month of months) {
    while (cursor < timeline.events.length) {
      const event = timeline.events[cursor] as (typeof timeline.events)[number];
      if (event.ordinal > month.ordinal) break;
      cursor += 1;
      let ownerChanged = false;
      for (const change of event.changes) {
        if (applyChange(event.provinceId, change.field, change.value)) ownerChanged = true;
      }
      if (ownerChanged) slotById[event.provinceId] = slotForOwner(ownerById[event.provinceId]);
    }

    const devTotals = new Float64Array(names.length);
    const countTotals = new Int32Array(names.length);
    for (const id of provinceIds) {
      const slot = slotById[id] as number;
      if (slot < 0) continue;
      devTotals[slot] += taxById[id]! + prodById[id]! + mpById[id]!;
      countTotals[slot] += 1;
    }
    for (let slot = 0; slot < names.length; slot += 1) {
      (devSeries[slot] as number[]).push(Math.round(devTotals[slot] as number));
      (provinceSeries[slot] as number[]).push(countTotals[slot] as number);
    }
  }
  console.log(
    `power curves: ${names.length} countries x ${months.length} months (top: ${names.slice(0, 5).join(', ')})`,
  );
  // A top-12 country that starts at zero development is the signature of a
  // rename that broke its curve in two (Venice -> Sardinia-Piedmont did).
  const zeroStarts = names.filter((_, slot) => (devSeries[slot]?.[0] ?? 0) === 0);
  console.log(
    `  starts: ${names.map((n, slot) => `${n}=${devSeries[slot]?.[0] ?? 0}`).join(' ')}`,
  );
  if (zeroStarts.length) {
    console.log(`  !! curves starting at zero (check tag renames): ${zeroStarts.join(', ')}`);
  }
  return { tags: tagIdx, names, dev: devSeries, provinces: provinceSeries };
})();

// ----------------------------------------------------------------- raster -----
// Province id split over two channels so the browser can recover it exactly.
const rasterRgb = new Uint8Array(width * height * 3);
for (let i = 0; i < pixels.length; i += 1) {
  const id = pixels[i] as number;
  rasterRgb[i * 3] = (id >> 8) & 0xff;
  rasterRgb[i * 3 + 1] = id & 0xff;
  rasterRgb[i * 3 + 2] = 0;
}
const rasterPng = encodePng(width, height, rasterRgb, 3);
writeFileSync(`${OUT}/raster.png`, rasterPng);
const rasterUri = `data:image/png;base64,${rasterPng.toString('base64')}`;

/**
 * Wallpapers from the project's 背景图 folder, referenced by relative path (they
 * are megabytes each, so embedding them would dwarf the map). The page crops
 * them with background-size:cover, which is what makes every image share the
 * page's aspect ratio without re-encoding anything.
 */
const bgFiles = (() => {
  // The folder lives inside the site folder (that folder is the deploy output).
  // URLs are absolute from the site root: the generated page is served from
  // /saves/<id>/viewer/, three levels deep, and a relative `../../背景图/` landed on
  // /saves/背景图/ — every wallpaper 404'd. Absolute cannot be off by a level.
  const dir = 'apps/site/public/背景图';
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp|avif)$/i.test(f))
      .sort()
      .map((f) => `/背景图/${f}`);
  } catch {
    return [];
  }
})();
console.log(`raster.png ${(rasterPng.length / 1024 / 1024).toFixed(2)} MB -> base64 ${(rasterUri.length / 1024 / 1024).toFixed(2)} MB`);

// ------------------------------------------------ server-side frame render ----
// Same painter, same palettes as the browser: this is how the hatching is
// inspected (and it doubles as a regression check on the whole pipeline).
const frameRgba = new Uint8ClampedArray(width * height * 4);
const frameBase = new Uint32Array(65_536);
const frameHatch = new Uint32Array(65_536);
const religionByIndex = religionDict.map((r) => packRgb(...religionColorOf(r)));
const cultureByIndex = cultureDict.map((c) => packRgb(...cultureColorOf(c)));

function paintAt(
  ordinal: number,
  view: 'political' | 'religion' | 'culture' | 'tech' | 'institution' | 'battle',
) {
  const player = new TimelinePlayer(timeline, ['owner', 'controller', 'religion', 'culture']);
  player.advanceTo(ordinal);
  const countryPlayer = new CountryTimelinePlayer(countryTimeline, ['religion']);
  countryPlayer.advanceTo(ordinal);

  frameBase.fill(packRgb(...UNOWNED));
  frameHatch.fill(0);
  frameBase[0] = packRgb(...NO_PROVINCE);
  for (const id of water.all) frameBase[id] = water.sea.has(id) ? packRgb(...SEA) : packRgb(...LAKE);

  const occupiedNow: number[] = [];
  const monthKey = (() => {
    const year = Math.floor(ordinal / 372);
    const month = Math.floor((ordinal - year * 372) / 31);
    return year * 12 + (month - 1);
  })();
  // Cumulative, exactly like the viewer: every battle up to this month counts.
  const cumulativeBattles = new Map<number, number>();
  if (view === 'battle') {
    for (const row of battleRows) {
      if ((row[0] as number) > monthKey) continue;
      cumulativeBattles.set(
        row[1] as number,
        (cumulativeBattles.get(row[1] as number) ?? 0) + (row[2] as number),
      );
    }
  }

  for (const province of provinces.values()) {
    const id = province.id;
    if (water.all.has(id)) continue;
    const rawOwner = player.valueOf('owner', id);
    const rawController = player.valueOf('controller', id);
    const ownerTag =
      rawOwner && rawOwner !== '---' && rawOwner !== 'REB'
        ? resolveTag(aliases, rawOwner, ordinal)
        : undefined;
    const controllerTag =
      rawController && rawController !== '---' && rawController !== 'REB'
        ? resolveTag(aliases, rawController, ordinal)
        : undefined;
    // Identity (for "is this an occupation") ignores *when* a rename happened.
    const sameCountry =
      ownerTag !== undefined &&
      rawController !== undefined &&
      resolveTagLatest(aliases, rawOwner as string) === resolveTagLatest(aliases, rawController);

    if (view === 'battle') {
      frameBase[id] = packRgb(246, 246, 246);
      continue;
    }
    if (view === 'tech') {
      const level = ownerTag ? (tagTech[tagId(ownerTag)] ?? 0) : 0;
      const span = techMax - techMin;
      frameBase[id] =
        level > 0 ? techRamp(span > 0 ? (level - techMin) / span : 1) : packRgb(...UNOWNED);
      continue;
    }
    if (view === 'institution') {
      const progress = readInstitutionProgress(province.institutions);
      const span = instMax - instMin;
      const norm = (v: number): number => (span > 0 ? (v - instMin) / span : 1);
      frameBase[id] = institutionRamp(norm(progress.embraced));
      if (progress.embracing >= 0) frameHatch[id] = institutionRamp(norm(progress.embracing + 1));
      continue;
    }
    if (view === 'political') {
      frameBase[id] = ownerTag ? tagColorOf(ownerTag) : packRgb(...UNOWNED);
      if (ownerTag && controllerTag && !sameCountry) {
        frameHatch[id] = tagColorOf(controllerTag);
        occupiedNow.push(id);
      }
      continue;
    }
    const field = view === 'religion' ? 'religion' : 'culture';
    const dict = view === 'religion' ? religionDict : cultureDict;
    const palette = view === 'religion' ? religionByIndex : cultureByIndex;
    const value = player.valueOf(field, id) ?? (province as unknown as Record<string, string>)[field];
    const valueIdx = value ? dict.indexOf(value) : -1;
    frameBase[id] = valueIdx >= 0 ? (palette[valueIdx] as number) : packRgb(...UNOWNED);
    if (view === 'culture') continue; // no hatching in the culture view
    if (!ownerTag) continue;
    // Faith physically present: the occupier's if occupied, otherwise the owner's.
    const presenceTag = sameCountry ? ownerTag : (controllerTag ?? ownerTag);
    const latest = resolveTagLatest(aliases, presenceTag);
    const want =
      countryPlayer.valueOf('religion', latest) ??
      countryScalar(countries.get(presenceTag) ?? countries.get(latest)!, 'religion');
    if (want && want !== value) {
      const wantIdx = dict.indexOf(want);
      if (wantIdx >= 0) frameHatch[id] = palette[wantIdx] as number;
      occupiedNow.push(id);
    }
  }

  if (view === 'battle') {
    for (const [id, score] of cumulativeBattles) {
      frameBase[id] = battleRamp(score / maxBattleScore);
    }
  }
  return occupiedNow;
}

function writeFrame(file: string, label: string): void {
  paintMap(
    pixels,
    frameRgba,
    width,
    height,
    frameBase,
    frameHatch,
    borderMask,
    STRIPE_PERIOD,
    STRIPE_WIDTH,
    true,
  );
  const png = encodePng(width, height, new Uint8Array(frameRgba.buffer), 4);
  writeFileSync(file, png);
  console.log(`  ${label.padEnd(34)} ${(png.length / 1024).toFixed(0)} KB`);
}

function writeCrop(file: string, label: string, cx: number, cy: number, w: number, h: number): void {
  const x0 = Math.max(0, Math.min(width - w, cx - (w >> 1)));
  const y0 = Math.max(0, Math.min(height - h, cy - (h >> 1)));
  const sub = new Uint16Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const src = (y0 + y) * width + x0;
    sub.set(pixels.subarray(src, src + w), y * w);
  }
  const subMask = buildBorderMask(sub, w, h, water.all);
  const subRgba = new Uint8ClampedArray(w * h * 4);
  paintMap(sub, subRgba, w, h, frameBase, frameHatch, subMask, STRIPE_PERIOD, STRIPE_WIDTH, true);
  const png = encodePng(w, h, new Uint8Array(subRgba.buffer), 4);
  writeFileSync(file, png);
  console.log(`  ${label.padEnd(34)} ${(png.length / 1024).toFixed(0)} KB  @${x0},${y0}`);
}

console.log('\npeak-month frames:');
const peakOrdinal = (months[bestMonth] as { ordinal: number }).ordinal;
const peakOccupied = paintAt(peakOrdinal, 'political');
writeFrame(`${OUT}/peak-political.png`, `political @${months[bestMonth]?.date}`);
if (peakOccupied.length > 0) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const set = new Set(peakOccupied);
  for (let i = 0; i < pixels.length; i += 5) {
    if (!set.has(pixels[i] as number)) continue;
    sx += i % width;
    sy += Math.floor(i / width);
    n += 1;
  }
  if (n > 0) {
    writeCrop(
      `${OUT}/peak-political-zoom.png`,
      `political zoom @${months[bestMonth]?.date}`,
      Math.round(sx / n),
      Math.round(sy / n),
      1500,
      900,
    );
  }
}
paintAt(peakOrdinal, 'religion');
writeFrame(`${OUT}/peak-religion.png`, `religion @${months[bestMonth]?.date}`);
paintAt(peakOrdinal, 'culture');
writeFrame(`${OUT}/peak-culture.png`, `culture @${months[bestMonth]?.date}`);
paintAt(peakOrdinal, 'political');
writeFrame(`${OUT}/peak-tech.png`, `tech snapshot @${months[bestMonth]?.date}`);
paintAt(peakOrdinal, 'institution');
writeFrame(`${OUT}/peak-institution.png`, `institutions @${months[bestMonth]?.date}`);

// The bloodiest month is the most informative frame for the battle view.
{
  const byMonth = new Map<number, number>();
  for (const row of battleRows) {
    byMonth.set(row[0] as number, (byMonth.get(row[0] as number) ?? 0) + (row[5] as number));
  }
  let worstKey = 0;
  let worstLosses = -1;
  for (const [key, losses] of byMonth) {
    if (losses > worstLosses) {
      worstLosses = losses;
      worstKey = key;
    }
  }
  let targetMonth = months[0]!;
  for (const month of months) {
    const year = Math.floor(month.ordinal / 372);
    const m = Math.floor((month.ordinal - year * 372) / 31);
    if (year * 12 + (m - 1) <= worstKey) targetMonth = month;
  }
  paintAt(targetMonth.ordinal, 'battle');
  writeFrame(`${OUT}/battle-worst.png`, `battle @${targetMonth.date}`);
  console.log(
    `  bloodiest month: ${Math.floor(worstKey / 12)}.${(worstKey % 12) + 1} ` +
      `with ${worstLosses.toLocaleString()} casualties`,
  );
}

console.log('\npeak-month frames done');

// --------------------------------------------------------------- thumbnail ----
/**
 * The catalogue card's image: the political map on the campaign's last day.
 *
 * `raster.png` is province *ids* rather than a picture, and the `peak-*` frames show the
 * month with the most occupations instead of the end, so the card needs a frame of its
 * own.
 *
 * It replays `initRows`/`eventRows` — the corrected plane, which is exactly what the
 * viewer replays — rather than the raw timeline: `paintAt()` walks the raw timeline and
 * would therefore draw the 503 stale occupations the corrections exist to remove.
 * `apps/site/public/viewer-build.js` builds the same frame in the browser and repeats
 * this replay on purpose, the same way the two data planes each keep their own copy of
 * the colour rules. The downscale is repeated there too, and is hand-written rather
 * than `drawImage` so that both sides average identical source rectangles.
 */
const THUMB_WIDTH = 704;

function downscaleRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Uint8ClampedArray {
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
          r += rgba[i] as number;
          g += rgba[i + 1] as number;
          b += rgba[i + 2] as number;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const o = (y * outWidth + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = 255;
    }
  }
  return out;
}

{
  const ownerIndex = new Int16Array(65_536).fill(-1);
  const controllerIndex = new Int16Array(65_536).fill(-1);
  const ownerField = provinceFieldIdx.get('owner') as number;
  const controllerField = provinceFieldIdx.get('controller') as number;
  const apply = (id: number, field: number, value: number): void => {
    if (field === ownerField) ownerIndex[id] = value;
    else if (field === controllerField) controllerIndex[id] = value;
  };
  for (const row of initRows) apply(row[0] as number, row[1] as number, row[2] as number);
  const thumbOrdinal = parseGameDate(doc.meta.date)!.ordinal;
  for (const row of eventRows) {
    // The log is sorted and the corrections sit at the save date, so the first row past
    // it ends the replay.
    if ((row[0] as number) > thumbOrdinal) break;
    apply(row[1] as number, row[2] as number, row[3] as number);
  }

  frameBase.fill(packRgb(...UNOWNED));
  frameHatch.fill(0);
  frameBase[0] = packRgb(...NO_PROVINCE);
  for (const id of water.all) frameBase[id] = water.sea.has(id) ? packRgb(...SEA) : packRgb(...LAKE);
  for (const province of provinces.values()) {
    const id = province.id;
    if (water.all.has(id)) continue;
    const ownerIdx = ownerIndex[id] as number;
    const controllerIdx = controllerIndex[id] as number;
    const rawOwner = ownerIdx >= 0 ? (tagList[ownerIdx] as string) : undefined;
    const rawController = controllerIdx >= 0 ? (tagList[controllerIdx] as string) : undefined;
    // Which COLOUR is date-aware (Muscovy is Muscovy until it renames itself) ...
    const ownerTag = rawOwner ? resolveTag(aliases, rawOwner, thumbOrdinal) : undefined;
    const controllerTag = rawController ? resolveTag(aliases, rawController, thumbOrdinal) : undefined;
    frameBase[id] = ownerTag ? tagColorOf(ownerTag) : packRgb(...UNOWNED);
    // ... while "is this an occupation" is identity-based, so a renamed country never
    // occupies itself. Same two resolutions as the viewer's political view.
    if (
      rawOwner &&
      rawController &&
      resolveTagLatest(aliases, rawOwner) !== resolveTagLatest(aliases, rawController)
    ) {
      frameHatch[id] = tagColorOf(controllerTag as string);
    }
  }

  paintMap(pixels, frameRgba, width, height, frameBase, frameHatch, borderMask, STRIPE_PERIOD, STRIPE_WIDTH, true);
  const thumbHeight = Math.max(1, Math.round((THUMB_WIDTH * height) / width));
  const thumbRgba = downscaleRgba(frameRgba, width, height, THUMB_WIDTH, thumbHeight);
  const thumbPng = encodePng(THUMB_WIDTH, thumbHeight, new Uint8Array(thumbRgba.buffer), 4);
  writeFileSync(`${OUT}/thumb.png`, thumbPng);
  console.log(`\ncard thumbnail:`);
  console.log(
    `  ${'thumb.png'.padEnd(34)} ${(thumbPng.length / 1024).toFixed(0)} KB  ` +
      `${THUMB_WIDTH}x${thumbHeight} (political) @${doc.meta.date}`,
  );
}

// ------------------------------------------------------------------- html -----
/**
 * The three colour modes, mirroring `apps/site/public/viewer-build.js`.
 *
 * The helpers are duplicated on purpose: the two hosts are independent implementations
 * of the same data plane and `test/viewer-build.test.ts` compares the whole `colours`
 * object against `tmp/timeline/data.json`, so a drift here fails loudly. Only the ΔE
 * maths is shared (`packages/eu4-parser/src/colours.ts`), because the two hosts must
 * agree on it to the byte.
 */
function unpackRgb(packed: number): RGB {
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}
/** The country's own `color`, or `undefined` when it has none (see `isPlaceholderColour`). */
function recordedColourOf(country: CountryRecord | undefined): RGB | undefined {
  const colors = country ? countryGroup(country, 'colors') : undefined;
  const raw = colors?.['color'];
  const parts = raw ? raw.trim().split(/\s+/).map(Number) : undefined;
  if (!parts || parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return undefined;
  const rgb: RGB = [parts[0] as number, parts[1] as number, parts[2] as number];
  return isPlaceholderColour(rgb) ? undefined : rgb;
}

const colourModes = (() => {
  const count = tagList.length;
  const original: number[] = [];
  const mod: number[] = [];
  const subject: number[] = [];
  /** The colour the save records for the tag, packed; `undefined` when it has none. */
  const ownColours: Array<number | undefined> = [];
  const from: number[] = new Array(count).fill(-1) as number[];
  const ledger = readSubjectLedger(doc);
  const campaignStart = parseGameDate(timeline.campaignStart ?? doc.meta.date)!.ordinal;

  // Who takes whose colour: the dependency ledger is the authority, so a country that
  // has become independent is absent and keeps its own colour. `colonial_parent` only
  // fills one gap — a colony the save lists no dependency for — and only when both
  // ends own land, so a dormant colonial record is left alone.
  const landed = new Set<string>();
  for (const province of provinces.values()) if (province.owner) landed.add(province.owner);
  const overlordOf = new Map<string, string>();
  for (const [tag, relation] of ledger.relations) overlordOf.set(tag, relation.overlord);
  const excluded = new Set(ledger.excluded.map((relation) => relation.subject));
  for (const [tag, country] of countries) {
    if (overlordOf.has(tag) || excluded.has(tag) || !landed.has(tag)) continue;
    const parent = countryScalar(country, 'colonial_parent');
    if (parent && landed.has(parent)) overlordOf.set(tag, parent);
  }

  // The ΔE target of every subject, spread within its family in tag order.
  const targets = new Map<string, number>();
  const families = new Map<string, string[]>();
  for (const [tag, overlord] of overlordOf) {
    const members = families.get(overlord) ?? [];
    members.push(tag);
    families.set(overlord, members);
  }
  for (const members of families.values()) for (const [member, target] of familyTargets(members)) targets.set(member, target);
  const midBand = (SUBJECT_SHADE.low + SUBJECT_SHADE.high) / 2;

  for (let i = 0; i < count; i += 1) {
    const tag = tagList[i] as string;
    const country = countries.get(tag);
    const recorded = recordedColourOf(country);
    let own = recorded;
    if (!own) {
      // No colour, or only the engine's `255 255 255` placeholder: a colonial nation is
      // then a shade of its mother country's own colour. `map_color` would drag the
      // recolouring mod's result into 原始色.
      const parent = country ? countryScalar(country, 'colonial_parent') : undefined;
      const parentCountry = parent ? countries.get(parent) : undefined;
      own = parentCountry
        ? shadeRgb(recordedColourOf(parentCountry) ?? countryColorRaw(parent), targets.get(tag) ?? midBand)
        : countryColorRaw(tag);
    }
    original[i] = packRgb(...own);
    // `recorded` stays undefined for a placeholder, which is what the leftover-tint test
    // needs: a country with no colour of its own cannot be showing one.
    ownColours[i] = recorded ? packRgb(...recorded) : undefined;
    mod[i] = tagColors[i] ?? packRgb(...countryColorRaw(tag));
    subject[i] = mod[i] as number;
  }

  for (const [tag, overlord] of overlordOf) {
    const subjectIndex = tagIndex.get(tag);
    const overlordIndex = tagIndex.get(overlord);
    if (subjectIndex === undefined || overlordIndex === undefined) continue;
    subject[subjectIndex] = packRgb(...shadeRgb(unpackRgb(mod[overlordIndex] as number), targets.get(tag) ?? midBand));
    from[subjectIndex] = ledger.relations.get(tag)?.ordinal ?? campaignStart;
  }

  // Countries drawn in somebody else's own colour although they are not a 属国 (an ended
  // subjection, or a 朝贡国 the mods painted as one): 属国染色 hands them their own colour.
  const foreignTint = foreignTintFlags({
    own: ownColours,
    drawn: mod,
    subject: tagList.map((tag) => overlordOf.has(tag)),
    landed: tagList.map((tag) => landed.has(tag)),
  });
  for (let i = 0; i < count; i += 1) if (foreignTint[i]) subject[i] = original[i] as number;

  const foreignTintCount = foreignTint.reduce((total: number, flag) => total + flag, 0);
  console.log(
    `colour modes: ${count} tags, ${overlordOf.size} subject(s) (${ledger.relations.size} with a dated ` +
      `dependency), ${foreignTintCount} foreign tint(s), types ` +
      `${[...ledger.types.entries()].map(([t, n]) => `${t}=${n}`).join(' ')}`,
  );
  return {
    original,
    mod,
    subject,
    from,
    foreignTint,
    subjects: overlordOf.size,
    types: Object.fromEntries(ledger.types),
  };
})();

const data = {
  w: width,
  h: height,
  scale: SCALE,
  start,
  end: doc.meta.date,
  months: months.map((m) => m.ordinal),
  monthLabels: months.map((m) => m.date),
  provinceFields: [...PROVINCE_FIELDS],
  provinceDicts: PROVINCE_FIELDS.map((f) => provinceDicts.get(f)!.dict),
  provinceInit: initRows,
  provinceEvents: eventRows,
  countryFields: [...COUNTRY_FIELDS],
  countryDicts: COUNTRY_FIELDS.map((f) => countryDicts.get(f)!.dict),
  countryInit: countryInitRows,
  countryEvents: countryEventRows,
  /** [year*12+month-1, provinceId, contribution×100, attackerTag, defenderTag, losses] */
  battles: battleRows,
  /**
   * Total adm+dip+mil tech per tag index. A snapshot, not a series: the save
   * records no usable tech timeline, so this view does not change over time.
   */
  tagTech,
  /** [provinceId, embracedCount, embracingIndex] — likewise a snapshot. */
  provinceInstitutions,
  tags: tagList,
  tagColors: tagColors.map((c) => c ?? 0),
  /**
   * The three colour modes, one packed colour per tag index: the country's own colour,
   * what the save draws (the recolouring mod's result), the 属国染色 colour (ΔE 8–14
   * from the overlord's), and the ordinal each subjection began (`from`, -1 when the
   * tag is nobody's subject). A country whose `color` is the engine's `255 255 255`
   * placeholder — a colonial nation — has its own colour derived from its mother
   * country instead of being painted white.
   */
  colours: colourModes,
  tagAlias,
  countryNames: tagList.map((tag) => displayName(tag)),
  religions: religionDict,
  religionColors: religionDict.map((r) => packRgb(...religionColorOf(r))),
  cultures: cultureDict,
  cultureColors: cultureDict.map((c) => packRgb(...cultureColorOf(c))),
  dynasties: dynastyDict,
  dynastyColors,
  /**
   * Colonial nations and their mother country. `colonial_parent` is the real
   * relationship (36 countries here); `overlord` also covers vassals and junior
   * partners in a personal union (50), which must NOT be drawn as colonies.
   */
  colonialParent: (() => {
    const out: Record<string, string> = {};
    for (const [tag, country] of countries) {
      const parent = countryScalar(country, 'colonial_parent');
      if (parent) out[tag] = parent;
    }
    return out;
  })(),
  /** Holy Roman Empire: dated emperor changes, plus today's roles. */
  hre: hreInfo,
  /** Top-12 development / province-count series, one sample per month. */
  curves,
  provinceNames: [...provinces.keys()].map((id) => provinces.get(id)?.name ?? ''),
  provinceIds: [...provinces.keys()],
  /**
   * The detail-panel tables (省份国家界面阶段任务书 §2): province extras read out of
   * the province blocks, plus the country panel's wave-1 scalars. Built by the shared
   * `buildDetailTables`, which `viewer-build.js` calls at the same point so the two
   * planes agree key for key.
   */
  provinceBuildings: detailTables.provinceBuildings,
  provinceCores: detailTables.provinceCores,
  provinceClaims: detailTables.provinceClaims,
  provinceGreatProjects: detailTables.provinceGreatProjects,
  provinceTradeGoods: detailTables.provinceTradeGoods,
  provinceLatentTradeGoods: detailTables.provinceLatentTradeGoods,
  provinceImprove: detailTables.provinceImprove,
  /** `-1` for a province with no terrain; the dictionary comes from S2's table. */
  provinceTerrain: detailTables.provinceTerrain,
  provinceArea: detailTables.provinceArea,
  areaDetail: detailTables.areaDetail,
  provinceDevastation: detailTables.provinceDevastation,
  provinceTradeCompany: detailTables.provinceTradeCompany,
  countryDetail: detailTables.countryDetail,
  /**
   * S2's `uiNames.json` baked into the plane, plus the two shapes the panel code indexes
   * directly. `cultureNames` runs parallel to `cultures` (the panel knows a culture's
   * dictionary slot, not its key); `personalityNames` is the personality map itself,
   * because the save keeps personalities as free-standing keys, not a dictionary.
   */
  uiNames,
  cultureNames,
  personalityNames,
  /**
   * 波 3 的槽位名表（19 收入 / 38 支出 / 46 点数）：`countryDetail[tag].budget` 与
   * `.manaSpent` 的数组下标与它们一一对应。
   */
  ledgerSlots: detailTables.ledgerSlots,
  manaSlots: detailTables.manaSlots,
  /**
   * 历史十五个最优秀将军 / 十五个最优秀君主 (第四对话任务书 §3.4): the two boards plus the
   * weights, floors and measured war-record coverage the pages print.
   */
  rankings: detailTables.rankings,
  waterSea: [...water.sea],
  waterLakes: [...water.lakes],
  constants: {
    sea: packRgb(...SEA),
    lake: packRgb(...LAKE),
    unowned: packRgb(...UNOWNED),
    none: packRgb(...NO_PROVINCE),
    stripePeriod: STRIPE_PERIOD,
    stripeWidth: STRIPE_WIDTH,
    maxDev: Math.max(
      1,
      ...[...provinces.values()].map(
        (p) => (p.baseTax ?? 0) + (p.baseProduction ?? 0) + (p.baseManpower ?? 0),
      ),
    ),
    maxBattleScore,
    maxNavalScore,
    techMin,
    techMax,
    instMin,
    instMax,
    /** Empire role colours, read by the client as C.hre.*. */
    hre: {
      emperor: packRgb(...HRE_COLORS.emperor),
      elector: packRgb(...HRE_COLORS.elector),
      freeCity: packRgb(...HRE_COLORS.freeCity),
      member: packRgb(...HRE_COLORS.member),
      foreign: packRgb(...HRE_COLORS.foreign),
    },
  },
  peak: { month: bestMonth, occupied: bestCount },
};

// Standalone data plane, for the eventual web app (and for tooling).
writeFileSync(`${OUT}/data.json`, JSON.stringify(data), 'utf8');
console.log(`wrote ${OUT}/data.json (${(JSON.stringify(data).length / 1024 / 1024).toFixed(2)} MB)`);

// ------------------------------------------------------- leaderboard inputs ---
const saveOrdinalForTables = parseGameDate(doc.meta.date)!.ordinal;

/** Total land regiments per tag, counted in one pass over the countries block. */
function armySizes(): Map<string, number> {
  const out = new Map<string, number>();
  const ref = doc.section('countries');
  if (!ref) return out;
  const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);
  const countRegiments = (armyReader: ClausewitzReader, depth: number): number => {
    let count = 0;
    for (;;) {
      const member = armyReader.nextMember();
      if (!member) break;
      if (member.key === 'regiment') count += 1;
      if (
        member.kind === 'block' &&
        depth < 2 &&
        (member.key === 'mercenary_company' || member.key === 'subunit' || member.key === 'army')
      ) {
        count += countRegiments(armyReader.enter(member), depth + 1);
      }
    }
    return count;
  };
  for (;;) {
    const country = reader.nextMember();
    if (!country) break;
    if (country.kind !== 'block' || country.key === null) continue;
    let regiments = 0;
    const body = reader.enter(country);
    for (;;) {
      const item = body.nextMember();
      if (!item) break;
      if (item.key === 'army' && item.kind === 'block') {
        regiments += countRegiments(body.enter(item), 0);
      }
    }
    if (regiments > 0) out.set(country.key, regiments);
  }
  return out;
}

const armyByTag = armySizes();
console.log(`army sizes: ${armyByTag.size} countries with regiments`);

const provinceDev = new Map<number, number>();
const countryDev = new Map<string, number>();
for (const province of provinces.values()) {
  const dev =
    (province.baseTax ?? 0) + (province.baseProduction ?? 0) + (province.baseManpower ?? 0);
  provinceDev.set(province.id, dev);
  const ownerTag = province.owner;
  if (!ownerTag || ownerTag === '---' || ownerTag === 'REB') continue;
  const resolved = resolveTag(aliases, ownerTag, saveOrdinalForTables);
  countryDev.set(resolved, (countryDev.get(resolved) ?? 0) + dev);
}

interface LeaderRow {
  tag: string;
  name: string;
  color: RGB;
  score: number;
  dev: number;
  capital: string;
  religion: string;
  income: number;
  army: number;
}

/**
 * Display name for a tag. Localisation covers the normal tags, but dynamically
 * created ones (colonial nations like C05) have no localisation key at all —
 * their name is stored in the save itself (`name = 十三殖民地`).
 */
function displayName(tag: string): string {
  const localised = localise(names, tag);
  if (localised && localised !== tag) return localised;
  const country = countries.get(tag);
  const stored = country ? countryScalar(country, 'name') : undefined;
  if (stored) return stored;
  const parent = country ? countryScalar(country, 'colonial_parent') : undefined;
  if (parent) return displayName(parent) + '属' + tag;
  return localised || tag;
}

const leaderRows: LeaderRow[] = [];
for (const [tag, country] of countries) {
  const resolved = resolveTag(aliases, tag, saveOrdinalForTables);
  const capitalId = Number(countryScalar(country, 'capital') ?? '0');
  const score = Number(countryScalar(country, 'great_power_score') ?? '0');
  const dev = countryDev.get(resolved) ?? countryDev.get(tag) ?? 0;
  if (!(dev > 0)) continue;
  leaderRows.push({
    tag,
    name: displayName(tag),
    color: countryColorRaw(resolved),
    score: Number.isFinite(score) ? score : 0,
    dev: Math.round(dev),
    capital: provinces.get(capitalId)?.name ?? '',
    religion: localise(names, countryScalar(country, 'religion')),
    income: Number(countryScalar(country, 'estimated_monthly_income') ?? '0') || 0,
    army: armyByTag.get(tag) ?? 0,
  });
}
leaderRows.sort((a, b) => b.score - a.score || b.dev - a.dev);

const leaderTable = leaderRows
  .slice(0, 15)
  .map(
    (row, index) =>
      `<tr><td class="num">${index + 1}</td>` +
      // `data-tag` lets the client repaint this colour when the colour mode changes.
      `<td><span class="sw" data-tag="${esc(row.tag)}" style="background:${toHex(row.color)}"></span>` +
      `<img class="flag" data-tag="${esc(row.tag)}" alt="" onerror="this.style.display='none'">` +
      `${esc(row.name)}</td>` +
      `<td class="tag">${row.tag}</td>` +
      `<td class="num">${row.score.toFixed(1)}</td>` +
      `<td class="num">${row.dev.toLocaleString()}</td>` +
      `<td>${esc(row.capital)}</td>` +
      `<td>${esc(row.religion)}</td>` +
      `<td class="num">${row.income.toFixed(1)}</td>` +
      `<td class="num">${row.army.toLocaleString()}</td></tr>`,
  )
  .join('\n');

const cityTable = [...provinces.values()]
  .map((province) => ({ province, dev: provinceDev.get(province.id) ?? 0 }))
  .filter((entry) => entry.dev > 0)
  .sort((a, b) => b.dev - a.dev)
  .slice(0, 15)
  .map((entry, index) => {
    const owner = entry.province.owner;
    const ownerName =
      owner && owner !== '---'
        ? localise(names, resolveTag(aliases, owner, saveOrdinalForTables))
        : '';
    return (
      `<tr><td class="num">${index + 1}</td>` +
      `<td>${esc(entry.province.name ?? '')}</td>` +
      `<td class="num">${Math.round(entry.dev)}</td>` +
      `<td>${esc(localise(names, entry.province.religion))}</td>` +
      `<td>${esc(ownerName)} <span class="tag">${owner ?? ''}</span></td></tr>`
    );
  })
  .join('\n');

const institutionOrigins = (() => {
  const originNode = doc.readSection('institution_origin');
  const foundedNode = doc.readSection('institutions');
  const ids =
    originNode && originNode.type === 'list'
      ? originNode.items.map((i) => Number(i.type === 'scalar' ? i.value : '0'))
      : [];
  const founded =
    foundedNode && foundedNode.type === 'list'
      ? foundedNode.items.map((i) => Number(i.type === 'scalar' ? i.value : '0'))
      : [];
  return INSTITUTIONS.map((institution, index) => {
    const provinceId = ids[index] ?? 0;
    const province = provinceId > 0 ? provinces.get(provinceId) : undefined;
    return (
      `<tr><td>${index + 1}</td><td>${esc(institution.zh)}</td>` +
      `<td>${esc(province?.name ?? '—')}</td>` +
      `<td>${province ? `<span class="tag">#${provinceId}</span>` : ''}</td>` +
      `<td>${founded[index] ? '<span class="ok">已诞生</span>' : '<span class="no">未出现</span>'}</td></tr>`
    );
  }).join('\n');
})();

void religionHex;
void institutionLabel;

/**
 * The page markup is a shared static asset: apps/site/public/viewer.html is also
 * what the hosted viewer serves, so the two cannot drift. Host-specific pieces
 * (the painter, the data plane, the client script) go in through HOST_SCRIPTS, and
 * the numbers around the map arrive as VIEWER_FACTS for the client to fill in.
 */
const VIEWER_HTML = readFileSync('apps/site/public/viewer.html', 'utf8');

/** Facts and panel tables the client paints into the shared markup. */
const viewerFacts = {
  title: doc.meta.displayedCountryName ?? '',
  start,
  end: doc.meta.date,
  // The frame and event counts are no longer printed: the line under the heading names the
  // archive's own fields now, the same four the catalogue card shows. They stay in this
  // object because the client fills every matching data-fact span from it and they are what
  // any future "what is in this file" line would want; the hosted page publishes them too.
  // Pre-formatted: the client sets these as text, and 1,562 reads better than 1562.
  frames: months.length.toLocaleString(),
  provinces: stats.provincesWithHistory.toLocaleString(),
  events: stats.eventCount.toLocaleString(),
  width,
  height,
  // The four the subtitle prints. A file on disk has no catalogue record behind it, so the
  // end date is the parsed campaign date, the version and the mod count come straight out
  // of the save's own meta, and 封档日期 has no real-world value at all — it prints as a
  // dash, which is exactly what the hosted page shows for an unset one. Keys must match the
  // data-fact attributes in viewer.html.
  version: doc.meta.version.text || '—',
  endDate: doc.meta.date || '—',
  sealedAt: '—',
  mods: doc.meta.mods.length ? `${doc.meta.mods.length} 个` : '—',
};
const viewerPanels = {
  leaders: leaderTable,
  cities: cityTable,
  institutions: institutionOrigins,
};

const hostScripts = [
  '<script>',
  PAINT_SOURCE,
  '</script>',
  '<script>',
  `const DATA = ${JSON.stringify(data)};`,
  `const RASTER = ${JSON.stringify(rasterUri)};`,
  `const BG = ${JSON.stringify(bgFiles)};`,
  `const ALIAS = DATA.tagAlias;`,
  // Absolute from the site root, exactly as the hosted page does it: the generated
  // page is three levels deep, so a relative prefix is a trap (see viewer.js).
  "const VIEWER_ASSETS = { flags: '/assets/flags/' };",
  'const VIEWER_FACTS = ' + JSON.stringify(viewerFacts) + ';',
  'const VIEWER_PANELS = ' + JSON.stringify(viewerPanels) + ';',
  '</script>',
  // The shared background/theme component comes before the player: that is what makes
  // `mountPageTheme` a global here, exactly as viewer-page.js makes it one on the
  // hosted page. Without this block the generated page has no 🎨 controls at all.
  '<script>',
  THEME_SOURCE,
  '</script>',
  '<script>',
  VIEWER_SOURCE,
  '</script>',
].join('\n');

/**
 * The hosted script tail, exactly as viewer.html ships it. Replacing this whole
 * block (not just a token) keeps the served file valid on its own, and the assert
 * below catches the day someone edits one side only.
 */
const HOSTED_TAIL = [
  '<!-- HOST_SCRIPTS: as served, this page is the hosted viewer and loads the shared',
  '     assets over HTTP. scripts/render-timeline.ts replaces this entire block with',
  '     the inline scripts that make the standalone file self-contained. -->',
  '<script src="paint.js"></script>',
  '<!-- A module: the bootstrap imports the parser and the builder. paint.js stays a',
  '     classic script because the player reads its functions as globals. -->',
  '<script type="module" src="viewer-page.js"></script>',
].join('\n');
if (!VIEWER_HTML.includes(HOSTED_TAIL)) {
  throw new Error('viewer.html no longer carries the hosted script tail; the offline page would ship no player');
}

// A function replacement: the data contains `$`, which a string replacement would
// interpret (`$&`, `$'`).
const html = VIEWER_HTML.replace(HOSTED_TAIL, () => hostScripts);


writeFileSync(`${OUT}/index.html`, html, 'utf8');
console.log(
  `wrote ${OUT}/index.html  ${(html.length / 1024 / 1024).toFixed(2)} MB (self-contained)`,
);
console.log(`elapsed ${((performance.now() - t0) / 1000).toFixed(1)} s`);

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

