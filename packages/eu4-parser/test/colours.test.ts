/**
 * The colour maths behind the three colour modes.
 *
 * These are the numbers the two data planes must agree on, and the ones the map's
 * readability rests on:
 *
 *   * a shade lands at the requested ΔE, whatever the base colour is (a near-white
 *     overlord used to get a subject it could not be told apart from),
 *   * the shade keeps the hue (a subject must look like the same family),
 *   * siblings — the several subjects of one overlord — do not collapse onto one
 *     shade,
 *   * `255 255 255` is recognised as the engine's placeholder rather than a colour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBJECT_SHADE,
  deltaE,
  familyTargets,
  isPlaceholderColour,
  shadeRgb,
  foreignTintFlags,
} from '../src/colours.ts';

/** Hue angle in degrees, or null for a grey. */
function hue([r, g, b]: readonly number[]): number | null {
  const max = Math.max(r as number, g as number, b as number);
  const min = Math.min(r as number, g as number, b as number);
  if (max === min) return null;
  const span = max - min;
  const raw = max === r ? ((g as number) - (b as number)) / span % 6 : max === g ? ((b as number) - (r as number)) / span + 2 : ((r as number) - (g as number)) / span + 4;
  return ((raw * 60) % 360 + 360) % 360;
}
const hueGap = (a: readonly number[], b: readonly number[]) => {
  const [h1, h2] = [hue(a), hue(b)];
  if (h1 === null || h2 === null) return null;
  const raw = Math.abs(h1 - h2);
  return Math.min(raw, 360 - raw);
};

test('the placeholder is exactly the white the engine writes', () => {
  assert.equal(isPlaceholderColour([255, 255, 255]), true);
  assert.equal(isPlaceholderColour([255, 255, 254]), false);
  assert.equal(isPlaceholderColour([254, 255, 255]), false);
  assert.equal(isPlaceholderColour([220, 220, 220]), false);
});

test('a shade lands at the requested distance, whatever the base colour', () => {
  const bases: Array<[number, number, number]> = [
    [255, 255, 255], // the placeholder itself
    [220, 220, 220], // pale: lightening would not move it
    [246, 246, 246],
    [153, 0, 0], // a dark, saturated overlord
    [20, 50, 210],
    [193, 171, 8], // the light-but-saturated case (CAS)
    [40, 110, 140],
    [0, 0, 0],
  ];
  for (const base of bases) {
    for (const target of [SUBJECT_SHADE.low, (SUBJECT_SHADE.low + SUBJECT_SHADE.high) / 2, SUBJECT_SHADE.high]) {
      const shade = shadeRgb(base, target);
      // One 8-bit step is worth ~0.5 ΔE, so a whole unit of slack is plenty.
      const gap = deltaE(shade, base);
      assert.ok(
        Math.abs(gap - target) <= 1,
        `base ${base.join(',')} target ${target} landed at ${gap.toFixed(2)} (${shade.join(',')})`,
      );
      assert.ok(shade.every((channel) => channel >= 0 && channel <= 255 && Number.isInteger(channel)));
    }
  }
});

test('a pale overlord still hands its subjects a colour it can be told from', () => {
  // Austria's white was the case the old percentage-based version failed on.
  const austria: [number, number, number] = [220, 220, 220];
  const subject = shadeRgb(austria, SUBJECT_SHADE.low);
  assert.ok(deltaE(subject, austria) >= SUBJECT_SHADE.low - 1, 'the palest subject must still be visible');
  assert.ok(subject[0] < austria[0] || subject[0] > austria[0], 'a grey subject moves, not stays');
});

test('the shade keeps the hue, so a subject reads as the same family', () => {
  const saturated: Array<[number, number, number]> = [
    [153, 0, 0],
    [20, 50, 210],
    [193, 171, 8],
    [48, 149, 21],
    [97, 209, 251],
  ];
  for (const base of saturated) {
    if (Math.max(...base) === Math.min(...base)) continue;
    const gap = hueGap(base, shadeRgb(base, SUBJECT_SHADE.high));
    assert.ok(gap !== null && gap < 2, `base ${base.join(',')} shifted hue by ${gap} degrees`);
  }
});

test('family targets spread over the band in tag order, one member taking the middle', () => {
  const five = familyTargets(['C10', 'C00', 'C03', 'C01', 'C02']);
  assert.deepEqual([...five.keys()], ['C00', 'C01', 'C02', 'C03', 'C10'], 'sorted, so a rebuild cannot reshuffle');
  assert.equal(five.get('C00'), SUBJECT_SHADE.low);
  assert.equal(five.get('C10'), SUBJECT_SHADE.high);
  assert.equal(familyTargets(['C00']).get('C00'), (SUBJECT_SHADE.low + SUBJECT_SHADE.high) / 2);
  assert.equal(familyTargets([]).size, 0);
  // A repeated tag is one member, not two.
  assert.equal(familyTargets(['C00', 'C00']).size, 1);
});

test('siblings stay apart instead of collapsing onto one shade', () => {
  // CAS had five colonies, all drawn #736605 before this: the hash put them on the
  // same amount.
  const cas: [number, number, number] = [193, 171, 8];
  const members = ['C00', 'C02', 'C03', 'C08', 'C10'];
  const targets = familyTargets(members);
  const drawn = members.map((tag) => shadeRgb(cas, targets.get(tag)!));
  for (let i = 0; i < drawn.length; i += 1) {
    for (let j = i + 1; j < drawn.length; j += 1) {
      assert.ok(
        deltaE(drawn[i]!, drawn[j]!) > 1,
        `siblings ${members[i]} and ${members[j]} are ${deltaE(drawn[i]!, drawn[j]!).toFixed(2)} ΔE apart`,
      );
    }
  }
  // ...and every one of them still reads as CAS's colour, not as a new one.
  for (const shade of drawn) assert.ok(deltaE(shade, cas) <= SUBJECT_SHADE.high + 1);
});

test('a finished subjection leaves a colour the save still carries', () => {
  // The real case, from 西班牙1567: 瓦剌 owns 56 provinces and is nobody's subject, but
  // still draws 明's own colour (#b38068); its own colour is #ccb8b1.
  const own = [0xccb8b1, 0xb38068, undefined];
  const drawn = [0xb38068, 0xb38068, 0xb38068];
  const landed = [true, true, true];
  assert.deepEqual(
    foreignTintFlags({ own, drawn, subject: [false, false, false], landed }),
    [1, 0, 0],
    'the ex-subject is flagged, the country whose colour it borrows is not',
  );

  // A country that *is* a subject takes its overlord's colour on purpose.
  assert.deepEqual(foreignTintFlags({ own, drawn, subject: [true, false, false], landed }), [0, 0, 0]);

  // A country that draws its own colour is never stale, even when two countries happen
  // to share it.
  assert.deepEqual(
    foreignTintFlags({ own: [0xb38068, 0xb38068], drawn: [0xb38068, 0xb38068], subject: [false, false], landed }),
    [0, 0],
  );

  // A country recoloured to a colour nobody owns was recoloured *deliberately* (the
  // sample saves' FRS: #e8ceff → #64ffc8), which is not ours to undo.
  assert.deepEqual(
    foreignTintFlags({ own: [0xe8ceff, 0xb38068], drawn: [0x64ffc8, 0xb38068], subject: [false, false], landed }),
    [0, 0],
  );

  // A country with no colour of its own (a colonial nation's placeholder white) cannot
  // be showing someone else's colour as a leftover.
  assert.deepEqual(
    foreignTintFlags({ own: [undefined, 0xb38068], drawn: [0xb38068, 0xb38068], subject: [false, false], landed }),
    [0, 0],
  );

  // A dormant record that owns no province is not drawn at all, so it is not flagged.
  assert.deepEqual(
    foreignTintFlags({ own: [0xccb8b1, 0xb38068], drawn: [0xb38068, 0xb38068], subject: [false, false], landed: [false, true] }),
    [0, 0],
  );
});
