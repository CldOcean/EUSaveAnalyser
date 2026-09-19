/*
 * Assemble the viewer's whole data plane in the browser.
 *
 * `scripts/render-timeline.ts` writes `tmp/timeline/data.json` plus a raster PNG;
 * this module produces the same object from a parsed save plus the game folder the
 * user picked. The order of the steps below is not cosmetic: `tagId()` hands out
 * indices in first-request order, so building the province plane before the country
 * plane, and `tagAlias` before the battles, is what makes the two builds agree
 * index for index. `viewer-build.test.ts` compares the result against the offline
 * file key by key, which is the only reason this ordering is trustworthy.
 *
 * Colour helpers live here rather than in the parser because they belong to the
 * offline map-assets library (`scripts/lib/map-assets.ts`), not to save parsing.
 * The ΔE maths the shading needs is the exception: it is shared with the offline
 * data plane through the parser bundle (`packages/eu4-parser/src/colours.ts`).
 */

import {
  COUNTRY_FIELDS,
  PROVINCE_FIELDS,
  buildCountryDicts,
  buildCountryPlane,
  buildProvinceDicts,
  buildProvincePlane,
  countryColorOf,
  createTagRegistry,
} from './viewer-data.js';

import {
  BlockView,
  ClausewitzReader,
  CountryTimelinePlayer,
  INSTITUTIONS,
  SUBJECT_SHADE,
  TimelinePlayer,
  buildCountryTimeline,
  buildDetailTables,
  buildTagAliases,
  buildTimeline,
  countryGroup,
  countryScalar,
  extractWars,
  familyTargets,
  frameMonths,
  isPlaceholderColour,
  parseGameDate,
  readInstitutionProgress,
  readSubjectLedger,
  resolveTag,
  resolveTagLatest,
  shadeRgb,
  foreignTintFlags,
  timelineStats,
} from './eu4-parser.js';

/** Raster / shading constants, shared with the client painter. */
export const SEA = [26, 52, 84];
export const LAKE = [42, 88, 128];
export const UNOWNED = [88, 92, 98];
export const NO_PROVINCE = [12, 12, 18];
export const REBEL = [140, 30, 30];
export const STRIPE_PERIOD = 10;
export const STRIPE_WIDTH = 4;

/** Holy Roman Empire entity colours (there is no game-provided palette). */
export const HRE_COLORS = {
  emperor: [216, 178, 58],
  elector: [139, 92, 246],
  freeCity: [59, 130, 246],
  member: [107, 127, 106],
  foreign: [138, 109, 74],
};

/** `[r,g,b]` -> one 24-bit integer, the form the client indexes. */
export function packRgb(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

/** `[r,g,b]` -> `#rrggbb`, for CSS. */
export function toHex(rgb) {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** A packed colour back to its three channels. */
export function unpackRgb(packed) {
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

/**
 * The colour a country is recorded with, or `undefined` when it has none.
 *
 * `255 255 255` counts as none: the engine writes it for every country it colours
 * itself (colonial nations, the `C##`/`D##` pools), so reading it as a colour is
 * what painted the whole colonial world white.
 */
export function recordedColourOf(country) {
  const raw = country ? countryGroup(country, 'colors')?.color : undefined;
  const parts = raw ? raw.trim().split(/\s+/).map(Number) : undefined;
  if (!parts || parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return undefined;
  const rgb = parts.slice(0, 3);
  return isPlaceholderColour(rgb) ? undefined : rgb;
}

/** HTML-escape a value that goes into the panels' markup. */
export function htmlEscape(text) {
  return String(text).replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

export function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

/** Stable, visually distinct colours for an unordered list of names. */
export function buildPalette(values) {
  const palette = new Map();
  values.forEach((value, index) => {
    const hue = (index * 137.508) % 360;
    const saturation = 0.45 + ((index * 7) % 3) * 0.12;
    const lightness = 0.38 + ((index * 11) % 4) * 0.07;
    palette.set(value, hslToRgb(hue, saturation, lightness));
  });
  return palette;
}

/**
 * Fallback colour for a tag with no `map_color` in the save.
 *
 * The polynomial hash alone is *not* spread out: its low bits move almost
 * linearly with the characters, so `C00`..`C17` all landed within a few degrees
 * of each other and every colonial tint came out yellow. Mixing the bits first
 * (murmur3's fmix32) is what makes the hue depend on the whole hash.
 *
 * Keep this byte for byte identical to the copy in `scripts/lib/map-assets.ts`:
 * `viewer-build.test.ts` compares the two data planes key by key.
 */
export function hashColor(tag) {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return hslToRgb((h >>> 0) % 360, 0.6, 0.45);
}

/**
 * Build everything the viewer needs.
 *
 * @param {{
 *   doc: object,
 *   map: { ids: Uint16Array|number[], width: number, height: number },
 *   water: { sea: Set<number>, lakes: Set<number> },
 *   localise: (key: string) => string,
 *   officialReligions?: Map<string, number[]>,
 *   scale?: number,
 *   uiTables?: { uiNames?: string, provinceTerrain?: string, area?: string },
 * }} input
 */
export function buildViewerData({ doc, map, water, localise, officialReligions, scale = 1, uiTables }) {
  const provinces = doc.provinces();
  const countries = doc.countries();
  const aliases = buildTagAliases(doc);
  const timeline = buildTimeline(doc);
  const countryTimeline = buildCountryTimeline(doc);
  const stats = timelineStats(timeline);
  const start = timeline.campaignStart ?? stats.startDate;
  const months = frameMonths(start, doc.meta.date);
  const saveOrdinal = parseGameDate(doc.meta.date).ordinal;

  // ---- tag registry and colours -------------------------------------------
  const registry = createTagRegistry();
  const tagId = registry.tagId;
  const tagColors = [];
  const countryColorRaw = (tag) => {
    if (tag === 'REB') return REBEL;
    return countryColorOf(countries.get(tag), tag, hashColor);
  };
  const tagColorOf = (tag) => {
    const id = tagId(tag);
    if (tagColors[id] === undefined) tagColors[id] = packRgb(...countryColorRaw(tag));
    return tagColors[id];
  };

  // ---- dictionaries and the two planes ------------------------------------
  const provinceDicts = buildProvinceDicts({ timeline, countryTimeline, countries });
  const countryDicts = buildCountryDicts({ provinceDicts, countryTimeline });
  const provinceFieldIdx = new Map(PROVINCE_FIELDS.map((f, i) => [f, i]));
  const countryFieldIdx = new Map(COUNTRY_FIELDS.map((f, i) => [f, i]));

  const provincePlane = buildProvincePlane({
    timeline,
    provinces,
    doc,
    provinceDicts,
    provinceFieldIdx,
    tagId,
    saveOrdinal,
  });
  const campaignStartOrdinal = parseGameDate(start).ordinal;
  const countryPlane = buildCountryPlane({
    countryTimeline,
    countries,
    aliases,
    countryDicts,
    countryFieldIdx,
    tagId,
    resolveTagLatest,
    campaignStartOrdinal,
    saveOrdinal,
  });

  // Tag changes as [fromIdx, ordinal, toIdx], so the client can resolve aliases.
  const tagAlias = aliases.map((a) => [tagId(a.from), a.ordinal, tagId(a.to)]);

  // ---- palettes -----------------------------------------------------------
  const religionDict = provinceDicts.get('religion').dict;
  const cultureDict = provinceDicts.get('culture').dict;
  const generatedReligions = buildPalette([...religionDict].sort());
  const generatedCultures = buildPalette([...cultureDict].sort());
  const religionColorOf = (name) => officialReligions?.get(name) ?? generatedReligions.get(name) ?? UNOWNED;
  const cultureColorOf = (name) => generatedCultures.get(name) ?? UNOWNED;

  // ---- most-occupied month ------------------------------------------------
  // Occupancy is measured on month boundaries with aliases applied: a province
  // flips from "occupied by RUS" to "owned by RUS" the moment MOS is renamed,
  // with no province event at all.
  const ownerById = new Array(70_000);
  const controllerById = new Array(70_000);
  for (const history of timeline.provinces.values()) {
    for (const change of history.initial) {
      if (change.field === 'owner') ownerById[history.id] = change.value;
      else if (change.field === 'controller') controllerById[history.id] = change.value;
    }
  }
  let bestCount = -1;
  let bestMonth = 0;
  {
    let cursor = 0;
    const provinceIds = [...provinces.keys()];
    for (let i = 0; i < months.length; i += 1) {
      const month = months[i];
      while (cursor < timeline.events.length) {
        const event = timeline.events[cursor];
        if (event.ordinal > month.ordinal) break;
        cursor += 1;
        for (const change of event.changes) {
          if (change.field === 'owner') ownerById[event.provinceId] = change.value;
          else if (change.field === 'controller') controllerById[event.provinceId] = change.value;
        }
      }
      const cache = new Map();
      const resolved = (tag) => {
        let value = cache.get(tag);
        if (value === undefined) {
          value = resolveTag(aliases, tag, month.ordinal);
          cache.set(tag, value);
        }
        return value;
      };
      let count = 0;
      for (const id of provinceIds) {
        const owner = ownerById[id];
        if (!owner || owner === '---' || owner === 'REB') continue;
        const controller = controllerById[id];
        // Rebels are not a country, so rebel control is not an occupation here.
        if (!controller || controller === '---' || controller === 'REB') continue;
        if (resolved(controller) !== resolved(owner)) count += 1;
      }
      if (count > bestCount) {
        bestCount = count;
        bestMonth = i;
      }
    }
  }

  // ---- battles ------------------------------------------------------------
  // Cumulative, not per-month: a province darkens as it is fought over again and
  // again. Battle count dominates bloodiness on purpose.
  const BATTLE_COUNT_WEIGHT = 1;
  const BATTLE_INTENSITY_WEIGHT = 0.3;
  const wars = extractWars(doc);
  const battleRows = [];
  {
    const sumUnits = (units) => {
      let total = 0;
      for (const value of Object.values(units)) total += value;
      return total;
    };
    let maxLosses = 1;
    for (const war of wars) {
      for (const battle of war.battles) {
        const losses = (battle.attacker.losses ?? 0) + (battle.defender.losses ?? 0);
        if (losses > maxLosses) maxLosses = losses;
      }
    }
    for (const war of wars) {
      for (const battle of war.battles) {
        if (battle.location === undefined) continue;
        const parts = battle.date.split('.').map(Number);
        const year = parts[0] ?? 0;
        const month = parts[1] ?? 1;
        const engaged = sumUnits(battle.attacker.units) + sumUnits(battle.defender.units);
        const losses = (battle.attacker.losses ?? 0) + (battle.defender.losses ?? 0);
        const lethality = engaged > 0 ? losses / engaged : 0;
        const size = Math.log(1 + losses) / Math.log(1 + maxLosses);
        const intensity = 0.7 * size + 0.3 * Math.min(1, lethality);
        const contribution = BATTLE_COUNT_WEIGHT + BATTLE_INTENSITY_WEIGHT * Math.min(1, intensity);
        battleRows.push([
          year * 12 + (month - 1),
          battle.location,
          Math.round(contribution * 100), // x100 keeps it an integer
          battle.attacker.country ? tagId(battle.attacker.country) : -1,
          battle.defender.country ? tagId(battle.defender.country) : -1,
          losses,
          // 1 for a sea battle, 0 for a land battle: different ramps.
          battle.naval ? 1 : 0,
        ]);
      }
    }
  }
  const maxCumulativeBattleScore = (naval) => {
    const totals = new Map();
    let best = 1;
    for (const row of battleRows) {
      if ((row[6] === 1) !== naval) continue;
      const total = (totals.get(row[1]) ?? 0) + row[2];
      totals.set(row[1], total);
      if (total > best) best = total;
    }
    return best;
  };
  const maxBattleScore = maxCumulativeBattleScore(false);
  const maxNavalScore = maxCumulativeBattleScore(true);

  // ---- technology snapshot ------------------------------------------------
  // There is no usable dated tech log (~11 tech events per country here), so this
  // is one snapshot, scored relatively: weakest reddest, strongest greenest.
  const tagTech = [];
  let techMin = Number.POSITIVE_INFINITY;
  let techMax = 0;
  for (const [tag, country] of countries) {
    const tech = countryGroup(country, 'technology') ?? {};
    const level = (Number(tech['adm_tech']) || 0) + (Number(tech['dip_tech']) || 0) + (Number(tech['mil_tech']) || 0);
    tagTech[tagId(tag)] = level;
    if (level > 0) {
      if (level < techMin) techMin = level;
      if (level > techMax) techMax = level;
    }
  }
  if (!Number.isFinite(techMin)) techMin = 0;

  // ---- institutions snapshot ---------------------------------------------
  const provinceInstitutions = [];
  let instMin = Number.POSITIVE_INFINITY;
  let instMax = 0;
  for (const province of provinces.values()) {
    const progress = readInstitutionProgress(province.institutions);
    provinceInstitutions.push([province.id, progress.embraced, progress.embracing]);
    if (progress.embraced < instMin) instMin = progress.embraced;
    if (progress.embraced > instMax) instMax = progress.embraced;
  }
  if (!Number.isFinite(instMin)) instMin = 0;

  // ---- detail tables ------------------------------------------------------
  // The province extras and the country panel's wave-1 scalars, built by the shared
  // assembler the offline plane calls at the same point (right before the tag colours
  // are frozen, because claims/builders/areas may introduce tags). `uiTables` is the
  // raw text of `assets/ui/*.json`; a missing table just leaves that category empty.
  const detailTables = buildDetailTables({
    doc,
    provinces,
    tagId,
    saveDate: doc.meta.date,
    startDate: start,
    wars,
    // The monarch board's 在位发展度 replays province ownership month by month; the one
    // shared implementation lives in `details.ts`, so both planes hand in the timeline
    // they already built (第四对话任务书 §3.5).
    timeline,
    tables: uiTables ?? {},
  });

  /**
   * S2's name table, baked (省份国家界面阶段任务书 §6.8.3).
   *
   * The panels read names out of the data plane and never fetch a file at run time —
   * the offline self-contained page has no server to fetch from. `uiNames` keeps the
   * family shape of the file; `cultureNames` / `personalityNames` are the shapes the
   * panel code indexes directly.
   */
  const uiNames = detailTables.uiNames;
  const cultureNames = cultureDict.map((key) => uiNames['cultures']?.[key] ?? '');
  const personalityNames = uiNames['personalities'] ?? {};

  // Every tag seen so far gets a colour. Tags first seen after this point (HRE
  // and curve tags) keep the hole, which the assembly below flattens to 0 —
  // exactly what the offline build does.
  for (const tag of registry.list) tagColorOf(tag);

  // ---- dynasties ----------------------------------------------------------
  // The game ships no dynasty colour table, so each dynasty gets a deterministic
  // golden-angle colour in alphabetical order.
  const dynastyDict = countryDicts.get('dynasty').dict;
  const dynastyColors = dynastyDict.map((name, index) => {
    const hue = (index * 137.508) % 360;
    const saturation = 0.42 + ((index * 5) % 3) * 0.13;
    const lightness = 0.36 + ((index * 7) % 4) * 0.075;
    return packRgb(...hslToRgb(hue, saturation, lightness));
  });

  // ---- Holy Roman Empire --------------------------------------------------
  const hreInfo = (() => {
    const empire = doc.readSectionView('empire');
    const emperorTag = empire?.string('emperor');
    const electorTags = empire?.stringList('electors') ?? [];

    // `old_emperor` repeats, each with the date the previous emperor died.
    const emperorEvents = [];
    for (const node of empire?.all('old_emperor') ?? []) {
      const view = BlockView.from(node);
      const tag = view?.string('country');
      const date = view?.scalar('date');
      if (!tag || !date) continue;
      const ordinal = parseGameDate(date)?.ordinal;
      if (ordinal === undefined) continue;
      emperorEvents.push([ordinal, tagId(tag)]);
    }
    emperorEvents.sort((a, b) => a[0] - b[0]);
    if (emperorTag) emperorEvents.push([saveOrdinal, tagId(emperorTag)]);

    const freeCities = [...countries.entries()]
      .filter(([, country]) => /free_city/i.test(countryScalar(country, 'government_name') ?? ''))
      .map(([tag]) => tagId(tag));

    // A country belongs to the empire when its capital province is HRE land.
    const capitals = [];
    for (const [tag, country] of countries) {
      const capital = Number(countryScalar(country, 'capital') ?? '0');
      if (capital > 0) capitals.push([tagId(tag), capital]);
    }
    return {
      emperor: emperorTag ? tagId(emperorTag) : -1,
      emperorEvents,
      electors: electorTags.map((t) => tagId(t)),
      freeCities,
      capitals,
    };
  })();

  // ---- power curves -------------------------------------------------------
  // The one long-run series the save genuinely supports: ownership and
  // development are dated, while income and army exist only as snapshots.
  const curves = (() => {
    const TOP_N = 12;
    const MAX_ID = 70_000;
    const taxById = new Float64Array(MAX_ID);
    const prodById = new Float64Array(MAX_ID);
    const mpById = new Float64Array(MAX_ID);
    const curveOwnerById = new Array(MAX_ID);
    const provinceIds = [...provinces.keys()];
    for (const province of provinces.values()) {
      taxById[province.id] = province.baseTax ?? 0;
      prodById[province.id] = province.baseProduction ?? 0;
      mpById[province.id] = province.baseManpower ?? 0;
      if (province.owner && province.owner !== '---' && province.owner !== 'REB') {
        curveOwnerById[province.id] = province.owner;
      }
    }

    const applyChange = (provinceId, field, value) => {
      if (field === 'owner') {
        curveOwnerById[provinceId] = value === '---' || value === 'REB' ? undefined : value;
        return true;
      }
      if (field === 'base_tax') taxById[provinceId] = Number(value) || 0;
      else if (field === 'base_production') prodById[provinceId] = Number(value) || 0;
      else if (field === 'base_manpower') mpById[provinceId] = Number(value) || 0;
      return false;
    };

    // The province blocks hold the campaign's *final* values, so this rewinds.
    const applyInitialState = () => {
      for (const history of timeline.provinces.values()) {
        for (const change of history.initial) applyChange(history.id, change.field, change.value);
      }
    };

    // Rank by the final state, so the chart shows the countries that mattered.
    const finalDev = new Map();
    for (const id of provinceIds) {
      const owner = curveOwnerById[id];
      if (!owner) continue;
      finalDev.set(owner, (finalDev.get(owner) ?? 0) + taxById[id] + prodById[id] + mpById[id]);
    }
    const names = [...finalDev.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([t]) => t);
    const slotOf = new Map();
    names.forEach((tag, slot) => slotOf.set(tag, slot));
    const tagIdx = names.map((tag) => tagId(resolveTag(aliases, tag, saveOrdinal)));

    applyInitialState();

    // Slots are keyed by identity, not by the tag of the day: a country that
    // changes tag keeps one continuous curve instead of restarting at zero.
    const slotById = new Int8Array(MAX_ID).fill(-1);
    const slotForOwner = (owner) => (owner === undefined ? -1 : (slotOf.get(resolveTagLatest(aliases, owner)) ?? -1));
    for (const id of provinceIds) slotById[id] = slotForOwner(curveOwnerById[id]);

    const devSeries = names.map(() => []);
    const provinceSeries = names.map(() => []);
    let cursor = 0;

    for (const month of months) {
      while (cursor < timeline.events.length) {
        const event = timeline.events[cursor];
        if (event.ordinal > month.ordinal) break;
        cursor += 1;
        let ownerChanged = false;
        for (const change of event.changes) {
          if (applyChange(event.provinceId, change.field, change.value)) ownerChanged = true;
        }
        if (ownerChanged) slotById[event.provinceId] = slotForOwner(curveOwnerById[event.provinceId]);
      }

      const devTotals = new Float64Array(names.length);
      const countTotals = new Int32Array(names.length);
      for (const id of provinceIds) {
        const slot = slotById[id];
        if (slot < 0) continue;
        devTotals[slot] += taxById[id] + prodById[id] + mpById[id];
        countTotals[slot] += 1;
      }
      for (let slot = 0; slot < names.length; slot += 1) {
        devSeries[slot].push(Math.round(devTotals[slot]));
        provinceSeries[slot].push(countTotals[slot]);
      }
    }
    return { tags: tagIdx, names, dev: devSeries, provinces: provinceSeries };
  })();

  // ---- raster -------------------------------------------------------------
  // Province id split over two channels so the client can recover it exactly.
  const rgb = new Uint8Array(map.width * map.height * 3);
  for (let i = 0; i < map.ids.length; i += 1) {
    const id = map.ids[i];
    rgb[i * 3] = (id >> 8) & 0xff;
    rgb[i * 3 + 1] = id & 0xff;
    rgb[i * 3 + 2] = 0;
  }

  /**
   * Display name for a tag. Localisation covers normal tags; dynamically created
   * ones (colonial nations like C05) have no key at all and carry their name in
   * the save itself.
   */
  function displayName(tag) {
    const localised = localise(tag);
    if (localised && localised !== tag) return localised;
    const country = countries.get(tag);
    const stored = country ? countryScalar(country, 'name') : undefined;
    if (stored) return stored;
    const parent = country ? countryScalar(country, 'colonial_parent') : undefined;
    if (parent) return displayName(parent) + '属' + tag;
    return localised || tag;
  }

  // ---- the three panels under the map -------------------------------------
  // Army size has to be counted by hand: the save keeps regiments as nested
  // blocks, and nothing else reports a country's land forces.
  const armySizes = () => {
    const out = new Map();
    const ref = doc.section('countries');
    if (!ref) return out;
    const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);
    const countRegiments = (armyReader, depth) => {
      let count = 0;
      for (;;) {
        const member = armyReader.nextMember();
        if (!member) break;
        if (member.key === 'regiment') count += 1;
        if (
          member.kind === 'block' &&
          depth < 2 &&
          (member.key === 'mercenary_company' || member.key === 'subunit' || member.key === 'army')
        ) {
          count += countRegiments(armyReader.enter(member), depth + 1);
        }
      }
      return count;
    };
    for (;;) {
      const country = reader.nextMember();
      if (!country) break;
      if (country.kind !== 'block' || country.key === null) continue;
      let regiments = 0;
      const body = reader.enter(country);
      for (;;) {
        const item = body.nextMember();
        if (!item) break;
        if (item.key === 'army' && item.kind === 'block') {
          regiments += countRegiments(body.enter(item), 0);
        }
      }
      if (regiments > 0) out.set(country.key, regiments);
    }
    return out;
  };

  const panels = (() => {
    const armyByTag = armySizes();
    const provinceDev = new Map();
    const countryDev = new Map();
    for (const province of provinces.values()) {
      const dev = (province.baseTax ?? 0) + (province.baseProduction ?? 0) + (province.baseManpower ?? 0);
      provinceDev.set(province.id, dev);
      const ownerTag = province.owner;
      if (!ownerTag || ownerTag === '---' || ownerTag === 'REB') continue;
      const resolved = resolveTag(aliases, ownerTag, saveOrdinal);
      countryDev.set(resolved, (countryDev.get(resolved) ?? 0) + dev);
    }

    const leaderRows = [];
    for (const [tag, country] of countries) {
      const resolved = resolveTag(aliases, tag, saveOrdinal);
      const capitalId = Number(countryScalar(country, 'capital') ?? '0');
      const score = Number(countryScalar(country, 'great_power_score') ?? '0');
      const dev = countryDev.get(resolved) ?? countryDev.get(tag) ?? 0;
      if (!(dev > 0)) continue;
      leaderRows.push({
        tag,
        name: displayName(tag),
        color: countryColorRaw(resolved),
        score: Number.isFinite(score) ? score : 0,
        dev: Math.round(dev),
        capital: provinces.get(capitalId)?.name ?? '',
        religion: localise(countryScalar(country, 'religion')),
        income: Number(countryScalar(country, 'estimated_monthly_income') ?? '0') || 0,
        army: armyByTag.get(tag) ?? 0,
      });
    }
    leaderRows.sort((a, b) => b.score - a.score || b.dev - a.dev);

    const leaderHtml = leaderRows
      .slice(0, 15)
      .map(
        (row, index) =>
          `<tr><td class="num">${index + 1}</td>` +
          // `data-tag` lets the client repaint this colour when the colour mode changes.
          `<td><span class="sw" data-tag="${htmlEscape(row.tag)}" style="background:${toHex(row.color)}"></span>` +
          `<img class="flag" data-tag="${htmlEscape(row.tag)}" alt="" onerror="this.style.display='none'">` +
          `${htmlEscape(row.name)}</td>` +
          `<td class="tag">${row.tag}</td>` +
          `<td class="num">${row.score.toFixed(1)}</td>` +
          `<td class="num">${row.dev.toLocaleString()}</td>` +
          `<td>${htmlEscape(row.capital)}</td>` +
          `<td>${htmlEscape(row.religion)}</td>` +
          `<td class="num">${row.income.toFixed(1)}</td>` +
          `<td class="num">${row.army.toLocaleString()}</td></tr>`,
      )
      .join('\n');

    const cityHtml = [...provinces.values()]
      .map((province) => ({ province, dev: provinceDev.get(province.id) ?? 0 }))
      .filter((entry) => entry.dev > 0)
      .sort((a, b) => b.dev - a.dev)
      .slice(0, 15)
      .map((entry, index) => {
        const owner = entry.province.owner;
        const ownerName =
          owner && owner !== '---' ? localise(resolveTag(aliases, owner, saveOrdinal)) : '';
        return (
          `<tr><td class="num">${index + 1}</td>` +
          `<td>${htmlEscape(entry.province.name ?? '')}</td>` +
          `<td class="num">${Math.round(entry.dev)}</td>` +
          `<td>${htmlEscape(localise(entry.province.religion))}</td>` +
          `<td>${htmlEscape(ownerName)} <span class="tag">${owner ?? ''}</span></td></tr>`
        );
      })
      .join('\n');

    const institutionHtml = (() => {
      const originNode = doc.readSection('institution_origin');
      const foundedNode = doc.readSection('institutions');
      const ids =
        originNode && originNode.type === 'list'
          ? originNode.items.map((i) => Number(i.type === 'scalar' ? i.value : '0'))
          : [];
      const founded =
        foundedNode && foundedNode.type === 'list'
          ? foundedNode.items.map((i) => Number(i.type === 'scalar' ? i.value : '0'))
          : [];
      return INSTITUTIONS.map((institution, index) => {
        const provinceId = ids[index] ?? 0;
        const province = provinceId > 0 ? provinces.get(provinceId) : undefined;
        return (
          `<tr><td>${index + 1}</td><td>${htmlEscape(institution.zh)}</td>` +
          `<td>${htmlEscape(province?.name ?? '—')}</td>` +
          `<td>${province ? `<span class="tag">#${provinceId}</span>` : ''}</td>` +
          `<td>${founded[index] ? '<span class="ok">已诞生</span>' : '<span class="no">未出现</span>'}</td></tr>`
        );
      }).join('\n');
    })();

    /** Header facts the page prints around the map. Names must match viewer.html's
     *  `data-fact` attributes; numbers arrive pre-formatted because the client sets
     *  them as text and 1,562 reads better than 1562. */
    const header = {
      title: doc.meta.displayedCountryName ?? '',
      start,
      end: doc.meta.date,
      frames: months.length.toLocaleString(),
      provinces: stats.provincesWithHistory.toLocaleString(),
      events: stats.eventCount.toLocaleString(),
      width: map.width,
      height: map.height,
      firstMonth: months[0]?.date ?? '',
      lastIndex: months.length - 1,
      seaHex: toHex(SEA),
      unownedHex: toHex(UNOWNED),
    };

    return { leaderHtml, cityHtml, institutionHtml, header, leaders: leaderRows.slice(0, 15) };
  })();

  /**
   * The three colour modes, built once the tag table is complete.
   *
   * A country that is a subject **now** takes the overlord's colour only from the date
   * the relation began — that is the one piece of colour history the save actually
   * records (`dependency/start_date`). Before that date it shows its own colour.
   *
   * One rule decides who follows whom: the split is by **distance**, not by a
   * hand-picked percentage, so a near-white overlord and a nearly black one both
   * produce a subject the same perceptual distance from themselves. See
   * `packages/eu4-parser/src/colours.ts`.
   */
  const colourModes = (() => {
    const count = registry.list.length;
    const original = new Array(count);
    const mod = new Array(count);
    const subject = new Array(count);
    /** The colour the save records for the tag, packed; `undefined` when it has none. */
    const ownColours = new Array(count);
    const from = new Array(count).fill(-1);

    const ledger = readSubjectLedger(doc);

    /**
     * Who takes whose colour.
     *
     * The dependency ledger is the authority: it holds every relation that still
     * exists, so a country that has *become independent* is simply absent and keeps
     * its own colour — there is no "independence date" to be found anywhere, and
     * none is invented. `colonial_parent` only fills one gap: a colony the save does
     * not list as a dependency (the game writes no row for a colonial record whose
     * mother country holds no province of its own). Both ends must own land for that
     * fallback to fire, so a dormant colonial record is left alone.
     */
    const landed = new Set();
    for (const province of provinces.values()) if (province.owner) landed.add(province.owner);

    const overlordOf = new Map();
    for (const [tag, relation] of ledger.relations) overlordOf.set(tag, relation.overlord);
    const excluded = new Set(ledger.excluded.map((relation) => relation.subject));
    for (const [tag, country] of countries) {
      if (overlordOf.has(tag) || excluded.has(tag) || !landed.has(tag)) continue;
      const parent = countryScalar(country, 'colonial_parent');
      if (parent && landed.has(parent)) overlordOf.set(tag, parent);
    }

    /** The ΔE target of every subject, spread within its family in tag order. */
    const targets = new Map();
    const families = new Map();
    for (const [tag, overlord] of overlordOf) {
      if (!families.has(overlord)) families.set(overlord, []);
      families.get(overlord).push(tag);
    }
    for (const members of families.values()) {
      for (const [member, target] of familyTargets(members)) targets.set(member, target);
    }
    const midBand = (SUBJECT_SHADE.low + SUBJECT_SHADE.high) / 2;

    for (let index = 0; index < count; index += 1) {
      const tag = registry.list[index];
      const country = countries.get(tag);
      const recorded = recordedColourOf(country);
      let own = recorded;
      if (!own) {
        // No colour in the save, or only the engine's placeholder: a colonial nation
        // is then a shade of its mother country's *own* colour. Using `map_color`
        // here would drag the recolouring mod's result into 原始色.
        const parent = country ? countryScalar(country, 'colonial_parent') : undefined;
        const parentCountry = parent ? countries.get(parent) : undefined;
        own = parentCountry
          ? shadeRgb(recordedColourOf(parentCountry) ?? countryColorOf(parentCountry, parent, hashColor), targets.get(tag) ?? midBand)
          : countryColorOf(country, tag, hashColor);
      }
      original[index] = packRgb(...own);
      // `recorded` stays `undefined` for a placeholder, which is what the leftover-tint
      // test needs: a country with no colour of its own cannot be showing one.
      ownColours[index] = recorded ? packRgb(...recorded) : undefined;
      mod[index] = tagColors[index] ?? packRgb(...countryColorOf(country, tag, hashColor));
      subject[index] = mod[index];
    }

    for (const [tag, overlord] of overlordOf) {
      const subjectIndex = registry.index.get(tag);
      const overlordIndex = registry.index.get(overlord);
      if (subjectIndex === undefined || overlordIndex === undefined) continue;
      subject[subjectIndex] = packRgb(...shadeRgb(unpackRgb(mod[overlordIndex]), targets.get(tag) ?? midBand));
      from[subjectIndex] = ledger.relations.get(tag)?.ordinal ?? campaignStartOrdinal;
    }

    /**
     * Countries drawn in somebody else's own colour although they are not a 属国
     * (`foreignTintFlags`): an ended subjection, or a 朝贡国 the mods painted as one.
     *
     * Only 属国染色 uses these: it hands such a country its own colour back instead of
     * one that claims a relationship the mode does not acknowledge.
     */
    const foreignTint = foreignTintFlags({
      own: ownColours,
      drawn: mod,
      subject: registry.list.map((tag) => overlordOf.has(tag)),
      landed: registry.list.map((tag) => landed.has(tag)),
    });
    for (let index = 0; index < count; index += 1) if (foreignTint[index]) subject[index] = original[index];

    return {
      original,
      mod,
      subject,
      from,
      foreignTint,
      subjects: overlordOf.size,
      types: Object.fromEntries(ledger.types),
    };
  })();

  const data = {
    w: map.width,
    h: map.height,
    scale,
    start,
    end: doc.meta.date,
    months: months.map((m) => m.ordinal),
    monthLabels: months.map((m) => m.date),
    provinceFields: [...PROVINCE_FIELDS],
    provinceDicts: PROVINCE_FIELDS.map((f) => provinceDicts.get(f).dict),
    provinceInit: provincePlane.initRows,
    provinceEvents: provincePlane.eventRows,
    countryFields: [...COUNTRY_FIELDS],
    countryDicts: COUNTRY_FIELDS.map((f) => countryDicts.get(f).dict),
    countryInit: [],
    countryEvents: countryPlane.eventRows,
    /** [year*12+month-1, provinceId, contribution×100, attackerTag, defenderTag, losses, naval] */
    battles: battleRows,
    /** Total adm+dip+mil tech per tag index; a snapshot, not a series. */
    tagTech,
    /** [provinceId, embracedCount, embracingIndex] — likewise a snapshot. */
    provinceInstitutions,
    tags: registry.list,
    tagColors: tagColors.map((c) => c ?? 0),
    /**
     * The three colour modes, one packed colour per tag index.
     *
     * `original` is the country's own `color` (what 原始色 shows), `mod` is what the
     * save actually draws (`map_color`, i.e. the recolouring mod's result), and
     * `subject` is the 属国染色 colour, ΔE 8–14 from the overlord's. A country whose
     * `color` is the engine's `255 255 255` placeholder — a colonial nation — has its
     * `original` derived from its mother country instead. `from` is the ordinal a
     * subjection began: a subject only takes the new colour from then on, and a
     * country that is independent now already carries its own colour in the save, so
     * independence needs no date of its own. `foreignTint` is 1 for a country that draws
     * somebody else's own colour while being no 属国 of ours (`foreignTintFlags`): 属国染色
     * gives it its own colour back, 模组色 still draws what the save says.
     */
    colours: colourModes,
    tagAlias,
    countryNames: registry.list.map((tag) => displayName(tag)),
    religions: religionDict,
    religionColors: religionDict.map((r) => packRgb(...religionColorOf(r))),
    cultures: cultureDict,
    cultureColors: cultureDict.map((c) => packRgb(...cultureColorOf(c))),
    dynasties: dynastyDict,
    dynastyColors,
    /**
     * Colonial nations and their mother country. `colonial_parent` is the real
     * relationship (36 countries); `overlord` also covers vassals and junior
     * partners in a personal union (50), which must NOT be drawn as colonies.
     */
    colonialParent: (() => {
      const out = {};
      for (const [tag, country] of countries) {
        const parent = countryScalar(country, 'colonial_parent');
        if (parent) out[tag] = parent;
      }
      return out;
    })(),
    /** Holy Roman Empire: dated emperor changes, plus today's roles. */
    hre: hreInfo,
    /** Top-12 development / province-count series, one sample per month. */
    curves,
    provinceNames: [...provinces.keys()].map((id) => provinces.get(id)?.name ?? ''),
    provinceIds: [...provinces.keys()],
    /**
     * The detail-panel tables (省份国家界面阶段任务书 §2): province extras read out of
     * the province blocks, plus the country panel's wave-1 scalars. Built by the shared
     * `buildDetailTables`, which `render-timeline.ts` calls at the same point so the
     * two planes agree key for key.
     */
    provinceBuildings: detailTables.provinceBuildings,
    provinceCores: detailTables.provinceCores,
    provinceClaims: detailTables.provinceClaims,
    provinceGreatProjects: detailTables.provinceGreatProjects,
    provinceTradeGoods: detailTables.provinceTradeGoods,
    provinceLatentTradeGoods: detailTables.provinceLatentTradeGoods,
    provinceImprove: detailTables.provinceImprove,
    /** `-1` for a province with no terrain; the dictionary comes from S2's table. */
    provinceTerrain: detailTables.provinceTerrain,
    provinceArea: detailTables.provinceArea,
    areaDetail: detailTables.areaDetail,
    provinceDevastation: detailTables.provinceDevastation,
    provinceTradeCompany: detailTables.provinceTradeCompany,
    countryDetail: detailTables.countryDetail,
    /**
     * S2's `uiNames.json` baked into the plane, plus the two shapes the panel code
     * indexes directly. `cultureNames` runs parallel to `cultures` (the panel knows a
     * culture's dictionary slot, not its key); `personalityNames` is the personality map
     * itself, because the save keeps personalities as free-standing keys.
     */
    uiNames,
    cultureNames,
    personalityNames,
    /**
     * 波 3 的槽位名表（19 收入 / 38 支出 / 46 点数）：`countryDetail[tag].budget` 与
     * `.manaSpent` 的数组下标与它们一一对应。
     */
    ledgerSlots: detailTables.ledgerSlots,
    manaSlots: detailTables.manaSlots,
    /**
     * 历史十五个最优秀将军 / 十五个最优秀君主 (第四对话任务书 §3.4): the two boards plus the
     * weights, floors and measured war-record coverage the pages print.
     */
    rankings: detailTables.rankings,
    waterSea: [...water.sea],
    waterLakes: [...water.lakes],
    constants: {
      sea: packRgb(...SEA),
      lake: packRgb(...LAKE),
      unowned: packRgb(...UNOWNED),
      none: packRgb(...NO_PROVINCE),
      stripePeriod: STRIPE_PERIOD,
      stripeWidth: STRIPE_WIDTH,
      maxDev: Math.max(1, ...[...provinces.values()].map((p) => (p.baseTax ?? 0) + (p.baseProduction ?? 0) + (p.baseManpower ?? 0))),
      maxBattleScore,
      maxNavalScore,
      techMin,
      techMax,
      instMin,
      instMax,
      /** Empire role colours, read by the client as C.hre.*. */
      hre: {
        emperor: packRgb(...HRE_COLORS.emperor),
        elector: packRgb(...HRE_COLORS.elector),
        freeCity: packRgb(...HRE_COLORS.freeCity),
        member: packRgb(...HRE_COLORS.member),
        foreign: packRgb(...HRE_COLORS.foreign),
      },
    },
    peak: { month: bestMonth, occupied: bestCount },
  };

  /**
   * The catalogue card's own image: the political map on the campaign's last day.
   *
   * `raster.png` is province *ids* rather than a picture and the `peak-*` frames are the
   * most-occupied month, so the card needs a frame of its own. It replays the corrected
   * province plane — the same rows the viewer replays — instead of the raw timeline, so
   * the stale occupations the corrections exist to remove are not drawn. The palette is
   * `colours.mod`, which is what the viewer's political view shows by default.
   *
   * `scripts/render-timeline.ts` builds the same file offline and repeats this replay on
   * purpose: the two data planes are independent implementations of one thing, and
   * `viewer-build.test.ts` keeps the rows they replay identical key by key.
   */
  const thumb = (() => {
    const count = 65_536;
    const ownerById = new Int16Array(count).fill(-1);
    const controllerById = new Int16Array(count).fill(-1);
    const ownerField = provinceFieldIdx.get('owner');
    const controllerField = provinceFieldIdx.get('controller');
    const apply = (id, field, value) => {
      if (field === ownerField) ownerById[id] = value;
      else if (field === controllerField) controllerById[id] = value;
    };
    for (const row of provincePlane.initRows) apply(row[0], row[1], row[2]);
    for (const row of provincePlane.eventRows) {
      // The log is sorted and the corrections sit at the save date, so the first row
      // past it ends the replay.
      if (row[0] > saveOrdinal) break;
      apply(row[1], row[2], row[3]);
    }

    const palette = data.colours.mod;
    /** The colour a tag is drawn with on the last day (date-aware, like the viewer). */
    const colourAt = (tagIdx) => {
      const resolved = resolveTag(aliases, registry.list[tagIdx], saveOrdinal);
      const index = registry.index.get(resolved);
      return index === undefined ? packRgb(...countryColorRaw(resolved)) : palette[index];
    };
    /** Identity, not the tag of the day: a renamed country cannot occupy itself. */
    const latest = (tagIdx) => registry.index.get(resolveTagLatest(aliases, registry.list[tagIdx])) ?? tagIdx;

    const base = new Uint32Array(count);
    const hatch = new Uint32Array(count);
    base.fill(packRgb(...UNOWNED));
    base[0] = packRgb(...NO_PROVINCE);
    for (const id of water.sea) base[id] = packRgb(...SEA);
    for (const id of water.lakes) base[id] = packRgb(...LAKE);
    for (const province of provinces.values()) {
      const id = province.id;
      if (water.sea.has(id) || water.lakes.has(id)) continue;
      const ownerIdx = ownerById[id];
      const controllerIdx = controllerById[id];
      base[id] = ownerIdx >= 0 ? colourAt(ownerIdx) : packRgb(...UNOWNED);
      if (ownerIdx >= 0 && controllerIdx >= 0 && latest(ownerIdx) !== latest(controllerIdx)) {
        hatch[id] = colourAt(controllerIdx);
      }
    }
    return { base, hatch, ordinal: saveOrdinal };
  })();

  return {
    data,
    /** Packed colours per province id for the card thumbnail (see above). */
    thumb,
    raster: { rgb, width: map.width, height: map.height },
    panels,
    diagnostics: {
      provinces: timeline.provinces.size,
      events: timeline.events.length,
      countries: countries.size,
      tags: registry.list.length,
      wars: wars.length,
      battles: battleRows.length,
      controllerCorrections: provincePlane.corrected,
      rebelCleared: provincePlane.rebelCleared,
      countryCorrections: countryPlane.corrected,
      officialReligions: officialReligions?.size ?? 0,
      unmatchedPixels: map.unmatched ?? 0,
    },
  };
}

/** Re-exported so the page imports one module for the whole data plane. */
export { CountryTimelinePlayer, TimelinePlayer };
