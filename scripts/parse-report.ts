/**
 * Parse one save and write a human-readable report.
 *
 * Built for testing: it exercises every stage of the parser (zip members, meta,
 * gamestate sections, provinces, countries) and prints ASCII-only progress to the
 * console, while the Chinese detail goes into a UTF-8 text file.
 *
 * Why the split: piping UTF-8 Chinese through cmd.exe while `chcp 65001` is active
 * makes cmd terminate the batch early (and mangle `§`/`£` markup), so the console
 * never sees anything but ASCII here.
 *
 *   node scripts/parse-report.ts <save.eu4> [--out tmp/parse-report.txt]
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { SaveDocument, countryScalar } from '../packages/eu4-parser/src/document.ts';
import { readZipEntries } from '../packages/eu4-parser/src/zip.ts';

const args = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const savePath = args.find((arg, i) => !arg.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
const outPath = valueOf('out') ?? 'tmp/parse-report.txt';

if (!savePath) {
  console.log('usage: parse-report.ts <save.eu4> [--out tmp/parse-report.txt]');
  process.exit(2);
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** Small members are KB-sized, and "0.0 MB" for them reads like a bug. */
const size = (bytes: number): string =>
  bytes >= 1024 * 1024 ? mb(bytes) : `${(bytes / 1024).toFixed(1)} KB`;
const line = (text: string): string => `${text}\n`;

const out: string[] = [];
const step = (index: number, total: number, what: string): void => {
  console.log(`[${index}/${total}] ${what}`);
};

// ---------------------------------------------------------------- 1. members --
step(1, 5, 'archive members');
const buffer = readFileSync(savePath);
const entries = readZipEntries(buffer);
out.push(line(`存档：${savePath}`));
out.push(line(`文件：${mb(statSync(savePath).size)}`));
out.push(line(''));
out.push(line('## 压缩包成员'));
for (const entry of entries) {
  out.push(line(`  ${entry.name.padEnd(12)} method=${entry.method}  压缩 ${size(entry.compressedSize)}  原始 ${size(entry.uncompressedSize)}`));
}
console.log(`      ${entries.length} member(s), ${mb(buffer.length)} on disk`);

// ------------------------------------------------------------------- 2. meta --
step(2, 5, 'meta header');
const doc = await SaveDocument.fromFile(savePath, { sections: [] });
const meta = doc.meta;
out.push(line(''));
out.push(line('## 存档信息（meta）'));
out.push(line(`  日期          ${meta.date}`));
out.push(line(`  玩家          ${meta.player} (${meta.displayedCountryName ?? '?'})`));
out.push(line(`  版本          ${meta.version?.text ?? '?'}`));
out.push(line(`  存档名        ${meta.saveGame ?? '?'}`));
out.push(line(`  DLC           ${meta.dlc?.length ?? 0} 个`));
out.push(line(`  模组          ${meta.mods?.length ?? 0} 个`));
for (const mod of meta.mods ?? []) out.push(line(`      - ${mod.name}`));
console.log(`      date=${meta.date} player=${meta.player} version=${meta.version?.text ?? '?'} mods=${meta.mods?.length ?? 0}`);

// --------------------------------------------------------------- 3. sections --
step(3, 5, 'gamestate sections (this is the 57 MB part)');
const sections = [...doc.sections].sort((a, b) => b.size - a.size);
out.push(line(''));
out.push(line(`## 顶层区块（共 ${sections.length} 个，按体积）`));
for (const section of sections.slice(0, 20)) {
  out.push(line(`  ${String(section.key).padEnd(28)} ${mb(section.size)}`));
}
console.log(`      ${sections.length} section(s), largest ${sections[0]?.key ?? '?'} (${mb(sections[0]?.size ?? 0)})`);

// ------------------------------------------------------- 4. provinces/countries
step(4, 5, 'provinces and countries');
const provinces = doc.provinces();
const countries = doc.countries();
out.push(line(''));
out.push(line('## 解析结果'));
out.push(line(`  省份          ${provinces.size}`));
out.push(line(`  国家          ${countries.size}`));
out.push(line(`  告警          ${doc.warnings.length} 条`));
for (const warning of doc.warnings.slice(0, 20)) out.push(line(`      ! ${warning}`));

const ranked = [...countries.entries()]
  .map(([tag, country]) => ({ tag, score: Number(countryScalar(country, 'great_power_score') ?? '0') || 0 }))
  .filter((entry) => entry.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 8);
out.push(line(''));
out.push(line('## 列强前 8（验证国家数据可用）'));
for (const entry of ranked) out.push(line(`  ${entry.tag}  ${entry.score.toFixed(1)}`));

const big = [...provinces.values()]
  .map((province) => ({
    name: province.name ?? `#${province.id}`,
    dev: (province.baseTax ?? 0) + (province.baseProduction ?? 0) + (province.baseManpower ?? 0),
  }))
  .sort((a, b) => b.dev - a.dev)
  .slice(0, 8);
out.push(line(''));
out.push(line('## 发展度前 8 省份（验证省份数据可用）'));
for (const entry of big) out.push(line(`  ${entry.name}  ${entry.dev}`));
console.log(`      provinces=${provinces.size} countries=${countries.size} warnings=${doc.warnings.length}`);

// ----------------------------------------------------------------- 5. report --
step(5, 5, 'writing the report');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out.join(''), 'utf8');
console.log(`      report: ${outPath} (${basename(outPath)})`);

const ok = provinces.size > 0 && countries.size > 0 && meta.date !== undefined;
console.log('');
console.log(ok ? 'RESULT: OK - every stage produced data' : 'RESULT: SUSPICIOUS - some stage came back empty');
process.exit(ok ? 0 : 1);
