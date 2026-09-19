/**
 * The browser's map reader must reproduce the server's pipeline exactly.
 *
 * `public/game-data.js` is a second implementation of what `scripts/lib/map-assets.ts`
 * does offline (BMP decoding, colour -> id, sea/lake ids, downscaling). The only
 * meaningful test is pixel-for-pixel equality on the real game files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildGameMap,
  decodeProvinceBmp,
  downscaleIds,
  parseDefinitions,
  parseIdSet,
  parseWaterIds,
  colorToIdMap,
  readBmpHeader,
} from '../public/game-data.js';
import {
  EU4,
  colorToIdMap as serverColorToIdMap,
  downscalePixels,
  loadDefinitions,
  loadProvincePixels,
  loadWaterIds,
} from '../../../scripts/lib/map-assets.ts';

const BMP = `${EU4}/map/provinces.bmp`;
const CSV = `${EU4}/map/definition.csv`;
const MAP = `${EU4}/map/default.map`;
const hasGame = existsSync(BMP) && existsSync(CSV) && existsSync(MAP);

test('definition.csv parsing matches the server', { skip: !hasGame }, () => {
  const text = readFileSync(CSV, 'latin1');
  const mine = parseDefinitions(text);
  const theirs = loadDefinitions();
  assert.equal(mine.size, theirs.size, 'province definition count');
  for (const [id, def] of theirs) {
    const ours = mine.get(id);
    assert.ok(ours, `definition ${id} missing`);
    assert.deepEqual(ours.rgb, def.rgb, `definition ${id} colour`);
    assert.equal(ours.name, def.name, `definition ${id} name`);
  }
  assert.equal(colorToIdMap(mine).size, serverColorToIdMap(theirs).size, 'colour -> id table');
});

test('default.map sea and lake lists match the server', { skip: !hasGame }, () => {
  const water = parseWaterIds(readFileSync(MAP, 'latin1'));
  const theirs = loadWaterIds();
  assert.deepEqual([...water.sea].sort((a, b) => a - b), [...theirs.sea].sort((a, b) => a - b), 'sea_starts');
  assert.deepEqual([...water.lakes].sort((a, b) => a - b), [...theirs.lakes].sort((a, b) => a - b), 'lakes');
  // A tiny synthetic case, so this is not only checking pass-through.
  // Note the 0: splitting on whitespace yields empty tokens, `Number('')` is 0,
  // and both implementations therefore collect it. That is harmless (id 0 means
  // "no province") and the two must stay identical, so it is asserted here on
  // purpose rather than silently "fixed" on one side only.
  assert.deepEqual([...parseIdSet('x = { 3 4 # c\n 5 }', 'x')], [0, 3, 4, 5]);
});

test('provinces.bmp decodes to the same id per pixel as the server', { skip: !hasGame }, () => {
  const bytes = new Uint8Array(readFileSync(BMP));
  const header = readBmpHeader(bytes);
  assert.equal(header.bpp, 24);
  assert.equal(header.compression, 0);
  assert.equal(header.bottomUp, true, 'EU4 stores rows bottom-up');
  assert.equal(header.width, 5632);
  assert.equal(header.height, 2048);

  const definitions = loadDefinitions();
  const started = Date.now();
  const mine = decodeProvinceBmp(bytes, serverColorToIdMap(definitions));
  const mineMs = Date.now() - started;
  const theirs = loadProvincePixels(5632, 2048, serverColorToIdMap(definitions), { quiet: true });

  assert.equal(mine.ids.length, theirs.length);
  let firstDiff = -1;
  for (let i = 0; i < theirs.length; i += 1) {
    if (mine.ids[i] !== theirs[i]) {
      firstDiff = i;
      break;
    }
  }
  assert.equal(firstDiff, -1, `pixel ${firstDiff} differs: browser ${mine.ids[firstDiff]} vs server ${theirs[firstDiff]}`);
  const nonZero = mine.ids.reduce((sum, id) => (id ? sum + 1 : sum), 0);
  console.log(
    `      ${mine.width}x${mine.height} decoded in ${mineMs} ms, ` +
      `${nonZero.toLocaleString()} mapped pixels, ${mine.unmatched.toLocaleString()} unmatched`,
  );
});

test('downscaling matches the server for nearest sampling', { skip: !hasGame }, () => {
  const definitions = loadDefinitions();
  const pixels = loadProvincePixels(5632, 2048, serverColorToIdMap(definitions), { quiet: true });
  const mine = downscaleIds(pixels, 5632, 2048, 2, 'nearest');
  const theirs = downscalePixels(pixels, 5632, 2048, 2);
  assert.equal(mine.width, theirs.width);
  assert.equal(mine.height, theirs.height);
  assert.deepEqual([...mine.ids.subarray(0, 5000)], [...theirs.ids.subarray(0, 5000)]);
});

test('buildGameMap assembles the same map the server renders', { skip: !hasGame }, () => {
  const map = buildGameMap({
    provincesBmp: new Uint8Array(readFileSync(BMP)),
    definitionCsv: new Uint8Array(readFileSync(CSV)),
    defaultMap: new Uint8Array(readFileSync(MAP)),
  });
  assert.equal(map.width, 5632);
  assert.equal(map.height, 2048);
  const definitions = loadDefinitions();
  const theirs = loadProvincePixels(5632, 2048, serverColorToIdMap(definitions), { quiet: true });
  let diff = 0;
  for (let i = 0; i < theirs.length; i += 1) if (map.ids[i] !== theirs[i]) diff += 1;
  assert.equal(diff, 0, `${diff} pixels differ from the server pipeline`);
  assert.equal(map.water.sea.size, loadWaterIds().sea.size);
  console.log(`      buildGameMap: ${map.definitions.size} definitions, ${map.water.all.size} water ids`);
});
