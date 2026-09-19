/**
 * Cross-check the parser against ground truth that does not come from the save:
 * the game's own Chinese localisation files and `map/definition.csv`.
 *
 *   node scripts/verify.ts
 */
import { readFileSync } from 'node:fs';
import { SaveDocument } from '../packages/eu4-parser/src/document.ts';
import { decodeSaveString } from '../packages/eu4-parser/src/encoding.ts';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const MOD_LOC = String.raw`D:\Software\Steam\Steam\steamapps\workshop\content\236850\2976470733\localisation\prov_names_l_english.yml`;
const DEFINITION = String.raw`D:\Software\Steam\Steam\steamapps\eu4_placeholder`;
const EU4 = String.raw`D:\Software\Steam\Steam\steamapps\common\Europa Universalis IV`;

/** Decode an escaped localisation value into text (CP1252 round-trip first). */
function decodeLocalisationValue(value: string): string {
  const bytes: number[] = [];
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x100) {
      bytes.push(code);
      continue;
    }
    // Characters that were CP1252 bytes 0x80..0x9F, re-saved as UTF-8.
    const cp1252 = CP1252_REVERSE.get(code);
    if (cp1252 === undefined) return `<undecodable U+${code.toString(16)}>`;
    bytes.push(cp1252);
  }
  return decodeSaveString(Uint8Array.from(bytes));
}

const CP1252_REVERSE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

const localisation = new Map<number, string>();
{
  const text = readFileSync(MOD_LOC, 'utf8');
  for (const m of text.matchAll(/PROV(\d+):\d*\s*"([^"]*)"/g)) {
    localisation.set(Number(m[1]), decodeLocalisationValue(m[2]!));
  }
}

// definition.csv: id;r;g;b;name;type
const definitions = new Map<number, string>();
{
  const text = readFileSync(`${EU4}\\map\\definition.csv`, 'latin1');
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(';');
    if (parts.length < 5) continue;
    const id = Number(parts[0]);
    if (!Number.isInteger(id)) continue;
    definitions.set(id, parts[4]!);
  }
}

const doc = await SaveDocument.fromFile(SAVE);
const provinces = doc.provinces();
const countries = doc.countries();

console.log(`parsed: ${provinces.size} provinces, ${countries.size} countries, ${doc.sections.length} sections`);
console.log(`localisation entries: ${localisation.size}, definition.csv rows: ${definitions.size}`);

// --- 1. province names vs localisation ---
let matched = 0, mismatched = 0, missing = 0;
const examples: string[] = [];
for (const [id, province] of provinces) {
  const expected = localisation.get(id);
  if (expected === undefined) { missing += 1; continue; }
  if (province.name === expected) matched += 1;
  else {
    mismatched += 1;
    if (examples.length < 15) {
      examples.push(`  id=${id} save=${JSON.stringify(province.name)} localisation=${JSON.stringify(expected)}`);
    }
  }
}
console.log(`\n[1] province name vs localisation: matched=${matched} mismatched=${mismatched} not-in-localisation=${missing}`);
for (const line of examples) console.log(line);

// --- 2. province id <-> definition.csv internal name sanity ---
let defHits = 0;
for (const id of provinces.keys()) if (definitions.has(id)) defHits += 1;
console.log(`\n[2] province ids present in definition.csv: ${defHits}/${provinces.size}`);

// --- 3. country capitals point at real provinces ---
let capOk = 0, capBad = 0;
const capExamples: string[] = [];
for (const [tag, country] of countries) {
  const raw = country.scalars['capital'];
  if (raw === undefined) continue;
  const n = Number(raw);
  if (!Number.isInteger(n)) continue;
  if (provinces.has(n)) capOk += 1;
  else if (provinces.has(-n)) capBad += 1;
  else if (capExamples.length < 10) capExamples.push(`  ${tag}: capital=${n} not a province`);
}
console.log(`\n[3] country capitals resolving to a province: direct=${capOk} needs-negation=${capBad}`);
for (const line of capExamples) console.log(line);

// --- 4. what is RUS's capital province actually called? ---
const rus = countries.get('RUS');
if (rus) {
  const cap = Number(rus.scalars['capital']);
  const p = provinces.get(cap) ?? provinces.get(-cap);
  console.log(`\n[4] RUS capital key=${cap} -> province "${p?.name}" owner=${p?.owner}`);
}
for (const tag of ['SPI', 'PER', 'GBR', 'CAS']) {
  const c = countries.get(tag);
  if (!c) continue;
  const cap = Number(c.scalars['capital']);
  const p = provinces.get(cap) ?? provinces.get(-cap);
  console.log(`    ${tag} capital key=${cap} -> "${p?.name}"`);
}

// --- 5. sample of well known provinces ---
console.log('\n[5] spot checks (id: save name | localisation | definition.csv):');
for (const id of [1, 2, 3, 151, 1836, 2368, 295, 932]) {
  const p = provinces.get(id);
  console.log(
    `    ${String(id).padStart(5)}: ${(p?.name ?? '<absent>').padEnd(14)} | ` +
    `${(localisation.get(id) ?? '-').padEnd(14)} | ${definitions.get(id) ?? '-'}`,
  );
}

// --- 6. province-key convention ---
const keys = [...provinces.keys()].sort((a, b) => a - b);
console.log(`\n[6] province id range after normalisation: ${keys[0]} .. ${keys[keys.length - 1]}`);

// --- 7. decode coverage / anomalies ---
const warnings: string[] = [];
let replacementChars = 0;
for (const p of provinces.values()) {
  if (p.name?.includes('\uFFFD')) replacementChars += 1;
}
console.log(`\n[7] province names containing a truncation marker U+FFFD: ${replacementChars}`);
void warnings;
