/**
 * The data plane's foundation, checked against the offline build.
 *
 * Two things are compared here, and the difference matters:
 *
 *   * **Dictionaries** are sorted, so they are a property of the data - compared
 *     exactly, entry for entry, against `tmp/timeline/data.json`.
 *   * **Tag indices** are handed out in first-request order, which depends on the
 *     offline script's traversal. Comparing those arrays would be comparing an
 *     accident, so tags are compared *semantically*: same tag, same colour.
 *
 * Run `pnpm timeline` first: the reference data.json is the offline build's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { countryScalar } from '../../../packages/eu4-parser/src/document.ts';
import {
  PROVINCE_FIELDS,
  buildCountryDicts,
  buildProvinceDicts,
  countryColorOf,
  createTagRegistry,
} from '../public/viewer-data.js';
import { SaveDocument, buildCountryTimeline, buildTimeline } from '../public/eu4-parser.js';
import { readMembers } from '../public/parser.js';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const REFERENCE = 'tmp/timeline/data.json';
const hasSave = existsSync(SAVE);
const hasReference = existsSync(REFERENCE);

let cache;
async function context() {
  if (!cache) {
    const doc = SaveDocument.fromMembers(await readMembers(new Uint8Array(readFileSync(SAVE))));
    cache = { doc, timeline: buildTimeline(doc), countryTimeline: buildCountryTimeline(doc) };
  }
  return cache;
}

test('the field lists match the offline build', { skip: !hasReference }, () => {
  const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'));
  assert.deepEqual(reference.provinceFields, PROVINCE_FIELDS, 'provinceFields');
  assert.deepEqual(reference.countryFields, ['religion', 'dynasty'], 'countryFields');
});

test('province dictionaries match the offline build exactly', { skip: !hasSave || !hasReference }, async () => {
  const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'));
  const { doc, timeline, countryTimeline } = await context();
  const dicts = buildProvinceDicts({ timeline, countryTimeline, countries: doc.countries() });

  reference.provinceFields.forEach((field, fieldIndex) => {
    const mine = dicts.get(field).dict;
    const theirs = reference.provinceDicts[fieldIndex];
    assert.deepEqual(mine, theirs, `dictionary for ${field}`);
  });

  // The religion dictionary must be the shared one, i.e. it has to contain the
  // state religions too, not just the province religions.
  const religions = dicts.get('religion').dict;
  const countryReligions = new Set();
  for (const country of doc.countries().values()) {
    const own = countryScalar(country, 'religion');
    if (own) countryReligions.add(own);
  }
  const missing = [...countryReligions].filter((religion) => !religions.includes(religion));
  assert.deepEqual(missing, [], 'every country religion must exist in the shared dictionary');
  console.log(
    `      dictionaries compared: ${reference.provinceFields
      .map((field, i) => `${field}=${reference.provinceDicts[i].length}`)
      .join(' ')}`,
  );
});

test('country dictionaries match, religion being the shared one', { skip: !hasSave || !hasReference }, async () => {
  const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'));
  const { doc, timeline, countryTimeline } = await context();
  const provinceDicts = buildProvinceDicts({ timeline, countryTimeline, countries: doc.countries() });
  const dicts = buildCountryDicts({ provinceDicts, countryTimeline });

  reference.countryFields.forEach((field, fieldIndex) => {
    assert.deepEqual(dicts.get(field).dict, reference.countryDicts[fieldIndex], `dictionary for ${field}`);
  });
  assert.equal(dicts.get('religion'), provinceDicts.get('religion'), 'religion is the same object, not a copy');
});

test('every tag keeps its colour, whatever index it happens to get', { skip: !hasSave || !hasReference }, async () => {
  const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'));
  const { doc } = await context();
  const countries = doc.countries();

  const checked = [];
  for (const tag of ['RUS', 'HAB', 'FRA', 'ENG', 'CAS']) {
    const at = reference.tags.indexOf(tag);
    if (at < 0) continue;
    const theirs = reference.tagColors[at];
    const country = countries.get(tag);
    const mine = countryColorOf(country, tag, () => [0, 0, 0]);
    const packed = (mine[0] << 16) | (mine[1] << 8) | mine[2];
    assert.equal(packed, theirs, `colour of ${tag}`);
    checked.push(tag);
  }
  assert.ok(checked.length > 0, 'at least one great power should be in the reference tag table');
  // The registry assigns stable indices within one build.
  const registry = createTagRegistry();
  assert.equal(registry.tagId('RUS'), registry.tagId('RUS'));
  assert.equal(registry.list.length, 1);
  console.log(`      colours verified for ${checked.join(', ')}`);
});
