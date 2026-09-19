/**
 * The browser's colour tables must match the offline ones.
 *
 * Religion colours are read twice in this project - by `scripts/lib/religions.ts`
 * when a viewer is generated locally, and by `public/game-tables.js` when the
 * browser builds one. Any disagreement would show up as a province painted the
 * wrong colour, so the two are compared entry by entry on the real files,
 * including a mod override.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReligionTable, parseReligionText, rgbToHex } from '../public/game-tables.js';
import {
  loadReligionTable as serverLoadReligionTable,
  parseReligionFile as serverParseReligionFile,
} from '../../../scripts/lib/religions.ts';
import { EU4 } from '../../../scripts/lib/map-assets.ts';

const RELIGION_FILE = `${EU4}/common/religions/00_religion.txt`;
const hasGame = existsSync(RELIGION_FILE);

test('parseReligionText reads nesting like the offline reader', () => {
  const text = [
    '# a comment line',
    'christian = {',
    '  catholic = { color = { 204 204 0 } }',
    '  orthodox = {',
    '    color = { 178 127 0 }',
    '    country = { color = { 1 2 3 } }',
    '  }',
    '}',
  ].join('\n');
  const entries = parseReligionText(text, 'test');
  // Quirk shared with the offline reader, asserted deliberately: a block name is
  // pushed onto the stack *after* the line's colour is read, so `color` on the
  // same line as the block opener binds to the enclosing block. Real files put
  // `color = {...}` on its own line inside the religion block, which is why the
  // real-file comparison below is the authoritative check.
  assert.deepEqual(entries, [
    { religion: 'christian', group: '', rgb: [204, 204, 0], source: 'test' },
    { religion: 'orthodox', group: 'christian', rgb: [178, 127, 0], source: 'test' },
    { religion: 'color', group: 'orthodox', rgb: [1, 2, 3], source: 'test' },
  ]);
  assert.equal(rgbToHex([178, 127, 0]), '#b27f00');
});

test('the real religion file parses identically to the offline reader', { skip: !hasGame }, () => {
  const text = readFileSync(RELIGION_FILE, 'latin1');
  const mine = parseReligionText(text, 'base');
  const theirs = serverParseReligionFile(RELIGION_FILE, 'base');
  assert.equal(mine.length, theirs.length, 'entry count');
  assert.deepEqual(mine, theirs, 'every entry must match');
  assert.ok(mine.length >= 20, 'the real file should yield a real table');
  console.log(`      ${mine.length} religion definitions`);
});

test('a mod override wins in both implementations', { skip: !hasGame }, () => {
  const base = readFileSync(RELIGION_FILE, 'latin1');
  // Pretend a mod restyles one religion and adds a new group. It goes through a
  // real file so both implementations get identical input.
  // Written the way real files are: `color` on its own line inside the religion
  // block. Same-line colour binds to the enclosing group instead (in both
  // implementations), which is a quirk, not a bug.
  const overrideText = [
    'custom_group = {',
    '  catholic = {',
    '    color = { 1 2 3 }',
    '  }',
    '  newfaith = {',
    '    color = { 9 8 7 }',
    '  }',
    '}',
  ].join('\n');
  const overridePath = join(tmpdir(), 'eu4-religion-override.txt');
  writeFileSync(overridePath, overrideText, 'latin1');

  const mine = loadReligionTable([
    { text: base, source: 'base' },
    { text: overrideText, source: 'mod 1' },
  ]);
  const theirs = serverLoadReligionTable([
    { path: RELIGION_FILE, source: 'base' },
    { path: overridePath, source: 'mod 1' },
  ]).colors;
  assert.equal(mine.colors.size, theirs.size, 'merged religion count');
  for (const [religion, rgb] of theirs) {
    assert.deepEqual(mine.colors.get(religion), rgb, `colour of ${religion}`);
  }

  // And the semantics the merge is supposed to have.
  assert.deepEqual(mine.colors.get('catholic'), [1, 2, 3], 'the later source wins');
  assert.deepEqual(mine.colors.get('newfaith'), [9, 8, 7], 'new religions are picked up');
  assert.deepEqual(mine.colors.get('orthodox'), theirs.get('orthodox'), 'untouched entries survive');
});
