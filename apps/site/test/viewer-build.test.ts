/**
 * The whole browser data plane, checked against the offline file.
 *
 * `viewer-build.js` re-implements ~900 lines of `scripts/render-timeline.ts` in the
 * browser: palettes, the HRE log, power curves, battles, tech and institution
 * snapshots, the raster, and the constants the painter reads. Nothing there is
 * verifiable by inspection — the only honest check is the real reference file, key
 * by key. Anything that cannot be compared exactly is reported, not asserted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EU4, MOD_LOCALISATION, WORKSHOP_ROOT } from '../../../scripts/lib/map-assets.ts';
import { countryGroup, countryScalar } from '../../../packages/eu4-parser/src/document.ts';
import { SUBJECT_SHADE, deltaE, isPlaceholderColour } from '../../../packages/eu4-parser/src/colours.ts';
import { readSubjectLedger } from '../../../packages/eu4-parser/src/subjects.ts';
import { UI_NAME_FAMILIES } from '../../../packages/eu4-parser/src/details.ts';
import { buildGameMap, downscaleIds } from '../public/game-data.js';
import { loadLocalisation, localise } from '../public/game-localisation.js';
import { loadReligionTable } from '../public/game-tables.js';
import { buildViewerData } from '../public/viewer-build.js';
import { SaveDocument } from '../public/eu4-parser.js';
import { readMembers } from '../public/parser.js';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const REFERENCE = 'tmp/timeline/data.json';
const UI_TABLES = 'apps/site/public/assets/ui';
const BMP = `${EU4}/map/provinces.bmp`;
const CSV = `${EU4}/map/definition.csv`;
const MAP = `${EU4}/map/default.map`;
const hasGame = existsSync(BMP) && existsSync(CSV) && existsSync(MAP);
const hasSave = existsSync(SAVE);
const hasReference = existsSync(REFERENCE);
const hasUiTables = existsSync(`${UI_TABLES}/uiNames.json`) && existsSync(`${UI_TABLES}/provinceTerrain.json`);

/** The static tables the detail panels read, as raw text — the browser path's input. */
function uiTables() {
  const read = (name: string): string | undefined => {
    const path = `${UI_TABLES}/${name}`;
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };
  return {
    uiNames: read('uiNames.json'),
    provinceTerrain: read('provinceTerrain.json'),
    area: read('area.json'),
    advisorIds: read('advisorIds.json'),
    ledgerSlots: read('ledgerSlots.json'),
    manaSlots: read('manaSlots.json'),
  };
}

/** The same religion sources, in the same order, as the offline script. */
function religionSources() {
  const sources = [{ text: readFileSync(`${EU4}/common/religions/00_religion.txt`, 'utf8'), source: 'base' }];
  for (const dir of existsSync(WORKSHOP_ROOT) ? readdirSync(WORKSHOP_ROOT) : []) {
    const folder = join(WORKSHOP_ROOT, dir, 'common', 'religions');
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder)) {
      if (file.endsWith('.txt')) {
        sources.push({ text: readFileSync(join(folder, file), 'utf8'), source: `mod ${dir}` });
      }
    }
  }
  return sources;
}

let cache;
async function context() {
  if (cache) return cache;
  const doc = SaveDocument.fromMembers(await readMembers(new Uint8Array(readFileSync(SAVE))));

  const map = buildGameMap({
    definitionCsv: new Uint8Array(readFileSync(CSV)),
    defaultMap: new Uint8Array(readFileSync(MAP)),
    provincesBmp: new Uint8Array(readFileSync(BMP)),
  });

  const localisationFiles = [
    join(MOD_LOCALISATION, 'text_l_english.yml'),
    join(MOD_LOCALISATION, 'countries_l_english.yml'),
  ]
    .filter((path) => existsSync(path))
    .map((path) => ({ text: readFileSync(path, 'utf8'), source: path }));
  const names = loadLocalisation(localisationFiles);
  const officialReligions = loadReligionTable(religionSources()).colors;

  const built = buildViewerData({
    doc,
    map: { ids: map.ids, width: map.width, height: map.height, unmatched: map.unmatched },
    water: map.water,
    localise: (key) => localise(names, key),
    officialReligions,
    scale: 1,
    // Exactly what `viewer-store.js` hands the page after fetching the same files.
    uiTables: uiTables(),
  });

  cache = { doc, map, built, names, officialReligions };
  return cache;
}

/** First index at which two arrays disagree, or -1. */
function firstDiff(mine, theirs) {
  for (let i = 0; i < Math.max(mine.length, theirs.length); i += 1) {
    if (JSON.stringify(mine[i]) !== JSON.stringify(theirs[i])) return i;
  }
  return -1;
}

test('the browser data plane equals the offline data.json', { skip: !hasSave || !hasReference || !hasGame }, async () => {
  const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'));
  const { built } = await context();
  const data = built.data;

  // Same keys, no more and no less: a missing key is a view that cannot be drawn.
  assert.deepEqual(Object.keys(data).sort(), Object.keys(reference).sort(), 'top-level keys');

  const mismatched = [];
  for (const key of Object.keys(reference)) {
    const mine = data[key];
    const theirs = reference[key];
    if (JSON.stringify(mine) === JSON.stringify(theirs)) continue;
    if (Array.isArray(theirs)) {
      mismatched.push(`${key} differs at index ${firstDiff(mine, theirs)} (${mine.length} vs ${theirs.length})`);
    } else {
      mismatched.push(`${key} differs`);
    }
  }
  assert.deepEqual(mismatched, [], `keys that do not match: ${mismatched.join('; ')}`);

  console.log(
    `      all ${Object.keys(reference).length} keys match: ` +
      `${data.tags.length.toLocaleString()} tags, ${data.provinceEvents.length.toLocaleString()} province rows, ` +
      `${data.countryEvents.length.toLocaleString()} country rows, ${data.battles.length.toLocaleString()} battles, ` +
      `${data.curves.names.length} curves × ${data.months.length.toLocaleString()} months`,
  );
});

test('the detail tables: province extras, terrain and the country panel wave 1', { skip: !hasSave || !hasReference || !hasGame }, async () => {
  const { built } = await context();
  const data = built.data;
  const tagOf = (index: number) => data.tags[index];

  // ---- the province sub-blocks `extractProvince()` used to drop --------------
  const buildingRows = data.provinceBuildings.rows;
  const buildingBuilders = data.provinceBuildings.builders;
  const buildingAt = buildingRows.findIndex((row) => row[0] === 1);
  assert.ok(buildingAt >= 0, 'province 1 must have buildings');
  assert.deepEqual(
    buildingRows[buildingAt].slice(1).map((index: number) => data.provinceBuildings.dict[index]),
    // The dictionary is sorted, so the row is in alphabetical key order, not in the
    // order the save wrote the block.
    ['marketplace', 'shipyard', 'temple', 'workshop'],
    'province 1 buildings (the phase-1 acceptance anchor)',
  );
  assert.deepEqual(buildingBuilders[buildingAt], ['SWE', 'DAN', 'SWE', 'RUS'], 'who paid for province 1');
  assert.equal(data.provinceBuildings.rows.length, 1573, 'provinces with buildings');
  assert.equal(data.provinceBuildings.dict.length, 32, 'distinct building keys');

  const claimRow = data.provinceClaims.rows.find((row: number[]) => row[0] === 2);
  assert.ok(claimRow, 'province 2 must have claims');
  assert.ok(
    claimRow.slice(1).map(tagOf).includes('RUS'),
    `province 2 claims should include RUS, got ${claimRow.slice(1).map(tagOf).join(',')}`,
  );
  const coreRow = data.provinceCores.rows.find((row: number[]) => row[0] === 1);
  assert.ok(coreRow, 'province 1 must have cores');
  assert.deepEqual(coreRow.slice(1).map(tagOf), ['RUS', 'SWE'], 'cores are sorted tag indices');

  const greatProjectAt = data.provinceGreatProjects.rows.findIndex((row: number[]) => row[0] === 8);
  assert.ok(greatProjectAt >= 0, 'province 8 must have a great project');
  assert.equal(
    data.provinceGreatProjects.dict[data.provinceGreatProjects.rows[greatProjectAt][1]],
    'falun_copper_mine',
  );
  assert.ok(data.provinceGreatProjects.names.includes('法伦铜矿') || data.provinceGreatProjects.names.some((n: string) => n.length > 0), 'great projects carry Chinese names');

  const latentRow = data.provinceLatentTradeGoods.rows.find((row: number[]) => row[0] === 62);
  assert.ok(latentRow, 'province 62 must have a latent trade good');
  assert.equal(data.provinceLatentTradeGoods.dict[latentRow[1]], 'coal');
  const tradeGoodRow = data.provinceTradeGoods.rows.find((row: number[]) => row[0] === 2);
  assert.ok(tradeGoodRow, 'province 2 must have a trade good');
  assert.equal(data.provinceTradeGoods.dict[tradeGoodRow[1]], 'grain');
  // Every province block carries `trade_goods` (sea tiles included), unlike the `trade`
  // node, which only 3369 of them have.
  assert.equal(data.provinceTradeGoods.rows.length, 4941, 'provinces with a trade good');

  const improveRow = data.provinceImprove.rows.find((row: number[]) => row[0] === 1);
  assert.ok(improveRow, 'province 1 must record infrastructure expansion');
  assert.equal(tagOf(improveRow[1]), 'SWE', 'province 1 was expanded by Sweden');
  assert.equal(improveRow[2], 5, 'province 1 expansion count');

  assert.equal(data.provinceTradeCompany[131], 1, 'province 131 is in a trade company');
  assert.equal(
    data.provinceTradeCompany.reduce((total: number, flag: number) => total + flag, 0),
    155,
    'trade-company provinces',
  );
  assert.equal(
    data.provinceDevastation.filter((value: number) => value > 0).length,
    529,
    'provinces with devastation',
  );
  assert.ok(data.provinceDevastation.length > 4941, 'devastation is indexed by province id');

  // ---- the static tables (provinceTerrain / area / uiNames) -------------------
  if (hasUiTables) {
    const terrainOf = (id: number) => {
      const index = data.provinceTerrain.byId[id];
      return index >= 0 ? data.provinceTerrain.dict[index] : '';
    };
    const terrainName = (id: number) => {
      const index = data.provinceTerrain.byId[id];
      return index >= 0 ? data.provinceTerrain.names[index] : '';
    };
    // The three provinces the phase book measured: 1 = 草原, 4 = 森林, 6 = 农田.
    assert.equal(terrainOf(1), 'grasslands');
    assert.equal(terrainName(1), '草原');
    assert.equal(terrainOf(4), 'forest');
    assert.equal(terrainName(4), '森林');
    assert.equal(terrainOf(6), 'farmlands');
    assert.equal(terrainName(6), '农田');
    assert.equal(data.provinceTerrain.byId.filter((index: number) => index >= 0).length, 3358);

    const areaOf = (id: number) => {
      const index = data.provinceArea.byId[id];
      return index >= 0 ? data.provinceArea.dict[index] : '';
    };
    const areaName = (id: number) => {
      const index = data.provinceArea.byId[id];
      return index >= 0 ? data.provinceArea.names[index] : '';
    };
    assert.equal(areaOf(1), 'ostra_svealand_area');
    assert.ok(areaName(1).length > 0, `the area name must be translated, got "${areaName(1)}"`);
    // Keyed by the area's index, which is what the client has after provinceArea.byId.
    const area = data.areaDetail[String(data.provinceArea.byId[1])];
    assert.ok(area, 'the province panel needs the state table for province 1');
    const stateTag = tagOf(area.states[0].tagIdx);
    assert.equal(stateTag, 'RUS', 'in this campaign Stockholm\u2019s area is a Russian state');
    assert.ok(area.states[0].prosperity > 0, 'prosperity comes from map_area_data');
    assert.ok(data.countryDetail[stateTag], 'a state holder is always a country with provinces');

    const investEntries = Object.entries(data.areaDetail as Record<string, { investments: { tagIdx: number; icons: string[] }[] }>)
      .filter(([, entry]) => entry.investments.length > 0);
    assert.equal(investEntries.length, 18, 'areas with trade-company investments');
    const investment = investEntries[0][1].investments[0];
    assert.ok(tagOf(investment.tagIdx).length >= 2, 'an investor is a real tag');
    assert.ok(investment.icons.length > 0, 'the investment icons come from map_area_data');
  } else {
    console.log('      !! assets/ui tables are missing: terrain / area / names are empty');
  }

  // ---- the country panel's wave 1 --------------------------------------------
  const tags = Object.keys(data.countryDetail);
  assert.equal(tags.length, 273, 'only countries that own a province get an entry');
  assert.deepEqual(tags, [...tags].sort(), 'countryDetail keys are sorted');
  const rus = data.countryDetail.RUS;
  assert.ok(rus, 'RUS must be in countryDetail');
  assert.equal(rus.government, 'russian_monarchy');
  assert.equal(rus.governmentRank, 3);
  assert.deepEqual(rus.tech, [12, 13, 13]);
  assert.deepEqual(rus.powers, [10, 141, 45]);
  assert.ok(Math.abs(rus.prestige - 84) < 0.5, `prestige ${rus.prestige}`);
  assert.ok(Math.abs(rus.corruption - 1.17) < 0.05, `corruption ${rus.corruption}`);
  assert.ok(Math.abs(rus.armyTradition - 65) < 1, `army tradition ${rus.armyTradition}`);
  assert.ok(Math.abs(rus.navyTradition - 30) < 1, `navy tradition ${rus.navyTradition}`);
  assert.ok(Math.abs(rus.inflation - 2.7) < 0.1, `inflation ${rus.inflation}`);
  assert.equal(rus.mercantilism, 100);
  assert.equal(rus.cities, 373);
  assert.equal(rus.governmentStrengthKind, 'legitimacy');
  assert.ok(Math.abs(rus.governmentStrength - 89) < 1, `government strength ${rus.governmentStrength}`);
  // The save never records absolutism: the panel shows `—`, not a fabricated 0.
  assert.equal(rus.absolutism, null, 'absolutism is absent from this save');
  // §1.3's diplomacy fields, which the phase-1 acceptance list checks by name.
  assert.deepEqual(rus.subjects, ['RIG', 'VOL', 'SME']);
  assert.deepEqual(rus.rivals, ['FRA', 'GBR', 'PER']);
  assert.deepEqual(rus.atWar, ['PER', 'GBR']);
  assert.ok(Math.abs(rus.sailors - 14887) < 5, `sailors ${rus.sailors}`);
  assert.ok(Math.abs(rus.manpower - 97) < 1, `manpower ${rus.manpower}`);
  assert.deepEqual(rus.army, [131, 1, 32, 12], 'infantry / cavalry / artillery / mercenary');
  assert.deepEqual(rus.navy, [22, 20, 3, 30], 'heavy / light / galley / transport');
  assert.deepEqual(rus.envoys, { merchants: 10, colonists: 0, diplomats: 5, missionaries: 3 });
  assert.equal(rus.religion, 'orthodox');
  assert.equal(rus.primaryCulture, 'russian');
  assert.equal(rus.religionDev.orthodox, 1584, 'religion development is dev-weighted');
  assert.ok(rus.monarch && rus.monarch.dynasty.length > 0, 'the current monarch must be resolved');
  assert.equal(rus.monarch.inaugurated, '1573.9.12');
  assert.ok(rus.rulers.length > 5, `RUS rulers: ${rus.rulers.length}`);
  assert.equal(rus.rulers[rus.rulers.length - 1].end, '', 'the reigning monarch has no end date');
  assert.ok(rus.leaders.length > 5, `RUS leaders: ${rus.leaders.length}`);
  assert.ok(rus.bestGeneral && rus.bestGeneral.kind === 'general', 'a best general is picked from active leaders');
  assert.equal(rus.ideas.length, 4);
  assert.ok(rus.ideas.every((idea: { total: number }) => idea.total === 7), 'idea groups have 7 pips');
  assert.ok(rus.history.length > 50, `RUS history rows: ${rus.history.length}`);
  assert.ok(
    rus.history.some((row: { kind: string }) => row.kind === 'capital'),
    'the history log carries capital moves',
  );
  assert.ok(
    rus.history.some((row: { kind: string }) => row.kind === 'warStart'),
    'the history log carries war starts',
  );
  assert.ok(
    rus.cultureStats.every((stat: { group: string }) => stat.group === ''),
    'culture groups are not in the save, so they stay empty rather than being invented',
  );
  console.log(
    `      detail tables: ${data.provinceBuildings.dict.length} building keys, ${data.provinceBuildings.rows.length} provinces with buildings, ` +
      `${data.provinceClaims.rows.length} with claims, ${data.provinceGreatProjects.rows.length} great projects, ` +
      `${data.provinceTerrain.byId.filter((i: number) => i >= 0).length} with terrain, ${Object.keys(data.areaDetail).length} areas, ` +
      `${tags.length} countries (${rus.history.length} history rows for RUS)`,
  );
});

test('the country panel wave 2: buildings, states, estates, crownland, advisors', { skip: !hasSave || !hasReference || !hasGame }, async () => {
  const { built, doc } = await context();
  const data = built.data;
  const CJK = /[\u3400-\u9fff]/;
  const rus = data.countryDetail.RUS;
  assert.ok(rus, 'RUS must be in countryDetail');

  // ---- 建筑：从各省 buildings 按拥有国现算（不碰 num_of_buildings_indexed） ----
  // Cross-checked against the parser's own province table plus the plane's building
  // rows: the same buildings, counted along a different path.
  const buildingRow = new Map<number, number[]>();
  for (const row of data.provinceBuildings.rows) buildingRow.set(row[0], row);
  const tally = new Map<string, number>();
  for (const province of doc.provinces().values()) {
    if (province.owner !== 'RUS') continue;
    const row = buildingRow.get(province.id);
    if (!row) continue;
    for (const index of row.slice(1)) {
      const key = data.provinceBuildings.dict[index];
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  assert.deepEqual(
    [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    rus.buildingCount.map((entry: { building: string; provinces: number }) => [entry.building, entry.provinces]),
    'the panel total must equal the provinces\u2019 own buildings',
  );
  // The three the phase-2 acceptance list names.
  assert.deepEqual(
    rus.buildingCount.slice(0, 3).map((entry: { building: string }) => entry.building),
    ['workshop', 'temple', 'fort_15th'],
  );
  assert.deepEqual(
    rus.buildingCount.slice(0, 3).map((entry: { provinces: number }) => entry.provinces),
    [99, 83, 22],
  );
  const counted = rus.buildingCount.reduce((total: number, entry: { provinces: number }) => total + entry.provinces, 0);
  assert.equal(counted, 258, 'RUS owns 258 buildings');

  // ---- 州 ----
  assert.equal(rus.states.length, 106, 'RUS holds 106 areas');
  const capitalProvince = 1777; // `countries/RUS/capital` in this save
  const capitalArea = (() => {
    const raw = JSON.parse(readFileSync(`${UI_TABLES}/area.json`, 'utf8')) as { byId: Record<string, string> };
    return raw.byId[String(capitalProvince)];
  })();
  const capitalStates = rus.states.filter((state: { capitalState: boolean }) => state.capitalState);
  assert.equal(capitalStates.length, 1, 'exactly one capital state');
  assert.equal(capitalStates[0].area, capitalArea, 'the capital state is the capital province\u2019s area');
  assert.ok(capitalStates[0].dev > 0, 'the capital state has development');
  for (const state of rus.states) {
    assert.ok(data.provinceArea.dict.includes(state.area), `${state.area} must be a real area key`);
    assert.ok(CJK.test(state.name), `${state.area} must have a Chinese name, got "${state.name}"`);
    assert.ok(state.dev > 0, `${state.area} must have development`);
    assert.ok(
      ['', 'prospering', 'declining'].includes(state.prosperityMode),
      `${state.area} has prosperityMode "${state.prosperityMode}"`,
    );
    assert.ok(state.prosperity >= 0 && state.prosperity <= 100, `${state.area} prosperity ${state.prosperity}`);
  }

  // ---- 阶级与王室领地 ----
  assert.deepEqual(
    rus.estates.map((estate: { kind: string }) => estate.kind),
    ['estate_church', 'estate_nobles', 'estate_burghers', 'estate_cossacks'],
    'the estate kind is the save\u2019s own key, which is how uiNames.estates is keyed',
  );
  const church = rus.estates[0];
  assert.ok(Math.abs(church.loyalty - 80.554) < 0.01, `church loyalty ${church.loyalty}`);
  assert.ok(Math.abs(church.territory - 16.015) < 0.01, `church territory ${church.territory}`);
  assert.equal(church.agendas, 2);
  assert.ok(church.privileges.length >= 4, 'the church holds privileges');
  assert.ok(/^\d+\.\d+\.\d+$/.test(church.privileges[0].since), `privilege date ${church.privileges[0].since}`);
  assert.ok(church.influences.length >= 1, 'the church has an influence modifier');
  assert.ok(church.influences[0].expires.includes('.'), 'an influence carries its expiry');
  // The three lookups the 阶级 cards need must actually resolve — this is the contract
  // between this plane's keys and S2's tables.
  assert.equal(data.uiNames.estates[church.kind], '教士');
  assert.ok(
    church.privileges.every((entry: { name: string }) => data.uiNames.estatePrivileges[entry.name]),
    `every privilege needs a name: ${church.privileges.map((entry: { name: string }) => `${entry.name}=${data.uiNames.estatePrivileges[entry.name]}`).join(' ')}`,
  );
  assert.ok(
    church.influences.every((entry: { name: string }) => data.uiNames.estateInfluenceModifiers[entry.name]),
    `every influence needs a name: ${church.influences.map((entry: { name: string }) => `${entry.name}=${data.uiNames.estateInfluenceModifiers[entry.name]}`).join(' ')}`,
  );
  // 王室领地 = 100 − Σ 领地占比, the only definition the save supports.
  const territory = rus.estates.reduce((total: number, estate: { territory: number }) => total + estate.territory, 0);
  assert.ok(Math.abs(rus.crownland - (100 - territory)) < 0.01, `crownland ${rus.crownland} vs ${100 - territory}`);
  assert.ok(Math.abs(rus.crownland - 37.23) < 0.01, `RUS crownland ${rus.crownland}`);

  // ---- 名臣顾问 ----
  // This campaign barely rolled any: 10 of 273 countries, and RUS is not one of them —
  // the panel shows its "no great advisors" line rather than an empty grid.
  assert.deepEqual(rus.advisors, [], 'RUS never triggered a great advisor in this save');
  const spi = data.countryDetail.SPI;
  assert.ok(spi.advisors.length >= 5, `SPI triggered ${spi.advisors.length} advisors`);
  for (const advisor of spi.advisors) {
    assert.ok(CJK.test(advisor.name), `${advisor.id} must have a Chinese name, got "${advisor.name}"`);
    assert.ok(/^\d+\.\d+\.\d+$/.test(advisor.date), `${advisor.id} date ${advisor.date}`);
  }
  assert.deepEqual(
    data.countryDetail.FRA.advisors.map((advisor: { id: string }) => advisor.id),
    ['statesman', 'natural_scientist'],
  );

  // ---- coverage, so a regression in any roll-up is loud ----
  const countries = Object.keys(data.countryDetail);
  const withStates = countries.filter((tag) => data.countryDetail[tag].states.length > 0).length;
  const withEstates = countries.filter((tag) => data.countryDetail[tag].estates.length > 0).length;
  const withAdvisors = countries.filter((tag) => data.countryDetail[tag].advisors.length > 0).length;
  const withBuildings = countries.filter((tag) => data.countryDetail[tag].buildingCount.length > 0).length;
  assert.deepEqual([withStates, withEstates, withAdvisors, withBuildings], [273, 210, 10, 263]);
  assert.deepEqual(data.countryDetail.C00.estates, [], 'a country without estates gets an empty list, not a missing key');
  console.log(
    `      wave 2: RUS ${rus.buildingCount.length} building kinds / ${counted} buildings, ${rus.states.length} states, ` +
      `${rus.estates.length} estates (crownland ${rus.crownland}%), ${rus.advisors.length} great advisors; ` +
      `save-wide states=${withStates} estates=${withEstates} advisors=${withAdvisors} buildings=${withBuildings}`,
  );
});

test('the country panel wave 3: budget and mana, slot by slot', { skip: !hasSave || !hasReference || !hasGame }, async () => {
  const { built } = await context();
  const data = built.data;

  // ---- the slot name tables (S2's enumeration, baked once for the plane) ----
  assert.equal(data.ledgerSlots.income.length, 19, '19 income slots');
  assert.equal(data.ledgerSlots.expense.length, 38, '38 expense slots');
  assert.equal(data.manaSlots.length, 46, '46 mana slots');
  assert.deepEqual(data.ledgerSlots.income[0], { key: 'taxation', name: '税收' });
  assert.deepEqual(data.ledgerSlots.expense[0], { key: 'advisor_maintenance', name: '顾问维护' });
  assert.equal(data.manaSlots[7].name, '发展省份');
  for (const slot of [...data.ledgerSlots.income, ...data.ledgerSlots.expense, ...data.manaSlots]) {
    assert.ok(slot && typeof slot.key === 'string' && typeof slot.name === 'string', 'every slot is { key, name }');
  }

  const rus = data.countryDetail.RUS;
  assert.deepEqual(
    rus.budget.periods.map((entry: { period: string }) => entry.period),
    ['last-month', 'ytd', 'last-year'],
    'the three intervals the panel switches between',
  );
  for (const entry of rus.budget.periods) {
    assert.equal(entry.income.length, 19, `${entry.period} income is 19 slots`);
    assert.equal(entry.expense.length, 38, `${entry.period} expense is 38 slots`);
    for (const value of [...entry.income, ...entry.expense]) {
      assert.ok(Number.isFinite(value), `${entry.period} carries a finite number (got ${value})`);
    }
    assert.ok(
      Math.abs(entry.net - (entry.incomeTotal - entry.expenseTotal)) < 0.001,
      `${entry.period} net is income − expense`,
    );
  }
  assert.equal(rus.budget.totalExpense.length, 38, 'the all-time expense table has 38 slots');
  assert.equal(rus.budget.totalExpense.filter((value: number) => value > 0).length > 10, true);

  // The save records its own last-month totals, so the array sum is checkable against it.
  assert.ok(Math.abs(rus.budget.periods[0].incomeTotal - 190.176) < 0.001, `last month income ${rus.budget.periods[0].incomeTotal}`);
  assert.ok(Math.abs(rus.budget.periods[0].expenseTotal - 205.612) < 0.001, `last month expense ${rus.budget.periods[0].expenseTotal}`);
  assert.ok(Math.abs(rus.budget.periods[0].income[2] - 104.401) < 0.001, 'trade is slot 2');
  assert.ok(Math.abs(rus.budget.periods[1].income[0] - 313.34) < 0.001, 'ytd taxation');
  assert.ok(Math.abs(rus.budget.periods[2].income[0] - 364.621) < 0.001, 'last year taxation');
  assert.ok(Math.abs(rus.budget.recurringIncome - 190.176) < 0.001, 'the recurring-income scalar');
  assert.ok(Math.abs(rus.budget.recurringExpense - 205.612) < 0.001, 'the recurring-expense scalar');

  // ---- mana: dense 46-slot arrays, and every slot a real number ----
  for (const [label, series] of [['adm', rus.manaSpent.adm], ['dip', rus.manaSpent.dip], ['mil', rus.manaSpent.mil]] as const) {
    assert.equal(series.length, 46, `${label} has 46 slots`);
    // The maps are sparse in the save, so a missing slot must read 0 — an `undefined`
    // here is exactly the bug that turned every total into NaN.
    assert.ok(series.every((value: number) => typeof value === 'number' && Number.isFinite(value)), `${label} slots are all finite`);
  }
  assert.equal(rus.manaSpent.adm[0], 5775, 'buy_idea');
  assert.equal(rus.manaSpent.adm[1], 4463, 'advance_tech');
  assert.equal(rus.manaSpent.adm[17], 6309, 'core province');
  assert.equal(rus.manaSpent.dip[0], 2667);
  assert.equal(rus.manaSpent.mil[1], 7526);
  const sum = (series: number[]) => series.reduce((total, value) => total + value, 0);
  assert.equal(sum(rus.manaSpent.adm), 18131);
  assert.equal(sum(rus.manaSpent.dip), 10417);
  assert.equal(sum(rus.manaSpent.mil), 11859);

  // ---- coverage ----
  const countries = Object.keys(data.countryDetail);
  const withBudget = countries.filter((tag) => data.countryDetail[tag].budget.periods[1].incomeTotal > 0).length;
  const withMana = countries.filter((tag) => {
    const spent = data.countryDetail[tag].manaSpent;
    return spent.adm.some((value: number) => value > 0) || spent.dip.some((value: number) => value > 0) || spent.mil.some((value: number) => value > 0);
  }).length;
  assert.equal(countries.length, 273);
  assert.ok(withBudget >= 260, `only ${withBudget}/273 countries carry a ledger`);
  assert.ok(withMana >= 265, `only ${withMana}/273 countries spent mana`);
  console.log(
    `      wave 3: RUS last month ${rus.budget.periods[0].incomeTotal}/${rus.budget.periods[0].expenseTotal}, ` +
      `ytd ${rus.budget.periods[1].incomeTotal}/${rus.budget.periods[1].expenseTotal}, ` +
      `mana ${sum(rus.manaSpent.adm)}/${sum(rus.manaSpent.dip)}/${sum(rus.manaSpent.mil)}; ` +
      `save-wide ledger=${withBudget} mana=${withMana} of ${countries.length}`,
  );
});

test('the name table is baked into the plane, not fetched at run time', { skip: !hasSave || !hasReference || !hasGame }, async () => {
  const { built } = await context();
  const data = built.data;
  const uiNames = data.uiNames;
  const CJK = /[\u3400-\u9fff]/;

  // 省份国家界面阶段任务书 §6.8.3: every frozen family exists even when S2's file has
  // nothing for it yet, so the client never has to guard for a missing family.
  for (const family of UI_NAME_FAMILIES) {
    assert.ok(
      uiNames[family] && typeof uiNames[family] === 'object' && !Array.isArray(uiNames[family]),
      `uiNames.${family} must exist`,
    );
  }
  for (const [family, entries] of Object.entries(uiNames as Record<string, Record<string, string>>)) {
    for (const [key, name] of Object.entries(entries)) {
      assert.ok(typeof name === 'string' && name.length > 0, `${family}.${key} must be a non-empty name`);
    }
  }

  // The two shapes the panel indexes directly.
  assert.equal(data.cultureNames.length, data.cultures.length, 'one culture name per dictionary slot');
  for (let i = 0; i < data.cultures.length; i += 1) {
    assert.equal(
      data.cultureNames[i],
      uiNames.cultures[data.cultures[i]] ?? '',
      `cultureNames[${i}] (${data.cultures[i]})`,
    );
  }
  assert.deepEqual(data.personalityNames, uiNames.personalities, 'personalityNames is the personality map');

  // The families the phase-1.5 acceptance depends on are populated from the mod (and
  // therefore Chinese). A family S2 has not published yet is reported, not asserted,
  // because it is S2's deliverable — but a family that IS published must not be mostly
  // untranslated: that would mean the keys changed shape and the panel would fall back
  // to raw game keys.
  assert.ok(Object.keys(uiNames.religions).length > 0, 'religions must be named');
  assert.ok(CJK.test(uiNames.religions.orthodox ?? ''), 'religion names must be Chinese');
  assert.ok(CJK.test(uiNames.buildings.marketplace ?? ''), 'building names must be Chinese');
  assert.ok(CJK.test(uiNames.governmentReforms.tsardom ?? ''), 'government reform names must be Chinese');
  const cultureGap = Object.keys(uiNames.cultures).length;
  if (cultureGap > 0) {
    const translated = data.cultureNames.filter((name: string) => CJK.test(name)).length;
    assert.ok(
      translated >= data.cultureNames.length * 0.8,
      `only ${translated}/${data.cultureNames.length} cultures are translated — the table's keys probably changed shape`,
    );
  }
  const personalityCount = Object.keys(uiNames.personalities).length;
  if (personalityCount > 0) {
    assert.ok(
      Object.values(uiNames.personalities).every((name) => CJK.test(name as string)),
      'personality names must be Chinese',
    );
  }
  console.log(
    `      uiNames: ${Object.entries(uiNames as Record<string, Record<string, string>>)
      .map(([family, entries]) => `${family}=${Object.keys(entries).length}`)
      .join(' ')}; cultureNames ${data.cultureNames.filter((name: string) => CJK.test(name)).length}/${data.cultureNames.length}`,
  );
  if (cultureGap === 0) console.log('      !! uiNames.cultures is empty — S2 has not published it yet (§6.8.2)');
  if (personalityCount === 0) console.log('      !! uiNames.personalities is empty — S2 has not published it yet (§6.8.2)');
});

test('the ruler flags are split out of the personality traits', { skip: !hasSave || !hasGame }, async () => {
  // 第四对话任务书 §4.1 交付 1: `personalities` and `ruler_flags` are two different blocks of
  // a character record. Merging them is what put English event keys (`me_flag_*`,
  // `has_lowborn_consort`) into the panel's 性格 column (§2.2).
  const { built } = await context();
  const data = built.data;
  const countries = Object.keys(data.countryDetail);
  let people = 0;
  let flags = 0;
  let traits = 0;
  const flagKeys = new Set<string>();
  for (const tag of countries) {
    const record = data.countryDetail[tag];
    const characters = [...record.rulers, ...record.failedHeirs, ...(record.monarch ? [record.monarch] : [])];
    for (const person of characters) {
      people += 1;
      assert.ok(Array.isArray(person.flags), `${tag}: every character needs a flags array`);
      assert.ok(Array.isArray(person.personalities), `${tag}: every character needs a personalities array`);
      // A key can only come out of one of the two blocks.
      for (const trait of person.personalities) {
        assert.ok(!person.flags.includes(trait), `${tag}: ${trait} appears in both blocks`);
      }
      for (const flag of person.flags) flagKeys.add(flag);
      flags += person.flags.length;
      traits += person.personalities.length;
    }
    for (const ruler of record.rulers) {
      assert.ok(
        !ruler.personalities.some((key: string) => key.startsWith('me_flag_') || key === 'has_lowborn_consort'),
        `${tag} ${ruler.name}: an event marker is still in personalities`,
      );
    }
  }
  assert.ok(people > 1000, `only ${people} characters — the save did not load properly`);
  assert.ok(flags > 0, 'the split must actually move flags out of personalities');
  assert.ok(traits > 0, 'the real traits must survive the split');
  // §2.2's two named examples must now be flags, not traits.
  assert.ok(
    [...flagKeys].some((key) => key === 'has_lowborn_consort' || key.startsWith('me_flag_')),
    'the event markers §2.2 named should be flags now',
  );
  console.log(`      flags split: ${people} characters, ${flags} flags (${flagKeys.size} distinct), ${traits} traits`);
});

test('the rankings block: two boards, meta coverage, the frozen formula', { skip: !hasSave || !hasGame }, async () => {
  // 第四对话任务书 §3.4/§3.5. The shape, the weights and the two exclusion rules are
  // frozen, so they are asserted here; the numbers themselves are checked against the
  // offline plane by the key-by-key test above.
  const { built } = await context();
  const rankings = built.data.rankings;
  assert.ok(rankings, 'the data plane must publish rankings');

  const meta = rankings.meta;
  assert.deepEqual(meta.weights.general, { skill: 0.45, war: 0.4, win: 0.15 }, 'general weights');
  assert.deepEqual(
    meta.weights.monarch,
    { ability: 0.35, tenure: 0.15, growth: 0.35, pace: 0.15 },
    'monarch weights',
  );
  assert.deepEqual(meta.floors, { minBattles: 3, minReignMonths: 60 }, 'floors');
  assert.ok(meta.coverage.commandedSides > 0, 'coverage: commanded sides');
  assert.ok(meta.coverage.joinedSides > 0, 'coverage: joined sides');
  assert.ok(
    meta.coverage.joinedSides <= meta.coverage.commandedSides,
    'the join cannot cover more sides than exist',
  );
  assert.ok(meta.coverage.tagsWithLeaders <= meta.coverage.resolvedTags, 'coverage: tags');
  assert.ok(meta.generalPool >= meta.generalQualified, 'the qualified generals are part of the pool');

  assert.equal(rankings.generals.length, 15, 'the general board is full for this save');
  assert.equal(rankings.monarchs.length, 15, 'the monarch board is full for this save');

  const generalKeys = [
    'tag', 'name', 'kind', 'fire', 'shock', 'maneuver', 'siege', 'skill',
    'battles', 'wins', 'winRate', 'kills', 'taken', 'net', 'score', 'parts',
  ].sort();
  const monarchKeys = [
    'tag', 'name', 'adm', 'dip', 'mil', 'stats', 'start', 'end', 'months',
    'devStart', 'devEnd', 'devGain', 'devPerYear', 'provincesGain', 'score', 'parts',
  ].sort();
  for (const general of rankings.generals) {
    assert.deepEqual(Object.keys(general).sort(), generalKeys, 'every general key is present');
    assert.deepEqual(Object.keys(general.parts).sort(), ['skill', 'war', 'win'], 'general parts');
    assert.ok(general.battles >= 3, `${general.name}: fewer than 3 battles reached the board`);
    assert.ok(general.wins <= general.battles, `${general.name}: more wins than battles`);
    assert.equal(general.net, general.kills - general.taken, `${general.name}: net`);
  }
  for (const monarch of rankings.monarchs) {
    assert.deepEqual(Object.keys(monarch).sort(), monarchKeys, 'every monarch key is present');
    assert.deepEqual(
      Object.keys(monarch.parts).sort(),
      ['ability', 'growth', 'pace', 'tenure'],
      'monarch parts',
    );
    // §2.4's three traps must never reach the board.
    assert.notEqual(monarch.name, '', 'a nameless placeholder reached the board');
    assert.ok(monarch.months >= 60, `${monarch.name}: a reign under 5 years reached the board`);
    assert.ok(
      monarch.stats > 0,
      `${monarch.name}: a 0/0/0 placeholder reached the board`,
    );
  }
  for (let i = 1; i < rankings.generals.length; i += 1) {
    assert.ok(rankings.generals[i - 1].score >= rankings.generals[i].score, 'generals are score-ordered');
  }
  for (let i = 1; i < rankings.monarchs.length; i += 1) {
    assert.ok(rankings.monarchs[i - 1].score >= rankings.monarchs[i].score, 'monarchs are score-ordered');
  }
  console.log(
    `      rankings: ${meta.coverage.commandedSides} commanded sides -> ${meta.coverage.joinedSides} joined, ` +
      `${meta.coverage.tagsWithLeaders}/${meta.coverage.resolvedTags} tags with leaders, ` +
      `general pool ${meta.generalPool} (${meta.generalQualified} qualified), monarch pool ${meta.monarchPool}`,
  );
});

test('the three panels render exactly the offline tables', { skip: !hasSave || !hasGame }, async () => {
  // The tables are no longer baked into the page: both hosts hand the client a
  // VIEWER_PANELS object (that is what lets one markup file serve both), so the
  // comparison is against that object. The rows carry army counts and institution
  // origins that no other view shows, which is what makes them worth pinning.
  const offline = readFileSync('tmp/timeline/index.html', 'utf8');
  const { built } = await context();

  const line = offline.split('\n').find((l) => l.startsWith('const VIEWER_PANELS = '));
  assert.ok(line, 'the offline page should publish VIEWER_PANELS');
  const offlinePanels = JSON.parse(line.slice('const VIEWER_PANELS = '.length).replace(/;$/, '')) as Record<string, string>;

  assert.ok(offlinePanels.leaders.includes('<tr>'), 'the offline leaderboard should have rows');
  assert.equal(built.panels.leaderHtml, offlinePanels.leaders, 'gross-power table');
  assert.equal(built.panels.cityHtml, offlinePanels.cities, 'development table');
  assert.equal(built.panels.institutionHtml, offlinePanels.institutions, 'institution origin table');

  // The markup must still carry the empty containers those rows go into. The two rankings'
  // bodies are in the same list although no VIEWER_PANELS string fills them: the client draws
  // them from DATA.rankings (第四对话任务书.md §4.3 C2), and they are empty in the markup.
  const tables = [...offline.matchAll(/<tbody id="([^"]+)"><\/tbody>/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['leaderBody', 'cityBody', 'institutionBody', 'generalBody', 'monarchBody']);

  // ...and the header facts the page prints around the map. The keys must match
  // viewer.html's data-fact attributes, or the page shows blanks.
  const header = built.panels.header;
  assert.equal(header.start, built.data.start);
  assert.equal(header.end, built.data.end);
  assert.equal(header.frames, built.data.months.length.toLocaleString());
  assert.equal(header.provinces, built.diagnostics.provinces.toLocaleString());
  assert.equal(header.width, built.raster.width);
  assert.equal(header.lastIndex, built.data.months.length - 1);
  assert.equal(header.seaHex, '#1a3454');
  const markup = readFileSync('apps/site/public/viewer.html', 'utf8');
  // The spans this header feeds. The frame / province / event counts are no longer printed:
  // the line under the heading names the archive's fields now (版本 / 结档日期 / 封档日期 /
  // 模组), and those four are resolved by each host from the record or the save's meta rather
  // than by viewer-build — so they are pinned in packages/eu4-parser/test/build-guards.test.ts
  // and filled at runtime in scripts/verify-player-run.ts, not here.
  for (const key of ['title', 'start', 'end']) {
    assert.ok(markup.includes(`data-fact="${key}"`), `viewer.html should show the ${key} fact`);
    assert.notEqual(header[key], undefined, `the header must define ${key}`);
  }
  // The counts stay in the object even though nothing prints them any more.
  for (const key of ['frames', 'provinces', 'events']) {
    assert.notEqual(header[key], undefined, `the header must still define ${key}`);
  }
  console.log(
    `      panels match: ${built.panels.leaders.length} powers (top ${built.panels.leaders[0]?.tag} ` +
      `${built.panels.leaders[0]?.score.toFixed(1)}), institutions from ${header.firstMonth} to ${header.end}`,
  );
});

test('the three colour modes: no colonial white, subjects close to their overlord', { skip: !hasSave || !hasGame }, async () => {
  const { built, doc } = await context();
  const data = built.data;
  const colours = data.colours;
  assert.ok(colours, 'the data plane must publish the colour table');

  const at = (tag: string) => data.tags.indexOf(tag);
  const rgb = (packed: number) => [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff] as [number, number, number];

  // 1. A country that owns land is never drawn in the engine's `255 255 255` placeholder.
  // Every colonial nation carries it in `color`, which is what painted the map white.
  const owners = new Set<string>();
  for (const province of doc.provinces().values()) if (province.owner) owners.add(province.owner);
  const white = [...owners].filter((tag) => at(tag) >= 0 && colours.original[at(tag)] === 0xffffff);
  assert.deepEqual(white, [], 'these own provinces but keep the placeholder colour');
  assert.ok(owners.size > 100, `only ${owners.size} owners found, the save did not load properly`);

  // 2. A colonial nation whose `color` is that placeholder takes a shade of its mother
  // country, as the engine derives it — and only from the mother country's *own* colour.
  const derived: string[] = [];
  for (const [tag, country] of doc.countries()) {
    const parent = countryScalar(country, 'colonial_parent');
    const index = at(tag);
    if (!parent || index < 0 || at(parent) < 0) continue;
    const recorded = countryGroup(country, 'colors')?.color?.trim().split(/\s+/).map(Number) ?? [];
    if (!isPlaceholderColour(recorded)) continue;
    derived.push(tag);
    const gap = deltaE(rgb(colours.original[index]), rgb(colours.original[at(parent)]));
    assert.ok(
      gap >= SUBJECT_SHADE.low - 1.5 && gap <= SUBJECT_SHADE.high + 1.5,
      `${tag} sits ${gap.toFixed(1)} ΔE from ${parent}'s own colour, outside ${SUBJECT_SHADE.low}–${SUBJECT_SHADE.high}`,
    );
  }
  assert.ok(derived.length > 0, 'this save should have placeholder-coloured colonial nations');

  // 3. 属国染色: every subject sits inside the band of its overlord's drawn colour, and
  // two subjects of one overlord do not collapse onto the same shade.
  const ledger = readSubjectLedger(doc);
  const families = new Map<string, string[]>();
  let checked = 0;
  for (const [tag, relation] of ledger.relations) {
    if (at(tag) < 0 || at(relation.overlord) < 0) continue;
    const gap = deltaE(rgb(colours.subject[at(tag)]), rgb(colours.mod[at(relation.overlord)]));
    assert.ok(
      gap >= SUBJECT_SHADE.low - 1.5 && gap <= SUBJECT_SHADE.high + 1.5,
      `${tag} sits ${gap.toFixed(1)} ΔE from ${relation.overlord}, outside ${SUBJECT_SHADE.low}–${SUBJECT_SHADE.high}`,
    );
    const members = families.get(relation.overlord) ?? [];
    members.push(tag);
    families.set(relation.overlord, members);
    checked += 1;
  }
  assert.ok(checked > 10, `only ${checked} relations checked`);
  for (const [overlord, members] of families) {
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const gap = deltaE(rgb(colours.subject[at(members[i]!)]), rgb(colours.subject[at(members[j]!)]));
        assert.ok(gap > 1, `${members[i]} and ${members[j]} of ${overlord} are only ${gap.toFixed(2)} ΔE apart`);
      }
    }
  }

  // 4. The foreign-tint flags: one per tag, and never contradicting "is a subject".
  // This save's mod list has no subject-colouring mod, so nothing is flagged — a save
  // that has one (西班牙1567 has 31) is covered by the browser at runtime.
  assert.equal(colours.foreignTint.length, data.tags.length, 'one foreign-tint flag per tag');
  assert.equal(
    colours.foreignTint.reduce((total: number, flag: number) => total + flag, 0),
    0,
    'no foreign tints in this save',
  );
  for (let i = 0; i < colours.foreignTint.length; i += 1) {
    if (colours.foreignTint[i]) assert.ok(colours.from[i] < 0, `${data.tags[i]} is flagged but follows an overlord`);
  }
  console.log(
    `      colour modes: ${derived.length} colonial nation(s) derived from their mother country, ` +
      `${checked} subject(s) inside ΔE ${SUBJECT_SHADE.low}–${SUBJECT_SHADE.high} of the overlord, ` +
      `${colours.foreignTint.length} foreign-tint flag(s)`,
  );
});

test('the raster is the same province-id image the offline build embedded', { skip: !hasSave || !hasGame }, async () => {
  const { built, map } = await context();
  assert.equal(built.raster.width, 5632);
  assert.equal(built.raster.height, 2048);
  assert.equal(built.raster.rgb.length, 5632 * 2048 * 3);

  // Spot-check the channel split against the decoded ids, then confirm the water
  // set really is the game's own list (the viewer needs both to look right).
  let idSamples = 0;
  for (let i = 0; i < built.raster.rgb.length; i += 3 * 4096) {
    const hi = built.raster.rgb[i];
    const lo = built.raster.rgb[i + 1];
    assert.equal(built.raster.rgb[i + 2], 0, 'the blue channel must stay empty');
    const j = i / 3;
    assert.equal((hi << 8) | lo, map.ids[j] ?? 0, `pixel ${j}`);
    idSamples += 1;
  }
  assert.ok(idSamples > 100, `sampled only ${idSamples} pixels`);
  console.log(
    `      raster ${built.raster.width}x${built.raster.height} px, ` +
      `${map.water.sea.size} sea + ${map.water.lakes.size} lake ids, ${map.unmatched} unmatched colours`,
  );
});

test('odd facts the build depends on, reported rather than asserted', { skip: !hasSave || !hasGame }, async () => {
  const { built } = await context();
  const d = built.diagnostics;
  // A country the curves cannot draw is a real risk (a rename once split Venice in
  // two), so it is printed loudly; equality is the other test's job.
  const zeroStarts = built.data.curves.names.filter((_, slot) => (built.data.curves.dev[slot]?.[0] ?? 0) === 0);
  console.log(
    `      ${d.provinces.toLocaleString()} provinces, ${d.events.toLocaleString()} events, ` +
      `${d.countries.toLocaleString()} countries, ${d.tags.toLocaleString()} tags, ${d.battles.toLocaleString()} battles`,
  );
  console.log(
    `      corrections: ${d.controllerCorrections} controllers (${d.rebelCleared} stale rebel), ` +
      `${d.countryCorrections} country faith; religions resolved: ${d.officialReligions} definitions`,
  );
  console.log(`      peak occupation: ${built.data.peak.occupied} provinces in ${built.data.monthLabels[built.data.peak.month]}`);
  if (zeroStarts.length) console.log(`      !! curves starting at zero: ${zeroStarts.join(', ')}`);
  assert.equal(zeroStarts.length, 0, `curves starting at zero: ${zeroStarts.join(', ')}`);
});
