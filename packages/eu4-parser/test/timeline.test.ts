/**
 * Regression tests for the timeline replay and the war history.
 *
 * The headline assertion is a *proof of correctness* rather than a spot check:
 * replaying every province event up to the save's own date must reproduce the
 * province table the save stores directly, for every province — including the
 * tag aliases that turn a 1525 `owner=MOS` into today's `RUS`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SaveDocument } from '../src/document.ts';
import {
  TimelinePlayer,
  buildTagAliases,
  buildTimeline,
  frameDates,
  provincesEverMatching,
  resolveTag,
  timelineStats,
} from '../src/timeline.ts';
import { extractWars, warStats } from '../src/wars.ts';
import { parseGameDate } from '../src/value.ts';

const SAVE = fileURLToPath(
  new URL('../../../存档示例/mp_俄罗斯1574_11_12.eu4', import.meta.url),
);

const doc = await SaveDocument.fromFile(SAVE);
const timeline = buildTimeline(doc);
const aliases = buildTagAliases(doc);
const FIELDS = ['owner', 'controller', 'religion', 'culture'] as const;

test('a single save carries a full dated province history', () => {
  const stats = timelineStats(timeline);
  assert.equal(stats.provincesWithHistory, 3924);
  assert.equal(stats.eventCount, 147_337);
  assert.equal(stats.startDate, '1444.11.11');
  assert.equal(stats.endDate, '1574.11.12');
  assert.ok(timeline.fields.includes('owner'));
  assert.ok(timeline.fields.includes('controller'));
  assert.ok(timeline.fields.includes('religion'));
});

test('events are sorted, and same-date entries keep file order', () => {
  let previous = -Infinity;
  for (const event of timeline.events) {
    assert.ok(event.ordinal >= previous, `event ${event.date} out of order`);
    previous = event.ordinal;
  }
  // Stockholm: `1523.3.30 controller=MOS` then `controller=RUS` on the same day.
  const stockholm = timeline.provinces.get(1)!;
  const sameDay = stockholm.events.filter((e) => e.date === '1523.3.30');
  assert.equal(sameDay.length, 2);
  const controllers = sameDay.map(
    (e) => e.changes.find((c) => c.field === 'controller')?.value,
  );
  assert.deepEqual(controllers, ['MOS', 'RUS'], 'file order must be preserved');
});

test('replaying to the save date reproduces the province table exactly', () => {
  const saveDate = parseGameDate(doc.meta.date)!;
  const player = new TimelinePlayer(timeline, FIELDS);
  player.advanceTo(saveDate.ordinal);

  const normalise = (v: string | undefined): string | undefined =>
    v === undefined || v === '---' ? undefined : v;

  let compared = 0;
  let exact = 0;
  const failures: string[] = [];
  for (const province of doc.provinces().values()) {
    for (const field of ['owner', 'religion', 'culture'] as const) {
      let replayed = player.valueOf(field, province.id);
      if (field === 'owner' && replayed !== undefined) {
        replayed = resolveTag(aliases, replayed, saveDate.ordinal);
      }
      const expected = province[field];
      const a = normalise(replayed);
      const b = normalise(expected);
      if (a === undefined && b === undefined) continue;
      compared += 1;
      if (a === b) exact += 1;
      else if (failures.length < 5) failures.push(`${province.id}.${field}: ${a} != ${b}`);
    }
  }
  assert.ok(compared > 9000, `expected to compare many fields, got ${compared}`);
  assert.deepEqual(failures, [], 'replay diverged from the stored state');
  assert.equal(exact, compared);
});

test('tag changes are discovered and applied as aliases', () => {
  const pairs = aliases.map((a) => `${a.from}->${a.to}`);
  assert.ok(pairs.includes('MOS->RUS'), 'Muscovy forming Russia');
  assert.ok(pairs.includes('ENG->GBR'), 'England forming Great Britain');
  assert.ok(pairs.includes('BRA->PRU'), 'Brandenburg forming Prussia');
  assert.ok(pairs.includes('QOM->PER'), 'Persia forming');
  assert.equal(aliases.length, 17);

  // Before the change the old tag stands; after it, the successor does.
  const change = aliases.find((a) => a.from === 'MOS')!;
  assert.equal(resolveTag(aliases, 'MOS', change.ordinal - 1), 'MOS');
  assert.equal(resolveTag(aliases, 'MOS', change.ordinal), 'RUS');
  assert.equal(resolveTag(aliases, 'RUS', change.ordinal), 'RUS');
  assert.equal(resolveTag(aliases, 'NONE', change.ordinal), 'NONE');
});

test('a province can be walked through time', () => {
  const at = (date: string) => {
    const player = new TimelinePlayer(timeline, FIELDS);
    player.advanceTo(parseGameDate(date)!.ordinal);
    return {
      owner: player.valueOf('owner', 1),
      controller: player.valueOf('controller', 1),
      religion: player.valueOf('religion', 1),
    };
  };
  assert.deepEqual(at('1444.11.11'), {
    owner: 'SWE',
    controller: 'SWE',
    religion: 'catholic',
  });
  // occupied by Russia during a war, still Swedish
  assert.deepEqual(at('1523.3.30'), {
    owner: 'SWE',
    controller: 'RUS',
    religion: 'catholic',
  });
  // handed to Muscovy, then protestant during the Reformation
  assert.deepEqual(at('1532.5.22'), {
    owner: 'MOS',
    controller: 'RUS',
    religion: 'protestant',
  });
});

test('stateOf reports the full tracked state of one province', () => {
  const player = new TimelinePlayer(timeline, FIELDS);
  const state = player.stateOf(1, parseGameDate('1574.11.12')!.ordinal);
  assert.equal(state['owner'], 'MOS', 'raw value before alias resolution');
  assert.equal(state['religion'], 'protestant');
  assert.equal(state['culture'], 'swedish');
});

test('advanceTo is monotonic and reset rewinds', () => {
  const player = new TimelinePlayer(timeline, ['owner']);
  const early = parseGameDate('1450.1.1')!.ordinal;
  const late = parseGameDate('1574.11.12')!.ordinal;
  player.advanceTo(early);
  const afterEarly = player.appliedEvents;
  player.advanceTo(late);
  assert.ok(player.appliedEvents > afterEarly);
  // Advancing backwards is a no-op, not a rewind.
  player.advanceTo(early);
  assert.ok(player.appliedEvents >= afterEarly);
  player.reset();
  assert.equal(player.appliedEvents, 0);
  assert.equal(player.valueOf('owner', 1), 'SWE');
});

test('provincesEverMatching finds historical reach', () => {
  // Only the provinces Muscovy still held when it renamed itself are logged as
  // MOS; everything it took afterwards is logged directly as RUS.
  const everMuscovite = provincesEverMatching(timeline, 'owner', 'MOS');
  assert.ok(everMuscovite.length > 150, `got ${everMuscovite.length}`);
  assert.ok(everMuscovite.includes(1));

  const everRussian = provincesEverMatching(timeline, 'owner', 'RUS');
  assert.ok(everRussian.length > 200, `got ${everRussian.length}`);
  // Together they cover Russia's whole reach. The union is at least the 380
  // provinces held today, and larger because provinces Russia later lost count
  // as well.
  const union = new Set([...everMuscovite, ...everRussian]);
  assert.ok(union.size >= 380, `union covers only ${union.size} provinces`);
  for (const province of doc.provinces().values()) {
    if (province.owner !== 'RUS') continue;
    assert.ok(union.has(province.id), `province ${province.id} owned by RUS is not in the union`);
  }
});

test('frameDates produces evenly spaced dates and ends on the save date', () => {
  const frames = frameDates('1444.11.11', '1574.11.12', 5);
  assert.equal(frames[0]?.date, '1444.11.11');
  assert.equal(frames[frames.length - 1]?.date, '1574.11.12');
  // 1444, 1449, ... 1574 is 27 five-year marks, plus the final partial frame.
  assert.equal(frames.length, 28);
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok((frames[i]!.ordinal) > (frames[i - 1]!.ordinal));
  }
});

// ------------------------------------------------------------------- wars ----

const wars = extractWars(doc);

test('extracts every war with its dated history', () => {
  const stats = warStats(wars);
  assert.equal(stats.total, 638);
  assert.equal(stats.finished, 621);
  assert.equal(stats.ongoing, 17);
  assert.equal(stats.battles, 3172);
  assert.ok(stats.navalBattles > 200);
});

test('wars carry sides, dates and war goals', () => {
  const war = wars.find((w) => w.name === '巽他征服卡尔塔之战');
  assert.ok(war, 'the Sunda war should be present');
  assert.equal(war!.originalAttacker, 'SUN');
  assert.equal(war!.originalDefender, 'MAJ');
  assert.equal(war!.startDate, '1452.11.2');
  assert.equal(war!.endDate, '1456.10.6');
  assert.ok(war!.attackers.includes('SMB'));
  assert.ok(war!.defenders.includes('MAJ'));
  assert.ok(war!.battles.length >= 8, `got ${war!.battles.length}`);
});

test('battles record both sides, losses and the winner', () => {
  const war = wars.find((w) => w.name === '巽他征服卡尔塔之战')!;
  const first = war.battles[0]!;
  assert.equal(first.date, '1453.4.13');
  assert.equal(first.name, '苏腊巴亚');
  assert.equal(first.location, 628);
  assert.equal(first.naval, false);
  assert.equal(first.attackerWon, false, 'result=no means the attacker lost');
  assert.equal(first.attacker.country, 'SUN');
  assert.equal(first.defender.country, 'MAJ');
  assert.equal(first.attacker.losses, 3718);
  assert.equal(first.defender.losses, 1519);
  assert.equal(first.attacker.units['infantry'], 6871);
  assert.ok((first.attacker.commander ?? '').length > 0);

  const naval = war.battles.find((b) => b.naval);
  assert.ok(naval, 'the war has a naval battle');
  assert.equal(naval!.date, '1455.12.6');
  assert.ok(Object.keys(naval!.attacker.units).some((u) => u.includes('ship') || u === 'galley'));

  // Battle locations are real provinces.
  const provinces = doc.provinces();
  const located = wars.flatMap((w) => w.battles).filter((b) => b.location !== undefined);
  assert.ok(located.length > 3000);
  let resolved = 0;
  for (const battle of located) if (provinces.has(battle.location!)) resolved += 1;
  assert.ok(resolved / located.length > 0.98, `only ${resolved}/${located.length} resolved`);
});

test('the Sunda war battle at 苏腊巴亚 maps to the right province', () => {
  const war = wars.find((w) => w.name === '巽他征服卡尔塔之战')!;
  const battle = war.battles.find((b) => b.location === 628)!;
  assert.equal(doc.provinces().get(628)?.name, '苏腊巴亚');
});

test('join and leave events are dated', () => {
  const war = wars.find((w) => w.name === '巽他征服卡尔塔之战')!;
  const joins = war.events.filter((e) => e.kind === 'add_attacker' || e.kind === 'add_defender');
  assert.ok(joins.length >= 2);
  assert.ok(joins.every((e) => /^\d+\.\d+\.\d+$/.test(e.date)));
  assert.ok(joins.some((e) => e.tags.includes('SUN') || e.tags.includes('MAJ')));
});

test('ongoing wars are marked and have no outcome', () => {
  const active = wars.filter((w) => w.ongoing);
  assert.equal(active.length, 17);
  assert.ok(active.every((w) => w.endDate !== undefined));
  assert.ok(active.some((w) => w.name.includes('阿兹特克')));
});

test('peace terms survive extraction', () => {
  const withTerms = wars.filter((w) => w.peaceTerms.length > 0);
  assert.ok(withTerms.length > 50, `only ${withTerms.length} wars carry terms`);
  const all = withTerms.flatMap((w) => w.peaceTerms);
  assert.ok(all.some((t) => t.kind.startsWith('take_')));
  assert.ok(all.some((t) => t.province !== undefined));
});
