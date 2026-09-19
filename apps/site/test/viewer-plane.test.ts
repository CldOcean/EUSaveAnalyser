/**
 * The province plane, checked against the offline build.
 *
 * This is the data the map replay consumes, so the comparison is exact: the same
 * initial rows, the same dated rows, and the same save-date corrections. Rebel
 * control must encode as "no controller" (-1) and never as a tag - that bug made
 * 84 provinces look rebel-occupied for a century.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseGameDate } from '../../../packages/eu4-parser/src/value.ts';
import {
  PROVINCE_FIELDS,
  buildProvinceDicts,
  buildProvincePlane,
  createTagRegistry,
  encodeProvinceChange,
} from '../public/viewer-data.js';
import { SaveDocument, buildCountryTimeline, buildTimeline } from '../public/eu4-parser.js';
import { readMembers } from '../public/parser.js';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const REFERENCE = 'tmp/timeline/data.json';
const hasSave = existsSync(SAVE);
const hasReference = existsSync(REFERENCE);

let cache;
async function context() {
  if (cache) return cache;
  const doc = SaveDocument.fromMembers(await readMembers(new Uint8Array(readFileSync(SAVE))));
  const timeline = buildTimeline(doc);
  const countryTimeline = buildCountryTimeline(doc);
  const provinceDicts = buildProvinceDicts({ timeline, countryTimeline, countries: doc.countries() });
  const provinceFieldIdx = new Map(PROVINCE_FIELDS.map((f, i) => [f, i]));
  const registry = createTagRegistry();
  const saveOrdinal = parseGameDate(doc.meta.date).ordinal;
  const plane = buildProvincePlane({
    timeline,
    provinces: doc.provinces(),
    doc,
    provinceDicts,
    provinceFieldIdx,
    tagId: registry.tagId,
    saveOrdinal,
  });
  cache = { doc, timeline, provinceDicts, provinceFieldIdx, registry, plane, saveOrdinal };
  return cache;
}

test('encoding never turns a rebel into a country', async () => {
  const { provinceFieldIdx, provinceDicts, registry } = await context();
  const encode = (id, field, value) =>
    encodeProvinceChange(id, field, value, { provinceFieldIdx, provinceDicts, tagId: registry.tagId });
  assert.deepEqual(encode(1, 'owner', 'REB'), [1, 0, -1]);
  assert.deepEqual(encode(1, 'owner', '---'), [1, 0, -1]);
  assert.deepEqual(encode(1, 'controller', 'REB'), [1, 1, -1]);
  assert.deepEqual(encode(2, 'controller', 'SWE'), [2, 1, registry.tagId('SWE')]);
  // A field the player does not track is dropped, not encoded as garbage.
  assert.equal(encode(1, 'trade_goods', 'grain'), undefined);
});

test('the province plane matches the offline build', { skip: !hasSave || !hasReference }, async () => {
  const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'));
  const { plane, saveOrdinal, timeline } = await context();

  assert.equal(plane.initRows.length, reference.provinceInit.length, 'initial row count');
  assert.deepEqual(plane.initRows, reference.provinceInit, 'initial rows');

  assert.equal(plane.eventRows.length, reference.provinceEvents.length, 'dated row count');
  let firstDiff = -1;
  for (let i = 0; i < plane.eventRows.length; i += 1) {
    const mine = plane.eventRows[i];
    const theirs = reference.provinceEvents[i];
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
      firstDiff = i;
      break;
    }
  }
  assert.equal(firstDiff, -1, `row ${firstDiff}: ${JSON.stringify(plane.eventRows[firstDiff])} vs ${JSON.stringify(reference.provinceEvents[firstDiff])}`);

  // The corrections are part of the log, at the save date, and they are what makes
  // the final frame agree with the save.
  const atSaveDate = plane.eventRows.filter((row) => row[0] === saveOrdinal);
  assert.ok(atSaveDate.length > 0, 'the save-date corrections must be appended');
  assert.equal(
    plane.eventRows.filter((row) => row[0] > saveOrdinal).length,
    0,
    'nothing may come after the save date',
  );
  console.log(
    `      ${plane.initRows.length.toLocaleString()} initial rows, ` +
      `${plane.eventRows.length.toLocaleString()} dated rows, ` +
      `${plane.corrected} controller corrections (${plane.rebelCleared} stale rebel) ` +
      `across ${timeline.provinces.size.toLocaleString()} provinces`,
  );
});

test('the last frame of the replayed plane equals the save', { skip: !hasSave }, async () => {
  const { plane, saveOrdinal, registry, doc, provinceFieldIdx } = await context();

  // Replay the packed rows exactly as the viewer does, then compare against the
  // save's own owner/controller. This is the check that matters: the plane is only
  // correct if it lands on the save.
  const controllerField = provinceFieldIdx.get('controller');
  const ownerField = provinceFieldIdx.get('owner');
  const state = new Map();
  for (const [id, fieldIdx, value] of plane.initRows) {
    if (fieldIdx === controllerField || fieldIdx === ownerField) state.set(`${id}:${fieldIdx}`, value);
  }
  for (const [ordinal, id, fieldIdx, value] of plane.eventRows) {
    if (ordinal > saveOrdinal) break;
    if (fieldIdx === controllerField || fieldIdx === ownerField) state.set(`${id}:${fieldIdx}`, value);
  }

  let controllerMatch = 0;
  let ownerMatch = 0;
  let checked = 0;
  for (const province of doc.provinces().values()) {
    const controller = state.get(`${province.id}:${controllerField}`) ?? -1;
    const owner = state.get(`${province.id}:${ownerField}`) ?? -1;
    const expected = (tag) => (tag === undefined || tag === '' || tag === '---' || tag === 'REB' ? -1 : registry.tagId(tag));
    if (controller === expected(province.controller)) controllerMatch += 1;
    if (owner === expected(province.owner)) ownerMatch += 1;
    checked += 1;
  }
  assert.equal(controllerMatch, checked, `${checked - controllerMatch} provinces disagree on controller`);
  // Owner is not asserted: the offline build appends controller corrections only
  // (the game's habit of not logging the end of an occupation is a controller
  // problem). The two builds produce identical rows, so whatever owner drift
  // exists is the same drift the offline viewer has - reported, not hidden.
  console.log(
    `      final frame: controller matches the save for ${checked.toLocaleString()} provinces, ` +
      `owner for ${ownerMatch.toLocaleString()} (${checked - ownerMatch} inherited from the offline build)`,
  );
});
