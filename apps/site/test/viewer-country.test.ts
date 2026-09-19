/**
 * The country plane, checked against the offline build.
 *
 * Religion and dynasty are the two places where a plausible-looking shortcut is
 * wrong: seeding every country from the save's current faith paints the
 * Reformation into 1444, and letting a renamed tag keep its own timeline lets a
 * stale entry overwrite its successor (Bavaria turning Catholic again).
 *
 * The province plane is built first, deliberately: it is what hands out tag
 * indices, so skipping it would shift every index in the rows below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseGameDate } from '../../../packages/eu4-parser/src/value.ts';
import {
  COUNTRY_FIELDS,
  PROVINCE_FIELDS,
  buildCountryDicts,
  buildCountryPlane,
  buildProvinceDicts,
  buildProvincePlane,
  createTagRegistry,
} from '../public/viewer-data.js';
import {
  SaveDocument,
  buildCountryTimeline,
  buildTagAliases,
  buildTimeline,
  countryScalar,
  resolveTagLatest,
} from '../public/eu4-parser.js';
import { readMembers } from '../public/parser.js';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const REFERENCE = 'tmp/timeline/data.json';
const hasSave = existsSync(SAVE);
const hasReference = existsSync(REFERENCE);

let cache;
async function context() {
  if (cache) return cache;
  const doc = SaveDocument.fromMembers(await readMembers(new Uint8Array(readFileSync(SAVE))));
  const countries = doc.countries();
  const timeline = buildTimeline(doc);
  const countryTimeline = buildCountryTimeline(doc);
  const aliases = buildTagAliases(doc);

  const provinceDicts = buildProvinceDicts({ timeline, countryTimeline, countries });
  const provinceFieldIdx = new Map(PROVINCE_FIELDS.map((f, i) => [f, i]));
  const registry = createTagRegistry();
  const saveOrdinal = parseGameDate(doc.meta.date).ordinal;
  const campaignStartOrdinal = parseGameDate(timeline.campaignStart ?? doc.meta.date).ordinal;

  // Tag indices are handed out in this order offline, so the order is reproduced.
  buildProvincePlane({
    timeline,
    provinces: doc.provinces(),
    doc,
    provinceDicts,
    provinceFieldIdx,
    tagId: registry.tagId,
    saveOrdinal,
  });

  const countryDicts = buildCountryDicts({ provinceDicts, countryTimeline });
  const countryFieldIdx = new Map(COUNTRY_FIELDS.map((f, i) => [f, i]));
  const plane = buildCountryPlane({
    countryTimeline,
    countries,
    aliases,
    countryDicts,
    countryFieldIdx,
    tagId: registry.tagId,
    resolveTagLatest,
    campaignStartOrdinal,
    saveOrdinal,
  });

  cache = { doc, countries, timeline, countryTimeline, aliases, registry, plane, saveOrdinal, campaignStartOrdinal, countryDicts, countryFieldIdx };
  return cache;
}

test('the country plane matches the offline build row for row', { skip: !hasSave || !hasReference }, async () => {
  const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'));
  const { plane, countryTimeline, countryDicts } = await context();

  assert.equal(plane.eventRows.length, reference.countryEvents.length, 'row count');
  let firstDiff = -1;
  for (let i = 0; i < plane.eventRows.length; i += 1) {
    if (JSON.stringify(plane.eventRows[i]) !== JSON.stringify(reference.countryEvents[i])) {
      firstDiff = i;
      break;
    }
  }
  assert.equal(
    firstDiff,
    -1,
    `row ${firstDiff}: ${JSON.stringify(plane.eventRows[firstDiff])} vs ${JSON.stringify(reference.countryEvents[firstDiff])}`,
  );

  // The offline build keeps `countryInit` empty on purpose: initials are dated
  // rows like any other, so nothing may be seeded outside the log.
  assert.equal(reference.countryInit.length, 0, 'the offline build seeds no country initials');
  console.log(
    `      ${plane.eventRows.length.toLocaleString()} country rows from ` +
      `${countryTimeline.countries.size.toLocaleString()} country histories, ` +
      `${plane.corrected} save-date corrections, ` +
      `religion dict ${countryDicts.get('religion').dict.length} / dynasty dict ${countryDicts.get('dynasty').dict.length}`,
  );
});

test('a renamed tag never writes over its successor', { skip: !hasSave }, async () => {
  const { plane, aliases, registry, countries } = await context();
  const renamedFrom = new Set(aliases.map((a) => a.from));
  assert.ok(renamedFrom.size > 0, 'this save must contain a rename, or the test proves nothing');

  // Every row must be filed under a *surviving* tag. If a predecessor ever wrote a
  // row, its stale value would land in the successor's slot and win on ties.
  const written = new Set(plane.eventRows.map((row) => registry.list[row[1]]));
  const strays = [...written].filter((tag) => renamedFrom.has(tag));
  assert.deepEqual(strays, [], `${strays.length} predecessors wrote rows: ${strays.slice(0, 5).join(', ')}`);

  // ...and the successor really did inherit, otherwise the rule is untested here.
  const inherited = [...renamedFrom].filter((from) => registry.index.has(resolveTagLatest(aliases, from)));
  assert.ok(inherited.length > 0, 'at least one predecessor must resolve to a tag the plane knows');

  // A country that carries a faith must have been written under its successor's
  // tag. (Registry presence alone proves nothing: owning a province is enough to
  // enter the tag table, with no country history at all.)
  const unfiled = [];
  for (const [tag, country] of countries) {
    if (renamedFrom.has(tag)) continue;
    if (!countryScalar(country, 'religion')) continue;
    const latest = resolveTagLatest(aliases, tag);
    if (!written.has(latest)) unfiled.push(`${tag}->${latest}`);
  }
  assert.deepEqual(unfiled, [], `countries with a faith and no religion row: ${unfiled.slice(0, 5).join(', ')}`);
});

test('the Reformation is not painted into 1444, and the save date matches the save', { skip: !hasSave }, async () => {
  const { plane, registry, aliases, countryDicts, countryFieldIdx, campaignStartOrdinal, saveOrdinal, doc } =
    await context();
  const religionField = countryFieldIdx.get('religion');
  const religionDict = countryDicts.get('religion').dict;

  // Replay religion exactly like the viewer: rows are sorted, later wins.
  const start = new Map();
  const final = new Map();
  for (const [ordinal, tagIdx, fieldIdx, valueIdx] of plane.eventRows) {
    if (fieldIdx !== religionField) continue;
    final.set(tagIdx, valueIdx);
    if (ordinal <= campaignStartOrdinal) start.set(tagIdx, valueIdx);
  }

  let protestants = 0;
  for (const valueIdx of start.values()) {
    const name = religionDict[valueIdx];
    if (name === 'protestant' || name === 'reformed') protestants += 1;
  }
  assert.ok(protestants <= 2, `1444 should show at most a couple of Protestants, found ${protestants}`);

  // At the save date the plane must agree with the save's own scalar for every
  // country that has one.
  const renamedFrom = new Set(aliases.map((a) => a.from));
  let matched = 0;
  let checked = 0;
  const mismatches = [];
  for (const [tag, country] of doc.countries()) {
    if (renamedFrom.has(tag)) continue;
    const value = countryScalar(country, 'religion');
    if (typeof value !== 'string' || value === '') continue;
    const tagIdx = registry.index.get(resolveTagLatest(aliases, tag));
    if (tagIdx === undefined) continue;
    checked += 1;
    if (religionDict[final.get(tagIdx)] === value) matched += 1;
    else if (mismatches.length < 5) mismatches.push(`${tag}: plane=${religionDict[final.get(tagIdx)]} save=${value}`);
  }
  assert.ok(checked > 300, `expected many countries with a faith, got ${checked}`);
  assert.equal(matched, checked, `religion disagrees for: ${mismatches.join('; ')}`);
  assert.equal(
    plane.eventRows.filter((row) => row[0] > saveOrdinal).length,
    0,
    'nothing may come after the save date',
  );
  console.log(
    `      1444: ${protestants} Protestant/Reformed of ${start.size} known; ` +
      `save date: ${matched}/${checked} match the save`,
  );
});
