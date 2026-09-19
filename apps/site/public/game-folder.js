/*
 * The user's game folder, and the cache that makes picking it a one-time job.
 *
 * Browsers cannot read a path from disk, so the page asks for the folder (or the
 * three map files) with an <input type="file" webkitdirectory>, and everything
 * arrives as File objects whose `webkitRelativePath` looks like
 * `Europa Universalis IV/map/provinces.bmp`. This module turns that flat list
 * into the files the viewer needs, then caches the expensive result (the
 * 5632x2048 province id map, ~23 MB as a typed array) in IndexedDB so the user
 * picks the folder once and never again.
 *
 * Pure matching is separated from caching on purpose: the matching rules are
 * testable against the real game folder listing, the cache is not.
 */

/** Files the viewer reads. Directories and mods can add more later. */
export const GAME_FILES = {
  provincesBmp: ['map/provinces.bmp'],
  definitionCsv: ['map/definition.csv'],
  defaultMap: ['map/default.map'],
  /** Colour and name sources, read one directory at a time. */
  religionDirs: ['common/religions/', 'common/religion/'],
  countryColourDirs: ['common/countries/'],
  localisationDirs: ['localisation/'],
};

/** Normalise a relative path: backslashes out, no leading folder segments. */
export function normalisePath(path) {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

/**
 * Keep only the part from `map/`, `common/` or `localisation/` onwards, so the
 * picker works whether the user selected the game root or its parent.
 */
export function gameRelative(path) {
  const normalised = normalisePath(path);
  for (const root of ['map/', 'common/', 'localisation/', 'gfx/', 'dlc/']) {
    const at = normalised.indexOf(root);
    if (at >= 0) return normalised.slice(at);
  }
  return normalised;
}

/**
 * Pick the files the viewer needs out of a directory listing.
 * @param {Array<{path: string, file: unknown}>} entries
 */
export function matchGameFiles(entries) {
  const byPath = new Map();
  for (const entry of entries) {
    byPath.set(gameRelative(entry.path).toLowerCase(), entry);
  }
  const pick = (candidates) => {
    for (const candidate of candidates) {
      const found = byPath.get(candidate.toLowerCase());
      if (found) return found;
    }
    return undefined;
  };
  const pickAll = (prefixes) =>
    [...byPath.entries()]
      .filter(([path]) => prefixes.some((prefix) => path.startsWith(prefix)))
      .map(([, entry]) => entry);

  const found = {
    provincesBmp: pick(GAME_FILES.provincesBmp),
    definitionCsv: pick(GAME_FILES.definitionCsv),
    defaultMap: pick(GAME_FILES.defaultMap),
    religions: pickAll(GAME_FILES.religionDirs),
    countryColours: pickAll(GAME_FILES.countryColourDirs),
    localisation: pickAll(GAME_FILES.localisationDirs),
  };
  const missing = ['provincesBmp', 'definitionCsv', 'defaultMap'].filter((key) => !found[key]);
  return { ...found, missing, complete: missing.length === 0, total: entries.length };
}

// --------------------------------------------------------------- IndexedDB ---

const DB_NAME = 'eu4-save-archive';
// v2 added the `game-tables` store: the map cache alone still left the user picking
// the folder again for names and colours, which is the whole thing the cache exists
// to prevent. v3 rows carry the Chinese mod's localisation (see TABLES_VERSION).
const DB_VERSION = 3;
const MAP_STORE = 'game-map';
const TABLES_STORE = 'game-tables';
/** Bump when what gets merged into the name table changes. */
const TABLES_VERSION = 3;

/** Small promise wrapper; every call degrades to "no cache" on failure. */
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MAP_STORE)) db.createObjectStore(MAP_STORE);
      if (!db.objectStoreNames.contains(TABLES_STORE)) db.createObjectStore(TABLES_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
  });
}

function runTransaction(store, mode, work) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = work(tx.objectStore(store));
        tx.oncomplete = () => {
          db.close();
          resolve(request ? request.result : undefined);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('transaction failed'));
        };
      }),
  );
}

/**
 * Cache key for a map: the dimensions plus a cheap fingerprint of the id list.
 * A different game version (or a map mod) produces a different key, so a stale
 * cache is never silently reused.
 */
export function mapCacheKey(width, height, ids) {
  let hash = 2166136261;
  // Sampling every 97th id is enough to notice a different map and costs nothing.
  for (let i = 0; i < ids.length; i += 97) {
    hash ^= ids[i];
    hash = Math.imul(hash, 16777619);
  }
  return `map-${width}x${height}-${(hash >>> 0).toString(16)}-${ids.length}`;
}

/** Store the decoded map (ids + water + definitions) for next time. */
export async function cacheMap(map) {
  const key = mapCacheKey(map.width, map.height, map.ids);
  await runTransaction(MAP_STORE, 'readwrite', (store) =>
    store.put(
      {
        key,
        width: map.width,
        height: map.height,
        ids: map.ids,
        water: { sea: [...map.water.sea], lakes: [...map.water.lakes] },
        definitions: [...map.definitions.values()],
        savedAt: new Date().toISOString(),
      },
      'current',
    ),
  );
  return key;
}

/** Read the cached map back, or undefined when there is none. */
export async function cachedMap() {
  try {
    const record = await runTransaction(MAP_STORE, 'readonly', (store) => store.get('current'));
    if (!record?.ids) return undefined;
    return {
      width: record.width,
      height: record.height,
      ids: record.ids instanceof Uint16Array ? record.ids : new Uint16Array(record.ids),
      water: {
        sea: new Set(record.water?.sea ?? []),
        lakes: new Set(record.water?.lakes ?? []),
      },
      definitions: new Map((record.definitions ?? []).map((def) => [def.id, def])),
      savedAt: record.savedAt,
    };
  } catch {
    return undefined;
  }
}

/** Forget the cached map (used when the user picks a different game folder). */
export async function clearCachedMap() {
  try {
    await runTransaction(MAP_STORE, 'readwrite', (store) => store.delete('current'));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- names and colours ---

/**
 * The two files the offline build reads for names.
 *
 * A Chinese mod ships its text as `_l_english.yml` overrides, and these two hold the
 * country names and the UI text. Reading exactly these — rather than every English
 * file in the mod — is what keeps the hosted page's names identical to the generated
 * one's instead of merely similar.
 */
const PREFERRED_LOCALISATION = ['text_l_english.yml', 'countries_l_english.yml'];

/** Caps so a picked folder cannot stall the page. */
export const MAX_LOCALISATION_FILES = 200;
export const MAX_LOCALISATION_BYTES = 8 * 1024 * 1024;

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();
const usable = (entries) =>
  entries
    .filter((entry) => (entry.file?.size ?? 0) <= MAX_LOCALISATION_BYTES)
    .sort((a, b) => a.path.localeCompare(b.path));

/**
 * Which localisation files to read, and in what order.
 *
 * Order is the whole point: later entries overwrite earlier ones, so the game folder
 * comes first and the Chinese mod's files last. Without the mod the viewer shows the
 * base game's English names — which is exactly the bug this exists to fix.
 *
 * @param {{game?: Array<{path: string, file: {size: number}}>, mod?: Array}} folders
 * @returns {Array} entries in load order
 */
export function localisationSources({ game = [], mod = [] } = {}) {
  const preferred = (entries) =>
    usable(entries).filter((entry) => PREFERRED_LOCALISATION.includes(baseName(entry.path)));
  const modPreferred = preferred(mod);
  if (modPreferred.length) {
    return [...preferred(game), ...modPreferred];
  }
  // No recognisable Chinese mod: fall back to every English file, game first.
  const english = (entries) => {
    const all = usable(entries);
    const only = all.filter((entry) => /_l_english\.yml$/i.test(entry.path));
    return (only.length ? only : all).slice(0, MAX_LOCALISATION_FILES);
  };
  return [...english(game), ...english(mod)];
}

/**
 * Cache the merged localisation table and religion colours.
 *
 * These are derived values, not the files: the merged English/Chinese table is a
 * megabyte of JSON while the source folder can be hundreds of megabytes, and the
 * viewer only ever needs this one map. Storing the result keeps the second visit to
 * a single IndexedDB read.
 */
export async function cacheTables({ names, religions, sources, savedAt }) {
  await runTransaction(TABLES_STORE, 'readwrite', (store) =>
    store.put(
      {
        version: TABLES_VERSION,
        names: [...names],
        religions: [...religions],
        sources: sources ?? [],
        savedAt: savedAt ?? new Date().toISOString(),
      },
      'current',
    ),
  );
}

/** Read the cached tables back, or undefined when there are none (or they are old). */
export async function cachedTables() {
  try {
    const record = await runTransaction(TABLES_STORE, 'readonly', (store) => store.get('current'));
    if (!record?.names) return undefined;
    // v2 added the Chinese mod's localisation. A v1 record is English-only, so it is
    // ignored: keeping it would silently pin the viewer to the wrong names forever.
    if (record.version !== TABLES_VERSION) return undefined;
    return {
      names: new Map(record.names),
      religions: new Map(record.religions),
      sources: record.sources ?? [],
      savedAt: record.savedAt,
    };
  } catch {
    return undefined;
  }
}

/** Forget the cached names and colours. */
export async function clearCachedTables() {
  try {
    await runTransaction(TABLES_STORE, 'readwrite', (store) => store.delete('current'));
    return true;
  } catch {
    return false;
  }
}
