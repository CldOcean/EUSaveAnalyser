/**
 * Province history replay — the basis for a map timeline.
 *
 * A single save is **not** limited to the present state. Every province carries a
 * `history` block that is a dated event log from the campaign's start date to the
 * current date, e.g. Stockholm in the sample save:
 *
 *   history={
 *       owner="SWE"                 # undated keys = state when the campaign began
 *       controller={ tag="SWE" }
 *       religion="catholic"
 *       base_tax="5.000"
 *       1436.4.28={ revolt={ … } controller={ tag="REB" } }
 *       1523.3.30={ controller={ tag="MOS" } }
 *       1523.3.30={ controller={ tag="RUS" } }
 *       1525.6.4={ owner="MOS" fake_owner="RUS" add_core="RUS" }
 *       1532.5.22={ religion="protestant" }
 *   }
 *
 * In the sample save 3,924 provinces carry such a log with 147,337 dated entries
 * between them, covering `owner`, `controller` (wartime occupation), `religion`,
 * `culture`, `base_tax`/`base_production`/`base_manpower`, buildings, cores and
 * claims. Replaying it yields the whole territorial timeline from one file.
 *
 * Replay is a forward sweep, not a per-frame re-scan: `TimelinePlayer` keeps a
 * cursor into the globally date-sorted event list and applies each event once, so
 * producing 100 map frames costs the same as producing one.
 */

import { ClausewitzReader, type Member } from './clausewitz.ts';
import { parseGameDate, type GameDate } from './value.ts';
import type { SaveDocument } from './document.ts';

const DATE_KEY = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/;

/** One field change: `owner=MOS`, `controller={tag=REB …}`. */
export interface ProvinceChange {
  field: string;
  /** The primary value: for `controller={tag=REB}` this is `REB`. */
  value: string;
  /** Extra fields from a structured value, e.g. `{ tag=REB rebel=… }`. */
  detail?: Record<string, string>;
}

export interface ProvinceHistoryEvent {
  /** The date exactly as written, e.g. `1525.6.4`. */
  date: string;
  /** Comparable day counter for the date. */
  ordinal: number;
  provinceId: number;
  changes: ProvinceChange[];
}

export interface ProvinceHistory {
  id: number;
  /** Undated keys at the head of the block: the state at campaign start. */
  initial: ProvinceChange[];
  events: ProvinceHistoryEvent[];
}

export interface GameTimeline {
  provinces: Map<number, ProvinceHistory>;
  /** Every province event, sorted ascending by date (input order kept on ties). */
  events: ProvinceHistoryEvent[];
  /** Earliest and latest dates seen, as written. */
  startDate: string;
  endDate: string;
  /** Distinct field names across all histories, most frequent first. */
  fields: string[];
  /** The date at which the campaign starts (`1444.11.11` in the sample). */
  campaignStart?: string;
}

export interface TimelineStats {
  provincesWithHistory: number;
  eventCount: number;
  changeCount: number;
  startDate: string;
  endDate: string;
}

/**
 * Read the history of the province whose block starts at `member`.
 * `reader` must be positioned inside the `provinces` block.
 */
function readProvinceHistory(
  reader: ClausewitzReader,
  member: Member,
  provinceId: number,
): ProvinceHistory {
  const history: ProvinceHistory = { id: provinceId, initial: [], events: [] };
  const province = reader.enter(member);
  for (;;) {
    const item = province.nextMember();
    if (!item) break;
    if (item.key !== 'history' || item.kind !== 'block') continue;

    const block = province.enter(item);
    for (;;) {
      const entry = block.nextMember();
      if (!entry) break;
      if (entry.key === null) continue;
      const match = DATE_KEY.exec(entry.key);
      if (!match) {
        // Undated key -> part of the initial state.
        const change = readChange(block, entry);
        if (change) history.initial.push(change);
        continue;
      }
      const date = entry.key;
      const ordinal =
        Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]);
      const changes: ProvinceChange[] = [];
      if (entry.kind === 'block') {
        const body = block.enter(entry);
        for (;;) {
          const field = body.nextMember();
          if (!field) break;
          const change = readChange(body, field);
          if (change) changes.push(change);
        }
      }
      history.events.push({ date, ordinal, provinceId, changes });
    }
  }
  return history;
}

/** Turn one member into a change, flattening structured values to their `tag`. */
function readChange(reader: ClausewitzReader, member: Member): ProvinceChange | undefined {
  const field = member.key;
  if (field === null) return undefined;

  if (member.kind === 'scalar') {
    return { field, value: reader.rawValue(member) };
  }
  if (member.kind === 'string') {
    return { field, value: reader.stringValue(member) };
  }

  const detail: Record<string, string> = {};
  const inner = reader.enter(member);
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    detail[item.key] =
      item.kind === 'string'
        ? inner.stringValue(item)
        : item.kind === 'scalar'
          ? inner.rawValue(item)
          : '';
  }
  // `controller={ tag=REB rebel=… }` — the tag is the value callers care about.
  const value = detail['tag'] ?? detail['type'] ?? Object.values(detail)[0] ?? '';
  return { field, value, detail };
}

/** Build the replayed timeline for a save. */
export function buildTimeline(doc: SaveDocument): GameTimeline {
  const provinces = new Map<number, ProvinceHistory>();
  const allEvents: ProvinceHistoryEvent[] = [];
  const fieldCounts = new Map<string, number>();

  const ref = doc.section('provinces');
  const reader = ref
    ? new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1)
    : undefined;

  if (reader) {
    for (;;) {
      const member = reader.nextMember();
      if (!member) break;
      if (member.kind !== 'block' || member.key === null) continue;
      const raw = Number(member.key);
      if (!Number.isInteger(raw)) continue;
      const id = Math.abs(raw);
      const history = readProvinceHistory(reader, member, id);
      if (history.initial.length === 0 && history.events.length === 0) continue;
      provinces.set(id, history);
      for (const event of history.events) {
        allEvents.push(event);
        for (const change of event.changes) {
          fieldCounts.set(change.field, (fieldCounts.get(change.field) ?? 0) + 1);
        }
      }
    }
  }

  // Stable sort keeps same-date entries in the order the game wrote them, which
  // matters: `1523.3.30 controller=MOS` then `controller=RUS` must stay ordered.
  allEvents.sort((a, b) => a.ordinal - b.ordinal);

  const fields = [...fieldCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([field]) => field);

  const campaignStart = doc.section('start_date')
    ? scalarOfSection(doc, 'start_date')
    : undefined;

  return {
    provinces,
    events: allEvents,
    startDate:
      campaignStart ??
      (allEvents[0]?.date ?? ''),
    endDate: allEvents[allEvents.length - 1]?.date ?? '',
    fields,
    campaignStart,
  };
}

function scalarOfSection(doc: SaveDocument, key: string): string | undefined {
  const node = doc.readSection(key);
  if (!node) return undefined;
  if (node.type === 'scalar' || node.type === 'string') return node.value;
  return undefined;
}

export function timelineStats(timeline: GameTimeline): TimelineStats {
  let changes = 0;
  for (const event of timeline.events) changes += event.changes.length;
  return {
    provincesWithHistory: timeline.provinces.size,
    eventCount: timeline.events.length,
    changeCount: changes,
    startDate: timeline.startDate,
    endDate: timeline.endDate,
  };
}

/**
 * Forward-only replay cursor.
 *
 * ```ts
 * const player = new TimelinePlayer(timeline, ['owner', 'religion', 'culture']);
 * for (const frame of frameDates) {
 *   player.advanceTo(frame.ordinal);
 *   player.valueOf('owner', 1); // -> current owner of province 1
 * }
 * ```
 */
export class TimelinePlayer {
  readonly #timeline: GameTimeline;
  readonly #fields: readonly string[];
  /** field -> province id -> current value. */
  readonly #state = new Map<string, string[]>();
  #cursor = 0;

  constructor(timeline: GameTimeline, fields: readonly string[]) {
    this.#timeline = timeline;
    this.#fields = fields;
    for (const field of fields) this.#state.set(field, []);
    this.reset();
  }

  /** The date the cursor currently sits on (the last applied event, if any). */
  get lastAppliedDate(): string | undefined {
    return this.#timeline.events[this.#cursor - 1]?.date;
  }

  get appliedEvents(): number {
    return this.#cursor;
  }

  /** Rewind to the campaign's starting state. */
  reset(): void {
    this.#cursor = 0;
    for (const field of this.#fields) {
      const column = this.#state.get(field) as string[];
      column.length = 0;
    }
    for (const history of this.#timeline.provinces.values()) {
      for (const change of history.initial) {
        if (!this.#fields.includes(change.field)) continue;
        (this.#state.get(change.field) as string[])[history.id] = change.value;
      }
    }
  }

  /** Apply every event up to and including `ordinal`. */
  advanceTo(ordinal: number): void {
    const events = this.#timeline.events;
    while (this.#cursor < events.length) {
      const event = events[this.#cursor] as ProvinceHistoryEvent;
      if (event.ordinal > ordinal) break;
      this.apply(event);
      this.#cursor += 1;
    }
  }

  apply(event: ProvinceHistoryEvent): void {
    for (const change of event.changes) {
      const column = this.#state.get(change.field);
      if (column) column[event.provinceId] = change.value;
    }
  }

  valueOf(field: string, provinceId: number): string | undefined {
    return this.#state.get(field)?.[provinceId];
  }

  /** Full tracked state of one province: initial values plus every event ≤ date. */
  stateOf(provinceId: number, ordinal: number): Record<string, string> {
    const history = this.#timeline.provinces.get(provinceId);
    const out: Record<string, string> = {};
    if (!history) return out;
    for (const change of history.initial) {
      if (this.#fields.includes(change.field)) out[change.field] = change.value;
    }
    for (const event of history.events) {
      if (event.ordinal > ordinal) break;
      for (const change of event.changes) {
        if (this.#fields.includes(change.field)) out[change.field] = change.value;
      }
    }
    return out;
  }

  /** Every event that touched one province, optionally within a date range. */
  eventsFor(provinceId: number): readonly ProvinceHistoryEvent[] {
    return this.#timeline.provinces.get(provinceId)?.events ?? [];
  }
}

/** Every province that ever had a given value for a field, in the whole timeline. */
export function provincesEverMatching(
  timeline: GameTimeline,
  field: string,
  value: string,
): number[] {
  const out: number[] = [];
  for (const history of timeline.provinces.values()) {
    for (const change of history.initial) {
      if (change.field === field && change.value === value) {
        out.push(history.id);
        break;
      }
    }
    for (const event of history.events) {
      if (event.changes.some((c) => c.field === field && c.value === value)) {
        out.push(history.id);
        break;
      }
    }
  }
  return out;
}

/** Build a list of evenly spaced frame dates between two dates (inclusive). */
export function frameDates(
  from: string,
  to: string,
  stepYears: number,
): Array<{ date: string; ordinal: number; gameDate: GameDate }> {
  const start = parseGameDate(from);
  const end = parseGameDate(to);
  const out: Array<{ date: string; ordinal: number; gameDate: GameDate }> = [];
  if (!start || !end) return out;
  for (let year = start.year; year <= end.year; year += stepYears) {
    const month = year === start.year ? start.month : 1;
    const day = year === start.year ? start.day : 1;
    const ordinal = year * 372 + month * 31 + day;
    out.push({
      date: `${year}.${month}.${day}`,
      ordinal,
      gameDate: { year, month, day, ordinal },
    });
  }
  const endOrdinal = end.year * 372 + end.month * 31 + end.day;
  const last = out[out.length - 1];
  if (last && last.ordinal < endOrdinal) {
    out.push({ date: end.year + '.' + end.month + '.' + end.day, ordinal: endOrdinal, gameDate: end });
  }
  return out;
}

// --------------------------------------------------------------- tag changes --

/**
 * A country renaming itself, e.g. Muscovy -> Russia.
 *
 * Province histories record the tag that held the province *at the time*, so
 * Stockholm's log says `owner=MOS` from 1525 and never mentions RUS. The game
 * writes the switch into the successor's own country history instead:
 *
 *   countries/RUS/history = { 1529.2.5 = { changed_tag_from="MOS" … } }
 *
 * Without following that alias a replayed map shows Muscovy holding 380
 * provinces in 1574.
 */
export interface TagAlias {
  date: string;
  ordinal: number;
  /** The tag that ceased to exist. */
  from: string;
  /** The tag that continues it. */
  to: string;
}

/** Scan every country's history for `changed_tag_from` entries. */
export function buildTagAliases(doc: SaveDocument): TagAlias[] {
  const aliases: TagAlias[] = [];
  const ref = doc.section('countries');
  if (!ref) return aliases;
  const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);

  for (;;) {
    const country = reader.nextMember();
    if (!country) break;
    if (country.kind !== 'block' || country.key === null) continue;
    const tag = country.key;
    const body = reader.enter(country);
    for (;;) {
      const item = body.nextMember();
      if (!item) break;
      if (item.key !== 'history' || item.kind !== 'block') continue;
      const history = body.enter(item);
      for (;;) {
        const entry = history.nextMember();
        if (!entry) break;
        if (entry.key === null || entry.kind !== 'block') continue;
        const match = DATE_KEY.exec(entry.key);
        if (!match) continue;
        const event = history.enter(entry);
        for (;;) {
          const field = event.nextMember();
          if (!field) break;
          if (field.key !== 'changed_tag_from') continue;
          const from =
            field.kind === 'string' ? event.stringValue(field) : event.rawValue(field);
          if (!from) continue;
          aliases.push({
            date: entry.key,
            ordinal:
              Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]),
            from,
            to: tag,
          });
        }
      }
    }
  }

  aliases.sort((a, b) => a.ordinal - b.ordinal);
  return aliases;
}

/** Follow tag changes that had already happened by `ordinal`. */
export function resolveTag(
  aliases: readonly TagAlias[],
  tag: string,
  ordinal: number,
): string {
  let current = tag;
  // A handful of renames per campaign at most; the guard only stops bad data.
  for (let guard = 0; guard < 32; guard += 1) {
    const alias = aliases.find((a) => a.from === current && a.ordinal <= ordinal);
    if (!alias) return current;
    current = alias.to;
  }
  return current;
}

/** Map every tag that appears in a state array to its resolved successor. */
export function resolveTagSet(
  aliases: readonly TagAlias[],
  tags: Iterable<string>,
  ordinal: number,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of tags) {
    if (!out.has(tag)) out.set(tag, resolveTag(aliases, tag, ordinal));
  }
  return out;
}

/**
 * Follow tag changes ignoring *when* they happened.
 *
 * Country attributes (state religion, primary culture, …) are carried over to the
 * successor: Muscovy's whole history ends up stored under RUS. So when a province
 * was owned by MOS in 1500, its owner's religion must be looked up on RUS.
 */
export function resolveTagLatest(aliases: readonly TagAlias[], tag: string): string {
  let current = tag;
  for (let guard = 0; guard < 32; guard += 1) {
    const alias = aliases.find((a) => a.from === current);
    if (!alias) return current;
    current = alias.to;
  }
  return current;
}

// ------------------------------------------------- country-level timelines ----

export interface CountryHistoryEvent {
  date: string;
  ordinal: number;
  tag: string;
  changes: ProvinceChange[];
}

export interface CountryHistory {
  tag: string;
  /** Undated keys at the head of the block: the state when the campaign began. */
  initial: ProvinceChange[];
  events: CountryHistoryEvent[];
}

export interface CountryTimeline {
  countries: Map<string, CountryHistory>;
  /** Every country event, sorted ascending by date. */
  events: CountryHistoryEvent[];
  fields: string[];
}

/**
 * Read the dated history of every country.
 *
 * Same shape as the province log (`countries/{TAG}/history`), which is where a
 * country's own `religion`, `primary_culture`, `capital` and government changes
 * are recorded. The religion view needs this: a province's fill is its own
 * religion, and the hatching is the *owner's* state religion at that date.
 */
export function buildCountryTimeline(doc: SaveDocument): CountryTimeline {
  const countries = new Map<string, CountryHistory>();
  const allEvents: CountryHistoryEvent[] = [];
  const fieldCounts = new Map<string, number>();

  const ref = doc.section('countries');
  const reader = ref
    ? new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1)
    : undefined;

  if (reader) {
    for (;;) {
      const member = reader.nextMember();
      if (!member) break;
      if (member.kind !== 'block' || member.key === null) continue;
      const tag = member.key;
      const history: CountryHistory = { tag, initial: [], events: [] };
      const body = reader.enter(member);
      for (;;) {
        const item = body.nextMember();
        if (!item) break;
        if (item.key !== 'history' || item.kind !== 'block') continue;
        const block = body.enter(item);
        for (;;) {
          const entry = block.nextMember();
          if (!entry) break;
          if (entry.key === null) continue;
          const match = DATE_KEY.exec(entry.key);
          if (!match) {
            const change = readChange(block, entry);
            if (change) history.initial.push(change);
            continue;
          }
          const changes: ProvinceChange[] = [];
          if (entry.kind === 'block') {
            const eventBody = block.enter(entry);
            for (;;) {
              const field = eventBody.nextMember();
              if (!field) break;
              const change = readChange(eventBody, field);
              if (change) changes.push(change);
            }
          }
          history.events.push({
            date: entry.key,
            ordinal:
              Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]),
            tag,
            changes,
          });
        }
      }
      if (history.initial.length === 0 && history.events.length === 0) continue;
      countries.set(tag, history);
      for (const event of history.events) {
        allEvents.push(event);
        for (const change of event.changes) {
          fieldCounts.set(change.field, (fieldCounts.get(change.field) ?? 0) + 1);
        }
      }
    }
  }

  allEvents.sort((a, b) => a.ordinal - b.ordinal);
  return {
    countries,
    events: allEvents,
    fields: [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f),
  };
}

/** Forward-only replay cursor for country-level attributes, keyed by tag. */
export class CountryTimelinePlayer {
  readonly #timeline: CountryTimeline;
  readonly #fields: readonly string[];
  readonly #state = new Map<string, Map<string, string>>();
  #cursor = 0;

  constructor(timeline: CountryTimeline, fields: readonly string[]) {
    this.#timeline = timeline;
    this.#fields = fields;
    for (const field of fields) this.#state.set(field, new Map());
    this.reset();
  }

  reset(): void {
    this.#cursor = 0;
    for (const field of this.#fields) (this.#state.get(field) as Map<string, string>).clear();
    for (const history of this.#timeline.countries.values()) {
      for (const change of history.initial) {
        if (!this.#fields.includes(change.field)) continue;
        (this.#state.get(change.field) as Map<string, string>).set(history.tag, change.value);
      }
    }
  }

  advanceTo(ordinal: number): void {
    const events = this.#timeline.events;
    while (this.#cursor < events.length) {
      const event = events[this.#cursor] as CountryHistoryEvent;
      if (event.ordinal > ordinal) break;
      for (const change of event.changes) {
        const column = this.#state.get(change.field);
        if (column) column.set(event.tag, change.value);
      }
      this.#cursor += 1;
    }
  }

  valueOf(field: string, tag: string): string | undefined {
    return this.#state.get(field)?.get(tag);
  }

  /** All dated entries for one country, in order. */
  eventsFor(tag: string): readonly CountryHistoryEvent[] {
    return this.#timeline.countries.get(tag)?.events ?? [];
  }
}

/**
 * Frame dates stepping one **month** at a time — the finest granularity a save
 * actually records, and what the map player scrubs through.
 *
 * The first frame is the campaign's exact start date; every later frame is the
 * 1st of a month so labels stay readable.
 */
export function frameMonths(
  from: string,
  to: string,
): Array<{ date: string; ordinal: number; year: number; month: number }> {
  const start = parseGameDate(from);
  const end = parseGameDate(to);
  if (!start || !end) return [];
  const endOrdinal = end.year * 372 + end.month * 31 + end.day;
  const out = [
    { date: from, ordinal: start.ordinal, year: start.year, month: start.month },
  ];
  let year = start.year;
  let month = start.month;
  for (;;) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    const ordinal = year * 372 + month * 31 + 1;
    if (ordinal > endOrdinal) break;
    out.push({ date: `${year}.${month}.1`, ordinal, year, month });
  }
  // Land exactly on the save's date: the last day of the month can still carry
  // events (EU4 stamps the current state), and the final frame must show the
  // present, not the 1st of the month.
  const last = out[out.length - 1];
  if (last && last.ordinal < endOrdinal) {
    out.push({ date: to, ordinal: endOrdinal, year: end.year, month: end.month });
  }
  return out;
}

/** Decode an ordinal produced by the helpers above back into `Y.M.D`. */
export function ordinalToDate(ordinal: number): string {
  const year = Math.floor(ordinal / 372);
  const rest = ordinal - year * 372;
  const month = Math.floor(rest / 31);
  const day = rest - month * 31;
  return `${year}.${month}.${day}`;
}
