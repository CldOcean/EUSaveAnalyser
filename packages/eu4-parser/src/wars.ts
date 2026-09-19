/**
 * War, battle and occupation history.
 *
 * Every war the campaign has ever seen is stored in `previous_war` (621 of them in
 * the sample save) and ongoing ones in `active_war`. Each carries a **dated**
 * `history` block that records, in order:
 *
 *   `add_attacker` / `add_defender` / `rem_attacker` / `rem_defender`  who joined or left
 *   `battle`                                                          a land or naval battle
 *   `take_province` / `take_capital`                                  peace-deal terms
 *
 * and a `battle` entry is itself a full report:
 *
 *   '1453.4.13': {
 *       battle: {
 *           name: '苏腊巴亚'
 *           location: '628'
 *           result: 'no'                       # 'yes' -> the attacker won
 *           attacker: { cavalry: 1964, infantry: 6871, losses: 3718, country: SUN, commander: '…' }
 *           defender: { cavalry: 3000, infantry: 9000, losses: 1519, country: MAJ, commander: '…' }
 *           winner_alliance: 16.000
 *           loser_alliance: 21.000
 *       }
 *   }
 *
 * Combined with a province's `controller` changes in its own history, this gives
 * "who fought whom, when, where, and who was occupying what".
 */

import { ClausewitzReader } from './clausewitz.ts';
import { readNode, toBoolean, toNumber, type CwNode } from './value.ts';
import type { SaveDocument } from './document.ts';

const DATE_KEY = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/;

/** Non-`take_*` keys that are also peace terms. */
const PEACE_KEYS = new Set([
  'annul_treaties',
  'war_reparations',
  'independence',
  'transfer_trade_power',
  'guarantee',
  'dependency',
  'royal_marriage',
  'alliance',
  'military_access',
  'improve_relation',
  'knowledge_sharing',
  'trade_company',
  'change_religion',
  'release_country',
  'vassalize',
]);

export interface BattleSide {
  country?: string;
  commander?: string;
  losses?: number;
  /** Unit type -> count, e.g. `{ infantry: 6871, cavalry: 1964 }`. */
  units: Record<string, number>;
}

export interface Battle {
  date: string;
  name: string;
  /** Province id where the battle happened. */
  location?: number;
  /** `true` when the attacker won (`result=yes`). */
  attackerWon: boolean;
  naval: boolean;
  attacker: BattleSide;
  defender: BattleSide;
  /** Warscore swing, as stored. */
  winnerAlliance?: number;
  loserAlliance?: number;
}

export type WarEventKind =
  | 'add_attacker'
  | 'add_defender'
  | 'rem_attacker'
  | 'rem_defender'
  | 'battle'
  | 'peace_term'
  | 'other';

export interface WarEvent {
  date: string;
  kind: WarEventKind;
  /** Tags involved (for join/leave events). */
  tags: string[];
  /** Human-readable detail for peace terms, e.g. `take_claim province 626`. */
  detail?: string;
}

export interface WarParticipant {
  tag: string;
  warScore?: number;
  /** Per-category loss counters, as stored. */
  losses?: number[];
  value?: number;
}

export interface War {
  name: string;
  ongoing: boolean;
  originalAttacker?: string;
  originalDefender?: string;
  attackers: string[];
  defenders: string[];
  /** First and last dated entries in the war's history. */
  startDate?: string;
  endDate?: string;
  durationDays?: number;
  warGoal?: { type?: string; casusBelli?: string; province?: number; tag?: string };
  battles: Battle[];
  events: WarEvent[];
  participants: WarParticipant[];
  /**
   * Terms recorded on the war block itself (`take_province`, `take_capital`,
   * `annul_treaties`, …). These are what actually moved on the map.
   */
  peaceTerms: PeaceTerm[];
  attackerScore?: number;
  defenderScore?: number;
  /**
   * Raw engine enum. Its meaning could **not** be established from the data:
   * 526 of 584 finished wars carry `outcome=2`, and 380 of those store no war
   * scores at all, so no consistent attacker/defender split is derivable. Treat
   * this as an opaque code and rely on `peaceTerms` instead.
   */
  outcome?: number;
  isCoalition: boolean;
}

export interface PeaceTerm {
  kind: string;
  province?: number;
  tag?: string;
}

function asString(node: CwNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'string' || node.type === 'scalar') return node.value;
  return undefined;
}

function asStrings(node: CwNode | undefined): string[] {
  if (!node) return [];
  if (node.type === 'string' || node.type === 'scalar') return [node.value];
  if (node.type === 'list') {
    return node.items.map((i) => asString(i) ?? '').filter((s) => s !== '');
  }
  return [];
}

function readEntry(reader: ClausewitzReader, member: import('./clausewitz.ts').Member): CwNode {
  return readNode(reader, member);
}

/** Collect the immediate members of a node as a key -> node map (repeats -> array). */
function entriesOf(node: CwNode | undefined): Map<string, CwNode[]> {
  const map = new Map<string, CwNode[]>();
  if (!node || node.type !== 'block') return map;
  for (const entry of node.entries) {
    const list = map.get(entry.key);
    if (list) list.push(entry.value);
    else map.set(entry.key, [entry.value]);
  }
  return map;
}

function parseBattle(date: string, node: CwNode): Battle | undefined {
  const map = entriesOf(node);
  const side = (key: string): BattleSide => {
    const inner = entriesOf(map.get(key)?.[0]);
    const units: Record<string, number> = {};
    for (const [unit, values] of inner) {
      if (unit === 'country' || unit === 'commander' || unit === 'losses') continue;
      const n = toNumber(asString(values[0]));
      if (n !== undefined) units[unit] = n;
    }
    const losses = toNumber(asString(inner.get('losses')?.[0]));
    return {
      country: asString(inner.get('country')?.[0]),
      commander: asString(inner.get('commander')?.[0]),
      ...(losses !== undefined ? { losses } : {}),
      units,
    };
  };
  const attacker = side('attacker');
  const defender = side('defender');
  const naval =
    Object.keys(attacker.units).some((u) => u.includes('ship') || u === 'galley' || u === 'transport') ||
    Object.keys(defender.units).some((u) => u.includes('ship') || u === 'galley' || u === 'transport');
  const location = toNumber(asString(map.get('location')?.[0]));
  const resultRaw = asString(map.get('result')?.[0]) ?? map.get('result')?.[0]?.type;
  return {
    date,
    name: asString(map.get('name')?.[0]) ?? '',
    ...(location !== undefined ? { location } : {}),
    attackerWon: resultRaw === 'yes' || resultRaw === true,
    naval,
    attacker,
    defender,
    winnerAlliance: toNumber(asString(map.get('winner_alliance')?.[0])),
    loserAlliance: toNumber(asString(map.get('loser_alliance')?.[0])),
  };
}

function parseWar(name: string, node: CwNode, ongoing: boolean): War {
  const map = entriesOf(node);
  const war: War = {
    name,
    ongoing,
    attackers: asStrings(map.get('attackers')?.[0]),
    defenders: asStrings(map.get('defenders')?.[0]),
    battles: [],
    events: [],
    participants: [],
    peaceTerms: [],
    isCoalition: toBoolean(asString(map.get('is_coalition')?.[0])) ?? false,
  };

  const original = (key: string): string | undefined => asString(map.get(key)?.[0]);
  war.originalAttacker = original('original_attacker');
  war.originalDefender = original('original_defender');
  if (war.attackers.length === 0) war.attackers = asStrings(map.get('persistent_attackers')?.[0]);
  if (war.defenders.length === 0) war.defenders = asStrings(map.get('persistent_defenders')?.[0]);

  const outcome = toNumber(asString(map.get('outcome')?.[0]));
  if (outcome !== undefined) war.outcome = outcome;
  war.attackerScore = toNumber(asString(map.get('attacker_score')?.[0]));
  war.defenderScore = toNumber(asString(map.get('defender_score')?.[0]));

  // Peace terms sit on the war block itself, repeated once per term.
  for (const [key, values] of map) {
    if (!key.startsWith('take_') && !PEACE_KEYS.has(key)) continue;
    for (const value of values) {
      if (value.type !== 'block') {
        war.peaceTerms.push({ kind: key, tag: asString(value) });
        continue;
      }
      const inner = entriesOf(value);
      const province = toNumber(asString(inner.get('province')?.[0]));
      war.peaceTerms.push({
        kind: key,
        ...(province !== undefined ? { province } : {}),
        tag: asString(inner.get('tag')?.[0]),
      });
    }
  }

  const goal = map.get('war_goal')?.[0] ?? map.get('superiority')?.[0];
  if (goal && goal.type === 'block') {
    const g = entriesOf(goal);
    const province = toNumber(asString(g.get('province')?.[0]));
    war.warGoal = {
      type: asString(g.get('type')?.[0]),
      casusBelli: asString(g.get('casus_belli')?.[0]),
      ...(province !== undefined ? { province } : {}),
      tag: asString(g.get('tag')?.[0]),
    };
  }

  // `history` is the dated log; it may also carry the war's own name/war_goal.
  const history = map.get('history')?.[0];
  if (history && history.type === 'block') {
    for (const entry of history.entries) {
      const match = DATE_KEY.exec(entry.key);
      if (!match) continue;
      war.startDate ??= entry.key;
      war.endDate = entry.key;

      const items = entry.value.type === 'list' ? entry.value.items : [entry.value];
      const changes = new Map<string, CwNode[]>();
      for (const item of items) {
        if (item.type !== 'block') continue;
        for (const [k, v] of entriesOf(item)) {
          const list = changes.get(k);
          if (list) list.push(...v);
          else changes.set(k, [...v]);
        }
      }

      for (const [key, values] of changes) {
        if (key === 'battle') {
          for (const value of values) {
            const battle = parseBattle(entry.key, value);
            if (battle) war.battles.push(battle);
          }
          war.events.push({ date: entry.key, kind: 'battle', tags: [] });
          continue;
        }
        if (
          key === 'add_attacker' ||
          key === 'add_defender' ||
          key === 'rem_attacker' ||
          key === 'rem_defender'
        ) {
          const tags = values.flatMap((v) => asStrings(v));
          war.events.push({ date: entry.key, kind: key, tags });
          continue;
        }
        if (key.startsWith('take_') || key === 'annul_treaties' || key === 'war_reparations') {
          const inner = entriesOf(values[0]);
          const province = asString(inner.get('province')?.[0]);
          const tag = asString(inner.get('tag')?.[0]);
          war.events.push({
            date: entry.key,
            kind: 'peace_term',
            tags: tag ? [tag] : [],
            detail: `${key}${province ? ` province ${province}` : ''}${tag ? ` tag ${tag}` : ''}`,
          });
        }
      }
    }
  }

  if (war.startDate && war.endDate) {
    const a = DATE_KEY.exec(war.startDate);
    const b = DATE_KEY.exec(war.endDate);
    if (a && b) {
      const toOrdinal = (m: RegExpExecArray) =>
        Number(m[1]) * 372 + Number(m[2]) * 31 + Number(m[3]);
      war.durationDays = toOrdinal(b) - toOrdinal(a);
    }
  }

  // `participants` repeats once per country and is a block (not a list).
  if (node.type === 'block') {
    for (const entry of node.entries) {
      if (entry.key !== 'participants' || entry.value.type !== 'block') continue;
      const p = entriesOf(entry.value);
      const tag = asString(p.get('tag')?.[0]);
      if (!tag) continue;
      const lossesNode = p.get('losses')?.[0];
      const losses =
        lossesNode && lossesNode.type === 'list'
          ? lossesNode.items
              .map((i) => toNumber(asString(i)))
              .filter((n): n is number => n !== undefined)
          : undefined;
      war.participants.push({
        tag,
        warScore: toNumber(asString(p.get('war_score')?.[0])),
        value: toNumber(asString(p.get('value')?.[0])),
        ...(losses ? { losses } : {}),
      });
    }
  }

  return war;
}

/** Extract every war in the save: finished ones plus those still running. */
export function extractWars(doc: SaveDocument): War[] {
  const wars: War[] = [];

  for (const ref of doc.allSections('previous_war')) {
    const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);
    const member = reader.nextMember();
    if (!member) continue;
    const name =
      member.kind === 'string' ? reader.stringValue(member) : reader.rawValue(member);
    // `previous_war` blocks are either a bare string name followed by fields, or a
    // single block; normalise both into one node.
    const node = readAsWarNode(reader, member);
    if (!node) continue;
    wars.push(parseWar(name, node, false));
  }

  for (const ref of doc.allSections('active_war')) {
    const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);
    const node = readBlockNode(reader);
    if (!node) continue;
    const map = entriesOf(node);
    const name = asString(map.get('name')?.[0]) ?? '(未命名战争)';
    wars.push(parseWar(name, node, true));
  }

  wars.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
  return wars;
}

/** `previous_war` starts with an unkeyed name string, then the fields. */
function readAsWarNode(
  reader: ClausewitzReader,
  first: import('./clausewitz.ts').Member,
): CwNode | undefined {
  if (first.kind === 'block') return readNode(reader, first);
  const entries: { key: string; value: CwNode }[] = [];
  for (;;) {
    const member = reader.nextMember();
    if (!member) break;
    if (member.key === null) continue;
    entries.push({ key: member.key, value: readEntry(reader, member) });
  }
  return { type: 'block', entries };
}

/** A whole `active_war` section is one block. */
function readBlockNode(reader: ClausewitzReader): CwNode | undefined {
  const member = reader.nextMember();
  if (!member) return undefined;
  if (member.kind === 'block') return readNode(reader, member);
  // Fall back to reading the members as a synthetic block.
  const entries: { key: string; value: CwNode }[] = [];
  entries.push({ key: member.key ?? '?', value: readEntry(reader, member) });
  for (;;) {
    const next = reader.nextMember();
    if (!next) break;
    if (next.key === null) continue;
    entries.push({ key: next.key, value: readEntry(reader, next) });
  }
  return { type: 'block', entries };
}

export interface WarStats {
  total: number;
  ongoing: number;
  finished: number;
  battles: number;
  navalBattles: number;
  /** tag -> number of wars it took part in. */
  participation: Map<string, number>;
  /** tag -> number of battles it fought. */
  battleCount: Map<string, number>;
}

export function warStats(wars: readonly War[]): WarStats {
  const participation = new Map<string, number>();
  const battleCount = new Map<string, number>();
  let battles = 0;
  let navalBattles = 0;
  let ongoing = 0;
  for (const war of wars) {
    if (war.ongoing) ongoing += 1;
    for (const tag of new Set([...war.attackers, ...war.defenders])) {
      participation.set(tag, (participation.get(tag) ?? 0) + 1);
    }
    for (const battle of war.battles) {
      battles += 1;
      if (battle.naval) navalBattles += 1;
      for (const side of [battle.attacker, battle.defender]) {
        if (!side.country) continue;
        battleCount.set(side.country, (battleCount.get(side.country) ?? 0) + 1);
      }
    }
  }
  return {
    total: wars.length,
    ongoing,
    finished: wars.length - ongoing,
    battles,
    navalBattles,
    participation,
    battleCount,
  };
}
