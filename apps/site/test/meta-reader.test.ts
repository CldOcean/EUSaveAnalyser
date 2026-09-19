/**
 * The browser-side meta reader must agree with the Node parser.
 *
 * This is the whole safety net for `public/parser.js`: it reimplements zip
 * reading, raw inflate and the letter-stream decoder in plain browser JS, so the
 * only convincing test is to run both on the same real save and compare.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readSaveInfo, decodeLetterStream, readZipEntries, parseMeta } from '../public/parser.js';
import { SaveDocument } from '../../../packages/eu4-parser/src/document.ts';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const hasSave = existsSync(SAVE);

test('letter stream decoding matches the parser for CJK text', () => {
  // 三 is stored as marker 0x10 + the shifted code unit, per encoding.ts.
  const san = new Uint8Array([0x10, 0x09, 0x4e]);
  assert.equal(decodeLetterStream(san), '三');
  assert.equal(decodeLetterStream(new Uint8Array([0x41, 0x42])), 'AB');
  // A truncated escape degrades to single bytes instead of eating the quote.
  const truncated = new Uint8Array([0x10, 0x09, 0x22]);
  assert.equal(decodeLetterStream(truncated).length, 3);
});

test('the flat meta reader keeps keys, blocks and bare lists', () => {
  const meta = parseMeta('date=1574.11.12\nversions={\n\t"a"\n\t"b"\n}\nmods={\n{\nname="x"\n}\n}\n');
  assert.equal(meta.date, '1574.11.12');
  assert.deepEqual(meta.versions.$list, ['a', 'b']);
  assert.equal(meta.mods.$list[0].name, 'x');
});

test('reads the zip central directory of a real save', { skip: !hasSave }, () => {
  const bytes = new Uint8Array(readFileSync(SAVE));
  const names = readZipEntries(bytes).map((entry) => entry.name).sort();
  assert.deepEqual(names, ['ai', 'gamestate', 'meta'].sort());
});

test('browser reader and Node parser agree on the sample save', { skip: !hasSave }, async () => {
  const bytes = new Uint8Array(readFileSync(SAVE));
  const info = await readSaveInfo(bytes);
  const doc = await SaveDocument.fromFile(SAVE, { sections: [] });

  assert.equal(info.campaignDate, doc.meta.date, 'campaign date');
  assert.equal(info.playerTag, doc.meta.player, 'player tag');
  assert.equal(info.player, '俄罗斯', 'the letter-stream country name decodes to Chinese');
  assert.equal(info.player, doc.meta.displayedCountryName, 'displayed country name matches the parser');
  assert.equal(info.version, doc.meta.version?.text, 'version text');
  assert.equal(info.dlcCount, doc.meta.dlc.length, 'DLC count');
  assert.equal(info.mods?.length, doc.meta.mods.length, 'mod count');
  assert.equal(info.mods?.[0], doc.meta.mods[0]?.name, 'first mod name (plain UTF-8)');
  assert.ok(info.mods?.some((name) => name.includes('二次元')), 'CJK mod names survive');
});

test('a file that is not a zip is reported clearly', async () => {
  await assert.rejects(async () => readSaveInfo(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /zip/);
});
