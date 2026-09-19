/**
 * End-to-end check of the viewer pipeline against a running dev server:
 *
 *   node apps/site/src/dev-server.ts &
 *   node apps/site/test/viewer-flow.ts
 *
 * upload -> build the viewer locally -> the site serves it -> the catalogue shows
 * a viewer URL -> everything referenced by the viewer page resolves.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE = process.env.SITE_URL ?? 'http://127.0.0.1:8788';
/**
 * Must match the server's --root, or the build writes into one store while the server
 * reads another: the record then never gains a viewer, and worse, a throwaway run can
 * overwrite the real catalogue's pages (that happened once).
 */
const ROOT = process.env.SITE_ROOT ?? '.dev-storage';
const SAVE = process.argv[2] ?? '存档示例/mp_俄罗斯1574_11_12.eu4';

const bytes = readFileSync(SAVE);
const hash = createHash('sha256').update(bytes).digest('hex');
const id = hash.slice(0, 12);

const upload = await fetch(`${BASE}/api/saves`, {
  method: 'POST',
  headers: { 'x-file-hash': hash, 'x-file-name': encodeURIComponent(SAVE.split('/').pop() ?? 'save.eu4') },
  body: bytes,
});
console.log(`upload -> ${upload.status}${upload.status === 409 ? ' (already present, reusing)' : ''}`);

console.log(`building viewer (local renderer, needs the game files) into ${ROOT}...`);
const built = execFileSync(
  process.execPath,
  ['apps/site/src/build-viewer.ts', id, '--save', SAVE, '--root', ROOT],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
for (const line of built.split('\n').filter(Boolean)) console.log(`  ${line}`);

const list = (await (await fetch(`${BASE}/api/saves`)).json()) as {
  saves: Array<{ id: string; status: string; viewer?: string }>;
};
const record = list.saves.find((save) => save.id === id);
console.log(`record -> status=${record?.status} viewer=${record?.viewer}`);

const viewer = await fetch(`${BASE}${record?.viewer}`);
const html = await viewer.text();
console.log(`viewer page -> ${viewer.status} ${(html.length / 1024 / 1024).toFixed(2)} MB`);
if (viewer.status !== 200 || html.length < 100_000) {
  console.log(`\nFAILED: the viewer page is not being served (status ${viewer.status}, ${html.length} bytes)`);
  process.exit(1);
}

// Everything the viewer references must resolve **against the page's own URL**, not
// against the site root. The earlier version of this check pulled `../../assets/...`
// out of the markup and fetched `/assets/...` — which is a different URL, and it hid
// a real bug for as long as it existed: the generated page lives at
// /saves/<id>/viewer/index.html (three levels), so `../../` lands on /saves/ and
// every flag and wallpaper 404'd on the page while this test stayed green.
const pageUrl = new URL(record?.viewer ?? '/', BASE);
const references = new Set<string>();
for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:png|jpe?g|webp|avif))"/g)) {
  references.add(match[1] as string);
}
// Wallpapers arrive as a JS array, not as markup.
for (const match of html.matchAll(/"([^"]*背景图\/[^"]+)"/g)) references.add(match[1] as string);

const resolved = [...references]
  .map((reference) => ({ reference, url: new URL(reference, pageUrl).href }))
  .sort((a, b) => a.url.localeCompare(b.url));
console.log(`viewer references ${resolved.length} image URL(s); checking all of them:`);
let failures = 0;
for (const { reference, url } of resolved) {
  const response = await fetch(url);
  if (response.status !== 200) failures += 1;
  console.log(`  ${response.status} ${reference} -> ${url.replace(BASE, '')}`);
  if (response.status !== 200 && failures <= 3) console.log(`        (resolved from ${pageUrl.pathname})`);
}

const viewerAssets = [...html.matchAll(/src="(\.\.\/[^"]+)"/g)].length;
console.log(`inline <img> sources in the viewer: ${viewerAssets}`);

// Flags never appear as markup: the client assigns `img.src` for every `data-tag` it
// finds, falling back to the colonial composite when the first one 404s. Build the
// URLs the same way, or a broken flag prefix stays invisible to this test — which is
// exactly how the /saves/assets/... bug survived.
const prefix = /const VIEWER_ASSETS = \{ flags: '([^']+)' \};/.exec(html)?.[1] ?? '/assets/flags/';
// The leaderboard markup travels inside a JSON string, so its quotes are escaped.
const tags = [
  ...new Set([...html.matchAll(/data-tag=\\?"([A-Za-z0-9_]+)\\?"/g)].map((match) => match[1] as string)),
];
const sets = ['base', 'modded', 'colonial', 'colonial-modded'];
console.log(`flag prefix ${prefix}; ${tags.length} tag(s) drawn as a flag: ${tags.join(' ')}`);
let flagFailures = 0;
for (const tag of tags) {
  const tried: string[] = [];
  let found = false;
  for (const set of sets) {
    const response = await fetch(`${BASE}${prefix}${set}/${tag}.png`);
    tried.push(`${set}=${response.status}`);
    if (response.status === 200) {
      found = true;
      break;
    }
  }
  if (!found) flagFailures += 1;
  console.log(`  ${found ? 'ok  ' : 'FAIL'} ${tag}: ${tried.join(' ')}`);
}
if (flagFailures) failures += flagFailures;

if (failures) {
  console.log(`\nFAILED: ${failures} referenced asset(s) missing (the page is at ${pageUrl.pathname})`);
  process.exit(1);
}
console.log('\nviewer pipeline works: upload -> build -> serve -> every wallpaper and flag resolves');
