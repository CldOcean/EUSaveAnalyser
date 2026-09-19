/*
 * The viewer's client script: one IIFE that reads the globals set just before it.
 *
 * Shared by both hosts, which is why it is a classic script and not a module:
 *
 *   offline  scripts/render-timeline.ts writes a self-contained HTML file and
 *            interpolates this file's text into it.
 *   hosted   apps/site/public/viewer.html loads it with <script src>.
 *
 * Globals it expects, all declared by the host before this file runs:
 *
 *   DATA     the data plane from viewer-build.js
 *   RASTER   province-id image, split across the R and G channels
 *   BG       wallpaper URLs
 *   ALIAS    DATA.tagAlias, hoisted for the tag-resolution hot paths
 *   VIEWER_ASSETS   optional; where the flag PNGs live (see below)
 *
 * It also mounts the shared background/theme component, which both hosts hand over as
 * globals (mountPageTheme / loadSettings / saveSettings): the generated page inlines
 * apps/site/public/page-theme.js, the hosted page copies the module's exports onto
 * globalThis. The viewer no longer has a settings panel of its own — see the block
 * below the zoom code.
 *
 * Do not edit scripts/render-timeline.ts to change this - edit this file.
 */
(function () {
  // ---- facts and panel tables from the host ------------------------------
  // The markup is one shared file, so the numbers printed around the map arrive as
  // data rather than being baked in: the offline generator and the hosted page hand
  // over the same two objects. Without them the page still plays; it just has no
  // headline, no table rows, and a slider that cannot be dragged to the end.
  //
  // The document title is NOT set here: the player owns it and rewrites it with the
  // current frame's date on every draw.
  if (typeof VIEWER_FACTS !== 'undefined' && VIEWER_FACTS) {
    const factEls = document.querySelectorAll('[data-fact]');
    for (let i = 0; i < factEls.length; i += 1) {
      const key = factEls[i].getAttribute('data-fact');
      if (VIEWER_FACTS[key] !== undefined) factEls[i].textContent = String(VIEWER_FACTS[key]);
    }
    const sliderEl = document.getElementById('slider');
    if (sliderEl) sliderEl.max = String(DATA.months.length - 1);
    if (typeof VIEWER_PANELS !== 'undefined' && VIEWER_PANELS) {
      const bodies = {
        leaderBody: VIEWER_PANELS.leaders,
        cityBody: VIEWER_PANELS.cities,
        institutionBody: VIEWER_PANELS.institutions,
      };
      for (const id in bodies) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = bodies[id] || '';
      }
    }
  }

  // ---- one generic sorter for every table on the page --------------------
  // 第四对话任务书.md §3.3. The user asked for "所有类似列表" to sort from their header,
  // and the tables come from three different places — the host's own markup (the three
  // bottom tables), the province sheet, and every tab of the country drawer — so the
  // sorter is one function that works on whatever table[data-sortable] it is given.
  //
  // A column is sortable only when its <th> carries data-sort="num|date|text". The "#"
  // column carries none: it never sorts, and its own numbers are never rewritten — they
  // are the rank the renderer computed, which is what makes a sorted table still
  // comparable with the list it came from. A composite cell (a flag and a name, "4 / 5 /
  // 2") says what to sort it by through data-sort on the <td>.
  //
  // First click on a column: descending. Second: ascending. Then it cycles. Exactly one
  // header per table carries aria-sort. The sort is stable (Array.prototype.sort is, in
  // every engine this ships to), so equal values keep the order they arrived in and the
  // head of a tie is reproducible.
  //
  // A row whose cell count differs from the header is a *section* row — the ledger's
  // 收入 / 支出 separators are single colspan cells — so it stays put and the rows on
  // either side of it are sorted as their own block: a grouped table never scrambles
  // its groups.
  //
  // The chosen column is remembered by data-table name, which is how a panel that is
  // rebuilt on every frame comes back with the user's sort still on it.
  var sortState = {};

  /** The declared type of a header cell; anything unrecognised means plain text. */
  function sortTypeOf(th) {
    var type = th.getAttribute('data-sort');
    return type === 'num' || type === 'date' || type === 'text' ? type : 'text';
  }
  /**
   * One cell's sort key.
   *
   * num: the cell's own data-sort if it has one (that is how "4 / 5 / 2" sorts as 11),
   * otherwise its text with the grouping commas, the "%" and whitespace removed — plus a
   * leading "#", which is how the host prints a province id in 思潮发源地. Anything that
   * still will not read as a number is NaN, which compares as "last" in both directions
   * rather than as a small number.
   *
   * date: YYYY.M.D on the project's own ordinal scale. An empty cell, "—", "(now)" or
   * "在位" is NaN, so it lands at the end instead of at the year 0.
   */
  function sortCellValue(cell, type) {
    if (!cell) return type === 'text' ? '' : NaN;
    var override = cell.getAttribute ? cell.getAttribute('data-sort') : null;
    var raw = override !== null && override !== undefined && override !== ''
      ? override
      : (cell.textContent || '');
    var text = String(raw);
    if (type === 'text') return text;
    if (type === 'date') {
      var match = /^\s*(\d{1,4})\.(\d{1,2})\.(\d{1,2})\s*$/.exec(text);
      if (!match) return NaN;
      return Number(match[1]) * 372 + (Number(match[2]) - 1) * 31 + (Number(match[3]) - 1);
    }
    var digits = text.replace(/[#,%\s]/g, '');
    if (digits === '') return NaN;
    var value = Number(digits);
    return isFinite(value) ? value : NaN;
  }
  /** Ascending with dir=1, descending with dir=-1; unreadable values always last. */
  function compareSortValues(a, b, type, dir) {
    if (type === 'text') return dir * String(a).localeCompare(String(b), 'zh-CN');
    var na = Number(a);
    var nb = Number(b);
    var fa = isFinite(na);
    var fb = isFinite(nb);
    if (!fa && !fb) return 0;
    if (!fa) return 1;
    if (!fb) return -1;
    return dir * (na - nb);
  }
  /** Sort each run of data rows in a table body, leaving section rows where they are. */
  function sortTableBody(body, headerCount, colIndex, type, dir) {
    var rows = [];
    for (var i = 0; i < body.children.length; i += 1) rows.push(body.children[i]);
    var out = [];
    var block = [];
    function flush() {
      if (!block.length) return;
      block.sort(function (ra, rb) {
        return compareSortValues(
          sortCellValue(ra.cells[colIndex], type),
          sortCellValue(rb.cells[colIndex], type),
          type,
          dir,
        );
      });
      for (var k = 0; k < block.length; k += 1) out.push(block[k]);
      block = [];
    }
    for (var r = 0; r < rows.length; r += 1) {
      var row = rows[r];
      var cells = row.cells ? row.cells.length : 0;
      if (cells !== headerCount) {
        flush();
        out.push(row);
      } else {
        block.push(row);
      }
    }
    flush();
    // appendChild moves an existing child, so re-appending in order is the reorder.
    for (var m = 0; m < out.length; m += 1) body.appendChild(out[m]);
  }
  /** Write the arrow and the one aria-sort onto a table's header row. */
  function markSortHeader(table, colIndex, dir) {
    var ths = table.querySelectorAll('thead th');
    for (var i = 0; i < ths.length; i += 1) {
      var th = ths[i];
      var label = th.getAttribute('data-sort-text');
      if (label === null || label === undefined) {
        label = th.textContent || '';
        th.setAttribute('data-sort-text', label);
      }
      if (i !== colIndex) {
        th.removeAttribute('aria-sort');
        if (th.textContent !== label) th.textContent = label;
        continue;
      }
      th.setAttribute('aria-sort', dir < 0 ? 'descending' : 'ascending');
      th.textContent = label + (dir < 0 ? ' ↓' : ' ↑');
    }
  }
  function applyTableSort(table, colIndex, type, dir) {
    var bodies = table.querySelectorAll('tbody');
    var headCount = table.querySelectorAll('thead th').length;
    for (var b = 0; b < bodies.length; b += 1) sortTableBody(bodies[b], headCount, colIndex, type, dir);
    markSortHeader(table, colIndex, dir);
  }
  /** Bind every declared header once; a re-render makes fresh nodes, so this is idempotent. */
  function makeSortable(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return;
    var tables = rootEl.querySelectorAll('table[data-sortable]');
    for (var t = 0; t < tables.length; t += 1) {
      var table = tables[t];
      var ths = table.querySelectorAll('thead th');
      for (var i = 0; i < ths.length; i += 1) {
        if (!ths[i].getAttribute('data-sort')) continue;
        if (ths[i].getAttribute('data-sort-bound') === '1') continue;
        bindSortHeader(table, ths[i], i);
      }
    }
  }
  function bindSortHeader(table, th, colIndex) {
    th.setAttribute('data-sort-bound', '1');
    th.addEventListener('click', function () {
      var name = table.getAttribute('data-table') || '';
      var previous = sortState[name];
      // First click descending, then ascending, then descending again.
      var dir = previous && previous.col === colIndex && previous.dir === -1 ? 1 : -1;
      sortState[name] = { table: name, col: colIndex, dir: dir };
      applyTableSort(table, colIndex, sortTypeOf(th), dir);
    });
  }
  /** Replay the remembered sort on freshly rendered markup (a panel rebuild keeps it). */
  function applyStoredSort(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return;
    var tables = rootEl.querySelectorAll('table[data-sortable]');
    for (var t = 0; t < tables.length; t += 1) {
      var table = tables[t];
      var state = sortState[table.getAttribute('data-table') || ''];
      if (!state) continue;
      var ths = table.querySelectorAll('thead th');
      var th = state.col < ths.length ? ths[state.col] : null;
      if (!th || !th.getAttribute('data-sort')) continue;
      applyTableSort(table, state.col, sortTypeOf(th), state.dir);
    }
  }
  // The three host tables are in the page from the start; the sheet's tables are bound as
  // they are rendered (see paintDetail).
  makeSortable(document);

  // ---- the two rankings (第四对话任务书.md §3.4 / §3.6) ------------------
  // The data plane packs 'rankings': fifteen generals and fifteen monarchs, already scored and
  // already ordered, plus the meta that says how they were scored and how much of the save's
  // war record could be matched to a leader at all. The page only *draws* them — it never
  // re-scores — and the note under each heading is built from that same meta, so the weights
  // and the coverage on screen are the plane's own numbers rather than a second copy.
  //
  // An older payload has no 'rankings' at all: both tables then say 数据面待补 in one row
  // instead of throwing, which is what every other missing key does in this viewer.
  /** The country cell: its swatch, its flag and its Chinese name, and the name as sort key. */
  function rankingTagCell(tag) {
    const wanted = String(tag || '').toUpperCase();
    const at = tagIndex.get(wanted);
    const idx = at === undefined ? -1 : resolveLatest(at);
    const name = idx >= 0 ? tagName(idx) : wanted;
    if (idx < 0) return '<td data-sort="' + esc(name) + '">' + esc(name) + '</td>';
    // The same three pieces the host's leaderboard row uses, so 旗帜/配色 repaint this table
    // too: applyFlagSet() finds it through img.flag, applyColourMode() through .sw[data-tag].
    const colour = colourCss(idx, DATA.months[DATA.months.length - 1]);
    return '<td data-sort="' + esc(name) + '">' +
      '<span class="sw" data-tag="' + esc(wanted) + '" style="background:' + colour + '"></span>' +
      '<img class="flag" data-tag="' + esc(wanted) + '" alt="">' + esc(name) + '</td>';
  }
  /** '0.826' -> '82.6%'; anything unreadable is the dash, never NaN%. */
  function rateText(rate) {
    const value = Number(rate);
    return isFinite(value) ? (Math.round(value * 1000) / 10).toFixed(1) + '%' : DASH;
  }
  /** A one-decimal score — the precision the frozen shape asks for. */
  function scoreText(value) {
    const number = Number(value);
    return isFinite(number) ? number.toFixed(1) : DASH;
  }
  /** A development change: the sign is the point, so a gain is written with a +. */
  function signedText(value) {
    const number = Number(value);
    if (!isFinite(number)) return DASH;
    return (number > 0 ? '+' : '') + fmt(number);
  }
  function permilleText(value) {
    const number = Number(value);
    return isFinite(number) ? Math.round(number * 100) + '%' : DASH;
  }
  function countText(value) {
    const number = Number(value);
    return isFinite(number) ? fmt(number) : DASH;
  }
  function rankingsMissingRow(columns) {
    return '<tr><td colspan="' + columns + '">数据面待补：这一份数据面里还没有 rankings 键（旧产物，重新生成一次即可）。</td></tr>';
  }
  function generalsHtml(generals) {
    if (!generals.length) return rankingsMissingRow(12);
    return generals.map(function (entry, index) {
      return '<tr><td class="num">' + (index + 1) + '</td>' +
        '<td>' + esc(entry.name || DASH) + '</td>' +
        rankingTagCell(entry.tag) +
        '<td>' + esc(leaderKindLabel(entry.kind) || DASH) + '</td>' +
        '<td class="num">' + countText(entry.skill) + '</td>' +
        '<td class="num">' + countText(entry.battles) + '</td>' +
        '<td class="num">' + countText(entry.wins) + '</td>' +
        '<td class="num">' + rateText(entry.winRate) + '</td>' +
        '<td class="num">' + countText(entry.kills) + '</td>' +
        '<td class="num">' + countText(entry.taken) + '</td>' +
        '<td class="num">' + fmt(entry.net) + '</td>' +
        '<td class="num">' + scoreText(entry.score) + '</td></tr>';
    }).join('');
  }
  function monarchsHtml(monarchs) {
    if (!monarchs.length) return rankingsMissingRow(11);
    return monarchs.map(function (entry, index) {
      return '<tr><td class="num">' + (index + 1) + '</td>' +
        '<td>' + esc(entry.name || DASH) + '</td>' +
        rankingTagCell(entry.tag) +
        // 4 / 5 / 2 reads as ADM/DIP/MIL, but the column is really "how able was he", so the
        // cell sorts by the three-part total (the same override the panel's rulers table uses).
        '<td class="num" data-sort="' + countText(entry.stats) + '">' +
          fmt(entry.adm) + ' / ' + fmt(entry.dip) + ' / ' + fmt(entry.mil) + '</td>' +
        '<td class="num">' + countText(entry.stats) + '</td>' +
        '<td class="d">' + esc(entry.start || DASH) + '</td>' +
        '<td class="d">' + esc(entry.end || '在位') + '</td>' +
        '<td class="num">' + countText(entry.months) + '</td>' +
        '<td class="num">' + signedText(entry.devGain) + '</td>' +
        '<td class="num">' + fmt(entry.devPerYear) + '</td>' +
        '<td class="num">' + scoreText(entry.score) + '</td></tr>';
    }).join('');
  }
  function generalNoteText(rankings) {
    const meta = rankings.meta || {};
    const weights = (meta.weights && meta.weights.general) || {};
    const floors = meta.floors || {};
    const coverage = meta.coverage || {};
    const commanded = Number(coverage.commandedSides);
    const joined = Number(coverage.joinedSides);
    const rate = commanded > 0 && joined > 0 ? rateText(joined / commanded) : DASH;
    return '评分＝能力 ' + permilleText(weights.skill) + ' ＋ 净杀伤 ' + permilleText(weights.war) +
      ' ＋ 胜率 ' + permilleText(weights.win) + '（本存档内归一化）；只收参战 ≥ ' +
      countText(floors.minBattles) + ' 场的将领（候选池 ' + countText(meta.generalPool) + ' 名，过门槛 ' +
      countText(meta.generalQualified) + ' 名）；只统计能按「国家＋姓名」对上将领档案的战斗：' +
      countText(coverage.commandedSides) + ' 个指挥战斗方中 ' + countText(coverage.joinedSides) +
      ' 个对上（覆盖率 ' + rate + '）。';
  }
  function monarchNoteText(rankings) {
    const meta = rankings.meta || {};
    const weights = (meta.weights && meta.weights.monarch) || {};
    const floors = meta.floors || {};
    const months = Number(floors.minReignMonths);
    const years = isFinite(months) ? Math.round(months / 12) + ' 年' : DASH;
    return '评分＝能力 ' + permilleText(weights.ability) + ' ＋ 在位时长 ' + permilleText(weights.tenure) +
      ' ＋ 在位发展度增量 ' + permilleText(weights.growth) + ' ＋ 年均发展度增速 ' + permilleText(weights.pace) +
      '（本存档内归一化）；只收在位 ≥ ' + years + '、且存档里有完整任职链的君主（候选池 ' +
      countText(meta.monarchPool) + ' 名）。';
  }
  function renderRankings() {
    const generalBody = document.getElementById('generalBody');
    const monarchBody = document.getElementById('monarchBody');
    const generalNote = document.getElementById('generalNote');
    const monarchNote = document.getElementById('monarchNote');
    const rankings = DATA.rankings && typeof DATA.rankings === 'object' ? DATA.rankings : null;
    const generals = rankings && Array.isArray(rankings.generals) ? rankings.generals : [];
    const monarchs = rankings && Array.isArray(rankings.monarchs) ? rankings.monarchs : [];
    if (generalBody) generalBody.innerHTML = generalsHtml(generals);
    if (monarchBody) monarchBody.innerHTML = monarchsHtml(monarchs);
    if (generalNote) generalNote.textContent = rankings ? generalNoteText(rankings) : '数据面待补。';
    if (monarchNote) monarchNote.textContent = rankings ? monarchNoteText(rankings) : '数据面待补。';
  }

  const FIELD = {};
  DATA.provinceFields.forEach((f, i) => { FIELD[f] = i; });
  const CFIELD = {};
  DATA.countryFields.forEach((f, i) => { CFIELD[f] = i; });

  // ---- province state, indexed directly by province id -------------------
  const provCount = 70000;
  const owner = new Int16Array(provCount).fill(-1);
  const controller = new Int16Array(provCount).fill(-1);
  const religion = new Int16Array(provCount).fill(-1);
  const culture = new Int16Array(provCount).fill(-1);
  const tax = new Float32Array(provCount);
  const production = new Float32Array(provCount);
  const manpower = new Float32Array(provCount);
  /** Holy Roman Empire membership per province: index into the 'hre' dictionary. */
  const hre = new Int16Array(provCount).fill(-1);
  const numeric = [tax, production, manpower];
  function numericSlot(fieldIdx) {
    if (fieldIdx === FIELD.base_tax) return 0;
    if (fieldIdx === FIELD.base_production) return 1;
    return 2;
  }
  function applyProvince(fieldIdx, id, valIdx) {
    if (id <= 0 || id >= provCount) return;
    if (fieldIdx === FIELD.owner) { owner[id] = valIdx; return; }
    if (fieldIdx === FIELD.controller) { controller[id] = valIdx; return; }
    if (fieldIdx === FIELD.religion) { religion[id] = valIdx; return; }
    if (fieldIdx === FIELD.culture) { culture[id] = valIdx; return; }
    if (fieldIdx === FIELD.hre) { hre[id] = valIdx; return; }
    const slot = numericSlot(fieldIdx);
    const raw = DATA.provinceDicts[fieldIdx][valIdx];
    numeric[slot][id] = valIdx < 0 || raw === undefined ? 0 : Number(raw) || 0;
  }

  // ---- country state ----------------------------------------------------
  const cCount = DATA.tags.length;
  const cReligion = new Int16Array(cCount).fill(-1);
  /** tag index -> dynasty index. */
  const dynastyOf = new Int16Array(cCount).fill(-1);
  function applyCountry(fieldIdx, tagIdx, valIdx) {
    if (tagIdx < 0 || tagIdx >= cCount) return;
    if (fieldIdx === CFIELD.religion) cReligion[tagIdx] = valIdx;
    else if (fieldIdx === CFIELD.dynasty) dynastyOf[tagIdx] = valIdx;
  }

  // ---- Holy Roman Empire ------------------------------------------------
  // NOTE: the palette constant C (DATA.constants) is not initialized until the
  // palette section below, so anything reading it must live after that line. A
  // top-level constant assigned from the palette here is a temporal-dead-zone
  // error that kills the whole player: blank map, dead view buttons, empty chart.
  const hreYes = DATA.provinceDicts[FIELD.hre].indexOf('yes');
  const electorSet = new Set(DATA.hre.electors);
  const freeCitySet = new Set(DATA.hre.freeCities);
  const capitalOf = new Map();
  for (const row of DATA.hre.capitals) capitalOf.set(row[0], row[1]);
  /** A country is in the empire when its capital province is HRE land. */
  function isHreMember(tagIdx) {
    const capital = capitalOf.get(tagIdx);
    if (capital === undefined) return false;
    return hre[capital] === hreYes;
  }
  function hreEmperorAt(ord) {
    let current = -1;
    for (const row of DATA.hre.emperorEvents) {
      if (row[0] > ord) break;
      current = row[1];
    }
    return current;
  }

  // ---- the tag aliases, applied by the viewer ---------------------------
  // Resolved server-side into DATA.tagAlias: [tagIdx, ord, successorIdx]
  function resolveOwner(tagIdx, ord) {
    let cur = tagIdx;
    for (let i = 0; i < ALIAS.length; i++) {
      const a = ALIAS[i];
      if (a[0] === cur && a[1] <= ord) { cur = a[2]; i = -1; }
    }
    return cur;
  }
  function resolveLatest(tagIdx) {
    let cur = tagIdx;
    for (let i = 0; i < ALIAS.length; i++) {
      const a = ALIAS[i];
      if (a[0] === cur) { cur = a[2]; i = -1; }
    }
    return cur;
  }

  let cursor = 0;
  let ccursor = 0;
  function reset() {
    owner.fill(-1); controller.fill(-1); religion.fill(-1); culture.fill(-1);
    hre.fill(-1);
    tax.fill(0); production.fill(0); manpower.fill(0);
    for (const row of DATA.provinceInit) applyProvince(row[1], row[0], row[2]);
    cReligion.fill(-1);
    dynastyOf.fill(-1);
    for (const row of DATA.countryInit) applyCountry(row[1], row[0], row[2]);
    // BOTH cursors must rewind. Missing one here leaves the country state
    // cleared but never refilled, because its forward-only cursor has already
    // run past the end: every province then falls back to the grey "unknown"
    // colour (this is what made the dynasty view entirely grey).
    cursor = 0;
    ccursor = 0;
  }
  function advanceTo(ord) {
    const ev = DATA.provinceEvents;
    while (cursor < ev.length && ev[cursor][0] <= ord) {
      const r = ev[cursor++];
      applyProvince(r[2], r[1], r[3]);
    }
  }
  function advanceCountries(ord) {
    const ev = DATA.countryEvents;
    while (ccursor < ev.length && ev[ccursor][0] <= ord) {
      const r = ev[ccursor++];
      applyCountry(r[2], r[1], r[3]);
    }
  }

  // ---- raster -> province id per pixel ----------------------------------
  // One embedded image, two quality levels: "原生" paints every raster pixel,
  // "一半" derives a half-size province map from it, which quarters the per-frame
  // paint cost — the difference between stuttering and smooth at high speed.
  const canvas = document.getElementById('map');
  const ctx = canvas.getContext('2d');
  /**
   * The hover layer, and the buffers it paints through.
   *
   * A highlight has to be redrawn on every mouse move while the map's own pixels are
   * only rewritten when the frame changes, so it lives on a second canvas stacked over
   * the first. Its backing store follows the raster (applyRaster resizes both), it is
   * CSS-matched to #map, and applyView writes the same transform to the two of them —
   * the one place a view change is allowed to come out of.
   */
  const hoverCanvas = document.getElementById('hover');
  const hoverCtx = hoverCanvas ? hoverCanvas.getContext('2d') : null;
  const base = new Uint32Array(provCount);
  const hatch = new Uint32Array(provCount);
  const waterIds = new Set(DATA.waterSea.concat(DATA.waterLakes));
  let W = 0, H = 0;
  let pixels = new Uint16Array(0);
  let borderMask = new Uint8Array(0);
  let rgba = new Uint8ClampedArray(0);
  let imageData = null;
  /** The hover layer's own pixels: same size as the map's, written and blitted alone. */
  let hoverRGBA = new Uint8ClampedArray(0);
  let hoverImageData = null;
  let fullPixels = null;
  let rasterReady = false;
  // Half resolution is the default: it paints 4x fewer pixels per frame, which is
  // what keeps high playback speeds smooth on ordinary hardware. The native mode
  // is one click away when inspecting borders matters more than speed.
  let quality = 'half';

  /**
   * Halve the province map by 2x2 majority vote. Nearest sampling (what the
   * build-time --scale 2 does) drops provinces that are one pixel wide; the
   * vote keeps anything holding a majority of the block.
   */
  function halfIds(ids, w, h) {
    const dw = w >> 1, dh = h >> 1;
    const out = new Uint16Array(dw * dh);
    for (let y = 0; y < dh; y += 1) {
      const row0 = y * 2 * w, row1 = row0 + w, dst = y * dw;
      for (let x = 0; x < dw; x += 1) {
        const a = ids[row0 + x * 2], b = ids[row0 + x * 2 + 1];
        const c = ids[row1 + x * 2], d = ids[row1 + x * 2 + 1];
        out[dst + x] = (a === b || a === c || a === d) ? a : (b === c || b === d) ? b : a;
      }
    }
    return out;
  }

  function applyRaster(ids, w, h) {
    W = w; H = h;
    pixels = ids;
    borderMask = buildBorderMask(pixels, W, H, waterIds);
    rgba = new Uint8ClampedArray(W * H * 4);
    imageData = new ImageData(rgba, W, H);
    // The canvas keeps its CSS size; only the backing store changes.
    canvas.width = W;
    canvas.height = H;
    // The hover layer follows the raster exactly: same intrinsic size, its own buffer.
    // Every highlight index list cached for the previous raster is dropped with it,
    // because the offsets in it point at pixels that no longer exist.
    hoverIds.clear();
    hoveredId = 0;
    hoverPainted = false;
    hoverRGBA = new Uint8ClampedArray(W * H * 4);
    hoverImageData = new ImageData(hoverRGBA, W, H);
    if (hoverCanvas) {
      hoverCanvas.width = W;
      hoverCanvas.height = H;
    }
    rasterReady = true;
    clampView();
    applyView();
    // Re-resolve the highlight against the new buffer and the (possibly new) box.
    refreshHoverAfterViewChange();
  }

  const img = new Image();
  img.onload = function () {
    const off = document.createElement('canvas');
    off.width = DATA.w; off.height = DATA.h;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0);
    const d = octx.getImageData(0, 0, DATA.w, DATA.h).data;
    const ids = new Uint16Array(DATA.w * DATA.h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      ids[p] = (d[i] << 8) | d[i + 1];
    }
    fullPixels = ids;
    if (quality === 'half') {
      applyRaster(halfIds(ids, DATA.w, DATA.h), DATA.w >> 1, DATA.h >> 1);
    } else {
      applyRaster(ids, DATA.w, DATA.h);
    }
    draw();
  };
  img.src = RASTER;

  // ---- the phone, as the script sees it ----------------------------------
  /**
   * True on a touch-first device.
   *
   * The stylesheet asks the same question for the layout (the pointer:coarse media query),
   * but two behaviours are decisions rather than styles — the default playback speed and the
   * resolution button — so they need an answer in script too (第四对话任务书.md §4.3 C3).
   * Only pointer:coarse counts here: a narrow desktop window gets the phone *layout* (a
   * 600px-wide table is unreadable either way) while keeping its mouse defaults. No
   * matchMedia at all — the DOM stub, a very old browser — means desktop.
   */
  function isCoarsePointer() {
    if (typeof window.matchMedia !== 'function') return false;
    try {
      return window.matchMedia('(pointer:coarse)').matches === true;
    } catch (error) {
      void error;
      return false;
    }
  }

  // ---- resolution toggle -------------------------------------------------
  const resBtn = document.getElementById('res');
  /** What a phone is told when it asks for the native raster (§4.3 C3 item 4). */
  const MOBILE_RES_TEXT = '手机上不支持原生分辨率';
  function updateResLabel() {
    if (isCoarsePointer()) {
      // The native raster is 4x the memory of the half one: the difference between a map
      // that scrolls smoothly on a phone and one that does not.
      resBtn.textContent = '分辨率：一半（手机）';
      resBtn.title = MOBILE_RES_TEXT + '；手机上固定一半分辨率';
      return;
    }
    resBtn.textContent = quality === 'native' ? '分辨率：原生' : '分辨率：一半';
    resBtn.title = quality === 'native'
      ? '当前为原生 ' + DATA.w + 'x' + DATA.h + '；点击切到一半（播放更流畅）'
      : '当前为一半分辨率（更快）；点击切回原生';
  }
  resBtn.addEventListener('click', function () {
    // A phone gets the sentence, not a switch: the half raster is already the default and
    // staying on it is the whole point.
    if (isCoarsePointer()) {
      resBtn.textContent = MOBILE_RES_TEXT;
      resBtn.title = MOBILE_RES_TEXT;
      return;
    }
    if (!fullPixels) return;
    quality = quality === 'native' ? 'half' : 'native';
    if (quality === 'half') {
      applyRaster(halfIds(fullPixels, DATA.w, DATA.h), DATA.w >> 1, DATA.h >> 1);
    } else {
      applyRaster(fullPixels, DATA.w, DATA.h);
    }
    updateResLabel();
    draw();
  });
  updateResLabel();

  // ---- palettes ---------------------------------------------------------
  const C = DATA.constants;
  /** Unclaimed land, and the same neutral grey the HRE view paints outside it. */
  const cardUnowned = C.unowned;
  const seaSet = new Set(DATA.waterSea);
  const lakeSet = new Set(DATA.waterLakes);

  /**
   * Which colour a tag shows at a given date.
   *
   * 'colourMode' is declared here rather than with the other settings because this
   * function is defined above them; the settings section assigns it the remembered
   * value before anything is drawn.
   *
   *   mod        what the save draws — the recolouring mod's result
   *   original   the country's own colour, as the game files define it (a colonial
   *              nation's is derived from its mother country: the save writes
   *              '255 255 255', the engine's placeholder, into its 'color')
   *   subject    a subject follows its overlord, shaded ΔE 8–14 towards the same
   *              colour family so the two read as related but distinct
   *
   * A subject only takes the new colour once the relation has begun; before that it is
   * its own colour. Independence needs no case of its own: the country is simply absent
   * from the ledger. Its *colour*, though, may still be somebody else's — a recolouring
   * mod writes the overlord's colour into the save, restoring it is a decision somebody
   * has to take, and the mods paint 朝贡国 too because EU4 counts tributaries as subjects.
   * foreignTint marks those, and 属国染色 shows them their own colour rather than a
   * relationship it does not acknowledge (foreignTintFlags in colours.ts). 模组色 stays
   * faithful: the game really does draw that colour.
   */
  let colourMode = 'mod';

  function colourOf(tagIdx, ord) {
    if (tagIdx < 0) return C.unowned;
    const palette = DATA.colours;
    if (!palette) return DATA.tagColors[tagIdx] || C.unowned; // data built before this feature
    if (colourMode === 'original') return palette.original[tagIdx];
    const from = palette.from[tagIdx];
    const subjectNow = from >= 0 && ord >= from;
    // A country that *will* be a subject shows its own colour until the relation
    // begins; one that is nobody's subject simply shows what the save draws.
    const before = from >= 0 ? palette.original[tagIdx] : palette.mod[tagIdx];
    if (colourMode === 'subject') {
      if (subjectNow) return palette.subject[tagIdx];
      return palette.foreignTint && palette.foreignTint[tagIdx] ? palette.original[tagIdx] : before;
    }
    return subjectNow ? palette.mod[tagIdx] : before;
  }

  /** The swatch colour for a tag, for the panels the host built as HTML. */
  function colourCss(tagIdx, ord) {
    return '#' + (colourOf(tagIdx, ord) || 0x888888).toString(16).padStart(6, '0');
  }

  function buildColors(view, ord) {
    base.fill(C.unowned);
    hatch.fill(0);
    // terrain
    for (let i = 0; i < pixels.length; i += 1) {
      const id = pixels[i];
      if (id === 0) { base[0] = C.none; continue; }
      if (seaSet.has(id)) base[id] = C.sea;
      else if (lakeSet.has(id)) base[id] = C.lake;
    }
    if (view === 'development') {
      const maxDev = C.maxDev || 1;
      for (const id of DATA.provinceIds) {
        if (seaSet.has(id) || lakeSet.has(id)) continue;
        const dev = tax[id] + production[id] + manpower[id];
        base[id] = dev === 0 ? C.unowned : devRamp(Math.sqrt(dev / maxDev));
      }
      return;
    }
    if (view === 'battle') {
      // Cumulative: every battle up to this month adds to its province's score,
      // so the map reddens over the campaign rather than flashing month by month.
      // Land and sea are accumulated separately and normalised separately, so sea
      // battles can use the blue->red ramp without being swamped by land ones.
      const upto = monthOfOrdinal(DATA.months[idx]);
      // Quiet land is plain white; everything that is not land (sea and lakes) is
      // the user's requested pale blue #ABC7E2, so the ocean reads as empty water
      // until a naval battle colours it with the blue -> red ramp.
      for (const id of DATA.provinceIds) {
        base[id] = seaSet.has(id) || lakeSet.has(id) ? packRgb(171, 199, 226) : packRgb(246, 246, 246);
      }
      const land = new Map();
      const sea = new Map();
      for (const row of DATA.battles) {
        if (row[0] > upto) continue;
        const bucket = row[6] === 1 ? sea : land;
        bucket.set(row[1], (bucket.get(row[1]) || 0) + row[2]);
      }
      for (const [id, score] of land) base[id] = battleRamp(score / (C.maxBattleScore || 1));
      for (const [id, score] of sea) {
        // A province with both kinds shows whichever was fought more.
        if ((land.get(id) || 0) <= score) base[id] = navalRamp(score / (C.maxNavalScore || 1));
      }
      return;
    }
    if (view === 'dynasty') {
      // Dynasty is a country attribute: resolve to the surviving tag, then read
      // its dynasty at this date. No hatching.
      for (const id of DATA.provinceIds) {
        if (seaSet.has(id) || lakeSet.has(id)) continue;
        const ownerIdx = owner[id];
        if (ownerIdx < 0) { base[id] = C.unowned; continue; }
        const d = dynastyOf[resolveLatest(ownerIdx)];
        base[id] = d >= 0 ? (DATA.dynastyColors[d] || C.unowned) : cardUnowned;
      }
      return;
    }
    if (view === 'hre') {
      // Outside the empire everything is the neutral grey; inside, colour by the
      // owner's role. HRE land held by an outsider is hatched instead.
      const emperorIdx = hreEmperorAt(ord);
      for (const id of DATA.provinceIds) {
        if (seaSet.has(id) || lakeSet.has(id)) continue;
        base[id] = cardUnowned;
        if (hre[id] !== hreYes) continue;
        const ownerIdx = owner[id];
        if (ownerIdx < 0) continue;
        const latest = resolveLatest(ownerIdx);
        if (latest === emperorIdx) base[id] = C.hre.emperor;
        else if (electorSet.has(latest)) base[id] = C.hre.elector;
        else if (freeCitySet.has(latest)) base[id] = C.hre.freeCity;
        else if (isHreMember(latest)) base[id] = C.hre.member;
        else base[id] = C.hre.foreign;
        // An occupier from outside the empire gets the hatching.
        const ctlIdx = controller[id];
        if (ctlIdx >= 0) {
          const ctlLatest = resolveLatest(ctlIdx);
          if (!isHreMember(ctlLatest) && ctlLatest !== emperorIdx && !electorSet.has(ctlLatest) && !freeCitySet.has(ctlLatest)) {
            hatch[id] = colourOf(resolveOwner(ctlIdx, ord), ord) || C.unowned;
          }
        }
      }
      return;
    }
    if (view === 'tech') {
      // Snapshot view: relative, weakest country reddest, strongest greenest.
      const span = C.techMax - C.techMin;
      for (const id of DATA.provinceIds) {
        if (seaSet.has(id) || lakeSet.has(id)) continue;
        const ownerIdx = owner[id];
        if (ownerIdx < 0) { base[id] = C.unowned; continue; }
        const level = DATA.tagTech[resolveOwner(ownerIdx, ord)] || 0;
        base[id] = level > 0 ? techRamp(span > 0 ? (level - C.techMin) / span : 1) : C.unowned;
      }
      return;
    }
    if (view === 'institution') {
      // Snapshot view: relative, and hatched while an institution is in progress.
      const span = C.instMax - C.instMin;
      const norm = (level) => (span > 0 ? (level - C.instMin) / span : 1);
      for (const id of DATA.provinceIds) {
        if (seaSet.has(id) || lakeSet.has(id)) continue;
        const info = institutionById.get(id);
        if (!info) { base[id] = C.unowned; continue; }
        base[id] = institutionRamp(norm(info[0]));
        if (info[1] >= 0) hatch[id] = institutionRamp(norm(info[1] + 1));
      }
      return;
    }
    for (const id of DATA.provinceIds) {
      if (seaSet.has(id) || lakeSet.has(id)) continue;
      const ownerIdx = owner[id];
      const ctlIdx = controller[id];
      // Two different questions, two different resolutions:
      //   * which COLOUR?  date-aware, so Muscovy is Muscovy until it renames
      //     itself, and Russia's green only appears from the rename onwards;
      //   * is this an OCCUPATION? identity-based, so the old and new tag of the
      //     same country never count as occupying each other.
      const ownerTag = ownerIdx >= 0 ? resolveOwner(ownerIdx, ord) : -1;
      const ctlTag = ctlIdx >= 0 ? resolveOwner(ctlIdx, ord) : -1;
      const sameCountry =
        ownerIdx >= 0 &&
        ctlIdx >= 0 &&
        resolveLatest(ownerIdx) === resolveLatest(ctlIdx);

      if (view === 'religion') {
        base[id] = religion[id] >= 0 ? DATA.religionColors[religion[id]] : C.unowned;
        // The religion physically present: the occupier's if occupied, else the
        // owner's. A country of faith X over a province of faith X leaves the
        // province colour alone; only a mismatch earns hatching.
        const presence = sameCountry
          ? cReligion[resolveLatest(ownerIdx)]
          : cReligion[resolveLatest(ctlIdx)];
        if (presence >= 0 && presence !== religion[id]) {
          hatch[id] = DATA.religionColors[presence] || C.unowned;
        }
        continue;
      }
      if (view === 'culture') {
        // Plain fill: no hatching in the culture view.
        base[id] = culture[id] >= 0 ? DATA.cultureColors[culture[id]] : C.unowned;
        continue;
      }
      base[id] = ownerTag >= 0 ? colourOf(ownerTag, ord) : C.unowned;
      if (ownerTag >= 0 && ctlTag >= 0 && !sameCountry) {
        hatch[id] = colourOf(ctlTag, ord);
      }
    }
  }

  // ---- battles, bucketed by year*12+month --------------------------------
  const battleIndex = new Map();
  for (const row of DATA.battles) {
    let list = battleIndex.get(row[0]);
    if (!list) { list = []; battleIndex.set(row[0], list); }
    list.push(row);
  }
  function battlesOf(monthKey) { return battleIndex.get(monthKey) || []; }
  function monthOfOrdinal(ord) {
    const year = Math.floor(ord / 372);
    const month = Math.floor((ord - year * 372) / 31);
    return year * 12 + (month - 1);
  }
  const institutionById = new Map();
  for (const row of DATA.provinceInstitutions) institutionById.set(row[0], [row[1], row[2]]);

  // ---- frame loop -------------------------------------------------------
  let idx = 0, view = 'political', timer = null, finished = false;
  const slider = document.getElementById('slider');
  const dateEl = document.getElementById('date');
  const statsEl = document.getElementById('stats');
  const playBtn = document.getElementById('play');
  const viewBtns = {
    political: 'vPol', religion: 'vRel', culture: 'vCul', development: 'vDev',
    tech: 'vTech', institution: 'vIns', dynasty: 'vDyn', hre: 'vHre', battle: 'vBat',
  };
  const HATCHED = { political: true, religion: true, institution: true, hre: true };
  const LAST = DATA.months.length - 1;
  // The ImageData buffer is allocated in applyRaster() and reused for the whole
  // session; allocating ~46 MB per frame was what made scrubbing stutter.

  /**
   * The play button shows "restart" only in the two states that warrant it: the
   * cursor sits on the last frame, or a full run just finished. Any manual move —
   * dragging the slider or an arrow key — drops that state, so a mid-timeline
   * pause always reads as a plain play button.
   */
  function syncPlayButton() {
    if (timer) return;
    const restart = finished || idx >= LAST;
    playBtn.textContent = restart ? '↻' : '▶';
    playBtn.classList.remove('on');
    playBtn.title = restart ? '重新播放' : '播放';
  }

  /** Move the cursor because the *user* asked: clears the "just finished" state. */
  function goTo(next) {
    idx = Math.max(0, Math.min(LAST, next));
    finished = false;
    draw();
  }

  function draw() {
    const ord = DATA.months[idx];
    // Replay from scratch every frame. It costs ~1 ms and removes a whole class
    // of state-drift bugs when the slider is dragged back and forth.
    reset();
    advanceTo(ord);
    advanceCountries(ord);
    buildColors(view, ord);
    if (rasterReady) {
      paintMap(pixels, rgba, W, H, base, hatch, borderMask, C.stripePeriod, C.stripeWidth,
               HATCHED[view] === true);
      ctx.putImageData(imageData, 0, 0);
    }
    dateEl.textContent = DATA.monthLabels[idx];
    statsEl.textContent = describe();
    slider.value = String(idx);
    document.title = DATA.monthLabels[idx] + ' — 版图时间线';
    drawChart();
    syncPlayButton();
    // The detail sheet reads the same replay, so it is refreshed from the state that was
    // just rebuilt rather than from a copy taken when it was opened. This is what makes
    // dragging the timeline rewrite the province's owner, religion and development live.
    refreshDetailLive();
  }

  function describe() {
    const ord = DATA.months[idx];
    if (view === 'political') {
      let occ = 0;
      for (const id of DATA.provinceIds) {
        const o = owner[id], c = controller[id];
        // controller is already -1 for rebels, so this cannot count them.
        if (o >= 0 && c >= 0 && resolveLatest(o) !== resolveLatest(c)) occ++;
      }
      return occ ? ('该月有 ' + occ + ' 个省份处于被占领状态（不含叛军）') : '';
    }
    if (view === 'battle') {
      const upto = monthOfOrdinal(ord);
      const rows = [];
      for (const r of DATA.battles) if (r[0] === upto) rows.push(r);
      if (!rows.length) return '该月没有发生战斗（地图为历史累计）';
      let worst = rows[0], total = 0;
      for (const r of rows) { total += r[5]; if (r[5] > worst[5]) worst = r; }
      const name = (tagIdx) => tagIdx >= 0 ? DATA.countryNames[tagIdx] : '?';
      return '该月 ' + rows.length + ' 场战斗，伤亡 ' + total.toLocaleString() +
        '；最惨烈：' + name(worst[3]) + ' vs ' + name(worst[4]) +
        '（' + worst[5].toLocaleString() + ' 人）';
    }
    if (view === 'development') return '发展度 = 基础税收 + 生产 + 人力（随开发变化）';
    if (view === 'tech') {
      return '存档当日快照（无科技时间线，拖动时间轴不会变化）：最弱 ' + C.techMin +
        '、最强 ' + C.techMax + '，相对着色';
    }
    if (view === 'institution') {
      return '存档当日快照（无思潮时间线）：已接纳 ' + C.instMin + '–' + C.instMax +
        '，斜线＝正在接纳的思潮';
    }
    if (view === 'dynasty') return '按在位君主的王朝着色（君主即位日期来自国家历史；无官方王朝颜色表，颜色为按名称生成）';
    if (view === 'hre') {
      const emperor = hreEmperorAt(ord);
      const name = emperor >= 0 ? DATA.countryNames[emperor] : '无';
      return '神罗：皇帝 ' + name + '｜金＝皇帝，紫＝选帝侯，蓝＝自由市，绿灰＝其他成员，棕＝神罗土地被外部国家持有；斜线＝被神罗外国家占领';
    }
    return '';
  }

  // ---- power-curve chart -------------------------------------------------
  const chart = document.getElementById('chart');
  const chartLegend = document.getElementById('chartLegend');
  let hiddenSeries = new Set();
  function drawChart() {
    if (!chart || !DATA.curves) return;
    const W = 1200, H = 690, PAD = 44;
    const series = DATA.curves.dev;
    let max = 1;
    for (const row of series) for (const v of row) if (v > max) max = v;
    const n = DATA.months.length;
    const x = (i) => PAD + (i / Math.max(1, n - 1)) * (W - PAD * 2);
    const y = (v) => H - PAD - (v / max) * (H - PAD * 2);
    const parts = [
      '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '" style="stroke:var(--chart-axis)"/>',
      '<line x1="' + PAD + '" y1="' + PAD + '" x2="' + PAD + '" y2="' + (H - PAD) + '" style="stroke:var(--chart-axis)"/>',
      '<text x="' + PAD + '" y="' + (PAD - 8) + '" style="fill:var(--chart-label)" font-size="12">发展度 ' + max.toLocaleString() + '</text>',
    ];
    DATA.curves.tags.forEach(function (tagIdx, s) {
      if (hiddenSeries.has(s)) return;
      const color = colourCss(tagIdx, DATA.months[idx]);
      let d = '';
      for (let i = 0; i < n; i += 1) d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(series[s][i]).toFixed(1);
      parts.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" opacity="0.92"/>');
    });
    // marker for the current month
    const ci = idx;
    parts.push('<line x1="' + x(ci) + '" y1="' + PAD + '" x2="' + x(ci) + '" y2="' + (H - PAD) + '" style="stroke:var(--accent)" stroke-dasharray="4 4"/>');
    DATA.curves.tags.forEach(function (tagIdx, s) {
      if (hiddenSeries.has(s)) return;
      parts.push('<circle cx="' + x(ci) + '" cy="' + y(series[s][ci]) + '" r="3.5" style="fill:var(--accent)"/>');
    });
    parts.push('<text x="' + (W - PAD) + '" y="' + (H - PAD + 20) + '" style="fill:var(--chart-label)" font-size="12" text-anchor="end">' + DATA.monthLabels[n - 1] + '</text>');
    chart.innerHTML = parts.join('');
  }
  function drawChartLegend() {
    if (!chartLegend || !DATA.curves) return;
    chartLegend.innerHTML = DATA.curves.tags.map(function (tagIdx, s) {
      const color = colourCss(tagIdx, DATA.months[idx]);
      return '<span class="chip' + (hiddenSeries.has(s) ? ' off' : '') + '" data-slot="' + s + '">' +
        '<span class="sw" style="background:' + color + '"></span>' +
        '<img class="flag" data-tag="' + DATA.tags[tagIdx] + '" alt="">' +
        DATA.countryNames[tagIdx] + '</span>';
    }).join('');
    Array.prototype.forEach.call(chartLegend.querySelectorAll('.chip'), function (chip) {
      chip.addEventListener('click', function () {
        const slot = Number(chip.getAttribute('data-slot'));
        if (hiddenSeries.has(slot)) hiddenSeries.delete(slot); else hiddenSeries.add(slot);
        drawChart(); drawChartLegend(); applyFlagSet();
      });
    });
  }
  drawChartLegend();

  function stopPlayback(restartIcon) {
    if (timer) { clearInterval(timer); timer = null; }
    if (restartIcon) {
      playBtn.textContent = '↻';
      playBtn.classList.remove('on');
      playBtn.title = '重新播放';
    } else {
      syncPlayButton();
    }
  }

  slider.addEventListener('input', function () { goTo(Number(slider.value)); });
  Object.keys(viewBtns).forEach(function (key) {
    document.getElementById(viewBtns[key]).addEventListener('click', function () {
      view = key;
      Object.keys(viewBtns).forEach(function (k) {
        document.getElementById(viewBtns[k]).classList.toggle('on', k === key);
      });
      draw();
    });
  });
  // ---- playback speed ---------------------------------------------------
  // The shipped default of 90 ms per frame is defined as 3x, so 1x is 270 ms,
  // 5x is 54 ms, 10x is 27 ms and 20x is 14 ms. Changing speed mid-playback
  // restarts the interval immediately. The slider max must match SPEED_MAX here.
  const SPEED_BASE_MS = 270, SPEED_MAX = 20;
  const speedEl = document.getElementById('speed');
  const speedValEl = document.getElementById('speedVal');
  const speedUpEl = document.getElementById('speedUp');
  const speedDownEl = document.getElementById('speedDown');
  // A phone starts at 1×: the same frame costs it far more than a desktop, and the user
  // asked for smooth playback rather than a fast slideshow. Desktop stays at the markup's
  // 3× (§4.3 C3 item 4).
  if (isCoarsePointer()) speedEl.value = '1';
  function playbackSpeed() {
    const value = Number(speedEl.value) || 3;
    return value < 1 ? 1 : value > SPEED_MAX ? SPEED_MAX : value;
  }
  function intervalMs() {
    return Math.round(SPEED_BASE_MS / playbackSpeed());
  }
  function tick() {
    if (idx >= LAST) {
      // Reached the end: pause, rewind, and offer a restart.
      finished = true;
      idx = 0;
      draw();
      stopPlayback(true);
      return;
    }
    idx += 1;
    draw();
  }
  function startTimer() {
    stopTimer();
    timer = setInterval(tick, intervalMs());
  }
  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  function syncSpeedLabel() {
    const speed = playbackSpeed();
    // One line of warning past 8× on a phone, where the frame really is the bottleneck.
    const slow = isCoarsePointer() && speed > 8 ? '（手机高倍速可能掉帧）' : '';
    speedValEl.textContent = speed + '×' + slow;
    speedEl.title = '播放速度 ' + speed + ' 倍（1 倍 = ' + intervalMs() + ' 毫秒/帧）';
  }
  /** Step the speed by whole multiples, clamped to the slider's own range. */
  function nudgeSpeed(delta) {
    speedEl.value = String(Math.max(1, Math.min(SPEED_MAX, playbackSpeed() + delta)));
    syncSpeedLabel();
    if (timer) startTimer();
  }
  speedEl.addEventListener('input', function () {
    syncSpeedLabel();
    if (timer) startTimer();
  });
  speedUpEl.addEventListener('click', function () { nudgeSpeed(1); });
  speedDownEl.addEventListener('click', function () { nudgeSpeed(-1); });
  syncSpeedLabel();
  playBtn.addEventListener('click', function () {
    if (timer) { stopPlayback(false); return; }
    // Starting from the end (or after a completed run) rewinds first.
    if (finished || idx >= LAST) { idx = 0; finished = false; draw(); }
    playBtn.textContent = '⏸';
    playBtn.classList.add('on');
    playBtn.title = '暂停';
    startTimer();
  });
  // ---- map zoom and pan -------------------------------------------------
  // The canvas keeps its 1:1 raster and is moved with a CSS transform, so
  // panning/zooming never touches the paint pipeline (and image-rendering
  // pixelated keeps the pixels crisp when magnified).
  const viewEl = document.getElementById('view');
  const ZOOM_MIN = 1, ZOOM_STEP = 1.25;
  /** Never magnify native pixels past this, whatever the window size. */
  const MAX_NATIVE_MAGNIFICATION = 4;
  let zScale = 1, zx = 0, zy = 0;
  function maxZoom() {
    const cw = canvas.clientWidth || canvas.width;
    if (!cw || !canvas.width) return 10;
    return Math.max(1, MAX_NATIVE_MAGNIFICATION * (canvas.width / cw));
  }
  /** Displayed pixels per source pixel, at the current zoom. */
  function effectiveScale() {
    const cw = canvas.clientWidth || canvas.width;
    return zScale * (cw / canvas.width);
  }
  function applyView() {
    const transform =
      'translate(' + zx.toFixed(2) + 'px,' + zy.toFixed(2) + 'px) scale(' + zScale.toFixed(4) + ')';
    canvas.style.transform = transform;
    // The hover layer is the map's second skin, so it moves with it. Two canvases with
    // two transforms would drift apart on the first zoom.
    if (hoverCanvas) hoverCanvas.style.transform = transform;
    // Nearest-neighbour is only correct when MAGNIFYING: when the native raster
    // is shown smaller than 1:1 (the fit-to-width default shrinks it ~5x), the
    // browser's smooth filter is what keeps the map legible instead of aliased.
    const filter = effectiveScale() >= 1 ? 'pixelated' : 'auto';
    canvas.style.imageRendering = filter;
    if (hoverCanvas) hoverCanvas.style.imageRendering = filter;
  }
  /** Keep the map covering its own viewport: no dragging it out of sight. */
  function clampView() {
    const cw = canvas.clientWidth || canvas.width;
    const ch = canvas.clientHeight || canvas.height;
    const minX = cw * (1 - zScale), minY = ch * (1 - zScale);
    if (zx > 0) zx = 0;
    if (zy > 0) zy = 0;
    if (zx < minX) zx = minX;
    if (zy < minY) zy = minY;
  }
  /** Zoom around a point given in the wrapper's coordinates. */
  function zoomAt(factor, cx, cy) {
    const next = Math.max(ZOOM_MIN, Math.min(maxZoom(), zScale * factor));
    if (next === zScale) return;
    const u = (cx - zx) / zScale, v = (cy - zy) / zScale;
    zScale = next;
    zx = cx - u * zScale;
    zy = cy - v * zScale;
    clampView();
    applyView();
  }
  function zoomCentre() {
    return { x: (canvas.clientWidth || canvas.width) / 2, y: (canvas.clientHeight || canvas.height) / 2 };
  }
  document.getElementById('zoomIn').addEventListener('click', function () {
    const c = zoomCentre(); zoomAt(ZOOM_STEP, c.x, c.y);
  });
  document.getElementById('zoomOut').addEventListener('click', function () {
    const c = zoomCentre(); zoomAt(1 / ZOOM_STEP, c.x, c.y);
  });
  document.getElementById('zoomReset').addEventListener('click', function () {
    zScale = 1; zx = 0; zy = 0; applyView();
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    const rect = viewEl.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  // ---- pointers: one finger pans, two fingers pinch (§4.3 C3) -------------
  // This was mouse-only, which is exactly why a phone could not move the map at all.
  // Pointer Events cover a mouse, a finger and a stylus in one path, and the mouse path
  // keeps every line of its old behaviour: one pointer is the same accumulate-and-clamp
  // pan it always was, and the wheel below still zooms a desktop the way it did.
  const pointers = new Map();
  /** { d0, s0 } while two fingers are down: the base distance and the scale it began at. */
  let pinch = null;
  /** Set when a second finger lands, so a pinch is never mistaken for a tap. */
  let gesturePinched = false;
  let dragging = false, dragX = 0, dragY = 0;
  function pointerDistance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  /** Client coordinates as the wrapper sees them — what zoomAt() wants. */
  function canvasPoint(clientX, clientY) {
    const rect = viewEl.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Capture, so a finger that slides off the canvas keeps panning — the job the
    // window-level mouse listeners used to do.
    if (typeof canvas.setPointerCapture === 'function') {
      try { canvas.setPointerCapture(e.pointerId); } catch (error) { void error; }
    }
    if (pointers.size === 0) gesturePinched = false;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragging = true;
      dragX = e.clientX; dragY = e.clientY;
      viewEl.classList.add('dragging');
    } else if (pointers.size === 2) {
      const pair = Array.from(pointers.values());
      pinch = { d0: Math.max(1, pointerDistance(pair[0], pair[1])), s0: zScale };
      gesturePinched = true;
    }
    if (e.preventDefault) e.preventDefault();
  });
  function movePointer(e) {
    const tracked = pointers.get(e.pointerId);
    if (!tracked) return;
    tracked.x = e.clientX; tracked.y = e.clientY;
    if (pointers.size >= 2) {
      const pair = Array.from(pointers.values());
      const distance = pointerDistance(pair[0], pair[1]);
      if (!pinch) pinch = { d0: Math.max(1, distance), s0: zScale };
      const next = pinch.s0 * (distance / pinch.d0);
      const mid = canvasPoint((pair[0].x + pair[1].x) / 2, (pair[0].y + pair[1].y) / 2);
      // Only the *ratio* to the current scale goes in: zoomAt() owns the clamp, and
      // assigning view.scale directly would fight it.
      zoomAt(next / zScale, mid.x, mid.y);
      return;
    }
    zx += e.clientX - dragX;
    zy += e.clientY - dragY;
    dragX = e.clientX; dragY = e.clientY;
    clampView(); applyView();
  }
  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (typeof canvas.releasePointerCapture === 'function') {
      try { canvas.releasePointerCapture(e.pointerId); } catch (error) { void error; }
    }
    if (pointers.size === 0) {
      dragging = false;
      pinch = null;
      viewEl.classList.remove('dragging');
      return;
    }
    if (pointers.size === 1) {
      // One finger left: it carries on as a pan from wherever it is.
      const rest = Array.from(pointers.values())[0];
      dragX = rest.x; dragY = rest.y;
      pinch = null;
      return;
    }
    const pair = Array.from(pointers.values());
    pinch = { d0: Math.max(1, pointerDistance(pair[0], pair[1])), s0: zScale };
  }
  window.addEventListener('pointermove', movePointer);
  window.addEventListener('pointerup', endPointer);
  // A touch the system takes away (a call, the app switcher, a gesture) has to end the
  // gesture exactly like a lift, or the map stays stuck mid-drag.
  window.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('mouseleave', function () {
    if (dragging) return;
    viewEl.classList.remove('dragging');
  });
  // A resize changes how much the raster is being shrunk, so re-clamp and
  // re-pick the filter. The canvas's box moved too, so the highlight is re-resolved.
  window.addEventListener('resize', function () {
    clampView();
    applyView();
    refreshHoverAfterViewChange();
  });
  applyView();

  // ======================================================================
  // ---- the province / country detail sheet ----------------------------
  // ======================================================================
  // pdx-tools' information architecture, this project's own code: a sheet pinned to
  // the map's edge that *projects the selection*. The three states are the whole
  // model (第三对话任务书.md §1.7) —
  //
  //   none                  nothing selected, the sheet is hidden
  //   province(p)           the sheet shows province p
  //   country(t, back=p)    the same sheet, widened, showing country t; 'back' is the
  //                         province the country was reached from, so 返回 has a target
  //
  // The map underneath keeps hover, click, drag and zoom while the sheet is open — the
  // user asked for the sheet to *overlay* rather than squeeze the map (第三对话任务书.md
  // §5 ③) — and every value the sheet shows is read at the current frame, so scrubbing
  // the timeline rewrites it live instead of leaving a stale snapshot behind.
  //
  // Two rules are borrowed from pdx-tools verbatim (第三对话任务书.md §1.7/§3.4):
  // a click is only a click when the pointer barely moved, and an empty value is written
  // down ("—", or a whole group left out) rather than left blank.
  const detailEl = document.getElementById('detail');
  const detailBody = document.getElementById('detailBody');
  const detailTitleEl = document.getElementById('detailTitle');
  const detailBackEl = document.getElementById('detailBack');
  const detailCloseEl = document.getElementById('detailClose');
  const playerEl = document.getElementById('player');
  const mapFullBtn = document.getElementById('mapFull');
  const leaderBodyEl = document.getElementById('leaderBody');

  /** Root-absolute, per the frozen asset convention: the deployed page is three deep. */
  const UI_PATH = {
    buildings: '/assets/ui/buildings/',
    great_projects: '/assets/ui/great_projects/',
    terrain: '/assets/ui/terrain/',
    religions: '/assets/ui/religions/',
    institutions: '/assets/ui/institutions/',
  };
  /** How far the pointer may travel between down and up and still count as a click. */
  const DRAG_SLOP = 15;  /** …and how far a finger may, which is more: touch is coarser. */
  const TOUCH_DRAG_SLOP = 24;  /** …and how long it may take. A slow press is a deliberate drag, not a click. */
  const CLICK_MS = 500;
  /** pdx-tools' own highlight cache size, borrowed because it is the right order. */
  const HOVER_CACHE_MAX = 8;

  /**
   * Chinese names for the keys the data plane does not name itself.
   *
   * 'apps/site/public/assets/ui/uiNames.json' is S2's committed key -> 中文名 table, and the
   * data plane bakes most of it (buildings, terrain, great projects). The two groups it does
   * not carry are the religion keys and the government-reform keys, and the panel is meant to
   * read Chinese throughout — so the viewer reads that one table itself and uses it only to
   * *fill gaps*: a name the plane carries always wins, so the page and the plane can never
   * disagree about a name. Root-absolute like every other asset, so the deployed page three
   * levels down finds it; a page opened straight from disk gets a failed fetch, or no fetch at
   * all, and the keys stay on screen rather than the sheet breaking.
   */
  let uiNames = null;
  /**
   * The eleven religion keys whose *artwork* is named differently from the save's key.
   *
   * S2 applies this exact table when it publishes the icons (第三对话任务书.md §4), so the
   * files are named the way the save spells them; the same eleven names are missing from
   * 'uiNames.religions', which was keyed by the icon name. Mirroring the table here is what
   * keeps those eleven religions named in Chinese instead of falling back to the raw key —
   * and it is only ever consulted after a direct hit has failed.
   */
  const RELIGION_NAME_ALIAS = {
    buddhism: 'theravada',
    shamanism: 'fetishist',
    dreamtime: 'alcheringa',
    mesoamerican_religion: 'mayan',
    norse_pagan_reformed: 'norse',
    tengri_pagan_reformed: 'tengri',
    shiite: 'shia',
    sikhism: 'sikh',
    hinduism: 'hindu',
    confucianism: 'confucian',
    animism: 'animist',
  };
  function uiNameOf(group, key) {
    if (!key) return '';
    // The data plane's own table wins: it is the one that ships with the page, so the offline
    // file has it too. The fetched table is only the fallback for a payload older than the
    // plane's name bake (or for a page with no network at all).
    const plane = DATA.uiNames ? DATA.uiNames[group] : null;
    if (plane && plane[key]) return plane[key];
    if (!uiNames) return '';
    const table = uiNames[group];
    if (!table) return '';
    if (table[key]) return table[key];
    if (group === 'religions' && RELIGION_NAME_ALIAS[key]) return table[RELIGION_NAME_ALIAS[key]] || '';
    return '';
  }
  /**
   * The Chinese name of a culture, by its index in DATA.cultures.
   *
   * The plane bakes 'cultureNames' index-aligned with 'cultures' (built in the same pass, so
   * the two cannot drift within one build), and also carries the key -> name map. Both are
   * consulted before the raw key, which is what the map views have always shown.
   */
  function cultureNameOf(index) {
    if (index < 0 || index >= DATA.cultures.length) return DASH;
    const key = DATA.cultures[index];
    const aligned = DATA.cultureNames ? DATA.cultureNames[index] : '';
    return aligned || uiNameOf('cultures', key) || key;
  }
  /** A culture name from a key that is already a string (country fields carry keys). */
  function cultureNameByKey(key) {
    if (!key) return '';
    const at = DATA.cultures.indexOf(key);
    if (at >= 0) return cultureNameOf(at);
    return uiNameOf('cultures', key) || key;
  }
  /** A ruler personality — the save stores engine keys like 'well_advised_personality'. */
  function personalityNameOf(key) {
    if (!key) return DASH;
    const baked = DATA.personalityNames ? DATA.personalityNames[key] : '';
    return baked || uiNameOf('personalities', key) || key;
  }
  function ideaGroupNameOf(key) {
    if (!key) return DASH;
    return uiNameOf('ideaGroups', key) || key;
  }
  function advisorNameOf(key) {
    if (!key) return DASH;
    return uiNameOf('advisors', key) || key;
  }
  function religionNameOf(key) {
    if (!key) return DASH;
    return uiNameOf('religions', key) || key;
  }
  if (typeof fetch === 'function') {
    fetch('/assets/ui/uiNames.json')
      .then(function (response) {
        return response && response.ok ? response.json() : null;
      })
      .then(function (names) {
        if (!names || typeof names !== 'object') return;
        uiNames = names;
        // A sheet opened before the table arrived is repainted, so it gets its names instead
        // of freezing on the raw keys.
        if (selected.kind !== 'none') paintDetail();
      })
      .catch(function () {
        // No table (a file on disk, or an older deploy): the keys are the fallback.
      });
  }

  const selected = { kind: 'none', province: 0, country: -1, back: 0 };

  /** province id -> its position in the parallel id/name arrays. */
  const provIndex = new Map();
  for (let i = 0; i < DATA.provinceIds.length; i += 1) provIndex.set(DATA.provinceIds[i], i);
  /** country tag -> its index in DATA.tags. */
  const tagIndex = new Map();
  for (let i = 0; i < DATA.tags.length; i += 1) tagIndex.set(DATA.tags[i], i);

  function provinceName(id) {
    const at = provIndex.get(id);
    if (at === undefined) return '省 ' + id;
    return DATA.provinceNames[at] || '省 ' + id;
  }
  function tagAt(idx) {
    return idx >= 0 && idx < DATA.tags.length ? DATA.tags[idx] : '';
  }
  function tagName(idx) {
    if (idx < 0 || idx >= DATA.tags.length) return '无主 / 未殖民';
    return DATA.countryNames[idx] || DATA.tags[idx];
  }
  /** The tag string of a country name, index -> the string the flag PNGs are named for. */
  function tagOfIndex(idx) {
    return tagAt(idx);
  }
  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  /** Numbers are printed in full, with zh-CN grouping, and never as NaN. */
  function fmt(value) {
    const n = Number(value);
    if (!isFinite(n)) return '—';
    return (Math.round(n * 100) / 100).toLocaleString('zh-CN');
  }
  function pct(part, whole) {
    if (!whole) return '—';
    return (Math.round((part / whole) * 1000) / 10).toLocaleString('zh-CN') + '%';
  }
  /** An empty cell is written down, never left blank (pdx-tools' own rule). */
  const DASH = '—';

  function isWaterId(id) {
    return id <= 0 || waterIds.has(id);
  }

  // ---- the hover layer ---------------------------------------------------
  /** provId -> the pixel offsets it occupies, built once and reused. */
  const hoverIds = new Map();
  let hoveredId = 0;
  let hoverPainted = false;
  /**
   * Where the pointer last was, in client coordinates.
   *
   * Kept so the highlight can be re-resolved when the *view* changes under a stationary
   * mouse — entering or leaving full screen, resizing the window — instead of waiting for
   * the next mouse move to notice.
   */
  let pointerX = 0;
  let pointerY = 0;
  let hasPointer = false;

  function hoverOffsets(id) {
    let list = hoverIds.get(id);
    if (list) return list;
    const found = [];
    for (let i = 0; i < pixels.length; i += 1) if (pixels[i] === id) found.push(i);
    list = Uint32Array.from(found);
    hoverIds.set(id, list);
    // Insertion order is visit order, so the first key is the coldest one. The cache is
    // an optimisation, never a correctness requirement: a miss just rescans.
    if (hoverIds.size > HOVER_CACHE_MAX) {
      const oldest = hoverIds.keys().next();
      if (!oldest.done && oldest.value !== id) hoverIds.delete(oldest.value);
    }
    return list;
  }

  /** What the hover layer should be showing right now, topmost last. */
  function hoverTargets() {
    const out = [];
    if (selected.kind === 'province') {
      const p = selected.province;
      if (!isWaterId(p) && p !== hoveredId) out.push([p, 75, 143, 214]);
    }
    if (hoveredId > 0 && !isWaterId(hoveredId)) out.push([hoveredId, 255, 255, 255]);
    return out;
  }

  /**
   * Repaint the highlight layer.
   *
   * "Ocean: no clear, no paint" is the user's own rule (第三对话任务书.md §1.7 和 §6.5 A2):
   * moving onto water is supposed to do *nothing at all*, so this function is only ever
   * reached for land — except when 'force' is set, which is the "the view changed under the
   * pointer" case (entering full screen, switching resolution): there the layer must be
   * rebuilt even if the answer is now "nothing", or a stale highlight stays on screen.
   */
  function paintHoverLayer(force) {
    if (!hoverCtx || !hoverImageData) return;
    const targets = hoverTargets();
    if (!targets.length && !hoverPainted && !force) return;
    hoverRGBA.fill(0);
    for (let t = 0; t < targets.length; t += 1) {
      const target = targets[t];
      const list = hoverOffsets(target[0]);
      for (let i = 0; i < list.length; i += 1) {
        const at = list[i];
        const p = at * 4;
        hoverRGBA[p] = target[1];
        hoverRGBA[p + 1] = target[2];
        hoverRGBA[p + 2] = target[3];
        hoverRGBA[p + 3] = borderMask[at] === 1 ? 235 : 74;
      }
    }
    // putImageData replaces the whole rectangle, so the all-zero buffer *is* the clear.
    hoverCtx.clearRect(0, 0, W, H);
    hoverCtx.putImageData(hoverImageData, 0, 0);
    hoverPainted = targets.length > 0;
  }

  /**
   * The province under a pointer event, or 0.
   *
   * The canvas's *own* bounding box already contains the view transform: zooming and panning
   * are a CSS transform on the canvas, and 'getBoundingClientRect()' reports the transformed
   * box. So a screen point is mapped onto the raster in one step —
   *
   *     x = (clientX - rect.left) / rect.width  * canvas.width
   *
   * — and the transform must NOT be applied a second time by adding zx/zy/zScale or by
   * rescaling with clientWidth. That double transform is invisible while the map sits at 1:1
   * with no pan; it shows up the moment entering full screen makes clampView() move the map,
   * which is exactly the "the selected province is offset from the mouse" the user reported.
   * The rect is read per event and never cached: a cached one is wrong the moment the map is
   * panned, zoomed or the window resized.
   */
  function rasterAt(clientX, clientY) {
    if (!rasterReady) return 0;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return 0;
    const x = Math.floor(((Number(clientX) - rect.left) / rect.width) * canvas.width);
    const y = Math.floor(((Number(clientY) - rect.top) / rect.height) * canvas.height);
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    return pixels[y * W + x];
  }

  /**
   * Re-ask "which province is under the pointer" after the view itself changed.
   *
   * Entering full screen, leaving it, resizing the window or switching resolution all change
   * the canvas's box, so the remembered province is stale: the screen point that produced it
   * now sits over something else. Dropping the cached pixel lists and re-resolving from the
   * last pointer is what keeps the highlight under the mouse across a full-screen toggle
   * (第三对话任务书.md §6.8.1).
   */
  function refreshHoverAfterViewChange() {
    hoverIds.clear();
    hoverPainted = false;
    hoveredId = 0;
    if (hasPointer) {
      const id = rasterAt(pointerX, pointerY);
      if (!isWaterId(id)) hoveredId = id;
    }
    paintHoverLayer(true);
  }

  // ---- reading the frozen detail schema ---------------------------------
  // Every table below is optional: S1 builds them into BOTH data planes, and until they
  // land the sheet still opens, still tracks the frame, and says so where a value is
  // missing instead of pretending. 'has' is what keeps a missing key from being
  // mistaken for an empty one.
  function tableRows(table) {
    return table && Array.isArray(table.rows) ? table.rows : null;
  }
  /** The row of a [[id, value…]] table for one province, or null when there is none. */
  function rowFor(table, id) {
    const rows = tableRows(table);
    if (!rows) return null;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i][0] === id) return rows[i];
    }
    return null;
  }
  /** The names of a table's keys: table.names when packed, the key itself otherwise. */
  function tableName(table, keyIdx) {
    if (!table || keyIdx === null || keyIdx === undefined || keyIdx < 0) return '';
    const key = table.dict && table.dict[keyIdx] !== undefined ? table.dict[keyIdx] : '';
    const name = table.names && table.names[keyIdx] ? table.names[keyIdx] : key;
    return name || key || '';
  }
  function tableKey(table, keyIdx) {
    if (!table || !table.dict || keyIdx < 0 || table.dict[keyIdx] === undefined) return '';
    return String(table.dict[keyIdx]);
  }

  // ---- element mounting --------------------------------------------------
  // The sheet's markup is one innerHTML assignment per render (fast, and the only way to
  // keep the layout rules in one readable place), but flags and icons are *appended*
  // into slots that assignment reserves. Two reasons: an <img> that 404s has to swap
  // itself for a labelled square, which needs a real handler rather than an inline one in
  // generated HTML; and a stable <img> whose src is rewritten is what lets the timeline
  // scrub without re-requesting artwork every frame.
  let slotSeq = 0;
  let pendingFlags = [];
  let pendingIcons = [];
  /** Every flag the sheet currently shows, so the 旗帜 button can repaint them. */
  let detailFlags = [];
  /** One function per frame-dependent cell; draw() runs them after the replay. */
  let liveUpdaters = [];

  function slotEl(id) {
    if (detailBody) {
      const el = detailBody.querySelector('#' + id);
      if (el) return el;
    }
    return detailEl ? detailEl.querySelector('#' + id) : null;
  }
  /** Reserve a slot for one country (flag + name). 'resolve' returns a tag index. */
  function countrySlot(resolve, emptyLabel) {
    slotSeq += 1;
    const id = 'dSlot' + slotSeq;
    pendingFlags.push({ id: id, resolve: resolve, empty: emptyLabel || '无主 / 未殖民' });
    return '<span class="dSlot" id="' + id + '"></span>';
  }
  /** Reserve a slot for one icon cell. */
  function iconSlot(kind, key, name, hint) {
    slotSeq += 1;
    const id = 'dIcon' + slotSeq;
    pendingIcons.push({ id: id, kind: kind, key: key, name: name, live: null, hint: hint || '' });
    return '<span class="dCell" id="' + id + '"></span>';
  }
  /**
   * …and the same slot for an icon whose key is not fixed.
   *
   * A province's religion changes with the frame (the Reformation is the whole point of
   * this project's history data), so the icon has to follow it. 'resolve' returns the
   * current '{ key, name }' and the mounted image only re-requests artwork when the key
   * actually moves.
   */
  function liveIconSlot(kind, resolve) {
    slotSeq += 1;
    const id = 'dIcon' + slotSeq;
    pendingIcons.push({ id: id, kind: kind, key: '', name: '', live: resolve });
    return '<span class="dCell" id="' + id + '"></span>';
  }

  function updateCountrySlot(rec) {
    const idx = rec.resolve();
    const tag = idx >= 0 ? tagOfIndex(idx) : '';
    rec.label.textContent = idx >= 0 ? tagName(idx) : rec.empty;
    if (tag === rec.tag) return;
    rec.tag = tag;
    if (!tag) {
      rec.box.style.display = 'none';
      return;
    }
    rec.box.style.display = '';
    rec.img.style.display = '';
    if (rec.fallback) rec.fallback.style.display = 'none';
    rec.img.setAttribute('data-tag', tag);
    rec.box.setAttribute('data-tag', tag);
    // A colonial nation has no artwork of its own: mother country's flag plus its own
    // colour over the right half, the same DOM recipe the heading's strip uses.
    const parent = flagParent(tag);
    rec.img.onerror = function () {
      // No artwork for this tag — a mod's country, a colony whose mother has no file: the box
      // keeps its 48x48 frame and shows the TAG instead, exactly like the catalogue card
      // (第三对话任务书.md §6.8.7 第 4 条), never a broken-image icon.
      rec.img.style.display = 'none';
      if (!rec.fallback) {
        rec.fallback = document.createElement('span');
        rec.fallback.className = 'detailFallback';
        rec.box.appendChild(rec.fallback);
      }
      rec.fallback.textContent = tag;
      rec.fallback.style.display = '';
    };
    rec.img.src = FLAG_PREFIX[flagSet] + (parent || tag) + '.png';
    if (parent) {
      if (!rec.tint) {
        rec.tint = document.createElement('i');
        rec.tint.className = 'flagTint';
        rec.box.appendChild(rec.tint);
      }
      rec.tint.style.background = flagFill(tag);
      rec.tint.style.display = '';
    } else if (rec.tint) {
      rec.tint.style.display = 'none';
    }
  }

  function mountSlots() {
    for (let i = 0; i < pendingFlags.length; i += 1) {
      const job = pendingFlags[i];
      const host = slotEl(job.id);
      if (!host) continue;
      // The same 48x48 box the catalogue card draws for a protagonist flag (see the
      // .detailFlagBox rules in the shared markup): the user asked for panel flags to read at
      // exactly that size, province rows and the country drawer's header alike.
      const box = document.createElement('span');
      box.className = 'detailFlagBox';
      const img = document.createElement('img');
      img.className = 'detailFlag';
      img.alt = '';
      box.appendChild(img);
      const label = document.createElement('span');
      label.className = 'dName';
      host.appendChild(box);
      host.appendChild(label);
      const rec = {
        box: box, img: img, label: label, resolve: job.resolve, empty: job.empty,
        tag: null, tint: null, fallback: null,
      };
      detailFlags.push(rec);
      liveUpdaters.push(function () { updateCountrySlot(rec); });
      updateCountrySlot(rec);
    }
    pendingFlags = [];
    for (let i = 0; i < pendingIcons.length; i += 1) {
      const job = pendingIcons[i];
      const host = slotEl(job.id);
      if (!host) continue;
      const img = document.createElement('img');
      img.className = 'dIcon';
      img.alt = '';
      if (job.hint) img.title = job.hint;
      const cap = document.createElement('span');
      cap.className = 'dCap';
      host.appendChild(img);
      host.appendChild(cap);
      let shown = null;
      const apply = function () {
        const wanted = job.live ? job.live() : { key: job.key, name: job.name };
        const key = wanted && wanted.key ? String(wanted.key) : '';
        const label = (wanted && wanted.name) || key;
        cap.textContent = label || DASH;
        if (key === shown) return;
        shown = key;
        img.setAttribute('data-key', key);
        if (!key) {
          img.style.display = 'none';
          return;
        }
        img.style.display = '';
        img.onerror = function () {
          // A mod's building, a great project the export never had artwork for: the cell
          // degrades to a labelled square, keeping data-key so the gap is assertable.
          img.style.display = 'none';
          let box = null;
          const kids = host.children;
          for (let k = 0; k < kids.length; k += 1) if (kids[k].className === 'dIconFallback') box = kids[k];
          if (!box) {
            box = document.createElement('span');
            box.className = 'dIconFallback';
            host.insertBefore(box, img);
          }
          box.setAttribute('data-key', key);
          box.textContent = (wanted && wanted.name) || key;
        };
        img.src = UI_PATH[job.kind] + key + '.png';
      };
      apply();
      if (job.live) liveUpdaters.push(apply);
    }
    pendingIcons = [];
  }

  /** The 旗帜 button also repaints the sheet's artwork (called from applyFlagSet). */
  function paintDetailFlags() {
    const prefix = FLAG_PREFIX[flagSet];
    for (let i = 0; i < detailFlags.length; i += 1) {
      const rec = detailFlags[i];
      const tag = rec.tag;
      if (!tag) continue;
      const parent = flagParent(tag);
      // A fresh src deserves a fresh attempt: the artwork set that failed a moment ago
      // (原版) may well exist in the other one (国家娘), so the image comes back and the TAG
      // block steps aside.
      rec.img.style.display = '';
      if (rec.fallback) rec.fallback.style.display = 'none';
      rec.img.src = prefix + (parent || tag) + '.png';
      if (rec.tint && parent) rec.tint.style.background = flagFill(tag);
    }
  }

  /** Re-read every frame-dependent cell. draw() calls this after the replay. */
  function refreshDetailLive() {
    if (selected.kind === 'none') return;
    for (let i = 0; i < liveUpdaters.length; i += 1) {
      try {
        liveUpdaters[i]();
      } catch (error) {
        // A single stale row must never take the frame down with it.
        void error;
      }
    }
  }

  // ---- the selection state machine --------------------------------------
  function currentOrd() {
    return DATA.months[Math.max(0, Math.min(DATA.months.length - 1, idx))];
  }
  /**
   * The frame that contains a date.
   *
   * The timeline is monthly while a province's or a country's history is dated to the day,
   * so almost no event ordinal is a frame ordinal: an entry dated 1445.2.9 lives in the
   * frame labelled 1445.2.1. Asking 'months.indexOf(ordinal)' for that entry answers -1,
   * which is exactly how a "jump the map to that day" button silently disappears. This is
   * the last frame at or before the date, and -1 only for a date before the campaign starts
   * (the save does contain such entries — some provinces are dated to the year 400).
   */
  function monthIndexForOrdinal(ord) {
    const months = DATA.months;
    if (!months.length) return -1;
    const wanted = Number(ord);
    if (!isFinite(wanted) || wanted < months[0]) return -1;
    let lo = 0;
    let hi = months.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (months[mid] <= wanted) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }
  /**
   * An ordinal back into 'Y.M.D', the game's own calendar (31-day months, 372-day years —
   * the same arithmetic the frame labels are built with).
   */
  function dateOfOrdinal(ord) {
    const value = Number(ord);
    if (!isFinite(value) || value < 0) return DASH;
    const year = Math.floor(value / 372);
    const day = value - year * 372;
    return year + '.' + (Math.floor(day / 31) + 1) + '.' + ((day % 31) + 1);
  }
  /**
   * Who owns a province *at the current frame*, as a tag index, or -1.
   *
   * Two readings of the same state, both already used by the map: the NAME is resolved
   * date-aware (Muscovy is 莫斯科 until it renames itself), while the flag and the
   * country panel use the identity (resolveLatest) so a rename never splits a country in
   * two — the exact distinction the power curves had to learn.
   */
  function ownerTagAt(id) {
    const raw = owner[id];
    if (raw < 0) return -1;
    return resolveOwner(raw, currentOrd());
  }
  function controllerTagAt(id) {
    const raw = controller[id];
    if (raw < 0) return -1;
    return resolveOwner(raw, currentOrd());
  }
  function isOccupied(id) {
    const o = owner[id];
    const c = controller[id];
    if (o < 0 || c < 0) return false;
    return resolveLatest(o) !== resolveLatest(c);
  }
  /** The country a province belongs to, as an identity (what the country panel keys on). */
  function ownerIdentityAt(id) {
    const raw = owner[id];
    return raw < 0 ? -1 : resolveLatest(raw);
  }

  function showProvince(id) {
    selected.kind = 'province';
    selected.province = id;
    selected.country = -1;
    selected.back = 0;
    jumpPinned = -1;
    jumpBack = -1;
    paintDetail();
  }
  function showCountry(tagIdx, backProvince) {
    if (tagIdx < 0) return;
    selected.kind = 'country';
    selected.country = tagIdx;
    selected.back = backProvince > 0 ? backProvince : 0;
    paintDetail();
  }
  function clearSelection() {
    selected.kind = 'none';
    selected.province = 0;
    selected.country = -1;
    selected.back = 0;
    jumpPinned = -1;
    jumpBack = -1;
    paintDetail();
  }
  /** A tag string (from a flag, or the leaderboard) as the panel's identity index. */
  function openTagString(tag) {
    const at = tagIndex.get(String(tag || '').toUpperCase());
    if (at === undefined) return;
    const back = selected.kind === 'province' ? selected.province : selected.back;
    showCountry(resolveLatest(at), back);
  }

  function setTitle(text) {
    if (detailTitleEl) detailTitleEl.textContent = text;
  }
  function setBackLabel(text, hint) {
    if (!detailBackEl) return;
    detailBackEl.textContent = text;
    detailBackEl.title = hint || '';
  }

  function paintDetail() {
    if (!detailEl || !detailBody) return;
    detailFlags = [];
    liveUpdaters = [];
    pendingFlags = [];
    pendingIcons = [];
    if (selected.kind === 'none') {
      detailEl.hidden = true;
      detailBody.innerHTML = '';
      detailEl.classList.remove('country');
      paintHoverLayer();
      return;
    }
    detailEl.hidden = false;
    detailEl.classList.toggle('country', selected.kind === 'country');
    if (selected.kind === 'province') {
      renderProvincePanel(selected.province);
    } else {
      renderCountryPanel(selected.country);
    }
    mountSlots();
    // The sheet's tables are brand-new nodes after every render, so the header bindings go
    // back on here and the column the user chose is replayed onto them (第四对话任务书.md
    // §3.3): switching a tab, or scrubbing the timeline, must not silently drop a sort.
    makeSortable(detailBody);
    applyStoredSort(detailBody);
    // The mounted cells are only the ones with artwork; the frame-dependent text (the
    // religion and culture names, the 发展度 line, the country flags' names) is written by
    // the live updaters, so they run once here too — otherwise a freshly opened sheet would
    // show its labels only after the next frame was drawn.
    refreshDetailLive();
    paintDetailFlags();
    paintHoverLayer();
  }

  // ---- the province panel (pdx-tools' sheet, plus what it does not have) --
  // The row table is frozen in 省份国家界面阶段任务书.md §6.4: twelve key/value rows, four
  // extra rows for terrain / great projects / institutions / area, and four grouped
  // tables. Group-level emptiness hides the whole group (a province with no claims shows
  // no 宣称 row at all); cell-level emptiness is a literal —.
  function renderProvincePanel(id) {
    setTitle(id + ': ' + provinceName(id));
    setBackLabel('✕ 关闭省份界面', '关闭省份面板');
    const html = [];
    html.push('<div class="dRow"><span class="k">发展度</span><span class="v" id="dDev"></span></div>');
    html.push('<p class="dNote">按当前帧回放：基础税收 / 生产 / 人力。拖动时间轴可以看到这个省几百年的开发过程。</p>');
    liveUpdaters.push(function () {
      const el = slotEl('dDev');
      if (!el) return;
      const t = tax[id];
      const p = production[id];
      const m = manpower[id];
      el.textContent = fmt(t) + ' / ' + fmt(p) + ' / ' + fmt(m) + '（合计 ' + fmt(t + p + m) + '）';
    });
    html.push(
      '<div class="dRow"><span class="k">拥有者</span><span class="v" id="dOwnerV">' +
        countrySlot(function () { return ownerTagAt(id); }, '无主 / 未殖民') + '</span></div>',
    );
    html.push(
      '<div class="dRow"><span class="k">占领者</span><span class="v" id="dCtrlV">' +
        countrySlot(
          function () { return isOccupied(id) ? controllerTagAt(id) : -1; },
          DASH + '（没有被占领；叛军不算占领方）',
        ) + '</span></div>',
    );
    const ownerUpdater = function () {
      const el = slotEl('dOwnerV');
      if (el) el.className = owner[id] < 0 ? 'v dim' : 'v';
    };
    const ctrlUpdater = function () {
      const el = slotEl('dCtrlV');
      if (el) el.className = isOccupied(id) ? 'v hot' : 'v dim';
    };
    liveUpdaters.push(ownerUpdater);
    liveUpdaters.push(ctrlUpdater);

    // 核心 / 宣称: flag lists, and no row at all when the list is empty.
    const cores = rowFor(DATA.provinceCores, id);
    if (cores && cores.length > 1) {
      html.push('<div class="dRow"><span class="k">核心</span><span class="v">' + tagListHtml(cores.slice(1)) + '</span></div>');
    }
    const claims = rowFor(DATA.provinceClaims, id);
    if (claims && claims.length > 1) {
      html.push('<div class="dRow"><span class="k">宣称</span><span class="v">' + tagListHtml(claims.slice(1)) + '</span></div>');
    }

    html.push(
      '<div class="dRow"><span class="k">宗教</span><span class="v">' +
        liveIconSlot('religions', function () {
          const idx = religion[id];
          const key = idx >= 0 && DATA.religions[idx] ? DATA.religions[idx] : '';
          return { key: key, name: uiNameOf('religions', key) || key };
        }) +
        '<span class="dName" id="dRelName"></span></span></div>',
    );
    liveUpdaters.push(function () {
      const el = slotEl('dRelName');
      const key = religion[id] >= 0 && DATA.religions[religion[id]] ? DATA.religions[religion[id]] : '';
      if (el) el.textContent = key ? (uiNameOf('religions', key) || key) : DASH;
    });
    html.push(
      '<div class="dRow"><span class="k">文化</span><span class="v">' +
        '<span class="dSw" id="dCulSw"></span><span class="dName" id="dCulName"></span></span></div>',
    );
    liveUpdaters.push(function () {
      const name = slotEl('dCulName');
      if (name) name.textContent = cultureNameOf(culture[id]);
      const sw = slotEl('dCulSw');
      if (sw) {
        const color = culture[id] >= 0 && DATA.cultureColors && DATA.cultureColors[culture[id]]
          ? DATA.cultureColors[culture[id]]
          : 0x888888;
        sw.style.background = cssOf(color);
      }
    });

    // 荒废度 / 贸易品 / 潜在贸易品 / 贸易公司: all four come from the province block, which the
    // extractor used to drop. Until the data plane carries them the row says so.
    html.push('<div class="dRow"><span class="k">荒废度</span><span class="v">' + devastationHtml(id) + '</span></div>');
    html.push('<div class="dRow"><span class="k">贸易品</span><span class="v">' + tradeGoodHtml(id) + '</span></div>');
    const latent = rowFor(DATA.provinceLatentTradeGoods, id);
    if (latent) {
      const names = latent.slice(1).map(function (keyIdx) {
        const key = tableKey(DATA.provinceLatentTradeGoods, keyIdx);
        return esc(tableName(DATA.provinceLatentTradeGoods, keyIdx) || uiNameOf('tradeGoods', key) || key || DASH);
      });
      html.push('<div class="dRow"><span class="k">潜在贸易品</span><span class="v">' + (names.join('、') || DASH) + '</span></div>');
    }
    const tradeCompany = DATA.provinceTradeCompany;
    html.push(
      '<div class="dRow"><span class="k">属于贸易公司</span><span class="v">' +
        (Array.isArray(tradeCompany) || tradeCompany ? (tradeCompany[id] ? '是' : '否') : DASH) +
        '</span></div>',
    );

    // 建筑: the icon grid the user asked for — four to a row, each captioned in Chinese.
    const buildings = rowFor(DATA.provinceBuildings, id);
    if (buildings && buildings.length > 1) {
      const builders = buildersOf(id);
      const slots = [];
      for (let i = 1; i < buildings.length; i += 1) {
        const keyIdx = buildings[i];
        const key = tableKey(DATA.provinceBuildings, keyIdx);
        const label = tableName(DATA.provinceBuildings, keyIdx) || key;
        const who = builders[i - 1];
        slots.push(iconSlot('buildings', key, label, who ? '建造者：' + who : ''));
      }
      html.push('<div class="dRow"><span class="k">建筑</span><span class="v dMono">' + String(buildings.length - 1) + ' 座</span></div>');
      html.push('<div class="dGrid">' + slots.join('') + '</div>');
    } else {
      html.push('<div class="dRow"><span class="k">建筑</span><span class="v">' + DASH + '</span></div>');
    }

    // ---- the four extra rows ---------------------------------------------
    html.push('<div class="dSec">地形与归属</div>');
    html.push('<div class="dRow"><span class="k">地形</span><span class="v" id="dTerrainV">' + terrainHtml(id) + '</span></div>');
    const projects = rowFor(DATA.provinceGreatProjects, id);
    if (projects && projects.length > 1) {
      const cells = [];
      for (let i = 1; i < projects.length; i += 1) {
        const keyIdx = projects[i];
        const key = tableKey(DATA.provinceGreatProjects, keyIdx);
        cells.push(iconSlot('great_projects', key, tableName(DATA.provinceGreatProjects, keyIdx) || key));
      }
      html.push('<div class="dRow"><span class="k">奇观</span><span class="v">' + String(cells.length) + ' 处</span></div>');
      html.push('<div class="dGrid">' + cells.join('') + '</div>');
    }
    html.push('<div class="dRow"><span class="k">思潮</span><span class="v" id="dInstText"></span></div>');
    html.push('<div class="dGrid">' + institutionSlots(id) + '</div>');
    liveUpdaters.push(function () {
      const el = slotEl('dInstText');
      if (el) el.textContent = institutionSummary(id);
    });
    const areaKey = areaOf(id);
    html.push(
      '<div class="dRow"><span class="k">归属地区</span><span class="v">' +
        (areaKey === null ? DASH : esc(areaName(areaKey))) +
        '</span></div>',
    );

    // ---- the four grouped tables -----------------------------------------
    html.push(areaTablesHtml(areaKey));
    html.push(improveTableHtml(id));
    html.push(historyTableHtml(id));

    html.push(
      '<div class="dRow" style="margin-top:12px"><span class="k"></span><span class="v">' +
        '<button class="dLink" id="detailGotoCountry" type="button"' +
        (ownerIdentityAt(id) < 0 ? ' disabled' : '') +
        '>转到国家 →</button>' +
        (ownerIdentityAt(id) < 0 ? '<span class="dNote">该省没有拥有国。</span>' : '') +
        '</span></div>',
    );
    html.push(
      '<p class="dNote">数据来自存档：省份地理与当前帧的归属、宗教、文化、发展度都是存档记录的值；' +
        '存档没有记录的东西（例如某次建筑的建造者）会明确写成「存档未记录」，不会假装有。</p>',
    );

    detailBody.innerHTML = html.join('');
  }

  /** A row of country flags, for 核心 / 宣称. The tag comes straight from the table. */
  function tagListHtml(indices) {
    const out = [];
    for (let i = 0; i < indices.length; i += 1) {
      const idx = indices[i];
      out.push(countrySlot((function (wanted) {
        return function () { return resolveLatest(wanted); };
      })(idx)));
    }
    return out.join(' ');
  }

  function cssOf(packed) {
    return '#' + (Number(packed) || 0x888888).toString(16).padStart(6, '0');
  }

  function devastationHtml(id) {
    const table = DATA.provinceDevastation;
    if (!Array.isArray(table) && typeof table !== 'object') return DASH;
    if (table === null || table === undefined) return DASH;
    const value = table[id];
    if (value === undefined) return DASH + '<span class="dNote" style="display:inline">数据面待补</span>';
    return fmt(value) + '%';
  }
  /** 贸易品: the save's own key, named when either table has a Chinese name for it. */
  function tradeGoodHtml(id) {
    const table = DATA.provinceTradeGoods;
    if (!table) return DASH;
    const row = rowFor(table, id);
    if (!row) return DASH;
    const names = [];
    for (let i = 1; i < row.length; i += 1) {
      const keyIdx = row[i];
      const key = tableKey(table, keyIdx);
      // 'unknown' is the game's own value for a province with no trade good at all, so it is
      // translated rather than left as an English word.
      if (key === 'unknown') {
        names.push('未知');
        continue;
      }
      names.push(esc(tableName(table, keyIdx) || uiNameOf('tradeGoods', key) || key));
    }
    return names.join('、') || DASH;
  }
  function buildersOf(id) {
    const table = DATA.provinceBuildings;
    if (!table || !Array.isArray(table.builders)) return [];
    for (let i = 0; i < table.builders.length; i += 1) {
      if (table.builders[i][0] === id) return table.builders[i].slice(1);
    }
    return [];
  }
  function terrainHtml(id) {
    const table = DATA.provinceTerrain;
    // Terrain is not in the save at all (it is derived from the game's own map), so a payload
    // built before this feature simply has no table: say so rather than pretend.
    if (!table || !Array.isArray(table.byId)) return DASH + '（数据面待补）';
    const keyIdx = table.byId[id];
    if (keyIdx === undefined || keyIdx < 0) return DASH;
    const key = tableKey(table, keyIdx);
    const label = tableName(table, keyIdx) || key;
    if (!key) return DASH;
    return iconSlot('terrain', key, label) + '<span class="dName">' + esc(label) + '</span>';
  }
  /**
   * The eight institutions, in the order the game declares them.
   *
   * The names are frozen here because the save carries no localisation for them and the
   * data plane packs none; the order is the same one 'viewer-build.js' uses for the
   * institution view's ramp, so an icon and a map colour always mean the same thing.
   */
  const INSTITUTION_NAMES = [
    '封建制', '文艺复兴', '殖民主义', '印刷术', '全球贸易', '工场手工业', '启蒙运动', '工业化',
  ];
  function institutionSlots(id) {
    const info = institutionById.get(id);
    const cells = [];
    const accepted = info ? info[0] : -1;
    const inProgress = info ? info[1] : -1;
    for (let i = 0; i < INSTITUTION_NAMES.length; i += 1) {
      const state = accepted >= 0 && i < accepted ? '已接纳' : i === inProgress ? '正在接纳' : '未接纳';
      cells.push(iconSlot('institutions', String(i), INSTITUTION_NAMES[i] + '·' + state));
    }
    return cells.join('');
  }
  /** The 思潮 row's own sentence. Institutions are a snapshot, so it never moves. */
  function institutionSummary(id) {
    const info = institutionById.get(id);
    if (!info) return DASH + '（存档没有这个省的思潮记录）';
    return '已接纳 ' + fmt(info[0]) + ' / 8' +
      (info[1] >= 0 ? '，正在接纳第 ' + (info[1] + 1) + ' 个（' + INSTITUTION_NAMES[info[1]] + '）' : '');
  }
  function areaOf(id) {
    const table = DATA.provinceArea;
    if (!table || !Array.isArray(table.byId)) return null;
    const keyIdx = table.byId[id];
    if (keyIdx === undefined || keyIdx < 0) return null;
    return keyIdx;
  }
  function areaName(keyIdx) {
    const table = DATA.provinceArea;
    if (!table) return '地区 ' + keyIdx;
    return tableName(table, keyIdx) || tableKey(table, keyIdx) || ('地区 ' + keyIdx);
  }

  function areaTablesHtml(areaKey) {
    const area = DATA.areaDetail;
    const detail = areaKey === null || !area ? null : area[String(areaKey)];
    const html = [];
    const states = detail && Array.isArray(detail.states) ? detail.states : [];
    if (states.length) {
      const rows = states.map(function (row) {
        return '<tr><td data-sort="' + esc(countrySortName(row.tagIdx)) + '">' + countrySlot(tagResolve(row.tagIdx)) +
          '</td><td class="num">' + fmt(row.prosperity) + '</td></tr>';
      });
      html.push(
        '<div class="dSec">' + esc(areaName(areaKey)) + ' 州<span class="dSecNote">国家 ｜ 繁荣度</span></div>',
        '<table class="dTable" data-sortable data-table="area"><thead><tr><th data-sort="text">国家</th>' +
        '<th class="num" data-sort="num">繁荣度</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>',
      );
    }
    const investments = detail && Array.isArray(detail.investments) ? detail.investments : [];
    if (investments.length) {
      const rows = investments.map(function (row) {
        const icons = (Array.isArray(row.icons) ? row.icons : []).map(function (key) {
          return '<span class="dChip">' + esc(key) + '</span>';
        }).join('');
        return '<tr><td data-sort="' + esc(countrySortName(row.tagIdx)) + '">' + countrySlot(tagResolve(row.tagIdx)) +
          '</td><td>' + (icons || DASH) + '</td></tr>';
      });
      html.push(
        '<div class="dSec">' + esc(areaName(areaKey)) + ' 贸易公司投资<span class="dSecNote">国家 ｜ 投资</span></div>',
        '<table class="dTable" data-sortable data-table="tradecompany"><thead><tr><th data-sort="text">国家</th>' +
        '<th data-sort="text">投资</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>',
      );
    }
    return html.join('');
  }
  /** A resolver that turns "a tag index in some table" into a country slot's index. */
  function tagResolve(value) {
    return function () {
      const idx = Number(value);
      if (!isFinite(idx) || idx < 0) return -1;
      return resolveLatest(idx);
    };
  }
  /**
   * What a country's own cell sorts by.
   *
   * A country cell is a flag plus a name, both mounted *after* the markup is written, so
   * its textContent is empty at the moment the sorter reads it — the name it will show is
   * put on the cell's data-sort instead (第四对话任务书.md §3.3). It is the same name the
   * slot paints, resolved through the final tag, so the column sorts in the order the
   * table reads.
   */
  function countrySortName(tagIdx) {
    const idx = Number(tagIdx);
    if (!isFinite(idx) || idx < 0) return '';
    return tagName(resolveLatest(idx));
  }

  function improveTableHtml(id) {
    const row = rowFor(DATA.provinceImprove, id);
    if (!row || row.length < 3) return '';
    const cells = [];
    for (let i = 1; i + 1 < row.length; i += 2) {
      const tagIdx = row[i];
      const count = row[i + 1];
      cells.push(
        '<tr><td data-sort="' + esc(countrySortName(tagIdx)) + '">' + countrySlot(tagResolve(tagIdx)) + '</td>' +
          '<td class="num">' + (Number(count) < 0 ? DASH + '（存档未记录）' : fmt(count)) + '</td></tr>',
      );
    }
    if (!cells.length) return '';
    return (
      '<div class="dSec">扩建基础设施<span class="dSecNote">国家 ｜ 次数</span></div>' +
      '<table class="dTable" data-sortable data-table="improve"><thead><tr><th data-sort="text">国家</th>' +
      '<th class="num" data-sort="num">次数</th></tr></thead><tbody>' + cells.join('') + '</tbody></table>'
    );
  }

  // ---- the province history table ---------------------------------------
  // Read from the province's own history log — the part of this project pdx-tools does not
  // have at all. Its own Province History lists Owner / Constructed / Demolished; ours
  // adds religion and culture, because the save records them with dates.
  let historyCache = new Map();
  let jumpPinned = -1;
  let jumpBack = -1;
  let jumpOrds = [];

  function provinceHistory(id) {
    const cached = historyCache.get(id);
    if (cached) return cached;
    const entries = [];
    const init = new Map();
    for (let i = 0; i < DATA.provinceInit.length; i += 1) {
      const row = DATA.provinceInit[i];
      if (row[0] === id) init.set(row[1], row[2]);
    }
    if (init.size) {
      entries.push({ ord: DATA.months[0], text: '开局：' + initSummary(init), tag: init.has(FIELD.owner) ? init.get(FIELD.owner) : -1 });
    }
    const byOrd = new Map();
    for (let i = 0; i < DATA.provinceEvents.length; i += 1) {
      const row = DATA.provinceEvents[i];
      if (row[1] !== id) continue;
      let list = byOrd.get(row[0]);
      if (!list) { list = []; byOrd.set(row[0], list); }
      list.push(row);
    }
    const ords = Array.from(byOrd.keys()).sort(function (a, b) { return a - b; });
    for (let i = 0; i < ords.length; i += 1) {
      const ord = ords[i];
      const list = byOrd.get(ord);
      const parts = [];
      let tag = -1;
      for (let k = 0; k < list.length; k += 1) {
        const fieldIdx = list[k][2];
        const valIdx = list[k][3];
        if (fieldIdx === FIELD.owner) {
          tag = valIdx;
          parts.push('拥有者 → ' + (valIdx >= 0 ? tagName(valIdx) : '无主'));
        } else if (fieldIdx === FIELD.controller) {
          parts.push('占领 → ' + (valIdx >= 0 ? tagName(valIdx) : '无'));
        } else if (fieldIdx === FIELD.religion) {
          parts.push('宗教 → ' + (valIdx >= 0 ? (DATA.religions[valIdx] || valIdx) : '无'));
        } else if (fieldIdx === FIELD.culture) {
          parts.push('文化 → ' + (valIdx >= 0 ? cultureNameOf(valIdx) : '无'));
        }
      }
      if (!parts.length) continue;
      entries.push({ ord: ord, text: parts.join('；'), tag: tag });
    }
    // Newest first: the question a player asks about a province is "how did it get here".
    entries.reverse();
    historyCache.set(id, entries);
    return entries;
  }
  function initSummary(init) {
    const bits = [];
    if (init.has(FIELD.owner)) bits.push('拥有者 ' + (init.get(FIELD.owner) >= 0 ? tagName(init.get(FIELD.owner)) : '无主'));
    if (init.has(FIELD.religion)) bits.push('宗教 ' + (DATA.religions[init.get(FIELD.religion)] || '—'));
    if (init.has(FIELD.culture)) bits.push('文化 ' + cultureNameOf(init.get(FIELD.culture)));
    return bits.join('，') || '存档无记录';
  }

  function historyTableHtml(id) {
    const entries = provinceHistory(id);
    if (!entries.length) {
      return '<div class="dSec">省份历史</div><p class="dNote">存档里没有这个省的变更记录。</p>';
    }
    jumpOrds = [];
    const rows = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const at = monthIndexForOrdinal(entry.ord);
      const date = dateOfOrdinal(entry.ord);
      const pinned = jumpPinned === entry.ord;
      const jumpId = 'dJump' + i;
      jumpOrds.push(entry.ord);
      rows.push(
        '<tr><td class="d">' + esc(date) + '</td><td>' + esc(entry.text) + '</td>' +
          '<td data-sort="' + esc(countrySortName(entry.tag)) + '">' +
          (entry.tag >= 0 ? countrySlot(tagResolve(entry.tag)) : '') +
          (at >= 0
            ? '<button class="dGo' + (pinned ? ' on' : '') + '" id="' + jumpId + '" type="button" data-ord="' + entry.ord +
              '" title="把地图切到 ' + esc(date) + '（再点一次回到当前帧）">⏱</button>'
            : '') +
          '</td></tr>',
      );
    }
    return (
      '<div class="dSec">省份历史<span class="dSecNote">日期 ｜ 事件 ｜ 图形（⏱ = 把地图切到那天）</span></div>' +
      '<table class="dTable" data-sortable data-table="history"><thead><tr><th data-sort="date">日期</th>' +
      '<th data-sort="text">事件</th><th data-sort="text">图形</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody></table>'
    );
  }

  /** Jump the timeline, and jump back on a second press (pdx-tools' own interaction). */
  function jumpToOrd(ord) {
    const at = monthIndexForOrdinal(ord);
    if (at < 0) return;
    if (jumpPinned === ord) {
      const back = jumpBack;
      jumpPinned = -1;
      jumpBack = -1;
      goTo(back < 0 ? at : back);
    } else {
      if (jumpPinned < 0) jumpBack = idx;
      jumpPinned = ord;
      goTo(at);
    }
    paintDetail();
  }

  // ---- the country panel -------------------------------------------------
  // The thirteen tabs of pdx-tools' country drawer, in its own order (第三对话任务书.md
  // §1.9), with the first wave enabled and the rest visibly parked rather than silently
  // absent: a disabled tab still tells the user the plan.
  const COUNTRY_TABS = [
    ['general', '总览', true],
    ['history', '历史', true],
    ['institution', '思潮', true],
    ['advisors', '顾问', true],
    ['rulers', '君主', true],
    ['leaders', '将领', true],
    ['budget', '财政', true],
    ['mana', '点数', true],
    ['buildings', '建筑', true],
    ['religion', '宗教', true],
    ['culture', '文化', true],
    ['states', '州', true],
    ['estates', '阶级', true],
  ];
  let countryTab = 'general';

  function countryRow(tagIdx) {
    const table = DATA.countryDetail;
    if (!table) return null;
    const tag = tagAt(tagIdx);
    if (!tag) return null;
    const row = table[tag];
    return row && typeof row === 'object' ? row : null;
  }
  /** A field that may be spelled either way in the frozen schema. */
  function pick(row, names) {
    if (!row) return null;
    for (let i = 0; i < names.length; i += 1) {
      const value = row[names[i]];
      if (value !== undefined && value !== null) return value;
    }
    return null;
  }
  /** A tag list field, as tag indices (the schema stores indices; strings are tolerated). */
  function tagIndices(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      const entry = value[i];
      if (typeof entry === 'number' && isFinite(entry)) out.push(resolveLatest(entry));
      else if (typeof entry === 'string') {
        const at = tagIndex.get(entry.toUpperCase());
        if (at !== undefined) out.push(resolveLatest(at));
      }
    }
    return out;
  }
  function tagListValue(value) {
    const list = [];
    for (let i = 0; i < value.length; i += 1) list.push(tagAt(value[i]) || '?');
    return list.join(' · ');
  }

  /**
   * What the province replay can say about a country, at the current frame.
   *
   * This is the fallback for the aggregates the frozen schema carries: development,
   * province and city counts, and the religion/culture breakdown by development. It is
   * *derived from the map's own state* — never a second data plane — and it is only used
   * when the packed key is missing, so the two can never disagree on screen.
   */
  function countryAggregate(tagIdx) {
    let provinces = 0;
    let cities = 0;
    let dev = 0;
    const religions = new Map();
    const cultures = new Map();
    for (let i = 0; i < DATA.provinceIds.length; i += 1) {
      const id = DATA.provinceIds[i];
      if (seaSet.has(id) || lakeSet.has(id)) continue;
      const raw = owner[id];
      if (raw < 0 || resolveLatest(raw) !== tagIdx) continue;
      provinces += 1;
      const d = tax[id] + production[id] + manpower[id];
      dev += d;
      if (d >= 10) cities += 1;
      const rel = religion[id];
      if (rel >= 0) religions.set(rel, (religions.get(rel) || 0) + d);
      const cul = culture[id];
      if (cul >= 0) cultures.set(cul, (cultures.get(cul) || 0) + d);
    }
    return { provinces: provinces, cities: cities, dev: dev, religions: religions, cultures: cultures };
  }
  function mapRows(map, dict, dev) {
    const rows = Array.from(map.entries()).sort(function (a, b) { return b[1] - a[1]; });
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
      out.push({ key: dict[rows[i][0]] || String(rows[i][0]), dev: rows[i][1], share: dev ? rows[i][1] / dev : 0 });
    }
    return out;
  }

  function renderCountryPanel(tagIdx) {
    const tag = tagAt(tagIdx);
    const row = countryRow(tagIdx);
    setTitle(tagName(tagIdx) + (tag ? '（' + tag + '）' : ''));
    if (selected.back > 0) {
      setBackLabel('← 返回到 - ' + provinceName(selected.back), '回到 ' + provinceName(selected.back) + ' 的省份面板');
    } else {
      setBackLabel('✕ 关闭国家界面', '关闭国家面板');
    }
    const tabs = [];
    for (let i = 0; i < COUNTRY_TABS.length; i += 1) {
      const entry = COUNTRY_TABS[i];
      const on = entry[0] === countryTab;
      tabs.push(
        '<button id="dTab-' + entry[0] + '" class="' + (on ? 'on' : '') + '" type="button"' +
          (entry[2] ? '' : ' disabled title="后续波次：数据与图标就位后再开放"') +
          '>' + entry[1] + '</button>',
      );
    }
    const head = countryTab === 'general' ? countryHeadHtml(tagIdx) : '';
    const html = [
      '<div class="dTabs">' + tabs.join('') + '</div>',
      head,
      '<div id="dPane">' + countryPaneHtml(tagIdx, tag, row) + '</div>',
    ];
    detailBody.innerHTML = html.join('');
    // The country pane is all text (no artwork is mounted inside it), so rebuilding it is
    // both safe and the cheapest way to keep every number on the current frame — which is
    // the whole point of this viewer: the map is timeline-driven, so the panel is too.
    // Only the tabs whose numbers actually *are* frame-dependent get that treatment: the
    // snapshot tabs (建筑/州/阶级/顾问/财政/点数/思潮) would rebuild a few hundred rows on
    // every frame for nothing.
    const FRAME_DEPENDENT_TABS = { general: true, history: true, culture: true, religion: true, states: true };
    if (FRAME_DEPENDENT_TABS[countryTab] === true) {
      liveUpdaters.push(function () {
        const pane = slotEl('dPane');
        if (!pane) return;
        pane.innerHTML = countryPaneHtml(tagIdx, tag, row);
        // A frame-dependent tab is rebuilt on every drawn frame, which would drop the sort
        // the moment the timeline moves: rebind the fresh headers and replay it.
        makeSortable(pane);
        applyStoredSort(pane);
      });
    }
  }

  /**
   * The country drawer's header: the flag (or 国家娘) at 48x48 with the country name beside it.
   *
   * The user asked for it at the top of 总览, at the size of the catalogue card's country flag
   * (省份国家界面阶段任务书.md §6.8.7). It is emitted *outside* #dPane on purpose: the pane is
   * rebuilt on every frame to keep its numbers current, and a slot re-created each frame would
   * lose the artwork mounted into it (and leak one flag per frame). Built once per paint, the
   * header keeps its flag while the timeline moves.
   */
  function countryHeadHtml(tagIdx) {
    return '<div class="dCtryHead" id="dCountryHead">' + countrySlot(function () { return tagIdx; }, '未知国家') + '</div>';
  }

  function countryPaneHtml(tagIdx, tag, row) {
    const agg = countryAggregate(tagIdx);
    const missing = row === null;
    const note = missing
      ? '<p class="dWarn">数据面里没有这个国家的 <b>countryDetail</b> 记录。该键只烤<b>结档当日仍拥有省份</b>的国家' +
        '（273 个），所以把时间轴往前拖、点一个当年存在但结档时已无国土的国家（例如瑞典、莫斯科、奥斯曼）时就会看到这一条：' +
        '它的版图与省份是存档真实记录的，而国力、君主、将领这些<b>存档当日标量</b>没有它的那一份。' +
        '下面是能由既有的省份回放直接推出来的值；其余单元格记为 ' + DASH + ' 并注明「数据面待补」，不会编造。</p>'
      : '';
    if (countryTab === 'rulers') return note + rulersPane(row);
    if (countryTab === 'leaders') return note + leadersPane(row);
    if (countryTab === 'culture') return note + culturePane(row, agg);
    if (countryTab === 'religion') return note + religionPane(row, agg);
    if (countryTab === 'history') return note + historyPane(tagIdx, row);
    // Wave 2: buildings, states, estates, advisors.
    if (countryTab === 'buildings') return note + buildingsPane(tagIdx, row);
    if (countryTab === 'states') return note + statesPane(tagIdx, row);
    if (countryTab === 'estates') return note + estatesPane(row);
    if (countryTab === 'advisors') return note + advisorsPane(row);
    // Wave 3: the ledger, the monarch power breakdown, and the institution badge.
    if (countryTab === 'budget') return note + budgetPane(row);
    if (countryTab === 'mana') return note + manaPane(row);
    if (countryTab === 'institution') return note + institutionPane(tagIdx);
    return note + generalPane(tagIdx, tag, row, agg);
  }

  // ---- wave 3: 财政 / 点数 / 思潮 ----------------------------------------
  // 省份国家界面阶段任务书.md §8. Two things are deliberately *not* done here: the institution
  // tab is a display (the badge plus every province's progress), not pdx-tools' "cheapest way to
  // embrace" planner; and nothing prints a subject name that the slot enumeration has not named —
  // a slot index is a position in an array, and the wrong subject beside a number is worse than
  // no subject at all. Where the numbers are missing the pane says 数据待补.

  /** The slot tables, from the plane when it carries them and from the committed JSON otherwise. */
  let fetchedSlots = null;
  /**
   * The slot list of one group.
   *
   * Two spellings exist and both must work: the plane bakes a *bare array* ('DATA.ledgerSlots.income',
   * 'DATA.manaSlots') while S2's committed JSON wraps it as '{ slots: [...] }'. The plane's copy is
   * preferred because it is what the offline file has.
   */
  function slotList(kind) {
    const fromSource = function (source, key) {
      if (!source) return null;
      const group = source[key];
      if (Array.isArray(group)) return group;
      if (group && Array.isArray(group.slots)) return group.slots;
      return null;
    };
    if (kind === 'mana') {
      const plane = DATA.manaSlots;
      if (Array.isArray(plane)) return plane;
      const planeGroup = fromSource(plane, 'slots');
      if (planeGroup) return planeGroup;
      const fetched = fetchedSlots && fetchedSlots.mana;
      if (Array.isArray(fetched)) return fetched;
      return fromSource(fetched, 'slots');
    }
    const planeLedger = DATA.ledgerSlots;
    const planeIncome = fromSource(planeLedger, kind);
    if (planeIncome) return planeIncome;
    return fromSource(fetchedSlots && fetchedSlots.ledger, kind);
  }
  /** One slot's Chinese name, or '' when the table is missing, short, or off by a position. */
  function slotName(list, index) {
    if (!list || !list.length) return '';
    const entry = list[index];
    if (!entry) return '';
    if (entry.index !== undefined && entry.index !== index) return '';
    return entry.name || entry.key || '';
  }
  /** A slot table is only usable when it is long enough and aligned position for position. */
  function slotTableUsable(list, length) {
    if (!list || list.length < length) return false;
    for (let i = 0; i < length; i += 1) {
      const entry = list[i];
      if (!entry) return false;
      if (entry.index !== undefined && entry.index !== i) return false;
    }
    return true;
  }
  if (typeof fetch === 'function') {
    Promise.all([
      fetch('/assets/ui/ledgerSlots.json')
        .then(function (response) { return response && response.ok ? response.json() : null; })
        .catch(function () { return null; }),
      fetch('/assets/ui/manaSlots.json')
        .then(function (response) { return response && response.ok ? response.json() : null; })
        .catch(function () { return null; }),
    ]).then(function (both) {
      if (!both[0] && !both[1]) return;
      fetchedSlots = { ledger: both[0], mana: both[1] };
      if (selected.kind !== 'none') paintDetail();
    });
  }

  /**
   * The ledger's period keys, in the words the rest of the page uses.
   *
   * The save spells them with hyphens ('last-month', 'ytd', 'last-year'); the aliases cover the
   * spellings other versions and S2's tables use.
   */
  const LEDGER_PERIODS = [
    ['last-month', '上月'], ['lastMonth', '上月'], ['month', '上月'],
    ['ytd', '年初至今'], ['thisYear', '年初至今'],
    ['last-year', '去年'], ['lastYear', '去年'], ['year', '去年'],
    ['total', '合计'],
  ];
  const LEDGER_PERIOD_ORDER = ['上月', '年初至今', '去年', '合计'];
  function ledgerPeriodLabel(key) {
    for (let i = 0; i < LEDGER_PERIODS.length; i += 1) {
      if (LEDGER_PERIODS[i][0] === key) return LEDGER_PERIODS[i][1];
    }
    return String(key || DASH);
  }
  /** Which period's cards and waterfall are on screen (the switcher sets this). */
  let ledgerPeriod = 'ytd';
  function ledgerKeyOf(label) {
    for (let i = 0; i < LEDGER_PERIODS.length; i += 1) {
      if (LEDGER_PERIODS[i][1] === label) return LEDGER_PERIODS[i][0];
    }
    return '';
  }
  /**
   * The ledger periods of one country.
   *
   * Each entry keeps the save's own key as well as the Chinese label, and the totals the ledger
   * already computed ('incomeTotal' / 'expenseTotal' / 'net') are carried through instead of being
   * re-added: the archive's own arithmetic is the one to trust.
   */
  function budgetPeriods(row) {
    const raw = pick(row, ['budget', 'ledger', 'budgetPeriods']);
    if (!raw) return null;
    const out = [];
    const add = function (entry) {
      const source = entry || {};
      const income = source.income;
      const expense = source.expense;
      if (!Array.isArray(income) && !Array.isArray(expense)) return;
      const key = source.period || source.key || source.label || 'total';
      out.push({
        key: key,
        label: ledgerPeriodLabel(key),
        income: Array.isArray(income) ? income : [],
        expense: Array.isArray(expense) ? expense : [],
        incomeTotal: source.incomeTotal === undefined ? null : Number(source.incomeTotal),
        expenseTotal: source.expenseTotal === undefined ? null : Number(source.expenseTotal),
        net: source.net === undefined ? null : Number(source.net),
      });
    };
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 1) add(raw[i]);
    } else if (Array.isArray(raw.periods)) {
      for (let i = 0; i < raw.periods.length; i += 1) add(raw.periods[i]);
    } else {
      add(raw);
    }
    // Keep the order the ledger asks for, whatever order the data arrived in.
    out.sort(function (a, b) {
      return LEDGER_PERIOD_ORDER.indexOf(a.label) - LEDGER_PERIOD_ORDER.indexOf(b.label);
    });
    if (!out.length) return null;
    // A 合计 period is not part of the save's ledger (it has 上月/年初至今/去年 only), so the table's
    // fourth column is added up here — element by element, from the rows already on screen.
    if (!out.some(function (period) { return period.label === '合计'; })) {
      const lengthIncome = out.reduce(function (max, period) { return Math.max(max, period.income.length); }, 0);
      const lengthExpense = out.reduce(function (max, period) { return Math.max(max, period.expense.length); }, 0);
      const income = [];
      const expense = [];
      for (let i = 0; i < lengthIncome; i += 1) {
        income.push(out.reduce(function (sum, period) { return sum + (Number(period.income[i]) || 0); }, 0));
      }
      for (let i = 0; i < lengthExpense; i += 1) {
        expense.push(out.reduce(function (sum, period) { return sum + (Number(period.expense[i]) || 0); }, 0));
      }
      out.push({
        key: 'total',
        label: '合计',
        income: income,
        expense: expense,
        incomeTotal: income.reduce(function (sum, value) { return sum + value; }, 0),
        expenseTotal: expense.reduce(function (sum, value) { return sum + value; }, 0),
        net: 0,
        computed: true,
      });
      const total = out[out.length - 1];
      total.net = total.incomeTotal - total.expenseTotal;
    }
    return out;
  }
  function sumOf(list) {
    let total = 0;
    for (let i = 0; i < list.length; i += 1) total += Number(list[i]) || 0;
    return total;
  }

  /**
   * 财政：三张指标卡 ＋ 瀑布图 ＋ 明细表（上月 / 年初至今 / 去年 / 合计 ＋ 占比）＋ 支出树。
   *
   * The waterfall is a real one: every slot is a thin column whose top and height are the running
   * total before and after it, so income climbs and expense falls, and the last column is the net.
   */
  function budgetPane(row) {
    const periods = budgetPeriods(row);
    if (!periods) {
      return (
        '<div class="dSec">财政</div>' +
        '<p class="dNote">数据待补：这一份数据面里还没有国库账本（countryDetail.budget）。' +
        '面板已按冻结 schema 写好（三指标卡 / 瀑布图 / 明细表 / 支出树）；科目名也会等槽位表就位后才显示，' +
        '现在**不会**拿位置去猜科目（19 收入槽 / 38 支出槽的名字由 S2 的 ledgerSlots.json 提供）。</p>'
      );
    }
    const incomeSlots = slotList('income');
    const expenseSlots = slotList('expense');
    // The switcher picks which period the cards and the waterfall speak for (§8's 上月 / 年初至今 /
    // 去年). The table below always shows every period plus the computed 合计 column.
    const real = periods.filter(function (period) { return !period.computed; });
    const selected = real.find(function (period) { return period.key === ledgerPeriod; }) || real[0] || periods[0];
    const totalPeriod = periods.find(function (period) { return period.label === '合计'; }) || selected;
    const totalOf = function (period, key) {
      const given = key === 'income' ? period.incomeTotal : period.expenseTotal;
      return given === null || given === undefined ? sumOf(period[key]) : given;
    };
    // The 占比 column describes the 合计 column (each row's share of it), so its denominator is the
    // 合计 period — not the period the cards are showing.
    const shareBaseIncome = totalOf(totalPeriod, 'income');
    const shareBaseExpense = totalOf(totalPeriod, 'expense');
    const incomeTotal = totalOf(selected, 'income');
    const expenseTotal = totalOf(selected, 'expense');
    const net = selected.net === null || selected.net === undefined ? incomeTotal - expenseTotal : selected.net;
    const ratio = incomeTotal > 0 ? Math.round((expenseTotal / incomeTotal) * 1000) / 10 : 0;
    const html = ['<div class="dSec">财政<span class="dSecNote">账本</span></div>'];

    if (real.length > 1) {
      const buttons = real.map(function (period) {
        return (
          '<button id="dLedger-' + esc(period.key) + '" type="button" class="' +
          (period.key === selected.key ? 'on' : '') + '">' + esc(period.label) + '</button>'
        );
      });
      html.push('<div class="dTabs">' + buttons.join('') + '</div>');
    }

    html.push(
      '<div class="dCards">' +
      '<div class="dCard dMetric"><h5>营业利润（净收入）</h5><b class="dMono ' + (net < 0 ? 'dNeg' : 'dPos') + '">' +
        fmt(net) + '</b></div>' +
      '<div class="dCard dMetric"><h5>总收入</h5><b class="dMono dPos">' + fmt(incomeTotal) + '</b></div>' +
      '<div class="dCard dMetric"><h5>总支出</h5><b class="dMono dNeg">' + fmt(expenseTotal) + '</b></div>' +
      '<div class="dCard dMetric"><h5>支出 / 收入</h5><b class="dMono">' + fmt(ratio) + '%</b></div>' +
      '</div>',
    );
    html.push(
      '<p class="dNote">上面是「' + esc(selected.label) + '」区间（用上面的按钮切换）。' +
      '三张 pdx-tools 式的卡（营业利润 / 总支出 / 资本支出%）里，资本支出% 需要槽位分类' +
      '（槽位表只有 key/name，没有分类列），所以这里用能算的「支出 / 收入」代替，不猜分类。' +
      '明细表的「合计」列是上面几个区间逐项相加（存档只给上月/年初至今/去年三个窗口），' +
      '「占比」＝该行在合计列里占多少。</p>',
    );

    // ---- waterfall: cumulative columns, income up and expense down --------
    const steps = [];
    let running = 0;
    const pushStep = function (label, amount, kind) {
      if (!amount) return;
      steps.push({ label: label, amount: amount, from: running, to: running + amount, kind: kind });
      running += amount;
    };
    for (let i = 0; i < selected.income.length; i += 1) {
      pushStep(slotName(incomeSlots, i) || ('收入槽 ' + i), Number(selected.income[i]) || 0, 'in');
    }
    for (let i = 0; i < selected.expense.length; i += 1) {
      pushStep(slotName(expenseSlots, i) || ('支出槽 ' + i), -(Number(selected.expense[i]) || 0), 'out');
    }
    if (steps.length) {
      let top = net;
      let bottom = 0;
      for (let i = 0; i < steps.length; i += 1) {
        if (steps[i].to > top) top = steps[i].to;
        if (steps[i].to < bottom) bottom = steps[i].to;
      }
      const span = Math.max(1, top - bottom);
      const height = 150;
      const stepWidth = 100 / steps.length;
      const columns = steps.map(function (step, i) {
        const high = Math.max(step.from, step.to);
        const low = Math.min(step.from, step.to);
        const topPct = ((top - high) / span) * 100;
        const heightPct = Math.max(1.5, ((high - low) / span) * 100);
        // Absolute columns need their own left/width: siblings taken out of flow would all sit
        // at the same static position and overlap into one bar.
        return (
          '<i class="dWfCol ' + (step.kind === 'in' ? 'dWfIn' : 'dWfOut') +
          '" style="left:' + (i * stepWidth).toFixed(3) + '%;width:' + (stepWidth * 0.8).toFixed(3) +
          '%;top:' + topPct.toFixed(2) + '%;height:' + heightPct.toFixed(2) + '%" title="' +
          esc(step.label) + '：' + fmt(step.amount) + '（累计 ' + fmt(step.to) + '）"></i>'
        );
      });
      html.push(
        '<div class="dSec">瀑布图<span class="dSecNote">每个科目一格：绿＝收入抬升、红＝支出下拉，最后一格是净收入；' +
        '鼠标悬停看科目与数额</span></div>' +
        '<div class="dWaterfall" style="height:' + height + 'px">' + columns.join('') + '</div>' +
        '<div class="dLegend"><span class="sw" style="background:var(--ok)"></span>收入 ' + fmt(incomeTotal) +
        '<span class="sw" style="background:var(--danger)"></span>支出 ' + fmt(expenseTotal) +
        '<span class="sw" style="background:var(--accent)"></span>净收入 ' + fmt(net) + '</div>',
      );
    }

    // ---- detail table: one column per period, plus the share of that period -------
    // The ledger's own periods already include 合计, so the table must NOT add a second total
    // column: the share is computed against the 合计 period when the data has one, and against the
    // sum of the periods when it does not.
    const headings = periods.map(function (period) {
      return '<th class="num" data-sort="num">' + esc(period.label) + '</th>';
    }).join('');
    const totalIndex = periods.findIndex(function (period) { return period.label === '合计'; });
    const detailRows = function (list, key, sign) {
      const rows = [];
      const length = Math.max(list ? list.length : 0, periods.reduce(function (max, period) {
        return Math.max(max, period[key].length);
      }, 0));
      for (let i = 0; i < length; i += 1) {
        const cells = periods.map(function (period) {
          return '<td class="num">' + fmt(period[key][i] || 0) + '</td>';
        }).join('');
        const across = periods.reduce(function (sum, period) { return sum + (Number(period[key][i]) || 0); }, 0);
        const basis = totalIndex >= 0 ? (Number(periods[totalIndex][key][i]) || 0) : across;
        if (!basis) continue;
        const share = sign > 0
          ? (shareBaseIncome ? (basis / shareBaseIncome) * 100 : 0)
          : (shareBaseExpense ? (basis / shareBaseExpense) * 100 : 0);
        const name = slotName(sign > 0 ? incomeSlots : expenseSlots, i);
        if (!name) continue; // no name -> no row: the position would be a guess (§8)
        rows.push(
          '<tr><td>' + esc(name) + '</td>' + cells +
          '<td class="num">' + fmt(Math.round(share * 10) / 10) + '%</td></tr>',
        );
      }
      return rows;
    };
    const incomeRows = detailRows(incomeSlots, 'income', 1);
    const expenseRows = detailRows(expenseSlots, 'expense', -1);
    if (!incomeRows.length && !expenseRows.length) {
      html.push('<p class="dNote">账本里每个科目都是 0，或者槽位表还没有名字（不猜科目）。</p>');
    } else {
      const head = '<tr><th data-sort="text">科目</th>' + headings + '<th class="num" data-sort="num">占比</th></tr>';
      html.push('<div class="dSec">明细</div><table class="dTable" data-sortable data-table="budget"><thead>' + head + '</thead><tbody>');
      if (incomeRows.length) {
        html.push('<tr><td colspan="' + (periods.length + 2) + '"><b>收入</b></td></tr>' + incomeRows.join(''));
      }
      if (expenseRows.length) {
        html.push('<tr><td colspan="' + (periods.length + 2) + '"><b>支出</b></td></tr>' + expenseRows.join(''));
      }
      html.push('</tbody></table>');
    }

    // ---- expense tree (one level for now) --------------------------------
    if (expenseRows.length) {
      const items = [];
      const length = Math.max(expenseSlots ? expenseSlots.length : 0, selected.expense.length);
      for (let i = 0; i < length; i += 1) {
        const amount = Number(selected.expense[i]) || 0;
        const name = slotName(expenseSlots, i);
        if (!amount || !name) continue;
        items.push(
          '<li>' + esc(name) + ' <span class="dMono">' + fmt(amount) + '</span> ' +
          '<span class="dNote">' + fmt(Math.round((amount / (expenseTotal || 1)) * 1000) / 10) + '%</span></li>',
        );
      }
      html.push(
        '<div class="dSec">支出树<span class="dSecNote">槽位表还没有分类列，所以先是一层（总支出 → 各科目）</span></div>' +
        '<ul class="dTree"><li>总支出 <b class="dMono">' + fmt(expenseTotal) + '</b>' +
        '<ul>' + items.join('') + '</ul></li></ul>',
      );
    }
    return html.join('');
  }

  /**
   * 点数：ADM / DIP / MIL 三条量条 ＋「点数去哪了」的分组明细。
   *
   * The three bars read 'powers', which the plane has carried since wave 1, so they are real
   * today; the breakdown needs 'manaSpent' and the 46-slot table, and says 数据待补 until both
   * exist.
   */
  function manaPane(row) {
    const powers = pick(row, ['powers']);
    const html = ['<div class="dSec">君主点数<span class="dSecNote">ADM / DIP / MIL</span></div>'];
    const names = ['行政 (ADM)', '外交 (DIP)', '军事 (MIL)'];
    if (Array.isArray(powers)) {
      const cap = Math.max(999, Number(powers[0]) || 0, Number(powers[1]) || 0, Number(powers[2]) || 0);
      for (let i = 0; i < 3; i += 1) {
        const value = Number(powers[i]) || 0;
        const width = Math.max(1, Math.round((value / cap) * 100));
        html.push(
          '<div class="dBar"><span class="dBarName">' + names[i] + '</span>' +
          '<span class="dBarTrack"><i style="width:' + width + '%"></i></span>' +
          '<span class="dBarVal dMono">' + fmt(value) + '</span></div>',
        );
      }
      html.push('<p class="dNote">量条按当前三项里的最大值取比例（上限至少按 999 画），条上写的是存档里的真实点数。</p>');
    } else {
      html.push('<p class="dNote">数据待补：这一份 countryDetail 里没有三项点数（powers）。</p>');
    }

    const spent = pick(row, ['manaSpent', 'mana']);
    const slots = slotList('mana');
    if (!spent || typeof spent !== 'object') {
      html.push(
        '<div class="dSec">点数去哪了</div><p class="dNote">数据待补：这一份数据面里还没有点数去向（countryDetail.manaSpent）。' +
        '面板已按冻结 schema 写好；46 个槽位的中文名由 S2 的 manaSlots.json 提供，槽位表不可用时**不会**按位置猜科目。</p>',
      );
      return html.join('');
    }
    const powers3 = [spent.adm, spent.dip, spent.mil].map(function (list) { return Array.isArray(list) ? list : []; });
    const length = Math.max(powers3[0].length, powers3[1].length, powers3[2].length);
    const totals = powers3.map(function (list) { return sumOf(list); });
    const rows = [];
    for (let i = 0; i < length; i += 1) {
      const name = slotName(slots, i);
      if (!name) continue; // no name -> no row
      const values = powers3.map(function (list) { return Number(list[i]) || 0; });
      const sum = values[0] + values[1] + values[2];
      if (!sum) continue;
      rows.push(
        '<tr><td>' + esc(name) + '</td>' +
        '<td class="num">' + fmt(values[0]) + '</td><td class="num">' + fmt(values[1]) +
        '</td><td class="num">' + fmt(values[2]) + '</td><td class="num">' + fmt(sum) + '</td></tr>',
      );
    }
    html.push(
      '<div class="dSec">点数去哪了<span class="dSecNote">合计 ADM ' + fmt(totals[0]) + ' / DIP ' + fmt(totals[1]) +
      ' / MIL ' + fmt(totals[2]) + '</span></div>',
    );
    if (!rows.length) {
      html.push('<p class="dNote">槽位表不可用或每个科目都是 0（不按位置猜科目）。</p>');
    } else {
      html.push(
        '<table class="dTable" data-sortable data-table="mana"><thead><tr><th data-sort="text">科目</th>' +
        '<th class="num" data-sort="num">ADM</th><th class="num" data-sort="num">DIP</th>' +
        '<th class="num" data-sort="num">MIL</th><th class="num" data-sort="num">合计</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>',
      );
    }
    return html.join('');
  }

  /**
   * 思潮：「已接纳 N / 8」徽章 ＋ 各省进度条。
   *
   * Deliberately *not* pdx-tools' planner (which models the cheapest way to embrace an
   * institution); this is a display. The save records institution adoption per province, not per
   * country, so the badge is the **capital province's** count and every province gets its own bar.
   */
  function institutionPane(tagIdx) {
    const provinces = [];
    for (let i = 0; i < DATA.provinceIds.length; i += 1) {
      const id = DATA.provinceIds[i];
      if (seaSet.has(id) || lakeSet.has(id)) continue;
      const raw = owner[id];
      if (raw < 0 || resolveLatest(raw) !== tagIdx) continue;
      const info = institutionById.get(id);
      // A province with no entry in the institution table has no institution progress at all —
      // that is a 0, not a missing row, and the map's institution view paints it the same way.
      // Skipping it would report "22 个省" for a country that owns 380.
      provinces.push({
        id: id,
        accepted: info ? Number(info[0]) || 0 : 0,
        inProgress: info ? Number(info[1]) : -1,
      });
    }
    if (!provinces.length) {
      return (
        '<div class="dSec">思潮</div>' +
        '<p class="dNote">该国在当前帧没有省份，也没有思潮记录。</p>'
      );
    }
    provinces.sort(function (a, b) {
      if (b.accepted !== a.accepted) return b.accepted - a.accepted;
      return provinceName(a.id).localeCompare(provinceName(b.id), 'zh-CN');
    });
    const capital = capitalOf.get(tagIdx);
    let badge = provinces[0].accepted;
    let badgeNote = '（全国最高的那个省）';
    if (capital !== undefined) {
      const at = provinces.find(function (entry) { return entry.id === capital; });
      if (at) {
        badge = at.accepted;
        badgeNote = '（首都 ' + provinceName(capital) + '）';
      }
    }
    const html = ['<div class="dSec">思潮<span class="dSecNote">已接纳 N / 8</span></div>'];
    html.push(
      '<div class="dBadge"><b class="dMono">已接纳 ' + fmt(badge) + ' / 8</b>' +
      '<span class="dNote">' + esc(badgeNote) + '。存档按省记录思潮进度（没有国家级的"已接纳"字段），' +
      '所以徽章取首都省，下面是本国每个省的进度。</span></div>',
    );
    const icons = [];
    for (let i = 0; i < INSTITUTION_NAMES.length; i += 1) {
      icons.push(iconSlot('institutions', String(i), INSTITUTION_NAMES[i] + (i < badge ? '·已接纳' : '·未接纳')));
    }
    html.push('<div class="dGrid">' + icons.join('') + '</div>');
    const cap = 300;
    const rows = provinces.slice(0, cap).map(function (entry) {
      const width = Math.max(1, Math.round((entry.accepted / INSTITUTION_NAMES.length) * 100));
      return (
        '<div class="dBar"><span class="dBarName">' + esc(provinceName(entry.id)) + '</span>' +
        '<span class="dBarTrack"><i style="width:' + width + '%"></i></span>' +
        '<span class="dBarVal dMono">' + fmt(entry.accepted) + ' / 8' +
        (entry.inProgress >= 0 ? '·进行中' : '') + '</span></div>'
      );
    });
    html.push(
      '<div class="dSec">各省进度<span class="dSecNote">' + fmt(provinces.length) + ' 个省，按已接纳数降序' +
      (provinces.length > cap ? '（只列前 ' + cap + ' 条）' : '') + '</span></div>' + rows.join(''),
    );
    return html.join('');
  }

  // ---- wave 2: 建筑 / 州 / 阶级 / 顾问 -----------------------------------
  // The four tabs of 省份国家界面阶段任务书.md §7, built on the frozen schema in §2. S1 packs
  // 'buildingCount' / 'states' / 'estates' / 'crownland' / 'advisors' into countryDetail; until
  // those land, the two tabs that *can* be answered from data the save already gives (buildings
  // and states) are derived from the province plane instead of being left blank, and the two
  // that cannot (estates, advisors) say so. The renderers are the same either way — the packed
  // value is preferred the moment it exists.

  /** A building key -> its Chinese name, from the plane's own table. */
  let buildingNames = null;
  function buildingName(key) {
    if (buildingNames === null) {
      buildingNames = new Map();
      const table = DATA.provinceBuildings;
      if (table && Array.isArray(table.dict) && Array.isArray(table.names)) {
        for (let i = 0; i < table.dict.length; i += 1) {
          if (table.names[i]) buildingNames.set(table.dict[i], table.names[i]);
        }
      }
    }
    return buildingNames.get(key) || uiNameOf('buildings', key) || key;
  }

  /**
   * 建筑：一条一栋建筑（名字 ｜ 拥有它的省份数），按建筑名排序（§7 的验收要求）。
   *
   * With 'countryDetail.buildingCount' it is the packed answer. Without it, the same number is
   * aggregated here from the province block's own 'buildings' snapshot, restricted to the
   * provinces the country holds at the current frame — that is what the packed key describes,
   * so a row means the same thing either way.
   */
  function buildingsPane(tagIdx, row) {
    const packed = pick(row, ['buildingCount', 'buildingCounts']);
    let rows = null;
    let derived = false;
    if (Array.isArray(packed)) {
      rows = [];
      for (let i = 0; i < packed.length; i += 1) {
        const entry = packed[i] || {};
        const key = String(entry.building || '');
        if (!key) continue;
        rows.push({ name: buildingName(key), count: Number(entry.provinces) || 0 });
      }
    } else if (DATA.provinceBuildings && Array.isArray(DATA.provinceBuildings.rows)) {
      derived = true;
      const counts = new Map();
      for (let i = 0; i < DATA.provinceIds.length; i += 1) {
        const id = DATA.provinceIds[i];
        if (seaSet.has(id) || lakeSet.has(id)) continue;
        const raw = owner[id];
        if (raw < 0 || resolveLatest(raw) !== tagIdx) continue;
        const record = rowFor(DATA.provinceBuildings, id);
        if (!record) continue;
        for (let k = 1; k < record.length; k += 1) {
          const key = tableKey(DATA.provinceBuildings, record[k]);
          if (!key) continue;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      rows = [];
      for (const pair of counts.entries()) rows.push({ name: buildingName(pair[0]), count: pair[1] });
    }
    if (!rows || !rows.length) {
      return (
        '<div class="dSec">全国建筑</div>' +
        '<p class="dNote">这一份数据面里没有建筑统计（countryDetail.buildingCount），也没有可聚合的省份建筑记录。</p>'
      );
    }
    rows.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-CN'); });
    let max = 1;
    let total = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].count > max) max = rows[i].count;
      total += rows[i].count;
    }
    const bars = rows.map(function (entry) {
      const width = Math.max(2, Math.round((entry.count / max) * 100));
      return (
        '<div class="dBar"><span class="dBarName">' + esc(entry.name) + '</span>' +
        '<span class="dBarTrack"><i style="width:' + width + '%"></i></span>' +
        '<span class="dBarVal dMono">' + fmt(entry.count) + '</span></div>'
      );
    });
    return (
      '<div class="dSec">全国建筑<span class="dSecNote">建筑名 ｜ 拥有它的省份数' +
      (derived ? '（由省份快照聚合；数据面 buildingCount 就位后自动改用存档值）' : '（数据面 countryDetail.buildingCount）') +
      '</span></div>' +
      '<p class="dNote">共 ' + fmt(total) + ' 座，' + fmt(rows.length) + ' 种建筑（按名称排序）。</p>' +
      bars.join('')
    );
  }

  /**
   * 州：州名 ｜ 发展度 ｜ 繁荣度 ｜ 州议会 ｜ 首都州★（§7 的验收要求）。
   *
   * 治理成本与集权由游戏规则公式算，本波先不提供（表下有一行说明），不猜数。
   * With 'countryDetail.states' the packed rows are printed as they are; without it the rows are
   * derived from the province plane (current ownership grouped by area) plus the save's own
   * 'areaDetail' for prosperity, which is where the packed key would read them from too.
   */
  function statesPane(tagIdx, row) {
    const packed = pick(row, ['states']);
    let rows = null;
    let derived = false;
    if (Array.isArray(packed)) {
      rows = packed.map(function (state) {
        const entry = state || {};
        return {
          name: entry.name || (entry.area ? (uiNameOf('areas', entry.area) || entry.area) : DASH),
          dev: Number(entry.dev) || 0,
          prosperity: entry.prosperity === undefined || entry.prosperity === null ? null : Number(entry.prosperity),
          capital: Boolean(entry.capitalState),
          house: entry.stateHouse === undefined || entry.stateHouse === null ? null : Boolean(entry.stateHouse),
          area: entry.area || '',
        };
      });
      // The packed order is the area key's, which says nothing to a reader: the most developed
      // state is the one worth seeing first. Ties fall back to the name, so the table is stable.
      rows.sort(function (a, b) {
        if (b.dev !== a.dev) return b.dev - a.dev;
        return String(a.name).localeCompare(String(b.name), 'zh-CN');
      });
    } else {
      derived = true;
      const capital = capitalOf.get(tagIdx);
      const byArea = new Map();
      for (let i = 0; i < DATA.provinceIds.length; i += 1) {
        const id = DATA.provinceIds[i];
        if (seaSet.has(id) || lakeSet.has(id)) continue;
        const raw = owner[id];
        if (raw < 0 || resolveLatest(raw) !== tagIdx) continue;
        const areaIdx = areaOf(id);
        if (areaIdx === null) continue;
        let entry = byArea.get(areaIdx);
        if (!entry) {
          entry = { areaIdx: areaIdx, dev: 0, provinces: 0 };
          byArea.set(areaIdx, entry);
        }
        entry.dev += tax[id] + production[id] + manpower[id];
        entry.provinces += 1;
      }
      rows = [];
      for (const entry of byArea.values()) {
        const detail = DATA.areaDetail ? DATA.areaDetail[String(entry.areaIdx)] : null;
        let mine = null;
        if (detail && Array.isArray(detail.states)) {
          for (let i = 0; i < detail.states.length; i += 1) {
            const candidate = detail.states[i];
            if (candidate && resolveLatest(Number(candidate.tagIdx)) === tagIdx) { mine = candidate; break; }
          }
        }
        rows.push({
          name: areaName(entry.areaIdx),
          dev: entry.dev,
          prosperity: mine && mine.prosperity !== undefined ? Number(mine.prosperity) : null,
          capital: capital !== undefined && areaOf(capital) === entry.areaIdx,
          house: null,
          area: '',
          provinces: entry.provinces,
        });
      }
      rows.sort(function (a, b) { return b.dev - a.dev; });
    }
    if (!rows.length) {
      return '<div class="dSec">州</div><p class="dNote">该国在当前帧没有州（存档也没有它的州记录）。</p>';
    }
    let total = 0;
    let capitalName = '';
    const body = rows.map(function (entry) {
      total += entry.dev;
      if (entry.capital) capitalName = entry.name || '';
      return (
        '<tr><td>' + (entry.capital ? '★ ' : '') + esc(entry.name || DASH) + '</td>' +
        '<td class="num">' + fmt(entry.dev) + '</td>' +
        '<td class="num">' + (entry.prosperity === null ? DASH : fmt(entry.prosperity)) + '</td>' +
        '<td>' + (entry.house === null ? DASH : entry.house ? '有' : '无') + '</td>' +
        '<td>' + (entry.capital ? '★' : '') + '</td></tr>'
      );
    });
    return (
      '<div class="dSec">州<span class="dSecNote">' + fmt(rows.length) + ' 个州' +
      (derived ? '（由当前帧归属＋存档州记录推算；数据面 countryDetail.states 就位后自动改用存档值）' : '（数据面 countryDetail.states）') +
      '</span></div>' +
      '<table class="dTable" data-sortable data-table="states"><thead><tr><th data-sort="text">州名</th>' +
      '<th class="num" data-sort="num">发展度</th><th class="num" data-sort="num">繁荣度</th>' +
      '<th data-sort="text">州议会</th><th data-sort="text">首都州</th></tr></thead>' +
      '<tbody>' + body.join('') + '</tbody></table>' +
      '<p class="dNote">共 ' + fmt(total) + ' 发展度' +
      (capitalName ? '；首都州是 ' + esc(capitalName) + '（带 ★）' : '') +
      '。治理成本与集权：暂不提供（要先复刻游戏规则公式，等数据面或规则表就位）。</p>'
    );
  }

  /**
   * EU4 localisation leftovers, tidied for display.
   *
   * The estate strings the plane carries are the game's own localisation lines, placeholders
   * and all: colour codes (a section sign plus a letter), '$ESTATE_NAME$' for the estate's own
   * name, and '$VAL…$' for the number that sits in the value column beside them. Substituting
   * them is presentation, not invention — the game does exactly this at runtime.
   */
  function tidyLoc(text, value, estate) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/§[A-Za-z!]/g, '')
      .replace(/\$ESTATE_NAME\$/g, estate || '')
      .replace(/\$VAL[^$]*\$/g, value === undefined || value === null ? '' : String(value))
      .replace(/\$[A-Z_]+\$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  /** An estate's own name: the plane keys them as 'estate_<kind>'. */
  function estateLabelOf(kind) {
    return uiNameOf('estates', 'estate_' + kind) || uiNameOf('estates', kind) || kind;
  }

  /** 阶级：王室领地条 ＋ 每个阶级一张卡（忠诚度 / 领地占比 / 议程 / 特权表 / 影响力修正表）。 */
  function estatesPane(row) {
    const estates = pick(row, ['estates']);
    if (!Array.isArray(estates)) {
      return (
        '<div class="dSec">阶级</div>' +
        '<p class="dNote">这一份数据面里还没有阶级数据（countryDetail.estates / crownland）。' +
        '面板已按冻结的 schema 写好：数据一到就显示王室领地条，以及每个阶级一张卡（忠诚度 / 领地占比 / 已完成议程 / 特权表 / 影响力修正表）。</p>'
      );
    }
    // An empty list is a *fact* about the country (a tribe has no estates), not missing data.
    if (!estates.length) return '<div class="dSec">阶级</div><p class="dNote">无阶级</p>';
    const html = ['<div class="dSec">阶级</div>'];
    const crown = pick(row, ['crownland']);
    if (crown !== null && crown !== undefined && crown !== '') {
      const percent = Math.max(0, Math.min(100, Number(crown) || 0));
      html.push(
        '<div class="dCrown"><span class="dCrownLabel">王室领地</span>' +
        '<span class="dBarTrack"><i style="width:' + percent.toFixed(1) + '%"></i></span>' +
        '<span class="dBarVal dMono">' + fmt(crown) + '%</span></div>',
      );
    }
    for (let i = 0; i < estates.length; i += 1) {
      const estate = estates[i] || {};
      const kind = String(estate.kind || '');
      const estateName = estateLabelOf(kind);
      const parts = [];
      parts.push('<h5>' + esc(estateName) + '</h5>');
      parts.push('<div class="dRow"><span class="k">忠诚度</span><span class="v">' + fmt(estate.loyalty) + '%</span></div>');
      parts.push('<div class="dRow"><span class="k">领地占比</span><span class="v">' + fmt(estate.territory) + '%</span></div>');
      parts.push('<div class="dRow"><span class="k">已完成议程</span><span class="v">' + fmt(estate.agendas) + '</span></div>');
      const privileges = Array.isArray(estate.privileges) ? estate.privileges : [];
      if (privileges.length) {
        const rows = privileges.map(function (privilege) {
          const key = String(privilege.name || '');
          const label = tidyLoc(uiNameOf('estatePrivileges', key) || key, undefined, estateName);
          return '<tr><td>' + esc(label) + '</td><td class="d">' + esc(privilege.since || DASH) + '</td></tr>';
        });
        parts.push(
          '<div class="dSec">特权</div><table class="dTable" data-sortable data-table="estates">' +
          '<thead><tr><th data-sort="text">特权</th><th data-sort="date">自</th></tr></thead><tbody>' +
          rows.join('') + '</tbody></table>',
        );
      }
      const influences = Array.isArray(estate.influences) ? estate.influences : [];
      if (influences.length) {
        const rows = influences.map(function (influence) {
          const key = String(influence.name || '');
          const label = tidyLoc(uiNameOf('estateInfluenceModifiers', key) || key, influence.value, estateName);
          return '<tr><td>' + esc(label) + '</td><td class="num dMono">' + esc(influence.value || DASH) +
            '</td><td class="d">' + esc(influence.expires || DASH) + '</td></tr>';
        });
        parts.push(
          '<div class="dSec">影响力修正</div><table class="dTable" data-sortable data-table="estates">' +
          '<thead><tr><th data-sort="text">修正</th><th class="num" data-sort="num">值</th>' +
          '<th data-sort="date">到期</th></tr></thead><tbody>' +
          rows.join('') + '</tbody></table>',
        );
      }
      html.push('<div class="dCard">' + parts.join('') + '</div>');
    }
    return html.join('');
  }

  /** 顾问：名臣顾问卡（名字 / 类型 / 获得日期）；没有名臣只留那一行文字。 */
  function advisorsPane(row) {
    const advisors = pick(row, ['advisors', 'advisorsHired']);
    if (!Array.isArray(advisors)) {
      return (
        '<div class="dSec">名臣顾问</div>' +
        '<p class="dNote">这一份数据面里还没有顾问记录（countryDetail.advisors）。' +
        '面板已按冻结的 schema 写好：数据一到就显示每位名臣的名字、类型与获得日期。</p>'
      );
    }
    if (!advisors.length) return '<div class="dSec">名臣顾问</div><p class="dNote">没有名臣顾问（存档里这一栏是空的）。</p>';
    const cards = advisors.map(function (advisor) {
      const entry = advisor || {};
      const name = entry.name ? advisorNameOf(entry.name) : DASH;
      // The schema's 'id' is the *type* key (diplomat, philosopher…) while 'name' is already
      // what the plane chose to print — today the type name in Chinese. So the type row appears
      // only once a type-name table exists, instead of repeating the title in English.
      const type = entry.id ? uiNameOf('advisorTypes', entry.id) : '';
      return (
        '<div class="dCard"><h5>' + esc(name) + '</h5>' +
        (type ? '<div class="dRow"><span class="k">类型</span><span class="v">' + esc(type) + '</span></div>' : '') +
        '<div class="dRow"><span class="k">获得日期</span><span class="v dMono">' + esc(entry.date || DASH) + '</span></div></div>'
      );
    });
    return (
      '<div class="dSec">名臣顾问<span class="dSecNote">' + fmt(advisors.length) + ' 位</span></div>' + cards.join('')
    );
  }

  function scalar(row, names, render) {
    const value = pick(row, names);
    if (value === null || value === undefined || value === '') return DASH;
    return render ? render(value) : fmt(value);
  }
  /**
   * A manpower figure, in the unit the game itself shows.
   *
   * EU4 writes manpower, its cap and its reinforcement rate into the save in **thousands**
   * (96.997 is 96,997 men), which is why the packed numbers look small next to the
   * province counts. Printing the raw value would say "96.997" and read as nonsense.
   */
  function thousands(value) {
    if (value === null || value === undefined || value === '') return DASH;
    const n = Number(value);
    if (!isFinite(n)) return DASH;
    return fmt(n) + ' 千（' + Math.round(n * 1000).toLocaleString('zh-CN') + '）';
  }

  function generalPane(tagIdx, tag, row, agg) {
    const html = [];
    const dev = pick(row, ['development']);
    const rawDev = pick(row, ['rawDevelopment']);
    const powers = pick(row, ['powers']);
    const powerCell = Array.isArray(powers)
      ? fmt(powers[0]) + ' / ' + fmt(powers[1]) + ' / ' + fmt(powers[2])
      : DASH;
    const rows = [
      ['行政 / 外交 / 军事点数', powerCell],
      ['国库', scalar(row, ['treasury'])],
      ['负债', scalar(row, ['debt'])],
      ['通胀', scalar(row, ['inflation'], function (v) { return fmt(v) + '%'; })],
      ['威望', scalar(row, ['prestige'])],
      ['稳定', scalar(row, ['stability'])],
      ['正统性 / 政府强度', governmentStrength(row)],
      ['力量投射', scalar(row, ['powerProjection'])],
      ['创新度', scalar(row, ['innovativeness'])],
      ['腐败', scalar(row, ['corruption'])],
      ['重商主义', scalar(row, ['mercantilism'])],
      ['辉煌点数', scalar(row, ['splendor'])],
      ['原始发展度', rawDev === null ? DASH : fmt(rawDev)],
      ['发展度（含建筑加成）', dev === null ? fmt(agg.dev) + '（由省份回放推算）' : fmt(dev)],
      ['平均自治度', scalar(row, ['autonomyPercent'], function (v) { return fmt(v) + '%'; })],
      ['省份数', (pick(row, ['provinces']) === null ? fmt(agg.provinces) + '（推算）' : fmt(pick(row, ['provinces'])))],
      ['城市数（发展度 ≥ 10）', (pick(row, ['cities']) === null ? fmt(agg.cities) + '（推算）' : fmt(pick(row, ['cities'])))],
      ['过度扩张', scalar(row, ['overextension'], function (v) { return fmt(v) + '%'; })],
      ['宗教统一度', scalar(row, ['religiousUnity'], function (v) { return fmt(v) + '%'; })],
      ['专制主义', absolutismCell(row)],
      ['科技（行 / 外 / 军）', techCell(row)],
      ['政体', governmentCell(row)],
    ];
    const cells = [];
    for (let i = 0; i < rows.length; i += 1) {
      cells.push('<div class="dRow"><span class="k">' + rows[i][0] + '</span><span class="v">' + rows[i][1] + '</span></div>');
    }
    html.push('<div class="dSec">国力</div>');
    html.push('<div class="dKV">' + cells.join('') + '</div>');

    // 使者 row: pdx-tools draws the four envoy types as icons with counts.
    const envoys = pick(row, ['envoys']);
    if (envoys && typeof envoys === 'object') {
      html.push(
        '<div class="dRow"><span class="k">使者</span><span class="v">' +
          '商人 ' + fmt(envoys.merchants) + ' · 殖民者 ' + fmt(envoys.colonists) +
          ' · 外交官 ' + fmt(envoys.diplomats) + ' · 传教士 ' + fmt(envoys.missionaries) +
          '</span></div>',
      );
    }
    html.push(
      '<div class="dRow"><span class="k">国教</span><span class="v">' +
        (row && row.religion ? esc(religionNameOf(row.religion)) : DASH) + '</span></div>',
    );
    html.push(
      '<div class="dRow"><span class="k">主文化</span><span class="v">' +
        (row && row.primaryCulture ? esc(cultureNameByKey(row.primaryCulture)) : DASH) +
        (row && row.dominantCulture && row.dominantCulture !== row.primaryCulture
          ? '（主导：' + esc(cultureNameByKey(row.dominantCulture)) + '）'
          : '') +
        '</span></div>',
    );
    if (row && Array.isArray(row.acceptedCultures) && row.acceptedCultures.length) {
      html.push(
        '<div class="dRow"><span class="k">已接受文化</span><span class="v">' +
          row.acceptedCultures.map(function (name) { return esc(cultureNameByKey(name)); }).join('、') + '</span></div>',
      );
    }
    html.push(
      '<div class="dRow"><span class="k">国家 ID</span><span class="v">' +
        (row && row.countryId !== undefined && row.countryId !== null ? fmt(row.countryId) : DASH) + '</span></div>',
    );

    // ---- military ---------------------------------------------------------
    const army = pick(row, ['army']);
    const navy = pick(row, ['navy']);
    if (arrayHas(army) || arrayHas(navy)) {
      html.push('<div class="dSec">军事</div>');
      if (arrayHas(army)) {
        html.push(
          '<div class="dRow"><span class="k">陆军</span><span class="v">步 ' + fmt(army[0]) + ' · 骑 ' + fmt(army[1]) +
            ' · 炮 ' + fmt(army[2]) + (army.length > 3 ? ' · 雇佣 ' + fmt(army[3]) : '') + '（团）</span></div>',
        );
      }
      if (arrayHas(navy)) {
        html.push(
          '<div class="dRow"><span class="k">海军</span><span class="v">重型 ' + fmt(navy[0]) + ' · 轻型 ' + fmt(navy[1]) +
            ' · 桨帆 ' + fmt(navy[2]) + ' · 运输 ' + fmt(navy[3]) + '（艘）</span></div>',
        );
      }
      html.push(
        '<div class="dRow"><span class="k">人力</span><span class="v">' +
          thousands(row ? row.manpower : null) + ' / 上限 ' + thousands(row ? row.maxManpower : null) +
          '（月补员 ' + thousands(row ? row.reinforce : null) + '）</span></div>',
      );
      html.push(
        '<div class="dRow"><span class="k">士气</span><span class="v">陆军 ' + scalar(row, ['landMorale']) +
          ' · 海军 ' + scalar(row, ['navalMorale']) + '</span></div>',
      );
      html.push(
        '<div class="dRow"><span class="k">职业化 / 传统</span><span class="v">职业化 ' + scalar(row, ['professionalism']) +
          ' · 陆军传统 ' + scalar(row, ['armyTradition']) + ' · 海军传统 ' + scalar(row, ['navyTradition']) + '</span></div>',
      );
      const best = bestLeaders(row);
      if (best) html.push('<div class="dRow"><span class="k">最佳将领</span><span class="v">' + best + '</span></div>');
    }

    // ---- monarch ----------------------------------------------------------
    const monarch = pick(row, ['monarch']);
    if (monarch && typeof monarch === 'object') {
      html.push('<div class="dSec">当前君主</div>');
      html.push(
        '<div class="dRow"><span class="k">姓名</span><span class="v">' + esc(monarch.name || DASH) +
          (monarch.dynasty ? ' · ' + esc(monarch.dynasty) + ' 王朝' : '') + '</span></div>',
      );
      html.push(
        '<div class="dRow"><span class="k">能力</span><span class="v">行政 ' + fmt(monarch.adm) + ' · 外交 ' + fmt(monarch.dip) +
          ' · 军事 ' + fmt(monarch.mil) + '（合计 ' + fmt((Number(monarch.adm) || 0) + (Number(monarch.dip) || 0) + (Number(monarch.mil) || 0)) + '）</span></div>',
      );
      html.push('<div class="dRow"><span class="k">年龄 / 登基</span><span class="v">' + fmt(monarch.age) + ' 岁 · ' + esc(monarch.inaugurated || DASH) + '</span></div>');
      if (Array.isArray(monarch.personalities) && monarch.personalities.length) {
        html.push('<div class="dRow"><span class="k">性格</span><span class="v">' +
          monarch.personalities.map(function (key) { return esc(personalityNameOf(key)); }).join('、') + '</span></div>');
      }
      if (monarch.culture || monarch.religion) {
        html.push('<div class="dRow"><span class="k">文化 / 宗教</span><span class="v">' +
          esc(monarch.culture ? cultureNameByKey(monarch.culture) : DASH) + ' · ' +
          esc(monarch.religion ? religionNameOf(monarch.religion) : DASH) + '</span></div>');
      }
    }

    // ---- ideas -----------------------------------------------------------
    const ideas = pick(row, ['ideas']);
    if (Array.isArray(ideas) && ideas.length) {
      html.push('<div class="dSec">理念</div>');
      const cards = [];
      for (let i = 0; i < ideas.length; i += 1) {
        const idea = ideas[i] || {};
        const total = Number(idea.total) || 7;
        const unlocked = Number(idea.unlocked) || 0;
        const pips = [];
        for (let k = 0; k < total; k += 1) pips.push('<i class="' + (k < unlocked ? 'on' : '') + '"></i>');
        cards.push(
          '<div class="dRow"><span class="k">' + esc(ideaGroupNameOf(idea.group) || ('理念组 ' + (i + 1))) + '</span><span class="v">' +
            unlocked + ' / ' + total + '<span class="dPip">' + pips.join('') + '</span></span></div>',
        );
      }
      html.push(cards.join(''));
    }

    // ---- diplomacy -------------------------------------------------------
    // Group-level emptiness hides the group: a country with no relations at all shows no
    // 外交 heading, which is what pdx-tools does and what the user asked for.
    const dipRows = [];
    const overlord = pick(row, ['overlord']);
    if (overlord) dipRows.push(['宗主', esc(String(overlord).toUpperCase())]);
    const parent = pick(row, ['colonialParent']);
    if (parent) dipRows.push(['母国', esc(String(parent).toUpperCase())]);
    dipRows.push(['宿敌', joinTags(pick(row, ['rivals']))]);
    dipRows.push(['盟友', joinTags(pick(row, ['allies', 'ally']))]);
    dipRows.push(['附属国', joinTags(pick(row, ['subjects']))]);
    dipRows.push(['正在交战', joinTags(pick(row, ['atWar', 'enemies']))]);
    const present = dipRows.filter(function (entry) { return entry[1] !== ''; });
    if (present.length) {
      html.push('<div class="dSec">外交</div>');
      for (let i = 0; i < present.length; i += 1) {
        html.push('<div class="dRow"><span class="k">' + present[i][0] + '</span><span class="v">' + present[i][1] + '</span></div>');
      }
    }
    return html.join('');
  }
  function arrayHas(value) {
    return Array.isArray(value) && value.length > 0;
  }
  function joinTags(value) {
    if (!Array.isArray(value) || !value.length) return '';
    const names = tagIndices(value).map(function (idx) { return tagName(idx); });
    if (names.length) return names.map(esc).join(' · ');
    return value.map(function (entry) { return esc(String(entry)); }).join(' · ');
  }
  function governmentStrength(row) {
    if (!row) return DASH;
    const kind = row.governmentStrengthKind;
    const value = row.governmentStrength;
    if (value === undefined || value === null) return DASH;
    const labels = {
      legitimacy: '正统性', republican_tradition: '共和传统', devotion: '虔诚',
      meritocracy: '贤能', horde_unity: '部落统一', native: '部落', 
    };
    return fmt(value) + (kind && labels[kind] ? '（' + labels[kind] + '）' : kind ? '（' + kind + '）' : '');
  }
  function governmentCell(row) {
    if (!row) return DASH;
    const name = row.government || '';
    const rank = Number(row.governmentRank);
    const rankLabel = rank === 3 ? '帝国' : rank === 2 ? '王国' : rank === 1 ? '公国' : '';
    const reforms = Array.isArray(row.governmentReforms) && row.governmentReforms.length
      ? '（' + row.governmentReforms.map(function (key) { return esc(uiNameOf('governmentReforms', key) || key); }).join('、') + '）'
      : '';
    if (!name) return DASH;
    return esc(name) + (rankLabel ? ' · ' + rankLabel : '') + reforms;
  }
  function techCell(row) {
    const tech = row ? row.tech : null;
    if (!Array.isArray(tech)) return DASH;
    return fmt(tech[0]) + ' / ' + fmt(tech[1]) + ' / ' + fmt(tech[2]);
  }
  function absolutismCell(row) {
    const value = row ? row.absolutism : null;
    // The save really does not record absolutism in this game version — the frozen
    // schema types it as 'number | null' for exactly this reason. Saying "not recorded"
    // is the honest answer, and it is what the acceptance checklist expects to see.
    if (value === null || value === undefined) return DASH + '<span class="dNote" style="display:inline">存档未记录</span>';
    return fmt(value);
  }
  function bestLeaders(row) {
    const names = [];
    for (const key of ['bestGeneral', 'bestAdmiral']) {
      const best = row ? row[key] : null;
      if (!best || !best.name) continue;
      names.push(
        esc(best.name) + '（火 ' + fmt(best.fire) + ' 冲 ' + fmt(best.shock) + ' 机 ' + fmt(best.maneuver) +
          ' 围 ' + fmt(best.siege) + '）',
      );
    }
    return names.length ? names.join('　') : '';
  }

  function rulersPane(row) {
    const rulers = pick(row, ['rulers']);
    if (!Array.isArray(rulers) || !rulers.length) {
      return '<p class="dNote">没有历代君主记录（数据面待补：countryDetail.rulers）。</p>';
    }
    const rows = rulers.map(function (r) {
      const total = (Number(r.adm) || 0) + (Number(r.dip) || 0) + (Number(r.mil) || 0);
      return (
        '<tr><td>' + esc(r.name || DASH) + '</td><td class="d">' + esc(r.start || DASH) + '</td>' +
        '<td class="d">' + esc(r.end || '在位') + '</td><td class="num">' + fmt(r.months) + '</td>' +
        '<td>' + (Array.isArray(r.personalities) && r.personalities.length
          ? r.personalities.map(function (key) { return esc(personalityNameOf(key)); }).join('、')
          : DASH) + '</td>' +
        '<td class="num" data-sort="' + total + '">' + fmt(r.adm) + ' / ' + fmt(r.dip) + ' / ' + fmt(r.mil) + '</td>' +
        '<td class="num">' + fmt(total) + '</td></tr>'
      );
    });
    let html =
      '<div class="dSec">历代君主<span class="dSecNote">名 ｜ 起 ｜ 止 ｜ 在位月数 ｜ 性格 ｜ 三维 ｜ 合计</span></div>' +
      '<table class="dTable" data-sortable data-table="rulers"><thead><tr><th data-sort="text">名</th>' +
      '<th data-sort="date">起</th><th data-sort="date">止</th><th class="num" data-sort="num">在位</th>' +
      '<th data-sort="text">性格</th><th class="num" data-sort="num">ADM/DIP/MIL</th>' +
      '<th class="num" data-sort="num">合计</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody></table>';
    const heirs = pick(row, ['failedHeirs']);
    if (Array.isArray(heirs) && heirs.length) {
      const sub = heirs.map(function (h) {
        const heirTotal = (Number(h.adm) || 0) + (Number(h.dip) || 0) + (Number(h.mil) || 0);
        return '<tr><td>' + esc(h.name || DASH) + '</td><td class="d">' + esc(h.birth || DASH) + '</td><td>' +
          (Array.isArray(h.personalities) && h.personalities.length
            ? h.personalities.map(function (key) { return esc(personalityNameOf(key)); }).join('、')
            : DASH) + '</td>' +
          '<td class="num" data-sort="' + heirTotal + '">' + fmt(h.adm) + ' / ' + fmt(h.dip) + ' / ' + fmt(h.mil) + '</td></tr>';
      });
      html += '<div class="dSec">未继位的继承人</div>' +
        '<table class="dTable" data-sortable data-table="failedHeirs"><thead><tr><th data-sort="text">名</th>' +
        '<th data-sort="date">出生</th><th data-sort="text">性格</th>' +
        '<th class="num" data-sort="num">ADM/DIP/MIL</th></tr></thead><tbody>' +
        sub.join('') + '</tbody></table>';
    }
    return html;
  }

  const LEADER_KINDS = {
    general: '将军', admiral: '海军上将', explorer: '探险家', conquistador: '征服者',
    monarch: '君主', active: '在职', ruler: '君主',
  };
  function leaderKindLabel(kind) {
    const key = String(kind || '').toLowerCase();
    return LEADER_KINDS[key] || String(kind || '');
  }
  function leadersPane(row) {
    const leaders = pick(row, ['leaders']);
    if (!Array.isArray(leaders) || !leaders.length) {
      return '<p class="dNote">没有将领记录（数据面待补：countryDetail.leaders）。</p>';
    }
    const rows = leaders.map(function (l) {
      const total = (Number(l.fire) || 0) + (Number(l.shock) || 0) + (Number(l.maneuver) || 0) + (Number(l.siege) || 0);
      const tags = [];
      if (l.active) tags.push('在职');
      if (l.kind) tags.push(leaderKindLabel(l.kind));
      return (
        '<tr><td>' + esc(l.name || DASH) + '</td><td>' + tags.map(esc).join(' · ') + '</td>' +
        '<td class="d">' + esc(l.activation || DASH) + '</td>' +
        '<td class="num">' + fmt(l.fire) + '</td><td class="num">' + fmt(l.shock) + '</td>' +
        '<td class="num">' + fmt(l.maneuver) + '</td><td class="num">' + fmt(l.siege) + '</td>' +
        '<td class="num">' + fmt(total) + '</td></tr>'
      );
    });
    return (
      '<div class="dSec">将领<span class="dSecNote">名 ｜ 标签 ｜ 激活日期 ｜ 火力·冲击·机动·围城 ｜ 合计</span></div>' +
      '<table class="dTable" data-sortable data-table="leaders"><thead><tr><th data-sort="text">名</th>' +
      '<th data-sort="text">标签</th><th data-sort="date">激活</th>' +
      '<th class="num" data-sort="num">火</th><th class="num" data-sort="num">冲</th>' +
      '<th class="num" data-sort="num">机</th><th class="num" data-sort="num">围</th>' +
      '<th class="num" data-sort="num">合计</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody></table>'
    );
  }

  function culturePane(row, agg) {
    const stats = pick(row, ['cultureStats']);
    const primary = row ? row.primaryCulture : '';
    if (Array.isArray(stats) && stats.length) {
      const rows = stats.map(function (s) {
        const mark = s.culture === primary ? '★ ' : '';
        return (
          '<tr><td>' + mark + esc(s.culture ? cultureNameByKey(s.culture) : DASH) + '</td><td>' + esc(s.group || DASH) + '</td>' +
          '<td class="num">' + fmt(s.provinces) + '</td><td class="num">' + pct(Number(s.dev) || 0, agg.dev) + '</td>' +
          '<td class="num">' + fmt(s.statedProvinces) + '</td><td class="num">' + fmt(s.statedDev) + '</td></tr>'
        );
      });
      return (
        '<div class="dSec">文化构成<span class="dSecNote">数据面 countryDetail.cultureStats</span></div>' +
        '<table class="dTable" data-sortable data-table="culture"><thead><tr><th data-sort="text">文化</th>' +
        '<th data-sort="text">组</th><th class="num" data-sort="num">省份</th>' +
        '<th class="num" data-sort="num">发展度占比</th><th class="num" data-sort="num">已建州省份</th>' +
        '<th class="num" data-sort="num">已建州发展度</th></tr></thead>' +
        '<tbody>' + rows.join('') + '</tbody></table>'
      );
    }
    const derived = mapRows(agg.cultures, DATA.cultures, agg.dev);
    if (!derived.length) return '<p class="dNote">该国在当前帧没有省份，无法统计文化构成。</p>';
    const rows = derived.map(function (entry) {
      const mark = entry.key === primary ? '★ ' : '';
      return '<tr><td>' + mark + esc(cultureNameByKey(entry.key)) + '</td><td class="num">' + fmt(entry.dev) + '</td>' +
        '<td class="num">' + fmt(Math.round(entry.share * 1000) / 10) + '%</td></tr>';
    });
    return (
      '<div class="dSec">文化构成<span class="dSecNote">由当前帧的省份回放推算（数据面 countryDetail.cultureStats 就位后自动改用存档值）</span></div>' +
      '<table class="dTable" data-sortable data-table="culture"><thead><tr><th data-sort="text">文化</th>' +
      '<th class="num" data-sort="num">发展度</th><th class="num" data-sort="num">占比</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody></table>'
    );
  }

  function religionPane(row, agg) {
    const dev = pick(row, ['religionDev']);
    let entries = null;
    if (dev && typeof dev === 'object') {
      entries = Object.keys(dev).map(function (key) { return { key: key, dev: Number(dev[key]) || 0 }; });
      entries.sort(function (a, b) { return b.dev - a.dev; });
    }
    if (!entries) {
      entries = mapRows(agg.religions, DATA.religions, agg.dev).map(function (e) { return { key: e.key, dev: e.dev }; });
    }
    if (!entries.length) return '<p class="dNote">该国在当前帧没有省份，无法统计宗教构成。</p>';
    const total = entries.reduce(function (sum, entry) { return sum + entry.dev; }, 0) || agg.dev;
    const rows = entries.map(function (entry) {
      const label = religionNameOf(entry.key);
      return '<tr><td>' + esc(label) + '</td><td class="num">' + fmt(entry.dev) + '</td><td class="num">' +
        pct(entry.dev, total) + '</td></tr>';
    });
    return (
      '<div class="dSec">宗教构成<span class="dSecNote">按发展度加权</span></div>' +
      '<table class="dTable" data-sortable data-table="religion"><thead><tr><th data-sort="text">宗教</th>' +
      '<th class="num" data-sort="num">发展度</th><th class="num" data-sort="num">占比</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody></table>'
    );
  }

  /**
   * The country's history flow.
   *
   * With the packed key it is pdx-tools' own list. Without it, the save's province
   * history is filtered to the changes that involve this country — the same events, seen
   * from the other side, which is what makes this tab useful before S1 lands. Every entry
   * carries the "jump the map to that day" button (第三对话任务书.md §3.4 第 10 条).
   */
  function historyPane(tagIdx, row) {
    const packed = pick(row, ['history']);
    const entries = [];
    if (Array.isArray(packed)) {
      for (let i = 0; i < packed.length; i += 1) {
        const entry = packed[i] || {};
        entries.push({ date: entry.date || '', ordinal: entry.ordinal, text: entry.text || entry.kind || '', tag: -1 });
      }
    } else {
      const derived = derivedHistory(tagIdx);
      for (let i = 0; i < derived.length; i += 1) entries.push(derived[i]);
    }
    if (!entries.length) return '<p class="dNote">存档里没有这个国家的变更记录。</p>';
    jumpOrds = [];
    const rows = [];
    const cap = Math.min(entries.length, 300);
    for (let i = 0; i < cap; i += 1) {
      const entry = entries[i];
      // The packed flow dates its entries; the derived one only has an ordinal.
      const ord = entry.ordinal !== undefined && entry.ordinal !== null
        ? Number(entry.ordinal)
        : ordinalOfLabel(entry.date);
      const at = monthIndexForOrdinal(ord);
      const pinned = at >= 0 && jumpPinned === ord;
      jumpOrds.push(ord);
      const label = entry.date || dateOfOrdinal(ord);
      rows.push(
        '<tr><td class="d">' + esc(label) + '</td><td>' + esc(entry.text || DASH) + '</td><td>' +
          (at >= 0
            ? '<button class="dGo' + (pinned ? ' on' : '') + '" id="dJump' + i + '" type="button" data-ord="' + ord +
              '" title="把地图切到 ' + esc(label) + '（再点一次回到当前帧）">⏱</button>'
            : '') +
          '</td></tr>',
      );
    }
    const note = entries.length > cap ? '<p class="dNote">只显示最近 ' + cap + ' 条（共 ' + entries.length + ' 条）。</p>' : '';
    return (
      '<div class="dSec">国家历史<span class="dSecNote">日期 ｜ 事件 ｜ ⏱ 把地图切到那天</span></div>' +
      '<table class="dTable" data-sortable data-table="history"><thead><tr><th data-sort="date">日期</th>' +
      '<th data-sort="text">事件</th><th class="num"></th></tr></thead><tbody>' +
      rows.join('') + '</tbody></table>' + note
    );
  }
  /** '1574.11.12' -> the ordinal the timeline is keyed by, or -1. */
  function ordinalOfLabel(text) {
    const match = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/.exec(String(text || ''));
    if (!match) return -1;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return year * 372 + (month - 1) * 31 + (day - 1);
  }

  /**
   * The country's own history, rebuilt from the province logs.
   *
   * Two kinds of entry: the renames the save records in 'changed_tag_from' (so
   * MOS → RUS shows up as one dated line rather than two unrelated countries), and the
   * owner changes that gave this country a province. Cached per country, because the scan
   * is over every province event in the save.
   */
  let derivedHistoryCache = new Map();
  function derivedHistory(tagIdx) {
    const cached = derivedHistoryCache.get(tagIdx);
    if (cached) return cached;
    const out = [];
    for (let i = 0; i < ALIAS.length; i += 1) {
      const alias = ALIAS[i];
      if (resolveLatest(alias[2]) !== tagIdx) continue;
      out.push({
        ordinal: alias[1],
        date: dateOfOrdinal(alias[1]),
        text: '改名：' + tagName(alias[0]) + ' → ' + tagName(alias[2]),
        tag: alias[2],
      });
    }
    for (let i = 0; i < DATA.provinceEvents.length; i += 1) {
      const row = DATA.provinceEvents[i];
      if (row[2] !== FIELD.owner) continue;
      if (row[3] < 0 || resolveLatest(row[3]) !== tagIdx) continue;
      out.push({
        ordinal: row[0],
        date: dateOfOrdinal(row[0]),
        text: '获得 ' + provinceName(row[1]) + '（拥有者 → ' + tagName(row[3]) + '）',
        tag: row[3],
      });
    }
    out.sort(function (a, b) { return b.ordinal - a.ordinal; });
    derivedHistoryCache.set(tagIdx, out);
    return out;
  }

  // ---- the events --------------------------------------------------------
  // Where the pointer was when the button went down: the click/drag decision is made from
  // the distance travelled, so it has to be recorded before the drag handler runs.
  let downX = 0;
  let downY = 0;
  let downAt = 0;
  /** 'mouse' or 'touch' — which threshold this press is judged by. */
  let downPointerType = 'mouse';

  canvas.addEventListener('pointermove', function (event) {
    // Remembered whatever happens next: a view change while the mouse is still has to be able
    // to ask again where this point lands.
    pointerX = Number(event.clientX) || 0;
    pointerY = Number(event.clientY) || 0;
    hasPointer = true;
    // A *mouse* pan never updates the highlight: while the button is down the pointer is
    // moving the map, not pointing at a province. A finger is different — on a phone the
    // highlight is the only confirmation that the touch landed on land at all (§4.3 C3).
    if (dragging && event.pointerType !== 'touch') return;
    const id = rasterAt(pointerX, pointerY);
    if (isWaterId(id)) return; // ocean: the user asked for nothing to happen, so nothing does
    if (id === hoveredId) return;
    hoveredId = id;
    paintHoverLayer();
  });

  canvas.addEventListener('pointerdown', function (event) {
    if (event.pointerType === 'mouse' && event.button !== undefined && event.button !== 0) return;
    downX = Number(event.clientX) || 0;
    downY = Number(event.clientY) || 0;
    downAt = Date.now();
    downPointerType = event.pointerType === 'touch' ? 'touch' : 'mouse';
  });

  canvas.addEventListener('pointerup', function (event) {
    if (event.pointerType === 'mouse' && event.button !== undefined && event.button !== 0) return;
    // A pinch is a gesture, never a tap: two fingers travel by definition.
    if (gesturePinched) return;
    // Click versus drag, with pdx-tools' own threshold — 15px on a mouse, a more forgiving
    // 24px for a finger, both within the same short press (§4.3 C3). Without this, every
    // pan would open a panel the moment the pointer came up.
    const slop = (event.pointerType || downPointerType) === 'touch' ? TOUCH_DRAG_SLOP : DRAG_SLOP;
    const moved = Math.abs((Number(event.clientX) || 0) - downX) + Math.abs((Number(event.clientY) || 0) - downY);
    if (moved > slop || Date.now() - downAt > CLICK_MS) return;
    const id = rasterAt(event.clientX, event.clientY);
    if (isWaterId(id)) {
      // Ocean is not a province, so it never routes through the province panel: clicking
      // it is simply "close what is open".
      if (selected.kind !== 'none') clearSelection();
      return;
    }
    if (selected.kind === 'country') showCountry(ownerIdentityAt(id), id);
    else showProvince(id);
  });

  // ---- panel controls ----------------------------------------------------
  if (detailCloseEl) {
    detailCloseEl.addEventListener('click', function () { clearSelection(); });
  }
  if (detailBackEl) {
    detailBackEl.addEventListener('click', function () {
      // One level of back, exactly as the state machine defines it: a country goes back to
      // the province it was reached from, a province goes nowhere.
      if (selected.kind === 'country' && selected.back > 0) showProvince(selected.back);
      else clearSelection();
    });
  }
  if (detailEl) {
    // The sheet sits over the map but is not part of it: a click inside must never be
    // read as a click on the province underneath.
    const swallow = function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    };
    detailEl.addEventListener('mousedown', swallow);
    detailEl.addEventListener('click', swallow);
    detailEl.addEventListener('wheel', swallow);
  }
  if (detailBody) {
    detailBody.addEventListener('click', function (event) {
      const target = event.target;
      if (!target) return;
      const id = target.id || '';
      if (id.indexOf('dTab-') === 0) {
        countryTab = id.slice('dTab-'.length);
        paintDetail();
        return;
      }
      if (id === 'detailGotoCountry') {
        const raw = selected.kind === 'province' ? owner[selected.province] : -1;
        if (raw >= 0) showCountry(resolveLatest(raw), selected.province);
        return;
      }
      // The ledger's period switcher (上月 / 年初至今 / 去年). The tab itself is a snapshot, so
      // repainting the sheet is enough — nothing here depends on the frame.
      if (id.indexOf('dLedger-') === 0) {
        ledgerPeriod = id.slice('dLedger-'.length);
        paintDetail();
        return;
      }
      if (id.indexOf('dJump') === 0) {
        const at = Number(id.slice('dJump'.length));
        if (isFinite(at) && jumpOrds[at] !== undefined) jumpToOrd(jumpOrds[at]);
        return;
      }
      // Any flag in the sheet is a way into that country — pdx-tools' one-action
      // "select and open", and the reason the country panel needs no separate opener.
      const flagged = closestAttr(target, 'data-tag');
      if (flagged) openTagString(flagged.getAttribute('data-tag'));
    });
  }

  /** The nearest ancestor (or self) carrying an attribute, without Element.closest. */
  function closestAttr(node, name) {
    let cur = node;
    let depth = 0;
    while (cur && depth < 8) {
      if (cur.getAttribute && cur.getAttribute(name)) return cur;
      cur = cur.parentNode;
      depth += 1;
    }
    return null;
  }

  // The great-power table is the other way into a country panel. The rows are the host's
  // own markup, so the tag is read back from the flag the host painted into them.
  if (leaderBodyEl) {
    leaderBodyEl.addEventListener('click', function (event) {
      const tag = leaderTagOf(event.target);
      if (!tag) return;
      openTagString(tag);
    });
  }
  function leaderTagOf(node) {
    let row = node;
    let depth = 0;
    while (row && depth < 8 && row.tagName !== 'TR') {
      row = row.parentNode;
      depth += 1;
    }
    if (!row || row.tagName !== 'TR' || !row.querySelector) return '';
    const img = row.querySelector('img.flag');
    if (img && img.getAttribute) {
      const tag = img.getAttribute('data-tag');
      if (tag) return String(tag).toUpperCase();
    }
    const cell = row.querySelector('td.tag');
    if (cell && cell.textContent) return String(cell.textContent).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return '';
  }

  // ---- full screen -------------------------------------------------------
  // 第三对话任务书.md §1.8: the player becomes a fixed full-viewport column, #view takes
  // everything left over and .bar stays along the bottom — the toolbar is the one piece
  // of chrome the user asked to keep. ESC and a second click both leave.
  function isFullscreen() {
    return Boolean(playerEl && playerEl.classList.contains('screen'));
  }
  function toggleFullscreen() {
    if (!playerEl) return;
    const on = !isFullscreen();
    playerEl.classList.toggle('screen', on);
    if (document.body && document.body.classList) document.body.classList.toggle('screen', on);
    if (mapFullBtn) mapFullBtn.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏';
    // The map's own box just changed size, so the pan clamp and the filter have to be
    // recomputed or the map is left scrolled off its own edge — and the highlight has to be
    // re-resolved, because the same screen point now lands on a different province.
    clampView();
    applyView();
    refreshHoverAfterViewChange();
  }
  if (mapFullBtn) mapFullBtn.addEventListener('click', toggleFullscreen);
  // Escape leaves full screen and nothing else: the player's other keys (arrows, space)
  // are handled by the listener further down, and one event must not be obeyed twice.
  window.addEventListener('keydown', function (event) {
    if (!event) return;
    const key = event.key || event.keyCode;
    if ((key === 'Escape' || key === 'Esc' || key === 27) && isFullscreen()) toggleFullscreen();
  });

  // ---- backgrounds and themes --------------------------------------------
  // The catalogue, the hosted viewer and the generated page all mount ONE component
  // (apps/site/public/page-theme.js): it owns the 🎨 button, the panel, the wallpaper
  // carousel and the scrim, and it is what reads and writes the shared settings object.
  // Both hosts hand it over the same way — the hosted page copies the module's exports
  // onto globalThis before loading this script, the generated page inlines it as a
  // classic script — so there is no second panel here to drift out of step.
  if (typeof globalThis.mountPageTheme === 'function') {
    // The wallpapers are passed in explicitly: both hosts already have the list (the
    // bootstrap fetches wallpapers.json, the generator embeds it), and a page-relative
    // fetch would resolve against this page's own deep URL instead of the site root.
    // 'detailPanel' is what adds the 面板 opacity slider: only this page has the detail
    // sheet that variable fades, so the catalogue asks for the component without it.
    // Guarded: a component that will not load costs the 🎨 controls, never the map.
    globalThis.mountPageTheme({ wallpapers: BG, detailPanel: true }).catch(function (error) {
      console.warn('backgrounds/themes unavailable', error);
    });
  }

  // ---- settings persistence ----------------------------------------------
  // One JSON blob in localStorage, the same key the component above owns. The two
  // controls left on this page — 旗帜 and 配色 — remember themselves in it, so a local
  // read is kept: the player must still work when that component failed to load.
  const SETTINGS_KEY = 'eu4analyser.settings';
  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    } catch (error) {
      return {};
    }
  }
  /** Written through the shared component when it is present, so one place merges. */
  function saveSettings(patch) {
    if (typeof globalThis.saveSettings === 'function') {
      globalThis.saveSettings(patch);
      return;
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.assign(loadSettings(), patch)));
    } catch (error) {
      // Nothing to do: the page is fully usable without persistence.
    }
  }
  const savedSettings = loadSettings();

  // Back to the catalogue. Rewritten from scratch: the previous versions tried to
  // be clever about where the user came from (history, then referrer), and both
  // silently did nothing in a tab that was opened directly. The catalogue IS the
  // site root, so when the viewer is served over http(s) this is simply a link.
  (function () {
    var back = document.getElementById('back');
    if (!back) return;
    var servedFromSite = location.protocol === 'http:' || location.protocol === 'https:';
    back.addEventListener('click', function () {
      if (servedFromSite) {
        location.href = '/';
        return;
      }
      // Opened straight from disk: only history is available.
      if (window.history.length > 1) window.history.back();
      else back.disabled = true;
    });
  })();

  /**
   * The title-row protagonist flag strip.
   *
   * The strip belongs to the archive record (custom.protagonists) and is built inside the
   * block below, but its artwork follows the 旗帜 button, which is declared further down
   * this file because the prefixes depend on VIEWER_ASSETS. One holder, written by the
   * block and called by applyFlagSet: a page with no catalogue record simply leaves it null.
   */
  var paintHeroStrip = null;

  // ---- the archive record: title, mods, dates, protagonists (📝) --------
  // Everything the catalogue card says about this save as a *document* — the title the
  // user chose, the mod line, the in-game 结档日期, the real-world 封档日期, and which
  // countries the player ran — lives in one place: custom on /api/saves/<id>. The drawer
  // is the editor and the card is the reader, so one PATCH is the whole synchronisation:
  // there is no second copy of the data to reconcile. The heading's first segment is a
  // second *editor* for the title alone (same state.title, same PATCH), because that is
  // where the user looks for it — see rename() below. The subtitle's four fields are
  // resolved by each host from that same record (viewer-page.js) or from the save itself
  // (render-timeline.ts) and arrive as facts; nothing on this page recomputes them.
  //
  // The generated standalone page has no id and no server, so the host never defines
  // VIEWER_META there and this entire block is skipped: no button, no panel, no request,
  // and the heading stays plain, non-clickable text (the markup for the drawer is not in
  // viewer.html for the same reason). The panel is built bottom-up with single-quoted
  // string concatenation, like the rest of this classic script: it is inlined into the
  // generated HTML, so it may contain neither a backtick nor a literal closing script tag
  // (both are enforced by packages/eu4-parser/test/build-guards.test.ts).
  (function () {
    var meta = typeof VIEWER_META !== 'undefined' && VIEWER_META ? VIEWER_META : null;
    if (!meta || !meta.id) return;

    // The heading's first segment (viewer.html declares it, in the same row as the 📝
    // button). Both this and the panel's 标题 input render the single state.title below,
    // which is what makes them impossible to disagree.
    var titleEl = document.getElementById('titleText');

    var custom = meta.custom && typeof meta.custom === 'object' ? meta.custom : {};
    var state = {
      title: typeof custom.title === 'string' ? custom.title : '',
      mods: typeof custom.mods === 'string' ? custom.mods : '',
      endDate: typeof custom.endDate === 'string' ? custom.endDate : '',
      // 封档日期: when the campaign was put away in the real world, as opposed to the
      // in-game 结档日期 above it. Empty means "use the upload day", which is what the
      // card prints too.
      sealedAt: typeof custom.sealedAt === 'string' ? custom.sealedAt : '',
    };
    /** The protagonist rows in display order; the card shows at most the first three. */
    var rows = (Array.isArray(custom.protagonists) ? custom.protagonists : [])
      .filter(function (row) {
        return row && typeof row.tag === 'string' && row.tag;
      })
      .map(function (row) {
        return { tag: row.tag, player: typeof row.player === 'string' ? row.player : '' };
      });

    function esc(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    /** The date the parser read out of the save, for the end-date placeholder. */
    function parsedEndDate() {
      if (typeof VIEWER_FACTS !== 'undefined' && VIEWER_FACTS && VIEWER_FACTS.end) {
        return String(VIEWER_FACTS.end);
      }
      return '';
    }
    /** The country name the parser read out: what the heading falls back to. */
    function fallbackTitle() {
      if (typeof VIEWER_FACTS !== 'undefined' && VIEWER_FACTS && VIEWER_FACTS.title) {
        return String(VIEWER_FACTS.title);
      }
      return '';
    }
    /** The catalogue's parsed info block: version, campaign date, mod count, player tag. */
    function parsed() {
      return meta.info && typeof meta.info === 'object' ? meta.info : {};
    }
    /**
     * The upload day, in UTC.
     *
     * 'uploadedAt' is an ISO timestamp; its first ten characters are the calendar day the
     * catalogue shows everywhere else, and taking them verbatim keeps this page and the
     * card from disagreeing about which day a save joined the archive.
     */
    function uploadedDay() {
      return typeof meta.uploadedAt === 'string' ? meta.uploadedAt.slice(0, 10) : '';
    }
    /**
     * What the 封档日期 field holds: the user's own value, else the upload day.
     *
     * The same rule the summary and the catalogue card follow — custom value first, then
     * the day the archive joined it. The field is never left empty: "the default is the
     * upload day" is exactly what the user asked to see in it, and clearing it (then
     * saving) is what puts the fallback back.
     */
    function sealedPrefill() {
      return state.sealedAt || uploadedDay();
    }
    /**
     * A country tag as the server stores it: letters and digits, upper case.
     *
     * The picker hands over tags from the save, but the same normalisation runs on the
     * player tag prefilled into a fresh row, so a value that came from anywhere else
     * cannot reach the archive in a shape the cleaner would silently drop.
     */
    function normaliseTag(value) {
      return String(value === null || value === undefined ? '' : value)
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .slice(0, 4);
    }

    /**
     * The fifteen great powers, for the TAG picker.
     *
     * Two sources, in order: the record the host already normalised (VIEWER_META.leaders,
     * handed over by viewer-page.js out of the built panels) and the leaderboard the host
     * painted into the page (VIEWER_PANELS.leaders, the table body's rows). The second one
     * is what keeps the picker working for an archive whose stored data.json predates the
     * array — those files hold the HTML table either way. With neither, the list is empty
     * and the picker says so; typing a tag by hand is always available and is never
     * disabled by a missing table.
     */
    var powerCache = null;
    function greatPowers() {
      if (powerCache !== null) return powerCache;
      var out = [];
      var i;
      if (Array.isArray(meta.leaders)) {
        for (i = 0; i < meta.leaders.length && out.length < 15; i += 1) {
          var given = meta.leaders[i];
          if (!given) continue;
          var givenTag = normaliseTag(given.tag);
          if (!givenTag) continue;
          out.push({ tag: givenTag, name: given.name === null || given.name === undefined ? '' : String(given.name) });
        }
      }
      if (!out.length) {
        var table = typeof VIEWER_PANELS !== 'undefined' && VIEWER_PANELS ? VIEWER_PANELS.leaders : '';
        if (table) {
          // Row by row, by the same markup viewer-build.js emits: the tag is the cell
          // classed 'tag', and the country name is the text of the cell after the rank,
          // with the swatch span and the flag image taken out.
          var cells = String(table).split('<tr>');
          for (i = 1; i < cells.length && out.length < 15; i += 1) {
            var tagCell = /<td class="tag">([^<]*)<\/td>/.exec(cells[i]);
            if (!tagCell) continue;
            var tableTag = normaliseTag(tagCell[1]);
            if (!tableTag) continue;
            var columns = cells[i].split('</td>');
            var label = (columns[1] || '').replace(/<[^>]*>/g, '').replace(/^\s+|\s+$/g, '');
            out.push({ tag: tableTag, name: label });
          }
        }
      }
      powerCache = out;
      return out;
    }

    /** The great-power list that opens under protagonist row 'index'. */
    function pickerShell(index) {
      var powers = greatPowers();
      var id = 'profileTagList' + index;
      if (!powers.length) {
        return '<div class="taglist" id="' + id + '"><div class="pickHint">没有列强榜数据，直接输入 TAG 即可</div></div>';
      }
      var html = '';
      for (var i = 0; i < powers.length; i += 1) {
        var power = powers[i];
        var label = power.name && power.name !== power.tag ? power.tag + '-' + power.name : power.tag;
        html += '<button type="button" id="profilePick' + index + '_' + i + '">' + esc(label) + '</button>';
      }
      return '<div class="taglist" id="' + id + '">' + html + '</div>';
    }

    /** Split the id of one great-power entry back into the row and the entry it names. */
    function pickTarget(id) {
      var parts = id.slice('profilePick'.length).split('_');
      var row = Number(parts[0]);
      var entry = Number(parts[1]);
      if (!isFinite(row) || !isFinite(entry)) return null;
      return { row: row, entry: entry };
    }

    /**
     * The heading, from the state alone.
     *
     * The same rule the catalogue card follows — custom.title, else the country name
     * (there the fallback is the original file name) — so the two pages name this save
     * identically whichever editor was used last.
     */
    function paintTitle() {
      if (titleEl) titleEl.textContent = state.title || fallbackTitle();
    }

    /**
     * One field of the summary line under the heading.
     *
     * That line belongs to the host — viewer-page.js resolves it from the stored record,
     * render-timeline.ts from the save itself — so the client only ever *refreshes* it.
     * It has to: the user edits 封档日期 in the drawer, and a summary that still showed the
     * old value until a reload is exactly the "two places disagree" the user objected to.
     */
    function paintFact(key, value) {
      var all = document.querySelectorAll('[data-fact]');
      for (var i = 0; i < all.length; i += 1) {
        if (all[i].getAttribute('data-fact') === key) all[i].textContent = String(value);
      }
    }
    /**
     * The four summary fields, resolved the way the host resolves them.
     *
     * Written out once here instead of at each call site, so the drawer, the line above it
     * and the catalogue card cannot end up with three readings of the same fallback chain.
     */
    function paintSummary() {
      var info = parsed();
      paintFact('version', info.version || '—');
      paintFact('endDate', state.endDate || info.campaignDate || '—');
      paintFact('sealedAt', sealedPrefill() || '—');
      paintFact('mods', state.mods || (info.modCount ? info.modCount + ' 个' : '—'));
    }

    // Both the trigger and the drawer hang off the heading row: the button is the last
    // flex item on the line the title is on (the row's own CSS puts it flush right), and
    // the row being position:relative is what makes the panel open from under it instead
    // of from a corner. The body fallback only exists so a page without the row still
    // gets a working drawer rather than a TypeError.
    var headRow = document.getElementById('headRow');
    var host = headRow || document.body;
    var status = document.createElement('span');
    status.id = 'titleStatus';
    var button = document.createElement('button');
    button.id = 'profileBtn';
    button.type = 'button';
    button.title = '档案信息：标题、模组、结档日期、封档日期、主角国家（目录页卡片显示的就是这些）';
    // Icon and words are separate nodes so the narrow-window rule in viewer.html can drop
    // the label and keep the 📝, instead of squeezing the heading.
    button.innerHTML = '<span class="ico">📝</span><span class="lbl">修改存档信息</span>';
    var panel = document.createElement('div');
    panel.id = 'profilePanel';
    host.appendChild(status);
    host.appendChild(button);
    host.appendChild(panel);

    // ---- the protagonist flag strip, immediately left of 📝 ---------------
    // The countries the player ran, in the drawer's own order: the same block the catalogue
    // card prints, five to a page, with the arrows drawn only when a second page exists and
    // each end disabling the arrow that would step past it. The artwork set follows the
    // 旗帜 button (applyFlagSet calls back in through paintHeroStrip), so switching to 国家娘
    // changes the strip and the map together. With no protagonist the block is not on the
    // page at all — arrows included — which is what the user asked for.
    var HERO_PER_PAGE = 5;
    /** Which page of the strip is showing. Deliberately not persisted, like the card's. */
    var heroPage = 0;
    /** The strip element, created on first use and kept for the life of the page. */
    var strip = null;
    var stripMounted = false;

    /** The rows that name a country: a row whose tag was cleared has nothing to draw. */
    function heroItems() {
      return rows.filter(function (row) {
        return normaliseTag(row.tag) !== '';
      });
    }

    /**
     * The country behind a tag, from the save's own name table.
     *
     * DATA.tags/DATA.countryNames are the tables the leaderboard already prints from, so
     * the strip does not carry a second localisation of its own; a tag the save never had
     * falls back to the tag itself, exactly like the card.
     */
    function heroCountry(tag) {
      var at = DATA.tags ? DATA.tags.indexOf(tag) : -1;
      if (at < 0) return tag;
      var name = DATA.countryNames ? DATA.countryNames[at] : '';
      return name || tag;
    }

    /** 玩家名字-国家名字; an empty player name leaves the country on its own. */
    function heroCaption(row) {
      var name = heroCountry(normaliseTag(row.tag));
      var player = String(row.player === null || row.player === undefined ? '' : row.player)
        .replace(/^\s+|\s+$/g, '');
      return player ? player + '-' + name : name;
    }

    /**
     * The mother country recorded for a colonial tag, or '' for everything else.
     *
     * Read from the data plane on every call rather than cached: it belongs to the save,
     * not to the artwork set, and applyFlagSet repaints the whole strip on every 旗帜
     * click.
     */
    function heroParent(tag) {
      var parents = DATA.colonialParent;
      var parent = parents ? parents[tag] : '';
      return typeof parent === 'string' ? parent : '';
    }

    /**
     * Where one flag's artwork lives.
     *
     * A colonial nation has no artwork of its own, so it borrows its mother country's —
     * taken from this save's own ledger, which is what makes one dynamic tag (C11, D02,
     * …) come out right in every campaign. '' before the prefixes exist (see the note
     * where paintHeroStrip is handed over): the caller then leaves src alone rather than
     * pointing an image at the page itself.
     */
    function heroFlagUrl(tag) {
      var prefix = FLAG_PREFIX ? FLAG_PREFIX[flagSet] : '';
      var parent = heroParent(tag);
      return prefix && tag ? prefix + encodeURIComponent(parent || tag) + '.png' : '';
    }

    /**
     * The right-half colour of one colonial flag, or '' when the tag is not a colony.
     *
     * flagFill is the same ten lines the leaderboard and the catalogue card use, and the
     * same algorithm as the build side's hashColor, so the block on the flag is literally
     * the colour this colony gets on the map. It deliberately does not follow the 配色
     * button: a flag is not a map.
     */
    function heroTint(tag) {
      return heroParent(tag) ? flagFill(tag) : '';
    }

    /** One right-half colour per figure on the current page, in the order they are drawn. */
    function heroTints(items, from, count) {
      var out = [];
      for (var i = 0; i < count; i += 1) {
        var row = items[from + i];
        out.push(row ? heroTint(normaliseTag(row.tag)) : '');
      }
      return out;
    }

    /** The onerror handler for one flag, with its own tag and figure captured. */
    function heroMissing(tag, img, figure) {
      return function () {
        // A colony is already drawn with its mother country's flag, so nothing is left
        // to try here: the TAG block the card falls back to takes over, and a missing
        // flag is never a broken-image icon in the heading.
        if (figure) figure.innerHTML = '<span class="heroFallback">' + esc(tag) + '</span>';
      };
    }

    /**
     * One page of the strip, arrows included, as the markup string it is painted from.
     *
     * tints carries one right-half colour per figure ('' for a country that is not a
     * colony). The wrapper and the block are part of the same markup the figures are
     * built from, so a repaint can never leave a second block behind.
     */
    function heroShell(pages, count, tints) {
      var figures = '';
      for (var i = 0; i < count; i += 1) {
        var tint = tints && tints[i] ? tints[i] : '';
        figures +=
          '<span class="heroFig" id="heroFig' + i + '">' +
          '<span class="flagBox" id="heroBox' + i + '">' +
          '<img class="heroFlag" id="heroFlag' + i + '" alt="">' +
          (tint ? '<i class="flagTint" id="heroTint' + i + '" style="background:' + tint + '"></i>' : '') +
          '</span>' +
          '<span class="heroCap" id="heroCap' + i + '"></span></span>';
      }
      var paged = pages > 1;
      return (
        (paged
          ? '<button class="heroPage" id="heroPrev" type="button" title="上一组主角旗帜"' +
            (heroPage === 0 ? ' disabled' : '') + '>←</button>'
          : '') +
        '<span class="heroItems" id="heroItems">' + figures + '</span>' +
        (paged
          ? '<button class="heroPage" id="heroNext" type="button" title="下一组主角旗帜"' +
            (heroPage >= pages - 1 ? ' disabled' : '') + '>→</button>'
          : '')
      );
    }

    /**
     * Paint the strip from the rows and the current page, mounting or removing the block.
     *
     * Called by applyFlagSet (so the artwork follows the 旗帜 button) and by whichever edit
     * changed the rows. Removing it when the last protagonist goes is what makes the block
     * belong to the user's data rather than to the page.
     */
    function paintHero() {
      var items = heroItems();
      if (!items.length) {
        heroPage = 0;
        if (stripMounted) {
          headRow.removeChild(strip);
          stripMounted = false;
        }
        return;
      }
      if (!strip) {
        strip = document.createElement('div');
        strip.id = 'heroStrip';
        // One delegated listener: the strip is rebuilt on every paint, so a handler per
        // arrow would sit on nodes that are thrown away.
        strip.addEventListener('click', function (event) {
          var id = (event.target && event.target.id) || '';
          if (id === 'heroPrev') { heroPage -= 1; paintHero(); }
          else if (id === 'heroNext') { heroPage += 1; paintHero(); }
        });
      }
      var pages = Math.ceil(items.length / HERO_PER_PAGE);
      if (heroPage > pages - 1) heroPage = pages - 1;
      if (heroPage < 0) heroPage = 0;
      var count = Math.min(HERO_PER_PAGE, items.length - heroPage * HERO_PER_PAGE);
      var first = heroPage * HERO_PER_PAGE;
      strip.innerHTML = heroShell(pages, count, heroTints(items, first, count));
      for (var i = 0; i < count; i += 1) {
        var row = items[first + i];
        var tag = normaliseTag(row.tag);
        var figure = strip.querySelector('#heroFig' + i);
        var img = strip.querySelector('#heroFlag' + i);
        var cap = strip.querySelector('#heroCap' + i);
        if (cap) cap.textContent = heroCaption(row);
        if (!img) continue;
        var src = heroFlagUrl(tag);
        if (!src) continue;
        img.style.display = '';
        // Registered before src, so a failure can never arrive before the handler exists.
        img.onerror = heroMissing(tag, img, figure);
        img.src = src;
      }
      if (!stripMounted) {
        headRow.insertBefore(strip, button);
        stripMounted = true;
      }
    }

    function $(id) {
      return panel.querySelector('#' + id);
    }

    /** Pull what is typed in the panel back into the state the save writes from. */
    function collect() {
      var title = $('profileTitle');
      if (title) state.title = title.value;
      var mods = $('profileMods');
      if (mods) state.mods = mods.value;
      var endDate = $('profileEndDate');
      if (endDate) state.endDate = endDate.value;
      var sealedAt = $('profileSealedAt');
      if (sealedAt) state.sealedAt = sealedAt.value;
      for (var i = 0; i < rows.length; i += 1) {
        var tag = $('profileTag' + i);
        if (tag) rows[i].tag = tag.value;
        var player = $('profilePlayer' + i);
        if (player) rows[i].player = player.value;
      }
    }

    function rowShells() {
      if (!rows.length) {
        return '<div class="note">还没有主角国家。点下面的按钮添加，卡片上最多显示 3 个。</div>';
      }
      var html = '';
      for (var i = 0; i < rows.length; i += 1) {
        // The great-power list is a sibling of the inputs inside the row, hidden until the
        // TAG field is clicked. It is rendered here rather than built on demand so opening
        // it is a class flip, not a re-render: a re-render would tear the caret out of the
        // field the user just clicked.
        html +=
          '<div class="prow trow"><input id="profileTag' + i + '" type="text" maxlength="4" placeholder="TAG（点这里选列强）">' +
          '<input id="profilePlayer' + i + '" type="text" maxlength="40" placeholder="玩家名字">' +
          '<button id="profileDel' + i + '" type="button" title="删除这一行">×</button>' +
          pickerShell(i) + '</div>';
      }
      return html;
    }

    /**
     * What the 标题 input holds.
     *
     * The heading's own rule (custom.title, else the country name) plus the file name the
     * catalogue card falls back to, so an untouched input never shows a value the heading
     * is not showing — the two are reading one state.title, and this is the only place
     * the fallback chain is written down.
     */
    function panelTitle() {
      return state.title || fallbackTitle() || meta.name || '';
    }

    /**
     * Paint the whole panel from the title state and the protagonist rows.
     *
     * Values are assigned to the inputs instead of baked into the markup: the two hosts
     * hand the client the record as an object, and assigning is the one way that survives
     * both a browser and the DOM stub in scripts/verify-player-run.ts.
     */
    function render() {
      panel.innerHTML =
        '<h4>档案信息</h4>' +
        '<div class="prow"><label>标题</label><input id="profileTitle" type="text" maxlength="80" placeholder="' +
        esc(meta.name || '') + '"></div>' +
        '<div class="prow"><label>模组</label><input id="profileMods" type="text" maxlength="200" placeholder="例如：风云世纪两千年 + 汉化"></div>' +
        '<div class="prow"><label>结档日期</label><input id="profileEndDate" type="text" maxlength="20" placeholder="解析值 ' +
        esc(parsedEndDate()) + '"></div>' +
        // Directly under 结档日期, as the card prints it: the game date of the last session,
        // then the real-world date the save was filed away. The field arrives filled with
        // the value it falls back to rather than empty, and its placeholder repeats that
        // value: "the default is the upload day" is what the user asked to see here.
        '<div class="prow"><label>封档日期</label><input id="profileSealedAt" type="text" maxlength="20" placeholder="' +
        esc(sealedPrefill()) + '"></div>' +
        '<div class="sep"></div><h4>主角国家</h4>' +
        '<div class="note">点 TAG 输入框可以从列强榜前 15 国里选，也可以直接手输。</div>' +
        rowShells() +
        '<div class="prow"><button id="profileAdd" type="button">＋ 添加主角国家</button></div>' +
        '<div class="sep"></div>' +
        '<div class="prow"><button id="profileSave" type="button">保存</button><span id="profileStatus"></span></div>' +
        '<div class="note">标题留空 = 用原始文件名；结档日期留空 = 用解析出来的日期；封档日期留空 = 用上传日期；模组留空 = 显示解析到的模组个数。</div>';
      $('profileTitle').value = panelTitle();
      $('profileMods').value = state.mods;
      $('profileEndDate').value = state.endDate;
      // Not state.sealedAt: the user asked for the field to show what an empty value means.
      $('profileSealedAt').value = sealedPrefill();
      for (var i = 0; i < rows.length; i += 1) {
        $('profileTag' + i).value = rows[i].tag;
        $('profilePlayer' + i).value = rows[i].player;
      }
    }

    function note(text) {
      var el = $('profileStatus');
      if (el) el.textContent = text;
    }

    /**
     * A short-lived note beside the heading.
     *
     * Renaming from the heading happens with the drawer shut, so its own status line
     * would be invisible; this one sits where the user is looking. The sequence number
     * keeps a second rename from being erased by the first one's timer.
     */
    var flashSeq = 0;
    function flash(text) {
      if (!status) return;
      flashSeq += 1;
      var mine = flashSeq;
      status.textContent = text;
      window.setTimeout(function () {
        if (flashSeq === mine) status.textContent = '';
      }, 4000);
    }

    /** The catalogue's upload token, the same key apps/site/public/app.js uses. */
    function uploadHeaders() {
      try {
        var token = localStorage.getItem('catalogue.token');
        return token ? { 'x-upload-token': token } : {};
      } catch (error) {
        return {};
      }
    }

    /**
     * One PATCH of the custom block, shared by both editors.
     *
     * The server merges field by field and treats an empty string as "back to the parsed
     * value", so sending just the field that changed is safe and is also what keeps the
     * panel, the heading and the card from drifting: the card re-reads this same record.
     * done() is handed an error message, or null when the write landed.
     */
    function send(patch, done) {
      fetch('/api/saves/' + encodeURIComponent(meta.id), {
        method: 'PATCH',
        headers: Object.assign({ 'content-type': 'application/json' }, uploadHeaders()),
        body: JSON.stringify({ custom: patch }),
      })
        .then(function (response) {
          if (response.ok) {
            done(null);
            return;
          }
          if (response.status === 401 || response.status === 403) {
            done('未授权：请到目录页 ⚙ 里填上传口令');
            return;
          }
          done('保存失败（HTTP ' + response.status + '）');
        })
        .catch(function (error) {
          done('保存失败：' + (error && error.message ? error.message : error));
        });
    }

    /** The whole form, one PATCH. */
    function save() {
      collect();
      note('保存中…');
      send(
        {
          title: state.title,
          mods: state.mods,
          endDate: state.endDate,
          sealedAt: state.sealedAt,
          protagonists: rows.map(function (row) {
            return { tag: row.tag, player: row.player };
          }),
        },
        function (error) {
          if (error) {
            note(error);
            return;
          }
          note('已保存');
          // The form holds the same title the heading shows, so repaint the heading from
          // the state that was just accepted: one value, two readers, never two values.
          paintTitle();
          // The summary line and the strip are readers of this same record, so they follow
          // the save immediately instead of waiting for a reload.
          paintSummary();
          paintHero();
        },
      );
    }

    /**
     * Rename from the heading.
     *
     * The prompt is prefilled with what the heading shows now; an empty answer clears
     * custom.title, which puts the country name back. The panel input is repainted from
     * the same state, so the two can never show different values, and a refused write
     * rolls the heading back instead of leaving an unsaved title on screen.
     */
    function rename() {
      var before = state.title;
      var answer = window.prompt('修改标题（留空 = 恢复国名）', state.title || fallbackTitle());
      if (answer === null) return;
      state.title = String(answer).replace(/^\s+|\s+$/g, '').slice(0, 80);
      paintTitle();
      var input = $('profileTitle');
      if (input) input.value = panelTitle();
      send({ title: state.title }, function (error) {
        var message = error || '已保存（目录页卡片会同步）';
        note(message);
        flash(message);
        if (!error) return;
        state.title = before;
        paintTitle();
        if (input) input.value = panelTitle();
      });
    }

    /** Put every great-power list away. */
    function closeLists() {
      for (var i = 0; i < rows.length; i += 1) {
        var list = $('profileTagList' + i);
        if (list) list.classList.remove('open');
      }
    }

    /**
     * Open the great-power list under one protagonist row.
     *
     * Only one is ever open — they are the same kind of choice about the same list — and
     * opening one is a class flip rather than a re-render, so the text field the click
     * landed in keeps the caret. Clicking elsewhere, pressing Esc, or picking an entry are
     * the ways back out; typing in the field was never blocked in the first place.
     */
    function openList(row) {
      closeLists();
      var list = $('profileTagList' + row);
      if (list) list.classList.add('open');
    }

    /** Fill one row's TAG from the list and put the list away. */
    function chooseTag(row, entry) {
      var power = greatPowers()[entry];
      if (!power) return;
      var input = $('profileTag' + row);
      if (input) input.value = power.tag;
      collect();
      closeLists();
    }

    // One delegated listener: the rows are re-rendered on every add/remove, so per-row
    // handlers would pile up on the elements that stayed.
    panel.addEventListener('click', function (event) {
      var id = (event.target && event.target.id) || '';
      if (id === 'profileAdd') {
        collect();
        // Prefill the tag the archive already knows was the player's, so the common case
        // is one keystroke rather than a lookup; an empty value is the same as before.
        rows.push({ tag: normaliseTag(parsed().playerTag), player: '' });
        render();
        // The strip is a reader of the rows, so an edit that changes them repaints it at
        // once: adding the first protagonist is what puts the block on the page at all.
        paintHero();
        return;
      }
      if (id === 'profileSave') {
        save();
        return;
      }
      if (id.indexOf('profileDel') === 0) {
        var at = Number(id.slice('profileDel'.length));
        if (at >= 0 && at < rows.length) {
          collect();
          rows.splice(at, 1);
          render();
          // Removing the last one takes the block off the heading row again.
          paintHero();
        }
        return;
      }
      // A TAG field opens its own row's list (profileTagList* is excluded by the Number
      // test below: "List0" is not a number).
      if (id.indexOf('profileTag') === 0) {
        var field = Number(id.slice('profileTag'.length));
        if (isFinite(field) && field >= 0 && field < rows.length) openList(field);
        return;
      }
      if (id.indexOf('profilePick') === 0) {
        var picked = pickTarget(id);
        if (picked) chooseTag(picked.row, picked.entry);
      }
    });

    // A list left open over the rest of the panel is in the way, so clicking anywhere
    // else closes it. The guard keeps the click that opens a list — and the one that
    // picks from it — from immediately closing it again.
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('click', function (event) {
        var id = (event.target && event.target.id) || '';
        if (id.indexOf('profileTag') === 0 || id.indexOf('profilePick') === 0) return;
        closeLists();
      });
      document.addEventListener('keydown', function (event) {
        var key = event && (event.key || event.keyCode);
        if (key === 'Escape' || key === 'Esc' || key === 27) closeLists();
      });
    }

    button.addEventListener('click', function () {
      var open = !panel.classList.contains('open');
      panel.classList.toggle('open', open);
      // Two panels open at once is one too many, so opening this one puts the shared 🎨
      // panel away (and vice versa below). That panel belongs to page-theme.js and is
      // looked up without getElementById on purpose: it is not part of this markup.
      if (open) {
        var theme = document.querySelector('#pageThemePanel');
        if (theme) theme.classList.remove('open');
      }
    });
    var themeButton = document.querySelector('#pageThemeBtn');
    if (themeButton) {
      themeButton.addEventListener('click', function () {
        panel.classList.remove('open');
      });
    }
    render();
    // The heading is only made clickable here, once the record is known: the standalone
    // page never reaches this point, so its title stays plain text showing the country name.
    paintTitle();
    // The summary is the host's line, but the drawer edits two of its four fields, so it is
    // refreshed from the same record: the line and the drawer are never allowed to disagree.
    paintSummary();
    // The strip draws flags, and the artwork prefixes are declared further down this file
    // (they depend on VIEWER_ASSETS). So it is handed over here and painted for the first
    // time by applyFlagSet, which runs once those prefixes exist. Calling paintHero() at
    // this point would read a const binding inside its temporal dead zone and kill the rest of
    // the script — the failure mode that leaves a blank map and dead buttons.
    paintHeroStrip = paintHero;
    if (titleEl) {
      titleEl.classList.add('renameable');
      titleEl.title = '点击修改标题（留空 = 恢复国名）';
      titleEl.addEventListener('click', rename);
    }
  })();

  // ---- flag artwork source ----------------------------------------------
  // Both sets were exported next to the page (assets/flags/base and /modded),
  // so switching is just a different URL prefix - nothing is embedded.
  /**
   * Where the flag PNGs live.
   *
   * Absolute from the site root, and both hosts pass it explicitly. The deployed
   * viewer sits at /saves/<id>/viewer/index.html — three levels deep, not two — so a
   * relative prefix of ../../assets/... silently resolved to /saves/assets/... and every
   * flag 404'd. Root-absolute cannot be off by a level, however deep the page is.
   */
  const ASSETS = Object.assign(
    { flags: '/assets/flags/' },
    (typeof globalThis !== 'undefined' && globalThis.VIEWER_ASSETS) || {},
  );
  const FLAG_PREFIX = { base: ASSETS.flags + 'base/', modded: ASSETS.flags + 'modded/' };
  /**
   * The build-time composites (assets/flags/colonial*) are retired.
   *
   * A colonial nation is now its mother country's flag with its own colour over the
   * right half, assembled in the DOM: no image is generated, no canvas is involved, and
   * the mother country is read from this save — so a new colony works the moment the
   * save is parsed, and one dynamic tag (C11 is Florida in one campaign and 黎洲 in
   * another) is right in every campaign instead of needing a PNG per parent.
   */
  const flagBtn = document.getElementById('flagset');
  let flagSet = savedSettings.flagSet === 'modded' ? 'modded' : 'base';

  /** The mother country of a colonial tag, or ''. See heroParent. */
  function flagParent(tag) {
    const parents = DATA.colonialParent;
    const parent = parents ? parents[tag] : '';
    return typeof parent === 'string' ? parent : '';
  }

  /**
   * The colour of the right half of a colonial flag, as a #rrggbb string.
   *
   * Frozen algorithm: the polynomial hash mixed with murmur3's fmix32, then
   * hslToRgb(h % 360, 0.6, 0.45) — written out here because the client has no colour
   * table. It must stay byte for byte equal to hashColor() in
   * apps/site/public/viewer-build.js and scripts/lib/map-assets.ts, and to the copy in
   * the catalogue card (app.js): the block on a flag is then exactly the colour the
   * same tag gets on the map.
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

  /**
   * The .flagBox one flag image lives in, built around it on first use.
   *
   * The leaderboard's rows arrive as the host's own HTML — one bare
   * img class="flag" with its data-tag — so the wrapper is added here. applyFlagSet() runs
   * again on every 旗帜 click, so this has to be idempotent: an image that already sits in
   * a wrapper keeps it rather than getting a second one around it.
   */
  function flagBoxOf(img) {
    const box = img.parentNode;
    if (box && box.classList && box.classList.contains('flagBox')) return box;
    const made = document.createElement('span');
    made.className = 'flagBox';
    if (img.parentNode) img.parentNode.insertBefore(made, img);
    made.appendChild(img);
    return made;
  }

  /** The block already inside one wrapper, or null when it has none. */
  function flagTintIn(box) {
    const kids = box.children;
    for (let i = 0; kids && i < kids.length; i += 1) {
      if (kids[i].className === 'flagTint') return kids[i];
    }
    return null;
  }

  /**
   * The block on one flag: the colony's own colour, or nothing at all.
   *
   * Only the colour ever changes after the block exists — switching 旗帜 from 原版 to
   * 国家娘 replaces the picture underneath and leaves the block exactly where it was — and
   * a block is made once per wrapper, so calling this again cannot draw the right half
   * twice. A country that is not a colony gets no block at all, which is why the element
   * is created on demand instead of always.
   */
  function applyFlagTint(img, tag) {
    const box = flagBoxOf(img);
    const existing = flagTintIn(box);
    if (!flagParent(tag)) {
      if (existing) existing.style.display = 'none';
      return;
    }
    let tint = existing;
    if (!tint) {
      tint = document.createElement('i');
      tint.className = 'flagTint';
      box.appendChild(tint);
    }
    tint.style.background = flagFill(tag);
    tint.style.display = '';
  }

  // ---- colour mode -------------------------------------------------------
  // The recolouring mod paints a country and its subjects one colour, which makes an
  // empire and its vassals one indistinguishable blob. Three readings of the same
  // data, so the map can be either faithful or legible.
  const COLOUR_MODES = [
    { id: 'mod', label: '模组色', hint: '按存档里的颜色（重新染色模组的结果），属国从成为属国那天起才变色' },
    { id: 'original', label: '原始色', hint: '每个国家都用游戏本体的原色，辨识度最高' },
    { id: 'subject', label: '属国染色', hint: '属国跟随宗主颜色但更浅，宗主与属国一眼可分' },
  ];
  const colourBtn = document.getElementById('colour');
  function applyColourMode() {
    const mode = COLOUR_MODES.find((entry) => entry.id === colourMode) || COLOUR_MODES[0];
    if (colourBtn) {
      colourBtn.textContent = '配色：' + mode.label;
      colourBtn.title = mode.hint;
    }
    // The panels are host-built HTML, so their swatches have to be repainted here.
    const swatches = document.querySelectorAll('.sw[data-tag]');
    for (let i = 0; i < swatches.length; i += 1) {
      const tagIdx = DATA.tags.indexOf(swatches[i].getAttribute('data-tag'));
      if (tagIdx < 0) continue;
      swatches[i].style.background = colourCss(tagIdx, DATA.months[idx]);
    }
    draw();
    drawChartLegend();
    applyFlagSet();
  }
  if (colourBtn) {
    colourBtn.addEventListener('click', function () {
      const at = COLOUR_MODES.findIndex((entry) => entry.id === colourMode);
      colourMode = COLOUR_MODES[(at + 1) % COLOUR_MODES.length].id;
      saveSettings({ colourMode: colourMode });
      applyColourMode();
    });
  }
  colourMode = ['mod', 'original', 'subject'].includes(savedSettings.colourMode) ? savedSettings.colourMode : 'mod';

  function applyFlagSet() {
    const prefix = FLAG_PREFIX[flagSet];
    const imgs = document.querySelectorAll('img.flag');
    for (let i = 0; i < imgs.length; i += 1) {
      const tag = imgs[i].getAttribute('data-tag');
      if (!tag) continue;
      // A colony asks for its mother country's artwork straight away: one request, and
      // never the PNG of a tag the game has no artwork for. Everything else keeps its own.
      const parent = flagParent(tag);
      imgs[i].style.display = '';
      imgs[i].onerror = onFlagMissing;
      imgs[i].src = prefix + (parent || tag) + '.png';
      if (parent) imgs[i].setAttribute('data-founded', '1');
      else imgs[i].removeAttribute('data-founded');
      applyFlagTint(imgs[i], tag);
    }
    flagBtn.textContent = '旗帜：' + (flagSet === 'base' ? '原版' : '国家娘');
    // One switch, three readers: the heading's protagonist strip and the detail sheet draw
    // the same artwork sets, so a 旗帜 click has to repaint them too.
    if (paintHeroStrip) paintHeroStrip();
    paintDetailFlags();
  }

  /**
   * The requested artwork is not there.
   *
   * A country that is not colonial has nothing left to try, so the image is hidden — the
   * behaviour an artwork-less country has always had, and what the heading turns into a TAG
   * block. A colony is normally already on its mother country's flag from the first paint,
   * so the retry below is the guard for an image that reached the page without that
   * decision: it switches to the mother country's flag once, block included, and only a
   * second failure hides it.
   */
  function onFlagMissing() {
    const img = this;
    const tag = img.getAttribute('data-tag');
    const parent = tag ? flagParent(tag) : '';
    if (parent && img.getAttribute('data-founded') !== '1') {
      img.setAttribute('data-founded', '1');
      img.src = FLAG_PREFIX[flagSet] + parent + '.png';
      applyFlagTint(img, tag);
      return;
    }
    img.style.display = 'none';
  }
  flagBtn.addEventListener('click', function () {
    flagSet = flagSet === 'base' ? 'modded' : 'base';
    saveSettings({ flagSet: flagSet });
    applyFlagSet();
  });
  applyFlagSet();

  document.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') goTo(idx + 1);
    else if (e.key === 'ArrowLeft') goTo(idx - 1);
    else if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
  });
  document.getElementById('peak').textContent =
    '占领峰值：' + DATA.peak.occupied + ' 省（' + DATA.monthLabels[DATA.peak.month] + '）';
  // Paints the button label, the panel swatches and the first frame together.
  // The rankings are drawn first: they are the only tables the client builds itself, and
  // applyColourMode() below ends up in applyFlagSet(), which is what gives their flags and
  // swatches their artwork and colour.
  renderRankings();
  applyColourMode();
})();