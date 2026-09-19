/**
 * Validate the timeline replay and the war extraction.
 *
 * The decisive check: replay every province event up to the save's own date and
 * compare the result against the province's *current* `owner`/`religion`/`culture`
 * fields. If the replay is right, they must agree province for province.
 */
import { SaveDocument } from '../packages/eu4-parser/src/document.ts';
import {
  buildTimeline,
  timelineStats,
  TimelinePlayer,
  buildTagAliases,
  resolveTag,
} from '../packages/eu4-parser/src/timeline.ts';
import { extractWars, warStats } from '../packages/eu4-parser/src/wars.ts';
import { parseGameDate } from '../packages/eu4-parser/src/value.ts';

const doc = await SaveDocument.fromFile('存档示例/mp_俄罗斯1574_11_12.eu4');
const t0 = performance.now();

const timeline = buildTimeline(doc);
const stats = timelineStats(timeline);
console.log('=== timeline ===');
console.log(`  provinces with history : ${stats.provincesWithHistory.toLocaleString()}`);
console.log(`  dated events           : ${stats.eventCount.toLocaleString()}`);
console.log(`  field changes          : ${stats.changeCount.toLocaleString()}`);
console.log(`  campaign start         : ${stats.startDate}`);
console.log(`  last recorded event    : ${stats.endDate}`);
console.log(`  build time             : ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`  top fields             : ${timeline.fields.slice(0, 12).join(', ')}`);

const FIELDS = ['owner', 'controller', 'religion', 'culture', 'base_tax', 'base_production', 'base_manpower'] as const;

// -------------------------------------------------- replay vs current state ---
console.log('\n=== tag changes recorded in country histories ===');
const aliasStart = performance.now();
const aliases = buildTagAliases(doc);
console.log(`  ${aliases.length} change(s): ${aliases.map((a) => `${a.date} ${a.from}->${a.to}`).join(', ')}`);
console.log(`  scan time ${(performance.now() - aliasStart).toFixed(0)} ms`);

console.log('\n=== replay check: state at save date vs the save itself ===');
const saveDate = parseGameDate(doc.meta.date)!;
const player = new TimelinePlayer(timeline, FIELDS);
player.advanceTo(saveDate.ordinal);

const provinces = doc.provinces();
const mismatches: Array<{ id: number; field: string; replayed: string | undefined; actual: string | undefined }> = [];
const counts = { owner: 0, religion: 0, culture: 0 };
const totals = { owner: 0, religion: 0, culture: 0 };
for (const province of provinces.values()) {
  const actual: Record<string, string | undefined> = {
    owner: province.owner,
    religion: province.religion,
    culture: province.culture,
  };
  for (const field of ['owner', 'religion', 'culture'] as const) {
    let replayed = player.valueOf(field, province.id);
    if (field === 'owner' && replayed !== undefined) {
      replayed = resolveTag(aliases, replayed, saveDate.ordinal);
    }
    // `owner="---"` and an absent `owner` both mean "nobody owns this".
    const norm = (v: string | undefined): string | undefined =>
      v === undefined || v === '---' ? undefined : v;
    const a = norm(replayed);
    const b = norm(actual[field]);
    if (a === undefined && b === undefined) continue;
    totals[field] += 1;
    if (a === b) counts[field] += 1;
    else if (mismatches.length < 12) {
      mismatches.push({ id: province.id, field, replayed, actual: actual[field] });
    }
  }
}
for (const field of ['owner', 'religion', 'culture'] as const) {
  const ok = counts[field];
  const total = totals[field];
  const pct = total ? ((ok / total) * 100).toFixed(2) : 'n/a';
  console.log(`  ${field.padEnd(9)} ${ok.toLocaleString()} / ${total.toLocaleString()}  (${pct}% exact)`);
}
if (mismatches.length) {
  console.log('  first mismatches:');
  for (const m of mismatches) {
    console.log(`     province ${m.id} ${m.field}: replayed=${JSON.stringify(m.replayed)} actual=${JSON.stringify(m.actual)}`);
  }
}

// --------------------------------------------------------- states over time ---
console.log('\n=== province 1 (Stockholm) owner over time ===');
for (const date of ['1444.11.11', '1466.7.23', '1500.1.1', '1523.3.30', '1525.6.4', '1574.11.12']) {
  const gd = parseGameDate(date)!;
  const p2 = new TimelinePlayer(timeline, FIELDS);
  p2.advanceTo(gd.ordinal);
  console.log(
    `  ${date}  owner=${String(p2.valueOf('owner', 1)).padEnd(4)} ` +
      `controller=${String(p2.valueOf('controller', 1)).padEnd(4)} ` +
      `religion=${String(p2.valueOf('religion', 1)).padEnd(11)} ` +
      `culture=${String(p2.valueOf('culture', 1))}`,
  );
}

// ---------------------------------------------------------------- ownership ---
console.log('\n=== how many provinces did RUS own at each date? ===');
for (const date of ['1444.11.11', '1500.1.1', '1525.1.1', '1550.1.1', '1574.11.12']) {
  const gd = parseGameDate(date)!;
  const p3 = new TimelinePlayer(timeline, ['owner']);
  p3.advanceTo(gd.ordinal);
  let n = 0;
  for (const id of timeline.provinces.keys()) if (p3.valueOf('owner', id) === 'RUS') n += 1;
  console.log(`  ${date}  RUS owns ${n} provinces`);
}

// -------------------------------------------------------------------- wars ---
console.log('\n=== wars ===');
const t1 = performance.now();
const wars = extractWars(doc);
const ws = warStats(wars);
console.log(`  total ${ws.total} (finished ${ws.finished}, ongoing ${ws.ongoing})`);
console.log(`  battles ${ws.battles.toLocaleString()} (naval ${ws.navalBattles.toLocaleString()})`);
console.log(`  extraction time ${(performance.now() - t1).toFixed(0)} ms`);
const topBattlers = [...ws.battleCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`  most battles fought: ${topBattlers.map(([t, n]) => `${t}=${n}`).join(' ')}`);
const topWars = [...ws.participation.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`  most wars involved : ${topWars.map(([t, n]) => `${t}=${n}`).join(' ')}`);

const biggest = [...wars].sort((a, b) => b.battles.length - a.battles.length).slice(0, 3);
for (const war of biggest) {
  console.log(`\n  --- ${war.name} ---`);
  console.log(`     ${war.startDate} .. ${war.endDate}  ${war.ongoing ? '(进行中)' : ''}`);
  console.log(`     attacker=${war.originalAttacker} defenders=${war.originalDefender}`);
  console.log(`     attackers=[${war.attackers.join(' ')}] defenders=[${war.defenders.join(' ')}]`);
  console.log(`     war goal: ${JSON.stringify(war.warGoal)}   outcome=${war.outcome} ${war.outcomeLabel ?? ''}`);
  console.log(`     battles=${war.battles.length}`);
  for (const battle of war.battles.slice(0, 3)) {
    const provinceName = battle.location ? provinces.get(battle.location)?.name : undefined;
    console.log(
      `        ${battle.date} ${battle.name}${provinceName ? ` (${provinceName})` : ''} ` +
        `${battle.naval ? 'naval' : 'land'} ` +
        `${battle.attacker.country}(${battle.attacker.losses ?? '?'} lost) vs ` +
        `${battle.defender.country}(${battle.defender.losses ?? '?'} lost) ` +
        `-> ${battle.attackerWon ? 'attacker won' : 'defender won'}`,
    );
  }
}
