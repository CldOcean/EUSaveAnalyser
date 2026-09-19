/**
 * Save-catalogue API, written against the web fetch API only.
 *
 * The same handlers run in two places:
 *   * Cloudflare Pages Functions (`functions/api/*`), backed by R2
 *   * the local dev server (`src/dev-server.ts`), backed by a folder on disk
 *
 * That is the whole point of this file: the deployment target cannot be tested
 * without a Cloudflare account, so the logic lives here and both storage
 * backends are swappable. Nothing in here may use Node built-ins.
 */

/** One protagonist country: user-defined, shown on the catalogue card. */
export interface Protagonist {
  /** Country tag. Normalised to upper case, `[A-Z0-9]` only, 2-4 characters. */
  tag: string;
  /** Player name; omitted when empty. */
  player?: string;
}

/** User-defined card information; every field is optional and defaults to the parsed value. */
export interface SaveCustom {
  /** Custom title. Empty = fall back to the original file name (`name`). */
  title?: string;
  /** Custom campaign end date, free text (e.g. `1574.11.12`). Empty = use `info.campaignDate`. */
  endDate?: string;
  /**
   * Custom "sealed" date: when the player stopped playing, in real time rather than
   * in game time. Free text (e.g. `2026-09-18`). Empty = fall back to the upload date.
   */
  sealedAt?: string;
  /** Custom mod description, one string. Empty = use the count of `info.mods`. */
  mods?: string;
  /** Protagonist countries in display order; the card shows at most the first three. */
  protagonists?: Protagonist[];
}

/** One entry in the catalogue index. */
export interface SaveRecord {
  /** sha256 of the file bytes, first 12 hex chars. */
  id: string;
  /** Original file name as uploaded. */
  name: string;
  /** Bytes. */
  size: number;
  /** ISO timestamp of the upload. */
  uploadedAt: string;
  /** sha256 hex, full length. */
  hash: string;
  /**
   * `raw`    - stored, nothing parsed yet
   * `parsed` - metadata filled in (campaign date, player, version, ...)
   * `ready`  - a viewer build exists
   */
  status: 'raw' | 'parsed' | 'ready';
  /** Filled in once a parser has run (locally or in the browser). */
  info?: SaveInfo;
  /** User-defined card information. Older records have no such field and are read as `{}`. */
  custom?: SaveCustom;
  /** Relative URL of the generated viewer, when status is `ready`. */
  viewer?: string;
  /**
   * True when `saves/<id>/viewer/data.json` exists.
   *
   * The viewer page is one shared file, so there is nothing per-save to point at — but
   * the card still wants to know whether opening it will be instant or a rebuild.
   */
  viewerData?: boolean;
}

/** What a parsed save contributes to the catalogue. */
export interface SaveInfo {
  campaignDate?: string;
  player?: string;
  playerTag?: string;
  version?: string;
  dlcCount?: number;
  mods?: string[];
  /** Filled in by the browser's full parse (public/eu4-parser.js). */
  provinces?: number;
  countries?: number;
  wars?: number;
  /** Milliseconds the browser spent parsing, for the record. */
  parseMs?: number;
}

export interface Storage {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array | ReadableStream): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface ApiEnv {
  storage: Storage;
  /** When set, write requests must carry this value in `x-upload-token`. */
  token?: string;
  /** Local dev allows writes without a token; production must not. */
  allowAnonymousWrites?: boolean;
}

const INDEX_KEY = 'index.json';
const MAX_BYTES = 100 * 1024 * 1024; // Workers cap the request body around here

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function readIndex(env: ApiEnv): Promise<SaveRecord[]> {
  const raw = await env.storage.get(INDEX_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(textDecoder.decode(raw)) as { saves?: SaveRecord[] };
      if (Array.isArray(parsed.saves)) return parsed.saves;
    } catch {
      // A corrupt index is rebuilt from the per-save metadata below.
    }
  }
  return rebuildIndex(env);
}

/** Fallback: the per-save `meta.json` files are the real source of truth. */
async function rebuildIndex(env: ApiEnv): Promise<SaveRecord[]> {
  const keys = await env.storage.list('saves/');
  const saves: SaveRecord[] = [];
  for (const key of keys) {
    if (!key.endsWith('/meta.json')) continue;
    const raw = await env.storage.get(key);
    if (!raw) continue;
    try {
      saves.push(JSON.parse(textDecoder.decode(raw)) as SaveRecord);
    } catch {
      // Skip anything unreadable rather than failing the whole listing.
    }
  }
  saves.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  await env.storage.put(INDEX_KEY, textEncoder.encode(JSON.stringify({ version: 1, saves })));
  return saves;
}

export async function writeIndex(env: ApiEnv, saves: SaveRecord[]): Promise<void> {
  await env.storage.put(INDEX_KEY, textEncoder.encode(JSON.stringify({ version: 1, saves })));
}

function authorised(request: Request, env: ApiEnv): boolean {
  const token = env.token;
  if (!token) return env.allowAnonymousWrites === true;
  return request.headers.get('x-upload-token') === token;
}

/**
 * The day of a real-world date, as a comparable `YYYY-MM-DD` string.
 *
 * `custom.sealedAt` is free text while `uploadedAt` is an ISO timestamp, and comparing
 * the two raw strings gets the order wrong: `2026-09-18` and `2026-09-18T04:41:33Z` are
 * the same day to the reader but not to `<`, and a date typed without leading zeroes
 * (`2026-9-8`) sorts *after* `2026-09-18` because `9` > `0`. A value that carries a time
 * of day would also sort as if it were set at midnight. So both the custom value and the
 * fallback are reduced to the day here, with the same rule the catalogue card prints
 * (`app.js`'s `sealedDay`) — display and order must never disagree about the day.
 *
 * Anything that does not start with a `Y-M-D` date is passed through unchanged, so a
 * hand-written note is neither reordered nor thrown away.
 */
const dayKey = (value: string | undefined): string => {
  const text = String(value ?? '').trim();
  const [, year = '', month = '', day = ''] = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text) ?? [];
  if (!year) return text;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
};

/**
 * Sortable form of a game date: `971.1.2` -> `0971.01.02`.
 *
 * The parser keeps the game's own formatting, which is not zero-padded, so string order
 * would otherwise put the year 971 *after* 1574. A value that is not a `Y.M.D` date is
 * passed through unchanged.
 */
const gameDayKey = (value: string): string => {
  const text = value.trim();
  const [, year = '', month = '', day = ''] = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/.exec(text) ?? [];
  if (!year) return text;
  return `${year.padStart(4, '0')}.${month.padStart(2, '0')}.${day.padStart(2, '0')}`;
};

function sortSaves(saves: SaveRecord[], url: URL): SaveRecord[] {
  const key = url.searchParams.get('sort') ?? 'uploadedAt';
  const dir = url.searchParams.get('dir') === 'asc' ? 1 : -1;
  const value = (record: SaveRecord): string | number => {
    switch (key) {
      case 'name':
        return record.name.toLowerCase();
      case 'size':
        return record.size;
      // `date` is the legacy spelling of the same thing (it is what an older
      // `localStorage['catalogue.sort']` still holds), so both keys sort identically.
      case 'date':
      case 'endDate':
        return gameDayKey(record.custom?.endDate || record.info?.campaignDate || '');
      case 'sealedAt':
        // Custom value first, otherwise the upload date — the same pair the card shows,
        // both reduced to a day so a set and an unset record on one day compare equal.
        return dayKey(record.custom?.sealedAt) || dayKey(record.uploadedAt);
      case 'player':
        return (record.info?.player ?? '').toLowerCase();
      default:
        return record.uploadedAt;
    }
  };
  return [...saves].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === bv) return 0;
    return (av > bv ? 1 : -1) * dir;
  });
}

/** GET /api/saves - the catalogue listing. */
export async function listSaves(request: Request, env: ApiEnv): Promise<Response> {
  const saves = await readIndex(env);
  const url = new URL(request.url);
  const sorted = sortSaves(saves, url);
  const bytes = sorted.reduce((sum, record) => sum + record.size, 0);
  return json({
    saves: sorted,
    storage: { saves: sorted.length, bytes, writable: authorised(request, env) || !!env.token },
  });
}

/** POST /api/saves - store one uploaded save. The body is the raw file. */
export async function uploadSave(request: Request, env: ApiEnv): Promise<Response> {
  if (!authorised(request, env)) {
    return json({ error: '上传未授权：请在设置里填入上传口令（服务端环境变量 UPLOAD_TOKEN）' }, 401);
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) {
    return json({ error: `文件太大（${(declared / 1024 / 1024).toFixed(1)} MB），上限 100 MB` }, 413);
  }
  const hash = (request.headers.get('x-file-hash') ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return json({ error: '缺少 x-file-hash 头（浏览器端计算的 sha256）' }, 400);
  }
  const id = hash.slice(0, 12);
  const name = decodeURIComponent(request.headers.get('x-file-name') ?? 'save.eu4');
  if (!name.toLowerCase().endsWith('.eu4')) {
    return json({ error: '只接受 .eu4 存档文件' }, 400);
  }
  if (!request.body) return json({ error: '空请求体' }, 400);

  const saves = await readIndex(env);
  const existing = saves.find((record) => record.id === id);
  if (existing) return json({ error: '这份存档已经在目录里了', save: existing }, 409);

  await env.storage.put(`saves/${id}/original.eu4`, request.body);
  const record: SaveRecord = {
    id,
    name,
    hash,
    size: declared,
    uploadedAt: new Date().toISOString(),
    status: 'raw',
  };
  await env.storage.put(`saves/${id}/meta.json`, textEncoder.encode(JSON.stringify(record)));
  saves.unshift(record);
  await writeIndex(env, saves);
  return json({ save: record }, 201);
}

/** DELETE /api/saves/:id - remove a save and everything generated from it. */
export async function deleteSave(id: string, request: Request, env: ApiEnv): Promise<Response> {
  if (!authorised(request, env)) {
    return json({ error: '删除未授权：请在设置里填入上传口令' }, 401);
  }
  const saves = await readIndex(env);
  if (!saves.some((record) => record.id === id)) return json({ error: '没有这份存档' }, 404);
  const keys = await env.storage.list(`saves/${id}/`);
  for (const key of keys) await env.storage.delete(key);
  await writeIndex(
    env,
    saves.filter((record) => record.id !== id),
  );
  return json({ ok: true, removed: keys.length });
}

/**
 * PUT /api/saves/:id/artifact?path=viewer/index.html - store one generated file.
 *
 * The timeline viewer is built locally (it needs the game's map and localisation
 * files), so this is how the build output reaches storage in production. The path
 * is validated so an artifact can never escape its own save folder.
 */
export async function putArtifact(
  id: string,
  request: Request,
  env: ApiEnv,
  url: URL,
): Promise<Response> {
  if (!authorised(request, env)) return json({ error: '上传产物未授权' }, 401);
  const saves = await readIndex(env);
  const record = saves.find((entry) => entry.id === id);
  if (!record) return json({ error: '没有这份存档' }, 404);
  const relative = url.searchParams.get('path') ?? '';
  if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.includes('..')) {
    return json({ error: '产物路径不合法' }, 400);
  }
  if (!request.body) return json({ error: '空请求体' }, 400);
  await env.storage.put(`saves/${id}/${relative}`, request.body);

  let updated = record;
  if (relative.endsWith('.html')) {
    updated = { ...record, status: 'ready', viewer: `/saves/${id}/${relative}` };
  } else if (relative === 'viewer/data.json') {
    // The data-only flavour: the page itself is shared and served from the site, so
    // only the per-save data and raster are stored. `viewer` stays empty on purpose —
    // the card opens /viewer.html?id=..., which finds this and skips the rebuild.
    updated = { ...record, status: 'ready', viewerData: true };
  }
  if (updated !== record) {
    await env.storage.put(`saves/${id}/meta.json`, textEncoder.encode(JSON.stringify(updated)));
    await writeIndex(
      env,
      saves.map((entry) => (entry.id === id ? updated : entry)),
    );
  }
  return json({ ok: true, save: updated }, 201);
}

/**
 * GET /api/saves/:id/original - hand the stored save back to the browser.
 *
 * Used by the card's "重新解析" button: the browser re-reads a save it uploaded
 * earlier without the user having to find the file again. Like writes, this needs
 * the token when one is configured, because the raw save is not public data.
 */
export async function getOriginal(id: string, request: Request, env: ApiEnv): Promise<Response> {
  if (!authorised(request, env)) {
    return json({ error: '读取原始存档未授权：请在设置里填入上传口令' }, 401);
  }
  const bytes = await env.storage.get(`saves/${id}/original.eu4`);
  if (!bytes) return json({ error: '存储里没有这份存档的原始文件' }, 404);
  return new Response(bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    },
  });
}

/** GET /api/saves/:id - one record, so the viewer's edit panel can prefill itself. */
export async function getSave(id: string, request: Request, env: ApiEnv): Promise<Response> {
  void request; // unused: listing is public data, so a read needs no token

  const saves = await readIndex(env);
  const record = saves.find((entry) => entry.id === id);
  if (!record) return json({ error: '没有这份存档' }, 404);
  return json({ save: record });
}

/**
 * Clean one text field of a `custom` patch.
 *
 * `false` means "this is not a text patch, leave the field alone"; `null` means
 * "clear the field" (an empty string after trimming, or an explicit null);
 * anything else is the cleaned text. Dirty input never reaches storage, but a
 * malformed value also never wipes a good one.
 */
function cleanText(value: unknown, max: number): string | null | false {
  if (value === null) return null;
  if (typeof value !== 'string') return false;
  const text = value.trim().slice(0, max);
  return text.length ? text : null;
}

/** Same contract as {@link cleanText}, for the protagonist list. */
function cleanProtagonists(value: unknown): Protagonist[] | null | false {
  if (value === null) return null;
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  const out: Protagonist[] = [];
  for (const item of value) {
    if (out.length >= 20) break;
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as { tag?: unknown; player?: unknown };
    if (typeof raw.tag !== 'string') continue;
    const tag = raw.tag.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (tag.length < 2 || seen.has(tag)) continue;
    seen.add(tag);
    const player = typeof raw.player === 'string' ? raw.player.trim().slice(0, 40) : '';
    out.push(player ? { tag, player } : { tag });
  }
  return out.length ? out : null;
}

const CUSTOM_LIMITS = { title: 80, endDate: 20, mods: 200, sealedAt: 20 } as const;

/**
 * Field-by-field merge of a `custom` patch over the stored value.
 *
 * Only the fields present in the patch change, so the viewer can send the whole
 * form while the card can send one field. An empty value clears that field.
 */
export function mergeCustom(base: SaveCustom | undefined, patch: unknown): SaveCustom | undefined {
  const next: SaveCustom = { ...(base ?? {}) };
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return next;
  const source = patch as Record<string, unknown>;
  for (const field of ['title', 'endDate', 'sealedAt', 'mods'] as const) {
    if (!(field in source)) continue;
    const cleaned = cleanText(source[field], CUSTOM_LIMITS[field]);
    if (cleaned === false) continue;
    if (cleaned === null) delete next[field];
    else next[field] = cleaned;
  }
  if ('protagonists' in source) {
    const cleaned = cleanProtagonists(source.protagonists);
    if (cleaned !== false) {
      if (cleaned === null) delete next.protagonists;
      else next.protagonists = cleaned;
    }
  }
  return next;
}

/** PATCH /api/saves/:id - used later by the viewer's "edit info" screen. */
export async function updateSave(id: string, request: Request, env: ApiEnv): Promise<Response> {
  if (!authorised(request, env)) return json({ error: '修改未授权' }, 401);
  const saves = await readIndex(env);
  const record = saves.find((entry) => entry.id === id);
  if (!record) return json({ error: '没有这份存档' }, 404);
  const patch = ((await request.json()) ?? {}) as Partial<SaveRecord> & { custom?: SaveCustom | null };
  const updated: SaveRecord = {
    ...record,
    name: typeof patch.name === 'string' ? patch.name : record.name,
    info: patch.info ? { ...record.info, ...patch.info } : record.info,
    // Filling in the parsed info must never downgrade a save that already has a
    // generated viewer back to "parsed".
    status: patch.info ? (record.viewer ? 'ready' : 'parsed') : record.status,
  };
  // `custom: null` resets the whole block; otherwise the patch is merged field by
  // field, and a merge that leaves nothing behind drops the key altogether.
  if ('custom' in patch) {
    const merged = patch.custom === null ? undefined : mergeCustom(record.custom, patch.custom);
    if (merged && Object.keys(merged).length) updated.custom = merged;
    else delete updated.custom;
  }
  await env.storage.put(`saves/${id}/meta.json`, textEncoder.encode(JSON.stringify(updated)));
  await writeIndex(
    env,
    saves.map((entry) => (entry.id === id ? updated : entry)),
  );
  return json({ save: updated });
}
