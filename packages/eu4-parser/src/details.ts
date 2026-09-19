/**
 * The detail tables: the province extras and the country panel's wave-1 scalars.
 *
 * Both data planes (`scripts/render-timeline.ts` offline and
 * `apps/site/public/viewer-build.js` in the browser) call this one module, and it is
 * bundled into `apps/site/public/eu4-parser.js` by `scripts/build-browser-parser.ts`.
 * The rest of the two planes is deliberately written twice; these ~800 lines of frozen
 * schema (省份国家界面阶段任务书 §2) are not, because the province panel and the
 * country panel are their only readers and a second hand-maintained copy would only be
 * a place for the two planes to disagree.
 *
 * Everything here is derived from the save plus three *static* tables published by the
 * game-file conversation (`apps/site/public/assets/ui/*.json`). Those arrive as raw
 * JSON **text** so the offline `readFileSync` path and the browser `fetch` path
 * normalise them through exactly the same code. A missing table is not an error: the
 * matching key is simply empty and the panel falls back to the raw game key.
 *
 * Rules the panels depend on:
 *
 *  1. **Never invent a value.** A field the save does not record is `0` / `''` / `[]` /
 *     `null`, never a guess (see `absolutism` and `cultureStats.group`).
 *  2. **Every table is ordered deterministically** — dictionaries sorted, rows by
 *     province id, `countryDetail` keys by tag — because the two planes are compared
 *     with `JSON.stringify`.
 *  3. **Tag indices come from the caller's registry** (`tagId`), so a tag mentioned
 *     only here (a claim holder, a trade-company investor) still gets a colour entry in
 *     the plane's tag table. This therefore has to run *before* each plane freezes
 *     `tagColors`, which both planes do right after packing their event rows.
 */

import { ClausewitzReader, type Member } from './clausewitz.ts';
import type { SaveDocument } from './document.ts';
import { parseGameDate, toNumber } from './value.ts';
import {
  buildTagAliases,
  buildTimeline,
  ordinalToDate,
  resolveTagLatest,
  type GameTimeline,
  type TagAlias,
} from './timeline.ts';
import type { ProvinceRecord } from './types.ts';
import type { BattleSide, War } from './wars.ts';

const DATE_KEY = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/;

// --------------------------------------------------------------------- types ---

/** Raw JSON text of the static tables; any of them may be absent. */
export interface DetailTableTexts {
  /** `assets/ui/uiNames.json`: key -> 中文名, per category. */
  uiNames?: string;
  /** `assets/ui/provinceTerrain.json`: `{ byId, dict }`. */
  provinceTerrain?: string;
  /** `assets/ui/area.json`: `{ byId, names, dict }`. */
  area?: string;
  /**
   * `assets/ui/advisorIds.json`: the 21 *base-game* advisor type keys -> 中文名. The
   * keys are the id list the 顾问 tab iterates (a type only shows once the country has
   * a flag of that name), and the values are the name fallback behind
   * `uiNames.advisors`.
   */
  advisorIds?: string;
  /** `assets/ui/ledgerSlots.json`: the 19 income / 38 expense slot names (阶段 3). */
  ledgerSlots?: string;
  /** `assets/ui/manaSlots.json`: the 46 mana-spend slot names (阶段 3). */
  manaSlots?: string;
}

/** One ledger / mana slot: the machine key plus its baked Chinese name. */
export interface SlotName {
  key: string;
  name: string;
}

/** One budget interval, arrays already padded to the frozen 19 / 38 slots. */
export interface BudgetPeriod {
  /** `'last-month'` / `'ytd'` / `'last-year'` — pdx-tools' own three interval ids. */
  period: string;
  /** 19 slots, positional: index = the ledger slot's `index`. */
  income: number[];
  /** 38 slots, likewise. */
  expense: number[];
  incomeTotal: number;
  expenseTotal: number;
  /** `incomeTotal − expenseTotal`. */
  net: number;
}

export interface CountryBudget {
  periods: BudgetPeriod[];
  /** The all-time expense table (38 slots) — the expense tree's percentages need it. */
  totalExpense: number[];
  /** `last_months_recurring_income` / `_expenses`, the waterfall's recurring bars. */
  recurringIncome: number;
  recurringExpense: number;
}

export interface CountryManaSpent {
  /** 46 slots each, positional; a slot the country never used is 0. */
  adm: number[];
  dip: number[];
  mil: number[];
}

export interface ProvinceBuildingsTable {
  dict: string[];
  names: string[];
  /** `[[provId, keyIdx…]…]`, only the provinces that have buildings. */
  rows: number[][];
  /** Aligned with `rows`: the tag that paid for each entry, `''` when unknown. */
  builders: string[][];
}

export interface ProvinceTagRowsTable {
  /** Every tag index the rows mention (sorted). The rows carry indices directly. */
  dict: number[];
  rows: number[][];
}

export interface ProvinceNamesTable {
  dict: string[];
  names: string[];
  rows: number[][];
}

export interface ProvinceIndexTable {
  dict: string[];
  names: string[];
  /** By province id; values index `dict`, `-1` = none. */
  byId: number[];
}

export interface AreaDetailEntry {
  /** `map_area_data`: one per country holding the area as a state. */
  states: Array<{ tagIdx: number; prosperity: number }>;
  /** `map_area_data`: trade-company investments, one entry per company owner. */
  investments: Array<{ tagIdx: number; icons: string[] }>;
}

export interface CountryHistoryRow {
  date: string;
  ordinal: number;
  kind: string;
  text: string;
  tag?: string;
  provId?: number;
  payload?: number;
}

export interface CountryMonarch {
  name: string;
  dynasty: string;
  adm: number;
  dip: number;
  mil: number;
  age: number;
  culture: string;
  religion: string;
  inaugurated: string;
  /** Real traits only — the `personalities` block of the save's character record. */
  personalities: string[];
  /**
   * The character's `ruler_flags` block: event / decision markers such as
   * `has_lowborn_consort` or `me_flag_sonofaconcubine_11`. They used to be merged into
   * `personalities`, which is why the panel's 性格 column showed English event keys as
   * if they were traits (第四对话任务书 §2.2).
   */
  flags: string[];
}

export interface CountryRuler {
  name: string;
  start: string;
  end: string;
  months: number;
  personalities: string[];
  /** See `CountryMonarch.flags`. */
  flags: string[];
  adm: number;
  dip: number;
  mil: number;
}

export interface CountryFailedHeir {
  name: string;
  birth: string;
  personalities: string[];
  /** See `CountryMonarch.flags`. */
  flags: string[];
  adm: number;
  dip: number;
  mil: number;
}

export interface CountryLeader {
  name: string;
  kind: string;
  active: boolean;
  activation: string;
  fire: number;
  shock: number;
  maneuver: number;
  siege: number;
}

export interface CountryIdeaGroup {
  group: string;
  unlocked: number;
  total: number;
}

export interface CountryCultureStat {
  culture: string;
  /** Culture groups live in `common/cultures`, which the data plane cannot read. */
  group: string;
  provinces: number;
  dev: number;
  statedProvinces: number;
  statedDev: number;
}

export interface CountryDetailRecord {
  powers: number[];
  treasury: number;
  debt: number;
  inflation: number;
  prestige: number;
  stability: number;
  powerProjection: number;
  innovativeness: number;
  corruption: number;
  governmentStrengthKind: string;
  governmentStrength: number;
  government: string;
  governmentRank: number;
  governmentReforms: string[];
  development: number;
  rawDevelopment: number;
  autonomyPercent: number;
  cities: number;
  overextension: number;
  religiousUnity: number;
  absolutism: number | null;
  mercantilism: number;
  splendor: number;
  tech: number[];
  envoys: { merchants: number; colonists: number; diplomats: number; missionaries: number };
  religion: string;
  primaryCulture: string;
  /** Added on top of 阶段任务书 §2 because the 总览/外交区 and the phase-1 acceptance
   *  list need them: 附属国 / 宿敌 / 正在交战 come straight from §1.3's field list. */
  dominantCulture: string;
  acceptedCultures: string[];
  rivals: string[];
  allies: string[];
  subjects: string[];
  atWar: string[];
  overlord: string;
  colonialParent: string;
  sailors: number;
  countryId: number;
  /** 步兵 / 骑兵 / 炮兵 / 雇佣（团）. */
  army: number[];
  /** 重型 / 轻型 / 桨帆 / 运输（艘）. */
  navy: number[];
  manpower: number;
  /** 缺员补员量（千人）：Σ(1 − strength) over every land regiment. */
  reinforce: number;
  maxManpower: number;
  /** Estimated from the morale the save keeps on units; `null` = 存档未记录。 */
  landMorale: number | null;
  navalMorale: number | null;
  professionalism: number;
  armyTradition: number;
  navyTradition: number;
  ideas: CountryIdeaGroup[];
  monarch: CountryMonarch | null;
  rulers: CountryRuler[];
  failedHeirs: CountryFailedHeir[];
  leaders: CountryLeader[];
  bestGeneral: CountryLeader | null;
  bestAdmiral: CountryLeader | null;
  religionDev: Record<string, number>;
  cultureStats: CountryCultureStat[];
  history: CountryHistoryRow[];
  // ---- 波 2：建筑 / 州 / 阶级 / 顾问 ----
  /** 该国省份拥有的建筑统计（从各省 `buildings` 按拥有国现算，**不用**存档的 `num_of_buildings_indexed`）。 */
  buildingCount: Array<{ building: string; provinces: number }>;
  states: Array<{
    /** 地区 key（如 `ostra_svealand_area`）。 */
    area: string;
    /** 地区中文名（来自 S2 的表；缺名给 `''`）。 */
    name: string;
    /** 该州属于本国的省份发展度之和。 */
    dev: number;
    capitalState: boolean;
    prosperity: number;
    /** `'prospering'` / `'declining'` / `''`（＝pdx-tools 的 Some(true)/Some(false)/None）。 */
    prosperityMode: string;
    stateHouse: boolean;
  }>;
  estates: Array<{
    /**
     * The save's own estate type, e.g. `estate_church` — **not** the trimmed `church`,
     * because that is the key `uiNames.estates` is published under (教士/贵族/…).
     */
    kind: string;
    loyalty: number;
    territory: number;
    agendas: number;
    /** `name` is the game key, looked up in `uiNames.estatePrivileges`. */
    privileges: Array<{ name: string; since: string }>;
    /** `name` is the `EST_VAL_…` key, looked up in `uiNames.estateInfluenceModifiers`. */
    influences: Array<{ name: string; value: string; expires: string }>;
  }>;
  /** 王室领地 ＝ 100 − Σ(estate.territory)（存档里没有这个标量，与 pdx-tools 同算法）。 */
  crownland: number;
  /** 已触发的名臣顾问：类型 key、中文名、触发日期（按日期、id 排序）。 */
  advisors: Array<{ id: string; name: string; date: string }>;
  // ---- 波 3：财政 / 点数 ----
  /**
   * 三个区间（上月 / 年初至今 / 去年）＋ 全时段支出表；
   * `income`/`expense` 的下标就是 S2 `ledgerSlots.json` 的槽位下标（19 / 38）。
   */
  budget: CountryBudget;
  /** 三系点数花了多少，按 `manaSlots.json` 的 46 个槽位下标对齐。 */
  manaSpent: CountryManaSpent;
}

// ---------------------------------------------- the two rankings (第四对话任务书 §3.4) ---

/** One general on the 历史十五个最优秀将军 board. */
export interface RankingGeneral {
  /** The **final** tag (identity): a renamed country keeps one line. */
  tag: string;
  name: string;
  /** `general` / `conquistador` / `admiral` / `explorer`. */
  kind: string;
  fire: number;
  shock: number;
  maneuver: number;
  siege: number;
  /** `fire + shock + maneuver + siege` (0..24). */
  skill: number;
  /** Battles attributed to this `(tag, name)`. */
  battles: number;
  wins: number;
  /** `wins / battles`, 0..1. */
  winRate: number;
  /** Enemy losses caused, summed over the attributed battles. */
  kills: number;
  /** Own losses, likewise. */
  taken: number;
  /** `kills − taken`. */
  net: number;
  /** 0..100, one decimal. */
  score: number;
  /** The three normalised components, each 0..1 and already clamped. */
  parts: { skill: number; war: number; win: number };
}

/** One monarch on the 十五个最优秀君主 board. */
export interface RankingMonarch {
  tag: string;
  name: string;
  adm: number;
  dip: number;
  mil: number;
  /** `adm + dip + mil` (0..18). */
  stats: number;
  start: string;
  /** `''` while the ruler is still on the throne. */
  end: string;
  months: number;
  /** Owned-province development at `start` / `end` (same replay as the 兴衰曲线). */
  devStart: number;
  devEnd: number;
  /** `devEnd − devStart`; may be negative. */
  devGain: number;
  /** `devGain / (months / 12)`. */
  devPerYear: number;
  /** Owned-province count difference; display only, never scored. */
  provincesGain: number;
  score: number;
  parts: { ability: number; tenure: number; growth: number; pace: number };
}

export interface RankingsMeta {
  /** Generals with ≥ 1 attributable battle — the set the 0..1 normalisation uses. */
  generalPool: number;
  /** Of those, the ones that clear `floors.minBattles`. */
  generalQualified: number;
  /** Monarchs left after all three exclusion rules — the normalisation set. */
  monarchPool: number;
  weights: {
    general: { skill: number; war: number; win: number };
    monarch: { ability: number; tenure: number; growth: number; pace: number };
  };
  floors: { minBattles: number; minReignMonths: number };
  /** How much of the war record the join actually covers. Never claim 全量. */
  coverage: {
    /** Battle sides that name a commander. */
    commandedSides: number;
    /** Of those, the ones whose `(最终国号, 姓名)` matched a leader record. */
    joinedSides: number;
    /** Distinct final tags that appear in a battle side. */
    resolvedTags: number;
    /** Of those, the tags for which a leader record exists. */
    tagsWithLeaders: number;
  };
}

export interface Rankings {
  meta: RankingsMeta;
  /** ≤ 15 entries, `score` descending. */
  generals: RankingGeneral[];
  /** ≤ 15 entries, `score` descending. */
  monarchs: RankingMonarch[];
}

export interface ProvinceTables {
  provinceBuildings: ProvinceBuildingsTable;
  /** 核心：与 `provinceClaims` 同形，行里直接是 tag 下标。 */
  provinceCores: ProvinceTagRowsTable;
  provinceClaims: ProvinceTagRowsTable;
  provinceGreatProjects: ProvinceNamesTable;
  /** 贸易品：与 `provinceLatentTradeGoods` 同形（存档的 `trade_goods`）。 */
  provinceTradeGoods: { dict: string[]; rows: number[][] };
  provinceLatentTradeGoods: { dict: string[]; rows: number[][] };
  provinceImprove: ProvinceTagRowsTable;
  provinceTerrain: ProvinceIndexTable;
  provinceArea: ProvinceIndexTable;
  provinceDevastation: number[];
  provinceTradeCompany: number[];
}

export interface DetailTables extends ProvinceTables {
  /**
   * `{ [areaIdx]: … }` — the key is **`provinceArea.byId[provId]` rendered as a
   * string** (the area's index into `provinceArea.dict`), which is exactly how the
   * client looks it up. Areas no province names simply have no entry.
   */
  areaDetail: Record<string, AreaDetailEntry>;
  countryDetail: Record<string, CountryDetailRecord>;
  /**
   * S2's `assets/ui/uiNames.json`, baked in so a panel never has to fetch a file at
   * runtime (the offline self-contained page cannot). `{ [family]: { key: 中文名 } }`,
   * every family in `UI_NAME_FAMILIES` always present (empty until the table reaches
   * it) plus any further family the file grows. The raw text already arrives here as
   * `tables.uiNames`, which is why the bake lives in this module.
   */
  uiNames: Record<string, Record<string, string>>;
  /**
   * The ledger / mana slot names, baked once for the whole plane (阶段任务书 §2 波 3:
   * 槽位名来自 S2 的枚举表). Kept **positional** — `ledgerSlots.income[i]` belongs to
   * every country's `budget.periods[*].income[i]` — so re-ordering S2's file cannot
   * silently shift a name onto the wrong number.
   */
  ledgerSlots: { income: SlotName[]; expense: SlotName[] };
  manaSlots: SlotName[];
  /**
   * 历史十五个最优秀将军 / 十五个最优秀君主 (第四对话任务书 §3.4): the two boards plus the
   * weights, floors and measured war-record coverage the pages print. Always present —
   * the boards may be shorter than 15, but a key is never missing.
   */
  rankings: Rankings;
}

export interface DetailInput {
  doc: SaveDocument;
  provinces: Map<number, ProvinceRecord>;
  /** The plane's tag registry — indices must match its `tags` array. */
  tagId: (tag: string) => number;
  /** The save's date (`doc.meta.date`). */
  saveDate: string;
  /** The campaign's first frame; only the History tab uses it. */
  startDate?: string;
  /** The wars the plane already extracted; only the History tab uses them. */
  wars?: readonly War[];
  tables?: DetailTableTexts | null;
  /**
   * The plane's `buildTimeline()` result. The monarch board's 在位发展度 needs a monthly
   * ownership replay, and both planes already hold this object when they call in; the
   * single shared implementation lives here (第四对话任务书 §3.5). Absent (only an ad-hoc
   * probe) it is rebuilt from `doc`, never guessed.
   */
  timeline?: GameTimeline;
}

// ------------------------------------------------------------ static tables ---

interface NormalisedTables {
  buildingNames: Record<string, string>;
  greatProjectNames: Record<string, string>;
  terrainNames: Record<string, string>;
  terrainById: Map<number, string>;
  terrainDict: string[];
  areaById: Map<number, string>;
  areaNames: Record<string, string>;
  areaDict: string[];
}

function jsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A half-written table must not take the whole build down.
  }
  return {};
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string') out[key] = item;
    }
  }
  return out;
}

/** `{ key: name }`, or a `names` array aligned with the table's own `dict`. */
function namesAlignedWithDict(raw: Record<string, unknown>): Record<string, string> {
  const out = stringMap(raw['names']);
  const dict = stringArray(raw['dict']);
  const aligned = stringArray(raw['names']);
  for (let i = 0; i < dict.length && i < aligned.length; i += 1) {
    const key = dict[i];
    const name = aligned[i];
    if (key && name) out[key] = name;
  }
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** `{ byId: { "1": key } }`, or the flat `{ "1": key }` form. */
function provinceKeyMap(raw: Record<string, unknown>, name: string): Map<number, string> {
  const nested = raw[name];
  const flat =
    Object.keys(raw).length > 0 && Object.keys(raw).every((key) => /^\d+$/.test(key)) ? raw : {};
  const source =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : flat;
  const out = new Map<number, string>();
  for (const [key, value] of Object.entries(source)) {
    const id = Number(key);
    if (!Number.isInteger(id) || typeof value !== 'string' || value === '') continue;
    out.set(id, value);
  }
  return out;
}

/** A dictionary built from the table's own `dict`, extended with anything missing. */
function withExtras(dict: readonly string[], used: Iterable<string>): string[] {
  const out = [...dict];
  const seen = new Set(out);
  const extras: string[] = [];
  for (const value of used) if (!seen.has(value)) extras.push(value);
  extras.sort();
  for (const value of extras) out.push(value);
  return out;
}

function normaliseTables(tables: DetailTableTexts | null | undefined): NormalisedTables {
  const names = jsonObject(tables?.uiNames);
  const terrainRaw = jsonObject(tables?.provinceTerrain);
  const areaRaw = jsonObject(tables?.area);

  const terrainById = provinceKeyMap(terrainRaw, 'byId');
  const areaById = provinceKeyMap(areaRaw, 'byId');

  return {
    buildingNames: stringMap(names['buildings']),
    greatProjectNames: stringMap(names['greatProjects']),
    terrainNames: stringMap(names['terrain']),
    terrainById,
    terrainDict: withExtras(stringArray(terrainRaw['dict']), terrainById.values()),
    areaById,
    areaNames: { ...namesAlignedWithDict(areaRaw), ...stringMap(areaRaw['areaNames']) },
    areaDict: withExtras(stringArray(areaRaw['dict']), areaById.values()),
  };
}

// ---------------------------------------------------------- province extras ---

function provinceTables(
  provinces: Map<number, ProvinceRecord>,
  tagId: (tag: string) => number,
  tables: NormalisedTables,
): ProvinceTables {
  const ids = [...provinces.keys()];
  let maxId = 0;
  for (const id of ids) if (id > maxId) maxId = id;
  const size = maxId + 1;

  // Pass 1: the dictionaries. Tag indices are allocated here, in province-id order,
  // so both planes hand out the same numbers.
  const buildingKeys = new Set<string>();
  const greatProjectKeys = new Set<string>();
  const tradeGoodKeys = new Set<string>();
  const latentKeys = new Set<string>();
  const coreTags = new Set<number>();
  const claimTags = new Set<number>();
  const improveTags = new Set<number>();
  for (const id of ids) {
    const record = provinces.get(id) as ProvinceRecord;
    for (const key of record.buildings) buildingKeys.add(key);
    for (const key of record.greatProjects) greatProjectKeys.add(key);
    for (const key of record.latentTradeGoods) latentKeys.add(key);
    if (record.tradeGoods) tradeGoodKeys.add(record.tradeGoods);
    for (const tag of record.cores) if (tag && tag !== '---') coreTags.add(tagId(tag));
    for (const tag of record.claims) if (tag && tag !== '---') claimTags.add(tagId(tag));
    for (const entry of record.countryImprove) if (entry.tag) improveTags.add(tagId(entry.tag));
  }
  const buildingDict = [...buildingKeys].sort();
  const buildingIndex = new Map(buildingDict.map((key, i) => [key, i]));
  const greatProjectDict = [...greatProjectKeys].sort();
  const greatProjectIndex = new Map(greatProjectDict.map((key, i) => [key, i]));
  const latentDict = [...latentKeys].sort();
  const latentIndex = new Map(latentDict.map((key, i) => [key, i]));
  const tradeGoodDict = [...tradeGoodKeys].sort();
  const tradeGoodIndex = new Map(tradeGoodDict.map((key, i) => [key, i]));
  const terrainIndex = new Map(tables.terrainDict.map((key, i) => [key, i]));
  const areaIndex = new Map(tables.areaDict.map((key, i) => [key, i]));

  // Pass 2: the rows, in province-id order.
  const buildingRows: number[][] = [];
  const buildingBuilders: string[][] = [];
  const coreRows: number[][] = [];
  const claimRows: number[][] = [];
  const greatProjectRows: number[][] = [];
  const tradeGoodRows: number[][] = [];
  const latentRows: number[][] = [];
  const improveRows: number[][] = [];
  const devastation: number[] = new Array(size).fill(0) as number[];
  const tradeCompany: number[] = new Array(size).fill(0) as number[];
  const terrainById: number[] = new Array(size).fill(-1) as number[];
  const areaById: number[] = new Array(size).fill(-1) as number[];

  for (const id of ids) {
    const record = provinces.get(id) as ProvinceRecord;
    if (record.buildings.length > 0) {
      const keys = [...new Set(record.buildings)].sort();
      buildingRows.push([id, ...keys.map((key) => buildingIndex.get(key) ?? 0)]);
      buildingBuilders.push(keys.map((key) => record.buildingBuilders[key] ?? ''));
    }
    if (record.cores.length > 0) {
      const tags = [...new Set(record.cores)].filter((tag) => tag && tag !== '---').sort();
      if (tags.length > 0) coreRows.push([id, ...tags.map((tag) => tagId(tag))]);
    }
    if (record.claims.length > 0) {
      const tags = [...new Set(record.claims)].filter((tag) => tag && tag !== '---').sort();
      if (tags.length > 0) claimRows.push([id, ...tags.map((tag) => tagId(tag))]);
    }
    if (record.greatProjects.length > 0) {
      const keys = [...new Set(record.greatProjects)].sort();
      greatProjectRows.push([id, ...keys.map((key) => greatProjectIndex.get(key) ?? 0)]);
    }
    if (record.tradeGoods && tradeGoodIndex.has(record.tradeGoods)) {
      tradeGoodRows.push([id, tradeGoodIndex.get(record.tradeGoods) as number]);
    }
    if (record.latentTradeGoods.length > 0) {
      const keys = [...new Set(record.latentTradeGoods)].sort();
      latentRows.push([id, ...keys.map((key) => latentIndex.get(key) ?? 0)]);
    }
    for (const entry of record.countryImprove) {
      if (!entry.tag) continue;
      improveRows.push([id, tagId(entry.tag), entry.count]);
    }
    if (record.devastation !== undefined) devastation[id] = record.devastation;
    if (record.activeTradeCompany) tradeCompany[id] = 1;
    const terrain = tables.terrainById.get(id);
    if (terrain !== undefined) terrainById[id] = terrainIndex.get(terrain) ?? -1;
    const area = tables.areaById.get(id);
    if (area !== undefined) areaById[id] = areaIndex.get(area) ?? -1;
  }

  return {
    provinceBuildings: {
      dict: buildingDict,
      names: buildingDict.map((key) => tables.buildingNames[key] ?? ''),
      rows: buildingRows,
      builders: buildingBuilders,
    },
    provinceClaims: { dict: [...claimTags].sort((a, b) => a - b), rows: claimRows },
    provinceCores: { dict: [...coreTags].sort((a, b) => a - b), rows: coreRows },
    provinceGreatProjects: {
      dict: greatProjectDict,
      names: greatProjectDict.map((key) => tables.greatProjectNames[key] ?? ''),
      rows: greatProjectRows,
    },
    provinceTradeGoods: { dict: tradeGoodDict, rows: tradeGoodRows },
    provinceLatentTradeGoods: { dict: latentDict, rows: latentRows },
    provinceImprove: { dict: [...improveTags].sort((a, b) => a - b), rows: improveRows },
    provinceTerrain: {
      dict: tables.terrainDict,
      names: tables.terrainDict.map((key) => tables.terrainNames[key] ?? ''),
      byId: terrainById,
    },
    provinceArea: {
      dict: tables.areaDict,
      names: tables.areaDict.map((key) => tables.areaNames[key] ?? ''),
      byId: areaById,
    },
    provinceDevastation: devastation,
    provinceTradeCompany: tradeCompany,
  };
}

// -------------------------------------------------------------- area detail ---

interface AreaWalk {
  detail: Record<string, AreaDetailEntry>;
  /** tag -> areas it holds as a state, for the "stated" culture columns. */
  statedAreas: Map<string, Set<string>>;
  /** area key -> tag -> `country_state.prosperity` (the key also means "is a state"). */
  stateProsperity: Map<string, Map<string, number>>;
}

function areaDetails(doc: SaveDocument, tagId: (tag: string) => number): AreaWalk {
  const detail: Record<string, AreaDetailEntry> = {};
  const statedAreas = new Map<string, Set<string>>();
  const stateProsperity = new Map<string, Map<string, number>>();
  const ref = doc.section('map_area_data');
  if (!ref) return { detail, statedAreas, stateProsperity };
  const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);
  for (;;) {
    const area = reader.nextMember();
    if (!area) break;
    if (area.kind !== 'block' || area.key === null) continue;
    const body = reader.enter(area);
    const areaKey = area.key;
    const states: AreaDetailEntry['states'] = [];
    const investments: AreaDetailEntry['investments'] = [];
    const assignments: Array<{ country: string; areaKey: string }> = [];
    for (;;) {
      const item = body.nextMember();
      if (!item) break;
      if (item.kind !== 'block') continue;
      if (item.key === 'state') {
        const state = body.enter(item);
        let stateArea = areaKey;
        for (;;) {
          const member = state.nextMember();
          if (!member) break;
          if (member.key === 'area') {
            const value = textOf(state, member);
            if (value) stateArea = value;
            continue;
          }
          if (member.key !== 'country_state' || member.kind !== 'block') {
            if (member.kind === 'block') state.enter(member);
            continue;
          }
          const countryState = state.enter(member);
          let country = '';
          let prosperity = 0;
          for (;;) {
            const field = countryState.nextMember();
            if (!field) break;
            if (field.kind === 'block') {
              countryState.enter(field);
              continue;
            }
            if (field.key === 'country') country = textOf(countryState, field);
            else if (field.key === 'prosperity') prosperity = toNumber(textOf(countryState, field)) ?? 0;
          }
          if (!country) continue;
          states.push({ tagIdx: tagId(country), prosperity });
          assignments.push({ country, areaKey: stateArea });
          const byTag = stateProsperity.get(areaKey) ?? new Map<string, number>();
          byTag.set(country, prosperity);
          stateProsperity.set(areaKey, byTag);
        }
        continue;
      }
      if (item.key === 'investments') {
        const invest = body.enter(item);
        let company = '';
        const icons: string[] = [];
        for (;;) {
          const field = invest.nextMember();
          if (!field) break;
          if (field.key === 'tag') {
            company = textOf(invest, field);
          } else if (field.key === 'investments' && field.kind === 'block') {
            const list = invest.enter(field);
            for (;;) {
              const icon = list.nextMember();
              if (!icon) break;
              const value = textOf(list, icon);
              if (value) icons.push(value);
            }
          } else if (field.kind === 'block') {
            invest.enter(field);
          }
        }
        if (company) investments.push({ tagIdx: tagId(company), icons });
        continue;
      }
      body.enter(item);
    }
    if (states.length > 0 || investments.length > 0) detail[areaKey] = { states, investments };
    for (const assignment of assignments) {
      const set = statedAreas.get(assignment.country) ?? new Set<string>();
      set.add(assignment.areaKey);
      statedAreas.set(assignment.country, set);
    }
  }

  // Key order is part of the JSON both planes compare, so it is pinned here.
  const sorted: Record<string, AreaDetailEntry> = {};
  for (const key of Object.keys(detail).sort()) sorted[key] = detail[key] as AreaDetailEntry;
  return { detail: sorted, statedAreas, stateProsperity };
}

// ------------------------------------------------------------------ people ----

interface Person {
  id: number;
  name: string;
  dynasty: string;
  adm: number;
  dip: number;
  mil: number;
  culture: string;
  religion: string;
  birthDate: string;
  deathDate: string;
  activation: string;
  kind: string;
  fire: number;
  shock: number;
  maneuver: number;
  siege: number;
  /** The `personalities` block: real traits. */
  personalities: string[];
  /** The `ruler_flags` block: event / decision markers, kept apart from traits. */
  flags: string[];
  succeeded: boolean;
}

function emptyPerson(): Person {
  return {
    id: 0,
    name: '',
    dynasty: '',
    adm: 0,
    dip: 0,
    mil: 0,
    culture: '',
    religion: '',
    birthDate: '',
    deathDate: '',
    activation: '',
    kind: '',
    fire: 0,
    shock: 0,
    maneuver: 0,
    siege: 0,
    personalities: [],
    flags: [],
    succeeded: false,
  };
}

function textOf(reader: ClausewitzReader, member: Member): string {
  if (member.kind === 'string') return reader.stringValue(member);
  if (member.kind === 'scalar') return reader.rawValue(member);
  return '';
}

/** Read one character/leader block (`monarch`, `heir`, `leader`, …). */
function readPerson(reader: ClausewitzReader): Person {
  const person = emptyPerson();
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    if (item.kind === 'block') {
      if (item.key === 'id' || item.key === 'monarch_id' || item.key === 'leader_id') {
        const inner = reader.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key !== 'id') continue;
          const value = toNumber(textOf(inner, field));
          if (value !== undefined) person.id = value;
        }
        continue;
      }
      if (item.key === 'personalities' || item.key === 'ruler_flags') {
        // Two separate blocks with two different meanings: `personalities` carries the
        // character's real traits (the panel's 性格 column), `ruler_flags` carries event
        // and decision markers. Merging them is what put English event keys in the
        // 性格 column (第四对话任务书 §2.2), so they are kept apart.
        const target = item.key === 'personalities' ? person.personalities : person.flags;
        const inner = reader.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key !== null) target.push(field.key);
        }
        continue;
      }
      if (item.key === 'leader') {
        // A monarch who also commands: this nested block carries the pip stats.
        const inner = reader.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind === 'block') {
            inner.enter(field);
            continue;
          }
          const value = textOf(inner, field);
          if (field.key === 'type') person.kind = value;
          else if (field.key === 'fire') person.fire = toNumber(value) ?? 0;
          else if (field.key === 'shock') person.shock = toNumber(value) ?? 0;
          else if (field.key === 'maneuver') person.maneuver = toNumber(value) ?? 0;
          else if (field.key === 'siege') person.siege = toNumber(value) ?? 0;
          else if (field.key === 'activation' && !person.activation) person.activation = value;
        }
        continue;
      }
      reader.enter(item);
      continue;
    }
    const value = textOf(reader, item);
    switch (item.key) {
      case 'id':
        person.id = toNumber(value) ?? person.id;
        break;
      case 'name':
        person.name = value;
        break;
      case 'dynasty':
        person.dynasty = value;
        break;
      case 'ADM':
        person.adm = toNumber(value) ?? 0;
        break;
      case 'DIP':
        person.dip = toNumber(value) ?? 0;
        break;
      case 'MIL':
        person.mil = toNumber(value) ?? 0;
        break;
      case 'culture':
        person.culture = value;
        break;
      case 'religion':
        person.religion = value;
        break;
      case 'birth_date':
        person.birthDate = value;
        break;
      case 'death_date':
        person.deathDate = value;
        break;
      case 'activation':
        person.activation = value;
        break;
      case 'type':
        person.kind = value;
        break;
      case 'fire':
        person.fire = toNumber(value) ?? 0;
        break;
      case 'shock':
        person.shock = toNumber(value) ?? 0;
        break;
      case 'maneuver':
        person.maneuver = toNumber(value) ?? 0;
        break;
      case 'siege':
        person.siege = toNumber(value) ?? 0;
        break;
      case 'succeeded':
        person.succeeded = value === 'yes';
        break;
      default:
        break;
    }
  }
  return person;
}

const LEADER_KINDS: Record<string, string> = {
  general: '将军',
  admiral: '海军上将',
  explorer: '探险家',
  conquistador: '征服者',
};

function kindLabel(kind: string): string {
  return LEADER_KINDS[kind] ?? (kind || '将领');
}

function ordinalOf(date: string): number {
  return parseGameDate(date)?.ordinal ?? 0;
}

function monthsBetween(from: string, to: string): number {
  const a = parseGameDate(from);
  const b = parseGameDate(to);
  if (!a || !b) return 0;
  return b.year * 12 + b.month - (a.year * 12 + a.month);
}

function ageAt(birthDate: string, saveDate: string): number {
  const birth = parseGameDate(birthDate);
  const now = parseGameDate(saveDate);
  if (!birth || !now || birth.year <= 1) return 0;
  return Math.max(0, now.year - birth.year);
}

// --------------------------------------------------------------- the country ---

/** One monarch-ish history entry, kept raw until the id sets are complete. */
interface MonarchEvent {
  date: string;
  ordinal: number;
  key: string;
  person: Person;
}

/** Everything one `countries/{TAG}` walk collects before it is shaped. */
interface CountryScratch {
  countryIndex: number;
  tag: string;
  scalars: Map<string, string>;
  powers: number[];
  tech: number[];
  governmentReforms: string[];
  ideas: CountryIdeaGroup[];
  landCounts: Record<string, number>;
  navyCounts: Record<string, number>;
  landRegiments: number;
  landStrength: number;
  landMorale: number;
  navalMorale: number;
  envoys: { merchants: number; colonists: number; diplomats: number; missionaries: number };
  debt: number;
  rivals: string[];
  allies: string[];
  subjects: string[];
  atWar: string[];
  acceptedCultures: string[];
  monarchId: number;
  leaderIds: number[];
  previousMonarchIds: number[];
  /** Army unit ids, and the mercenary companies those armies have hired. */
  armyIds: number[];
  armyMercIds: number[];
  /** The country's own mercenary companies: `{ id, unitId, leader }`. */
  mercenaryCompanies: Array<{ id: number; unitId: number; leader: Person }>;
  leaderHistory: Map<number, Person>;
  monarchEvents: MonarchEvent[];
  history: CountryHistoryRow[];
  hasInitial: boolean;
  /** `flags` as `{ name: date }` — the 名臣顾问 trigger list reads it. */
  flags: Map<string, string>;
  /** The country's `estate` blocks, already flattened for 阶级. */
  estates: Array<{
    kind: string;
    loyalty: number;
    territory: number;
    agendas: number;
    privileges: Array<{ name: string; since: string }>;
    influences: Array<{ name: string; value: string; expires: string }>;
  }>;
  /** The `ledger` block, raw: arrays are positional and already 19 / 38 long. */
  ledger: {
    income?: number[];
    expense?: number[];
    lastMonthIncome?: number[];
    lastMonthExpense?: number[];
    lastMonthIncomeTotal?: number;
    lastMonthExpenseTotal?: number;
    lastYearIncome?: number[];
    lastYearExpense?: number[];
    totalExpense?: number[];
    recurringIncome?: number;
    recurringExpense?: number;
  };
  /** `adm_spent_indexed` / `dip_spent_indexed` / `mil_spent_indexed`, sparse by slot. */
  mana: { adm: number[]; dip: number[]; mil: number[] };
}

function emptyScratch(tag: string, countryIndex: number): CountryScratch {
  return {
    countryIndex,
    tag,
    scalars: new Map(),
    powers: [0, 0, 0],
    tech: [0, 0, 0],
    governmentReforms: [],
    ideas: [],
    landCounts: {},
    navyCounts: {},
    landRegiments: 0,
    landStrength: 0,
    landMorale: 0,
    navalMorale: 0,
    envoys: { merchants: 0, colonists: 0, diplomats: 0, missionaries: 0 },
    debt: 0,
    rivals: [],
    allies: [],
    subjects: [],
    atWar: [],
    acceptedCultures: [],
    monarchId: 0,
    leaderIds: [],
    previousMonarchIds: [],
    armyIds: [],
    armyMercIds: [],
    mercenaryCompanies: [],
    leaderHistory: new Map(),
    monarchEvents: [],
    history: [],
    hasInitial: false,
    flags: new Map(),
    estates: [],
    ledger: {},
    mana: { adm: [], dip: [], mil: [] },
  };
}

/** Read an `id={ id=… type=… }` or flat `id=…` member. */
function readId(reader: ClausewitzReader, member: Member): number {
  if (member.kind !== 'block') return toNumber(textOf(reader, member)) ?? 0;
  const inner = reader.enter(member);
  for (;;) {
    const field = inner.nextMember();
    if (!field) break;
    if (field.key !== 'id') continue;
    const value = toNumber(textOf(inner, field));
    if (value !== undefined) return value;
  }
  return 0;
}

/** Count land regiments (`regiment`) and sum their strength/morale. */
function readRegiments(reader: ClausewitzReader, depth: number, scratch: CountryScratch): void {
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.kind !== 'block') continue;
    if (item.key === 'regiment') {
      scratch.landRegiments += 1;
      let strength = 1;
      const regiment = reader.enter(item);
      for (;;) {
        const field = regiment.nextMember();
        if (!field) break;
        if (field.key === null) continue;
        const value = textOf(regiment, field);
        if (field.key === 'strength') strength = toNumber(value) ?? 1;
        else if (field.key === 'morale') {
          const morale = toNumber(value);
          if (morale !== undefined && morale > scratch.landMorale) scratch.landMorale = morale;
        }
      }
      scratch.landStrength += strength;
      continue;
    }
    if (
      depth < 2 &&
      (item.key === 'mercenary_company' || item.key === 'subunit' || item.key === 'army')
    ) {
      readRegiments(reader.enter(item), depth + 1, scratch);
    } else {
      reader.enter(item);
    }
  }
}

/** The save's only clue at naval morale: the morale it keeps on each ship. */
function readShips(reader: ClausewitzReader, scratch: CountryScratch): void {
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.kind !== 'block') continue;
    if (item.key === 'ship') {
      const ship = reader.enter(item);
      for (;;) {
        const field = ship.nextMember();
        if (!field) break;
        if (field.key !== 'morale') continue;
        const morale = toNumber(textOf(ship, field));
        if (morale !== undefined && morale > scratch.navalMorale) scratch.navalMorale = morale;
      }
      continue;
    }
    reader.enter(item);
  }
}

/** `num_subunits_type_and_cat`: category -> unit-type name -> count. */
function readSubunitCounts(
  reader: ClausewitzReader,
  land: Record<string, number>,
  navy: Record<string, number>,
): void {
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.key === null || item.kind !== 'block') {
      if (item.kind === 'block') reader.enter(item);
      continue;
    }
    const naval =
      item.key === 'heavy_ship' ||
      item.key === 'light_ship' ||
      item.key === 'galley' ||
      item.key === 'transport';
    const target = naval ? navy : land;
    const category = reader.enter(item);
    let total = 0;
    for (;;) {
      const field = category.nextMember();
      if (!field) break;
      if (field.key === null) continue;
      if (field.kind !== 'block') {
        // `infantry={ normal=56 mercenary=10 streltsy=55 }`: the inner keys are unit
        // type names, and `mercenary` is the one the panel shows as 雇佣.
        const count = toNumber(textOf(category, field)) ?? 0;
        total += count;
        if (field.key === 'mercenary') target['mercenary'] = (target['mercenary'] ?? 0) + count;
        continue;
      }
      const name = field.key;
      const inner = category.enter(field);
      for (;;) {
        const leaf = inner.nextMember();
        if (!leaf) break;
        if (leaf.key === null) continue;
        const count = toNumber(textOf(inner, leaf)) ?? 0;
        total += count;
        if (name === 'mercenary' || leaf.key === 'mercenary') {
          target['mercenary'] = (target['mercenary'] ?? 0) + count;
        }
      }
    }
    target[item.key] = (target[item.key] ?? 0) + total;
  }
}

/** A `{ TAG TAG … }` or `{ { tag=X } … }` block as a list of tags. */
function readTagList(reader: ClausewitzReader, member: Member): string[] {
  const out: string[] = [];
  const inner = reader.enter(member);
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.kind !== 'block') {
      const value = textOf(inner, item);
      if (value) out.push(value);
      continue;
    }
    const body = inner.enter(item);
    for (;;) {
      const field = body.nextMember();
      if (!field) break;
      if (field.key === 'tag' || field.key === 'country' || field.key === 'value') {
        const value = textOf(body, field);
        if (value) out.push(value);
      } else if (field.kind === 'block') {
        body.enter(field);
      }
    }
  }
  return out;
}

/** Read a `{ key=value … }` group into a plain map (first value wins). */
function readFlatGroup(reader: ClausewitzReader): Map<string, string> {
  const out = new Map<string, string>();
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    if (item.kind === 'block') {
      reader.enter(item);
      continue;
    }
    if (!out.has(item.key)) out.set(item.key, textOf(reader, item));
  }
  return out;
}

/** Pull the fields of one `countries/{TAG}` block into a scratch record. */
function readCountry(
  reader: ClausewitzReader,
  member: Member,
  tag: string,
  countryIndex: number,
  names: HistoryNames,
): CountryScratch {
  const scratch = emptyScratch(tag, countryIndex);
  const body = reader.enter(member);
  for (;;) {
    const item = body.nextMember();
    if (!item) break;
    if (item.key === null) continue;

    if (item.kind !== 'block') {
      const value = textOf(body, item);
      // `enemy` and `accepted_culture` repeat, so they are collected rather than
      // stored under a single (first-wins) scalar.
      if (item.key === 'enemy') {
        if (value) scratch.atWar.push(value);
        continue;
      }
      if (item.key === 'accepted_culture') {
        if (value) scratch.acceptedCultures.push(value);
        continue;
      }
      if (!scratch.scalars.has(item.key)) scratch.scalars.set(item.key, value);
      continue;
    }

    switch (item.key) {
      case 'rival': {
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.kind === 'block') {
            inner.enter(field);
            continue;
          }
          if (field.key === 'country') {
            const value = textOf(inner, field);
            if (value) scratch.rivals.push(value);
          }
        }
        break;
      }
      case 'allies':
        scratch.allies.push(...readTagList(body, item));
        break;
      case 'subjects':
        scratch.subjects.push(...readTagList(body, item));
        break;
      case 'powers': {
        let index = 0;
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (index < 3) scratch.powers[index] = toNumber(textOf(inner, field)) ?? 0;
          index += 1;
        }
        break;
      }
      case 'technology': {
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          const value = toNumber(textOf(inner, field)) ?? 0;
          if (field.key === 'adm_tech') scratch.tech[0] = value;
          else if (field.key === 'dip_tech') scratch.tech[1] = value;
          else if (field.key === 'mil_tech') scratch.tech[2] = value;
        }
        break;
      }
      case 'government': {
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key !== 'reform_stack' || field.kind !== 'block') {
            if (field.kind === 'block') inner.enter(field);
            continue;
          }
          const stack = inner.enter(field);
          for (;;) {
            const child = stack.nextMember();
            if (!child) break;
            if (child.key !== 'reforms' || child.kind !== 'block') {
              if (child.kind === 'block') stack.enter(child);
              continue;
            }
            const reforms = stack.enter(child);
            for (;;) {
              const reform = reforms.nextMember();
              if (!reform) break;
              const value = textOf(reforms, reform);
              if (value) scratch.governmentReforms.push(value);
            }
          }
        }
        break;
      }
      case 'active_idea_groups': {
        for (const [group, value] of readFlatGroup(body.enter(item))) {
          const unlocked = Math.round(toNumber(value) ?? 0);
          scratch.ideas.push({ group, unlocked, total: Math.max(7, unlocked) });
        }
        break;
      }
      case 'num_subunits_type_and_cat':
        readSubunitCounts(body.enter(item), scratch.landCounts, scratch.navyCounts);
        break;
      case 'army': {
        readRegiments(body.enter(item), 0, scratch);
        // A second, independent reader over the same member: the army's own id and
        // the mercenary company it has hired, both needed to know which companies
        // are actually on the map ("BEST LEADERS").
        const army = body.enter(item);
        for (;;) {
          const field = army.nextMember();
          if (!field) break;
          if (field.key === 'id' && field.kind === 'block') {
            const id = readId(army, field);
            if (id) scratch.armyIds.push(id);
          } else if (field.key === 'mercenary_company' && field.kind === 'block') {
            const id = readId(army, field);
            if (id) scratch.armyMercIds.push(id);
          } else if (field.kind === 'block') {
            army.enter(field);
          }
        }
        break;
      }
      case 'navy':
        readShips(body.enter(item), scratch);
        break;
      case 'merchants':
      case 'diplomats':
      case 'colonists':
      case 'missionaries': {
        const inner = body.enter(item);
        let count = 0;
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === 'envoy') count += 1;
          else if (field.kind === 'block') inner.enter(field);
        }
        if (item.key === 'merchants') scratch.envoys.merchants += count;
        else if (item.key === 'diplomats') scratch.envoys.diplomats += count;
        else if (item.key === 'colonists') scratch.envoys.colonists += count;
        else scratch.envoys.missionaries += count;
        break;
      }
      case 'monarch':
      case 'previous_monarch': {
        const inner = body.enter(item);
        let id = 0;
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === 'id') id = toNumber(textOf(inner, field)) ?? 0;
        }
        if (item.key === 'monarch') scratch.monarchId = id;
        else if (id) scratch.previousMonarchIds.push(id);
        break;
      }
      case 'leader': {
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key !== 'id') continue;
          const id = toNumber(textOf(inner, field));
          if (id !== undefined) scratch.leaderIds.push(id);
        }
        break;
      }
      case 'mercenary_company': {
        // A company names its own general, and points at the army unit carrying its
        // regiments; both are needed for "BEST LEADERS".
        let companyId = 0;
        let unitId = 0;
        let leader: Person | undefined;
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.key === 'id') {
            companyId = readId(inner, field);
          } else if (field.key === 'unit' && field.kind === 'block') {
            unitId = readId(inner, field);
          } else if (field.key === 'leader' && field.kind === 'block') {
            leader = readPerson(inner.enter(field));
          } else if (field.kind === 'block') {
            inner.enter(field);
          }
        }
        if (leader) scratch.mercenaryCompanies.push({ id: companyId, unitId, leader });
        break;
      }
      case 'flags': {
        // `{ some_flag=1512.8.17 … }` — the great-advisor triggers live here.
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind === 'block') {
            inner.enter(field);
            continue;
          }
          const value = textOf(inner, field);
          if (value && !scratch.flags.has(field.key)) scratch.flags.set(field.key, value);
        }
        break;
      }
      case 'estate': {
        const inner = body.enter(item);
        let kind = '';
        let loyalty = 0;
        let territory = 0;
        let agendas = 0;
        const privileges: Array<{ name: string; since: string }> = [];
        const influences: Array<{ name: string; value: string; expires: string }> = [];
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind !== 'block') {
            const value = textOf(inner, field);
            if (field.key === 'type') kind = value;
            else if (field.key === 'loyalty') loyalty = toNumber(value) ?? 0;
            else if (field.key === 'territory') territory = toNumber(value) ?? 0;
            else if (field.key === 'num_of_estate_agendas_completed') agendas = toNumber(value) ?? 0;
            continue;
          }
          if (field.key === 'granted_privileges') {
            // `{ { estate_church_land_rights 1478.9.3 } … }` — each inner block is a
            // bare (name, date) pair, so it is read positionally.
            const list = inner.enter(field);
            for (;;) {
              const entry = list.nextMember();
              if (!entry) break;
              if (entry.kind !== 'block') continue;
              const pair = list.enter(entry);
              let name = '';
              let since = '';
              for (;;) {
                const value = pair.nextMember();
                if (!value) break;
                const text = textOf(pair, value);
                if (!name && text && !DATE_KEY.test(text)) name = text;
                else if (!since && DATE_KEY.test(text)) since = text;
              }
              if (name) privileges.push({ name, since });
            }
            continue;
          }
          if (field.key === 'influence_modifier') {
            // `{ value=5.000 desc="EST_VAL_DIET_SUMMONED" date=1581.1.2 }`, may repeat.
            const modifier = inner.enter(field);
            let value = '';
            let name = '';
            let expires = '';
            for (;;) {
              const x = modifier.nextMember();
              if (!x) break;
              if (x.key === null) continue;
              if (x.kind === 'block') {
                modifier.enter(x);
                continue;
              }
              const text = textOf(modifier, x);
              if (x.key === 'value') value = text;
              else if (x.key === 'desc') name = text;
              else if (x.key === 'date') expires = text;
            }
            if (name || value) influences.push({ name, value, expires });
            continue;
          }
          inner.enter(field);
        }
        if (kind) {
          privileges.sort((a, b) => a.name.localeCompare(b.name) || a.since.localeCompare(b.since));
          influences.sort((a, b) => a.expires.localeCompare(b.expires) || a.name.localeCompare(b.name));
          scratch.estates.push({
            // The raw `estate_…` type on purpose: that is how `uiNames.estates` is keyed.
            kind,
            loyalty,
            territory,
            agendas,
            privileges,
            influences,
          });
        }
        break;
      }
      case 'ledger': {
        // 三个区间各自的收入/支出数组（19 / 38 槽，按槽位下标排列）＋全时段支出表。
        // `thismonth*` 是"本月到现在"，与三个区间的口径不同，不进数据面。
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind !== 'block') {
            const value = toNumber(textOf(inner, field)) ?? 0;
            if (field.key === 'lastmonthincome') scratch.ledger.lastMonthIncomeTotal = value;
            else if (field.key === 'lastmonthexpense') scratch.ledger.lastMonthExpenseTotal = value;
            else if (field.key === 'last_months_recurring_income') scratch.ledger.recurringIncome = value;
            else if (field.key === 'last_months_recurring_expenses') scratch.ledger.recurringExpense = value;
            continue;
          }
          const values: number[] = [];
          const list = inner.enter(field);
          for (;;) {
            const x = list.nextMember();
            if (!x) break;
            if (x.key === null && x.kind === 'block') {
              list.enter(x);
              values.push(0);
              continue;
            }
            values.push(toNumber(textOf(list, x)) ?? 0);
          }
          if (field.key === 'income') scratch.ledger.income = values;
          else if (field.key === 'expense') scratch.ledger.expense = values;
          else if (field.key === 'lastmonthincometable') scratch.ledger.lastMonthIncome = values;
          else if (field.key === 'lastmonthexpensetable') scratch.ledger.lastMonthExpense = values;
          else if (field.key === 'lastyearincome') scratch.ledger.lastYearIncome = values;
          else if (field.key === 'lastyearexpense') scratch.ledger.lastYearExpense = values;
          else if (field.key === 'totalexpensetable') scratch.ledger.totalExpense = values;
        }
        break;
      }
      case 'adm_spent_indexed':
      case 'dip_spent_indexed':
      case 'mil_spent_indexed': {
        // `{ 0=5775 1=4463 … }`：稀疏的"槽位下标 -> 点数"，缺的槽位就是 0。
        const inner = body.enter(item);
        const target =
          item.key === 'adm_spent_indexed'
            ? scratch.mana.adm
            : item.key === 'dip_spent_indexed'
              ? scratch.mana.dip
              : scratch.mana.mil;
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind === 'block') {
            inner.enter(field);
            continue;
          }
          const index = Number(field.key);
          if (!Number.isInteger(index) || index < 0) continue;
          target[index] = toNumber(textOf(inner, field)) ?? 0;
        }
        break;
      }
      case 'loan': {
        // `loan` repeats; the panel only needs the outstanding amount.
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === 'amount') scratch.debt += toNumber(textOf(inner, field)) ?? 0;
          else if (field.kind === 'block') inner.enter(field);
        }
        break;
      }
      case 'history':
        readCountryHistory(body.enter(item), scratch, names);
        break;
      default:
        // Estates, diplomacy, missions, ai … belong to later waves; skip the block
        // without materialising it.
        body.enter(item);
        break;
    }
  }
  return scratch;
}

/**
 * The name tables the dated history log needs to turn a raw game key into a name
 * (第四对话任务书 §2.5). Values are already the baked `uiNames` families; an absent
 * family is `{}` and every lookup falls back to the key it was given.
 */
interface HistoryNames {
  religions: Record<string, string>;
  /** Culture keys → 中文名. Identical to `cultureNames[cultures.indexOf(key)]` by
   *  construction — `viewer-build.test.ts` asserts that alignment — so the direct key
   *  lookup is used and no second dictionary has to be threaded through here. */
  cultures: Record<string, string>;
  government: Record<string, string>;
  decisions: Record<string, string>;
}

/** `table[key] || key` — never throws, never invents a name. */
function rkName(table: Record<string, string> | undefined, key: string): string {
  return table?.[key] || key;
}

/** The four national-focus keys the save writes in Latin capitals. */
const RK_FOCUS_LABELS: Record<string, string> = {
  ADM: '行政',
  DIP: '外交',
  MIL: '军事',
  none: '无',
};

function rkFocus(value: string): string {
  return RK_FOCUS_LABELS[value] ?? value;
}

/**
 * `2nd 俄罗斯征服波洛茨克之战` -> `第二次 俄罗斯征服波洛茨克之战` (第四对话任务书 §2.5
 * 第 6 行, optional). The save stores the ordinal as an English suffix; the acceptance
 * list expects the Chinese numeral, so 1–10 are spelled out and anything larger keeps
 * its digits. A name without the ordinal prefix is returned untouched.
 */
const RK_CN_NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const RK_WAR_ORDINAL = /^(\d+)(st|nd|rd|th) /;

function rkWarName(name: string): string {
  const match = RK_WAR_ORDINAL.exec(name);
  if (!match) return name;
  const value = Number(match[1]);
  const label = value >= 1 && value <= 10 ? (RK_CN_NUMERALS[value] as string) : match[1];
  return `第${label}次 ${name.slice(match[0].length)}`;
}

/** Read a country's dated history log into accessions, leaders and timeline rows. */
function readCountryHistory(
  history: ClausewitzReader,
  scratch: CountryScratch,
  names: HistoryNames,
): void {
  for (;;) {
    const entry = history.nextMember();
    if (!entry) break;
    if (entry.key === null) continue;
    const match = DATE_KEY.exec(entry.key);
    if (!match) {
      // An undated key at the head of the block is the state at the campaign start.
      if (entry.kind === 'block') history.enter(entry);
      scratch.hasInitial = true;
      continue;
    }
    if (entry.kind !== 'block') continue;
    const date = entry.key;
    const ordinal = Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]);
    const body = history.enter(entry);
    for (;;) {
      const field = body.nextMember();
      if (!field) break;
      if (field.key === null) continue;
      const key = field.key;

      if (field.kind === 'block') {
        if (
          key === 'monarch' ||
          key === 'monarch_heir' ||
          key === 'monarch_consort' ||
          key === 'heir' ||
          key === 'queen'
        ) {
          // Which of these count as a reign is decided once the whole block has been
          // read: the `monarch`/`previous_monarch` id sets come *after* `history`.
          scratch.monarchEvents.push({ date, ordinal, key, person: readPerson(body.enter(field)) });
          continue;
        }
        if (key === 'leader') {
          const person = readPerson(body.enter(field));
          if (person.id && !scratch.leaderHistory.has(person.id)) {
            scratch.leaderHistory.set(person.id, person);
          }
          scratch.history.push({
            date,
            ordinal,
            kind: 'leader',
            text: `${kindLabel(person.kind)}：${person.name}`,
            payload: person.fire + person.shock + person.maneuver + person.siege,
          });
          continue;
        }
        body.enter(field);
        continue;
      }

      const value = textOf(body, field);
      switch (key) {
        case 'changed_tag_from':
          scratch.history.push({ date, ordinal, kind: 'tagSwitch', text: `改国号：${value}`, tag: value });
          break;
        // The five `value` kinds below print a **name**, not the raw game key
        // (第四对话任务书 §2.5). A table that is missing or has no entry for the key
        // falls back to the key itself: the name families `government` / `decisions`
        // are built by task B, and the data plane must not depend on their arrival.
        case 'religion':
          scratch.history.push({
            date,
            ordinal,
            kind: 'religion',
            text: `国教改为 ${rkName(names.religions, value)}`,
          });
          break;
        case 'primary_culture':
          scratch.history.push({
            date,
            ordinal,
            kind: 'primaryCulture',
            text: `主文化改为 ${rkName(names.cultures, value)}`,
          });
          break;
        case 'add_accepted_culture':
          scratch.history.push({
            date,
            ordinal,
            kind: 'addAcceptedCulture',
            text: `接受文化：${rkName(names.cultures, value)}`,
          });
          break;
        case 'remove_accepted_culture':
          scratch.history.push({
            date,
            ordinal,
            kind: 'removeAcceptedCulture',
            text: `取消接受文化：${rkName(names.cultures, value)}`,
          });
          break;
        case 'add_government_reform':
          scratch.history.push({
            date,
            ordinal,
            kind: 'governmentReform',
            text: `政体改革：${value}`,
            tag: value,
          });
          break;
        case 'government':
          scratch.history.push({
            date,
            ordinal,
            kind: 'government',
            text: `政体改为 ${rkName(names.government, value)}`,
            tag: value,
          });
          break;
        case 'government_rank':
          scratch.history.push({
            date,
            ordinal,
            kind: 'governmentRank',
            text: `政体等级 ${value}`,
            ...(toNumber(value) !== undefined ? { payload: toNumber(value) as number } : {}),
          });
          break;
        case 'national_focus':
          scratch.history.push({
            date,
            ordinal,
            kind: 'focus',
            text: `国家焦点：${rkFocus(value)}`,
            tag: value,
          });
          break;
        case 'capital': {
          const provinceId = toNumber(value);
          scratch.history.push({
            date,
            ordinal,
            kind: 'capital',
            text: '迁都',
            ...(provinceId !== undefined ? { provId: provinceId } : {}),
          });
          break;
        }
        case 'decision':
          scratch.history.push({
            date,
            ordinal,
            kind: 'decision',
            text: rkName(names.decisions, value),
            tag: value,
          });
          break;
        default:
          break;
      }
    }
  }
}

// --------------------------------------------------------------- the shapes ---

/** Everything wave 2 needs that is aggregated across provinces or read from a table. */
interface Wave2Input {
  /** tag -> building key -> how many of that tag's provinces have it. */
  buildingCounts: Map<string, Map<string, number>>;
  /** tag -> area key -> the owned provinces' development / state house / devastation. */
  stateAgg: Map<string, Map<string, { dev: number; stateHouse: boolean; hasDevastation: boolean }>>;
  areaById: Map<number, string>;
  areaNames: Record<string, string>;
  /** area key -> tag -> prosperity; the inner key existing means "it is a state". */
  stateProsperity: Map<string, Map<string, number>>;
  advisorIds: Array<{ id: string; name: string }>;
  uiNames: Record<string, Record<string, string>>;
}

/** Wave 3's inputs: the two baked slot-name tables (their lengths are the slot counts). */
interface Wave3Input {
  ledgerSlots: { income: SlotName[]; expense: SlotName[] };
  manaSlots: SlotName[];
}

/** Turn one walked country into the frozen wave-1 record. */
function shapeCountry(
  scratch: CountryScratch,
  religionDev: Record<string, number>,
  cultures: Map<string, { provinces: number; dev: number; statedProvinces: number; statedDev: number }>,
  warRows: CountryHistoryRow[],
  saveDate: string,
  startDate: string | undefined,
  wave2: Wave2Input,
  wave3: Wave3Input,
): CountryDetailRecord {
  const scalar = (key: string): string => scratch.scalars.get(key) ?? '';
  const number = (key: string): number => toNumber(scalar(key)) ?? 0;
  const optionalNumber = (key: string): number | null =>
    scratch.scalars.has(key) ? (toNumber(scalar(key)) ?? null) : null;

  // Government strength: the first of these five the save actually records.
  const strengthSources: Array<[string, number]> = [
    ['legitimacy', number('legitimacy')],
    ['republican_tradition', number('republican_tradition')],
    ['devotion', number('devotion')],
    ['meritocracy', number('meritocracy')],
    ['horde_unity', number('horde_unity')],
  ];
  const strength = strengthSources.find(([, value]) => value > 0);

  // ---- rulers, failed heirs and the monarch cards ---------------------------
  // `monarchIds` is what the save itself calls a ruler: the `previous_monarch` list
  // plus the current `monarch`. Heirs and queens are *not* rulers until one of the
  // monarch-ish events names them, which is exactly the test for a failed heir.
  const monarchIds = new Set<number>([scratch.monarchId, ...scratch.previousMonarchIds]);

  const history = [...scratch.history];
  const accessions: MonarchEvent[] = [];
  const failedHeirs: CountryFailedHeir[] = [];
  // Collected up front: an heir entry is written before the accession that proves the
  // character reigned, so a single pass would miscount them as failed.
  const reigned = new Set<number>();
  for (const event of scratch.monarchEvents) {
    const isAccession =
      event.key === 'monarch' || event.key === 'monarch_heir' || event.key === 'monarch_consort';
    if (isAccession && event.person.id !== 0 && monarchIds.has(event.person.id)) {
      reigned.add(event.person.id);
    }
  }
  for (const event of scratch.monarchEvents) {
    const person = event.person;
    const isRuler = person.id !== 0 && monarchIds.has(person.id);
    if (
      isRuler &&
      (event.key === 'monarch' || event.key === 'monarch_heir' || event.key === 'monarch_consort')
    ) {
      accessions.push(event);
      history.push({ date: event.date, ordinal: event.ordinal, kind: 'monarch', text: `即位：${person.name}` });
      continue;
    }
    if (event.key === 'heir' || event.key === 'queen') {
      // A failed heir is an `heir` who never shows up as a ruler. pdx-tools tests the
      // save's own ruler id set (`previous_monarch` + `monarch`); this also drops an
      // heir who does have an accession event, because that list is capped and can be
      // missing an older ruler.
      if (event.key === 'heir' && person.id !== 0 && !monarchIds.has(person.id) && !reigned.has(person.id)) {
        failedHeirs.push({
          name: person.name,
          birth: person.birthDate,
          personalities: person.personalities,
          flags: person.flags,
          adm: person.adm,
          dip: person.dip,
          mil: person.mil,
        });
      }
      const label = event.key === 'heir' ? '立储' : '联姻';
      history.push({ date: event.date, ordinal: event.ordinal, kind: event.key, text: `${label}：${person.name}` });
      continue;
    }
    // A consort/heir who never ruled still belongs in the timeline.
    history.push({ date: event.date, ordinal: event.ordinal, kind: 'monarch', text: `册立：${person.name}` });
  }

  // A re-stated accession (`monarch` right after its own `monarch_heir`) is the same
  // reign, not a new one.
  const deduped: MonarchEvent[] = [];
  for (const event of accessions) {
    const last = deduped[deduped.length - 1];
    if (last && event.person.id !== 0 && last.person.id === event.person.id) continue;
    deduped.push(event);
  }
  const campaignStart = startDate ? ordinalOf(startDate) : 0;
  const rulers: CountryRuler[] = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const event = deduped[i] as MonarchEvent;
    const next = deduped[i + 1];
    if (next && next.ordinal <= campaignStart) continue;
    const endDate = next ? next.date : '';
    const startOrdinal = Math.max(event.ordinal, campaignStart);
    rulers.push({
      name: event.person.name,
      start: ordinalToDate(startOrdinal),
      end: endDate,
      months: Math.max(0, monthsBetween(event.date, endDate || saveDate)),
      personalities: event.person.personalities,
      flags: event.person.flags,
      adm: event.person.adm,
      dip: event.person.dip,
      mil: event.person.mil,
    });
  }

  // ---- the current monarch --------------------------------------------------
  let monarch: CountryMonarch | null = null;
  let currentPerson: Person | undefined;
  for (const event of scratch.monarchEvents) {
    if (event.person.id !== 0 && event.person.id === scratch.monarchId) currentPerson = event.person;
  }
  if (currentPerson) {
    monarch = {
      name: currentPerson.name,
      dynasty: currentPerson.dynasty,
      adm: currentPerson.adm,
      dip: currentPerson.dip,
      mil: currentPerson.mil,
      age: ageAt(currentPerson.birthDate, saveDate),
      culture: currentPerson.culture,
      religion: currentPerson.religion,
      inaugurated: scalar('inauguration'),
      personalities: currentPerson.personalities,
      flags: currentPerson.flags,
    };
  }

  // ---- leaders --------------------------------------------------------------
  // The history log keyed by character id (later entries win), plus the generals of
  // mercenary companies this country has actually hired.
  const attachedCompanies = new Set<number>([...scratch.armyMercIds]);
  const armyIds = new Set<number>([...scratch.armyIds]);
  const activeIds = new Set(scratch.leaderIds);
  const leaderById = new Map<number, Person>(scratch.leaderHistory);
  const mercenaryLeaders: Person[] = [];
  for (const company of scratch.mercenaryCompanies) {
    if (!company.leader.id) continue;
    if (!attachedCompanies.has(company.id) && !(company.unitId && armyIds.has(company.unitId))) continue;
    leaderById.set(company.leader.id, company.leader);
    mercenaryLeaders.push(company.leader);
  }
  const leaders: CountryLeader[] = [];
  for (const person of leaderById.values()) {
    leaders.push({
      name: person.name,
      kind: person.kind,
      active: activeIds.has(person.id) || mercenaryLeaders.includes(person),
      activation: person.activation,
      fire: person.fire,
      shock: person.shock,
      maneuver: person.maneuver,
      siege: person.siege,
    });
  }
  leaders.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      b.activation.localeCompare(a.activation) ||
      a.name.localeCompare(b.name),
  );

  const score = (leader: CountryLeader): number =>
    leader.fire + leader.shock + leader.maneuver + leader.siege;
  let bestGeneral: CountryLeader | null = null;
  let bestAdmiral: CountryLeader | null = null;
  const consider = (leader: CountryLeader): void => {
    if (leader.kind === 'general' || leader.kind === 'conquistador') {
      if (!bestGeneral || score(leader) > score(bestGeneral)) bestGeneral = leader;
    } else if (leader.kind === 'admiral' || leader.kind === 'explorer') {
      if (!bestAdmiral || score(leader) > score(bestAdmiral)) bestAdmiral = leader;
    }
  };
  for (const leader of leaders) if (leader.active) consider(leader);

  // ---- the timeline ---------------------------------------------------------
  if (scratch.hasInitial && startDate) {
    history.push({ date: startDate, ordinal: campaignStart, kind: 'initial', text: `开局：${scratch.tag}` });
  }
  history.push(...warRows);
  history.sort(
    (a, b) => a.ordinal - b.ordinal || a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text),
  );

  const land = (category: string): number => scratch.landCounts[category] ?? 0;
  const ship = (category: string): number => scratch.navyCounts[category] ?? 0;

  // ---- 波 2：建筑 / 州 / 阶级 / 顾问 ------------------------------------------
  const buildingCount = [...(wave2.buildingCounts.get(scratch.tag) ?? new Map<string, number>())]
    .map(([building, provinces]) => ({ building, provinces }))
    .filter((entry) => entry.provinces > 0)
    // A bar chart reads best tallest-first; the key breaks ties so both planes agree.
    .sort((a, b) => b.provinces - a.provinces || a.building.localeCompare(b.building));

  const capitalId = number('capital');
  const capitalArea = capitalId > 0 ? wave2.areaById.get(capitalId) : undefined;
  const stability = number('stability');
  const states = [...(wave2.stateAgg.get(scratch.tag) ?? new Map<string, { dev: number; stateHouse: boolean; hasDevastation: boolean }>())]
    .map(([area, agg]) => {
      const prosperity = wave2.stateProsperity.get(area)?.get(scratch.tag);
      const isState = prosperity !== undefined;
      const value = prosperity ?? 0;
      // pdx-tools' own three-way rule: it can prosper, it can be declining, or the
      // question does not apply (not a state at all, or already at 100).
      const prosperityMode = !isState
        ? ''
        : stability > 0 && !agg.hasDevastation && value < 100
          ? 'prospering'
          : stability < 0 || agg.hasDevastation
            ? 'declining'
            : '';
      return {
        area,
        name: wave2.areaNames[area] ?? '',
        dev: Math.round(agg.dev * 1000) / 1000,
        capitalState: capitalArea === area,
        prosperity: value,
        prosperityMode,
        stateHouse: agg.stateHouse,
      };
    })
    .sort((a, b) => a.area.localeCompare(b.area));

  // 王室领地：存档里没有这个标量，pdx-tools 也是算出来的（100 − Σ 阶级领地占比）。
  const crownland = Math.round((100 - scratch.estates.reduce((total, estate) => total + estate.territory, 0)) * 100) / 100;

  // 名臣顾问：只列该国有对应 flag 的类型（没有名臣的国家给空数组，面板只显示一行文字）。
  const advisors: Array<{ id: string; name: string; date: string }> = [];
  for (const advisor of wave2.advisorIds) {
    const date = scratch.flags.get(advisor.id);
    if (!date) continue;
    advisors.push({
      id: advisor.id,
      name: wave2.uiNames['advisors']?.[advisor.id] ?? advisor.name,
      date,
    });
  }
  advisors.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // ---- 波 3：财政 / 点数 ------------------------------------------------------
  const ledger = scratch.ledger;
  const round3 = (value: number): number => Math.round(value * 1000) / 1000;
  /** The save's arrays are positional; pad/truncate to the frozen slot count. */
  const padded = (values: number[] | undefined, count: number): number[] => {
    const out: number[] = new Array(count).fill(0) as number[];
    // `?? 0` matters: the mana maps are *sparse* (built by `target[index] = …`), so an
    // unused slot reads back as `undefined` and would poison every total with NaN.
    if (values) for (let i = 0; i < Math.min(values.length, count); i += 1) out[i] = values[i] ?? 0;
    return out;
  };
  const budgetPeriod = (
    period: string,
    income: number[] | undefined,
    expense: number[] | undefined,
    incomeTotalFallback = 0,
    expenseTotalFallback = 0,
  ): BudgetPeriod => {
    const incomeSlots = padded(income, wave3.ledgerSlots.income.length);
    const expenseSlots = padded(expense, wave3.ledgerSlots.expense.length);
    // The breakdown is the authority (the panel adds the rows up); the save's own
    // scalar total only stands in when the array is missing (5 countries in this save
    // keep no last-year table at all).
    const incomeTotal = round3(income && income.length > 0 ? incomeSlots.reduce((total, value) => total + value, 0) : incomeTotalFallback);
    const expenseTotal = round3(expense && expense.length > 0 ? expenseSlots.reduce((total, value) => total + value, 0) : expenseTotalFallback);
    return {
      period,
      income: incomeSlots.map(round3),
      expense: expenseSlots.map(round3),
      incomeTotal,
      expenseTotal,
      net: round3(incomeTotal - expenseTotal),
    };
  };
  const budget: CountryBudget = {
    periods: [
      budgetPeriod('last-month', ledger.lastMonthIncome, ledger.lastMonthExpense, ledger.lastMonthIncomeTotal, ledger.lastMonthExpenseTotal),
      budgetPeriod('ytd', ledger.income, ledger.expense),
      budgetPeriod('last-year', ledger.lastYearIncome, ledger.lastYearExpense),
    ],
    totalExpense: padded(ledger.totalExpense, wave3.ledgerSlots.expense.length).map(round3),
    recurringIncome: round3(ledger.recurringIncome ?? 0),
    recurringExpense: round3(ledger.recurringExpense ?? 0),
  };
  const manaSpent: CountryManaSpent = {
    adm: padded(scratch.mana.adm, wave3.manaSlots.length),
    dip: padded(scratch.mana.dip, wave3.manaSlots.length),
    mil: padded(scratch.mana.mil, wave3.manaSlots.length),
  };

  return {
    powers: [...scratch.powers],
    treasury: number('treasury'),
    debt: Math.round(scratch.debt * 1000) / 1000,
    inflation: number('inflation'),
    prestige: number('prestige'),
    stability: number('stability'),
    powerProjection: number('current_power_projection'),
    innovativeness: number('innovativeness'),
    corruption: number('corruption'),
    governmentStrengthKind: strength ? (strength[0] as string) : 'native',
    governmentStrength: strength ? (strength[1] as number) : 0,
    government: scalar('government_name'),
    governmentRank: number('government_rank'),
    governmentReforms: scratch.governmentReforms,
    development: number('development'),
    rawDevelopment: number('raw_development'),
    autonomyPercent: number('average_autonomy'),
    cities: number('num_of_cities'),
    overextension: number('overextension_percentage'),
    religiousUnity: number('religious_unity'),
    // The save never writes `absolutism` (0 occurrences in the sample save), so this
    // stays `null` and the panel prints `—` with "存档未记录" instead of a fake 0.
    absolutism: optionalNumber('absolutism'),
    mercantilism: number('mercantilism'),
    splendor: number('splendor'),
    tech: [...scratch.tech],
    envoys: { ...scratch.envoys },
    religion: scalar('religion'),
    primaryCulture: scalar('primary_culture'),
    dominantCulture: scalar('dominant_culture'),
    acceptedCultures: scratch.acceptedCultures,
    rivals: scratch.rivals,
    allies: scratch.allies,
    subjects: scratch.subjects,
    atWar: scratch.atWar,
    overlord: scalar('overlord'),
    colonialParent: scalar('colonial_parent'),
    sailors: number('sailors'),
    countryId: scratch.countryIndex,
    army: [land('infantry'), land('cavalry'), land('artillery'), land('mercenary')],
    navy: [ship('heavy_ship'), ship('light_ship'), ship('galley'), ship('transport')],
    manpower: number('manpower'),
    reinforce: Math.round(Math.max(0, scratch.landRegiments - scratch.landStrength) * 1000) / 1000,
    maxManpower: number('max_manpower'),
    landMorale: scratch.landMorale > 0.52 ? Math.round(scratch.landMorale * 1000) / 1000 : null,
    navalMorale: scratch.navalMorale > 0.52 ? Math.round(scratch.navalMorale * 1000) / 1000 : null,
    professionalism: number('army_professionalism'),
    armyTradition: number('army_tradition'),
    navyTradition: number('navy_tradition'),
    ideas: scratch.ideas,
    monarch,
    rulers,
    failedHeirs,
    leaders,
    bestGeneral,
    bestAdmiral,
    religionDev,
    cultureStats: [...cultures.entries()]
      .map(([culture, tally]) => ({
        culture,
        // Culture groups live in `common/cultures/*.txt`, which the data plane cannot
        // read; the panel falls back to the raw culture name.
        group: '',
        provinces: tally.provinces,
        dev: tally.dev,
        statedProvinces: tally.statedProvinces,
        statedDev: tally.statedDev,
      }))
      .sort((a, b) => b.dev - a.dev || a.culture.localeCompare(b.culture)),
    history,
    buildingCount,
    states,
    estates: scratch.estates,
    crownland,
    advisors,
    budget,
    manaSpent,
  };
}

// ------------------------------------------------------------------ names -----

/**
 * The name families 省份国家界面阶段任务书 §6.8.2 asks S2 to publish.
 *
 * They are listed here rather than read from the file so the baked object always has
 * the same keys in the same order — the two data planes are compared with
 * `JSON.stringify`. A family the file does not define yet is `{}`; a family it grows
 * beyond this list is passed through as well, so a new name table needs no data-plane
 * change.
 */
export const UI_NAME_FAMILIES = [
  'cultures',
  'personalities',
  'governmentReforms',
  'buildings',
  'greatProjects',
  'terrain',
  'religions',
  'institutions',
  'ideaGroups',
  'advisors',
  'areas',
  'units',
  'technologies',
  // The 阶级 family set, published in 阶段 2 and keyed exactly like the save writes it
  // (`estate_church` / `estate_church_land_rights` / `EST_VAL_DIET_SUMMONED`).
  'estates',
  'estatePrivileges',
  'estateInfluenceModifiers',
  'estateAgendas',
  'stateEdicts',
  'parliamentIssues',
  'parliamentBribes',
] as const;

/**
 * Bake the raw `uiNames.json` text into the plane.
 *
 * Deliberately **no fallback chain of its own**: religion names already have
 * `RELIGION_FALLBACK` in `game-localisation.js` / `scripts/lib/localisation.ts`, and a
 * missing key is simply absent here — the panel prints the raw key (or `—`), which is
 * the same floor the rest of the project uses.
 */
function bakeUiNames(text: string | undefined): Record<string, Record<string, string>> {
  const raw = jsonObject(text);
  const out: Record<string, Record<string, string>> = {};
  for (const family of UI_NAME_FAMILIES) out[family] = stringMap(raw[family]);
  for (const family of Object.keys(raw).sort()) {
    if (family in out) continue;
    out[family] = stringMap(raw[family]);
  }
  return out;
}

/**
 * One `{ index, key, name }` slot list, placed at its own `index` and padded to
 * `count` so the result can be zipped with the save's positional arrays.
 *
 * S2's tables carry `{ slots: [...] }` (ledger) or are that list directly (mana); an
 * absent or half-written table yields `count` empty slots rather than a wrong name.
 */
function slotNames(value: unknown, count: number): SlotName[] {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const list = Array.isArray(value)
    ? value
    : Array.isArray(raw?.['slots'])
      ? (raw?.['slots'] as unknown[])
      : [];
  const placed: SlotName[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const slot = entry as Record<string, unknown>;
    const index = Number(slot['index']);
    if (!Number.isInteger(index) || index < 0) continue;
    placed[index] = {
      key: typeof slot['key'] === 'string' ? slot['key'] : '',
      name: typeof slot['name'] === 'string' ? slot['name'] : '',
    };
  }
  const out: SlotName[] = [];
  for (let i = 0; i < count; i += 1) out.push(placed[i] ?? { key: '', name: '' });
  return out;
}

/** The frozen contract's slot counts, used when S2's table does not state one. */
const LEDGER_SLOTS = { income: 19, expense: 38 };
const MANA_SLOTS = 46;

function bakeLedgerSlots(text: string | undefined): { income: SlotName[]; expense: SlotName[] } {
  const raw = jsonObject(text);
  const income = raw['income'] && typeof raw['income'] === 'object' ? (raw['income'] as Record<string, unknown>) : {};
  const expense = raw['expense'] && typeof raw['expense'] === 'object' ? (raw['expense'] as Record<string, unknown>) : {};
  return {
    income: slotNames(income, Number(income['count']) || LEDGER_SLOTS.income),
    expense: slotNames(expense, Number(expense['count']) || LEDGER_SLOTS.expense),
  };
}

function bakeManaSlots(text: string | undefined): SlotName[] {
  const raw = jsonObject(text);
  return slotNames(raw, Number(raw['count']) || MANA_SLOTS);
}

// ------------------------------------------------------------- the rankings ---

/**
 * 第四对话任务书 §3.5: the frozen weights, floors and board size. Every tunable lives
 * here so the formula is never re-derived inside the scoring loop.
 */
const RK_GENERAL_WEIGHTS = { skill: 0.45, war: 0.4, win: 0.15 } as const;
const RK_MONARCH_WEIGHTS = { ability: 0.35, tenure: 0.15, growth: 0.35, pace: 0.15 } as const;
const RK_MIN_GENERAL_BATTLES = 3;
/** 5 years. A shorter reign sends the per-year pace component to the ceiling. */
const RK_MIN_REIGN_MONTHS = 60;
const RK_BOARD_SIZE = 15;

interface RankingCandidate {
  /** The final tag (identity) the battle side resolves to. */
  tag: string;
  name: string;
  kind: string;
  fire: number;
  shock: number;
  maneuver: number;
  siege: number;
  activation: string;
  battles: number;
  wins: number;
  kills: number;
  taken: number;
}

interface RankingInput {
  doc: SaveDocument;
  provinces: Map<number, ProvinceRecord>;
  countryDetail: Record<string, CountryDetailRecord>;
  wars: readonly War[];
  timeline: GameTimeline;
  saveDate: string;
}

/** `round(value, digits)` — the file's own house style (`round3` inside `shapeCountry`). */
function rkRound(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** §3.5's `norm()`. `max === min` hands every candidate 1, never NaN. */
function rkNorm(value: number, min: number, max: number): number {
  if (max === min) return 1;
  const ratio = (value - min) / (max - min);
  return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

function rkMinMax(values: readonly number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
}

/**
 * The `leader` blocks of one `countries/{TAG}` block, for the tags the panel has no
 * record of (§3.5's extended pool). `reader` must be positioned inside the country.
 */
function rkHistoryLeaders(reader: ClausewitzReader): RankingCandidate[] {
  const out: RankingCandidate[] = [];
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.key !== 'history' || item.kind !== 'block') continue;
    const history = reader.enter(item);
    for (;;) {
      const entry = history.nextMember();
      if (!entry) break;
      if (entry.key === null || entry.kind !== 'block') continue;
      const body = history.enter(entry);
      for (;;) {
        const field = body.nextMember();
        if (!field) break;
        if (field.key !== 'leader' || field.kind !== 'block') continue;
        const person = readPerson(body.enter(field));
        if (!person.name) continue;
        out.push({
          // Filled with the owning tag by the caller; the key here is the person.
          tag: '',
          name: person.name,
          kind: person.kind,
          fire: person.fire,
          shock: person.shock,
          maneuver: person.maneuver,
          siege: person.siege,
          activation: person.activation,
          battles: 0,
          wins: 0,
          kills: 0,
          taken: 0,
        });
      }
    }
  }
  return out;
}

interface RkDevRequest {
  /** The country's **identity** (`resolveTagLatest`): one line across a tag change. */
  identity: string;
  startOrdinal: number;
  endOrdinal: number;
}

/**
 * The monthly ownership / development replay the monarch board needs (§3.5).
 *
 * One forward sweep shared by every candidate: the province blocks hold the campaign's
 * *final* values, so the undated initial overlay rewinds to 1444 first, then the dated
 * events are applied once, in order. Readings are taken only at the ordinals a candidate
 * asks for — **no per-month series is published** (that would be megabytes). Same
 * algorithm, same `resolveTagLatest` identity merge and same dev definition as
 * `curves` in both data planes, so a monarch's `devGain` is the 兴衰曲线's own delta.
 */
function rkDevelopmentReplay(
  timeline: GameTimeline,
  provinces: Map<number, ProvinceRecord>,
  aliases: readonly TagAlias[],
  requests: readonly RkDevRequest[],
): Array<{ devStart: number; devEnd: number; provincesGain: number }> {
  let maxId = 0;
  for (const id of provinces.keys()) if (id > maxId) maxId = id;
  const size = maxId + 1;

  const tax = new Float64Array(size);
  const production = new Float64Array(size);
  const manpower = new Float64Array(size);
  const ownerOf = new Array<string | undefined>(size);
  for (const province of provinces.values()) {
    tax[province.id] = province.baseTax ?? 0;
    production[province.id] = province.baseProduction ?? 0;
    manpower[province.id] = province.baseManpower ?? 0;
    if (province.owner && province.owner !== '---' && province.owner !== 'REB') {
      ownerOf[province.id] = province.owner;
    }
  }

  const dev = new Map<string, number>();
  const count = new Map<string, number>();
  const devAt = (id: number): number => tax[id]! + production[id]! + manpower[id]!;
  const shift = (identity: string, delta: number, deltaCount: number): void => {
    dev.set(identity, (dev.get(identity) ?? 0) + delta);
    count.set(identity, (count.get(identity) ?? 0) + deltaCount);
  };
  const setOwner = (id: number, raw: string): void => {
    const next = raw === '---' || raw === 'REB' ? undefined : raw;
    const previous = ownerOf[id];
    if (previous === next) return;
    if (previous) shift(resolveTagLatest(aliases, previous), -devAt(id), -1);
    if (next) shift(resolveTagLatest(aliases, next), devAt(id), 1);
    ownerOf[id] = next;
  };
  const setDevelopment = (id: number, field: string, raw: string): void => {
    const before = devAt(id);
    const value = Number(raw) || 0;
    if (field === 'base_tax') tax[id] = value;
    else if (field === 'base_production') production[id] = value;
    else manpower[id] = value;
    const after = devAt(id);
    const owner = ownerOf[id];
    if (owner && after !== before) shift(resolveTagLatest(aliases, owner), after - before, 0);
  };
  const apply = (id: number, field: string, value: string): void => {
    if (field === 'owner') setOwner(id, value);
    else if (field === 'base_tax' || field === 'base_production' || field === 'base_manpower') {
      setDevelopment(id, field, value);
    }
  };

  // Seed the running tally with the save-date state, which is what the province records
  // hold. Without this the first owner change of every province would subtract
  // development that had never been added, and the total would go negative. (The curves
  // in both planes re-sum every province each month instead, so they need no seeding —
  // the totals are the same, which is what the probe cross-checks.)
  for (const province of provinces.values()) {
    const owner = ownerOf[province.id];
    if (owner) shift(resolveTagLatest(aliases, owner), devAt(province.id), 1);
  }

  for (const history of timeline.provinces.values()) {
    for (const change of history.initial) apply(history.id, change.field, change.value);
  }

  const results = requests.map(() => ({ devStart: 0, devEnd: 0, provincesGain: 0 }));
  const pending = new Map<number, Array<{ index: number; field: 'start' | 'end' }>>();
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index] as RkDevRequest;
    const points: Array<['start' | 'end', number]> = [
      ['start', request.startOrdinal],
      ['end', request.endOrdinal],
    ];
    for (const [field, ordinal] of points) {
      const list = pending.get(ordinal) ?? [];
      list.push({ index, field });
      pending.set(ordinal, list);
    }
  }

  const ordinals = [...pending.keys()].sort((a, b) => a - b);
  const events = timeline.events;
  let cursor = 0;
  for (const ordinal of ordinals) {
    while (cursor < events.length) {
      const event = events[cursor] as GameTimeline['events'][number];
      if (event.ordinal > ordinal) break;
      cursor += 1;
      for (const change of event.changes) apply(event.provinceId, change.field, change.value);
    }
    for (const request of pending.get(ordinal) ?? []) {
      const identity = (requests[request.index] as RkDevRequest).identity;
      const owned = count.get(identity) ?? 0;
      const record = results[request.index] as { devStart: number; devEnd: number; provincesGain: number };
      if (request.field === 'start') {
        record.devStart = dev.get(identity) ?? 0;
        record.provincesGain = -owned;
      } else {
        record.devEnd = dev.get(identity) ?? 0;
        record.provincesGain += owned;
      }
    }
  }
  return results;
}

/** Build `rankings` (§3.4 shape, §3.5 formula) from the assembled country panel. */
function buildRankings(input: RankingInput): Rankings {
  const { doc, provinces, countryDetail, wars, timeline, saveDate } = input;
  const aliases = buildTagAliases(doc);

  // ---- the general candidate pool ------------------------------------------
  // `(最终国号, 姓名)` -> the people carrying that name. §3.5 keeps the list: two rulers
  // of the same name are two people, and a battle goes to the closer `activation`.
  const byKey = new Map<string, RankingCandidate[]>();
  const candidateTags = new Set<string>();
  const addCandidate = (tag: string, leader: Omit<RankingCandidate, 'tag' | 'battles' | 'wins' | 'kills' | 'taken'>): void => {
    if (!tag || !leader.name) return;
    const key = `${tag}\u0000${leader.name}`;
    const list = byKey.get(key) ?? [];
    // The two sources cannot normally overlap (② is read only for tags ① does not
    // know), but an exact duplicate is still dropped rather than counted twice.
    for (const existing of list) {
      if (
        existing.activation === leader.activation &&
        existing.kind === leader.kind &&
        existing.fire === leader.fire &&
        existing.shock === leader.shock &&
        existing.maneuver === leader.maneuver &&
        existing.siege === leader.siege
      ) {
        return;
      }
    }
    list.push({
      tag,
      name: leader.name,
      kind: leader.kind,
      fire: leader.fire,
      shock: leader.shock,
      maneuver: leader.maneuver,
      siege: leader.siege,
      activation: leader.activation,
      battles: 0,
      wins: 0,
      kills: 0,
      taken: 0,
    });
    byKey.set(key, list);
    candidateTags.add(tag);
  };

  // ① every leader the country panel already carries.
  for (const tag of Object.keys(countryDetail)) {
    const identity = resolveTagLatest(aliases, tag);
    for (const leader of (countryDetail[tag] as CountryDetailRecord).leaders) {
      addCandidate(identity, leader);
    }
  }

  // ---- the battles ---------------------------------------------------------
  const resolvedTags = new Set<string>();
  const commanderSides: Array<{ tag: string; name: string; ordinal: number; kills: number; taken: number; won: boolean }> = [];
  for (const war of wars) {
    for (const battle of war.battles) {
      const ordinal = ordinalOf(battle.date);
      const sides: Array<[BattleSide, BattleSide, boolean]> = [
        [battle.attacker, battle.defender, battle.attackerWon],
        [battle.defender, battle.attacker, !battle.attackerWon],
      ];
      for (const [side, opponent, won] of sides) {
        if (!side.country) continue;
        const tag = resolveTagLatest(aliases, side.country);
        resolvedTags.add(tag);
        if (!side.commander) continue;
        commanderSides.push({
          tag,
          name: side.commander,
          ordinal,
          kills: opponent.losses ?? 0,
          taken: side.losses ?? 0,
          won,
        });
      }
    }
  }

  // ② the tags the country panel has no entry for (they no longer own a province), read
  // from `countries/{tag}/history` directly. A tag with no `history` block at all cannot
  // be read — the coverage block reports that rather than pretending otherwise.
  const missingTags = new Set<string>();
  for (const tag of resolvedTags) if (!(tag in countryDetail)) missingTags.add(tag);
  if (missingTags.size > 0) {
    const countryRef = doc.section('countries');
    if (countryRef) {
      const reader = new ClausewitzReader(doc.gamestate, countryRef.start + 1, countryRef.end - 1);
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.kind !== 'block' || member.key === null) continue;
        if (!missingTags.has(member.key)) continue;
        for (const leader of rkHistoryLeaders(reader.enter(member))) {
          addCandidate(member.key, leader);
        }
      }
    }
  }

  // ---- attribute the battles ----------------------------------------------
  let joinedSides = 0;
  for (const side of commanderSides) {
    const list = byKey.get(`${side.tag}\u0000${side.name}`);
    if (!list || list.length === 0) continue;
    joinedSides += 1;
    let target = list[0] as RankingCandidate;
    if (list.length > 1) {
      // 同名多人 (§3.5): the battle goes to the person whose `activation` is closest to
      // the battle date. Counted by `tmp/a4-rankings-check.ts`, not published — `meta`'s
      // shape is frozen and this number is a report figure.
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of list) {
        const distance = Math.abs(ordinalOf(candidate.activation) - side.ordinal);
        if (distance < best) {
          best = distance;
          target = candidate;
        }
      }
    }
    target.battles += 1;
    if (side.won) target.wins += 1;
    target.kills += side.kills;
    target.taken += side.taken;
  }

  // ---- score the generals --------------------------------------------------
  const generalSkill = (candidate: RankingCandidate): number =>
    candidate.fire + candidate.shock + candidate.maneuver + candidate.siege;
  const generalWar = (candidate: RankingCandidate): number => candidate.kills - candidate.taken;

  const generalPool = [...byKey.values()].flat().filter((candidate) => candidate.battles >= 1);
  const skillRange = rkMinMax(generalPool.map(generalSkill));
  const warRange = rkMinMax(generalPool.map(generalWar));
  const generalScores = generalPool.map((candidate) => {
    const skill = rkNorm(generalSkill(candidate), skillRange.min, skillRange.max);
    const war = rkNorm(generalWar(candidate), warRange.min, warRange.max);
    const win = candidate.battles > 0 ? candidate.wins / candidate.battles : 0;
    return {
      candidate,
      skill,
      war,
      win,
      score: rkRound(
        100 *
          (RK_GENERAL_WEIGHTS.skill * skill + RK_GENERAL_WEIGHTS.war * war + RK_GENERAL_WEIGHTS.win * win),
        1,
      ),
    };
  });
  const qualifiedGenerals = generalScores.filter(
    (entry) => entry.candidate.battles >= RK_MIN_GENERAL_BATTLES,
  );
  // score ↓ → battles ↓ → skill ↓ → name ↑ (§3.5). `Array.prototype.sort` is stable, so
  // exact ties keep the deterministic pool order and the two planes agree.
  qualifiedGenerals.sort(
    (a, b) =>
      b.score - a.score ||
      b.candidate.battles - a.candidate.battles ||
      generalSkill(b.candidate) - generalSkill(a.candidate) ||
      a.candidate.name.localeCompare(b.candidate.name),
  );
  const generals: RankingGeneral[] = qualifiedGenerals.slice(0, RK_BOARD_SIZE).map((entry) => {
    const candidate = entry.candidate;
    return {
      tag: candidate.tag,
      name: candidate.name,
      kind: candidate.kind,
      fire: candidate.fire,
      shock: candidate.shock,
      maneuver: candidate.maneuver,
      siege: candidate.siege,
      skill: generalSkill(candidate),
      battles: candidate.battles,
      wins: candidate.wins,
      winRate: candidate.battles > 0 ? candidate.wins / candidate.battles : 0,
      kills: candidate.kills,
      taken: candidate.taken,
      net: candidate.kills - candidate.taken,
      score: entry.score,
      parts: { skill: entry.skill, war: entry.war, win: entry.win },
    };
  });

  // ---- the monarch candidate pool ------------------------------------------
  // Three exclusion rules (§3.5), all applied to the normalisation pool: a nameless
  // placeholder, a country whose whole record is one still-ruling entry (a reign that
  // spans the campaign), and a reign shorter than five years.
  const monarchCandidates: Array<{
    tag: string;
    identity: string;
    ruler: CountryRuler;
    startOrdinal: number;
    endOrdinal: number;
  }> = [];
  for (const tag of Object.keys(countryDetail)) {
    const rulers = (countryDetail[tag] as CountryDetailRecord).rulers;
    const identity = resolveTagLatest(aliases, tag);
    for (const ruler of rulers) {
      if (!ruler.name) continue;
      if (rulers.length === 1 && ruler.end === '') continue;
      if (ruler.months < RK_MIN_REIGN_MONTHS) continue;
      monarchCandidates.push({
        tag,
        identity,
        ruler,
        startOrdinal: ordinalOf(ruler.start),
        endOrdinal: ruler.end ? ordinalOf(ruler.end) : ordinalOf(saveDate),
      });
    }
  }

  const devResults = rkDevelopmentReplay(
    timeline,
    provinces,
    aliases,
    monarchCandidates.map((candidate) => ({
      identity: candidate.identity,
      startOrdinal: candidate.startOrdinal,
      endOrdinal: candidate.endOrdinal,
    })),
  );

  const monarchEntries = monarchCandidates.map((candidate, index) => {
    const dev = devResults[index] as { devStart: number; devEnd: number; provincesGain: number };
    const devStart = rkRound(dev.devStart, 3);
    const devEnd = rkRound(dev.devEnd, 3);
    const growth = rkRound(devEnd - devStart, 3);
    const months = candidate.ruler.months;
    const pace = months > 0 ? rkRound(growth / (months / 12), 3) : 0;
    return {
      candidate,
      ability: candidate.ruler.adm + candidate.ruler.dip + candidate.ruler.mil,
      tenure: months,
      growth,
      pace,
      devStart,
      devEnd,
      provincesGain: dev.provincesGain,
    };
  });

  const abilityRange = rkMinMax(monarchEntries.map((entry) => entry.ability));
  const tenureRange = rkMinMax(monarchEntries.map((entry) => entry.tenure));
  const growthRange = rkMinMax(monarchEntries.map((entry) => entry.growth));
  const paceRange = rkMinMax(monarchEntries.map((entry) => entry.pace));
  const monarchScores = monarchEntries.map((entry) => {
    const ability = rkNorm(entry.ability, abilityRange.min, abilityRange.max);
    const tenure = rkNorm(entry.tenure, tenureRange.min, tenureRange.max);
    const growth = rkNorm(entry.growth, growthRange.min, growthRange.max);
    const pace = rkNorm(entry.pace, paceRange.min, paceRange.max);
    return {
      ...entry,
      parts: { ability, tenure, growth, pace },
      score: rkRound(
        100 *
          (RK_MONARCH_WEIGHTS.ability * ability +
            RK_MONARCH_WEIGHTS.tenure * tenure +
            RK_MONARCH_WEIGHTS.growth * growth +
            RK_MONARCH_WEIGHTS.pace * pace),
        1,
      ),
    };
  });
  // score ↓ → devGain ↓ → months ↓ → name ↑ (§3.5).
  monarchScores.sort(
    (a, b) =>
      b.score - a.score ||
      b.growth - a.growth ||
      b.tenure - a.tenure ||
      a.candidate.ruler.name.localeCompare(b.candidate.ruler.name),
  );
  const monarchs: RankingMonarch[] = monarchScores.slice(0, RK_BOARD_SIZE).map((entry) => ({
    tag: entry.candidate.tag,
    name: entry.candidate.ruler.name,
    adm: entry.candidate.ruler.adm,
    dip: entry.candidate.ruler.dip,
    mil: entry.candidate.ruler.mil,
    stats: entry.ability,
    start: entry.candidate.ruler.start,
    end: entry.candidate.ruler.end,
    months: entry.tenure,
    devStart: entry.devStart,
    devEnd: entry.devEnd,
    devGain: entry.growth,
    devPerYear: entry.pace,
    provincesGain: entry.provincesGain,
    score: entry.score,
    parts: entry.parts,
  }));

  let tagsWithLeaders = 0;
  for (const tag of resolvedTags) if (candidateTags.has(tag)) tagsWithLeaders += 1;

  return {
    meta: {
      generalPool: generalPool.length,
      generalQualified: qualifiedGenerals.length,
      monarchPool: monarchEntries.length,
      weights: {
        general: {
          skill: RK_GENERAL_WEIGHTS.skill,
          war: RK_GENERAL_WEIGHTS.war,
          win: RK_GENERAL_WEIGHTS.win,
        },
        monarch: {
          ability: RK_MONARCH_WEIGHTS.ability,
          tenure: RK_MONARCH_WEIGHTS.tenure,
          growth: RK_MONARCH_WEIGHTS.growth,
          pace: RK_MONARCH_WEIGHTS.pace,
        },
      },
      floors: { minBattles: RK_MIN_GENERAL_BATTLES, minReignMonths: RK_MIN_REIGN_MONTHS },
      coverage: {
        commandedSides: commanderSides.length,
        joinedSides,
        resolvedTags: resolvedTags.size,
        tagsWithLeaders,
      },
    },
    generals,
    monarchs,
  };
}

// --------------------------------------------------------------- entry point ---
export function buildDetailTables(input: DetailInput): DetailTables {
  const { doc, provinces, tagId, saveDate } = input;
  const tables = normaliseTables(input.tables);
  const province = provinceTables(provinces, tagId, tables);
  const areaWalk = areaDetails(doc, tagId);

  // `areaDetail` is keyed by the area's **index into `provinceArea.dict`** rendered as
  // a string: that is what the client has after `provinceArea.byId[provId]`, and it is
  // what 阶段任务书 §2 freezes (`{ [areaIdx: string]: … }`).
  const areaIndex = new Map(province.provinceArea.dict.map((key, i) => [key, i]));
  const areaDetail: Record<string, AreaDetailEntry> = {};
  for (const [key, entry] of Object.entries(areaWalk.detail)) {
    const index = areaIndex.get(key);
    if (index === undefined) continue;
    areaDetail[String(index)] = entry;
  }

  // Province owners: only these get a country panel entry. In the sample save that is
  // 273 tags — exactly the number of countries the save gives `development`.
  const landed = new Set<string>();
  for (const record of provinces.values()) {
    if (record.owner && record.owner !== '---' && record.owner !== 'REB') landed.add(record.owner);
  }

  // Owned-province aggregation: religion development, the culture table, and the two
  // wave-2 roll-ups (buildings per country, and each country's areas).
  const religionDev = new Map<string, Record<string, number>>();
  const cultureStats = new Map<
    string,
    Map<string, { provinces: number; dev: number; statedProvinces: number; statedDev: number }>
  >();
  const buildingCounts = new Map<string, Map<string, number>>();
  const stateAgg = new Map<
    string,
    Map<string, { dev: number; stateHouse: boolean; hasDevastation: boolean }>
  >();
  for (const record of provinces.values()) {
    const owner = record.owner;
    if (!owner || owner === '---' || owner === 'REB' || !landed.has(owner)) continue;
    const dev = (record.baseTax ?? 0) + (record.baseProduction ?? 0) + (record.baseManpower ?? 0);
    const religion = record.religion ?? '';
    const byReligion = religionDev.get(owner) ?? {};
    byReligion[religion] = (byReligion[religion] ?? 0) + dev;
    religionDev.set(owner, byReligion);

    const culture = record.culture ?? '';
    const byCulture = cultureStats.get(owner) ?? new Map();
    const tally = byCulture.get(culture) ?? { provinces: 0, dev: 0, statedProvinces: 0, statedDev: 0 };
    tally.provinces += 1;
    tally.dev += dev;
    const stated = areaWalk.statedAreas.get(owner);
    const recordArea = tables.areaById.get(record.id);
    if (stated && recordArea !== undefined && stated.has(recordArea)) {
      tally.statedProvinces += 1;
      tally.statedDev += dev;
    }
    byCulture.set(culture, tally);
    cultureStats.set(owner, byCulture);

    // 建筑统计：从各省 `buildings` 现算（契约明说不要用 `num_of_buildings_indexed`）。
    const byBuilding = buildingCounts.get(owner) ?? new Map<string, number>();
    for (const building of record.buildings) {
      byBuilding.set(building, (byBuilding.get(building) ?? 0) + 1);
    }
    buildingCounts.set(owner, byBuilding);

    // 州：本国拥有的省按地区归拢（地区 key 来自 S2 的 area.json）。
    if (recordArea !== undefined) {
      const byArea = stateAgg.get(owner) ?? new Map();
      const agg = byArea.get(recordArea) ?? { dev: 0, stateHouse: false, hasDevastation: false };
      agg.dev += dev;
      if (record.buildings.includes('state_house')) agg.stateHouse = true;
      if ((record.devastation ?? 0) > 0) agg.hasDevastation = true;
      byArea.set(recordArea, agg);
      stateAgg.set(owner, byArea);
    }
  }

  // Baked once: the panels, the history log's value lookups and the returned `uiNames`
  // all read this one object (the two planes are compared with `JSON.stringify`).
  const bakedNames = bakeUiNames(input.tables?.uiNames);

  // The 21 base-game advisor type keys：顾问网格只列这些，某类型出现在 `countries/{TAG}/flags`
  // 里才算「已触发」（pdx-tools 同款语义）；名字优先取 `uiNames.advisors`（含 mod 的 1315 条）。
  const advisorTable = stringMap(jsonObject(input.tables?.advisorIds));
  const advisorIds = Object.keys(advisorTable)
    .sort()
    .map((id) => ({ id, name: advisorTable[id] as string }));
  const wave2: Wave2Input = {
    buildingCounts,
    stateAgg,
    areaById: tables.areaById,
    areaNames: tables.areaNames,
    stateProsperity: areaWalk.stateProsperity,
    advisorIds,
    uiNames: bakedNames,
  };
  const wave3: Wave3Input = {
    ledgerSlots: bakeLedgerSlots(input.tables?.ledgerSlots),
    manaSlots: bakeManaSlots(input.tables?.manaSlots),
  };

  // The four families the dated history log prints as values, taken from the same baked
  // object the panels read (第四对话任务书 §2.5 第 2/3 项). `government` / `decisions`
  // belong to task B and are `{}` until it lands — `rkName` then returns the raw key.
  const historyNames: HistoryNames = {
    religions: bakedNames['religions'] ?? {},
    cultures: bakedNames['cultures'] ?? {},
    government: bakedNames['government'] ?? {},
    decisions: bakedNames['decisions'] ?? {},
  };

  // War rows for the History tab. Both planes already extracted the wars, so they are
  // handed in rather than parsed a second time.
  const warRows = new Map<string, CountryHistoryRow[]>();
  const campaignStart = input.startDate ? ordinalOf(input.startDate) : 0;
  for (const war of input.wars ?? []) {
    const joined = new Map<string, string>();
    const left = new Map<string, string>();
    for (const event of war.events) {
      const tags = event.tags.length > 0 ? event.tags : [];
      if (event.kind === 'add_attacker' || event.kind === 'add_defender') {
        for (const tag of tags) if (!joined.has(tag)) joined.set(tag, event.date);
      } else if (event.kind === 'rem_attacker' || event.kind === 'rem_defender') {
        for (const tag of tags) if (!left.has(tag)) left.set(tag, event.date);
      }
    }
    const participants = new Set<string>([...war.attackers, ...war.defenders, ...joined.keys(), ...left.keys()]);
    const warLabel = rkWarName(war.name);
    for (const tag of participants) {
      if (!landed.has(tag)) continue;
      const rows = warRows.get(tag) ?? [];
      const start = joined.get(tag) ?? war.startDate;
      if (start && ordinalOf(start) > campaignStart) {
        rows.push({ date: start, ordinal: ordinalOf(start), kind: 'warStart', text: warLabel });
      }
      const end = left.get(tag) ?? (war.ongoing ? undefined : war.endDate);
      if (end && end !== start) {
        rows.push({ date: end, ordinal: ordinalOf(end), kind: 'warEnd', text: `退出：${warLabel}` });
      }
      warRows.set(tag, rows);
    }
  }

  const countryDetail: Record<string, CountryDetailRecord> = {};
  const countryRef = doc.section('countries');
  if (countryRef) {
    const reader = new ClausewitzReader(doc.gamestate, countryRef.start + 1, countryRef.end - 1);
    let index = 0;
    for (;;) {
      const member = reader.nextMember();
      if (!member) break;
      if (member.kind !== 'block' || member.key === null) continue;
      const tag = member.key;
      const countryIndex = index;
      index += 1;
      if (!landed.has(tag)) continue;
      const scratch = readCountry(reader, member, tag, countryIndex, historyNames);
      countryDetail[tag] = shapeCountry(
        scratch,
        religionDev.get(tag) ?? {},
        cultureStats.get(tag) ?? new Map(),
        warRows.get(tag) ?? [],
        saveDate,
        input.startDate,
        wave2,
        wave3,
      );
    }
  }

  // The keys are sorted, not in walk order: it is part of the JSON both planes compare.
  const sortedCountries: Record<string, CountryDetailRecord> = {};
  for (const tag of Object.keys(countryDetail).sort()) {
    sortedCountries[tag] = countryDetail[tag] as CountryDetailRecord;
  }

  // 两张排行榜 (第四对话任务书 §3.4/§3.5). Built here, once, so the two data planes share
  // the formula; the planes only hand in the timeline they already built.
  const rankings = buildRankings({
    doc,
    provinces,
    countryDetail: sortedCountries,
    wars: input.wars ?? [],
    timeline: input.timeline ?? buildTimeline(doc),
    saveDate,
  });

  return {
    ...province,
    areaDetail,
    countryDetail: sortedCountries,
    uiNames: bakedNames,
    ledgerSlots: bakeLedgerSlots(input.tables?.ledgerSlots),
    manaSlots: bakeManaSlots(input.tables?.manaSlots),
    rankings,
  };
}
