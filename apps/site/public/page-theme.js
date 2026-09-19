/*
 * Backgrounds and themes, shared by every page.
 *
 * The viewer already had this; the catalogue wanted the same thing. Both read and write
 * ONE object, so the two pages cannot disagree:
 *
 *   localStorage['eu4analyser.settings'] = {
 *     theme, bgMode, bgOn, bgAt, bgInterval, dim, ...
 *   }
 *
 * Same origin, same key — that is the whole synchronisation mechanism. There is no
 * server round trip and nothing to reconcile: change the theme in the catalogue and the
 * viewer opens with it, because it reads the same field.
 *
 * The module owns its markup and its styles (injected once): a floating button and a
 * panel, so a page can adopt it without touching its own layout.
 *
 * TWO HOSTS, ONE FILE. The catalogue and the hosted viewer load this as an ES module —
 * viewer-page.js copies the exports onto globalThis so the classic player script can read
 * them. The generated standalone page has no module loader, so
 * scripts/render-timeline.ts inlines the source with `export ` stripped, the same trick
 * scripts/lib/paint-bundle.ts plays on paint.js. That only works while this file stays a
 * flat script: keep every declaration `export`-prefixed and use no other ESM syntax (no
 * `import`, no `export { … }` block, no top-level `await`).
 */

export const SETTINGS_KEY = 'eu4analyser.settings';

export const THEMES = [
  { id: 'slate', label: '石板' },
  { id: 'parchment', label: '羊皮纸' },
  { id: 'royal', label: '王室金' },
  { id: 'light', label: '浅色' },
];

/** The viewer's own default, so an untouched install looks the same on both pages. */
const DEFAULTS = { theme: 'slate', bgMode: 'list', bgInterval: 12, dim: 66, bgOn: [], bgAt: 0, panelOpacity: 88 };

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Merge a patch into the shared object. The viewer reads these same fields. */
export function saveSettings(patch) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch }));
  } catch {
    // Private mode: the page still works, it just forgets.
  }
}

export function applyTheme(name) {
  const theme = THEMES.some((entry) => entry.id === name) ? name : 'slate';
  document.body.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme === 'light' || theme === 'parchment' ? 'light' : 'dark';
  saveSettings({ theme });
  return theme;
}

const CSS = `
:root{
  --bg:#0f1115; --panel:rgba(22,26,33,.94); --panel2:#1b212b; --ink:#e6e6e6; --ink-soft:#8a93a3;
  --accent:#4b8fd6; --accent-ink:#08121c; --border:#263042; --border-soft:#1e2530;
  --radius:6px; --radius-lg:10px;
  --font:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  --dim:#000000; --chip-off:.45;
}
body[data-theme=parchment]{
  --bg:#ece1c9; --panel:rgba(250,244,229,.95); --panel2:#f2e8d2; --ink:#3a3126; --ink-soft:#7a6a53;
  --accent:#8a5a2b; --accent-ink:#fff8ec; --border:#d3c1a0; --border-soft:#e0d2b6; --dim:#fdf7e9;
}
body[data-theme=royal]{
  --bg:#14110c; --panel:rgba(30,25,19,.95); --panel2:#241d15; --ink:#eadfc6; --ink-soft:#a2916f;
  --accent:#c9a227; --accent-ink:#1a1408; --border:#3d3324; --border-soft:#31291d; --dim:#0b0803;
}
body[data-theme=light]{
  --bg:#f2f4f8; --panel:rgba(255,255,255,.96); --panel2:#f7f9fc; --ink:#1d2530; --ink-soft:#67758a;
  --accent:#2563eb; --accent-ink:#ffffff; --border:#dde4ee; --border-soft:#eaeff6; --dim:#ffffff;
}
.bgLayer{position:fixed;inset:0;z-index:-2;background-position:center;background-size:cover;opacity:0;
  transition:opacity .8s ease}
.bgLayer.on{opacity:1}
.bgScrim{position:fixed;inset:0;z-index:-1;background:var(--dim);pointer-events:none}
#pageThemeBtn{position:fixed;right:14px;bottom:14px;z-index:50;width:44px;height:44px;border-radius:50%;
  border:1px solid var(--border);background:var(--panel);color:var(--ink);font-size:19px;cursor:pointer;
  box-shadow:0 6px 18px rgba(0,0,0,.3);font-family:var(--font)}
#pageThemePanel{position:fixed;right:14px;bottom:68px;z-index:50;width:290px;max-height:70vh;overflow:auto;
  background:var(--panel);color:var(--ink);border:1px solid var(--border);border-radius:var(--radius-lg);
  padding:12px;font:13px/1.6 var(--font);box-shadow:0 10px 30px rgba(0,0,0,.35);display:none}
#pageThemePanel.open{display:block}
#pageThemePanel h4{margin:0 0 8px;font-size:12px;color:var(--ink-soft);font-weight:600;letter-spacing:.4px}
#pageThemePanel .row{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}
#pageThemePanel button{background:var(--panel2);color:var(--ink);border:1px solid var(--border);
  border-radius:var(--radius);padding:5px 10px;cursor:pointer;font-family:var(--font);font-size:12.5px}
#pageThemePanel button.on{border-color:var(--accent);color:var(--accent)}
#pageThemePanel input[type=number]{width:64px;background:var(--panel2);color:var(--ink);
  border:1px solid var(--border);border-radius:var(--radius);padding:4px 6px}
#pageThemePanel input[type=range]{flex:1;min-width:110px}
#pageThemePanel .sep{height:1px;background:var(--border-soft);margin:10px 0}
#pageThemeThumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
#pageThemeThumbs button{padding:0;border-radius:4px;overflow:hidden;position:relative;aspect-ratio:16/10;
  border:1px solid var(--border);background:var(--panel2)}
#pageThemeThumbs button.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
#pageThemeThumbs button.off{opacity:var(--chip-off)}
#pageThemeThumbs img{width:100%;height:100%;object-fit:cover;display:block}
`;

function injectStyles() {
  if (document.getElementById('pageThemeStyles')) return;
  const style = document.createElement('style');
  style.id = 'pageThemeStyles';
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Mount the shared background/theme controls.
 *
 * @param {{ host?: HTMLElement, wallpapers?: string[], detailPanel?: boolean }} options
 *   `detailPanel` is the viewer's alone: only that page has the province/country sheet
 *   the 面板 slider fades, so only that page gets the row (the catalogue asks for the
 *   component without it and must not grow a control that drives nothing).
 * @returns {Promise<{reload: Function}>} `reload` re-reads the shared settings (used
 *   when the viewer changed them in another tab, via the `storage` event).
 */
export async function mountPageTheme({ host = document.body, wallpapers, detailPanel = false } = {}) {
  injectStyles();
  let settings = loadSettings();
  applyTheme(settings.theme);

  let list = wallpapers;
  if (!list) {
    try {
      const response = await fetch('wallpapers.json', { cache: 'no-cache' });
      list = response.ok ? await response.json() : [];
    } catch {
      list = [];
    }
  }
  list = (list ?? []).map((name) => new URL(name, location.href).href);

  // Two layers so a change cross-fades, exactly like the viewer's.
  const layers = [0, 1].map(() => {
    const div = document.createElement('div');
    div.className = 'bgLayer';
    host.appendChild(div);
    return div;
  });
  const scrim = document.createElement('div');
  scrim.className = 'bgScrim';
  host.appendChild(scrim);

  const button = document.createElement('button');
  button.id = 'pageThemeBtn';
  button.type = 'button';
  button.title = '背景与主题（与查看页共享同一份设置）';
  button.textContent = '🎨';
  const panel = document.createElement('div');
  panel.id = 'pageThemePanel';
  // The 面板 row sits directly under 蒙版 (the user's ask in 第三对话任务书.md §6.4): both
  // drive an opacity, and they are read one after the other. It is written as a
  // conditional string rather than built by script so the panel stays one innerHTML
  // assignment, exactly like the rest of it.
  panel.innerHTML =
    '<h4>主题</h4><div class="row" id="pageThemeThemes"></div>' +
    '<div class="sep"></div><h4>背景图</h4>' +
    '<div class="row" id="pageThemeModes"></div>' +
    '<div class="row"><span>切换间隔</span><input type="number" id="pageThemeInterval" min="1" max="600" step="1">' +
    '<span>秒</span></div>' +
    '<div class="row"><span>蒙版</span><input type="range" id="pageThemeDim" min="0" max="92">' +
    '<span id="pageThemeDimVal"></span></div>' +
    (detailPanel
      ? '<div class="row"><span>面板</span><input type="range" id="pageThemePanelOpacity" min="20" max="100">' +
        '<span id="pageThemePanelOpacityVal"></span></div>'
      : '') +
    '<div id="pageThemeThumbs"></div>';
  host.appendChild(button);
  host.appendChild(panel);
  button.addEventListener('click', () => panel.classList.toggle('open'));

  const $ = (id) => panel.querySelector(`#${id}`);
  let front = 0;
  let at = Math.min(Math.max(0, settings.bgAt | 0), Math.max(0, list.length - 1));
  let timer = null;

  const enabled = () => {
    const on = Array.isArray(settings.bgOn) ? settings.bgOn : [];
    const active = [];
    for (let i = 0; i < list.length; i += 1) if (on[i] !== false) active.push(i);
    return active;
  };

  function show(index) {
    at = index;
    const incoming = layers[1 - front];
    incoming.style.backgroundImage = `url("${list[index]}")`;
    incoming.classList.add('on');
    layers[front].classList.remove('on');
    front = 1 - front;
    saveSettings({ bgAt: at });
    renderThumbs();
  }

  function step() {
    const active = enabled();
    if (active.length < 2) return;
    if (settings.bgMode === 'shuffle') {
      let pick = active[Math.floor(Math.random() * active.length)];
      if (pick === at) pick = active[(active.indexOf(at) + 1) % active.length];
      show(pick);
      return;
    }
    const index = active.indexOf(at);
    show(active[index < 0 ? 0 : (index + 1) % active.length]);
  }

  function restart() {
    if (timer) clearInterval(timer);
    timer = null;
    if (settings.bgMode !== 'single' && enabled().length > 1) {
      const seconds = Number(settings.bgInterval) >= 1 && Number(settings.bgInterval) <= 600 ? Math.round(Number(settings.bgInterval)) : DEFAULTS.bgInterval;
      timer = setInterval(step, seconds * 1000);
    }
  }

  function applyDim(value) {
    const dim = Math.max(0, Math.min(92, Math.round(Number(value) || 0)));
    scrim.style.opacity = String(dim / 100);
    $('pageThemeDim').value = String(dim);
    $('pageThemeDimVal').textContent = `${dim}%`;
  }

  /**
   * The detail sheet's translucency, as one CSS variable.
   *
   * It is published on document.documentElement rather than on the sheet itself because
   * the sheet is the viewer's own markup — the component owns the *setting*, the viewer
   * owns what reads it, and `--panel-opacity` is the whole handover. The tint is a
   * separate layer behind the content (see viewer.html), so lowering this fades the sheet
   * and never the text on it. 20% is the floor: below that the sheet stops reading as a
   * surface at all.
   */
  function applyPanelOpacity(value) {
    const percent = Math.max(20, Math.min(100, Math.round(Number(value) || DEFAULTS.panelOpacity)));
    document.documentElement.style.setProperty('--panel-opacity', String(percent / 100));
    const range = $('pageThemePanelOpacity');
    if (range) range.value = String(percent);
    const label = $('pageThemePanelOpacityVal');
    if (label) label.textContent = `${percent}%`;
  }

  function renderThemes() {
    const host = $('pageThemeThemes');
    host.innerHTML = '';
    for (const theme of THEMES) {
      const el = document.createElement('button');
      el.textContent = theme.label;
      if (settings.theme === theme.id) el.classList.add('on');
      el.addEventListener('click', () => {
        settings.theme = applyTheme(theme.id);
        renderThemes();
      });
      host.appendChild(el);
    }
  }

  function renderModes() {
    const host = $('pageThemeModes');
    host.innerHTML = '';
    for (const [id, label] of [['list', '↻ 列表循环'], ['shuffle', '⇄ 随机播放'], ['single', '▣ 单图循环']]) {
      const el = document.createElement('button');
      el.textContent = label;
      if (settings.bgMode === id) el.classList.add('on');
      el.addEventListener('click', () => {
        settings.bgMode = id;
        saveSettings({ bgMode: id });
        renderModes();
        renderThumbs();
        restart();
      });
      host.appendChild(el);
    }
  }

  function renderThumbs() {
    const host = $('pageThemeThumbs');
    host.innerHTML = '';
    for (let i = 0; i < list.length; i += 1) {
      const el = document.createElement('button');
      el.title = decodeURIComponent(list[i].split('/').pop() ?? '');
      const marked = settings.bgMode === 'single' ? i === at : (Array.isArray(settings.bgOn) ? settings.bgOn[i] !== false : true);
      if (marked) el.classList.add('on');
      else el.classList.add('off');
      const img = document.createElement('img');
      img.src = list[i];
      img.loading = 'lazy';
      img.alt = '';
      el.appendChild(img);
      el.addEventListener('click', () => {
        if (settings.bgMode === 'single') {
          show(i);
          return;
        }
        const on = Array.isArray(settings.bgOn) ? [...settings.bgOn] : [];
        while (on.length < list.length) on.push(true);
        on[i] = on[i] === false;
        if (!on.some((value) => value !== false)) on[i] = true; // never allow an empty set
        settings.bgOn = on;
        saveSettings({ bgOn: on });
        if (on[i] === false && i === at) step();
        renderThumbs();
        restart();
      });
      host.appendChild(el);
    }
  }

  $('pageThemeInterval').value = String(settings.bgInterval);
  $('pageThemeInterval').addEventListener('change', () => {
    const seconds = Math.max(1, Math.min(600, Math.round(Number($('pageThemeInterval').value) || DEFAULTS.bgInterval)));
    settings.bgInterval = seconds;
    $('pageThemeInterval').value = String(seconds);
    saveSettings({ bgInterval: seconds });
    restart();
  });
  $('pageThemeDim').addEventListener('input', () => {
    const dim = Number($('pageThemeDim').value);
    settings.dim = dim;
    applyDim(dim);
    saveSettings({ dim });
  });
  const panelRange = $('pageThemePanelOpacity');
  if (panelRange) {
    panelRange.addEventListener('input', () => {
      const percent = Number(panelRange.value);
      settings.panelOpacity = percent;
      applyPanelOpacity(percent);
      saveSettings({ panelOpacity: percent });
    });
  }

  applyDim(settings.dim);
  applyPanelOpacity(settings.panelOpacity);
  renderThemes();
  renderModes();
  renderThumbs();
  if (list.length) {
    // A different wallpaper greets each visit while looping; with looping off the one
    // you picked last time comes back.
    const start = settings.bgMode === 'single' && list[at] ? at : Math.floor(Math.random() * list.length) % list.length;
    layers[0].style.backgroundImage = `url("${list[start]}")`;
    layers[0].classList.add('on');
    at = start;
  }
  restart();

  /** Re-read the settings another page (or tab) may have changed. */
  function reload() {
    settings = loadSettings();
    applyTheme(settings.theme);
    applyDim(settings.dim);
    applyPanelOpacity(settings.panelOpacity);
    $('pageThemeInterval').value = String(settings.bgInterval);
    renderThemes();
    renderModes();
    renderThumbs();
    restart();
  }
  window.addEventListener('storage', (event) => {
    if (event.key === SETTINGS_KEY) reload();
  });

  return { reload };
}
