/**
 * Check the exported flag assets: every stored file must be a readable image of
 * the right kind, and the manifest must agree with what is on disk.
 *
 * The build-time colonial composites (`assets/flags/colonial/`,
 * `assets/flags/colonial-modded/`) are retired:
 * colonial flags are drawn at runtime as a DOM overlay (the mother country's
 * flag plus a right-half colour block), so this script asserts nothing about
 * those directories any more. There is therefore no "colonial flag is missing"
 * case left to catch — what can still be missing is the *mother country's* own
 * artwork, and that is covered by the base/modded checks here and in
 * `scripts/verify-deploy.ts`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

const OUT = 'apps/site/public/assets/flags';
const manifest = JSON.parse(readFileSync(`${OUT}/manifest.json`, 'utf8')) as {
  sets: Record<string, { files: number; bytes: number; skipped: number }>;
  fileNames: Record<string, Record<string, string>>;
  sourceFormats: Record<string, Record<string, string>>;
};

function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  if (b[0] !== 0x89 || b[1] !== 0x50) throw new Error('not a PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
function jpegSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1] as number;
    const length = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new Error('no JPEG frame header');
}

/** Sets the manifest may still list that no longer exist on disk on purpose. */
const RETIRED_SETS = new Set(['colonial', 'colonial-modded']);

let checked = 0;
let bad = 0;
const sizes = new Map<string, number>();
const formats = new Map<string, number>();
for (const [set, stat] of Object.entries(manifest.sets)) {
  if (RETIRED_SETS.has(set)) continue;
  const dir = `${OUT}/${set}`;
  if (!existsSync(dir)) {
    console.log(`!! missing directory for set ${set}`);
    bad += 1;
    continue;
  }
  const files = readdirSync(dir);
  if (files.length !== stat.files) {
    console.log(`!! ${set}: manifest says ${stat.files} files, disk has ${files.length}`);
    bad += 1;
  }
  for (const file of files) {
    const path = `${dir}/${file}`;
    const format = (manifest.sourceFormats[set] ?? {})[file.replace(/\.(png|jpg)$/, '')] ?? '?';
    formats.set(format, (formats.get(format) ?? 0) + 1);
    try {
      const size = file.endsWith('.jpg') ? jpegSize(path) : pngSize(path);
      const key = `${size.width}x${size.height}`;
      sizes.set(key, (sizes.get(key) ?? 0) + 1);
      if (size.width < 8 || size.height < 8 || size.width > 4096 || size.height > 4096) {
        console.log(`!! ${set}/${file}: implausible size ${key}`);
        bad += 1;
      }
      checked += 1;
    } catch (error) {
      console.log(`!! ${set}/${file}: ${(error as Error).message}`);
      bad += 1;
    }
  }
}

const totalBytes = Object.values(manifest.sets).reduce((sum, s) => sum + s.bytes, 0);
console.log(`checked ${checked} stored flags, ${bad} problems`);
console.log(`manifest total: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
console.log('set summary:');
for (const [set, stat] of Object.entries(manifest.sets)) {
  console.log(`  ${set}: ${stat.files} files, ${(stat.bytes / 1024 / 1024).toFixed(1)} MB, ${stat.skipped} skipped`);
}
console.log('source formats:', [...formats.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' '));
console.log('stored sizes:', [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}=${n}`).join(' '));

// A couple of spot checks against the game itself.
const rus = `${OUT}/base/RUS.png`;
console.log(`base/RUS.png ${JSON.stringify(pngSize(rus))} on disk ${statSync(rus).size} B`);
const nonPng = Object.entries(manifest.fileNames).flatMap(([set, map]) =>
  Object.entries(map).map(([tag, file]) => `${set}/${file} (source ${(manifest.sourceFormats[set] ?? {})[tag]})`),
);
console.log(`stored with a non-PNG name: ${nonPng.length ? nonPng.slice(0, 6).join(', ') : 'none'}`);
process.exitCode = bad ? 1 : 0;
