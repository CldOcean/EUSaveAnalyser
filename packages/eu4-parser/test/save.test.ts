/**
 * End-to-end regression test against the real sample save.
 *
 * The expected values below were independently verified against the game's own
 * files: `map/definition.csv`, the Chinese localisation shipped by the
 * "Chinese Language Mod for 1.37" workshop mod, and the mods' plain-UTF-8
 * sources. If this test fails, the parser has regressed — not the save.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SaveDocument, countryScalar, provinceIdFromKey } from '../src/document.ts';

const SAVE = fileURLToPath(
  new URL('../../../存档示例/mp_俄罗斯1574_11_12.eu4', import.meta.url),
);

/** Exact byte -> char mapping for assertions (`Uint8Array#toString` joins with commas). */
const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

const doc = await SaveDocument.fromFile(SAVE);

test('reads the ZIP container', () => {
  assert.deepEqual(doc.archive.names.sort(), ['ai', 'gamestate', 'meta']);
  const gamestate = doc.archive.entries.find((e) => e.name === 'gamestate');
  assert.ok(gamestate);
  assert.equal(gamestate!.method, 8, 'gamestate is deflate-compressed');
  assert.ok(doc.gamestate.length > 50_000_000, 'inflated gamestate is ~57 MB');
  assert.equal(ascii(doc.gamestate.subarray(0, 6)), 'EU4txt');
});

test('parses meta', () => {
  const meta = doc.meta;
  assert.equal(meta.date, '1574.11.12');
  assert.equal(meta.saveGame, '撒丁-皮埃蒙特1555_07_27.eu4', 'plain UTF-8 string');
  assert.equal(meta.player, 'RUS');
  assert.equal(meta.displayedCountryName, '俄罗斯', 'letter-stream string');
  assert.equal(meta.version.text, '1.37.5.0');
  assert.equal(meta.version.name, 'Inca');
  assert.equal(meta.multiPlayer, true);
  assert.equal(meta.campaignId, '2fd5d35e-f15c-43f5-944d-c2a55e9a4955');
  assert.equal(meta.campaignLength, 41666);
  assert.equal(meta.dlc.length, 22);
  assert.equal(meta.mods.length, 11);
  assert.ok(
    meta.mods.some((mod) => mod.name === 'Chinese Language Mod for 1.37'),
  );
  assert.ok(
    meta.mods.some((mod) => mod.name === '更好的字体（我最喜欢的筑紫圆体）'),
    'mod names are plain UTF-8',
  );
});

test('campaign stats decode including EU4 rich-text codes', () => {
  const stats = new Map(doc.meta.campaignStats.map((s) => [s.key, s]));
  assert.equal(stats.get('game_country')?.selector, 'RUS');
  assert.equal(stats.get('game_country')?.localization, '俄罗斯');
  assert.equal(stats.get('religion')?.localization, '东正教');
  assert.equal(stats.get('best_prov')?.localization, '威尼斯');
  assert.equal(stats.get('wars_won')?.value, 63);
  assert.equal(stats.get('army_kills')?.value, 1499077);
  const leader = stats.get('best_leader')?.localization ?? '';
  assert.ok(leader.startsWith('§G帕韦尔 列普宁§!'), leader);
  assert.ok(leader.includes('£military_view_icon_fire£'), 'icon codes survive');
});

test('indexes top-level sections including the brace-only spelling', () => {
  const countries = doc.section('countries');
  const provinces = doc.section('provinces');
  assert.ok(countries, 'countries section found');
  assert.ok(provinces, 'provinces section found');
  assert.equal(countries!.kind, 'block');
  assert.ok(countries!.size > 35_000_000, `countries is ~37 MB, got ${countries!.size}`);
  assert.ok(provinces!.size > 16_000_000, `provinces is ~17 MB, got ${provinces!.size}`);
  // `map_area_data{` omits the `=`; it must still be a normal section.
  const areas = doc.section('map_area_data');
  assert.ok(areas);
  assert.ok(areas!.size > 90_000);
  // Section boundaries must line up: `provinces` ends just before `countries`.
  const gap = countries!.start - provinces!.end;
  assert.ok(gap >= 0 && gap < 64, `expected provinces to end just before countries, gap=${gap}`);
  assert.equal(
    ascii(doc.gamestate.subarray(provinces!.end, countries!.start)),
    '\ncountries=',
    'the bytes between the two sections are exactly the next key',
  );
});

test('extracts every province with the negated-key convention', () => {
  const provinces = doc.provinces();
  assert.equal(provinces.size, 4941);
  assert.equal(Math.min(...provinces.keys()), 1);
  assert.equal(Math.max(...provinces.keys()), 4941);
});

test('province names match the game localisation', () => {
  const provinces = doc.provinces();
  assert.equal(provinces.get(1)?.name, '斯德哥尔摩');
  assert.equal(provinces.get(2)?.name, '东约特兰');
  assert.equal(provinces.get(151)?.name, '君士坦丁堡');
  assert.equal(provinces.get(295)?.name, '莫斯科');
  assert.equal(provinces.get(1836)?.name, '洛阳');
  assert.equal(provinces.get(2368)?.name, '卡拉门根');
});

test('province fields carry ownership, culture, religion and development', () => {
  const provinces = doc.provinces();
  const stockholm = provinces.get(1);
  assert.ok(stockholm);
  assert.equal(stockholm!.owner, 'RUS');
  assert.equal(stockholm!.controller, 'RUS');
  assert.equal(stockholm!.trade, 'baltic_sea');
  assert.equal(stockholm!.religion, 'protestant');
  assert.equal(stockholm!.culture, 'swedish');
  assert.equal(stockholm!.baseTax, 6);
  assert.equal(stockholm!.baseProduction, 5);
  assert.equal(stockholm!.baseManpower, 2);
  assert.equal(stockholm!.isCity, true);
  assert.ok(stockholm!.cores.includes('SWE'));
  assert.equal(stockholm!.institutions.length, 8);
});

test('extracts countries and resolves their capitals', () => {
  const countries = doc.countries();
  assert.equal(countries.size, 1380);

  const gbr = countries.get('GBR');
  assert.ok(gbr);
  assert.equal(countryScalar(gbr!, 'capital'), '236');
  assert.equal(doc.provinces().get(236)?.name, '伦敦');

  const cas = countries.get('CAS');
  assert.equal(countryScalar(cas!, 'capital'), '219');
  assert.equal(doc.provinces().get(219)?.name, '托雷多');

  const rus = countries.get('RUS');
  assert.ok(rus);
  assert.equal(countryScalar(rus!, 'religion'), 'orthodox');
  assert.equal(countryScalar(rus!, 'primary_culture'), 'russian');
  assert.equal(countryScalar(rus!, 'government_name'), 'russian_monarchy');
  assert.deepEqual(rus!.groups['technology'], {
    adm_tech: '12',
    dip_tech: '13',
    mil_tech: '13',
  });
});

test('country province counts are consistent with the province table', () => {
  const counts = new Map<string, number>();
  for (const province of doc.provinces().values()) {
    if (!province.owner || province.owner === '---') continue;
    counts.set(province.owner, (counts.get(province.owner) ?? 0) + 1);
  }
  assert.equal(counts.get('RUS'), 380);
  assert.equal(counts.get('SPI'), 144);
  assert.equal(counts.size, 273);
});

test('multiplayer player names decode correctly', () => {
  const snapshot = doc.snapshot({ sections: [] });
  const names = snapshot.players.map((p) => p.name);
  assert.ok(snapshot.players.length >= 10);
  assert.ok(names.includes('heckel '), 'plain ASCII nickname survives');
  assert.ok(
    names.some((name) => name.includes('赫尔茨奥·佩特拉沙皇')),
    'CJK nickname with the U+00B7 separator decodes',
  );
  assert.ok(
    names.some((name) => name.includes('披萨')),
    'CJK nickname with full-width brackets decodes',
  );
  assert.ok(
    names.some((name) => name.includes('霍亨索伦')),
    'CJK nickname containing a space decodes',
  );
  assert.equal(snapshot.stats.provinceCount, 4941);
  assert.equal(snapshot.stats.ownedProvinceCount, 2856);
  assert.equal(snapshot.stats.countryCount, 1380);
  assert.deepEqual(snapshot.warnings, []);
});

test('provinceIdFromKey accepts both the negated and the legacy spelling', () => {
  assert.equal(provinceIdFromKey('-1'), 1);
  assert.equal(provinceIdFromKey('-4941'), 4941);
  assert.equal(provinceIdFromKey('295'), 295);
  assert.equal(provinceIdFromKey('---'), undefined);
});

test('unknown sections and entities return undefined rather than throwing', () => {
  assert.equal(doc.section('no_such_section'), undefined);
  assert.equal(doc.readSection('no_such_section'), undefined);
  // `ZZZ` really is a placeholder country in EU4 saves; `QQQ` is not used.
  assert.equal(doc.countries().has('ZZZ'), true);
  assert.equal(doc.countryDetail('QQQ'), undefined);
  assert.equal(doc.provinceDetail(999_999), undefined);
});
