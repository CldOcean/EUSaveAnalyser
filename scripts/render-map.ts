/**
 * Render the save's current state as maps, with occupation hatching.
 *
 *   node scripts/render-map.ts
 *
 * Four views (into `tmp/preview/`):
 *   political    fill = owner's map colour, hatch = occupier's colour
 *   religion     fill = the province's own religion, hatch = owner's state religion
 *   culture      fill = the province's own culture, hatch = owner's primary culture
 *   development  heat map, low = red, high = green
 *
 * Hatching is what makes a war legible: a province that is merely *occupied*
 * keeps its owner's fill and gains the occupier's diagonal bands, which is
 * exactly how the game and PDX Tools draw it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodePng } from './lib/png.ts';
import { loadLocalisation, localise } from './lib/localisation.ts';
import {
  MOD_LOCALISATION,
  buildPalette,
  colorToIdMap,
  hashColor,
  loadDefinitions,
  loadProvincePixels,
  loadWaterIds,
  toHex,
  type RGB,
} from './lib/map-assets.ts';
import {
  BORDER_DARKEN,
  STRIPE_PERIOD,
  STRIPE_WIDTH,
  buildBorderMask,
  devRamp,
  institutionRamp,
  packRgb,
  paintMap,
  techRamp,
} from './lib/paint.js';
import { SaveDocument, countryGroup, countryScalar } from '../packages/eu4-parser/src/document.ts';
import { readInstitutionProgress } from '../packages/eu4-parser/src/institutions.ts';
import {
  CountryTimelinePlayer,
  buildCountryTimeline,
  buildTagAliases,
  resolveTag,
  resolveTagLatest,
} from '../packages/eu4-parser/src/timeline.ts';
import { parseGameDate } from '../packages/eu4-parser/src/value.ts';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const OUT = 'tmp/preview';
const WIDTH = 5632;
const HEIGHT = 2048;

const SEA: RGB = [26, 52, 84];
const LAKE: RGB = [42, 88, 128];
// Neutral grey: several countries (Ming is 179/128/104) are desaturated warm
// tones, so a brown "unowned" colour is easy to mistake for a real country.
const UNOWNED: RGB = [88, 92, 98];
const NO_PROVINCE: RGB = [12, 12, 18];
/** Rebels hold provinces without being a country; give them a fixed colour. */
const REBEL: RGB = [140, 30, 30];

mkdirSync(OUT, { recursive: true });

const definitions = loadDefinitions();
const water = loadWaterIds();
const pixels = loadProvincePixels(WIDTH, HEIGHT, colorToIdMap(definitions));
const borderMask = buildBorderMask(pixels, WIDTH, HEIGHT, water.all);

const doc = await SaveDocument.fromFile(SAVE);
const provinces = doc.provinces();
const countries = doc.countries();
const aliases = buildTagAliases(doc);
const saveOrdinal = parseGameDate(doc.meta.date)!.ordinal;

const names = loadLocalisation([
  `${MOD_LOCALISATION}/text_l_english.yml`,
  `${MOD_LOCALISATION}/countries_l_english.yml`,
]);
console.log(`localisation entries: ${names.size}`);

// --------------------------------------------------------------- palettes ----
const NO_COLOR = 0;

function countryColor(tag: string): RGB {
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

const ownerOf = new Map<number, string>();
for (const p of provinces.values()) if (p.owner && p.owner !== '---') ownerOf.set(p.id, p.owner);

const religionValues = [...new Set([...provinces.values()].map((p) => p.religion ?? ''))]
  .filter(Boolean)
  .sort();
const religionPalette = buildPalette(religionValues);
const cultureValues = [...new Set([...provinces.values()].map((p) => p.culture ?? ''))]
  .filter(Boolean)
  .sort();
const culturePalette = buildPalette(cultureValues);

// state religion / primary culture per tag at the save date
const countryTimeline = buildCountryTimeline(doc);
const countryPlayer = new CountryTimelinePlayer(countryTimeline, ['religion', 'primary_culture']);
countryPlayer.advanceTo(saveOrdinal);
const stateReligion = new Map<string, string>();
const primaryCulture = new Map<string, string>();
for (const tag of countries.keys()) {
  const latest = resolveTagLatest(aliases, tag);
  const religion =
    countryPlayer.valueOf('religion', latest) ?? countryScalar(countries.get(tag)!, 'religion');
  const culture =
    countryPlayer.valueOf('primary_culture', latest) ??
    countryScalar(countries.get(tag)!, 'primary_culture');
  if (religion) stateReligion.set(tag, religion);
  if (culture) primaryCulture.set(tag, culture);
}
console.log(`country timelines: ${countryTimeline.countries.size} entries, ${countryTimeline.events.length} events`);

// ----------------------------------------------------------------- render ----
const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
const base = new Uint32Array(65_536);
const hatch = new Uint32Array(65_536);

function reset(): void {
  // Everything starts as "unowned land"; water and real owners overwrite it.
  // Forgetting this leaves unowned provinces as index 0 -> black.
  base.fill(packRgb(...UNOWNED));
  hatch.fill(0);
}

function render(file: string, label: string): void {
  paintMap(pixels, rgba, WIDTH, HEIGHT, base, hatch, borderMask, STRIPE_PERIOD, STRIPE_WIDTH, true);
  const png = encodePng(WIDTH, HEIGHT, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length), 4);
  writeFileSync(file, png);
  console.log(`  ${label.padEnd(28)} ${file}  ${(png.length / 1024 / 1024).toFixed(2)} MB`);
}

/** Paint water/unowned and return the colour to use for owned provinces. */
function paintTerrain(): void {
  base[0] = packRgb(...NO_PROVINCE);
  for (const id of water.all) base[id] = seaOrLake(id);
}

function seaOrLake(id: number): number {
  return water.sea.has(id) ? packRgb(...SEA) : packRgb(...LAKE);
}

/** Paint a 1:1 window of the current `base`/`hatch` state into its own PNG. */
function renderCrop(
  file: string,
  label: string,
  x0: number,
  y0: number,
  w: number,
  h: number,
): void {
  const sub = new Uint16Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const src = (y0 + y) * WIDTH + x0;
    sub.set(pixels.subarray(src, src + w), y * w);
  }
  const subMask = buildBorderMask(sub, w, h, water.all);
  const subRgba = new Uint8ClampedArray(w * h * 4);
  paintMap(sub, subRgba, w, h, base, hatch, subMask, STRIPE_PERIOD, STRIPE_WIDTH, true);
  const png = encodePng(w, h, new Uint8Array(subRgba.buffer), 4);
  writeFileSync(file, png);
  console.log(`  ${label.padEnd(28)} ${file}  ${(png.length / 1024).toFixed(0)} KB`);
}

const occupied: number[] = [];

// ---- political ----
reset();
paintTerrain();
for (const [id, owner] of ownerOf) {
  const ownerLatest = resolveTag(aliases, owner, saveOrdinal);
  base[id] = packRgb(...countryColor(ownerLatest));
  const controller = provinces.get(id)?.controller;
  if (controller && controller !== '---' && controller !== owner) {
    hatch[id] = packRgb(...countryColor(resolveTag(aliases, controller, saveOrdinal)));
    occupied.push(id);
  }
}
render(`${OUT}/political.png`, `political (${occupied.length} occupied)`);

// A 1:1 crop, so the hatching can actually be inspected: at 5632 px wide a
// full-map view shrinks stripes below one pixel on screen.
if (occupied.length > 0) {
  const occupiedSet = new Set(occupied);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < pixels.length; i += 7) {
    if (!occupiedSet.has(pixels[i] as number)) continue;
    sx += i % WIDTH;
    sy += Math.floor(i / WIDTH);
    n += 1;
  }
  if (n > 0) {
    const cx = Math.round(sx / n);
    const cy = Math.round(sy / n);
    const w = 1500;
    const h = 900;
    const x0 = Math.max(0, Math.min(WIDTH - w, cx - (w >> 1)));
    const y0 = Math.max(0, Math.min(HEIGHT - h, cy - (h >> 1)));
    renderCrop(`${OUT}/political-zoom.png`, `political zoom @${x0},${y0}`, x0, y0, w, h);
  }
}

// ---- religion ----
// Fill = the province's own faith. Hatch = the faith actually present (the
// occupier's while occupied, otherwise the owner's) when it differs. A country
// of faith X over a province of faith X leaves the colour alone.
reset();
paintTerrain();
for (const province of provinces.values()) {
  const id = province.id;
  if (water.all.has(id)) continue;
  const religion = province.religion;
  base[id] = religion
    ? packRgb(...(religionPalette.get(religion) ?? UNOWNED))
    : packRgb(...UNOWNED);
  const owner = ownerOf.get(id);
  if (!owner || !religion) continue;
  const controller = province.controller;
  // Rebels are not a country: EU4 leaves `controller=REB` behind for decades, so
  // counting them would paint permanent red hatching over 84 provinces.
  const occupied =
    Boolean(controller && controller !== '---' && controller !== 'REB') &&
    resolveTagLatest(aliases, controller as string) !== resolveTagLatest(aliases, owner);
  const presence = occupied ? (controller as string) : owner;
  const presenceReligion =
    stateReligion.get(presence) ?? stateReligion.get(resolveTagLatest(aliases, presence));
  if (presenceReligion && presenceReligion !== religion) {
    hatch[id] = packRgb(...(religionPalette.get(presenceReligion) ?? UNOWNED));
  }
}
render(`${OUT}/religion.png`, 'religion (faith-present hatch)');

// ---- culture: plain fill, no hatching ----
reset();
paintTerrain();
for (const province of provinces.values()) {
  const id = province.id;
  if (water.all.has(id)) continue;
  const culture = province.culture;
  base[id] = culture
    ? packRgb(...(culturePalette.get(culture) ?? UNOWNED))
    : packRgb(...UNOWNED);
}
render(`${OUT}/culture.png`, 'culture (no hatch)');

// ---- technology: a snapshot, scored relatively (weakest red, strongest green) ----
reset();
paintTerrain();
let maxTech = 1;
let minTech = Number.POSITIVE_INFINITY;
const techOf = new Map<string, number>();
for (const [tag, country] of countries) {
  const tech = countryGroup(country, 'technology') ?? {};
  const level =
    (Number(tech['adm_tech']) || 0) +
    (Number(tech['dip_tech']) || 0) +
    (Number(tech['mil_tech']) || 0);
  techOf.set(tag, level);
  if (level > 0 && level < minTech) minTech = level;
  if (level > maxTech) maxTech = level;
}
if (!Number.isFinite(minTech)) minTech = 0;
{
  const span = maxTech - minTech;
  for (const [id, owner] of ownerOf) {
    const level = techOf.get(resolveTag(aliases, owner, saveOrdinal)) ?? 0;
    base[id] = level > 0 ? techRamp(span > 0 ? (level - minTech) / span : 1) : packRgb(...UNOWNED);
  }
}
render(`${OUT}/tech.png`, `tech snapshot (${minTech}..${maxTech}, relative)`);

// ---- institutions: a snapshot, relative; hatching while one is in progress ----
reset();
paintTerrain();
let instMin = 8;
let instMax = 0;
const institutionOf = new Map<number, { embraced: number; embracing: number }>();
for (const province of provinces.values()) {
  const progress = readInstitutionProgress(province.institutions);
  institutionOf.set(province.id, progress);
  if (progress.embraced < instMin) instMin = progress.embraced;
  if (progress.embraced > instMax) instMax = progress.embraced;
}
if (instMin > instMax) instMin = instMax;
{
  const span = instMax - instMin;
  const norm = (level: number): number => (span > 0 ? (level - instMin) / span : 1);
  for (const [id, progress] of institutionOf) {
    if (water.all.has(id)) continue;
    base[id] = institutionRamp(norm(progress.embraced));
    if (progress.embracing >= 0) hatch[id] = institutionRamp(norm(progress.embracing + 1));
  }
}
render(
  `${OUT}/institution.png`,
  `institutions (${instMin}..${instMax}, ${[...institutionOf.values()].filter((p) => p.embracing >= 0).length} in progress)`,
);

// ---- development: low = red, high = green ----
reset();
paintTerrain();
let maxDev = 1;
const development = new Map<number, number>();
for (const province of provinces.values()) {
  const dev =
    (province.baseTax ?? 0) + (province.baseProduction ?? 0) + (province.baseManpower ?? 0);
  development.set(province.id, dev);
  if (dev > maxDev) maxDev = dev;
}
for (const [id, dev] of development) {
  if (water.all.has(id)) continue;
  base[id] = dev === 0 ? packRgb(...UNOWNED) : devRamp(Math.sqrt(dev / maxDev));
}
paintMap(pixels, rgba, WIDTH, HEIGHT, base, hatch, borderMask, STRIPE_PERIOD, STRIPE_WIDTH, false);
{
  const png = encodePng(WIDTH, HEIGHT, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length), 4);
  writeFileSync(`${OUT}/development.png`, png);
  console.log(`  ${'development (red→green)'.padEnd(28)} ${OUT}/development.png  ${(png.length / 1024 / 1024).toFixed(2)} MB`);
}

// ----------------------------------------------------------------- report ---
const counts = new Map<string, { provinces: number; dev: number }>();
for (const [id, owner] of ownerOf) {
  const entry = counts.get(owner) ?? { provinces: 0, dev: 0 };
  entry.provinces += 1;
  entry.dev += development.get(id) ?? 0;
  counts.set(owner, entry);
}
const rows = [...counts.entries()]
  .map(([tag, v]) => ({ tag, ...v, name: localise(names, tag), color: countryColor(tag) }))
  .sort((a, b) => b.dev - a.dev)
  .slice(0, 40);

const table = rows
  .map(
    (r) =>
      `<tr><td><span class="sw" style="background:${toHex(r.color)}"></span></td>` +
      `<td class="tag">${r.tag}</td><td>${esc(r.name)}</td>` +
      `<td class="num">${r.provinces}</td><td class="num">${r.dev}</td></tr>`,
  )
  .join('\n');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(doc.meta.displayedCountryName ?? '')} ${esc(doc.meta.date)} — 视图</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;padding:28px;background:#0f1115;color:#e6e6e6;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
 h1{margin:0 0 4px;font-size:21px} h2{margin:32px 0 10px;font-size:15px;color:#9fb4cc;border-bottom:1px solid #263042;padding-bottom:6px}
 .sub{color:#8a93a3;font-size:13px;margin-bottom:20px}
 figure{margin:0 0 26px} img{width:100%;display:block;border:1px solid #263042;border-radius:6px;image-rendering:pixelated}
 figcaption{color:#8a93a3;font-size:12.5px;margin-top:8px}
 table{border-collapse:collapse;font-size:13px;width:100%}
 th,td{padding:5px 10px;border-bottom:1px solid #1e2530;text-align:left}
 th{color:#7f8c9f;font-weight:600;position:sticky;top:0;background:#0f1115}
 td.num{text-align:right;font-variant-numeric:tabular-nums} td.tag{font-weight:600;color:#cfe0f5}
 .sw{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid #00000080}
 .note{background:#161a21;border:1px solid #263042;border-radius:8px;padding:12px 16px;font-size:13px;color:#9fb4cc;margin-bottom:22px}
</style></head><body>
<h1>${esc(doc.meta.displayedCountryName ?? '')} · ${esc(doc.meta.date)} — 四种视图</h1>
<div class="sub">${esc(SAVE)}</div>
<div class="note">
  <b>斜线 = 被占领 / 宗教不一致。</b>
  政治视图里底色是该省的拥有国，斜线是当前<b>占领国</b>（战时占领，尚未和谈割让）——
  本存档中有 <b>${occupied.length}</b> 个这样的省份。
  宗教视图里底色是该省本身的宗教，斜线是<b>拥有国的国教</b>；
  文化视图同理，斜线是拥有国的主体文化。
</div>

<h2>政治版图（斜线 = 被占领）</h2>
<figure><img src="political.png"><figcaption>拥有国底色 + 占领国斜线；除海洋外，灰色为无主 / 未殖民。</figcaption></figure>
<h2>宗教视图（斜线 = 实际在场的信仰不同）</h2>
<figure><img src="religion.png"><figcaption>省宗教底色；东正教国家统治逊尼派省份时，在逊尼派底色上画东正教斜线。信仰一致则不画。</figcaption></figure>
<h2>文化视图（无斜线）</h2>
<figure><img src="culture.png"><figcaption>纯省文化底色。</figcaption></figure>
<h2>发展度热力图</h2>
<figure><img src="development.png"><figcaption>越绿越高，越红越低（最高 ${maxDev}）。</figcaption></figure>
<h2>科技视图（存档当日快照，相对着色）</h2>
<figure><img src="tech.png"><figcaption>按拥有国的 adm+dip+mil 科技总和：最弱国最红、最强国最绿（${minTech}–${maxTech}）。存档没有科技时间线，故只有这一张。</figcaption></figure>
<h2>思潮视图（存档当日快照，相对着色）</h2>
<figure><img src="institution.png"><figcaption>按已接纳思潮数：最落后最红、最进步最绿；斜线＝正在接纳的思潮。存档没有思潮时间线，故只有这一张。</figcaption></figure>

<h2>列强榜（按总发展度）</h2>
<table><thead><tr><th></th><th>Tag</th><th>国名</th><th>省份</th><th>发展度</th></tr></thead><tbody>
${table}
</tbody></table>
</body></html>
`;
writeFileSync(`${OUT}/index.html`, html, 'utf8');
console.log(`wrote ${OUT}/index.html`);
console.log(`occupied provinces: ${occupied.length}`);

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

void BORDER_DARKEN;
void countryScalar;
