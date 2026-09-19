/**
 * End-to-end smoke test against a running dev server.
 *
 *   node apps/site/src/dev-server.ts &
 *   node apps/site/test/smoke.ts
 *
 * It uploads the real sample save (25 MB or so), lists the catalogue, and
 * deletes it again - the parts the unit tests cannot cover because they call the
 * handlers directly instead of going over HTTP.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const BASE = process.env.SITE_URL ?? 'http://127.0.0.1:8788';
const SAVE = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '存档示例/mp_俄罗斯1574_11_12.eu4';

const bytes = readFileSync(SAVE);
const hash = createHash('sha256').update(bytes).digest('hex');
console.log(`save: ${SAVE} (${(statSync(SAVE).size / 1024 / 1024).toFixed(1)} MB, sha256 ${hash.slice(0, 12)})`);

const upload = await fetch(`${BASE}/api/saves`, {
  method: 'POST',
  headers: {
    'content-type': 'application/octet-stream',
    'x-file-hash': hash,
    'x-file-name': encodeURIComponent(SAVE.split('/').pop() ?? 'save.eu4'),
  },
  body: bytes,
});
const created = (await upload.json()) as { save?: { id: string; size: number }; error?: string };
let saveId = created.save?.id;
if (created.save) {
  console.log(`upload -> ${upload.status} id=${created.save.id} size=${created.save.size}`);
} else if (upload.status === 409) {
  // Already catalogued: reuse the existing record so the rest of the flow runs.
  const current = (await (await fetch(`${BASE}/api/saves`)).json()) as { saves: Array<{ id: string; name: string }> };
  const existing = current.saves.find((save) => save.name === (SAVE.split('/').pop() ?? ''));
  console.log(`upload -> 409 (already present${existing ? `, id=${existing.id}` : ''})`);
  saveId = existing?.id;
} else {
  console.log(`upload -> ${upload.status} ${created.error ?? ''}`);
}
if (!saveId) process.exit(1);

// The browser fills this in after uploading; here we run the very same modules.
const { readSaveInfo, readMembers } = (await import('../public/parser.js')) as {
  readSaveInfo: (input: Uint8Array) => Promise<Record<string, unknown>>;
  readMembers: (input: Uint8Array) => Promise<{ meta: Uint8Array; gamestate: Uint8Array }>;
};
const { SaveDocument, extractWars } = (await import('../public/eu4-parser.js')) as {
  SaveDocument: { fromMembers: (members: unknown) => { provinces(): Map<number, unknown>; countries(): Map<string, unknown> } };
  extractWars: (doc: unknown) => unknown[];
};
const started = Date.now();
const info = await readSaveInfo(new Uint8Array(bytes));
delete info.members;
console.log(`parse meta in browser module -> ${Date.now() - started} ms`, JSON.stringify({
  date: info.campaignDate,
  player: info.player,
  version: info.version,
  dlc: info.dlcCount,
  mods: Array.isArray(info.mods) ? info.mods.length : 0,
}));

// Full parse, exactly what the page does: unpack with DecompressionStream, then
// hand the inflated members to the bundled parser.
const fullStart = Date.now();
const doc = SaveDocument.fromMembers(await readMembers(new Uint8Array(bytes)));
info.parseMs = Date.now() - fullStart;
info.provinces = doc.provinces().size;
info.countries = doc.countries().size;
info.wars = extractWars(doc).length;
console.log(
  `full parse in browser module -> ${info.parseMs} ms  ` +
  `${info.provinces} provinces / ${info.countries} countries / ${info.wars} wars`,
);
const patched = await fetch(`${BASE}/api/saves/${saveId}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ info }),
});
console.log(`patch -> ${patched.status}`);

const list = (await (await fetch(`${BASE}/api/saves?sort=size&dir=desc`)).json()) as {
  saves: Array<{ id: string; name: string; size: number; status: string }>;
  storage: { bytes: number; writable: boolean };
};
console.log(`list -> ${list.saves.length} save(s), ${(list.storage.bytes / 1024 / 1024).toFixed(1)} MB, writable=${list.storage.writable}`);
for (const save of list.saves) console.log(`  ${save.id}  ${save.name}  ${save.status}  ${save.size}`);

const duplicate = await fetch(`${BASE}/api/saves`, {
  method: 'POST',
  headers: { 'x-file-hash': hash, 'x-file-name': 'again.eu4' },
  body: bytes,
});
console.log(`duplicate upload -> ${duplicate.status} (expected 409)`);

// `--keep` leaves the save in the catalogue, which is handy for seeding a local
// instance with a real example; the default cleans up after itself.
if (process.argv.includes('--keep')) {
  console.log('--keep: leaving the save and its artifacts in the catalogue');
} else {
  const removed = await fetch(`${BASE}/api/saves/${saveId}`, { method: 'DELETE' });
  console.log(`delete -> ${removed.status}`, await removed.text());
  const after = (await (await fetch(`${BASE}/api/saves`)).json()) as { saves: unknown[] };
  console.log(`after delete -> ${after.saves.length} save(s)`);
}
