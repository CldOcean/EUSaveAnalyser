/**
 * Fact-finding:
 *   1. official religion colours (base game, plus which mods override them)
 *   2. where technology data lives, and whether it is dated
 *   3. what institution ("思潮") data exists
 */
import { existsSync, readdirSync } from 'node:fs';
import { SaveDocument, countryGroup } from '../packages/eu4-parser/src/document.ts';
import { buildCountryTimeline } from '../packages/eu4-parser/src/timeline.ts';
import { loadReligionTable, toHex } from './lib/religions.ts';

const EU4 = String.raw`D:\Software\Steam\Steam\steamapps\common\Europa Universalis IV`;
const WORKSHOP = String.raw`D:\Software\Steam\Steam\steamapps\workshop\content\236850`;

const save = await SaveDocument.fromFile('存档示例/mp_俄罗斯1574_11_12.eu4');

// ============================================================ 1. religion colours
console.log('================ 1. religion colours ================');
const sources: Array<{ path: string; source: string }> = [
  { path: `${EU4}/common/religions/00_religion.txt`, source: 'base' },
];
for (const dir of existsSync(WORKSHOP) ? readdirSync(WORKSHOP) : []) {
  const folder = `${WORKSHOP}/${dir}/common/religions`;
  if (!existsSync(folder)) continue;
  for (const file of readdirSync(folder)) {
    if (file.endsWith('.txt')) sources.push({ path: `${folder}/${file}`, source: `mod ${dir}` });
  }
}
console.log(`scanned ${sources.length} files (1 base + ${sources.length - 1} mod)`);

const base = loadReligionTable([sources[0]!]);
const merged = loadReligionTable(sources);
console.log(`base game: ${base.all.length} religion colour definitions`);
console.log(`with mods: ${merged.all.length} definitions, ${merged.colors.size} distinct religions`);

// which mods override religions that this save actually uses
const used = new Set<string>();
for (const p of save.provinces().values()) if (p.religion) used.add(p.religion);
for (const [, c] of save.countries()) {
  const r = c.scalars['religion'];
  if (typeof r === 'string') used.add(r);
}

const baseColors = new Map<string, [number, number, number]>();
for (const e of base.all) baseColors.set(e.religion, e.rgb);

console.log('\n--- base game colour table for every religion used in this save ---');
console.log('religion                base colour   RGB            overridden by');
for (const name of [...used].sort()) {
  const b = baseColors.get(name);
  const m = merged.colors.get(name);
  const overrides = merged.all.filter((e) => e.religion === name && e.source !== 'base');
  const changed = b && m && (b[0] !== m[0] || b[1] !== m[1] || b[2] !== m[2]);
  console.log(
    `  ${name.padEnd(22)} ${b ? toHex(b) : '   --    '}   ${b ? b.join(',').padEnd(14) : ''.padEnd(14)} ` +
      `${changed ? `${toHex(m!)} ${m!.join(',')} via ${[...new Set(overrides.map((o) => o.source))].join(',')}` : ''}`,
  );
}

console.log('\n--- full base game religion colour table ---');
const byGroup = new Map<string, Array<{ name: string; rgb: [number, number, number] }>>();
for (const e of base.all) {
  const list = byGroup.get(e.group) ?? [];
  list.push({ name: e.religion, rgb: e.rgb });
  byGroup.set(e.group, list);
}
for (const [group, list] of [...byGroup.entries()].sort()) {
  console.log(`  ${group}:`);
  for (const r of list.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`     ${r.name.padEnd(24)} ${toHex(r.rgb)}  ${r.rgb.join(',')}`);
  }
}

// ================================================================ 2. technology
console.log('\n================ 2. technology ================');
for (const key of ['tech_level_dates', 'idea_dates', 'institutions', 'institution_dates', 'advancement_dates']) {
  const ref = save.section(key);
  console.log(`  section ${key.padEnd(20)} ${ref ? `present, ${ref.size} bytes` : 'absent'}`);
}
{
  const node = save.readSection('tech_level_dates');
  if (node && node.type === 'block') {
    console.log(`\n  tech_level_dates has ${node.entries.length} entries; first 3:`);
    for (const e of node.entries.slice(0, 3)) {
      console.log(`     ${e.key} -> ${JSON.stringify(e.value).slice(0, 300)}`);
    }
  } else {
    console.log('  tech_level_dates not a block');
  }
}
{
  const country = save.countries().get('RUS')!;
  console.log(`\n  countries/RUS/technology      = ${JSON.stringify(countryGroup(country, 'technology'))}`);
  const detail = save.countryDetail('RUS');
  for (const key of ['technology', 'tech_level_dates', 'tech_dates', 'institutions', 'monarch']) {
    const node = detail?.first(key);
    console.log(`  countries/RUS/${key.padEnd(16)} = ${node ? JSON.stringify(node).slice(0, 240) : 'absent'}`);
  }
}
{
  const countryTimeline = buildCountryTimeline(save);
  const fieldCounts = new Map<string, number>();
  for (const history of countryTimeline.countries.values()) {
    for (const change of history.initial) {
      if (/tech|idea|advance|institut/i.test(change.field)) {
        fieldCounts.set(`init:${change.field}`, (fieldCounts.get(`init:${change.field}`) ?? 0) + 1);
      }
    }
    for (const event of history.events) {
      for (const change of event.changes) {
        if (/tech|idea|advance|institut/i.test(change.field)) {
          fieldCounts.set(change.field, (fieldCounts.get(change.field) ?? 0) + 1);
        }
      }
    }
  }
  console.log(`\n  tech-ish fields in country history: ${JSON.stringify([...fieldCounts.entries()].sort((a, b) => b[1] - a[1]))}`);
}
{
  // Do any country history events mention technology levels with dates at all?
  const countryTimeline = buildCountryTimeline(save);
  const samples: string[] = [];
  for (const [tag, history] of countryTimeline.countries) {
    for (const event of history.events) {
      for (const change of event.changes) {
        if (/^(adm_tech|dip_tech|mil_tech|technology)$/.test(change.field)) {
          if (samples.length < 8) samples.push(`${tag} ${event.date} ${change.field}=${change.value}`);
        }
      }
    }
  }
  console.log(`  dated tech-level samples: ${samples.length ? samples.join(' | ') : 'NONE'}`);
}

// ============================================================== 3. institutions
console.log('\n================ 3. institutions (思潮) ================');
{
  const province = save.provinceDetail(295);
  console.log(`  provinces/295/institutions  = ${JSON.stringify(province?.first('institutions')).slice(0, 220)}`);
  const detail = save.provinces().get(295);
  console.log(`  parsed provinces[295].institutions = ${JSON.stringify(detail?.institutions)}`);
  console.log(`  province keys mentioning institution: ${JSON.stringify(province?.keys().filter((k) => /institut/i.test(k)))}`);
}
{
  const country = save.countries().get('RUS')!;
  console.log(`  RUS.first_province_with_institutions = ${JSON.stringify(country.lists['first_province_with_institutions'])}`);
  console.log(`  RUS.institutions                     = ${JSON.stringify(country.lists['institutions'])}`);
  const keys = [...Object.keys(country.groups), ...Object.keys(country.blocks)].filter((k) => /institut|embrac/i.test(k));
  console.log(`  RUS sub-blocks mentioning institution: ${JSON.stringify(keys)}`);
  const detail = save.countryDetail('RUS');
  for (const key of ['institutions', 'first_province_with_institutions', 'embraced_institutions']) {
    const node = detail?.first(key);
    console.log(`  countries/RUS/${key.padEnd(30)} = ${node ? JSON.stringify(node).slice(0, 220) : 'absent'}`);
  }
}
{
  const names = [...new Set(save.sections.map((s) => s.key))].filter((k) => /institut|embrac|advancement/i.test(k));
  console.log(`  top-level sections mentioning institutions: ${JSON.stringify(names)}`);
}
