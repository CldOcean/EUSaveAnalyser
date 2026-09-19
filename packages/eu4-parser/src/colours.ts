/**
 * Colour maths for the viewer's three colour modes.
 *
 * sRGB triples in, sRGB triples out: no parsing, no state. It lives in the parser
 * package because both data planes need **identical** numbers — the browser build
 * (`apps/site/public/viewer-build.js`, which imports the generated
 * `public/eu4-parser.js`) and the offline generator (`scripts/render-timeline.ts`).
 * `apps/site/test/viewer-build.test.ts` compares their `colours` tables key by key,
 * so a divergence here is a failed build rather than a subtly different map.
 */

/** An `[r, g, b]` triple, one byte per channel. */
export type Rgb = [number, number, number];

/**
 * How far a subject's colour may sit from its overlord's, as CIE76 ΔE.
 *
 * ΔE ≈ 2.3 is the just-noticeable difference, so 8–14 reads as "the same colour,
 * clearly its own country". The band is a *distance*, not a percentage: the old
 * fixed 28–60 % lightening landed anywhere from ΔE 16 (a pale overlord) to 73 (a
 * saturated one), which is a different colour rather than a shade of the overlord's.
 */
export const SUBJECT_SHADE = { low: 8, high: 14 } as const;

/**
 * Whether a triple is the `255 255 255` an EU4 save writes for a country the
 * engine colours itself.
 *
 * Colonial nations and the `C##`/`D##` pools carry it in `color` while the colour
 * actually drawn is derived from the mother country (written to `map_color`), so
 * pure white is a placeholder there, not a colour.
 */
export function isPlaceholderColour(rgb: readonly number[]): boolean {
  return rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255;
}

/** Rec. 709 relative luminance; decides which way a shade moves. */
export function luminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** sRGB -> CIE L*a*b* (D65), the space ΔE is measured in. */
export function toLab(rgb: readonly [number, number, number]): [number, number, number] {
  const linear = (channel: number) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(rgb[0]);
  const g = linear(rgb[1]);
  const b = linear(rgb[2]);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference: 2.3 is the just-noticeable difference, 10+ is obvious. */
export function deltaE(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * The shade of `rgb` that sits `target` ΔE away from it.
 *
 * Direction follows the old hand-tuned version: a pale colour is darkened
 * (lightening Austria's white would not move it at all), everything else is pulled
 * towards white, which keeps the hue and is what the engine itself does to a
 * colonial nation. The *distance* is solved instead of guessed, so a near-white and
 * a nearly black overlord both hand their subjects a colour the same perceptual
 * distance away.
 */
export function shadeRgb(rgb: readonly [number, number, number], target: number): Rgb {
  const pale = luminance(rgb) > 150;
  const at = (amount: number): Rgb =>
    pale
      ? [
          Math.round(rgb[0] * (1 - amount * 0.7)),
          Math.round(rgb[1] * (1 - amount * 0.7)),
          Math.round(rgb[2] * (1 - amount * 0.7)),
        ]
      : [
          Math.round(rgb[0] + (255 - rgb[0]) * amount),
          Math.round(rgb[1] + (255 - rgb[1]) * amount),
          Math.round(rgb[2] + (255 - rgb[2]) * amount),
        ];
  // ΔE grows monotonically with the amount in both directions, so a bisection lands
  // on the requested distance; 24 steps is far below one 8-bit channel step.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (deltaE(at(middle), rgb) < target) low = middle;
    else high = middle;
  }
  return at((low + high) / 2);
}

/**
 * The ΔE target for every member of one family (a subject set, or one overlord's
 * colonial nations).
 *
 * Members are spread across the band in tag order rather than by a per-tag hash:
 * siblings are the ones that must not be confused with each other, and the hash
 * landed several of them on the same shade (CAS's five colonies were all `#736605`).
 * A family of one gets the middle of the band.
 */
export function familyTargets(
  members: readonly string[],
  band: { low: number; high: number } = SUBJECT_SHADE,
): Map<string, number> {
  const sorted = [...new Set(members)].sort();
  const targets = new Map<string, number>();
  sorted.forEach((member, rank) => {
    const target =
      sorted.length <= 1 ? (band.low + band.high) / 2 : band.low + ((band.high - band.low) * rank) / (sorted.length - 1);
    targets.set(member, target);
  });
  return targets;
}

/**
 * Countries drawn in another country's own colour although they are not a 属国.
 *
 * Two different things put a foreign colour into a save, and both land here:
 *
 *   * **A subjection that has ended.** A recolouring mod hands a subject its overlord's
 *     colour by writing it into `map_color` (EU4's `change_country_color`) and leaves the
 *     country its own `color`. Independence restores nothing: the mod's "I am nobody's
 *     subject any more" restore is a *decision* the country has to take, and a human
 *     player may never take it. In the sample save 瓦剌 (OIR) draws 明's `#b38068` while
 *     owning 56 provinces and holding its own `#ccb8b1`.
 *   * **A 朝贡国 (tributary).** By the user's rule tributaries are *not* 属国, so 属国染色
 *     never hands them an overlord's shade — but the mods paint with EU4's `is_subject`,
 *     which counts tributaries as subjects, so their saved colour is the overlord's too
 *     (in the sample save 17 of its 20 tributaries draw exactly that).
 *
 * Either way 属国染色 gives the country its own colour back: drawing the foreign one would
 * claim a relationship the mode does not acknowledge. 模组色 stays faithful — the game
 * really does draw that colour — and 原始色 already shows the country's own colour.
 *
 * The signature is four conditions, all read from the save:
 *
 *   1. it is not a subject now (`subject[index]` is false),
 *   2. it owns land (`landed[index]`), so it is actually drawn on the map,
 *   3. it does not draw its own colour (`drawn !== own`), so something recoloured it,
 *   4. the colour it draws is some **other** country's own colour (`drawn` is in `own`,
 *      and condition 3 guarantees it is not this one's).
 *
 * A country manually recoloured to exactly another country's own colour would also be
 * flagged; across the nine sample saves only the real leftovers and the painted
 * tributaries match, and the two manual recolours (`FRS`, arbitrary colours) do not.
 *
 * @param input index-aligned arrays: `own` is the country's recorded colour
 *   (`undefined` when it has none — a colonial nation's placeholder white), `drawn` is
 *   what the save actually draws, `subject` says whether the tag follows an overlord,
 *   `landed` whether it owns at least one province.
 * @returns one 0/1 flag per index.
 */
export function foreignTintFlags(input: {
  own: readonly (number | undefined)[];
  drawn: readonly number[];
  subject: readonly boolean[];
  landed: readonly boolean[];
}): number[] {
  const { own, drawn, subject, landed } = input;
  const owners = new Set<number>();
  for (const colour of own) if (colour !== undefined) owners.add(colour);
  return own.map((colour, index) =>
    colour !== undefined &&
    landed[index] &&
    !subject[index] &&
    drawn[index] !== colour &&
    owners.has(drawn[index] as number)
      ? 1
      : 0,
  );
}
