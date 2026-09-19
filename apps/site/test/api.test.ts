/**
 * API tests for the catalogue.
 *
 * They run the real handlers against the disk storage adapter, which is the same
 * code path the Pages Functions use - the only difference in production is that
 * `Storage` is backed by R2 instead of a temp folder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSave, getSave, listSaves, updateSave, uploadSave, type ApiEnv } from '../src/api.ts';
import { diskStorage } from '../src/storage-disk.ts';

function freshEnv(token?: string): { env: ApiEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'eu4-site-'));
  return {
    env: { storage: diskStorage(root), token, allowAnonymousWrites: !token },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A fake but well-formed upload: the API never parses the bytes. */
const fakeSave = (bytes = 2048): Uint8Array => {
  const body = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) body[i] = i % 251;
  return body;
};
const hex = (fill: string): string => fill.repeat(64 / fill.length);

function uploadRequest(body: Uint8Array, hash: string, name = 'mp_test.eu4', token?: string): Request {
  return new Request('https://example.test/api/saves', {
    method: 'POST',
    body: body as unknown as BodyInit,
    headers: {
      'content-length': String(body.length),
      'x-file-hash': hash,
      'x-file-name': encodeURIComponent(name),
      ...(token ? { 'x-upload-token': token } : {}),
    },
  });
}

const listRequest = (query = ''): Request => new Request(`https://example.test/api/saves${query}`);

/** A PATCH as the catalogue page or the viewer's info panel would send it. */
const patchRequest = (id: string, body: unknown, token?: string): Request =>
  new Request(`https://example.test/api/saves/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: token ? { 'x-upload-token': token } : {},
  });

const singleRequest = (id: string): Request => new Request(`https://example.test/api/saves/${id}`);

interface StoredRecord {
  id: string;
  custom?: {
    title?: string;
    endDate?: string;
    sealedAt?: string;
    mods?: string;
    protagonists?: Array<{ tag: string; player?: string }>;
  };
}

const patchedRecord = async (response: Response): Promise<StoredRecord> =>
  ((await response.json()) as { save: StoredRecord }).save;

const readOne = async (id: string, env: ApiEnv): Promise<StoredRecord> =>
  ((await (await getSave(id, singleRequest(id), env)).json()) as { save: StoredRecord }).save;

const readListed = async (id: string, env: ApiEnv): Promise<StoredRecord> => {
  const body = (await (await listSaves(listRequest(), env)).json()) as { saves: StoredRecord[] };
  const found = body.saves.find((save) => save.id === id);
  assert.ok(found, `save ${id} should be in the listing`);
  return found;
};

/** The ids of a listing, in the order the API returned them. */
const listedIds = async (env: ApiEnv, query = ''): Promise<string[]> => {
  const body = (await (await listSaves(listRequest(query), env)).json()) as { saves: Array<{ id: string }> };
  return body.saves.map((entry) => entry.id);
};

test('starts empty and reports writability', async () => {
  const { env, cleanup } = freshEnv();
  const body = (await (await listSaves(listRequest(), env)).json()) as {
    saves: unknown[];
    storage: { writable: boolean };
  };
  assert.deepEqual(body.saves, []);
  assert.equal(body.storage.writable, true, 'anonymous writes are allowed when no token is set');
  cleanup();
});

test('upload stores the file and lists it with size and status', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('ab');
  const response = await uploadSave(uploadRequest(fakeSave(4096), hash, 'mp_俄罗斯.eu4'), env);
  assert.equal(response.status, 201);
  const created = (await response.json()) as { save: { id: string; name: string; size: number } };
  assert.equal(created.save.id, hash.slice(0, 12));
  assert.equal(created.save.name, 'mp_俄罗斯.eu4', 'the encoded file name round-trips');
  assert.equal(created.save.size, 4096);

  const listed = (await (await listSaves(listRequest(), env)).json()) as {
    saves: Array<{ id: string; status: string }>;
    storage: { bytes: number };
  };
  assert.equal(listed.saves.length, 1);
  assert.equal(listed.saves[0]?.status, 'raw');
  assert.equal(listed.storage.bytes, 4096);
  cleanup();
});

test('the same save cannot be uploaded twice', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('cd');
  assert.equal((await uploadSave(uploadRequest(fakeSave(), hash), env)).status, 201);
  const again = await uploadSave(uploadRequest(fakeSave(), hash), env);
  assert.equal(again.status, 409, 'a duplicate is rejected by content hash');
  cleanup();
});

test('rejects a missing hash and a non-eu4 name', async () => {
  const { env, cleanup } = freshEnv();
  const noHash = new Request('https://example.test/api/saves', { method: 'POST', body: fakeSave() as unknown as BodyInit });
  assert.equal((await uploadSave(noHash, env)).status, 400);
  const wrongName = uploadRequest(fakeSave(), hex('ef'), 'notes.txt');
  assert.equal((await uploadSave(wrongName, env)).status, 400);
  cleanup();
});

test('a configured token gates writes but not reads', async () => {
  const { env, cleanup } = freshEnv('secret-token');
  const anonymous = await uploadSave(uploadRequest(fakeSave(), hex('11')), env);
  assert.equal(anonymous.status, 401);

  const authorised = new Request('https://example.test/api/saves', {
    method: 'POST',
    body: fakeSave() as unknown as BodyInit,
    headers: {
      'content-length': '2048',
      'x-file-hash': hex('22'),
      'x-file-name': 'ok.eu4',
      'x-upload-token': 'secret-token',
    },
  });
  assert.equal((await uploadSave(authorised, env)).status, 201);
  assert.equal((await listSaves(listRequest(), env)).status, 200, 'listing stays public');
  assert.equal((await listSaves(listRequest(), env)).json !== undefined, true);
  cleanup();
});

test('delete removes the record and every stored object', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('33');
  await uploadSave(uploadRequest(fakeSave(), hash), env);
  const id = hash.slice(0, 12);
  const response = await deleteSave(id, new Request('https://example.test', { method: 'DELETE' }), env);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { removed: number };
  assert.ok(body.removed >= 2, 'both original.eu4 and meta.json are cleaned up');
  const listed = (await (await listSaves(listRequest(), env)).json()) as { saves: unknown[] };
  assert.deepEqual(listed.saves, []);
  assert.equal((await env.storage.list(`saves/${id}/`)).length, 0);
  cleanup();
});

test('deleting something that is not there is a 404', async () => {
  const { env, cleanup } = freshEnv();
  const response = await deleteSave('deadbeef1234', new Request('https://example.test', { method: 'DELETE' }), env);
  assert.equal(response.status, 404);
  cleanup();
});

test('sorting by size, name and upload time both ways', async () => {
  const { env, cleanup } = freshEnv();
  await uploadSave(uploadRequest(fakeSave(1000), hex('aa'), 'b.eu4'), env);
  await uploadSave(uploadRequest(fakeSave(3000), hex('bb'), 'a.eu4'), env);
  await uploadSave(uploadRequest(fakeSave(2000), hex('cc'), 'c.eu4'), env);

  const sizes = async (dir: string): Promise<number[]> => {
    const body = (await (await listSaves(listRequest(`?sort=size&dir=${dir}`), env)).json()) as {
      saves: Array<{ size: number }>;
    };
    return body.saves.map((s) => s.size);
  };
  assert.deepEqual(await sizes('asc'), [1000, 2000, 3000]);
  assert.deepEqual(await sizes('desc'), [3000, 2000, 1000]);

  const names = (await (await listSaves(listRequest('?sort=name&dir=asc'), env)).json()) as {
    saves: Array<{ name: string }>;
  };
  assert.deepEqual(
    names.saves.map((s) => s.name),
    ['a.eu4', 'b.eu4', 'c.eu4'],
  );
  cleanup();
});

test('sorting by 结档日期 and 封档日期, fallbacks included', async () => {
  const { env, cleanup } = freshEnv();
  const ids: string[] = [];
  for (const fill of ['81', '82', '83']) {
    const hash = hex(fill);
    await uploadSave(uploadRequest(fakeSave(), hash), env);
    ids.push(hash.slice(0, 12));
  }
  const [a, b, c] = ids as [string, string, string];

  // `a` only has the parsed campaign date, `b` has a custom end date, `c` has neither.
  await updateSave(a, patchRequest(a, { info: { campaignDate: '1500.01.01' } }), env);
  await updateSave(b, patchRequest(b, { custom: { endDate: '1700.01.01' } }), env);

  const order = async (query: string): Promise<string[]> => {
    const body = (await (await listSaves(listRequest(query), env)).json()) as { saves: Array<{ id: string }> };
    return body.saves.map((entry) => entry.id);
  };

  // The custom date wins over the parsed one, and a record with neither sorts first
  // (its value is the empty string).
  assert.deepEqual(await order('?sort=endDate&dir=asc'), [c, a, b]);
  assert.deepEqual(await order('?sort=endDate&dir=desc'), [b, a, c], 'descending is the mirror image');
  // `date` is what an older browser still has in localStorage: same ordering, same meaning.
  assert.deepEqual(await order('?sort=date&dir=asc'), [c, a, b], 'the legacy sort key keeps working');
  assert.deepEqual(
    await order('?sort=date&dir=asc'),
    await order('?sort=endDate&dir=asc'),
    'the two keys are one sort, not two',
  );

  // 封档日期 falls back to the upload time, which for these three is "now" — far later
  // than the two dates written here, so the unset record sorts last in ascending order.
  await updateSave(a, patchRequest(a, { custom: { sealedAt: '1999-12-31' } }), env);
  await updateSave(b, patchRequest(b, { custom: { sealedAt: '2000-01-01' } }), env);
  assert.deepEqual(await order('?sort=sealedAt&dir=asc'), [a, b, c], 'an unset 封档日期 falls back to uploadedAt');
  assert.deepEqual(await order('?sort=sealedAt&dir=desc'), [c, b, a]);
  cleanup();
});

test('封档日期 compares the day, so a hand-set date and an ISO upload time tie', async () => {
  // The bug this pins down: the card prints `custom.sealedAt || uploadedAt`'s day, but
  // the sort compared the two values raw — `2026-09-18` and `2026-09-18T02:12:47.820Z`
  // are one day to the reader and two different strings to `<`, and a day typed without
  // leading zeroes (`2026-9-8`) sorted *after* `2026-09-18` because "9" > "0".
  // Chosen upload times can only come from the index (an upload uses the clock), so the
  // records are written straight into storage.
  const { env, cleanup } = freshEnv();
  const row = (id: string, uploadedAt: string, sealedAt?: string) => ({
    id,
    name: `${id}.eu4`,
    hash: id.padEnd(64, '0'),
    size: 1024,
    uploadedAt,
    status: 'parsed',
    ...(sealedAt ? { custom: { sealedAt } } : {}),
  });
  await env.storage.put(
    'index.json',
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        saves: [
          row('aaa', '2026-09-18T04:41:33.051Z', '2026-09-18'),
          row('bbb', '2026-09-18T02:12:47.820Z'),
          row('ccc', '2026-09-17T09:00:00.000Z', '2026-9-8'),
        ],
      }),
    ),
  );

  // `aaa` and `bbb` print the same day, so they tie and keep the index order in both
  // directions; `ccc` means 8 September and must come first / last accordingly.
  assert.deepEqual(await listedIds(env, '?sort=sealedAt&dir=asc'), ['ccc', 'aaa', 'bbb']);
  assert.deepEqual(await listedIds(env, '?sort=sealedAt&dir=desc'), ['aaa', 'bbb', 'ccc']);
  cleanup();
});

test('结档日期 compares game dates as dates, not as strings', async () => {
  // The parser keeps the game's own, non zero-padded formatting, so "971.1.2" sorted
  // after "1574.11.12" as a string — the 10th century came out last.
  const { env, cleanup } = freshEnv();
  const row = (id: string, campaignDate?: string) => ({
    id,
    name: `${id}.eu4`,
    hash: id.padEnd(64, '0'),
    size: 1024,
    uploadedAt: '2026-09-18T04:41:33.051Z',
    status: 'parsed',
    ...(campaignDate ? { info: { campaignDate } } : {}),
  });
  await env.storage.put(
    'index.json',
    new TextEncoder().encode(
      JSON.stringify({ version: 1, saves: [row('eee', '1574.11.12'), row('ddd', '971.1.2'), row('fff')] }),
    ),
  );

  // No date at all sorts first ascending, exactly as before.
  assert.deepEqual(await listedIds(env, '?sort=endDate&dir=asc'), ['fff', 'ddd', 'eee']);
  assert.deepEqual(await listedIds(env, '?sort=endDate&dir=desc'), ['eee', 'ddd', 'fff']);
  cleanup();
});

test('sealedAt is stored like endDate: trimmed, capped at 20 characters, empty clears it', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('84');
  await uploadSave(uploadRequest(fakeSave(), hash), env);
  const id = hash.slice(0, 12);

  const response = await updateSave(id, patchRequest(id, { custom: { sealedAt: '  2026-09-18 23:30  ' } }), env);
  assert.equal(response.status, 200);
  assert.equal((await readOne(id, env)).custom?.sealedAt, '2026-09-18 23:30', 'the value is trimmed');

  await updateSave(id, patchRequest(id, { custom: { sealedAt: 'x'.repeat(30) } }), env);
  assert.equal((await readOne(id, env)).custom?.sealedAt, 'x'.repeat(20), 'long input is truncated, not rejected');

  // It merges like its neighbours: patching one field must not drop the other two.
  await updateSave(id, patchRequest(id, { custom: { title: '大汉', endDate: '1574.11.12' } }), env);
  const merged = (await readOne(id, env)).custom;
  assert.equal(merged?.sealedAt, 'x'.repeat(20), 'a patch that does not mention sealedAt leaves it alone');
  assert.equal(merged?.endDate, '1574.11.12');

  await updateSave(id, patchRequest(id, { custom: { sealedAt: '   ' } }), env);
  const cleared = (await readOne(id, env)).custom;
  assert.equal(cleared?.sealedAt, undefined, 'an empty string deletes the field');
  assert.equal(cleared?.title, '大汉', 'and leaves the rest of the block alone');
  cleanup();
});

test('the parsed info shown on a card can be filled in later', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('44');
  await uploadSave(uploadRequest(fakeSave(), hash), env);
  const id = hash.slice(0, 12);
  const response = await updateSave(
    id,
    new Request('https://example.test', {
      method: 'PATCH',
      body: JSON.stringify({ info: { campaignDate: '1574.11.12', player: '俄罗斯', version: '1.37.5.0', mods: ['a', 'b'] } }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const listed = (await (await listSaves(listRequest('?sort=date'), env)).json()) as {
    saves: Array<{ status: string; info?: { campaignDate?: string; mods?: string[] } }>;
  };
  assert.equal(listed.saves[0]?.status, 'parsed');
  assert.equal(listed.saves[0]?.info?.campaignDate, '1574.11.12');
  assert.equal(listed.saves[0]?.info?.mods?.length, 2);
  cleanup();
});

test('a custom title is stored, trimmed and readable from both reads', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('66');
  await uploadSave(uploadRequest(fakeSave(), hash), env);
  const id = hash.slice(0, 12);

  const response = await updateSave(id, patchRequest(id, { custom: { title: '  大汉 · 我的第一次统一  ' } }), env);
  assert.equal(response.status, 200);

  assert.equal((await readOne(id, env)).custom?.title, '大汉 · 我的第一次统一', 'GET /api/saves/:id reads it');
  assert.equal((await readListed(id, env)).custom?.title, '大汉 · 我的第一次统一', 'the listing reads it too');

  const missing = await getSave('deadbeef1234', singleRequest('deadbeef1234'), env);
  assert.equal(missing.status, 404, 'an unknown id is a 404');
  cleanup();
});

test('patching one custom field leaves the others alone', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('67');
  await uploadSave(uploadRequest(fakeSave(), hash), env);
  const id = hash.slice(0, 12);
  await updateSave(
    id,
    patchRequest(id, { custom: { title: '大汉', mods: '风云世纪 + 汉化', endDate: '1574.11.12' } }),
    env,
  );

  const patched = await updateSave(id, patchRequest(id, { custom: { endDate: '1600.01.01' } }), env);
  const body = await patchedRecord(patched);
  assert.equal(body.custom?.endDate, '1600.01.01');
  assert.equal(body.custom?.title, '大汉', 'a deep merge keeps the fields the patch does not mention');
  assert.equal(body.custom?.mods, '风云世纪 + 汉化');
  cleanup();
});

test('protagonists are normalised, deduped, capped and kept in order', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('68');
  await uploadSave(uploadRequest(fakeSave(), hash), env);
  const id = hash.slice(0, 12);

  const messy = [
    { tag: ' mng ', player: '  张三  ' },
    { tag: 'm!n@g', player: '同一个国家' },
    { tag: 'a', player: '标签太短' },
    { tag: 'abcdextra', player: '四' },
    { tag: 'SWE' },
    'MNG',
    null,
  ];
  await updateSave(id, patchRequest(id, { custom: { protagonists: messy } }), env);
  assert.deepEqual((await readOne(id, env)).custom?.protagonists, [
    { tag: 'MNG', player: '张三' },
    { tag: 'ABCD', player: '四' },
    { tag: 'SWE' },
  ]);

  const many = Array.from({ length: 25 }, (_, index) => ({ tag: `t${String(index).padStart(2, '0')}` }));
  await updateSave(id, patchRequest(id, { custom: { protagonists: many } }), env);
  const capped = (await readOne(id, env)).custom?.protagonists ?? [];
  assert.equal(capped.length, 20, 'at most 20 protagonists are stored');
  assert.equal(capped[0]?.tag, 'T00');
  assert.equal(capped[19]?.tag, 'T19', 'the order is the display order, capped at the tail');
  cleanup();
});

test('an empty string or empty array clears that custom field', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('69');
  await uploadSave(uploadRequest(fakeSave(), hash), env);
  const id = hash.slice(0, 12);
  await updateSave(
    id,
    patchRequest(id, {
      custom: { title: '大汉', mods: '风云世纪', endDate: '1574.11.12', protagonists: [{ tag: 'MNG' }] },
    }),
    env,
  );

  await updateSave(id, patchRequest(id, { custom: { title: '' } }), env);
  const afterTitle = await readOne(id, env);
  assert.equal(afterTitle.custom?.title, undefined, 'an empty title means "use the file name"');
  assert.equal(afterTitle.custom?.mods, '风云世纪', 'the untouched fields survive');

  await updateSave(
    id,
    patchRequest(id, { custom: { title: '', endDate: '   ', mods: '', protagonists: [] } }),
    env,
  );
  assert.deepEqual((await readOne(id, env)).custom ?? {}, {}, 'clearing every field leaves no custom keys');
  cleanup();
});

test('sending custom: null resets the whole block', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('70');
  await uploadSave(uploadRequest(fakeSave(), hash), env);
  const id = hash.slice(0, 12);
  await updateSave(id, patchRequest(id, { custom: { title: '大汉', protagonists: [{ tag: 'MNG', player: '张三' }] } }), env);

  const response = await updateSave(id, patchRequest(id, { custom: null }), env);
  const body = await patchedRecord(response);
  assert.equal(body.custom, undefined, 'the response carries no custom block');
  assert.deepEqual((await readOne(id, env)).custom, undefined);
  assert.deepEqual((await readListed(id, env)).custom, undefined);
  cleanup();
});

test('a custom patch needs the token, while reading one record stays public', async () => {
  const { env, cleanup } = freshEnv('secret-token');
  const hash = hex('71');
  await uploadSave(uploadRequest(fakeSave(), hash, 'tok.eu4', 'secret-token'), env);
  const id = hash.slice(0, 12);

  const denied = await updateSave(id, patchRequest(id, { custom: { title: '匿名' } }), env);
  assert.equal(denied.status, 401);

  const allowed = await updateSave(id, patchRequest(id, { custom: { title: '正常' } }, 'secret-token'), env);
  assert.equal(allowed.status, 200);

  // A PATCH that says nothing about `custom` must leave it alone (existing info flow).
  const info = await updateSave(
    id,
    patchRequest(id, { info: { campaignDate: '1574.11.12', version: '1.37.5.0' } }, 'secret-token'),
    env,
  );
  const body = (await info.json()) as { save: { status: string; custom?: StoredRecord['custom'] } };
  assert.equal(info.status, 200);
  assert.equal(body.save.status, 'parsed', 'filling in info still moves the record forward');
  assert.equal(body.save.custom?.title, '正常', 'custom survives an info-only PATCH');

  const read = await getSave(id, singleRequest(id), env);
  assert.equal(read.status, 200, 'reading one record needs no token');
  cleanup();
});

test('the index self-heals from the per-save metadata', async () => {
  const { env, cleanup } = freshEnv();
  const hash = hex('55');
  await uploadSave(uploadRequest(fakeSave(), hash, 'x.eu4'), env);
  await updateSave(hash.slice(0, 12), patchRequest(hash.slice(0, 12), { custom: { title: '大汉' } }), env);
  // Simulate a lost or corrupt index: the records live in saves/<id>/meta.json.
  await env.storage.delete('index.json');
  await env.storage.put('index.json', new TextEncoder().encode('{ not json'));
  const listed = (await (await listSaves(listRequest(), env)).json()) as {
    saves: Array<{ name: string; custom?: { title?: string } }>;
  };
  assert.equal(listed.saves.length, 1, 'the listing is rebuilt from meta.json');
  assert.equal(listed.saves[0]?.name, 'x.eu4');
  assert.equal(listed.saves[0]?.custom?.title, '大汉', 'the rebuild carries custom with it');
  cleanup();
});
