/**
 * Build the parser for the browser.
 *
 * The parser is TypeScript and uses two Node APIs - `node:fs/promises` (only in
 * `fromFile`) and `node:zlib` (only the default zip inflater). Browsers have
 * neither, and they cannot run TypeScript at all. Rather than hand-maintain a
 * second copy, this script produces one ESM file from the real sources:
 *
 *   * types are removed with Node's own `module.stripTypeScriptTypes` (the same
 *     engine that lets us run .ts files directly),
 *   * relative imports are dropped and the modules concatenated in dependency
 *     order into a single scope,
 *   * the Node-only entry points are neutralised with clear errors, because the
 *     browser supplies already-inflated members instead (`fromMembers`).
 *
 * Output: apps/site/public/eu4-parser.js
 *
 *   node scripts/build-browser-parser.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';

const SRC = 'packages/eu4-parser/src';
const OUT = 'apps/site/public/eu4-parser.js';

/** Dependency order: a module may only use what earlier ones define. */
const MODULES = [
  // Pure colour maths, used by the page's data plane; declares nothing else.
  'colours.ts',
  'value.ts',
  'types.ts',
  'encoding.ts',
  'clausewitz.ts',
  'zip.ts',
  'document.ts',
  'timeline.ts',
  'subjects.ts',
  'wars.ts',
  'institutions.ts',
  // The detail tables (province extras + the country panel's wave-1 scalars) are one
  // implementation used by both data planes, so the page imports them from the bundle.
  'details.ts',
];

/** What the browser bundle exposes to page code. */
const EXPORTS = [
  'SaveDocument',
  'SaveArchive',
  // The HRE block is read through the same view class the offline script uses,
  // and the leaderboard panels count regiments through the same reader.
  'BlockView',
  'ClausewitzReader',
  'readZipEntries',
  'extractEntry',
  'decodeEu4String',
  'decodeSaveString',
  'buildTimeline',
  'buildCountryTimeline',
  'CountryTimelinePlayer',
  'TimelinePlayer',
  'timelineStats',
  'buildTagAliases',
  'resolveTag',
  'resolveTagLatest',
  'readSubjectLedger',
  'isSubjectType',
  'NON_SUBJECT_TYPES',
  'provincesEverMatching',
  'frameMonths',
  'extractWars',
  'warStats',
  'INSTITUTIONS',
  'readInstitutionProgress',
  'parseGameDate',
  'countryScalar',
  'countryScalarList',
  'countryGroup',
  // The three colour modes are built in the page (`viewer-build.js`), so the page
  // needs the same shading maths the offline generator uses.
  'SUBJECT_SHADE',
  'isPlaceholderColour',
  'shadeRgb',
  'familyTargets',
  'foreignTintFlags',
  // One implementation of the frozen detail schema, shared by both data planes.
  'buildDetailTables',
];

/** Replace Node-only pieces with browser-safe equivalents. */
function adapt(name: string, code: string): string {
  let out = code;
  // `node:fs/promises` -> a stub that explains itself. The browser path is
  // `SaveDocument.fromMembers`.
  out = out.replace(
    /import\s*\{[^}]*\}\s*from\s*'node:fs\/promises';?/g,
    'const readFile = () => { throw new Error("fromFile() needs Node; in the browser use SaveDocument.fromMembers()"); };',
  );
  // `node:zlib` -> the browser never reaches the sync inflater (members arrive
  // inflated) but the symbol must still exist.
  out = out.replace(
    /import\s*\{[^}]*\}\s*from\s*'node:zlib';?/g,
    'const inflateRawSync = () => { throw new Error("synchronous inflate needs Node; pass inflated members instead"); };',
  );
  // Drop every remaining import (relative ones are satisfied by concatenation).
  out = out.replace(/^\s*import\s[^;]*;?\s*$/gm, '');
  out = out.replace(/^\s*import\s*\{[\s\S]*?\}\s*from\s*'[^']*';?\s*$/gm, '');
  // Re-exports would reference names that now live in the same scope.
  out = out.replace(/^\s*export\s*\{[\s\S]*?\}\s*from\s*'[^']*';?\s*$/gm, '');
  // ...including a bare `export { a, b };` (no `from`), which document.ts uses.
  out = out.replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
  // Everything is exported once, at the end of the bundle.
  out = out.replace(/^export\s+(?=(const|let|function|class|async|type|interface|enum))/gm, '');
  out = out.replace(/^export\s+default\s+/gm, 'const __default = ');
  return `// ---- ${name} ----\n${out.trim()}\n`;
}

const parts: string[] = [];
/** Top-level names already taken by earlier modules. */
const declared = new Set<string>();

for (const [index, name] of MODULES.entries()) {
  const source = readFileSync(join(SRC, name), 'utf8');
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: name });
  let adapted = adapt(name, stripped);

  // Concatenating modules into one scope means two private helpers with the same
  // name collide (document.ts and timeline.ts both define DATE_KEY). Rename the
  // later one inside its own chunk only - private names are never referenced
  // across modules, and `(?<!\.)` leaves property accesses alone.
  const tops = [...adapted.matchAll(/^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((match) => match[1] as string);
  for (const top of new Set(tops)) {
    if (!declared.has(top)) {
      declared.add(top);
      continue;
    }
    if (EXPORTS.includes(top)) {
      console.error(`!! ${name} declares ${top}, which an earlier module already exports`);
      process.exit(1);
    }
    const renamed = `${top}__m${index}`;
    adapted = adapted.replace(new RegExp(`(?<!\\.)\\b${top}\\b`, 'g'), renamed);
    declared.add(renamed);
    console.log(`  renamed private ${name} symbol ${top} -> ${renamed}`);
  }
  parts.push(adapted);
}

const header = `/**
 * EU4 save parser, built for the browser by scripts/build-browser-parser.ts.
 *
 * Do not edit: it is generated from packages/eu4-parser/src/*.ts. The browser
 * cannot inflate synchronously, so pages unpack the zip themselves (see
 * public/parser.js) and call SaveDocument.fromMembers().
 */
`;

const footer = `\nexport { ${EXPORTS.join(', ')} };\n`;
mkdirSync(dirname(OUT), { recursive: true });
const bundle = header + parts.join('\n') + footer;
writeFileSync(OUT, bundle, 'utf8');

console.log(`wrote ${OUT}  ${(bundle.length / 1024).toFixed(0)} KB from ${MODULES.length} modules`);
const missing = EXPORTS.filter((name) => !new RegExp(`\\b${name}\\b`).test(bundle));
if (missing.length) {
  console.error(`!! these exports are not defined anywhere: ${missing.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------- paint.js ---
// The shared painter is an ES module so the render scripts can import it; the page
// needs the same code as a classic script. Stripping `export ` is the whole
// transformation, exactly as scripts/lib/paint-bundle.ts does for the offline page,
// so the hosted viewer and the generated one cannot drift apart.
const PAINT_SRC = 'scripts/lib/paint.js';
const PAINT_OUT = 'apps/site/public/paint.js';
const paint = readFileSync(PAINT_SRC, 'utf8').replace(/^export /gm, '');
const paintBundle = `/**
 * Map painter, built for the browser by scripts/build-browser-parser.ts.
 *
 * Do not edit: it is generated from ${PAINT_SRC}, which the offline player inlines
 * from the very same file.
 */
${paint.trim()}
`;
writeFileSync(PAINT_OUT, paintBundle, 'utf8');
console.log(`wrote ${PAINT_OUT}  ${(paintBundle.length / 1024).toFixed(0)} KB`);
