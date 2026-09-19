/**
 * Does the browser build of the parser agree with the Node parser?
 *
 * This is the test that makes a browser-side timeline possible: the bundle in
 * `public/eu4-parser.js` is generated from the same sources, so the only
 * convincing check is to run both on the same save and compare what they read -
 * including the parts the timeline depends on (province history, countries,
 * wars, tag renames).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readMembers } from '../public/parser.js';
import {
  SaveDocument as BrowserDocument,
  buildTimeline as browserTimeline,
  extractWars as browserWars,
  buildTagAliases as browserAliases,
  frameMonths as browserFrameMonths,
} from '../public/eu4-parser.js';
import {
  SaveDocument as NodeDocument,
} from '../../../packages/eu4-parser/src/document.ts';
import { buildTimeline, buildTagAliases } from '../../../packages/eu4-parser/src/timeline.ts';
import { extractWars } from '../../../packages/eu4-parser/src/wars.ts';

const SAVE = '存档示例/mp_俄罗斯1574_11_12.eu4';
const hasSave = existsSync(SAVE);

test('the browser bundle loads and exports the parser surface', () => {
  assert.equal(typeof BrowserDocument.fromMembers, 'function');
  assert.equal(typeof BrowserDocument.fromBuffer, 'function', 'fromBuffer stays available');
  assert.equal(typeof browserTimeline, 'function');
  assert.equal(typeof browserWars, 'function');
  assert.equal(typeof browserAliases, 'function');
  assert.equal(typeof browserFrameMonths, 'function');
});

test('the Node-only entry points fail with a usable message', async () => {
  // `fromFile` is async, so it rejects rather than throwing synchronously.
  await assert.rejects(BrowserDocument.fromFile('x.eu4'), /fromMembers/);
});

test('browser and Node parsers agree on the same save', { skip: !hasSave }, async () => {
  const bytes = new Uint8Array(readFileSync(SAVE));

  // Exactly the browser path: unpack with DecompressionStream, then fromMembers.
  const members = await readMembers(bytes);
  assert.ok(members.meta && members.gamestate, 'meta and gamestate must both inflate');
  const started = Date.now();
  const browser = BrowserDocument.fromMembers(members);
  const browserMs = Date.now() - started;

  const node = await NodeDocument.fromFile(SAVE, { sections: [] });

  assert.equal(browser.meta.date, node.meta.date);
  assert.equal(browser.meta.player, node.meta.player);
  assert.equal(browser.meta.displayedCountryName, node.meta.displayedCountryName);
  assert.equal(browser.meta.mods.length, node.meta.mods.length);
  assert.equal(browser.sections.length, node.sections.length, 'top-level sections');
  assert.equal(browser.warnings.length, node.warnings.length, 'warnings');

  const browserProvinces = browser.provinces();
  const nodeProvinces = node.provinces();
  assert.equal(browserProvinces.size, nodeProvinces.size, 'province count');
  const browserCountries = browser.countries();
  const nodeCountries = node.countries();
  assert.equal(browserCountries.size, nodeCountries.size, 'country count');

  // Spot-check real values, so a silent all-undefined bundle cannot pass.
  const stockholm = browserProvinces.get(1);
  assert.ok(stockholm?.name, 'province 1 must have a name');
  assert.equal(stockholm?.name, nodeProvinces.get(1)?.name);
  assert.equal(stockholm?.owner, nodeProvinces.get(1)?.owner);
  const rus = browserCountries.get('RUS');
  assert.ok(rus, 'RUS must exist');
  assert.equal(browser.meta.displayedCountryName, '俄罗斯');

  console.log(`      browser parse: ${browserMs} ms for ${browserProvinces.size} provinces / ${browserCountries.size} countries`);
});

test('the timeline the viewer needs can be built in the browser', { skip: !hasSave }, async () => {
  const bytes = new Uint8Array(readFileSync(SAVE));
  const browser = BrowserDocument.fromMembers(await readMembers(bytes));
  const node = await NodeDocument.fromFile(SAVE, { sections: [] });

  const started = Date.now();
  const browserTimelineData = browserTimeline(browser);
  const browserMs = Date.now() - started;
  const nodeTimeline = buildTimeline(node);

  assert.equal(
    browserTimelineData.events.length,
    nodeTimeline.events.length,
    'the replayed event log must match',
  );
  assert.equal(browserTimelineData.provinces.size, nodeTimeline.provinces.size);
  const browserFirst = browserTimelineData.provinces.get(1);
  const nodeFirst = nodeTimeline.provinces.get(1);
  assert.equal(browserFirst?.initial.length, nodeFirst?.initial.length);
  assert.equal(browserFirst?.events.length, nodeFirst?.events.length);

  const browserWarsData = browserWars(browser);
  const nodeWarsData = extractWars(node);
  assert.equal(browserWarsData.length, nodeWarsData.length, 'war count');
  console.log(
    `      browser timeline: ${browserMs} ms, ${browserTimelineData.events.length.toLocaleString()} events, ` +
      `${browserWarsData.length} wars`,
  );

  const aliases = browserAliases(browser);
  assert.equal(aliases.length, buildTagAliases(node).length, 'tag renames');
  assert.equal(browserFrameMonths('1444.11.11', '1574.11.12').length, 1562, 'monthly frames');
});
