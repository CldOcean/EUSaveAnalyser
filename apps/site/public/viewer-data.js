/*
 * The viewer's data plane, built in the browser.
 *
 * `scripts/render-timeline.ts` offline and this module online produce the same
 * thing: the arrays the player replays. Three rules learned from porting it:
 *
 * 1. **Dictionaries are sorted and therefore comparable exactly.** They are built
 *    from the union of every initial value and every dated change, so the order
 *    is a property of the data, not of the traversal.
 * 2. **The tag table is NOT comparable by position.** `tagId()` hands out indices
 *    in first-request order, which depends on the offline script's traversal
 *    order (province rows, then country rows, then aliases, HRE, curves,
 *    battles...). What matters is that a tag always maps to the same index
 *    *within one build*, so equivalence is checked semantically - same tag, same
 *    colour, same alias target - never array-by-array.
 * 3. **The religion dictionary is shared between provinces and countries.** The
 *    player compares a province's religion index against its owner's, so both
 *    must come from one table; two separate tables painted stripes almost
 *    everywhere (this is the bug the comment in the offline script warns about).
 *
 * Depends only on the parsed save plus the three browser game-data modules, so it
 * runs on the page and in tests alike.
 */

/** Province fields the player replays. */
export const PROVINCE_FIELDS = [
  'owner',
  'controller',
  'religion',
  'culture',
  'base_tax',
  'base_production',
  'base_manpower',
  'hre',
];

/** Country fields the player replays; `dynasty` comes from the monarch blocks. */
export const COUNTRY_FIELDS = ['religion', 'dynasty'];

export function buildDict(values) {
  const dict = [...values];
  return { dict, index: new Map(dict.map((value, i) => [value, i])) };
}

/**
 * One dictionary per province field, sorted so the indices are stable.
 *
 * @param {{ timeline: object, countryTimeline: object, countries: Map<string, object> }} input
 */
export function buildProvinceDicts({ timeline, countryTimeline, countries }) {
  const dicts = new Map();
  for (const field of PROVINCE_FIELDS) {
    const raw = new Set();
    for (const history of timeline.provinces.values()) {
      for (const change of history.initial) if (change.field === field) raw.add(change.value);
      for (const event of history.events) {
        for (const change of event.changes) if (change.field === field) raw.add(change.value);
      }
    }
    if (field === 'religion') {
      // Shared with the country table - see rule 3 above.
      for (const country of countries.values()) {
        const own = scalarOf(country, 'religion');
        if (own) raw.add(own);
      }
      for (const history of countryTimeline.countries.values()) {
        for (const change of history.initial) if (change.field === 'religion') raw.add(change.value);
        for (const event of history.events) {
          for (const change of event.changes) if (change.field === 'religion') raw.add(change.value);
        }
      }
    }
    dicts.set(field, buildDict([...raw].sort()));
  }
  return dicts;
}

/**
 * Country dictionaries. Religion reuses the province one (rule 3); dynasty is
 * collected from the dated `monarch` blocks.
 */
export function buildCountryDicts({ provinceDicts, countryTimeline }) {
  const dicts = new Map();
  for (const field of COUNTRY_FIELDS) {
    const shared = provinceDicts.get(field);
    if (shared) {
      dicts.set(field, shared);
      continue;
    }
    const raw = new Set();
    for (const history of countryTimeline.countries.values()) {
      for (const event of history.events) {
        for (const change of event.changes) {
          if (change.field === 'monarch' && change.detail?.dynasty) raw.add(change.detail.dynasty);
        }
      }
    }
    dicts.set(field, buildDict([...raw].sort()));
  }
  return dicts;
}

/**
 * The country plane: state religion and ruling dynasty, as dated rows.
 *
 * Two rules here were learned the hard way and must not be "simplified":
 *
 * 1. **Only the surviving tag of a rename carries the timeline.** The game moves a
 *    predecessor's whole history onto its successor (RUS holds Muscovy's entries
 *    back to 1389). Processing both would write to the same viewer slot twice and
 *    the stale one would win - Bavaria ends up Catholic because LBV->BAV
 *    overwrote it.
 * 2. **A country's faith is only known once its own history begins.** Seeding
 *    every country from the save's *current* religion painted the Reformation into
 *    1444 (15 Protestant countries at the start). The initial value is applied
 *    from the country's first dated event instead, with a two-month grace at the
 *    campaign start, and the save's scalar is appended as a correction at the save
 *    date.
 */
export function buildCountryPlane({
  countryTimeline,
  countries,
  aliases,
  countryDicts,
  countryFieldIdx,
  tagId,
  resolveTagLatest,
  campaignStartOrdinal,
  saveOrdinal,
  grace = 62,
}) {
  const renamedFrom = new Set(aliases.map((a) => a.from));
  const eventRows = [];

  for (const history of countryTimeline.countries.values()) {
    if (renamedFrom.has(history.tag)) continue;
    const latest = resolveTagLatest(aliases, history.tag);
    const firstOrdinal = history.events[0]?.ordinal;
    const initialFrom =
      firstOrdinal === undefined
        ? saveOrdinal
        : firstOrdinal <= campaignStartOrdinal + grace
          ? campaignStartOrdinal
          : firstOrdinal;

    for (const field of COUNTRY_FIELDS) {
      const initial = history.initial.find((change) => change.field === field);
      if (!initial) continue;
      const vi = countryDicts.get(field)?.index.get(initial.value);
      if (vi !== undefined) eventRows.push([initialFrom, tagId(latest), countryFieldIdx.get(field), vi]);
    }

    for (const event of history.events) {
      for (const change of event.changes) {
        const fi = countryFieldIdx.get(change.field);
        if (fi === undefined) {
          // Monarch accessions carry the dynasty; there is no separate field.
          if (change.field === 'monarch' && change.detail?.dynasty) {
            const dynastyIdx = countryDicts.get('dynasty')?.index.get(change.detail.dynasty);
            if (dynastyIdx !== undefined) {
              eventRows.push([event.ordinal, tagId(latest), countryFieldIdx.get('dynasty'), dynastyIdx]);
            }
          }
          continue;
        }
        const vi = countryDicts.get(change.field)?.index.get(change.value);
        if (vi === undefined) continue;
        eventRows.push([event.ordinal, tagId(latest), fi, vi]);
      }
    }
  }

  // The save's own scalar wins for "now": a conversion dated after the last event
  // in the log would otherwise be missing from the final frame.
  let corrected = 0;
  for (const [tag, country] of countries) {
    if (renamedFrom.has(tag)) continue;
    const latest = resolveTagLatest(aliases, tag);
    for (const field of COUNTRY_FIELDS) {
      const value = scalarOf(country, field);
      if (!value) continue;
      const vi = countryDicts.get(field)?.index.get(value);
      if (vi === undefined) continue;
      eventRows.push([saveOrdinal, tagId(latest), countryFieldIdx.get(field), vi]);
      corrected += 1;
    }
  }

  // Stable sort: for equal dates the order above (initials, dated, corrections)
  // must survive, because the later row wins for the same field.
  eventRows.sort((a, b) => a[0] - b[0]);
  return { eventRows, corrected };
}

/**
 * Tag registry: first request wins the index, exactly like the offline script
 * (rule 2 - the numbers differ between builds, the relationships must not).
 */
export function createTagRegistry() {
  const list = [];
  const index = new Map();
  const tagId = (tag) => {
    let id = index.get(tag);
    if (id === undefined) {
      id = list.length;
      list.push(tag);
      index.set(tag, id);
    }
    return id;
  };
  return { list, index, tagId };
}

/**
 * A country's map colour.
 *
 * Read out of the save, not the game files: `countries/{TAG}` carries a `colors`
 * block with `map_color` / `country_color` / `color`, and a deterministic hash
 * covers tags without one.
 */
export function countryColorOf(country, tag, hashFallback) {
  if (tag === 'REB') return [140, 30, 30];
  const colors = country ? groupOf(country, 'colors') : undefined;
  const raw = colors?.map_color ?? colors?.country_color ?? colors?.color;
  if (raw) {
    const parts = raw.trim().split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return hashFallback(tag);
}

// The parser already exposes the accessors for these records; using them avoids
// guessing at the record shape (and keeps the two builds honest).
import { TimelinePlayer, countryGroup as groupOf, countryScalar as scalarOf } from './eu4-parser.js';

/**
 * Encode one province change as `[provinceId, fieldIdx, valueIdx]`.
 *
 * `owner`/`controller` hold a **tag index** (so the player can index the colour
 * table and follow tag aliases directly); every other field holds an index into
 * that field's value dictionary.
 *
 * Rebel control is deliberately encoded as "no controller": EU4 leaves
 * `controller=REB` in a province's log long after the revolt, and in this save 84
 * provinces had been "rebel-occupied" for over a century, which the viewer drew as
 * permanent red hatching. Rebels are not a country, so they are not drawn.
 */
export function encodeProvinceChange(id, field, value, { provinceFieldIdx, provinceDicts, tagId }) {
  const fi = provinceFieldIdx.get(field);
  if (fi === undefined) return undefined;
  if (field === 'owner' || field === 'controller') {
    return [id, fi, value === '---' || value === 'REB' ? -1 : tagId(value)];
  }
  const vi = provinceDicts.get(field)?.index.get(value);
  return vi === undefined ? undefined : [id, fi, vi];
}

/**
 * The province plane: initial state, every dated change, and the corrections that
 * make the last frame agree with the save.
 *
 * @param {{ timeline: object, provinces: Map<number, object>, doc: object,
 *           provinceDicts: Map<string, object>, provinceFieldIdx: Map<string, number>,
 *           tagId: (tag: string) => number, saveOrdinal: number }} input
 */
export function buildProvincePlane({
  timeline: gameTimeline,
  provinces,
  doc,
  provinceDicts,
  provinceFieldIdx,
  tagId,
  saveOrdinal,
}) {
  const encode = (id, field, value) =>
    encodeProvinceChange(id, field, value, { provinceFieldIdx, provinceDicts, tagId });

  const initRows = [];
  for (const history of gameTimeline.provinces.values()) {
    for (const change of history.initial) {
      const row = encode(history.id, change.field, change.value);
      if (row) initRows.push(row);
    }
  }

  const eventRows = [];
  for (const event of gameTimeline.events) {
    for (const change of event.changes) {
      const row = encode(event.provinceId, change.field, change.value);
      if (row) eventRows.push([event.ordinal, ...row]);
    }
  }

  /**
   * Close the occupations the game never closed.
   *
   * EU4 records when a province is occupied but frequently **not** when the
   * occupation ends, so the replay drifts: in this save 503 provinces disagree
   * with the save's own `controller`. History is all we have for the past, but for
   * the present the save wins, so a correction is appended at the final date.
   * Appending keeps the log sorted (the save date is the largest ordinal) and the
   * later row wins for the same field.
   */
  const controllerField = provinceFieldIdx.get('controller');
  const replay = new TimelinePlayer(gameTimeline, ['controller']);
  replay.advanceTo(saveOrdinal);
  let corrected = 0;
  let rebelCleared = 0;
  for (const province of provinces.values()) {
    const replayed = replay.valueOf('controller', province.id) ?? '';
    const current = province.controller ?? '';
    if (replayed === current) continue;
    if (replayed === 'REB') rebelCleared += 1;
    const value = current === '' || current === '---' || current === 'REB' ? -1 : tagId(current);
    eventRows.push([saveOrdinal, province.id, controllerField, value]);
    corrected += 1;
  }
  return { initRows, eventRows, corrected, rebelCleared };
}
