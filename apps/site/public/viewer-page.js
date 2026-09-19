/*
 * The hosted viewer's bootstrap: /viewer.html?id=<saveId>
 *
 * Everything the viewer needs is produced here, in the browser, from three inputs:
 * the save itself (fetched from the archive), the game folder, and — for Chinese
 * names — the localisation of a Chinese mod. The folders are picked once and cached.
 * Nothing is precomputed on a server, because a Cloudflare Worker cannot read a 57 MB
 * gamestate inside 10 ms of CPU or 128 MB of RAM — and the offline route
 * (scripts/render-timeline.ts) is what "without local commands" was meant to remove.
 *
 * The order matters: viewer.html's markup is inert until DATA/RASTER/BG/ALIAS exist,
 * so the player script is only added to the page after the build finishes.
 */

import {
  cachedMap,
  cacheMap,
  cachedTables,
  cacheTables,
  clearCachedMap,
  clearCachedTables,
  localisationSources,
  matchGameFiles,
} from './game-folder.js';
import { buildGameMap } from './game-data.js';
import { loadLocalisation, localise } from './game-localisation.js';
import { loadReligionTable } from './game-tables.js';
import { buildForSave, loadStoredSave, storeBuiltSave } from './viewer-store.js';

const params = new URLSearchParams(location.search);
const id = params.get('id');
/** `?reset=1` forgets the cached folders, so a wrong pick is never permanent. */
const reset = params.has('reset');

// ---------------------------------------------------------------- boot UI -----

/**
 * The overlay is injected rather than declared in viewer.html: that markup is shared
 * with the offline player, which has nothing to wait for and must not grow a dialog
 * it never hides.
 */
const overlay = document.createElement('div');
overlay.style.cssText =
  'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
  'background:#0f1115;color:#e6e6e6;font:14px/1.7 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;padding:24px';
overlay.innerHTML =
  '<div style="max-width:620px;width:100%">' +
  '<h1 style="margin:0 0 10px;font-size:19px">正在浏览器中生成查看页</h1>' +
  '<div id="bootStep" style="color:#8a93a3;min-height:3.4em">准备中…</div>' +
  '<div id="bootBar" style="height:4px;background:#263042;border-radius:3px;overflow:hidden;margin:14px 0 16px">' +
  '<div id="bootFill" style="height:100%;width:0;background:#4b8fd6;transition:width .2s"></div></div>' +
  '<div id="bootPick" hidden style="margin-bottom:14px"></div>' +
  '<div id="bootError" hidden style="color:#f0a0a0;white-space:pre-wrap;margin-bottom:14px"></div>' +
  '<div style="color:#6f7d90;font-size:12.5px">' +
  '解析只在本机浏览器里进行，存档不会离开这台电脑。首次使用需要选择一次《欧陆风云 4》游戏目录' +
  '（或包含 map 与 localisation 的目录），之后会记住。' +
  '</div></div>';
/** Mount the overlay, whether or not the body exists yet. */
function mountOverlay() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', mountOverlay);
    return;
  }
  if (!overlay.isConnected) document.body.appendChild(overlay);
}
mountOverlay();

const stepEl = () => overlay.querySelector('#bootStep');
const errorEl = () => overlay.querySelector('#bootError');
const fillEl = () => overlay.querySelector('#bootFill');

function progress(percent, message) {
  const fill = fillEl();
  if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  const step = stepEl();
  if (step && message) step.textContent = message;
}

function fail(error) {
  const box = errorEl();
  if (box) {
    box.hidden = false;
    box.textContent = String(error && error.stack ? error.stack : error);
  }
  const step = stepEl();
  if (step) step.textContent = '生成失败';
  console.error(error);
}

// ------------------------------------------------------------ game folder -----

/**
 * Ask for two folders: the game (required) and the Chinese mod's localisation
 * (optional, but without it the page shows the base game's English names).
 *
 * @returns {Promise<{map: object, tables: object}>}
 */
function pickGameFolder() {
  return new Promise((resolve, reject) => {
    const host = overlay.querySelector('#bootPick');
    host.hidden = false;
    host.style.color = '#e6e6e6';
    host.innerHTML =
      '<div style="margin-bottom:6px"><b>① 游戏目录（必需）</b><br>' +
      '<span style="color:#8a93a3">选到能看到 map、common、localisation 三个文件夹的那一层</span></div>' +
      '<input id="bootDir" type="file" webkitdirectory directory multiple style="display:block;margin-bottom:14px">' +
      '<div style="margin-bottom:6px"><b>② 汉化 mod 目录（可选，想要中文国名就选它）</b><br>' +
      '<span style="color:#8a93a3">例如 …\\steamapps\\workshop\\content\\236850\\2976470733<br>' +
      '选 mod 根目录或它里面的 localisation 文件夹都可以</span></div>' +
      '<input id="bootMod" type="file" webkitdirectory directory multiple style="display:block;margin-bottom:14px">' +
      '<div id="bootChosen" style="color:#8a93a3;margin-bottom:12px"></div>' +
      '<button id="bootGo" disabled style="padding:8px 18px">开始生成</button>';

    const dirInput = host.querySelector('#bootDir');
    const modInput = host.querySelector('#bootMod');
    const goButton = host.querySelector('#bootGo');
    const chosen = host.querySelector('#bootChosen');
    const list = (input, set) => {
      [...input.files].forEach((file) => set.add(file.webkitRelativePath || file.name));
      return set;
    };
    let gameFiles = new Set();
    let modFiles = new Set();

    const describe = () => {
      chosen.textContent =
        `游戏目录：${gameFiles.size.toLocaleString()} 个文件` +
        (modFiles.size ? `　汉化目录：${modFiles.size.toLocaleString()} 个文件` : '　汉化目录：未选择（国名会是英文）');
      goButton.disabled = ![...dirInput.files].length;
    };
    dirInput.addEventListener('change', () => {
      gameFiles = list(dirInput, gameFiles);
      describe();
    });
    modInput.addEventListener('change', () => {
      modFiles = list(modInput, modFiles);
      describe();
    });
    describe();

    goButton.addEventListener('click', async () => {
      try {
        goButton.disabled = true;
        rejectIfEmpty([...dirInput.files]);
        resolve(await readGameFolder([...dirInput.files], [...modInput.files]));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function rejectIfEmpty(files) {
  if (!files.length) throw new Error('没有选择游戏目录');
}

/** Read, decode and cache everything the viewer needs out of the two listings. */
async function readGameFolder(files, modFileList = []) {
  progress(10, `已选择 ${files.length.toLocaleString()} 个文件，正在匹配地图文件…`);
  const found = matchGameFiles(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
  if (!found.complete) {
    throw new Error(
      '没找到地图文件：' +
        found.missing.join('、') +
        '\n请选择《欧陆风云 4》的游戏根目录（里面应有 map/provinces.bmp）。',
    );
  }

  progress(25, '正在解码省份地图（5,632 × 2,048）…');
  const map = buildGameMap({
    definitionCsv: new Uint8Array(await found.definitionCsv.file.arrayBuffer()),
    defaultMap: new Uint8Array(await found.defaultMap.file.arrayBuffer()),
    provincesBmp: new Uint8Array(await found.provincesBmp.file.arrayBuffer()),
  });

  progress(55, '正在读取国名与宗教颜色…');
  const modFound = matchGameFiles(
    modFileList.map((file) => ({ path: file.webkitRelativePath || file.name, file })),
  );
  const tables = await readTables(found, modFound);

  // Say it out loud: a wrong folder choice otherwise only shows up as English names
  // on a finished map, which is easy to miss and hard to attribute.
  progress(70, `词条 ${tables.names.size.toLocaleString()} 条｜${tables.summary}`);

  progress(80, '正在缓存，下次打开就不用再选了…');
  try {
    await cacheMap(map);
    await cacheTables(tables);
  } catch (error) {
    // A full or unavailable cache is not fatal: the folder is simply asked for again.
    console.warn('cache failed', error);
  }
  return { map, tables };
}

/** Merge the localisation and religion files the two folders provided. */
async function readTables(found, modFound) {
  const chosen = localisationSources({ game: found.localisation, mod: modFound.localisation ?? [] });

  const sources = [];
  for (const entry of chosen) {
    sources.push({ text: await entry.file.text(), source: entry.path });
  }
  const names = loadLocalisation(sources);

  const religionSources = [];
  for (const entry of [...found.religions, ...(modFound.religions ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
    religionSources.push({ text: await entry.file.text(), source: entry.path });
  }
  const religions = loadReligionTable(religionSources).colors;

  // A couple of concrete names, so the log tells the user whether the mod worked.
  const samples = ['RUS', 'ENG', 'FRA']
    .map((tag) => `${tag}→${localise(names, tag)}`)
    .join(' ');
  const chinese = ['RUS', 'ENG', 'FRA'].filter((tag) => /[\u4e00-\u9fff]/.test(localise(names, tag)));
  return {
    names,
    religions,
    sources: [...sources, ...religionSources].map((s) => s.source),
    summary: `${samples}${chinese.length ? '' : '（未检测到中文，请确认②选的是汉化 mod 目录）'}`,
  };
}

// ------------------------------------------------------------------ player -----

/** The upload token the catalogue remembers, if any. */
function uploadHeaders() {
  try {
    const token = localStorage.getItem('catalogue.token');
    return token ? { 'x-upload-token': token } : {};
  } catch {
    return {};
  }
}

/**
 * The calendar day of an ISO timestamp.
 *
 * `uploadedAt` is stored as a full ISO instant; its first ten characters are the day the
 * catalogue prints as 封档日期's fallback, both here and on the card — and the same string
 * the drawer prefills its 封档日期 field with when the user has not set one. Kept as a plain
 * substring so the two pages can never disagree about which day a save joined the archive.
 */
function isoDay(value) {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

/**
 * Hand the player its data and start it.
 *
 * `rasterUrl` is a URL, never a data URI: the stored file when one exists, an object
 * URL when this page just built it. The player only needs `img.src`.
 */
async function startPlayer({ data, rasterUrl, panels, bg }) {
  globalThis.VIEWER_ASSETS = { flags: '/assets/flags/' };
  globalThis.DATA = data;
  globalThis.RASTER = rasterUrl;
  globalThis.BG = bg ?? (await wallpapers());
  globalThis.ALIAS = data.tagAlias;
  globalThis.VIEWER_PANELS = {
    leaders: panels?.leaderHtml ?? '',
    cities: panels?.cityHtml ?? '',
    institutions: panels?.institutionHtml ?? '',
  };
  // The catalogue's own record for this save (title, mods, dates, protagonists). The
  // player's 📝 drawer edits it and the catalogue card reads it, so both pages work off
  // one stored object. Best effort: a viewer with no record still plays, it just opens
  // the drawer empty. The generated standalone page deliberately has no such global —
  // there is no id and no server behind it — which is what keeps the drawer off that page.
  let record;
  try {
    const response = await fetch(`/api/saves/${encodeURIComponent(id)}`, { cache: 'no-cache' });
    if (response.ok) record = (await response.json())?.save;
  } catch (error) {
    console.warn('the archive record is unavailable', error);
  }
  const custom = record?.custom && typeof record.custom === 'object' ? record.custom : {};
  const info = record?.info ?? {};
  // The subtitle under the heading names the archive's fields instead of the parsed frame
  // counts. Resolved here because this is the only host that holds the record: the two
  // dates are the user's own values (falling back to the parsed/uploaded ones) and the
  // other two are parsed. An absent field prints as a dash — never as a blank gap, which
  // reads like a broken page.
  globalThis.VIEWER_FACTS = Object.assign({}, panels?.header ?? {}, {
    version: info.version || '—',
    endDate: custom.endDate || info.campaignDate || '—',
    sealedAt: custom.sealedAt || isoDay(record?.uploadedAt) || '—',
    mods: custom.mods || (info.mods?.length ? `${info.mods.length} 个` : '—'),
  });
  globalThis.VIEWER_META = {
    id,
    name: record?.name ?? globalThis.VIEWER_FACTS.title ?? '',
    custom,
    // The drawer's 封档日期 field prefills itself from uploadedAt when custom.sealedAt is
    // empty, and the summary above it resolves the same pair the card does.
    uploadedAt: record?.uploadedAt ?? '',
    // What the drawer's picker and placeholder need from the parsed metadata; the panel
    // reads only these, so no parsed field ever leaks into the page wholesale.
    info: {
      version: info.version ?? '',
      campaignDate: info.campaignDate ?? '',
      modCount: info.mods?.length ?? 0,
      playerTag: info.playerTag ?? '',
    },
    // The great powers, so a protagonist's TAG can be picked instead of remembered. An
    // archive whose stored data.json predates this array simply leaves it undefined and
    // the client falls back to the leaderboard the page already shows.
    leaders: Array.isArray(panels?.leaders)
      ? panels.leaders.map((row) => ({ tag: String(row?.tag ?? ''), name: String(row?.name ?? '') }))
      : undefined,
  };
  // The shared background/theme component must already be a global when the player runs.
  // The generated page inlines it as a classic script before the player; here it is a
  // module, so its exports are copied onto globalThis and viewer.js reads one set of
  // names on both hosts — which is why the two pages cannot grow two settings panels.
  // Guarded: a module that will not load costs the 🎨 controls, never the map. Imported
  // before the overlay goes away so the build progress stays on screen until the end.
  try {
    const theme = await import('./page-theme.js');
    globalThis.mountPageTheme = theme.mountPageTheme;
    globalThis.applyTheme = theme.applyTheme;
    globalThis.loadSettings = theme.loadSettings;
    globalThis.saveSettings = theme.saveSettings;
    globalThis.SETTINGS_KEY = theme.SETTINGS_KEY;
    globalThis.THEMES = theme.THEMES;
  } catch (error) {
    console.warn('backgrounds/themes unavailable', error);
  }
  overlay.remove();
  await loadScript('viewer.js');
}

/** Wallpaper list, generated next to the page; a missing file just means none. */
async function wallpapers() {
  try {
    const response = await fetch('wallpapers.json', { cache: 'force-cache' });
    if (!response.ok) return [];
    const list = await response.json();
    return list.map((name) => new URL(name, location.href).href);
  } catch {
    return [];
  }
}

/** Add a script tag and resolve when it has run. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`cannot load ${src}`));
    document.body.appendChild(script);
  });
}

/**
 * A way out of a cached choice.
 *
 * The folders are remembered for good, so a pick made before the Chinese mod was
 * added (or the wrong mod) would otherwise mean English names forever with no hint of
 * why. A plain link beats a dialog here: it cannot race the build that is already
 * running underneath.
 */
function offerRepick() {
  const step = stepEl();
  if (!step || overlay.querySelector('#bootRepick')) return;
  const link = document.createElement('a');
  link.id = 'bootRepick';
  link.href = `?id=${encodeURIComponent(id)}&reset=1`;
  link.textContent = '重新选择游戏目录 / 汉化目录';
  link.style.cssText = 'color:#4b8fd6;display:inline-block;margin-top:8px';
  step.after(link);
}

// ------------------------------------------------------------------- main -----

(async function main() {
  try {
    if (!id) throw new Error('缺少存档 id：请从存档列表页打开');

    // Fast path first: the catalogue builds and stores this right after an upload, in
    // which case opening a viewer is two requests and no parsing at all.
    progress(4, '正在查找已生成的数据…');
    const stored = await loadStoredSave(id);
    if (stored) {
      progress(90, '已找到生成好的数据，正在打开…');
      await startPlayer({ data: stored.data, rasterUrl: stored.rasterUrl, panels: stored.panels });
      return;
    }

    if (reset) {
      progress(3, '正在清除已缓存的游戏目录…');
      await clearCachedMap();
      await clearCachedTables();
    }

    let map = await cachedMap().catch(() => undefined);
    let tables = await cachedTables().catch(() => undefined);
    if (!map || !tables) {
      progress(5, '第一次打开需要选择游戏目录（以及汉化 mod 目录）…');
      const picked = await pickGameFolder();
      map = picked.map;
      tables = picked.tables;
    } else {
      progress(10, `已使用上次缓存：词条 ${tables.names.size.toLocaleString()} 条，地图 ${map.width}×${map.height}。`);
      offerRepick();
    }

    progress(80, '正在下载存档…');
    const response = await fetch(`/api/saves/${encodeURIComponent(id)}/original`);
    if (!response.ok) throw new Error(`存档读取失败（HTTP ${response.status}）`);
    const bytes = new Uint8Array(await response.arrayBuffer());

    progress(85, `正在解压存档（${(bytes.length / 1024 / 1024).toFixed(1)} MB）…`);
    progress(92, '正在生成时间线数据与底图…');
    const built = await buildForSave({
      bytes,
      map,
      tables,
      localise: (key) => localise(tables.names, key),
      officialReligions: tables.religions,
    });

    // Store it so this is the only slow visit. Best effort: without the upload token
    // (or with a full bucket) the viewer still works, it just rebuilds next time.
    try {
      progress(97, '正在保存生成结果，下次打开就不用再算了…');
      await storeBuiltSave(id, built, uploadHeaders());
    } catch (error) {
      console.warn('saving the generated viewer failed', error);
    }

    progress(100, '完成');
    await startPlayer({
      data: built.payload.data,
      rasterUrl: URL.createObjectURL(built.raster),
      panels: built.payload.panels,
    });
  } catch (error) {
    fail(error);
  }
})();
