/**
 * The subject ledger: who is whose subject, since when, and what does not count.
 *
 * The three colour modes stand on this. Two properties matter and are asserted on the
 * real save rather than on a fixture, because both are properties of the game's format:
 * every live relation carries the date it began, and a tributary is not a subjection —
 * 朝贡国 keep their own colour, which is exactly what the user asked for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SaveDocument, countryScalar } from '../src/document.ts';
import { NON_SUBJECT_TYPES, isSubjectType, readSubjectLedger } from '../src/subjects.ts';

const SAVE = fileURLToPath(new URL('../../../存档示例/mp_俄罗斯1574_11_12.eu4', import.meta.url));
const hasSave = existsSync(SAVE);

test('tributaries are not subjects', () => {
  // The user's rule, spelled out: 朝贡国 do not count as 属国, and the religious
  // tributaries (`nahuatl_tributary`) are still tributaries.
  assert.equal(isSubjectType('vassal'), true);
  assert.equal(isSubjectType('personal_union'), true);
  assert.equal(isSubjectType('integrated_personal_union'), true);
  assert.equal(isSubjectType('crown_colony'), true);
  assert.equal(isSubjectType('march'), true);
  assert.equal(isSubjectType('tributary_state'), false);
  assert.equal(isSubjectType('nahuatl_tributary'), false);
  assert.equal(isSubjectType('mayan_tributary'), false);
  assert.equal(isSubjectType('trade_league'), false);
  assert.equal(isSubjectType(undefined), false);
  assert.ok(NON_SUBJECT_TYPES.has('tributary_state'));
});

test('the ledger reads every live relation, with its start date', { skip: !hasSave }, async () => {
  const doc = await SaveDocument.fromFile(SAVE);
  const ledger = readSubjectLedger(doc);

  assert.ok(ledger.relations.size > 0, 'the sample save has subjects');
  const tributaries = [...ledger.types.keys()].filter((type) => type.includes('tributary'));
  assert.ok(tributaries.length > 0, `the sample save should carry tributaries, saw: ${[...ledger.types.keys()].join(' ')}`);

  // Nothing tributary-shaped may be treated as a subject…
  for (const [tag, relation] of ledger.relations) {
    assert.equal(isSubjectType(relation.type), true, `${tag} (${relation.type}) must not be a subject`);
    // …and every subjection must carry the date it began, or the colour modes could
    // not start a subject's colour at the right frame.
    assert.equal(typeof relation.ordinal, 'number', `${tag} should have a usable start_date`);
    assert.ok(relation.overlord.length > 0 && relation.subject === tag);
  }
  // The excluded list holds exactly the tributaries, and it is not empty.
  assert.ok(ledger.excluded.length > 0, 'the sample save has tributaries');
  for (const relation of ledger.excluded) {
    assert.ok(
      relation.type.includes('tributary') || NON_SUBJECT_TYPES.has(relation.type),
      `${relation.type} was excluded but does not look like a tributary`,
    );
  }

  // The ledger must agree with the countries block, which states the end state.
  for (const [tag, relation] of ledger.relations) {
    const country = doc.countries().get(tag);
    if (!country) continue;
    const stated = countryScalar(country, 'overlord');
    assert.equal(stated, relation.overlord, `${tag}'s overlord should agree with countries/${tag}/overlord`);
  }

  console.log(
    `      ${ledger.relations.size} subject relation(s), ${ledger.excluded.length} tributary relation(s); ` +
      `types: ${[...ledger.types.entries()].map(([type, n]) => `${type}=${n}`).join(' ')}`,
  );
});
