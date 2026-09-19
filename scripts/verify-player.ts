/**
 * Verify the browser player without a browser.
 *
 * Three checks:
 *   1. every `<script>` block in the generated HTML compiles;
 *   2. the packed data plane replays to exactly the state the parser reads from
 *      the save (owner / religion / culture, province by province) — this is the
 *      data the canvas draws from, so if it diverges the map is wrong;
 *   3. the packed month list starts and ends where it should, monthly.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SaveDocument } from '../packages/eu4-parser/src/document.ts';
import { buildTagAliases, buildTimeline, resolveTag } from '../packages/eu4-parser/src/timeline.ts';
import { parseGameDate } from '../packages/eu4-parser/src/value.ts';

const OUT = 'tmp/timeline';
const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';

// Province ids that are sea/lakes come from the same data the viewer uses.
let seaSet = new Set<number>();

const html = readFileSync(`${OUT}/index.html`, 'utf8');

// ------------------------------------------------------- 1. syntax check -----
console.log('=== 1. script blocks compile ===');
const scripts: string[] = [];
{
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) scripts.push(m[1] as string);
}
console.log(`  ${scripts.length} script block(s)`);
let syntaxOk = 0;
for (const [i, body] of scripts.entries()) {
  try {
    new vm.Script(body, { filename: `script-${i}.js` });
    syntaxOk += 1;
    console.log(`  script ${i}: OK (${(body.length / 1024).toFixed(0)} KB)`);
  } catch (error) {
    console.log(`  script ${i}: FAILED -> ${(error as Error).message}`);
  }
}
if (syntaxOk !== scripts.length) process.exitCode = 1;

// ------------------------------------------------------- 2. unpack data ------
console.log('\n=== 2. packed data plane ===');
const dataLine = html.split('\n').find((l) => l.startsWith('const DATA = '));
if (!dataLine) throw new Error('DATA not found in index.html');
const DATA = JSON.parse(dataLine.slice('const DATA = '.length).replace(/;$/, '')) as {
  w: number;
  h: number;
  months: number[];
  monthLabels: string[];
  provinceFields: string[];
  provinceDicts: string[][];
  provinceInit: number[][];
  provinceEvents: number[][];
  countryFields: string[];
  countryDicts: string[][];
  countryInit: number[][];
  countryEvents: number[][];
  tags: string[];
  tagAlias: number[][];
  provinceIds: number[];
  countryDicts: string[][];
  countryFields: string[];
  battles: number[][];
  peak: { month: number; occupied: number };
};
seaSet = new Set([...(DATA as unknown as { waterSea: number[] }).waterSea, ...(DATA as unknown as { waterLakes: number[] }).waterLakes]);
console.log(`  raster ${DATA.w}x${DATA.h}`);
console.log(`  months ${DATA.months.length} (${DATA.monthLabels[0]} .. ${DATA.monthLabels[DATA.monthLabels.length - 1]})`);
console.log(`  province events ${DATA.provinceEvents.length.toLocaleString()}, initial ${DATA.provinceInit.length.toLocaleString()}`);
console.log(`  country events ${DATA.countryEvents.length}, tags ${DATA.tags.length}`);

// month spacing must be monthly (the first step starts mid-month)
let monthly = true;
for (let i = 2; i < DATA.months.length - 1; i += 1) {
  const delta = (DATA.months[i] as number) - (DATA.months[i - 1] as number);
  if (delta !== 31) {
    monthly = false;
    console.log(`  !! month ${i} (${DATA.monthLabels[i]}) stepped by ${delta}, expected 31`);
    break;
  }
}
console.log(`  month step = 31 days (one EU4 month): ${monthly ? 'yes' : 'NO'}`);

// ------------------------------------------------------------- 3. replay -----
console.log('\n=== 3. replay packed events ===');
const FIELD: Record<string, number> = {};
DATA.provinceFields.forEach((f, i) => (FIELD[f] = i));
const MAX_ID = 70_000;
const owner = new Int16Array(MAX_ID).fill(-1);
const religion = new Int16Array(MAX_ID).fill(-1);
const culture = new Int16Array(MAX_ID).fill(-1);
const apply = (field: number, id: number, value: number): void => {
  if (id <= 0 || id >= MAX_ID) return;
  if (field === FIELD['owner']) owner[id] = value;
  else if (field === FIELD['religion']) religion[id] = value;
  else if (field === FIELD['culture']) culture[id] = value;
};
for (const row of DATA.provinceInit) apply(row[1] as number, row[0] as number, row[2] as number);
for (const row of DATA.provinceEvents) {
  if ((row[0] as number) > DATA.months[DATA.months.length - 1]!) break;
  apply(row[2] as number, row[1] as number, row[3] as number);
}

const doc = await SaveDocument.fromFile(SAVE);
const aliases = buildTagAliases(doc);
const saveOrdinal = parseGameDate(doc.meta.date)!.ordinal;
const tagIndexOf = new Map(DATA.tags.map((t, i) => [t, i]));
const resolveOwner = (idx: number): number => {
  let cur = idx;
  for (const a of DATA.tagAlias) if ((a[0] as number) === cur && (a[1] as number) <= saveOrdinal) cur = a[2] as number;
  return cur;
};

let compared = 0;
let exact = 0;
const failures: string[] = [];
const perField = new Map<string, { compared: number; exact: number }>();
for (const province of doc.provinces().values()) {
  const checks: Array<[string, string | undefined, number, string[]]> = [
    ['owner', province.owner, owner[province.id] as number, DATA.tags],
    ['religion', province.religion, religion[province.id] as number, DATA.provinceDicts[FIELD['religion']] as string[]],
    ['culture', province.culture, culture[province.id] as number, DATA.provinceDicts[FIELD['culture']] as string[]],
  ];
  for (const [name, expected, index, dict] of checks) {
    const norm = (v: string | undefined): string | undefined => (v === '---' || v === '' ? undefined : v);
    let actual: string | undefined;
    if (index >= 0) {
      actual = name === 'owner' ? DATA.tags[resolveOwner(index)] : dict[index];
    }
    const a = norm(actual);
    const b = norm(expected);
    if (a === undefined && b === undefined) continue;
    compared += 1;
    const stat = perField.get(name) ?? { compared: 0, exact: 0 };
    stat.compared += 1;
    if (a === b) {
      exact += 1;
      stat.exact += 1;
    } else if (failures.length < 8) {
      failures.push(`${province.id}.${name}: packed=${a} save=${b}`);
    }
    perField.set(name, stat);
  }
}
console.log(`  compared ${compared.toLocaleString()} fields`);
for (const [name, stat] of perField) {
  console.log(
    `    ${name.padEnd(9)} ${stat.exact.toLocaleString()} / ${stat.compared.toLocaleString()}` +
      `  (${((stat.exact / stat.compared) * 100).toFixed(2)}%)`,
  );
}
if (failures.length) {
  console.log('  mismatches:');
  for (const f of failures) console.log(`     ${f}`);
  process.exitCode = 1;
}

// ------------------------------------------------------ 4. occupation peak ---
console.log('\n=== 4. occupation at the reported peak month ===');
{
  const controller = new Int16Array(MAX_ID).fill(-1);
  const ownerAt = new Int16Array(MAX_ID).fill(-1);
  const applyPeak = (field: number, id: number, value: number): void => {
    if (id <= 0 || id >= MAX_ID) return;
    if (field === FIELD['owner']) ownerAt[id] = value;
    else if (field === FIELD['controller']) controller[id] = value;
  };
  for (const row of DATA.provinceInit) applyPeak(row[1] as number, row[0] as number, row[2] as number);
  const limit = DATA.months[DATA.peak.month] as number;
  for (const row of DATA.provinceEvents) {
    if ((row[0] as number) > limit) break;
    applyPeak(row[2] as number, row[1] as number, row[3] as number);
  }
  const resolvePeak = (idx: number): number => {
    let cur = idx;
    for (const a of DATA.tagAlias) {
      if ((a[0] as number) === cur && (a[1] as number) <= limit) cur = a[2] as number;
    }
    return cur;
  };
  let occupied = 0;
  for (const id of DATA.provinceIds) {
    const o = ownerAt[id] as number;
    const c = controller[id] as number;
    if (o < 0 || c < 0) continue;
    if (resolvePeak(o) !== resolvePeak(c)) occupied += 1;
  }
  console.log(`  ${DATA.monthLabels[DATA.peak.month]}: packed replay says ${occupied}, server said ${DATA.peak.occupied}`);
  if (occupied !== DATA.peak.occupied) process.exitCode = 1;
}

// ------------------------------------------------------ 5. hatching rules -----
console.log('\n=== 5. hatching rules ===');
{
  const relField = (DATA.provinceFields as string[]).indexOf('religion');
  const culField = (DATA.provinceFields as string[]).indexOf('culture');
  const countryRelField = (DATA.countryFields as string[]).indexOf('religion');

  // (a) the bug that made the religion view stripe almost everything: country
  //     and province religion indices came from two different dictionaries.
  const provinceRelDict = JSON.stringify(DATA.provinceDicts[relField]);
  const countryRelDict = JSON.stringify(DATA.countryDicts[countryRelField]);
  const sharedDict = provinceRelDict === countryRelDict;
  console.log(`  religion dictionary shared by provinces and countries: ${sharedDict ? 'yes' : 'NO'}`);
  if (!sharedDict) process.exitCode = 1;

  // (b) culture must not hatch at all.
  const hasPrimaryCulture = (DATA.countryFields as string[]).includes('primary_culture');
  console.log(`  culture view hatching removed (no primary_culture in the data): ${hasPrimaryCulture ? 'NO' : 'yes'}`);
  if (hasPrimaryCulture) process.exitCode = 1;

  // (c) a rename must not look like an occupation, and must not repaint history.
  const aliasOf = (from: string): { ord: number; to: string } | undefined => {
    const i = DATA.tags.indexOf(from);
    const a = DATA.tagAlias.find((row) => row[0] === i);
    return a ? { ord: a[1] as number, to: DATA.tags[a[2] as number] as string } : undefined;
  };
  const mos = aliasOf('MOS');
  console.log(`  MOS alias: ${mos ? `${DATA.tags[0] ? '' : ''}at ordinal ${mos.ord} -> ${mos.to}` : 'MISSING'}`);
  if (!mos || mos.to !== 'RUS') process.exitCode = 1;
  const before = mos.ord - 1;
  const after = mos.ord;
  const colorAt = (tag: string, ord: number): string => {
    const idx = DATA.tags.indexOf(tag);
    let cur = idx;
    for (const a of DATA.tagAlias) {
      if ((a[0] as number) === cur && (a[1] as number) <= ord) cur = a[2] as number;
    }
    return DATA.tags[cur] as string;
  };
  console.log(`  colour token for province owned by MOS before the rename: ${colorAt('MOS', before)}`);
  console.log(`  colour token for province owned by MOS after  the rename: ${colorAt('MOS', after)}`);
  if (colorAt('MOS', before) !== 'MOS' || colorAt('MOS', after) !== 'RUS') process.exitCode = 1;

  // (d) the religion hatch must follow the user's rule, and *not* fire when the
  //     province faith already matches the faith physically present.
  const cRel = new Map<number, number>();
  // Country event rows are [ordinal, tagIdx, fieldIdx, valueIdx].
  for (const row of DATA.countryInit) {
    if ((row[1] as number) === countryRelField) cRel.set(row[0] as number, row[2] as number);
  }
  for (const row of DATA.countryEvents) {
    if ((row[2] as number) === countryRelField && (row[0] as number) <= saveOrdinal) {
      cRel.set(row[1] as number, row[3] as number);
    }
  }
  const latest = (idx: number): number => {
    let cur = idx;
    for (const a of DATA.tagAlias) if ((a[0] as number) === cur) cur = a[2] as number;
    return cur;
  };
  let match = 0;
  let mismatch = 0;
  let unknown = 0;
  for (const id of DATA.provinceIds) {
    const o = owner[id] as number;
    if (o < 0 || (seaSet as Set<number>).has(id)) continue;
    const provinceRel = religion[id] as number;
    if (provinceRel < 0) continue;
    const ownerRel = cRel.get(latest(o));
    if (ownerRel === undefined) { unknown += 1; continue; }
    if (ownerRel === provinceRel) match += 1;
    else mismatch += 1;
  }
  console.log(`  provinces whose faith matches the owner's state faith (no hatch): ${match.toLocaleString()}`);
  console.log(`  provinces whose faith differs (hatched):                         ${mismatch.toLocaleString()}`);
  console.log(`  provinces with no recorded state faith:                          ${unknown.toLocaleString()}`);
  // With the dictionary bug this number collapses towards zero.
  if (match < 300) {
    console.log('  !! too few matching provinces — the religion dictionaries have probably diverged again');
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------- 6. battles --------
console.log('\n=== 6. battle data ===');
{
  const keys = new Set<number>();
  let badProvince = 0;
  let badContribution = 0;
  const provinceSet = new Set(DATA.provinceIds);
  for (const row of DATA.battles) {
    keys.add(row[0] as number);
    if (!provinceSet.has(row[1] as number)) badProvince += 1;
    // Contribution is count + 0.3 x intensity, stored x100 -> 100..130.
    const contribution = row[2] as number;
    if (!(contribution >= 100 && contribution <= 130)) badContribution += 1;
  }
  console.log(`  ${DATA.battles.length.toLocaleString()} battles across ${keys.size} distinct months`);
  console.log(`  battles whose province is unknown: ${badProvince}`);
  console.log(`  battles with out-of-range contribution: ${badContribution}`);
  if (badProvince || badContribution) process.exitCode = 1;

  // The cumulative score is what the view normalises against.
  const totals = new Map<number, number>();
  let best = 0;
  for (const row of DATA.battles) {
    const total = (totals.get(row[1] as number) ?? 0) + (row[2] as number);
    totals.set(row[1] as number, total);
    if (total > best) best = total;
  }
  const constant = (DATA as unknown as { constants: { maxBattleScore: number } }).constants.maxBattleScore;
  console.log(`  cumulative max battle score: ${constant} (recomputed ${best})`);
  console.log(`  most-fought-over province: #${[...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]}`);
  if (constant !== best) {
    console.log('  !! the normalisation constant does not match the data');
    process.exitCode = 1;
  }
}

// ----------------------------------------------------- 7. rebels + final state --
console.log('\n=== 7. rebel control and the final frame ===');
{
  const ctlField = (DATA.provinceFields as string[]).indexOf('controller');
  const rebIdx = DATA.tags.indexOf('REB');
  console.log(`  REB tag index in the viewer data: ${rebIdx}`);

  // (a) Rebel control must never reach the viewer: EU4 leaves `controller=REB`
  //     in a province log for decades, which produced permanent red hatching.
  let rebelRows = 0;
  for (const row of DATA.provinceInit) {
    if ((row[1] as number) === ctlField && (row[2] as number) === rebIdx) rebelRows += 1;
  }
  for (const row of DATA.provinceEvents) {
    if ((row[2] as number) === ctlField && (row[3] as number) === rebIdx) rebelRows += 1;
  }
  console.log(`  controller assignments to REB reaching the viewer: ${rebelRows}`);
  if (rebelRows !== 0) {
    console.log('  !! rebels would be drawn as an occupier again');
    process.exitCode = 1;
  }

  // (b) The last frame must agree with the save's own controller field, which is
  //     what the appended corrections are for.
  const ctl = new Int16Array(MAX_ID).fill(-1);
  for (const row of DATA.provinceInit) {
    if ((row[1] as number) === ctlField) ctl[row[0] as number] = row[2] as number;
  }
  for (const row of DATA.provinceEvents) {
    if ((row[0] as number) > saveOrdinal) break;
    if ((row[2] as number) === ctlField) ctl[row[1] as number] = row[3] as number;
  }
  let compared = 0;
  let exact = 0;
  const bad: string[] = [];
  for (const province of doc.provinces().values()) {
    const packed = ctl[province.id] as number;
    const packedTag = packed >= 0 ? DATA.tags[packed] : '';
    const expected = province.controller === 'REB' ? '' : (province.controller ?? '');
    // Rebels are intentionally dropped, so `REB` compares as "no controller".
    const normalise = (v: string | undefined): string => (v === '---' ? '' : (v ?? ''));
    const a = normalise(packedTag);
    const b = normalise(expected);
    compared += 1;
    if (a === b) exact += 1;
    else if (bad.length < 6) bad.push(`${province.id} (${province.name}): viewer=${a || '-'} save=${b || '-'}`);
  }
  console.log(`  controller at ${doc.meta.date}: ${exact.toLocaleString()} / ${compared.toLocaleString()} match the save`);
  for (const line of bad) console.log(`     ${line}`);
  if (bad.length) {
    console.log('  !! the final frame disagrees with the save');
    process.exitCode = 1;
  }

  // (c) The institution rule, independent of the parser module.
  const progress = (arr: number[]): { embraced: number; embracing: number } => {
    let embraced = 0;
    while (embraced < arr.length && (arr[embraced] as number) >= 100) embraced += 1;
    const next = arr[embraced];
    return { embraced, embracing: next !== undefined && next > 0 && next < 100 ? embraced : -1 };
  };
  const cases: Array<[number[], number, number]> = [
    [[0, 100, 100, 0, 0, 0, 0, 0], 0, -1],
    [[100, 26, 100, 0, 0, 0, 0, 0], 1, 1],
    [[100, 100, 100, 100, 10, 0, 0, 0], 4, 4],
    [[100, 100, 100, 0, 0, 0, 0, 0], 3, -1],
    [[100, 100, 100, 89, 0, 0, 0, 0], 3, 3],
  ];
  let ruleOk = true;
  for (const [arr, embraced, embracing] of cases) {
    const got = progress(arr);
    if (got.embraced !== embraced || got.embracing !== embracing) ruleOk = false;
  }
  console.log(`  institution rule cases: ${ruleOk ? 'all 5 correct' : 'MISMATCH'}`);
  if (!ruleOk) process.exitCode = 1;
}

// ------------------------------------------------- 8. country faith over time --
console.log('\n=== 8. country religion timeline ===');
{
  const relField = (DATA.provinceFields as string[]).indexOf('religion');
  const religionDict = DATA.provinceDicts[relField] as string[];
  const cField = (DATA.countryFields as string[]).indexOf('religion');

  const faithAt = (ordinal: number): Map<number, number> => {
    const state = new Map<number, number>();
    for (const row of DATA.countryInit) {
      if ((row[1] as number) === cField) state.set(row[0] as number, row[2] as number);
    }
    for (const row of DATA.countryEvents) {
      if ((row[0] as number) > ordinal) break;
      if ((row[1] === undefined ? -1 : (row[2] as number)) === cField) {
        state.set(row[1] as number, row[3] as number);
      }
    }
    return state;
  };
  const startOrdinal = DATA.months[0] as number;
  const atStart = faithAt(startOrdinal);
  const protestantIdx = religionDict.indexOf('protestant');
  const reformedIdx = religionDict.indexOf('reformed');
  let protestantAtStart = 0;
  for (const value of atStart.values()) {
    if (value === protestantIdx || value === reformedIdx) protestantAtStart += 1;
  }
  console.log(`  Protestant/Reformed countries in 1444: ${protestantAtStart} (should be ~0)`);
  if (protestantAtStart > 3) {
    console.log('  !! the Reformation is being painted onto the start of the campaign');
    process.exitCode = 1;
  }

  // The faith at the save date must match the save's own scalar, compared per
  // *resolved* tag since a renamed tag's data lives on its successor.
  const latestOf = (tag: string): string => {
    const start = DATA.tags.indexOf(tag);
    if (start < 0) return tag;
    let cur = start;
    for (const a of DATA.tagAlias) if ((a[0] as number) === cur) cur = a[2] as number;
    return DATA.tags[cur] as string;
  };
  const atEnd = faithAt(saveOrdinal);
  const renamedFrom = new Set(DATA.tagAlias.map((a) => DATA.tags[a[0] as number] as string));
  let compared = 0;
  let exact = 0;
  const bad: string[] = [];
  for (const [tag, country] of doc.countries()) {
    const expected = country.scalars['religion'];
    if (typeof expected !== 'string' || !expected) continue;
    // A renamed-away tag's scalar is a leftover; its successor carries the truth.
    if (renamedFrom.has(tag)) continue;
    const tagIdx = DATA.tags.indexOf(latestOf(tag));
    if (tagIdx < 0) continue;
    const got = atEnd.get(tagIdx);
    compared += 1;
    if (got !== undefined && religionDict[got] === expected) exact += 1;
    else if (bad.length < 6) {
      bad.push(`${tag}: viewer=${got === undefined ? '-' : religionDict[got]} save=${expected}`);
    }
  }
  console.log(`  faith at ${doc.meta.date}: ${exact.toLocaleString()} / ${compared.toLocaleString()} match the save`);
  for (const line of bad) console.log(`     ${line}`);

  // A known conversion should land on its recorded date, not before.
  const sweden = DATA.tags.indexOf('SWE');
  const before = faithAt(parseGameDate('1526.3.1')!.ordinal).get(sweden);
  const after = faithAt(parseGameDate('1526.3.3')!.ordinal).get(sweden);
  const name = (v: number | undefined): string => (v === undefined ? '-' : (religionDict[v] as string));
  console.log(`  Sweden: 1526.3.1 -> ${name(before)}, 1526.3.3 -> ${name(after)} (converts 1526.3.2)`);
  if (name(before) !== 'catholic' || name(after) !== 'protestant') {
    console.log('  !! the dated conversion is not being applied on its date');
    process.exitCode = 1;
  }
}

// ------------------------------------------ 9. dynasty / HRE / power curves --
console.log('\n=== 9. dynasty, HRE and power curves ===');
{
  // --- dynasty ---
  const cDyn = (DATA.countryFields as string[]).indexOf('dynasty');
  const dynOf = new Map<number, number>();
  for (const row of DATA.countryEvents) {
    if ((row[2] as number) === cDyn && (row[0] as number) <= saveOrdinal) {
      dynOf.set(row[1] as number, row[3] as number);
    }
  }
  const dynNames = (DATA as unknown as { dynasties: string[] }).dynasties;
  console.log(`  dynasties known: ${dynNames.length}, countries with one at the save date: ${dynOf.size}`);
  const hab = DATA.tags.indexOf('HAB');
  console.log(`  Habsburg (HAB) dynasty: ${dynOf.has(hab) ? dynNames[dynOf.get(hab) as number] : 'MISSING'}`);
  if (dynOf.size < 200) {
    console.log('  !! too few countries resolved to a dynasty');
    process.exitCode = 1;
  }

  // --- HRE ---
  const hreInfo = (DATA as unknown as {
    hre: { emperor: number; emperorEvents: number[][]; electors: number[]; freeCities: number[]; capitals: number[][] };
  }).hre;
  console.log(
    `  HRE: ${hreInfo.emperorEvents.length} dated emperor changes, ` +
      `${hreInfo.electors.length} electors, ${hreInfo.freeCities.length} free cities`,
  );
  let emperorAtEnd = -1;
  for (const row of hreInfo.emperorEvents) {
    if ((row[0] as number) > saveOrdinal) break;
    emperorAtEnd = row[1] as number;
  }
  console.log(`  emperor at ${doc.meta.date}: ${DATA.tags[emperorAtEnd] ?? '?'} (save says ${doc.readSectionView('empire')?.string('emperor')})`);
  if (DATA.tags[emperorAtEnd] !== doc.readSectionView('empire')?.string('emperor')) {
    console.log('  !! the emperor timeline disagrees with the save');
    process.exitCode = 1;
  }

  const hreField = (DATA.provinceFields as string[]).indexOf('hre');
  const hreDict = DATA.provinceDicts[hreField] as string[];
  const yesIdx = hreDict.indexOf('yes');
  const hreState = new Int16Array(MAX_ID).fill(-1);
  for (const row of DATA.provinceInit) {
    if ((row[1] as number) === hreField) hreState[row[0] as number] = row[2] as number;
  }
  for (const row of DATA.provinceEvents) {
    if ((row[0] as number) > saveOrdinal) break;
    if ((row[2] as number) === hreField) hreState[row[1] as number] = row[3] as number;
  }
  let hreProvinces = 0;
  for (const id of DATA.provinceIds) if ((hreState[id] as number) === yesIdx) hreProvinces += 1;
  console.log(`  HRE provinces at the save date: ${hreProvinces}`);
  if (hreProvinces < 100) {
    console.log('  !! the HRE view would be almost empty');
    process.exitCode = 1;
  }

  // --- power curves ---
  const curves = (DATA as unknown as {
    curves: { tags: number[]; names: string[]; dev: number[][]; provinces: number[][] };
  }).curves;
  console.log(`  power curves: ${curves.tags.length} series x ${curves.dev[0]?.length ?? 0} months`);
  if (curves.tags.length !== 12 || (curves.dev[0]?.length ?? 0) !== DATA.months.length) {
    console.log('  !! curve shape is wrong');
    process.exitCode = 1;
  }
  // A rename must not split one country into two curves: every selected country
  // existed in 1444, so a series that starts at zero means its earlier half was
  // dropped (Venice -> Sardinia-Piedmont used to do exactly that).
  const zeroStarts = curves.names.filter((_, s) => ((curves.dev[s] as number[])[0] ?? 0) === 0);
  console.log(
    `  starts: ${curves.names.map((n, s) => `${n}=${(curves.dev[s] as number[])[0] ?? 0}`).join(' ')}`,
  );
  if (zeroStarts.length) {
    console.log(`  !! curves starting at zero development: ${zeroStarts.join(', ')}`);
    process.exitCode = 1;
  }
  // Russia should grow over the campaign, not shrink.
  const rusSlot = curves.names.indexOf('RUS');
  if (rusSlot >= 0) {
    const series = curves.dev[rusSlot] as number[];
    const first = series[0] as number;
    const last = series[series.length - 1] as number;
    console.log(`  RUS development: ${first.toLocaleString()} -> ${last.toLocaleString()}`);
    if (!(last > first)) {
      console.log('  !! the curve is not rising for the campaign winner');
      process.exitCode = 1;
    }
  }
}

void buildTimeline;
void resolveTag;
console.log(process.exitCode ? '\nFAILED' : '\nall player checks passed');
