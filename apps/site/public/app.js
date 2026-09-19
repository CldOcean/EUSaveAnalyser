/*
 * Catalogue front end.
 *
 * Uploads are streamed to the API as a raw body with the hash in a header: the
 * browser computes sha256 with crypto.subtle (the Worker would have to buffer the
 * whole file to do the same), which also lets us refuse duplicates before the
 * upload starts.
 *
 * After a successful upload the file is read *in the browser* (public/parser.js)
 * to fill in the campaign date, player, version and mod list. This cannot happen
 * server-side: the save inflates to ~57 MB and a Cloudflare Worker only gets
 * 10 ms of CPU and 128 MB of memory.
 */
import { readSaveInfo, readMembers } from './parser.js';
// The parser itself, bundled for the browser by scripts/build-browser-parser.ts.
// Parsing the 57 MB gamestate takes ~1.5 s here and needs no server at all.
import { SaveDocument, extractWars } from './eu4-parser.js';
// Building and storing the viewer's data, so opening a viewer later is instant.
import { cachedMap, cachedTables } from './game-folder.js';
import { localise } from './game-localisation.js';
import { buildForSave, loadStoredSave, storeBuiltSave } from './viewer-store.js';
// Backgrounds and themes: the same module the viewer uses, reading the same settings
// object, so the two pages can never disagree about them. `flagSet` lives in that same
// object, which is what keeps the card's flag toggle and the viewer's in step.
import { loadSettings, mountPageTheme, saveSettings } from './page-theme.js';

(() => {
  const $ = (id) => document.getElementById(id);
  const api = '/api/saves';
  /**
   * The sort dropdown's old value for "结档日期". A stored preference written before the
   * rename must still select the option it means, so it is mapped instead of dropped.
   */
  const SORT_ALIASES = { date: 'endDate' };
  const storedSort = localStorage.getItem('catalogue.sort');
  const state = {
    saves: [],
    sort: SORT_ALIASES[storedSort] || storedSort || 'uploadedAt',
    dir: localStorage.getItem('catalogue.dir') || 'desc',
    token: localStorage.getItem('catalogue.token') || '',
    /** Set once the game folders are known to be cached. */
    gameReady: false,
    /**
     * Which flag artwork the cards draw: `base` (the game's own flags) or `modded`
     * (the country-girl pack). It is read from — and written back to — the same
     * settings object the viewer's 旗帜 button owns, so the two pages cannot drift.
     */
    flagSet: loadSettings().flagSet === 'modded' ? 'modded' : 'base',
    /** Country names from the cached localisation table; undefined until (and unless) it exists. */
    names: undefined,
  };

  const fmtBytes = (n) => {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
  };
  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
  };
  /**
   * The day of a real-world date (`2026-09-18T04:12:33Z` -> `2026-09-18`,
   * `2026-9-8` -> `2026-09-08`).
   *
   * `custom.sealedAt` is free text while `uploadedAt` is an ISO timestamp, so printing
   * either raw would put a time of day in the row and let `2026-9-8` read as a different
   * day from `2026-09-18`. The server's 封档日期 sort (`api.ts`'s `dayKey`) reduces a
   * value exactly the same way, so the card's order can never contradict its dates.
   * Anything that does not start with a `Y-M-D` date is shown as typed.
   */
  const sealedDay = (value) => {
    const text = String(value ?? '').trim();
    const [, year = '', month = '', day = ''] = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text) ?? [];
    if (!year) return text;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  };
  const tip = (message, kind = 'info') => {
    const box = $('progress');
    box.textContent = message;
    box.style.color = kind === 'error' ? 'var(--danger)' : kind === 'ok' ? 'var(--ok)' : '';
  };

  function headers(extra = {}) {
    const out = { ...extra };
    if (state.token) out['x-upload-token'] = state.token;
    return out;
  }

  async function sha256Hex(file) {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function load() {
    try {
      const response = await fetch(`${api}?sort=${state.sort}&dir=${state.dir}`, { headers: headers() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      state.saves = data.saves || [];
      $('summary').textContent =
        `${state.saves.length} 份存档 · 占用 ${fmtBytes(data.storage?.bytes || 0)}` +
        (data.storage && data.storage.writable === false ? ' · 只读（未配置上传口令）' : '');
      render();
    } catch (error) {
      tip(`读取目录失败：${error.message}`, 'error');
    }
  }

  /**
   * How a card offers its viewer.
   *
   *   stored  the timeline data is in the archive, so the hosted page opens instantly
   *   page    only a self-contained HTML page exists (`生成查看页.bat`)
   *   none    nothing is stored yet; opening the viewer builds it (and stores it)
   *
   * Kept in one place because the label and the link must agree: a mismatch is what
   * made a save with stored data still offer "在浏览器中生成".
   *
   * Stored data now beats the self-contained page, and that order is the whole point of
   * 「生成查看页」: the self-contained page has no server behind it, so it can never
   * show the archive metadata panel (📝) or edit it. That page stays reachable through
   * the secondary 「查看」 link instead of being what the primary button silently opens.
   */
  const viewerState = (save) => (save.viewerData ? 'stored' : save.viewer ? 'page' : 'none');
  // 命名（用户 2026-09-19 拍板，只改名字、行为不动）：
  //   「生成查看页」＝打开托管查看页（没有数据时现场生成一次并入库）
  //   「查看」      ＝打开已经生成好的单文件页（离线页，可双击/离线打开）
  const viewerLabel = (save) =>
    viewerState(save) === 'none' ? (state.gameReady ? '生成查看页' : '生成查看页（需选目录）') : '生成查看页';
  const viewerHref = (save) =>
    save.viewerData || !save.viewer ? `viewer.html?id=${encodeURIComponent(save.id)}` : save.viewer;

  /** The custom block, or an empty one: records written before it existed have none. */
  const customOf = (save) => save.custom || {};

  /**
   * Country name for a tag, from the localisation table the viewer cached.
   *
   * If the catalogue has never seen the game folder there is no table, and the tag
   * itself is shown. There is deliberately no "pick your game folder" prompt here:
   * looking at the catalogue must never be blocked by that.
   */
  function countryName(tag) {
    const names = state.names;
    if (names) {
      const name = localise(names, tag);
      if (name && name !== tag) return name;
    }
    return tag;
  }

  /**
   * The map thumbnail of the campaign's last day.
   *
   * Only a save that already has stored viewer data gets one. The file itself is
   * produced by the build (`viewer/thumb.png`); a save built before that existed fails
   * to load and the error handler below turns it into a grey placeholder rather than a
   * broken-image icon.
   */
  function thumbMarkup(save) {
    if (!save.viewer && !save.viewerData) return '';
    return (
      '<div class="thumb">' +
      `<img src="/saves/${encodeURIComponent(save.id)}/viewer/thumb.png" alt="结档当日的地图" loading="lazy">` +
      '</div>'
    );
  }

  /** How many protagonist flags one page of the card shows. */
  const HERO_PER_PAGE = 3;

  /**
   * The mother countries of the colonies the save recorded.
   *
   * The catalogue record carries the protagonist tags but not the colony ledger: that
   * table only exists once the save has been built, and it lives in the viewer's own
   * data (`viewer/data.json`). So a card that shows a protagonist reads it back from
   * there — once per save, cached for the life of the page, and repainted in place when
   * it lands. A card with no protagonist, or a save that was never built, fetches
   * nothing at all.
   */
  const colonialLedgers = new Map();
  const colonialPending = new Map();
  function colonialParents(save) {
    if (!save.viewerData) return Promise.resolve(null);
    if (colonialLedgers.has(save.id)) return Promise.resolve(colonialLedgers.get(save.id));
    if (colonialPending.has(save.id)) return colonialPending.get(save.id);
    const pending = loadStoredSave(save.id)
      .then((stored) => {
        const parents = (stored && stored.data && stored.data.colonialParent) || null;
        colonialLedgers.set(save.id, parents);
        colonialPending.delete(save.id);
        return parents;
      })
      .catch(() => {
        colonialPending.delete(save.id);
        return null;
      });
    colonialPending.set(save.id, pending);
    return pending;
  }

  /** The mother country of a colonial tag, or '' for everything else. */
  const parentOf = (parents, tag) => (parents && parents[tag]) || '';

  /**
   * The colour of the right half of a colonial flag, as a #rrggbb string.
   *
   * Frozen algorithm, byte for byte the one in `viewer-build.js` and
   * `scripts/lib/map-assets.ts` (`hslToRgb(h % 360, 0.6, 0.45)` written out, so the card
   * needs no colour table), and the same copy `viewer.js` carries: the flag block is
   * then exactly the colour the same tag gets on the map.
   */
  function flagFill(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i += 1) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    const hp = ((h >>> 0) % 360) / 60;
    const c = (1 - Math.abs(2 * 0.45 - 1)) * 0.6;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const rgb =
      hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = 0.45 - c / 2;
    let hex = '#';
    for (let i = 0; i < 3; i += 1) {
      hex += ('0' + Math.round((rgb[i] + m) * 255).toString(16)).slice(-2);
    }
    return hex;
  }

  /** The protagonist countries of a record, in display order, without the invalid ones. */
  const heroList = (save) => {
    const list = customOf(save).protagonists;
    return (Array.isArray(list) ? list : []).filter((item) => item && item.tag);
  };

  /**
   * One flag plus its two-line caption: the player on the first line, the country on the
   * second.
   *
   * The single "player-country" line ran out of room, and the country is the part that
   * has to stay readable. With no player name there is no first line at all, rather than
   * a blank one or a bare `-`. `title` keeps the whole caption for the tooltip, because
   * both lines are ellipsised to the card's width.
   *
   * A colonial nation has no artwork of its own, so the card draws its mother country's
   * flag and hangs the colony's own colour over the right half of it — the same picture
   * the viewer's heading and leaderboard draw, from the same save's ledger.
   */
  function heroFigure(item, parents) {
    const tag = String(item.tag).toUpperCase();
    const name = countryName(tag);
    const player = item.player ? String(item.player) : '';
    const caption = player ? `${player}-${name}` : name;
    const lines =
      (player ? `<span class="capLine">${escapeHtml(player)}</span>` : '') +
      `<span class="capLine">${escapeHtml(name)}</span>`;
    const parent = parentOf(parents, tag);
    const src = `/assets/flags/${state.flagSet}/${encodeURIComponent(parent || tag)}.png`;
    const tint = parent ? `<i class="flagTint" style="background:${flagFill(tag)}"></i>` : '';
    return (
      `<figure class="hero" data-tag="${escapeHtml(tag)}">` +
      '<span class="flagBox">' +
      `<img src="${src}" data-tag="${escapeHtml(tag)}"${parent ? ' data-parent="1"' : ''} ` +
      `alt="${escapeHtml(tag)}" loading="lazy">` +
      tint +
      '</span>' +
      `<figcaption title="${escapeHtml(caption)}">${lines}</figcaption>` +
      '</figure>'
    );
  }

  /**
   * One page of the flag strip, arrows included.
   *
   * Three per page so a card with five protagonists stays the same size. The arrows
   * are only drawn when there is a second page — with three or fewer the block simply
   * has none — and the end pages disable the arrow that would go past the edge.
   */
  function heroPagerInner(save, page, parents) {
    const items = heroList(save);
    const pages = Math.ceil(items.length / HERO_PER_PAGE);
    const current = Math.min(Math.max(Math.trunc(page) || 0, 0), pages - 1);
    const figures = items
      .slice(current * HERO_PER_PAGE, current * HERO_PER_PAGE + HERO_PER_PAGE)
      .map((item) => heroFigure(item, parents))
      .join('');
    const paged = pages > 1;
    return (
      (paged ? `<button class="page prev" title="上一组主角旗帜"${current === 0 ? ' disabled' : ''}>←</button>` : '') +
      `<div class="heroes">${figures}</div>` +
      (paged ? `<button class="page next" title="下一组主角旗帜"${current === pages - 1 ? ' disabled' : ''}>→</button>` : '')
    );
  }

  /**
   * The protagonist flags: at most three at a time, in the user's order, each captioned
   * "player-country". Nothing at all is drawn when no protagonist is set — a row of
   * empty frames would promise something the card cannot show.
   */
  function protagonistsMarkup(save, parents) {
    if (!heroList(save).length) return '';
    return `<div class="heroPager" data-hero data-page="0">${heroPagerInner(save, 0, parents)}</div>`;
  }

  /**
   * A flag the artwork set does not have becomes a TAG block: a card must never show a
   * broken-image icon for a country that simply has no picture.
   *
   * A colonial nation is drawn with its mother country's flag and its own colour over the
   * right half, so there is nothing else to ask for — except for the one case where the
   * flag was painted before the colony ledger arrived: that figure gets a single retry
   * against its mother country, and only then the TAG block.
   */
  function bindHeroFlags(scope, parents) {
    for (const figure of scope.querySelectorAll('.hero')) {
      const img = figure.querySelector('img');
      if (!img) continue;
      // The card pass and the pager pass can both reach the same figure; binding twice
      // would let the second listener read the retry as "already tried" and replace the
      // flag with the TAG block before the mother country was ever requested.
      if (img.dataset.heroBound === '1') continue;
      img.dataset.heroBound = '1';
      const tag = figure.getAttribute('data-tag') || '';
      const fallback = () => {
        const block = document.createElement('span');
        block.className = 'heroFallback';
        block.textContent = tag;
        img.replaceWith(block);
      };
      const missing = () => {
        const parent = parentOf(parents, tag);
        if (parent && img.dataset.parent !== '1') {
          img.dataset.parent = '1';
          img.src = `/assets/flags/${state.flagSet}/${encodeURIComponent(parent)}.png`;
          // The block belongs to the colony, not to the artwork set: it is added once and
          // only when it is not already there.
          if (!figure.querySelector('.flagTint')) {
            const tint = document.createElement('i');
            tint.className = 'flagTint';
            tint.style.background = flagFill(tag);
            const box = figure.querySelector('.flagBox');
            if (box) box.appendChild(tint);
            else figure.insertBefore(tint, img.nextSibling);
          }
          return;
        }
        fallback();
      };
      img.addEventListener('error', missing);
      if (img.complete && img.naturalWidth === 0) missing();
    }
  }

  /**
   * The secondary way in: the single-file page from `生成查看页.bat`, labelled 「查看」.
   *
   * It is one HTML file, so it opens offline and by double-click, but there is no
   * server behind it — it can neither show the archive metadata panel nor change it.
   * That is exactly why the primary button says 「生成查看页」 instead, and why this
   * tooltip says what that page cannot do.
   */
  function offlineMarkup(save) {
    if (!save.viewer) return '';
    return (
      `<a class="offline" href="${escapeHtml(save.viewer)}" target="_blank" rel="noopener" ` +
      'title="本地生成的单文件版：可以离线/双击打开，但改不了存档信息">查看</a>'
    );
  }

  function render() {
    const cards = $('cards');
    $('empty').hidden = state.saves.length > 0;
    $('count').textContent = state.saves.length ? `共 ${state.saves.length} 份` : '';
    cards.innerHTML = '';
    for (const save of state.saves) {
      const card = document.createElement('article');
      card.className = 'card';
      const badge = save.status === 'raw' ? '未解析' : save.status === 'parsed' ? '已解析' : '可查看';
      const info = save.info || {};
      const custom = customOf(save);
      const title = custom.title || save.name;
      // The numbers the card always showed stay, just moved into the small print at
      // the bottom: the user asked for a new layout, not for information to be lost.
      const meta = [fmtBytes(save.size), `加入 ${fmtTime(save.uploadedAt)}`, `编号 ${escapeHtml(save.id)}`];
      if (info.player) meta.push(`玩家 ${escapeHtml(info.player)}`);
      if (info.provinces) meta.push(`${info.provinces.toLocaleString()} 省`);
      if (info.countries) meta.push(`${info.countries.toLocaleString()} 国`);
      if (info.wars) meta.push(`${info.wars.toLocaleString()} 场战争`);
      if (info.parseMs) meta.push(`解析 ${info.parseMs} ms`);
      card.innerHTML = `
        <h3>
          <span class="badge ${save.status}">${badge}</span>
          <button class="title" title="点击修改标题"><span class="titleText">${escapeHtml(title)}</span><span class="pen">✏️</span></button>
        </h3>
        ${thumbMarkup(save)}
        ${protagonistsMarkup(save, colonialLedgers.get(save.id) || null)}
        <dl>
          <dt>结档日期</dt><dd>${escapeHtml(custom.endDate || info.campaignDate || '—')}</dd>
          <dt>封档日期</dt><dd>${escapeHtml(sealedDay(custom.sealedAt) || sealedDay(save.uploadedAt) || '—')}</dd>
          <dt>版本</dt><dd>${escapeHtml(info.version || '—')}</dd>
          <dt>模组</dt><dd>${escapeHtml(custom.mods || (info.mods ? info.mods.length + ' 个' : '—'))}</dd>
        </dl>
        <p class="secondary">${meta.join(' · ')}</p>
        <div class="actions">
          <button class="view">${viewerLabel(save)}</button>
          ${offlineMarkup(save)}
          <button class="reparse" title="从存储里取回存档，重新解析并重建查看页数据">重新解析</button>
          <span class="grow"></span>
          <button class="danger remove">删除</button>
        </div>`;
      card.querySelector('.title').addEventListener('click', () => rename(save));
      card.querySelector('.remove').addEventListener('click', () => remove(save));
      card.querySelector('.reparse').addEventListener('click', (event) => reparse(save, event.target));
      const thumb = card.querySelector('.thumb img');
      if (thumb) {
        const missing = () => {
          thumb.remove();
          const box = card.querySelector('.thumb');
          if (box) box.classList.add('missing');
        };
        thumb.addEventListener('error', missing);
        if (thumb.complete && thumb.naturalWidth === 0) missing();
      }
      // A flag the artwork set does not have becomes a TAG block (after one last try at
      // the mother country's flag, for a colonial nation).
      bindHeroFlags(card, colonialLedgers.get(save.id) || null);
      // Paging through the flag strip redraws this card's strip only: the list keeps its
      // order and the scroll position, and the page number is deliberately not stored.
      const pager = card.querySelector('[data-hero]');
      if (pager) {
        const wire = (page) => {
          const prev = pager.querySelector('.page.prev');
          const next = pager.querySelector('.page.next');
          if (prev) prev.addEventListener('click', () => paint(page - 1));
          if (next) next.addEventListener('click', () => paint(page + 1));
          bindHeroFlags(pager, colonialLedgers.get(save.id) || null);
        };
        const paint = (page) => {
          const pages = Math.ceil(heroList(save).length / HERO_PER_PAGE);
          const current = Math.min(Math.max(Math.trunc(page) || 0, 0), Math.max(pages, 1) - 1);
          pager.dataset.page = String(current);
          pager.innerHTML = heroPagerInner(save, current, colonialLedgers.get(save.id) || null);
          wire(current);
        };
        paint(0);
        // The colony ledger is the one thing this record does not carry, so it is read
        // back from the save's own viewer data and the strip is repainted in place: the
        // list order, the scroll position and this card's page never move.
        void colonialParents(save).then((parents) => {
          if (parents) paint(Number(pager.dataset.page) || 0);
        });
      }
      // 「生成查看页」 always opens the hosted page: that is the only one with the
      // archive metadata panel, so the tooltip must never promise the other page.
      const view = card.querySelector('.view');
      view.title =
        viewerState(save) === 'stored'
          ? '打开查看页（数据已入库，秒开，可修改存档信息）'
          : viewerState(save) === 'page'
            ? '打开查看页：托管页首次要现场生成一次；只想离线打开请用「查看」'
            : '打开查看页：首次会现场生成，之后秒开';
      view.addEventListener('click', () => {
        location.href = viewerHref(save);
      });
      cards.appendChild(card);
    }
  }

  /** A refused write has to say what to do about it, not just that it failed. */
  function authMessage(response, fallback) {
    if (response.status === 401 || response.status === 403) return '未授权：请在 ⚙ 里填入上传口令';
    return fallback;
  }

  /**
   * Rename a card, in place.
   *
   * `prompt()` is the same control the upload token uses, and an empty answer means
   * "go back to the original file name": the empty string is sent as-is and the server
   * deletes the field rather than storing a blank title.
   */
  async function rename(save) {
    const current = customOf(save).title || save.name;
    const answer = prompt('标题（留空 = 用原始文件名）', current);
    if (answer === null) return;
    const title = answer.trim();
    if (title === current) return;
    try {
      const response = await fetch(`${api}/${encodeURIComponent(save.id)}`, {
        method: 'PATCH',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ custom: { title } }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(authMessage(response, data.error || response.statusText));
      // The list in memory is what the cards render from, so patch that one record and
      // redraw — no full page reload, and no refetch of the whole index.
      if (data.save) save.custom = data.save.custom;
      render();
      tip(title ? `标题已改为「${title}」` : '已恢复原始文件名', 'ok');
    } catch (error) {
      tip(`改名失败：${error.message}`, 'error');
    }
  }

  /**
   * Re-read a save that is already in the catalogue.
   *
   * The record may be missing its parsed fields (uploaded before a feature
   * existed, or the browser parse failed once), and re-uploading is impossible
   * because the content hash already exists. So the file comes back from storage
   * and everything happens again, in the browser.
   */
  async function reparse(save, button) {
    const started = Date.now();
    if (button) button.disabled = true;
    try {
      tip(`正在取回 ${save.name}…`);
      const response = await fetch(`${api}/${save.id}/original`, { headers: headers() });
      if (!response.ok) {
        throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
      }
      const buffer = await response.arrayBuffer();
      tip(`${save.name}（${fmtBytes(buffer.byteLength)}）已取回，正在解析…`);
      const info = await readSaveInfo(buffer);
      delete info.members;
      const parseStart = Date.now();
      try {
        const doc = SaveDocument.fromMembers(await readMembers(buffer));
        info.parseMs = Date.now() - parseStart;
        info.provinces = doc.provinces().size;
        info.countries = doc.countries().size;
        info.wars = extractWars(doc).length;
      } catch (error) {
        console.warn('full parse failed, keeping the meta only:', error);
      }
      const patched = await fetch(`${api}/${save.id}`, {
        method: 'PATCH',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ info }),
      });
      if (!patched.ok) throw new Error((await patched.json().catch(() => ({}))).error || patched.statusText);
      tip(`重新解析完成：${info.campaignDate} · ${info.player} · ${info.version} · ` +
        `${info.provinces ?? '?'} 省 / ${info.countries ?? '?'} 国 / ${info.wars ?? '?'} 场战争 ` +
        `（${Date.now() - started} ms）`, 'ok');
      // The data may never have been built (an older record, or a build that failed),
      // so a re-parse is also a chance to produce it.
      await generateViewerData(save.id, new Uint8Array(buffer), save.name);
      await load();
    } catch (error) {
      tip(`重新解析失败：${error.message}`, 'error');
      if (button) button.disabled = false;
    }
  }

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function remove(save) {
    if (!confirm(`删除《${save.name}》？这会连同它的查看页一起删除，无法恢复。`)) return;
    try {
      const response = await fetch(`${api}/${save.id}`, { method: 'DELETE', headers: headers() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      tip(`已删除 ${save.name}（清理 ${data.removed} 个对象）`, 'ok');
      await load();
    } catch (error) {
      tip(`删除失败：${error.message}`, 'error');
    }
  }

  /**
   * Build and store one save's viewer data, right after it is uploaded.
   *
   * The generated timeline needs the game's map and localisation files, which the
   * viewer page asks for once and caches. If that has never happened there is nothing
   * to build from, so the save simply stays viewable-on-demand: opening the viewer
   * asks for the folders and stores the result, after which uploads do this by
   * themselves.
   */
  async function generateViewerData(id, bytes, label) {
    const [map, tables] = await Promise.all([cachedMap().catch(() => undefined), cachedTables().catch(() => undefined)]);
    if (!map || !tables) {
      tip('已加入目录。还没选过游戏目录，打开查看页时选一次即可——之后上传会自动生成。', 'ok');
      return;
    }
    try {
      tip(`正在生成 ${label} 的查看页数据（约十秒，请稍候）…`);
      const built = await buildForSave({
        bytes,
        map,
        tables,
        localise: (key) => localise(tables.names, key),
        officialReligions: tables.religions,
      });
      await storeBuiltSave(id, built, headers());
      // The list in memory is what the cards render from, so mark the record here
      // instead of refetching the whole index.
      const record = state.saves.find((save) => save.id === id);
      if (record) {
        record.status = 'ready';
        record.viewerData = true;
        render();
      }
      tip(`${label} 已入库，打开查看页即为秒开。`, 'ok');
    } catch (error) {
      // Never a failed upload: the save is stored, and the viewer can still build on
      // first open. Say so plainly rather than showing a scary error.
      console.warn('building the viewer data failed', error);
      tip(`已加入目录，但查看页数据生成失败（${error.message}）——打开查看页时会重试。`, 'error');
    }
  }

  async function uploadOne(file) {
    if (!/\.eu4$/i.test(file.name)) throw new Error('只接受 .eu4 文件');
    if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} 超过 100 MB`);
    tip(`正在计算 ${file.name} 的校验值…`);
    const hash = await sha256Hex(file);
    const id = hash.slice(0, 12);
    if (state.saves.some((s) => s.id === id)) {
      tip(`${file.name} 已经在目录里了（编号 ${id}）`, 'ok');
      return false;
    }
    tip(`正在上传 ${file.name}（${fmtBytes(file.size)}）…`);
    const response = await fetch(api, {
      method: 'POST',
      headers: headers({
        'content-type': 'application/octet-stream',
        'x-file-hash': hash,
        'x-file-name': encodeURIComponent(file.name),
      }),
      body: file,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    // `id` is already in scope: it is hash.slice(0, 12), the same id the API
    // derives, so redeclaring it here was both redundant and a syntax error.
    tip(`已上传 ${file.name}（编号 ${id}），正在读取存档信息…`);
    // Enrich the record with what the save says about itself. A failure here is
    // not fatal: the file is already stored and shows up as "未解析".
    try {
      const buffer = await file.arrayBuffer();
      const info = await readSaveInfo(buffer);
      delete info.members;
      // Full parse, in the browser: the same bundle a client-side timeline build
      // will use. Slow part is inflating the 57 MB gamestate.
      tip(`${info.campaignDate ?? ''} ${info.player ?? ''} — 正在解析完整存档…`);
      const parseStart = Date.now();
      try {
        const doc = SaveDocument.fromMembers(await readMembers(buffer));
        info.parseMs = Date.now() - parseStart;
        info.provinces = doc.provinces().size;
        info.countries = doc.countries().size;
        info.wars = extractWars(doc).length;
        console.log(`parsed in the browser: ${info.parseMs} ms`, info);
      } catch (error) {
        console.warn('full parse failed, keeping the meta only:', error);
      }
      const patched = await fetch(`${api}/${id}`, {
        method: 'PATCH',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ info }),
      });
      if (!patched.ok) throw new Error((await patched.json().catch(() => ({}))).error || patched.statusText);
      const extra = info.provinces ? ` · ${info.provinces} 省 / ${info.countries} 国 / ${info.wars} 场战争` : '';
      tip(`${info.campaignDate ?? id} · ${info.player ?? '?'} · ${info.version ?? '?'}（${info.mods?.length ?? 0} 个模组）${extra}`, 'ok');
      // Build the viewer's data now. This is the only slow step in an upload (about
      // ten seconds) and it is what makes every later visit instant, so there is no
      // longer a "has a viewer" and "has no viewer" kind of save.
      await generateViewerData(id, new Uint8Array(buffer), file.name);
    } catch (error) {
      tip(`已加入目录，但读取存档信息失败：${error.message}（刷新页面可重试）`, 'error');
    }
    return true;
  }

  async function uploadFiles(files) {
    const list = [...files];
    if (!list.length) return;
    let added = 0;
    for (const file of list) {
      try {
        if (await uploadOne(file)) added += 1;
      } catch (error) {
        tip(`上传失败：${error.message}`, 'error');
      }
    }
    if (added) await load();
  }

  // ---- wiring ------------------------------------------------------------
  $('pick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', () => {
    void uploadFiles($('file').files);
    $('file').value = '';
  });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('hot');
    }),
  );
  ['dragleave', 'drop'].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove('hot');
    }),
  );
  drop.addEventListener('drop', (event) => {
    if (event.dataTransfer && event.dataTransfer.files) void uploadFiles(event.dataTransfer.files);
  });

  $('sort').value = state.sort;
  // The flag artwork switch, sitting just left of the sort control. It only changes
  // which URLs the cards point at, so the cards are redrawn from memory — no refetch.
  const flagButton = $('flagSet');
  const paintFlagSet = () => {
    flagButton.textContent = state.flagSet === 'modded' ? '👧 国家娘' : '🏳️ 原版';
    flagButton.title =
      state.flagSet === 'modded' ? '卡片正在显示国家娘旗帜，点击切回原版' : '卡片正在显示原版旗帜，点击切换到国家娘';
  };
  flagButton.addEventListener('click', () => {
    state.flagSet = state.flagSet === 'base' ? 'modded' : 'base';
    // Same key the viewer's 旗帜 button writes, so the two pages stay in step.
    saveSettings({ flagSet: state.flagSet });
    paintFlagSet();
    render();
  });
  paintFlagSet();
  $('sort').addEventListener('change', () => {
    state.sort = $('sort').value;
    localStorage.setItem('catalogue.sort', state.sort);
    void load();
  });
  const dirButton = $('dir');
  const paintDir = () => {
    dirButton.textContent = state.dir === 'asc' ? '↑' : '↓';
  };
  dirButton.addEventListener('click', () => {
    state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    localStorage.setItem('catalogue.dir', state.dir);
    paintDir();
    void load();
  });
  paintDir();

  // This page is the archive's root, so it deliberately has no back button.
  const panel = $('settingsPanel');
  $('settingsBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    panel.classList.toggle('open');
    $('setSort').textContent = '排序：' + $('sort').selectedOptions[0].textContent;
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest && event.target.closest('.menu,#settingsBtn')) return;
    panel.classList.remove('open');
  });
  $('setToken').addEventListener('click', () => {
    const value = prompt('上传口令（Cloudflare 环境变量 UPLOAD_TOKEN；本地开发留空即可）', state.token);
    if (value === null) return;
    state.token = value.trim();
    if (state.token) localStorage.setItem('catalogue.token', state.token);
    else localStorage.removeItem('catalogue.token');
    panel.classList.remove('open');
    tip(state.token ? '已保存上传口令' : '已清除上传口令', 'ok');
    void load();
  });
  $('setSort').addEventListener('click', () => {
    panel.classList.remove('open');
    $('sort').focus();
  });

  void load();
  // The same background/theme controls the viewer has, sharing one settings object.
  // Guarded: a problem here must cost the settings button, never the catalogue.
  mountPageTheme().catch((error) => console.warn('backgrounds/themes unavailable', error));
  // Whether the game folders are already cached decides two things: what a card
  // promises (with them an upload generates the viewer data by itself) and whether the
  // protagonist flags can be captioned with a localised country name. Both caches are
  // read once, then the cards are re-rendered. Neither failure is fatal.
  Promise.all([cachedMap().catch(() => undefined), cachedTables().catch(() => undefined)])
    .then(([map, tables]) => {
      state.gameReady = Boolean(map);
      if (tables && tables.names) state.names = tables.names;
      render();
    })
    .catch(() => {});
  // Tells the boot watchdog in index.html that the UI is wired and alive.
  window.__appReady = true;
})();
