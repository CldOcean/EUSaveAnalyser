#!/usr/bin/env node
/**
 * Command line interface for the EU4 save parser.
 *
 *   node src/cli.ts info      <save.eu4>            archive members + meta header
 *   node src/cli.ts sections  <save.eu4>            top-level gamestate sections
 *   node src/cli.ts dump      <save.eu4> <section> [entryKey]
 *   node src/cli.ts provinces <save.eu4> [--limit N] [--owner TAG]
 *   node src/cli.ts countries <save.eu4> [--limit N]
 *   node src/cli.ts map       <save.eu4> [--out file.json]
 *   node src/cli.ts parse     <save.eu4> [--out file.json] [--sections all]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  SaveDocument,
  countryGroup,
  countryScalar,
} from './document.ts';
import type { CountryRecord, ProvinceRecord } from './types.ts';

/** Write a text file, creating parent directories as needed. */
async function writeText(path: string, contents: string): Promise<void> {
  const parent = dirname(path);
  if (parent && parent !== '.') await mkdir(parent, { recursive: true });
  await writeFile(path, contents, 'utf8');
}

interface Args {
  command: string;
  file?: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2) as [string, string?];
      if (inline !== undefined) {
        flags.set(name, inline);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(name, next);
          i += 1;
        } else {
          flags.set(name, true);
        }
      }
    } else {
      positional.push(arg);
    }
  }
  const [command = 'help', file, ...rest] = positional;
  return { command, file, positional: rest, flags };
}

function flagNumber(args: Args, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined || raw === true) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function flagString(args: Args, name: string): string | undefined {
  const raw = args.flags.get(name);
  return typeof raw === 'string' ? raw : undefined;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${((ms - m * 60_000) / 1000).toFixed(1)}s`;
}

const HELP = `EU4 save parser CLI

  info      <save.eu4>                 archive members + meta header
  sections  <save.eu4>                 top-level gamestate sections by size
  dump      <save.eu4> <section> [key] list members of a section (or of one entry)
  provinces <save.eu4> [--limit N] [--owner TAG]
  countries <save.eu4> [--limit N] [--min-provinces N]
  map       <save.eu4> [--out FILE]    province -> owner/religion/culture table
  parse     <save.eu4> [--out FILE] [--sections all]   full snapshot as JSON
`;

async function load(file: string | undefined): Promise<SaveDocument> {
  if (!file) throw new Error('a .eu4 file path is required');
  return SaveDocument.fromFile(file);
}

function provinceRow(p: ProvinceRecord): string {
  const tax = p.baseTax ?? 0;
  const prod = p.baseProduction ?? 0;
  const mp = p.baseManpower ?? 0;
  return [
    String(p.id).padStart(5),
    (p.name ?? '').padEnd(12),
    (p.owner ?? '').padEnd(4),
    (p.controller ?? '').padEnd(4),
    (p.religion ?? '').padEnd(12),
    (p.culture ?? '').padEnd(16),
    (p.tradeGoods ?? '').padEnd(14),
    `${tax}/${prod}/${mp}`.padStart(12),
  ].join(' ');
}

function countryRow(tag: string, c: CountryRecord, provinceCount: number): string {
  const tech = countryGroup(c, 'technology') ?? {};
  const religion = countryScalar(c, 'religion') ?? '';
  const government = countryScalar(c, 'government') ?? countryScalar(c, 'government_name') ?? '';
  const capital = countryScalar(c, 'capital') ?? '';
  return [
    tag.padEnd(4),
    religion.padEnd(14),
    government.padEnd(22),
    `prov=${String(provinceCount).padStart(4)}`,
    `tech=${tech['adm_tech'] ?? '?'}/${tech['dip_tech'] ?? '?'}/${tech['mil_tech'] ?? '?'}`,
    `cap=${capital}`,
  ].join(' ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.command === '--help') {
    process.stdout.write(HELP);
    return;
  }

  const doc = await load(args.file);

  switch (args.command) {
    case 'info': {
      process.stdout.write(`file: ${doc.source}\n`);
      process.stdout.write('\narchive members:\n');
      for (const entry of doc.archive.entries) {
        process.stdout.write(
          `  ${entry.name.padEnd(12)} method=${entry.method} ` +
            `compressed=${fmtBytes(entry.compressedSize).padStart(9)} ` +
            `raw=${fmtBytes(entry.uncompressedSize).padStart(9)}\n`,
        );
      }
      const meta = doc.meta;
      process.stdout.write('\nmeta:\n');
      process.stdout.write(`  date                 ${meta.date}\n`);
      process.stdout.write(`  save_game            ${meta.saveGame ?? '-'}\n`);
      process.stdout.write(`  player               ${meta.player ?? '-'}\n`);
      process.stdout.write(
        `  displayed_country    ${meta.displayedCountryName ?? '-'}\n`,
      );
      process.stdout.write(`  version              ${meta.version.text} (${meta.version.name ?? '-'})\n`);
      process.stdout.write(`  versions seen        ${meta.versions.join(', ') || '-'}\n`);
      process.stdout.write(`  multiplayer          ${meta.multiPlayer}\n`);
      process.stdout.write(`  campaign_id          ${meta.campaignId ?? '-'}\n`);
      process.stdout.write(`  campaign_length      ${meta.campaignLength ?? '-'}\n`);
      process.stdout.write(`  checksum             ${meta.checksum ?? '-'}\n`);
      process.stdout.write(`  dlc enabled          ${meta.dlc.length}\n`);
      process.stdout.write(`  mods enabled         ${meta.mods.length}\n`);
      for (const mod of meta.mods) {
        process.stdout.write(`      - ${mod.name}\n`);
      }
      if (meta.campaignStats.length > 0) {
        process.stdout.write('\n  campaign stats:\n');
        for (const stat of meta.campaignStats) {
          process.stdout.write(
            `      ${String(stat.key).padEnd(18)} ` +
              `${stat.value !== undefined ? String(stat.value).padStart(12) : ''.padStart(12)} ` +
              `${stat.selector ? `selector=${stat.selector}` : ''}` +
              `${stat.localization ? ` "${stat.localization}"` : ''}\n`,
          );
        }
      }
      break;
    }

    case 'sections': {
      const sorted = [...doc.sections].sort((a, b) => b.size - a.size);
      process.stdout.write(`${doc.sections.length} top-level sections\n\n`);
      for (const s of sorted.slice(0, 120)) {
        process.stdout.write(
          `  ${s.key.padEnd(38)} ${s.kind.padEnd(7)} ${fmtBytes(s.size).padStart(10)}\n`,
        );
      }
      break;
    }

    case 'dump': {
      const section = args.positional[0];
      if (!section) throw new Error('dump requires a section name');
      const limit = flagNumber(args, 'limit') ?? 200;
      const rows = doc.describe(section, args.positional[1], limit);
      if (rows.length === 0) {
        process.stdout.write(`section "${section}" not found or empty\n`);
        break;
      }
      process.stdout.write(
        `${rows.length} members of ${section}` +
          `${args.positional[1] ? ` -> ${args.positional[1]}` : ''}\n\n`,
      );
      for (const row of rows) {
        process.stdout.write(
          `  ${String(row.key ?? '<bare>').padEnd(34)} ${row.kind.padEnd(7)} ${fmtBytes(row.size).padStart(10)}\n`,
        );
      }
      break;
    }

    case 'provinces': {
      const limit = flagNumber(args, 'limit') ?? 25;
      const owner = flagString(args, 'owner');
      const provinces = [...doc.provinces().values()].sort((a, b) => a.id - b.id);
      const filtered = owner ? provinces.filter((p) => p.owner === owner) : provinces;
      process.stdout.write(
        `${provinces.length} provinces parsed` +
          `${owner ? `, ${filtered.length} owned by ${owner}` : ''}\n\n`,
      );
      process.stdout.write(
        `  ${'id'.padStart(5)} ${'name'.padEnd(12)} ${'own'.padEnd(4)} ${'ctl'.padEnd(4)} ` +
          `${'religion'.padEnd(12)} ${'culture'.padEnd(16)} ${'trade goods'.padEnd(14)} ${'tax/prod/mp'.padStart(12)}\n`,
      );
      for (const p of filtered.slice(0, limit)) {
        process.stdout.write(`  ${provinceRow(p)}\n`);
      }
      break;
    }

    case 'countries': {
      const limit = flagNumber(args, 'limit') ?? 30;
      const minProvinces = flagNumber(args, 'min-provinces') ?? 0;
      const counts = new Map<string, number>();
      for (const p of doc.provinces().values()) {
        if (!p.owner || p.owner === '---') continue;
        counts.set(p.owner, (counts.get(p.owner) ?? 0) + 1);
      }
      const countries = doc.countries();
      const rows = [...countries.entries()]
        .map(([tag, c]) => ({ tag, c, n: counts.get(tag) ?? 0 }))
        .filter((r) => r.n >= minProvinces)
        .sort((a, b) => b.n - a.n);
      process.stdout.write(
        `${countries.size} countries parsed, ${rows.length} shown (sorted by provinces)\n\n`,
      );
      for (const row of rows.slice(0, limit)) {
        process.stdout.write(`  ${countryRow(row.tag, row.c, row.n)}\n`);
      }
      break;
    }

    case 'map': {
      const table: Record<string, { owner?: string; controller?: string; religion?: string; culture?: string }> = {};
      for (const p of doc.provinces().values()) {
        table[String(p.id)] = {
          owner: p.owner,
          controller: p.controller,
          religion: p.religion,
          culture: p.culture,
        };
      }
      const out = flagString(args, 'out');
      const json = JSON.stringify({ date: doc.meta.date, provinces: table });
      if (out) {
        await writeText(out, json);
        process.stdout.write(`wrote ${out} (${fmtBytes(json.length)})\n`);
      } else {
        process.stdout.write(`${json}\n`);
      }
      break;
    }

    case 'parse': {
      const started = performance.now();
      const snapshot = doc.snapshot({
        sections: args.flags.get('sections') === 'all' ? 'all' : undefined,
      });
      const elapsed = performance.now() - started;
      const out = flagString(args, 'out');
      if (out) {
        const json = JSON.stringify(snapshot);
        await writeText(out, json);
        process.stdout.write(`wrote ${out} (${fmtBytes(json.length)})\n`);
      }
      const provinces = Object.values(snapshot.provinces);
      const owners = new Map<string, number>();
      for (const p of provinces) {
        if (p.owner && p.owner !== '---') owners.set(p.owner, (owners.get(p.owner) ?? 0) + 1);
      }
      const top = [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
      process.stdout.write(`\nparsed ${doc.source}\n`);
      process.stdout.write(`  date                 ${snapshot.meta.date}\n`);
      process.stdout.write(`  player               ${snapshot.meta.player} (${snapshot.meta.displayedCountryName})\n`);
      process.stdout.write(`  version              ${snapshot.meta.version.text}\n`);
      process.stdout.write(`  players              ${snapshot.players.map((p) => `${p.name}=${p.tag}`).join(', ') || '-'}\n`);
      process.stdout.write(`  provinces            ${snapshot.stats.provinceCount} (${snapshot.stats.ownedProvinceCount} owned)\n`);
      process.stdout.write(`  countries            ${snapshot.stats.countryCount}\n`);
      process.stdout.write(`  sections captured    ${Object.keys(snapshot.sections).length}\n`);
      process.stdout.write(`  warnings             ${snapshot.warnings.length}\n`);
      for (const warning of snapshot.warnings.slice(0, 5)) {
        process.stdout.write(`      ! ${warning}\n`);
      }
      process.stdout.write(`  extraction time      ${fmtDuration(elapsed)}\n`);
      process.stdout.write('\n  largest countries by province count:\n');
      for (const [tag, n] of top) {
        const name = snapshot.countries[tag]?.scalars['name'];
        process.stdout.write(`      ${tag}  ${String(n).padStart(4)}${name ? `  ${name}` : ''}\n`);
      }
      break;
    }

    default:
      process.stdout.write(`unknown command "${args.command}"\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  if (process.env['EU4_DEBUG'] && error instanceof Error) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
