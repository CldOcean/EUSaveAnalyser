/**
 * Tests for the shared map painter (used by the PNG renderer and inlined into
 * the browser player) and for the monthly timeline helpers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  STRIPE_PERIOD,
  STRIPE_WIDTH,
  battleRamp,
  buildBorderMask,
  devRamp,
  institutionRamp,
  navalRamp,
  packRgb,
  paintMap,
  techRamp,
} from '../../../scripts/lib/paint.js';
import {
  CountryTimelinePlayer,
  TimelinePlayer,
  buildCountryTimeline,
  buildTagAliases,
  buildTimeline,
  frameMonths,
  ordinalToDate,
  resolveTagLatest,
} from '../src/timeline.ts';
import { SaveDocument } from '../src/document.ts';

const SAVE = fileURLToPath(
  new URL('../../../存档示例/mp_俄罗斯1574_11_12.eu4', import.meta.url),
);

// ------------------------------------------------------------------ paint ----

test('buildBorderMask marks province edges, not interiors', () => {
  // 4x1: ids 1,1 | 2,2 -> only the seam pixel on the left of the change is
  // flagged, which is what draws a 1px outline.
  const pixels = Uint16Array.from([1, 1, 2, 2]);
  const mask = buildBorderMask(pixels, 4, 1, null);
  assert.deepEqual([...mask], [0, 1, 0, 0]);
  const uniform = buildBorderMask(Uint16Array.from([1, 1, 1, 1]), 4, 1, null);
  assert.deepEqual([...uniform], [0, 0, 0, 0], 'a uniform row has no borders');
});

test('buildBorderMask ignores open water seams', () => {
  const pixels = Uint16Array.from([7, 8]);
  const withWater = buildBorderMask(pixels, 2, 1, new Set([7, 8]));
  assert.deepEqual([...withWater], [0, 0], 'two sea provinces share no border');
  const withoutWater = buildBorderMask(pixels, 2, 1, null);
  assert.deepEqual([...withoutWater], [1, 0], 'a land seam is drawn');
});

test('paintMap fills the base colour when there is no hatch', () => {
  const pixels = Uint16Array.from([1, 1, 1, 1]);
  const out = new Uint8ClampedArray(4 * 4);
  const base = new Uint32Array(8);
  const hatch = new Uint32Array(8);
  base[1] = packRgb(10, 20, 30);
  const mask = new Uint8Array(4);
  paintMap(pixels, out, 4, 1, base, hatch, mask, STRIPE_PERIOD, STRIPE_WIDTH, true);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(out[i * 4], 10);
    assert.equal(out[i * 4 + 1], 20);
    assert.equal(out[i * 4 + 2], 30);
    assert.equal(out[i * 4 + 3], 255);
  }
});

test('paintMap draws diagonal hatch bands over the base colour', () => {
  const w = 40;
  const h = 40;
  const pixels = new Uint16Array(w * h).fill(1);
  const out = new Uint8ClampedArray(w * h * 4);
  const base = new Uint32Array(8);
  const hatch = new Uint32Array(8);
  base[1] = packRgb(200, 200, 200);
  hatch[1] = packRgb(0, 0, 255);
  const mask = new Uint8Array(w * h);
  paintMap(pixels, out, w, h, base, hatch, mask, STRIPE_PERIOD, STRIPE_WIDTH, true);

  let striped = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const isStripe = out[o] === 0 && out[o + 2] === 255;
      const isBase = out[o] === 200;
      assert.ok(isStripe || isBase, `pixel ${x},${y} is neither stripe nor base`);
      if (isStripe) striped += 1;
    }
  }
  const ratio = striped / (w * h);
  const expected = STRIPE_WIDTH / STRIPE_PERIOD;
  assert.ok(
    Math.abs(ratio - expected) < 0.05,
    `stripe coverage ${ratio.toFixed(3)} should be near ${expected.toFixed(3)}`,
  );

  // The band must be diagonal, i.e. its phase shifts by one pixel per row.
  const stripeResidues = (y: number): string =>
    Array.from({ length: w }, (_, x) => {
      const o = (y * w + x) * 4;
      return out[o] === 0 && out[o + 2] === 255 ? '1' : '0';
    }).join('');
  assert.notEqual(
    stripeResidues(0),
    stripeResidues(1),
    'adjacent rows must not have an identical stripe pattern',
  );
  // ...and it must match the documented formula exactly.
  for (let i = 0; i < 200; i += 1) {
    const x = i % w;
    const y = Math.floor(i / w);
    const o = (y * w + x) * 4;
    const expectedStripe = (x + (y % STRIPE_PERIOD)) % STRIPE_PERIOD < STRIPE_WIDTH;
    assert.equal(
      out[o] === 0 && out[o + 2] === 255,
      expectedStripe,
      `pixel ${x},${y} disagrees with the stripe formula`,
    );
  }
});

test('paintMap can suppress hatching for heat maps', () => {
  const w = 20;
  const h = 20;
  const pixels = new Uint16Array(w * h).fill(1);
  const out = new Uint8ClampedArray(w * h * 4);
  const base = new Uint32Array(8);
  const hatch = new Uint32Array(8);
  base[1] = packRgb(200, 200, 200);
  hatch[1] = packRgb(0, 0, 255);
  paintMap(pixels, out, w, h, base, hatch, new Uint8Array(w * h), STRIPE_PERIOD, STRIPE_WIDTH, false);
  for (let i = 0; i < w * h; i += 1) {
    assert.equal(out[i * 4], 200, 'no hatch colour may appear when hatch=false');
  }
});

test('development ramp goes red (low) to green (high)', () => {
  const low = devRamp(0);
  const high = devRamp(1);
  const lowR = (low >> 16) & 0xff;
  const lowG = (low >> 8) & 0xff;
  const highR = (high >> 16) & 0xff;
  const highG = (high >> 8) & 0xff;
  assert.ok(lowR > lowG, `low development should be red-ish, got r=${lowR} g=${lowG}`);
  assert.ok(highG > highR, `high development should be green-ish, got r=${highR} g=${highG}`);
  // Greenness increases monotonically across the ramp.
  let previous = -Infinity;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const c = devRamp(t);
    const greenness = ((c >> 8) & 0xff) - ((c >> 16) & 0xff);
    assert.ok(greenness >= previous - 8, `greenness dipped at t=${t.toFixed(1)}`);
    previous = greenness;
  }
});

test('battle ramp runs white (quiet) to deep red (bloody)', () => {
  const quiet = battleRamp(0);
  const bloody = battleRamp(1);
  const channel = (c: number, shift: number): number => (c >> shift) & 0xff;
  assert.ok(channel(quiet, 16) > 230 && channel(quiet, 8) > 230, 'a quiet month is white');
  assert.ok(channel(bloody, 16) > 120, 'a bloody month is red-dominant');
  assert.ok(
    channel(bloody, 8) < channel(quiet, 8) && channel(bloody, 0) < channel(quiet, 0),
    'green and blue fall away as intensity rises',
  );
});

test('technology ramp runs red (backward) to green (advanced)', () => {
  const channel = (c: number, shift: number): number => (c >> shift) & 0xff;
  const low = techRamp(0);
  const high = techRamp(1);
  assert.ok(
    channel(low, 16) > channel(low, 8) && channel(low, 16) > channel(low, 0),
    'the weakest country is red-dominant',
  );
  assert.ok(
    channel(high, 8) > channel(high, 16),
    'the strongest country is green-dominant',
  );
  // Greenness rises monotonically across the ramp.
  let previous = -Infinity;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const c = techRamp(t);
    const greenness = channel(c, 8) - channel(c, 16);
    assert.ok(greenness >= previous - 8, `greenness dipped at t=${t.toFixed(1)}`);
    previous = greenness;
  }
});

test('technology and development ramps are different tables', () => {
  // Same direction (red -> green), deliberately different stops so the two heat
  // maps are still distinguishable side by side.
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    assert.notEqual(devRamp(t), techRamp(t), `t=${t} produced identical colours`);
  }
});

test('institution ramp runs red (behind) to green (advanced)', () => {
  const channel = (c: number, shift: number): number => (c >> shift) & 0xff;
  const low = institutionRamp(0);
  const high = institutionRamp(1);
  assert.ok(channel(low, 16) > channel(low, 8), 'the least advanced province is red-dominant');
  assert.ok(channel(high, 8) > channel(high, 16), 'the most advanced province is green-dominant');
  for (const t of [0, 0.5, 1]) {
    assert.notEqual(institutionRamp(t), techRamp(t), `t=${t} must not equal the tech ramp`);
  }
});

test('naval ramp runs blue (quiet) to red (bloody)', () => {
  const channel = (c: number, shift: number): number => (c >> shift) & 0xff;
  const quiet = navalRamp(0);
  const bloody = navalRamp(1);
  assert.ok(
    channel(quiet, 0) - channel(quiet, 16) >= 30,
    `a quiet naval month must read clearly blue, got ${quiet.toString(16)}`,
  );
  assert.ok(
    channel(bloody, 16) > channel(bloody, 0),
    `a bloody naval month is red-dominant, got ${bloody.toString(16)}`,
  );
  // The ramp sweeps blue -> purple -> red, so it is not monotone per channel;
  // the midpoint must instead be a genuine blend and the last leg must redden.
  const mid = navalRamp(0.5);
  assert.ok(channel(mid, 0) > channel(bloody, 0), 'the midpoint keeps more blue than the red end');
  assert.ok(channel(navalRamp(0.9), 16) > channel(mid, 16), 'red rises over the last leg');
  // The quiet end may not coincide with the land ramp (which starts white).
  // The bloody end is deliberately the same deep red for both.
  assert.notEqual(navalRamp(0), battleRamp(0));
  assert.equal(navalRamp(1), battleRamp(1));
});

// --------------------------------------------------------------- timeline ----

test('frameMonths yields one frame per month, ending on the save date', () => {
  const months = frameMonths('1444.11.11', '1574.11.12');
  assert.equal(months[0]?.date, '1444.11.11');
  assert.equal(months[months.length - 1]?.date, '1574.11.12');
  // 130 years of months, plus the exact closing frame.
  assert.equal(months.length, 1562);
  // Every step is one EU4 month (31 units) except the first, which starts
  // mid-month, and the last, which lands on the save's exact date.
  for (let i = 2; i < months.length - 1; i += 1) {
    assert.equal(
      (months[i] as { ordinal: number }).ordinal - (months[i - 1] as { ordinal: number }).ordinal,
      31,
      `frame ${i} is not one month after its predecessor`,
    );
  }
  assert.ok(
    (months[months.length - 1] as { ordinal: number }).ordinal >
      (months[months.length - 2] as { ordinal: number }).ordinal,
    'the closing frame must come after the last month',
  );
});

test('ordinalToDate round-trips', () => {
  for (const date of ['1444.11.11', '1500.1.1', '1574.11.12']) {
    const months = frameMonths(date, date);
    const ordinal = months[0]?.ordinal as number;
    assert.equal(ordinalToDate(ordinal), date);
  }
});

test('country timelines expose religion and follow tag renames', async () => {
  const doc = await SaveDocument.fromFile(SAVE);
  const countryTimeline = buildCountryTimeline(doc);
  assert.ok(countryTimeline.countries.has('RUS'));
  assert.ok(countryTimeline.events.length > 0);
  assert.ok(countryTimeline.fields.includes('religion'));

  const aliases = buildTagAliases(doc);
  // Muscovy's own history lives on under RUS.
  assert.equal(resolveTagLatest(aliases, 'MOS'), 'RUS');
  assert.equal(resolveTagLatest(aliases, 'ENG'), 'GBR');
  assert.equal(resolveTagLatest(aliases, 'NONE'), 'NONE');

  const player = new CountryTimelinePlayer(countryTimeline, ['religion', 'primary_culture']);
  player.advanceTo(frameMonths('1444.11.11', '1444.11.11')[0]!.ordinal);
  assert.equal(player.valueOf('religion', 'RUS'), 'orthodox');
  assert.equal(player.valueOf('primary_culture', 'RUS'), 'russian');
});

test('every tag a province ever had is resolvable to a live country', async () => {
  const doc = await SaveDocument.fromFile(SAVE);
  const aliases = buildTagAliases(doc);
  const countries = doc.countries();
  // A tag without a country entry cannot be coloured, so it must be a
  // placeholder or a rebel tag, never a real owner.
  const missing = new Set<string>();
  for (const province of doc.provinces().values()) {
    for (const tag of [province.owner, province.controller]) {
      if (!tag || tag === '---' || tag === 'REB') continue;
      const resolved = resolveTagLatest(aliases, tag);
      if (!countries.has(resolved)) missing.add(resolved);
    }
  }
  assert.deepEqual([...missing], [], 'owners must resolve to a known country');
});

test('the replayed HRE membership matches the save at its own date', async () => {
  const doc = await SaveDocument.fromFile(SAVE);
  const timeline = buildTimeline(doc);
  const saveOrdinal = frameMonths(doc.meta.date, doc.meta.date)[0]!.ordinal;

  // What the save itself says right now...
  const expected = new Set<number>();
  for (const province of doc.provinces().values()) {
    if (province.extra['hre'] === 'yes') expected.add(province.id);
  }

  // ...versus what the province history replays to. Membership lives partly in
  // the undated initial state, so a replay that only applied dated events would
  // silently drop most of the empire.
  const player = new TimelinePlayer(timeline, ['hre']);
  player.advanceTo(saveOrdinal);
  const replayed = new Set<number>();
  for (const id of timeline.provinces.keys()) {
    if (player.valueOf('hre', id) === 'yes') replayed.add(id);
  }

  assert.ok(expected.size > 100, `the sample save should have a real HRE, got ${expected.size}`);
  assert.deepEqual(
    [...replayed].sort((a, b) => a - b),
    [...expected].sort((a, b) => a - b),
    'replayed HRE members must equal the save province flags',
  );
});
