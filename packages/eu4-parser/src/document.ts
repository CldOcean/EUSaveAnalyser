/**
 * `SaveDocument` — the entry point of the parser.
 *
 * ```ts
 * const doc = await SaveDocument.fromFile('存档示例/mp_俄罗斯1574_11_12.eu4');
 * console.log(doc.meta.date, doc.meta.displayedCountryName);
 * const snapshot = doc.snapshot();
 * ```
 *
 * The archive is read once, the `gamestate` member is inflated once, and every
 * later query works directly on that buffer. Large sections that are not needed
 * are *skipped*, never materialised — walking the 37 MB `countries` block costs a
 * single brace-balanced scan.
 */

import { readFile } from 'node:fs/promises';
import { ClausewitzReader } from './clausewitz.ts';
import { decodeEu4String } from './encoding.ts';
import { SaveArchive } from './zip.ts';
import {
  parseGameDate,
  readNode,
  toBoolean,
  toNumber,
  type CwBlockNode,
  type CwEntry,
  type CwListNode,
  type CwNode,
} from './value.ts';
import type {
  BlockSummary,
  CampaignStat,
  CountryRecord,
  ModInfo,
  ProvinceRecord,
  SaveMeta,
  SaveSnapshot,
  SaveVersion,
  SectionRef,
} from './types.ts';

export interface ExtractOptions {
  /** Flatten depth-0 sub-blocks up to this many bytes into `groups`. */
  maxGroupBytes?: number;
  /** Also collect the member keys of large sub-blocks. Default `true`. */
  collectBlockKeys?: boolean;
  /** Top-level sections to parse verbatim. `'all'` parses everything small. */
  sections?: readonly string[] | 'all';
  /** Hard ceiling for a section to be parsed verbatim in `'all'` mode. */
  maxSectionBytes?: number;
}

const DEFAULT_MAX_GROUP_BYTES = 16 * 1024;

/** Sections that are cheap and genuinely useful in a snapshot. */
export const DEFAULT_SNAPSHOT_SECTIONS: readonly string[] = [
  'players_countries',
  'gameplaysettings',
  'used_client_names',
  'id_counters',
  'flags',
  'revolution',
  'map_area_data',
  'great_projects',
  'active_advisors',
  'diplomacy',
  'active_war',
  'empire',
  'hre_leagues_status',
  'hre_religion_status',
  'trade_company_manager',
  'tech_level_dates',
  'idea_dates',
  'achievement_ok',
  'start_date',
  'current_age',
  'checksum',
  'multiplayer_random_seed',
];

/** Read-only lookup over a parsed block. */
export class BlockView {
  readonly node: CwBlockNode | CwListNode;
  readonly #map = new Map<string, CwNode[]>();

  constructor(node: CwBlockNode | CwListNode) {
    this.node = node;
    if (node.type === 'block') {
      for (const entry of node.entries) {
        const list = this.#map.get(entry.key);
        if (list) list.push(entry.value);
        else this.#map.set(entry.key, [entry.value]);
      }
    }
  }

  static from(node: CwNode | undefined): BlockView | undefined {
    if (!node) return undefined;
    if (node.type !== 'block' && node.type !== 'list') return undefined;
    return new BlockView(node);
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  first(key: string): CwNode | undefined {
    return this.#map.get(key)?.[0];
  }

  all(key: string): CwNode[] {
    return this.#map.get(key) ?? [];
  }

  keys(): string[] {
    return [...this.#map.keys()];
  }

  scalar(key: string): string | undefined {
    const node = this.first(key);
    return node && node.type === 'scalar' ? node.value : undefined;
  }

  string(key: string): string | undefined {
    const node = this.first(key);
    if (!node) return undefined;
    if (node.type === 'string') return node.value;
    if (node.type === 'scalar') return node.value;
    return undefined;
  }

  number(key: string): number | undefined {
    return toNumber(this.scalar(key));
  }

  bool(key: string): boolean | undefined {
    return toBoolean(this.scalar(key));
  }

  block(key: string): BlockView | undefined {
    return BlockView.from(this.first(key));
  }

  /** A list block (`{ "a" "b" }`) rendered as strings. */
  stringList(key: string): string[] {
    const node = this.first(key);
    if (!node) return [];
    if (node.type === 'list') {
      return node.items.map((item) =>
        item.type === 'scalar' || item.type === 'string' ? item.value : '',
      );
    }
    if (node.type === 'block') {
      return node.entries.map((entry) => entry.key);
    }
    return [];
  }
}

export interface LoadOptions {
  /** Overrides the `source` label recorded in the snapshot. */
  source?: string;
}

export class SaveDocument {
  readonly archive: SaveArchive;
  readonly source: string;
  /** Raw `meta` member contents. */
  readonly metaBytes: Uint8Array;
  /** Raw, inflated `gamestate` member contents. */
  readonly gamestate: Uint8Array;
  /** Top-level `gamestate` members, in file order. */
  readonly sections: readonly SectionRef[];
  /** Non-fatal issues encountered while parsing. */
  readonly warnings: string[] = [];

  #meta: SaveMeta | undefined;
  #sectionIndex: Map<string, SectionRef[]> | undefined;
  #provinces: Map<number, ProvinceRecord> | undefined;
  #countries: Map<string, CountryRecord> | undefined;

  private constructor(
    archive: SaveArchive,
    source: string,
    metaBytes: Uint8Array,
    gamestate: Uint8Array,
  ) {
    this.archive = archive;
    this.source = source;
    this.metaBytes = metaBytes;
    this.gamestate = gamestate;
    this.sections = indexTopLevel(gamestate);
  }

  /**
   * Open a save whose members have already been inflated.
   *
   * Browsers cannot inflate synchronously (there is no `inflateRawSync`; the
   * native `DecompressionStream` is async), so the browser unpacks the zip itself
   * and hands the two members over here. Everything downstream is identical to
   * `fromBuffer`, which is what makes a browser build of this parser possible at
   * all: no DEFLATE implementation is needed on that side.
   */
  static fromMembers(
    members: { meta: Uint8Array; gamestate: Uint8Array; names?: readonly string[] },
    source = '<browser>',
  ): SaveDocument {
    if (!members.meta || !members.gamestate) {
      throw new Error(`"${source}" is not a readable EU4 save: meta and gamestate are both required`);
    }
    const archive = SaveArchive.fromInflated(
      members.meta,
      members.gamestate,
      members.names ?? ['meta', 'gamestate'],
    );
    return new SaveDocument(archive, source, members.meta, members.gamestate);
  }

  /** Open a `.eu4` file from disk. */
  static async fromFile(path: string, options: LoadOptions = {}): Promise<SaveDocument> {
    const buffer = await readFile(path);
    return SaveDocument.fromBuffer(new Uint8Array(buffer), options.source ?? path);
  }

  /** Open an in-memory `.eu4` archive (e.g. an upload). */
  static fromBuffer(buffer: Uint8Array, source = '<buffer>'): SaveDocument {
    const archive = new SaveArchive(buffer);
    const metaBytes = archive.read('meta');
    if (!metaBytes) {
      throw new Error(
        `"${source}" is not a readable EU4 save: missing the "meta" member ` +
          `(found: ${archive.names.join(', ') || 'nothing'})`,
      );
    }
    const gamestate = archive.read('gamestate');
    if (!gamestate) {
      throw new Error(
        `"${source}" is missing the "gamestate" member ` +
          `(found: ${archive.names.join(', ') || 'nothing'})`,
      );
    }
    return new SaveDocument(archive, source, metaBytes, gamestate);
  }

  // ---------------------------------------------------------------- meta ----

  get meta(): SaveMeta {
    this.#meta ??= parseMeta(this.metaBytes, this.warnings);
    return this.#meta;
  }

  // ------------------------------------------------------------ sections ----

  #index(): Map<string, SectionRef[]> {
    if (!this.#sectionIndex) {
      const index = new Map<string, SectionRef[]>();
      for (const section of this.sections) {
        const list = index.get(section.key);
        if (list) list.push(section);
        else index.set(section.key, [section]);
      }
      this.#sectionIndex = index;
    }
    return this.#sectionIndex;
  }

  section(key: string): SectionRef | undefined {
    return this.#index().get(key)?.[0];
  }

  /** All references for a repeated top-level key, e.g. `active_war`. */
  allSections(key: string): SectionRef[] {
    return this.#index().get(key) ?? [];
  }

  hasSection(key: string): boolean {
    return this.#index().has(key);
  }

  /** Parse a top-level section into a generic value tree. */
  readSection(key: string): CwNode | undefined {
    const ref = this.section(key);
    if (!ref) return undefined;
    return this.#readRef(ref);
  }

  readSectionView(key: string): BlockView | undefined {
    return BlockView.from(this.readSection(key));
  }

  #readRef(ref: SectionRef): CwNode {
    const reader = new ClausewitzReader(this.gamestate, ref.start, ref.end);
    const member = reader.nextMember();
    if (!member) throw new Error(`section "${ref.key}" is empty`);
    return readNode(reader, member);
  }

  /**
   * A reader positioned *inside* a block section, covering only its members.
   * `SectionRef.start` points at the opening brace, so callers that want to walk
   * the members must step one byte in on each side.
   */
  #bodyReader(ref: SectionRef): ClausewitzReader | undefined {
    if (ref.kind !== 'block') return undefined;
    return new ClausewitzReader(this.gamestate, ref.start + 1, ref.end - 1);
  }

  // ------------------------------------------------------------ provinces ---

  /** Extract every province, keyed by id. Cached. */
  provinces(): Map<number, ProvinceRecord> {
    if (this.#provinces) return this.#provinces;
    const out = new Map<number, ProvinceRecord>();
    const ref = this.section('provinces');
    const reader = ref ? this.#bodyReader(ref) : undefined;
    if (reader) {
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.kind !== 'block' || member.key === null) continue;
        const id = provinceIdFromKey(member.key);
        if (id === undefined) continue;
        out.set(id, extractProvince(reader, member, id));
      }
    }
    this.#provinces = out;
    return out;
  }

  // ------------------------------------------------------------ countries ---

  /** Extract every country, keyed by tag. Cached. */
  countries(options: ExtractOptions = {}): Map<string, CountryRecord> {
    if (this.#countries) return this.#countries;
    const maxGroupBytes = options.maxGroupBytes ?? DEFAULT_MAX_GROUP_BYTES;
    const out = new Map<string, CountryRecord>();
    const ref = this.section('countries');
    const reader = ref ? this.#bodyReader(ref) : undefined;
    if (reader) {
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.kind !== 'block' || member.key === null) continue;
        out.set(
          member.key,
          extractCountry(reader, member, member.key, maxGroupBytes),
        );
      }
    }
    this.#countries = out;
    return out;
  }

  /** Parse a single country's complete block, unresolved and verbatim. */
  countryDetail(tag: string): BlockView | undefined {
    for (const ref of this.allSections('countries')) {
      const reader = this.#bodyReader(ref);
      if (!reader) continue;
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.key === tag && member.kind === 'block') {
          return BlockView.from(readNode(reader, member));
        }
      }
    }
    return undefined;
  }

  /** Parse a single province's complete block, unresolved and verbatim. */
  provinceDetail(id: number): BlockView | undefined {
    const ref = this.section('provinces');
    const reader = ref ? this.#bodyReader(ref) : undefined;
    if (!reader) return undefined;
    const wanted = new Set([String(id), String(-id)]);
    for (;;) {
      const member = reader.nextMember();
      if (!member) break;
      if (member.key !== null && wanted.has(member.key) && member.kind === 'block') {
        return BlockView.from(readNode(reader, member));
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- dump ----

  /**
   * Describe the immediate members of a section (or of one entry inside it).
   * Used by `cli.ts dump` and for exploring unfamiliar saves.
   */
  describe(
    key: string,
    entryKey?: string,
    limit = 200,
  ): Array<{ key: string | null; kind: string; size: number }> {
    const ref = this.section(key);
    if (!ref) return [];
    let reader = this.#bodyReader(ref) ?? new ClausewitzReader(this.gamestate, ref.start, ref.end);
    if (entryKey !== undefined) {
      let found: ClausewitzReader | undefined;
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.key === entryKey && member.kind === 'block') {
          found = reader.enter(member);
          break;
        }
      }
      if (!found) return [];
      reader = found;
    }
    const out: Array<{ key: string | null; kind: string; size: number }> = [];
    for (let i = 0; i < limit; i += 1) {
      const member = reader.nextMember();
      if (!member) break;
      out.push({
        key: member.key,
        kind: member.kind,
        size: member.valueEnd - member.valueStart,
      });
    }
    return out;
  }

  // ------------------------------------------------------------ snapshot ----

  /** Build the full extracted snapshot used by the API and the UI. */
  snapshot(options: ExtractOptions = {}): SaveSnapshot {
    const startedAt = performance.now();
    const provinces = this.provinces();
    const countries = this.countries(options);
    const meta = this.meta;

    const players: Array<{ name: string; tag: string }> = [];
    const playersRef = this.section('players_countries');
    const playersReader = playersRef ? this.#bodyReader(playersRef) : undefined;
    if (playersReader) {
      const reader = playersReader;
      const values: string[] = [];
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.kind !== 'string') continue;
        values.push(reader.stringValue(member));
      }
      for (let i = 0; i + 1 < values.length; i += 2) {
        players.push({ name: values[i] as string, tag: values[i + 1] as string });
      }
    }

    const sections: Record<string, unknown> = {};
    const wanted =
      options.sections === 'all'
        ? this.sections
            .filter(
              (s) =>
                s.key !== 'countries' &&
                s.key !== 'provinces' &&
                s.size <= (options.maxSectionBytes ?? 2 * 1024 * 1024),
            )
            .map((s) => s.key)
        : (options.sections ?? DEFAULT_SNAPSHOT_SECTIONS);

    for (const key of new Set(wanted)) {
      if (key === 'countries' || key === 'provinces') continue;
      const refs = this.allSections(key);
      if (refs.length === 0) continue;
      if (refs.length === 1) {
        sections[key] = plainSection(this.#readRef(refs[0] as SectionRef));
      } else {
        sections[key] = refs.map((ref) => plainSection(this.#readRef(ref)));
      }
    }

    let owned = 0;
    for (const province of provinces.values()) {
      if (province.owner && province.owner !== '---') owned += 1;
    }

    return {
      source: this.source,
      meta,
      startDate: this.section('start_date')
        ? scalarOf(this.readSection('start_date'))
        : undefined,
      currentAge: this.section('current_age')
        ? scalarOf(this.readSection('current_age'))
        : undefined,
      gamestateChecksum: this.section('checksum')
        ? scalarOf(this.readSection('checksum'))
        : undefined,
      players,
      provinces: Object.fromEntries(provinces),
      countries: Object.fromEntries(countries),
      sections,
      stats: {
        provinceCount: provinces.size,
        ownedProvinceCount: owned,
        countryCount: countries.size,
      },
      warnings: [...this.warnings],
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }
}

// ---------------------------------------------------------------- helpers ----

/** Scan the top level of the gamestate without materialising anything. */
function indexTopLevel(buf: Uint8Array): SectionRef[] {
  const out: SectionRef[] = [];
  const reader = new ClausewitzReader(buf, 0, buf.length);
  let order = 0;
  for (;;) {
    const member = reader.nextMember();
    if (!member) break;
    if (member.key === null) {
      // Leading `EU4txt` marker token; nothing to record.
      continue;
    }
    out.push({
      key: member.key,
      kind: member.kind,
      start: member.valueStart,
      end: member.valueEnd,
      size: member.valueEnd - member.valueStart,
      order: order++,
    });
  }
  return out;
}

/** Read a block whose members are all bare scalars, as raw text. */
function readBareList(reader: ClausewitzReader, member: import('./clausewitz.ts').Member): string[] {
  const inner = reader.enter(member);
  const out: string[] = [];
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.kind === 'string') out.push(inner.stringValue(item));
    else if (item.kind === 'scalar') out.push(inner.rawValue(item));
  }
  return out;
}

/**
 * Map a `gamestate/provinces` key to a province id.
 *
 * EU4 1.37 writes these keys *negated*: key `-1` holds province 1 (Stockholm),
 * `-4941` holds province 4941. Older saves used positive keys, so the magnitude
 * is the id in both cases.
 */
export function provinceIdFromKey(key: string): number | undefined {
  const raw = Number(key);
  if (!Number.isInteger(raw)) return undefined;
  return Math.abs(raw);
}

const PROVINCE_FIELDS: Readonly<Record<string, keyof ProvinceRecord>> = {
  name: 'name',
  owner: 'owner',
  controller: 'controller',
  previous_controller: 'previousController',
  territorial_core: 'territorialCore',
  capital: 'capital',
  culture: 'culture',
  original_culture: 'originalCulture',
  native_culture: 'nativeCulture',
  religion: 'religion',
  original_religion: 'originalReligion',
  trade: 'trade',
  trade_goods: 'tradeGoods',
  likely_rebels: 'likelyRebels',
};

const PROVINCE_NUMBERS: Readonly<Record<string, keyof ProvinceRecord>> = {
  base_tax: 'baseTax',
  base_production: 'baseProduction',
  base_manpower: 'baseManpower',
  garrison: 'garrison',
};

function extractProvince(
  reader: ClausewitzReader,
  member: import('./clausewitz.ts').Member,
  id: number,
): ProvinceRecord {
  const record: ProvinceRecord = {
    id,
    cores: [],
    claims: [],
    institutions: [],
    buildings: [],
    buildingBuilders: {},
    greatProjects: [],
    latentTradeGoods: [],
    countryImprove: [],
    extra: {},
  };
  const inner = reader.enter(member);
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    if (item.kind === 'block') {
      // Every one of these used to be dropped on the floor: only `cores` and
      // `institutions` were read, so the detail panels had no buildings, no great
      // projects and no claims to show.
      if (item.key === 'cores') {
        record.cores = readBareList(inner, item);
      } else if (item.key === 'claims') {
        record.claims = readBareList(inner, item);
      } else if (item.key === 'institutions') {
        record.institutions = readBareList(inner, item)
          .map((raw) => toNumber(raw))
          .filter((n): n is number => n !== undefined);
      } else if (item.key === 'buildings') {
        record.buildings = readFlagKeys(inner, item);
      } else if (item.key === 'building_builders') {
        record.buildingBuilders = readKeyValues(inner, item);
      } else if (item.key === 'great_projects') {
        record.greatProjects = readBareList(inner, item);
      } else if (item.key === 'latent_trade_goods') {
        record.latentTradeGoods = readBareList(inner, item);
      } else if (item.key === 'country_improve_count') {
        record.countryImprove = readImproveCounts(inner, item);
      }
      continue;
    }
    const value =
      item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item);
    if (item.key === 'is_city') {
      record.isCity = toBoolean(value);
      continue;
    }
    // Two scalars the detail panels show are first-class fields now, not leftovers.
    if (item.key === 'devastation') {
      record.devastation = toNumber(value);
      continue;
    }
    if (item.key === 'active_trade_company') {
      record.activeTradeCompany = toBoolean(value);
      continue;
    }
    const textField = PROVINCE_FIELDS[item.key];
    if (textField) {
      (record as unknown as Record<string, unknown>)[textField] = value;
      continue;
    }
    const numericField = PROVINCE_NUMBERS[item.key];
    if (numericField) {
      (record as unknown as Record<string, unknown>)[numericField] = toNumber(value);
      continue;
    }
    record.extra[item.key] = value;
  }
  return record;
}

/** Keys of a `{ key=yes … }` block whose value is `yes`, in file order. */
function readFlagKeys(
  reader: ClausewitzReader,
  member: import('./clausewitz.ts').Member,
): string[] {
  const inner = reader.enter(member);
  const out: string[] = [];
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    const value = item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item);
    if (toBoolean(value)) out.push(item.key);
  }
  return out;
}

/**
 * A `{ key=value … }` block as a plain map.
 *
 * `building_builders` is the only user so far: `{ marketplace=SWE workshop=RUS }`,
 * i.e. which country paid for each building.
 */
function readKeyValues(
  reader: ClausewitzReader,
  member: import('./clausewitz.ts').Member,
): Record<string, string> {
  const inner = reader.enter(member);
  const out: Record<string, string> = {};
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    const value = item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item);
    if (value) out[item.key] = value;
  }
  return out;
}

/**
 * `country_improve_count`: a **repeating sequence** of `tag=`/`val=` pairs, e.g.
 * `{ tag="SWE" val=5 tag="RUS" val=2 }`, so a province can list several investors.
 * A nested `{ tag=… val=… }` form is tolerated too.
 */
function readImproveCounts(
  reader: ClausewitzReader,
  member: import('./clausewitz.ts').Member,
): Array<{ tag: string; count: number }> {
  const inner = reader.enter(member);
  const out: Array<{ tag: string; count: number }> = [];
  let tag: string | undefined;
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null && item.kind !== 'block') continue;
    if (item.kind === 'block') {
      const nested = inner.enter(item);
      let nestedTag: string | undefined;
      let nestedCount = 0;
      for (;;) {
        const x = nested.nextMember();
        if (!x) break;
        if (x.key === null) continue;
        const value = x.kind === 'string' ? nested.stringValue(x) : nested.rawValue(x);
        if (x.key === 'tag') nestedTag = value;
        else if (x.key === 'val') nestedCount = toNumber(value) ?? 0;
      }
      if (nestedTag !== undefined) out.push({ tag: nestedTag, count: nestedCount });
      continue;
    }
    if (item.key === null) continue;
    const value = item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item);
    if (item.key === 'tag') tag = value;
    else if (item.key === 'val') {
      out.push({ tag: tag ?? '', count: toNumber(value) ?? 0 });
      tag = undefined;
    }
  }
  return out;
}

/** Add `value` under `key`, widening to an array when the key repeats. */
function pushInto<T>(
  target: Record<string, T | T[]>,
  key: string,
  value: T,
): void {
  const existing = target[key];
  if (existing === undefined) {
    target[key] = value;
  } else if (Array.isArray(existing)) {
    (existing as T[]).push(value);
  } else {
    target[key] = [existing as T, value];
  }
}

/** Read a country scalar, taking the first value if the key repeated. */
export function countryScalar(country: CountryRecord, key: string): string | undefined {
  const value = country.scalars[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Read every occurrence of a country scalar. */
export function countryScalarList(country: CountryRecord, key: string): string[] {
  const value = country.scalars[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

/** Read a flattened country sub-block, taking the first if it repeated. */
export function countryGroup(
  country: CountryRecord,
  key: string,
): Record<string, string> | undefined {
  const value = country.groups[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function extractCountry(
  reader: ClausewitzReader,
  member: import('./clausewitz.ts').Member,
  tag: string,
  maxGroupBytes: number,
): CountryRecord {
  const scalars: Record<string, string | string[]> = {};
  const lists: Record<string, string[]> = {};
  const groups: Record<string, Record<string, string> | Array<Record<string, string>>> = {};
  const blocks: Record<string, BlockSummary | BlockSummary[]> = {};

  const inner = reader.enter(member);
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    if (item.kind !== 'block') {
      pushInto(
        scalars,
        item.key,
        item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item),
      );
      continue;
    }
    const bytes = item.valueEnd - item.valueStart;
    if (bytes <= maxGroupBytes) {
      const asList = tryReadBareScalarList(inner, item);
      if (asList) {
        lists[item.key] = asList;
        continue;
      }
      const flattened = tryFlatten(inner, item);
      if (flattened) {
        pushInto(groups, item.key, flattened);
        continue;
      }
    }
    pushInto(blocks, item.key, summariseBlock(inner, item));
  }

  return { tag, scalars, lists, groups, blocks };
}

/**
 * Read a block whose members are all unkeyed scalars, e.g. `institutions={ 0 0 0 }`.
 * Returns `undefined` when the block is keyed or nested, so the caller can try
 * another shape.
 */
function tryReadBareScalarList(
  reader: ClausewitzReader,
  member: import('./clausewitz.ts').Member,
): string[] | undefined {
  const inner = reader.enter(member);
  const out: string[] = [];
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key !== null || item.kind === 'block') return undefined;
    out.push(item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item));
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Flatten a block whose members are all scalars, strings, or bare scalar lists.
 *
 * The list case matters: `colors={ color={ 128 34 64 } map_color={ … } }` has
 * members whose values are list blocks, and those are joined with spaces so the
 * caller can read `map_color` as `"128 34 64"`. Returns `undefined` as soon as a
 * member is neither, so genuinely nested data is left for `blocks`.
 */
function tryFlatten(
  reader: ClausewitzReader,
  member: import('./clausewitz.ts').Member,
): Record<string, string> | undefined {
  const inner = reader.enter(member);
  const out: Record<string, string> = {};
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) return undefined;
    if (item.kind === 'string') {
      out[item.key] = inner.stringValue(item);
      continue;
    }
    if (item.kind === 'scalar') {
      out[item.key] = inner.rawValue(item);
      continue;
    }
    const list = tryReadBareScalarList(inner, item);
    if (list === undefined) return undefined;
    out[item.key] = list.join(' ');
  }
  return out;
}

function summariseBlock(
  reader: ClausewitzReader,
  member: import('./clausewitz.ts').Member,
): BlockSummary {
  const inner = reader.enter(member);
  const keys: string[] = [];
  let members = 0;
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    members += 1;
    if (item.key !== null && keys.length < 64 && !keys.includes(item.key)) {
      keys.push(item.key);
    }
  }
  return { members, bytes: member.valueEnd - member.valueStart, keys };
}

function scalarOf(node: CwNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'scalar' || node.type === 'string') return node.value;
  return undefined;
}

function plainSection(node: CwNode): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return plainify(node);
}

function plainify(node: CwNode): unknown {
  switch (node.type) {
    case 'scalar': {
      const n = toNumber(node.value);
      if (node.value === 'yes') return true;
      if (node.value === 'no') return false;
      return n ?? node.value;
    }
    case 'string':
      return node.value;
    case 'list':
      return node.items.map(plainify);
    case 'block': {
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) {
        const value = plainify(entry.value);
        const existing = out[entry.key];
        if (existing === undefined) out[entry.key] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else out[entry.key] = [existing, value];
      }
      return out;
    }
  }
}

/**
 * Parse the `meta` member into typed data.
 *
 * `meta` is not wrapped in braces — it is a flat run of members that begins with
 * the literal token `EU4txt`, e.g.
 *
 *   EU4txt
 *   date=1574.11.12
 *   savegame_version={ first=1 second=37 ... }
 */
export function parseMeta(bytes: Uint8Array, warnings: string[] = []): SaveMeta {
  const reader = new ClausewitzReader(bytes, 0, bytes.length);
  const entries: CwEntry[] = [];
  for (;;) {
    const member = reader.nextMember();
    if (!member) break;
    if (member.key === null) continue; // the leading `EU4txt` token
    entries.push({ key: member.key, value: readNode(reader, member) });
  }
  const view = new BlockView({ type: 'block', entries });

  const versionView = view.block('savegame_version');
  const version: SaveVersion = {
    first: versionView?.number('first') ?? 0,
    second: versionView?.number('second') ?? 0,
    third: versionView?.number('third') ?? 0,
    forth: versionView?.number('forth') ?? 0,
    name: versionView?.string('name'),
    text: '',
  };
  version.text = [
    version.first,
    version.second,
    version.third,
    version.forth,
  ].join('.');

  const mods: ModInfo[] = [];
  const modsNode = view.first('mods_enabled_names');
  if (modsNode && modsNode.type === 'list') {
    for (const item of modsNode.items) {
      const entry = BlockView.from(item);
      if (!entry) continue;
      const filename = entry.string('filename');
      if (filename === undefined) continue;
      mods.push({ filename, name: entry.string('name') ?? filename });
    }
  } else if (modsNode?.type === 'block') {
    // `mods_enabled_names` is a bare list, but tolerate a keyed spelling.
    const entry = BlockView.from(modsNode);
    const filename = entry?.string('filename');
    if (filename !== undefined) mods.push({ filename, name: entry?.string('name') ?? filename });
  }

  const campaignStats: CampaignStat[] = [];
  const statsNode = view.first('campaign_stats');
  const statsItems = statsNode?.type === 'list' ? statsNode.items : [];
  for (const item of statsItems) {
    const entry = BlockView.from(item);
    if (!entry) continue;
    campaignStats.push({
      id: entry.number('id'),
      comparison: entry.number('comparison'),
      key: entry.string('key'),
      selector: entry.string('selector'),
      localization: entry.string('localization'),
      value: entry.number('value'),
      sampleValue: entry.number('sample_value'),
      sampleCount: entry.number('sample_count'),
    });
  }

  return {
    date: view.scalar('date') ?? '',
    saveGame: view.string('save_game'),
    player: view.string('player'),
    displayedCountryName: view.string('displayed_country_name'),
    version,
    versions: view.stringList('savegame_versions'),
    dlc: view.stringList('dlc_enabled'),
    mods,
    multiPlayer: view.bool('multi_player') ?? false,
    notObserver: view.bool('not_observer') ?? false,
    campaignId: view.string('campaign_id'),
    campaignLength: view.number('campaign_length'),
    checksum: view.string('checksum'),
    campaignStats,
  };
}

export { parseGameDate, decodeEu4String };
