/**
 * Domain types for a parsed EU4 save.
 *
 * Vocabulary:
 *   - *tag*      three-letter country identifier as used by EU4 (`RUS`, `MOS`, `---`).
 *   - *province* numeric province id (0 is an uncolonised/placeholder entry, -1 sea).
 *   - *snapshot* the extracted, JSON-friendly state of one save at one date.
 */

/** `savegame_version` block from `meta`. */
export interface SaveVersion {
  first: number;
  second: number;
  third: number;
  forth: number;
  name?: string;
  /** Rendered as `1.37.5.0`. */
  text: string;
}

export interface ModInfo {
  filename: string;
  name: string;
}

/** One row of the "campaign stats" scoreboard found in `meta`. */
export interface CampaignStat {
  id?: number;
  comparison?: number;
  key?: string;
  selector?: string;
  localization?: string;
  value?: number;
  sampleValue?: number;
  sampleCount?: number;
}

/** Everything read out of the archive's small `meta` member. */
export interface SaveMeta {
  date: string;
  /** The file name the session was saved under, as recorded inside the save. */
  saveGame?: string;
  player?: string;
  displayedCountryName?: string;
  version: SaveVersion;
  /** All engine versions that touched this campaign. */
  versions: string[];
  dlc: string[];
  mods: ModInfo[];
  multiPlayer: boolean;
  notObserver: boolean;
  campaignId?: string;
  campaignLength?: number;
  checksum?: string;
  campaignStats: CampaignStat[];
  /** Unparsed leftovers, for forward compatibility. */
  raw?: unknown;
}

/** A province as stored in `gamestate/provinces`. */
export interface ProvinceRecord {
  id: number;
  name?: string;
  owner?: string;
  controller?: string;
  previousController?: string;
  /** Tag holding a territorial core here, if any. */
  territorialCore?: string;
  /** All tags with a core claim. */
  cores: string[];
  /** All tags with a (non-core) claim on this province. */
  claims: string[];
  /** Building keys present here (only the ones recorded `yes`), in file order. */
  buildings: string[];
  /** `building_builders`: building key -> the tag that paid for it. */
  buildingBuilders: Record<string, string>;
  /** Great-project keys built here; a province can hold several. */
  greatProjects: string[];
  /** `latent_trade_goods`: goods this province could still switch to. */
  latentTradeGoods: string[];
  /** `country_improve_count`: who expanded the infrastructure here, and how often. */
  countryImprove: Array<{ tag: string; count: number }>;
  /** `devastation` (only written when above zero), promoted out of `extra`. */
  devastation?: number;
  /** `active_trade_company` (only written when true), promoted out of `extra`. */
  activeTradeCompany?: boolean;
  capital?: string;
  culture?: string;
  originalCulture?: string;
  nativeCulture?: string;
  religion?: string;
  originalReligion?: string;
  trade?: string;
  tradeGoods?: string;
  baseTax?: number;
  baseProduction?: number;
  baseManpower?: number;
  garrison?: number;
  isCity?: boolean;
  likelyRebels?: string;
  institutions: number[];
  /** Every other flat scalar found on the province, verbatim. */
  extra: Record<string, string>;
}

/**
 * A country as stored in `gamestate/countries`.
 *
 * Country blocks repeat keys legitimately (`rival`, `estate`, `active_age_ability`,
 * `ignore_decision`, ...), so every map below widens to an array as soon as a key
 * is seen twice. Use the `countryScalar` / `countryScalarList` / `countryGroup`
 * helpers in `document.ts` instead of indexing these maps directly.
 */
export interface CountryRecord {
  tag: string;
  /** Flat scalars from the country block; repeated keys become arrays. */
  scalars: Record<string, string | string[]>;
  /** Bare list blocks of scalars, e.g. `cores`, `provinces`. */
  lists: Record<string, string[]>;
  /** Small sub-blocks flattened one level; repeated blocks become arrays. */
  groups: Record<string, Record<string, string> | Array<Record<string, string>>>;
  /** Larger sub-blocks, summarised. Fetch them with `SaveDocument.countryDetail`. */
  blocks: Record<string, BlockSummary | BlockSummary[]>;
}

export interface BlockSummary {
  members: number;
  bytes: number;
  /** Names of the sub-block's own members (capped), when collected. */
  keys?: string[];
}

export interface SnapshotStats {
  provinceCount: number;
  ownedProvinceCount: number;
  countryCount: number;
}

/** The complete extracted state of one save. */
export interface SaveSnapshot {
  /** Absolute path or user-supplied label of the source file. */
  source: string;
  meta: SaveMeta;
  /** `start_date` from the gamestate (campaign start bookmark). */
  startDate?: string;
  currentAge?: string;
  gamestateChecksum?: string;
  /** tag -> player name, from `players_countries`. */
  players: Array<{ name: string; tag: string }>;
  provinces: Record<number, ProvinceRecord>;
  countries: Record<string, CountryRecord>;
  /** Small named gamestate sections parsed verbatim (statistics, flags, ...). */
  sections: Record<string, unknown>;
  stats: SnapshotStats;
  /** Warnings gathered while parsing (unknown escape markers, odd blocks...). */
  warnings: string[];
  /** Wall-clock duration of the extraction, in milliseconds. */
  elapsedMs: number;
}

/** A top-level (or nested) member located inside the gamestate buffer. */
export interface SectionRef {
  key: string;
  kind: 'block' | 'string' | 'scalar';
  start: number;
  end: number;
  /** Byte length of the value. */
  size: number;
  /** Position in file order. */
  order: number;
}
