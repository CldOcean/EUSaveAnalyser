/**
 * Run the generated player in a DOM stub.
 *
 * `verify-player.ts` only *compiles* the client, which is why runtime failures
 * (blank map, dead view buttons, empty chart, a map stuck on one colour) shipped
 * twice. This actually executes the player and checks that it really painted:
 *
 *   1. every palette name the client reads (C.*) is packed by the server;
 *   2. all script blocks run to completion at load;
 *   3. all nine view buttons repaint, and the painted frame is not one flat
 *      colour — which is what a broken state replay looks like;
 *   4. the chart and its legend get content;
 *   5. the slider can be driven across the campaign.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('tmp/timeline/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
console.log(`${scripts.length} script block(s)`);

const dataLine = html.split('\n').find((l) => l.startsWith('const DATA = '));
if (!dataLine) throw new Error('DATA not found in index.html');
const DATA = JSON.parse(dataLine.slice('const DATA = '.length).replace(/;$/, '')) as {
  w: number;
  h: number;
  constants: Record<string, unknown>;
  provinceIds: number[];
};
const provinceIds = DATA.provinceIds;

// ------------------------------------------- 1. palette names are packed -----
console.log('\n=== 1. client palette vs packed constants ===');
{
  const client = scripts[scripts.length - 1] as string;
  const used = new Set(
    [...client.matchAll(/\bC\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] as string),
  );
  const have = new Set(Object.keys(DATA.constants));
  const missing = [...used].filter((k) => !have.has(k));
  const hreHave = new Set(Object.keys((DATA.constants.hre ?? {}) as Record<string, unknown>));
  const hreMissing = [
    ...new Set([...client.matchAll(/\bC\.hre\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] as string)),
  ].filter((k) => !hreHave.has(k));
  console.log(`  used: ${used.size}, missing: ${missing.length ? missing.join(', ') : 'none'}`);
  console.log(`  C.hre.*: ${hreMissing.length ? hreMissing.join(', ') : 'all present'}`);
  if (missing.length || hreMissing.length) process.exitCode = 1;
}

// ------------------------------------------------------------- DOM stub ------
const listeners = new Map<string, Array<(e: unknown) => void>>();
/** Listeners registered on `window` itself (used by drag-to-pan). */
const windowListeners = new Map<string, Array<(e: unknown) => void>>();
const els = new Map<string, Record<string, unknown>>();
/**
 * Every `img.flag` the stub has seen, in creation order.
 *
 * The leaderboard table (and the chart legend) are the *host's* own markup, and the client
 * paints them through `document.querySelectorAll('img.flag')` — a selector this stub used
 * to answer with an empty list, which is how the first of the client's four flag render
 * points stayed completely untested. The images a markup string declares are registered
 * here instead, so `applyFlagSet()` really runs over them.
 */
const flagImgs: Array<Record<string, unknown>> = [];
let putImageDataCalls = 0;
let lastImage: { data: Uint8ClampedArray } | null = null;
/**
 * putImageData calls and the last frame, *per canvas*.
 *
 * The map and the hover layer are two canvases with two contexts, and section 14 has to
 * tell them apart: a hover highlight must repaint one and never the other, and hovering
 * the ocean must repaint neither. `lastImage` keeps its old meaning (the map's frame) so
 * every colour assertion from section 3 on still reads the map.
 */
const paintCalls = new Map<string, number>();
const lastByCanvas = new Map<string, { data: Uint8ClampedArray }>();
/** Requested delays of every setInterval, so playback speed is observable. */
const intervals: number[] = [];

function makeCtx(ownerId = 'map'): unknown {
  const special: Record<string, unknown> = {
    putImageData: (img: { data: Uint8ClampedArray }) => {
      putImageDataCalls += 1;
      if (ownerId === 'map') lastImage = img;
      lastByCanvas.set(ownerId, img);
      paintCalls.set(ownerId, (paintCalls.get(ownerId) ?? 0) + 1);
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      // A synthetic raster that tiles the *real* province ids as 64x64 squares.
      // The squares matter: border detection compares a pixel with the one below
      // it, so a 1-D id pattern (one id per run of pixels) marks virtually every
      // pixel as a border and darkens the whole frame, which silently destroys
      // any colour assertion made against the painted result.
      const B = 64;
      const cols = Math.ceil(w / B);
      const data = new Uint8ClampedArray(w * h * 4);
      for (let p = 0; p < w * h; p += 1) {
        const x = p % w;
        const y = (p - x) / w;
        const block = Math.floor(x / B) + Math.floor(y / B) * cols;
        // Stride through the id list: a prefix-only sample would miss every sea
        // province (they are not the first ids in the save) and the battle-view
        // sea check below would have nothing to find. 7 is coprime with the
        // province count, so the whole list is covered.
        const id = provinceIds[(block * 7) % provinceIds.length] as number;
        data[p * 4] = (id >> 8) & 0xff;
        data[p * 4 + 1] = id & 0xff;
      }
      return { data, width: w, height: h };
    },
    createLinearGradient: () => ({ addColorStop: () => {} }),
    measureText: () => ({ width: 12 }),
  };
  return new Proxy(special, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && /^(fill|stroke|font|line|text|global|shadow|image)/.test(prop)) {
        return '';
      }
      return () => undefined;
    },
    set: () => true,
  });
}

function makeEl(id: string, tagName = 'DIV'): Record<string, unknown> {
  // The map canvas is the one element whose intrinsic size matters: the client
  // compares it with the CSS width to pick the scaling filter.
  const isMap = id === 'map';
  const cssWidth = isMap ? 1100 : 1000;
  const cssHeight = isMap ? 400 : 400;
  const attrs = new Map<string, string>();
  const classes = new Set<string>();
  /** Custom properties written through style.setProperty, so CSS variables are readable. */
  const styleVars = new Map<string, string>();
  /**
   * Children appended to this element, in order. The body is the interesting one: the
   * shared background/theme component builds its layers, scrim, 🎨 button and panel by
   * appending them to `document.body`, and section 8 reads them back from here.
   */
  const appended: Array<Record<string, unknown>> = [];
  /**
   * Children a script declared by *writing markup* rather than by appending. page-theme.js
   * fills its panel with innerHTML and then reads the pieces back by id — exactly what a
   * browser does — so the setter registers every `id="…"` it sees.
   */
  const byId = new Map<string, Record<string, unknown>>();
  let innerHTML = '';
  const el: Record<string, unknown> = {
    id,
    textContent: '',
    get innerHTML(): string {
      return innerHTML;
    },
    set innerHTML(value: string) {
      innerHTML = String(value);
      // Every element the markup declares, with its attributes parsed. A browser gives the
      // client back the element *and* its data-* attributes; a stub that only registers the
      // id would make getAttribute answer null for everything the panel reads back, which
      // is how a whole class of "the markup said X" assertions would pass while lying.
      for (const match of innerHTML.matchAll(/<([A-Za-z][A-Za-z0-9]*)([^>]*)>/g)) {
        const body = match[2] ?? '';
        const idMatch = /\sid="([^"]+)"/.exec(body);
        if (!idMatch) continue;
        const child = idMatch[1] as string;
        if (byId.has(child)) continue;
        const made = makeEl(child, (match[1] as string).toUpperCase());
        for (const attr of body.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
          made.setAttribute(attr[1] as string, attr[2] as string);
        }
        byId.set(child, made);
      }
      // A flag the markup declares: the client looks these up by class, not by id, so the
      // stub has to hand them over through the same selector a browser would answer.
      for (const match of innerHTML.matchAll(/<img class="flag" data-tag="([^"]+)"/g)) {
        const holder = makeEl(`flag-${match[1]}`);
        holder.setAttribute('data-tag', match[1] as string);
        holder.parentNode = el;
        flagImgs.push(holder);
      }
    },
    value: '0',
    // A browser keeps className and classList in step; the shared component sets the
    // class of its layers and scrim through `className`, so the stub has to as well or
    // it reports a mounted component as missing.
    get className(): string {
      return [...classes].join(' ');
    },
    set className(value: string) {
      classes.clear();
      for (const name of String(value).split(/\s+/)) if (name) classes.add(name);
    },
    title: '',
    width: isMap ? DATA.w : 0,
    height: isMap ? DATA.h : 0,
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    /**
     * The box a browser would report. It is a *property*, not a literal, because section 14
     * has to fake a second layout (the full-screen one) and prove that hit testing reads the
     * box the canvas actually has rather than a remembered transform.
     */
    rect: {
      left: 0,
      top: 0,
      right: cssWidth,
      bottom: cssHeight,
      width: cssWidth,
      height: cssHeight,
    },
    getBoundingClientRect: () => el.rect as { left: number; top: number; width: number; height: number },
    style: {
      setProperty: (name: string, value: string) => {
        styleVars.set(name, String(value));
      },
      removeProperty: (name: string) => {
        styleVars.delete(name);
      },
      getPropertyValue: (name: string) => styleVars.get(name) ?? '',
    },
    dataset: {},
    tagName,
    /** The elements the markup declared, by id — what a browser's tree would contain. */
    named: byId,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, force?: boolean) => {
        const want = force === undefined ? !classes.has(c) : force;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    },
    // Keyed on the element's *current* id: the shared component assigns `id` to an
    // element it created before wiring it, so `pageThemeBtn:click` must be reachable.
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      const key = `${el.id}:${type}`;
      const list = listeners.get(key) ?? [];
      list.push(fn);
      listeners.set(key, list);
    },
    getAttribute: (name: string) => attrs.get(name) ?? (name === 'data-slot' ? '0' : null),
    setAttribute: (name: string, value: string) => {
      attrs.set(name, value);
    },
    hasAttribute: (name: string) => attrs.has(name),
    removeAttribute: (name: string) => {
      attrs.delete(name);
    },
    appended,
    /** The children the client inserted, as a browser's element.children would report them. */
    get children(): Array<Record<string, unknown>> {
      return appended;
    },
    appendChild: (child: Record<string, unknown>) => {
      appended.push(child);
      // A real appendChild reparents the node, and the flag code relies on that: it wraps
      // an image by putting it inside the wrapper it just built.
      child.parentNode = el;
      return child;
    },
    // The heading's protagonist strip is inserted to the *left* of the 📝 trigger rather
    // than appended after it, so the stub needs the two DOM operations that does: both
    // keep `appended` in document order, which is what the order assertions read.
    insertBefore: (child: Record<string, unknown>, ref: Record<string, unknown> | null) => {
      const at = ref ? appended.indexOf(ref) : -1;
      if (at < 0) appended.push(child);
      else appended.splice(at, 0, child);
      child.parentNode = el;
      return child;
    },
    removeChild: (child: Record<string, unknown>) => {
      const at = appended.indexOf(child);
      if (at >= 0) appended.splice(at, 1);
      return child;
    },
    querySelector: (selector: string) => {
      const named = /^#([A-Za-z0-9_-]+)$/.exec(selector);
      return named ? (byId.get(named[1] as string) ?? null) : null;
    },
    // Only the shared component queries a class on an element it built itself.
    querySelectorAll: (selector: string) => {
      const named = /^\.([A-Za-z0-9_-]+)$/.exec(selector);
      if (!named) return [];
      const want = named[1] as string;
      return appended.filter((child) =>
        (child.classList as { contains: (c: string) => boolean }).contains(want),
      );
    },
    getContext: () => makeCtx(id),
    click: () => {
      for (const fn of listeners.get(`${el.id}:click`) ?? []) fn({ preventDefault: () => {} });
    },
  };
  return el;
}

const bodyEl = makeEl('body');
els.set('body', bodyEl);
/** The shared component injects its stylesheet into `document.head`; section 8 reads it. */
const headEl = makeEl('head');
/** The context's localStorage, so what the component persists can be asserted. */
const settingsStore = new Map<string, string>();

// Every id the generated page defines, so the stub answers getElementById exactly as
// the browser would — present for real controls, null for anything else.
for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
  const id = match[1] as string;
  if (!els.has(id)) els.set(id, makeEl(id));
}
console.log(`${els.size - 1} element id(s) taken from the generated page`);

/**
 * The markup's `[data-fact]` spans.
 *
 * Both hosts hand the client a VIEWER_FACTS object instead of baking the numbers
 * into the page (that is what lets one markup file serve the generated page and the
 * hosted one), so the stub has to carry these — otherwise every check below passes
 * while the headline stays blank on a real page.
 *
 * The list is the page's actual spans: the heading's country name, the campaign's first
 * and last date, and the four archive fields under it (版本 / 结档日期 / 封档日期 / 模组).
 * The frame, province and event counts used to be printed here; they were replaced by
 * those fields, so they are no longer spans — a key with no span is a fact nobody reads.
 *
 * The `title` fact is special: in the page it is the very element the drawer turns into
 * a second editor for custom.title (#titleText, inside the heading row). The stub has to
 * hand the client that same element, or the country name would be written into a stub
 * node nothing else can see and section 12 would be asserting against a heading the page
 * does not have.
 */
const FACT_KEYS = ['title', 'start', 'end', 'version', 'endDate', 'sealedAt', 'mods'];
const titleFactEl = els.get('titleText');
if (!titleFactEl) throw new Error('viewer.html must declare #titleText for the title fact');
const factEls = FACT_KEYS.map((key) => {
  if (key === 'title') {
    titleFactEl.setAttribute('data-fact', 'title');
    return titleFactEl;
  }
  const el = makeEl(`fact-${key}`);
  el.setAttribute('data-fact', key);
  return el;
});
/**
 * Answers the heading's rename prompt returns, oldest first. A real browser's prompt()
 * is synchronous, so the queue makes the click deterministic here.
 */
const promptAnswers: Array<string | null> = [];
const sandbox: Record<string, unknown> = {
  // The player legitimately reads these: the back button checks the protocol and,
  // when the viewer is served from the site, navigates to the catalogue root.
  location: { protocol: 'http:', origin: 'http://127.0.0.1:8788', href: 'http://127.0.0.1:8788/viewer' },
  history: { length: 1, back: () => {} },
  addEventListener: (type: string, fn: (e: unknown) => void) => {
    const list = windowListeners.get(type) ?? [];
    list.push(fn);
    windowListeners.set(type, list);
  },
  localStorage: {
    // Small in-memory stand-in so the theme persistence path is exercised.
    getItem(key: string): string | null {
      return settingsStore.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      settingsStore.set(key, String(value));
    },
  },
  document: {
    title: '',
    body: bodyEl,
    head: headEl,
    documentElement: makeEl('html'),
    /**
     * Only the ids the generated page actually defines, and null for anything else.
     *
     * This used to fabricate an element for every lookup, which hid a real bug for a
     * long time: the client asked for `miDark` — a control deleted from the markup
     * long ago — got a fake element here, and on the real page threw a TypeError that
     * killed the rest of the script (no flags, dead toggle).
     */
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: (tag: string) => makeEl(`created-${tag}`, String(tag).toUpperCase()),
    addEventListener: () => {},
    querySelector: () => null,
    // The facts prelude is the only [data-fact] consumer; the panels come back
    // through getElementById. `img.flag` is what the flags are painted through.
    querySelectorAll: (selector: string) =>
      selector === '[data-fact]' ? factEls : selector === 'img.flag' ? flagImgs : [],
  },
  // The shared component resolves every wallpaper against the page URL (`new URL(…)`),
  // which is exactly what keeps root-absolute paths working three levels deep.
  URL,
  Image: class {
    onload: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  },
  ImageData: class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, w: number, h: number) {
      this.data = data;
      this.width = w;
      this.height = h;
    }
  },
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
  // window.prompt is how the heading asks for the new title; nothing else in the player
  // blocks on user input. An unqueued answer is a cancelled prompt.
  prompt: (): string | null => promptAnswers.shift() ?? null,
  setInterval: (fn: () => void, ms?: number) => {
    void fn;
    intervals.push(Number(ms) || 0);
    return intervals.length;
  },
  clearInterval: () => {},
  setTimeout: (fn: () => void) => {
    void fn;
    return 0;
  },
  console,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// ------------------------------------------------------- 2. load the player --
console.log('\n=== 2. scripts execute ===');
const context = vm.createContext(sandbox);
for (const [i, body] of scripts.entries()) {
  try {
    new vm.Script(body, { filename: `script-${i}.js` }).runInContext(context);
    console.log(`  script ${i}: executed`);
  } catch (error) {
    console.log(`  script ${i}: THREW at load\n${(error as Error).stack}`);
    process.exit(1);
  }
}

/** Distinct RGB values in the last painted frame, sampled to stay quick. */
function distinctColors(): { colors: number; topShare: number } {
  const data = lastImage?.data;
  if (!data) return { colors: 0, topShare: 1 };
  const seen = new Map<number, number>();
  let total = 0;
  for (let p = 0; p < data.length / 4; p += 7) {
    const key =
      ((data[p * 4] as number) << 16) | ((data[p * 4 + 1] as number) << 8) | (data[p * 4 + 2] as number);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    total += 1;
  }
  let top = 0;
  for (const n of seen.values()) if (n > top) top = n;
  return { colors: seen.size, topShare: total ? top / total : 1 };
}

// ---------------------------------------------------- 3. every view paints ---
await new Promise((r) => setTimeout(r, 10));
console.log('\n=== 3. view buttons repaint ===');
const viewButtons = [...listeners.keys()].filter((k) => k.endsWith(':click') && /^v[A-Z]/.test(k));
if (viewButtons.length < 9) {
  console.log(`  !! expected 9 view buttons, found ${viewButtons.length}`);
  process.exitCode = 1;
}
// A map that collapsed to one colour is the signature of a broken replay.
const MIN_COLORS: Record<string, number> = {
  vPol: 60, vRel: 15, vCul: 40, vDev: 20, vTech: 20, vIns: 5, vDyn: 20, vHre: 3, vBat: 1,
};
const stats = els.get('stats') as { textContent: string } | undefined;
const chartEl = els.get('chart') as { innerHTML: string } | undefined;
const legendEl = els.get('chartLegend') as { innerHTML: string } | undefined;

for (const key of viewButtons) {
  const id = key.slice(0, key.indexOf(':'));
  const before = putImageDataCalls;
  try {
    for (const fn of listeners.get(key) ?? []) fn({ preventDefault: () => {} });
    const painted = putImageDataCalls - before;
    const { colors, topShare } = distinctColors();
    const chartChars = chartEl ? chartEl.innerHTML.length : 0;
    const legendChars = legendEl ? legendEl.innerHTML.length : 0;
    const tally = new Map<number, number>();
    const d = lastImage?.data;
    if (d) {
      for (let p = 0; p < d.length / 4; p += 13) {
        const key = ((d[p * 4] as number) << 16) | ((d[p * 4 + 1] as number) << 8) | (d[p * 4 + 2] as number);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
    const topColors = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([c, n]) => `#${c.toString(16).padStart(6, '0')}=${((n / Math.max(1, [...tally.values()].reduce((s, v) => s + v, 0))) * 100).toFixed(0)}%`)
      .join(' ');
    const min = MIN_COLORS[id] ?? 2;
    const ok = painted === 1 && colors >= min && chartChars > 100 && legendChars > 50;
    if (!ok) process.exitCode = 1;
    console.log(
      `  ${id}: ${ok ? 'OK' : 'INCOMPLETE'} painted=${painted} colors=${colors}` +
        ` (min ${min}, top ${(topShare * 100).toFixed(0)}%) [${topColors}] chartHtml=${chartChars}` +
        ` legendHtml=${legendChars} stats="${(stats?.textContent ?? '').slice(0, 30)}"`,
    );
  } catch (error) {
    process.exitCode = 1;
    console.log(`  ${id}: THREW\n${(error as Error).stack}`);
  }
}

// -------------------------------------- 3b. battle view sea is pale blue -----
console.log('\n=== 3b. battle view quiet colours ===');
{
  const battleKey = viewButtons.find((k) => k.startsWith('vBat:'));
  const sliderEl = els.get('slider') as { value: string } | undefined;
  if (battleKey && sliderEl) {
    sliderEl.value = '0';
    for (const fn of listeners.get('slider:input') ?? []) fn({});
    for (const fn of listeners.get(battleKey) ?? []) fn({ preventDefault: () => {} });
    const data = lastImage?.data ?? new Uint8ClampedArray(0);
    let land = 0;
    let sea = 0;
    for (let p = 0; p < data.length / 4; p += 1) {
      const r = data[p * 4] as number;
      const g = data[p * 4 + 1] as number;
      const b = data[p * 4 + 2] as number;
      if (r === 246 && g === 246 && b === 246) land += 1;
      else if (r === 171 && g === 199 && b === 226) sea += 1;
    }
    // Quiet land is plain white and quiet water is the requested #ABC7E2.
    const ok = land > 0 && sea > 0;
    if (!ok) process.exitCode = 1;
    const label = 'quiet sea #abc7e2 (171,199,226)';
    const tally = new Map<number, number>();
    for (let p = 0; p < data.length / 4; p += 1) {
      const key =
        ((data[p * 4] as number) << 16) | ((data[p * 4 + 1] as number) << 8) | (data[p * 4 + 2] as number);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log(
      `  land white (246,246,246): ${land} px, ${label}: ${sea} px — ${ok ? 'OK' : 'MISSING'}`,
    );
    console.log(
      `  frame ${data.length / 4} px; top: ` +
        top.map(([c, n]) => `#${c.toString(16).padStart(6, '0')}=${n}`).join(' '),
    );
  } else {
    console.log('  !! could not drive the battle view');
    process.exitCode = 1;
  }
}

// ------------------------------------------------- 3d. hatch is really drawn --
console.log('\n=== 3d. hatching ===');
{
  const B = 64;
  const w = DATA.w;
  const h = DATA.h;
  const cols = Math.ceil(w / B);
  const rows = Math.ceil(h / B);
  /** Province blocks whose interior holds two colours, i.e. base + hatch band. */
  function hatchedBlocks(): number {
    const data = lastImage?.data;
    if (!data) return -1;
    let hatched = 0;
    for (let by = 0; by < rows; by += 1) {
      for (let bx = 0; bx < cols; bx += 1) {
        const colors = new Set<number>();
        for (let y = by * B + 4; y < Math.min(h, by * B + 60); y += 3) {
          for (let x = bx * B + 4; x < Math.min(w, bx * B + 60); x += 3) {
            const p = y * w + x;
            colors.add(
              ((data[p * 4] as number) << 16) |
                ((data[p * 4 + 1] as number) << 8) |
                (data[p * 4 + 2] as number),
            );
          }
        }
        // Borders are excluded by sampling the interior, so two colours really
        // means a hatch band was painted on top of the fill.
        if (colors.size >= 2) hatched += 1;
      }
    }
    return hatched;
  }

  const sliderEl = els.get('slider') as { value: string } | undefined;
  const relKey = viewButtons.find((k) => k.startsWith('vRel:'));
  // Hatching is data-driven, so measure both ends of the campaign: 1444 has
  // almost no confessional mismatch, the Reformation era has a lot.
  for (const [month, value] of [['1444', '0'], ['1574', '1561']] as const) {
    if (!sliderEl) break;
    sliderEl.value = value;
    for (const fn of listeners.get('slider:input') ?? []) fn({});
    if (!relKey) break;
    for (const fn of listeners.get(relKey) ?? []) fn({ preventDefault: () => {} });
    const hatched = hatchedBlocks();
    console.log(`  religion @ ${month}: ${hatched} hatched blocks of ${rows * cols}`);
    if (month === '1574' && hatched < 1) {
      console.log('  !! the religion view drew no hatching in the Reformation era');
      process.exitCode = 1;
    }
  }
  for (const [view, id] of [['religion', 'vRel'], ['political', 'vPol']] as const) {
    const key = viewButtons.find((k) => k.startsWith(`${id}:`));
    if (!key) {
      console.log(`  ${view}: button missing`);
      process.exitCode = 1;
      continue;
    }
    for (const fn of listeners.get(key) ?? []) fn({ preventDefault: () => {} });
    const hatched = hatchedBlocks();
    console.log(`  ${view} @ frozen: ${hatched} hatched province blocks of ${rows * cols}`);
  }
}

// ------------------------------------------------------- 4. slider sweep -----
console.log('\n=== 4. timeline sweep ===');const slider = els.get('slider');
const sliderFns = listeners.get('slider:input') ?? [];
if (slider && sliderFns.length) {
  for (const value of ['0', '400', '900', '1400', '1561']) {
    slider.value = value;
    try {
      for (const fn of sliderFns) fn({});
      const { colors } = distinctColors();
      if (colors < 3) {
        console.log(`  month index ${value}: only ${colors} colours`);
        process.exitCode = 1;
      } else {
        console.log(`  month index ${value}: OK (${colors} colours)`);
      }
    } catch (error) {
      process.exitCode = 1;
      console.log(`  month index ${value}: THREW\n${(error as Error).stack}`);
    }
  }
} else {
  console.log('  !! no slider handler found');
  process.exitCode = 1;
}

// --------------------------------------------------- 5. playback speed ------
console.log('\n=== 5. playback speed slider ===');
{
  const speedEl = els.get('speed') as { value: string; title: string } | undefined;
  const speedVal = els.get('speedVal') as { textContent: string } | undefined;
  const playKey = [...listeners.keys()].find((k) => k === 'play:click');
  const speedKey = [...listeners.keys()].find((k) => k === 'speed:input');
  if (!speedEl || !speedVal || !playKey || !speedKey) {
    console.log('  !! speed slider, play button or its handler is missing');
    process.exitCode = 1;
  } else {
    if (speedVal.textContent !== '3×') {
      console.log(`  !! default label is "${speedVal.textContent}", expected 3×`);
      process.exitCode = 1;
    }
    const clickPlay = (): void => {
      for (const fn of listeners.get(playKey) ?? []) fn({ preventDefault: () => {} });
    };
    const setSpeed = (value: string): void => {
      speedEl.value = value;
      for (const fn of listeners.get(speedKey) ?? []) fn({});
    };
    // 3x must equal the shipped 90 ms/frame; 1x and 5x must bracket it.
    for (const [speed, expected] of [['3', 90], ['1', 270], ['5', 54], ['10', 27], ['20', 14]] as const) {
      setSpeed(speed);
      intervals.length = 0;
      clickPlay();
      const got = intervals[intervals.length - 1] ?? -1;
      clickPlay(); // pause again
      const ok = got === expected;
      if (!ok) process.exitCode = 1;
      console.log(`  ${speed}×: interval ${got} ms (expected ${expected}) ${ok ? 'OK' : 'WRONG'}`);
    }
    // Changing speed while playing must restart the timer at the new rate.
    intervals.length = 0;
    setSpeed('2');
    clickPlay();
    const before = intervals.length;
    setSpeed('4');
    const restarted = intervals.length > before;
    const changed = restarted && intervals[intervals.length - 1] === 68;
    clickPlay();
    if (!changed) process.exitCode = 1;
    console.log(
      `  live change 2× -> 4×: restarted=${restarted} new interval ${intervals[intervals.length - 1]} ms (expected 68) ${changed ? 'OK' : 'WRONG'}`,
    );

    // The +/- buttons beside the slider step the speed by exactly one.
    const stepKey = (name: string): string | undefined =>
      [...listeners.keys()].find((k) => k === `${name}:click`);
    const upKey = stepKey('speedUp');
    const downKey = stepKey('speedDown');
    if (!upKey || !downKey) {
      console.log('  !! the speed +/- buttons are missing');
      process.exitCode = 1;
    } else {
      const bump = (key: string): void => {
        for (const fn of listeners.get(key) ?? []) fn({ preventDefault: () => {} });
      };
      const read = (): string => `${speedEl.value}/${speedVal.textContent}`;
      setSpeed('3');
      bump(upKey);
      const up1 = read();
      bump(upKey);
      const up2 = read();
      bump(downKey);
      const down1 = read();
      const stepsOk = up1 === '4/4×' && up2 === '5/5×' && down1 === '4/4×';
      if (!stepsOk) process.exitCode = 1;
      console.log(`  3 +1 -> ${up1}, +1 -> ${up2}, -1 -> ${down1} ${stepsOk ? 'OK' : 'WRONG'}`);

      setSpeed('20');
      bump(upKey);
      const top = read();
      setSpeed('1');
      bump(downKey);
      const bottom = read();
      const clampOk = top === '20/20×' && bottom === '1/1×';
      if (!clampOk) process.exitCode = 1;
      console.log(`  clamp: at 20 +1 -> ${top}, at 1 -1 -> ${bottom} ${clampOk ? 'OK' : 'WRONG'}`);

      // Stepping during playback retimes the running timer, like the slider does.
      intervals.length = 0;
      setSpeed('1');
      clickPlay();
      bump(upKey);
      const live = intervals[intervals.length - 1] ?? -1;
      clickPlay();
      const liveOk = live === 135;
      if (!liveOk) process.exitCode = 1;
      console.log(`  step while playing (1× -> 2×): interval ${live} ms (expected 135) ${liveOk ? 'OK' : 'WRONG'}`);
    }
  }
}

// --------------------------------------------------- 6. zoom and pan --------
console.log('\n=== 6. map zoom and pan ===');
{
  const canvasEl = els.get('map') as { style: Record<string, string> } | undefined;
  const fire = (id: string, type: string, event: Record<string, unknown>): void => {
    for (const fn of listeners.get(`${id}:${type}`) ?? []) fn({ preventDefault: () => {}, ...event });
  };
  const fireWindow = (type: string, event: Record<string, unknown>): void => {
    for (const fn of windowListeners.get(type) ?? []) fn({ preventDefault: () => {}, ...event });
  };
  const state = (): { scale: number; x: number; y: number } => {
    const t = canvasEl?.style.transform ?? '';
    const s = /scale\(([\d.]+)\)/.exec(t);
    const p = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(t);
    return {
      scale: s ? Number(s[1]) : -1,
      x: p ? Number(p[1]) : 0,
      y: p ? Number(p[2]) : 0,
    };
  };

  const need = ['zoomIn:click', 'zoomOut:click', 'zoomReset:click', 'map:wheel', 'map:pointerdown'];
  const missing = need.filter((k) => !listeners.has(k));
  if (missing.length || !canvasEl || !windowListeners.has('pointermove')) {
    console.log(`  !! missing zoom/pan wiring: ${missing.join(', ')}${windowListeners.has('pointermove') ? '' : ' window:pointermove'}`);
    process.exitCode = 1;
  } else {
    // Every gesture below is a *mouse* pointer (第四对话任务书.md §4.3 C3): the map listens
    // for Pointer Events now, and these four helpers are the same press/move/lift the mouse
    // assertions here have always made — the numbers after them are unchanged on purpose,
    // because "desktop behaviour is byte-for-byte the same" is what this section proves.
    const mouse = { pointerType: 'mouse', pointerId: 1, isPrimary: true };
    const pointerDown = (x: number, y: number): void =>
      fire('map', 'pointerdown', { ...mouse, button: 0, clientX: x, clientY: y });
    const pointerMove = (x: number, y: number): void =>
      fireWindow('pointermove', { ...mouse, clientX: x, clientY: y });
    const pointerUp = (): void => fireWindow('pointerup', { ...mouse });
    fire('zoomReset', 'click', {});
    const initial = state();
    console.log(`  initial: scale=${initial.scale} translate=(${initial.x},${initial.y})`);
    if (initial.scale !== 1 || initial.x !== 0 || initial.y !== 0) process.exitCode = 1;

    fire('zoomIn', 'click', {});
    fire('zoomIn', 'click', {});
    const zoomed = state();
    const zoomOk = Math.abs(zoomed.scale - 1.5625) < 0.001;
    if (!zoomOk) process.exitCode = 1;
    console.log(`  after 2x "+": scale=${zoomed.scale} (expected 1.5625) ${zoomOk ? 'OK' : 'WRONG'}`);

    // Wheel up must zoom further in, wheel down back out.
    fire('map', 'wheel', { deltaY: -100, clientX: 500, clientY: 200 });
    const wheeled = state();
    const wheelOk = wheeled.scale > zoomed.scale;
    if (!wheelOk) process.exitCode = 1;
    console.log(`  wheel up: scale=${wheeled.scale} ${wheelOk ? 'OK' : 'WRONG'}`);
    fire('map', 'wheel', { deltaY: 100, clientX: 500, clientY: 200 });
    const wheelBack = state();
    const backOk = Math.abs(wheelBack.scale - zoomed.scale) < 0.001;
    if (!backOk) process.exitCode = 1;
    console.log(`  wheel down: scale=${wheelBack.scale} ${backOk ? 'OK' : 'WRONG'}`);

    // Drag: press on the map, move up-left, the map must follow.
    const before = state();
    pointerDown(500, 200);
    pointerMove(460, 170);
    const panned = state();
    const panOk = Math.abs(panned.x - (before.x - 40)) < 0.01 && Math.abs(panned.y - (before.y - 30)) < 0.01;
    if (!panOk) process.exitCode = 1;
    console.log(
      `  drag (-40,-30): translate=(${panned.x},${panned.y}) ${panOk ? 'OK' : 'WRONG'}`,
    );
    pointerUp();

    // Panning must be clamped so the map can never leave its viewport.
    pointerDown(500, 200);
    pointerMove(-99_999, -99_999);
    const clamped = state();
    const cw = (canvasEl as unknown as { clientWidth: number }).clientWidth;
    const minX = cw * (1 - panned.scale);
    const clampOk = Math.abs(clamped.x - minX) < 0.01 && clamped.x <= 0;
    if (!clampOk) process.exitCode = 1;
    console.log(`  clamp: translate=(${clamped.x},${clamped.y}) expected x=${minX.toFixed(1)} ${clampOk ? 'OK' : 'WRONG'}`);
    pointerUp();

    // The filter must follow the magnification: smooth while the native raster
    // is being shrunk (the default fit-to-width view), crisp once magnified.
    const nativeWidth = (canvasEl as unknown as { width: number }).width;
    const filter = (): string => canvasEl.style.imageRendering ?? '';
    const smoothed = filter() === 'auto';
    if (!smoothed) process.exitCode = 1;
    console.log(
      `  fit view (${(cw / nativeWidth).toFixed(3)}x native): image-rendering=${filter()} ${smoothed ? 'OK' : 'WRONG'}`,
    );
    let clicks = 0;
    while (state().scale * (cw / nativeWidth) < 1 && clicks < 20) {
      fire('zoomIn', 'click', {});
      clicks += 1;
    }
    const crisp = filter() === 'pixelated';
    if (!crisp) process.exitCode = 1;
    console.log(
      `  magnified (${(state().scale * (cw / nativeWidth)).toFixed(2)}x native after ${clicks} clicks): image-rendering=${filter()} ${crisp ? 'OK' : 'WRONG'}`,
    );
    // Zoom must be capped relative to native pixels, not by a magic number.
    for (let i = 0; i < 40; i += 1) fire('zoomIn', 'click', {});
    const ceiling = state().scale * (cw / nativeWidth);
    const capped = ceiling <= 4.001;
    if (!capped) process.exitCode = 1;
    console.log(`  zoom ceiling: ${ceiling.toFixed(2)}x native (max 4) ${capped ? 'OK' : 'WRONG'}`);

    fire('zoomReset', 'click', {});
    const reset = state();
    const resetOk = reset.scale === 1 && reset.x === 0 && reset.y === 0;
    if (!resetOk) process.exitCode = 1;
    console.log(`  reset: scale=${reset.scale} translate=(${reset.x},${reset.y}) ${resetOk ? 'OK' : 'WRONG'}`);

    // Dragging must not be possible while the map is at fit-to-width: there is
    // nothing to reveal, so the translation has to stay pinned at zero.
    pointerDown(500, 200);
    pointerMove(600, 300);
    const pinned = state();
    const pinOk = pinned.x === 0 && pinned.y === 0;
    if (!pinOk) process.exitCode = 1;
    console.log(`  drag at 1x stays pinned: (${pinned.x},${pinned.y}) ${pinOk ? 'OK' : 'WRONG'}`);
    pointerUp();
  }
}

// ------------------------------------------------ 7. resolution toggle ------
console.log('\n=== 7. resolution toggle ===');
{
  const canvasEl = els.get('map') as { width: number; height: number } | undefined;
  const fire = (id: string, type: string, event: Record<string, unknown> = {}): void => {
    for (const fn of listeners.get(`${id}:${type}`) ?? []) fn({ preventDefault: () => {}, ...event });
  };
  const distinct = (): number => {
    const data = lastImage?.data;
    if (!data) return 0;
    const seen = new Set<number>();
    for (let p = 0; p < data.length / 4; p += 7) {
      seen.add(
        ((data[p * 4] as number) << 16) | ((data[p * 4 + 1] as number) << 8) | (data[p * 4 + 2] as number),
      );
    }
    return seen.size;
  };
  if (!listeners.has('res:click') || !canvasEl) {
    console.log('  !! resolution button missing');
    process.exitCode = 1;
  } else {
    const native = { w: DATA.w, h: DATA.h };
    const halfSize = { w: DATA.w >> 1, h: DATA.h >> 1 };
    // Half resolution is the default, so the map must already be quarter-size.
    const before = { w: canvasEl.width, h: canvasEl.height };
    const defaultOk = before.w === halfSize.w && before.h === halfSize.h;
    const defaultColors = distinct();
    if (!defaultOk || defaultColors < 50) process.exitCode = 1;
    console.log(
      `  default: canvas ${before.w}x${before.h} (expected half ${halfSize.w}x${halfSize.h}) colors=${defaultColors} ${defaultOk && defaultColors >= 50 ? 'OK' : 'WRONG'}`,
    );

    fire('res', 'click');
    const full = { w: canvasEl.width, h: canvasEl.height };
    const fullOk = full.w === native.w && full.h === native.h && distinct() >= 50;
    if (!fullOk) process.exitCode = 1;
    console.log(
      `  toggled to native: canvas ${full.w}x${full.h} colors=${distinct()} ${fullOk ? 'OK' : 'WRONG'}`,
    );

    fire('res', 'click');
    const back = { w: canvasEl.width, h: canvasEl.height };
    const backOk = back.w === halfSize.w && back.h === halfSize.h && distinct() >= 50;
    if (!backOk) process.exitCode = 1;
    console.log(`  back to half: canvas ${back.w}x${back.h} colors=${distinct()} ${backOk ? 'OK' : 'WRONG'}`);
  }
}

// ------------------------------------------------------- 8. interface style --
console.log('\n=== 8. flags, and the shared background/theme component ===');
{
  const btn = els.get('flagset') as { textContent: string } | undefined;
  const fire = (): void => {
    for (const fn of listeners.get('flagset:click') ?? []) fn({ preventDefault: () => {} });
  };
  if (!btn || !listeners.has('flagset:click')) {
    console.log('  !! flag-set button missing');
    process.exitCode = 1;
  } else {
    const first = btn.textContent;
    fire();
    const second = btn.textContent;
    fire();
    const third = btn.textContent;
    const ok = first.includes('原版') && second.includes('国家娘') && third.includes('原版');
    if (!ok) process.exitCode = 1;
    console.log(`  flag set button: ${first} -> ${second} -> ${third} ${ok ? 'OK' : 'WRONG'}`);
  }

  // Backgrounds and themes are no longer the viewer's own: this page mounts the same
  // component the catalogue does (apps/site/public/page-theme.js), inlined above the
  // player as a classic script. So the checks are that the module is on the page at all,
  // that the player really mounted it, and that what it built is the shared markup —
  // two cross-fading layers, the scrim, the stylesheet — rather than a second copy of
  // the old panel, which is what this whole change was meant to remove.
  const moduleKind = vm.runInContext('typeof mountPageTheme', context) as string;
  const children = bodyEl.appended as Array<Record<string, unknown>>;
  const hasClass = (el: Record<string, unknown>, name: string): boolean =>
    (el.classList as { contains: (c: string) => boolean }).contains(name);
  const layers = children.filter((el) => hasClass(el, 'bgLayer'));
  const scrim = children.find((el) => el.className === 'bgScrim');
  const first = String((layers[0]?.style as Record<string, string> | undefined)?.backgroundImage ?? '');
  const scrimOpacity = String((scrim?.style as Record<string, string> | undefined)?.opacity ?? '');
  const styles = headEl.appended.filter((el) => el.id === 'pageThemeStyles');
  const panel = children.find((el) => el.id === 'pageThemePanel');
  const gridOf = panel ? (panel.querySelector as (s: string) => Record<string, unknown> | null) : null;
  const grid = gridOf ? gridOf('#pageThemeThumbs') : null;
  const thumbs = ((grid?.appended as Array<unknown> | undefined) ?? []).length;
  const wallpapers = vm.runInContext('BG.length', context) as number;
  const saved = JSON.parse(settingsStore.get('eu4analyser.settings') ?? '{}') as { theme?: string };

  const mounted =
    moduleKind === 'function' &&
    layers.length === 2 &&
    Boolean(layers[0] && hasClass(layers[0], 'on')) &&
    // Resolved against the page URL, so the root-absolute wallpaper paths survive being
    // served from /saves/<id>/viewer/ — which is where they used to 404.
    first.startsWith('url("http://127.0.0.1:8788/') &&
    first.includes(encodeURIComponent('背景图')) &&
    scrimOpacity === '0.66' &&
    styles.length === 1 &&
    thumbs === wallpapers &&
    saved.theme === 'slate';
  if (!mounted) process.exitCode = 1;
  console.log(`  shared component present: typeof mountPageTheme=${moduleKind}`);
  console.log(`  layers=${layers.length} first-active=${Boolean(layers[0] && hasClass(layers[0], 'on'))} scrim opacity=${scrimOpacity || '(unset)'}`);
  console.log(`  first wallpaper resolved against the page URL: "${first.slice(0, 58)}…"`);
  console.log(`  stylesheet injected=${styles.length}, thumbnails=${thumbs}/${wallpapers}, persisted theme="${saved.theme}" ${mounted ? 'OK' : 'WRONG'}`);
}

// --------------------------- 8b. flags in the host's own tables ---------------
console.log('\n=== 8b. the leaderboard flags are a wrapper plus a right-half block ===');
{
  // The first of the four flag render points, and the only one the stub used to skip:
  // applyFlagSet() walks document.querySelectorAll('img.flag'), and the leaderboard rows
  // (and the chart legend) are the *host's* markup, not the client's. The stub now answers
  // that selector from what those markup strings declared, so the path really runs.
  const leaderBody = els.get('leaderBody') as { innerHTML: string } | undefined;
  const fire = (): void => {
    for (const fn of listeners.get('flagset:click') ?? []) fn({ preventDefault: () => {} });
  };
  const label = (): string => String((els.get('flagset') as { textContent?: string } | undefined)?.textContent ?? '');
  const prefixOf = (): string => (label().includes('国家娘') ? '/assets/flags/modded/' : '/assets/flags/base/');
  /** The last image the stub registered for a tag, i.e. the one this section injected. */
  const imageOf = (tag: string): Record<string, unknown> | undefined =>
    [...flagImgs].reverse().find((img) => (img.getAttribute as (n: string) => string | null)('data-tag') === tag);
  const childrenOf = (img: Record<string, unknown> | undefined): Array<Record<string, unknown>> =>
    (img?.parentNode as { children?: Array<Record<string, unknown>> } | undefined)?.children ?? [];
  const boxedOf = (img: Record<string, unknown> | undefined): boolean => {
    const box = img?.parentNode as { classList?: { contains: (c: string) => boolean } } | undefined;
    return Boolean(box?.classList?.contains('flagBox'));
  };
  const tintsOf = (img: Record<string, unknown> | undefined): Array<Record<string, unknown>> =>
    childrenOf(img).filter((kid) => kid.className === 'flagTint');
  const colourOf = (img: Record<string, unknown> | undefined): string =>
    String(((tintsOf(img)[0]?.style ?? {}) as Record<string, string>).background ?? '');
  const hiddenTintOf = (img: Record<string, unknown> | undefined): boolean =>
    String(((tintsOf(img)[0]?.style ?? {}) as Record<string, string>).display ?? '') === 'none';
  const srcOf = (img: Record<string, unknown> | undefined): string => String(img?.src ?? '');

  // Everything the host declared — fifteen leaderboard rows and the chart legend — is
  // wrapped, colonial or not: the wrapper is what makes a block possible at all.
  const declared = flagImgs.length;
  const wrapped = flagImgs.filter(boxedOf).length;
  const wrappedOk = declared >= 15 && wrapped === declared;
  if (!wrappedOk) process.exitCode = 1;
  console.log(`  the host's own flags are wrapped: ${wrapped}/${declared} in .flagBox ${wrappedOk ? 'OK' : 'WRONG'}`);

  // One colonial row in the leaderboard's own shape (BRZ is POR's colony in this save) and
  // one ordinary country. The colour is the frozen hash, pinned as the hex the preview
  // page prints for the same tag.
  const rows =
    '<tr><td><span class="sw" data-tag="BRZ"></span><img class="flag" data-tag="BRZ" alt="">巴西</td>' +
    '<td class="tag">BRZ</td></tr>' +
    '<tr><td><span class="sw" data-tag="RUS"></span><img class="flag" data-tag="RUS" alt="">俄罗斯</td>' +
    '<td class="tag">RUS</td></tr>';
  if (leaderBody) leaderBody.innerHTML = rows;
  const colonial = imageOf('BRZ');
  const plain = imageOf('RUS');

  const read = (): Record<string, unknown> => ({
    prefix: prefixOf(),
    colonialSrc: srcOf(colonial),
    block: colourOf(colonial),
    blocks: tintsOf(colonial).length,
    plainSrc: srcOf(plain),
    plainBlock: tintsOf(plain).length,
    plainHidden: hiddenTintOf(plain),
  });
  const before = prefixOf();
  fire();
  const first = read();
  fire();
  const second = read();
  fire();
  const third = read();
  // Leave the artwork set where the sections after this one expect to find it: the button
  // toggles, so an odd number of clicks has to be balanced.
  for (let i = 0; i < 4 && prefixOf() !== before; i += 1) fire();

  const asExpected = (state: Record<string, unknown>): boolean =>
    state.colonialSrc === `${state.prefix}POR.png` &&
    state.plainSrc === `${state.prefix}RUS.png` &&
    state.block === '#372eb8';
  const colonialOk = boxedOf(colonial) && boxedOf(plain) && asExpected(first) &&
    // The block belongs to the colony alone: the ordinary country has none at all.
    first.blocks === 1 && first.plainBlock === 0;
  // Idempotent: applyFlagSet runs on every 旗帜 click, and a second or third pass must not
  // stack another block in the wrapper — nor move the block's colour, which is the colony's.
  const idempotent =
    asExpected(second) && asExpected(third) &&
    second.blocks === 1 && third.blocks === 1 &&
    second.block === '#372eb8' && third.block === '#372eb8' &&
    // The switch really did flip the artwork set: the prefix changed and came back.
    second.prefix !== first.prefix && third.prefix === first.prefix;
  if (!colonialOk || !idempotent) process.exitCode = 1;
  console.log(
    `  BRZ -> ${first.colonialSrc} with ${first.block} (blocks=${first.blocks}), RUS -> ${first.plainSrc} ` +
      `(blocks=${first.plainBlock}) ${colonialOk ? 'OK' : 'WRONG'}`,
  );
  console.log(
    `  旗帜 switch: ${first.prefix} -> ${second.prefix} -> ${third.prefix}, ` +
      `srcs ${second.colonialSrc} / ${third.colonialSrc}, block still ${third.block} (blocks=${third.blocks}) ` +
      `${idempotent ? 'OK' : 'WRONG'}`,
  );

  // The mother country's flag is the last thing left to ask for, so a failure there hides
  // the image in the table — as an artwork-less country always has — while the heading and
  // the card turn the same failure into a TAG block.
  const missing = colonial?.onerror as (() => void) | undefined;
  if (typeof missing === 'function') missing.call(colonial);
  const hidden = String(((colonial?.style ?? {}) as Record<string, string>).display ?? '') === 'none';
  if (!hidden) process.exitCode = 1;
  console.log(`  a flag whose artwork is really gone is hidden in the table: ${hidden ? 'OK' : 'WRONG'}`);
}

console.log('\n=== 9. navigation, one settings surface, colonial flags ===');
{
  const fire = (id: string): void => {
    for (const fn of listeners.get(`${id}:click`) ?? []) fn({ preventDefault: () => {}, stopPropagation: () => {} });
  };
  // ← must return to the catalogue. The catalogue IS the site root, so when the viewer is
  // served over http(s) the handler navigates; a tab opened straight from disk has only
  // history to fall back on.
  const loc = sandbox.location as { href: string };
  const pageUrl = loc.href;
  fire('back');
  const wentHome = loc.href === '/';
  loc.href = pageUrl; // the checks below resolve wallpaper URLs against the page URL
  if (!wentHome) process.exitCode = 1;
  console.log(`  back to the catalogue: → "${wentHome ? '/' : loc.href}" ${wentHome ? 'OK' : 'WRONG'}`);

  // The 🎨 is now the only settings surface, and it belongs to the shared component, so
  // the old stack (⚙ / #panel1..#panel3 / #dimRange / the thumbnail grid) must be gone
  // from the page rather than merely unwired — one component is the whole point.
  const children = bodyEl.appended as Array<Record<string, unknown>>;
  const panel = children.find((el) => el.id === 'pageThemePanel');
  const open = (): boolean =>
    Boolean(panel && (panel.classList as { contains: (c: string) => boolean }).contains('open'));
  const wired = listeners.has('pageThemeBtn:click');
  const wasClosed = !open();
  fire('pageThemeBtn');
  const opened = open();
  fire('pageThemeBtn');
  const closed = !open();
  const gone = ['settings', 'panel1', 'panel2', 'panel3', 'miTheme', 'miBg', 'bgA', 'bgB',
    'bgDim', 'bgList', 'dimRange', 'dimVal', 'bgInterval'];
  const leftovers = gone.filter((id) => html.includes(`id="${id}"`));
  const togglesOk = wentHome && wired && wasClosed && opened && closed && leftovers.length === 0;
  if (!togglesOk) process.exitCode = 1;
  console.log(`  🎨 panel toggles: wired=${wired} closed=${wasClosed} -> open=${opened} -> closed=${closed} ${togglesOk ? 'OK' : 'WRONG'}`);
  console.log(`  the viewer's own settings markup is gone: ${leftovers.length ? leftovers.join(', ') : 'none left'} ${leftovers.length ? 'WRONG' : 'OK'}`);

  // Colonial relationships come from `colonial_parent`, never `overlord`.
  const colonial = vm.runInContext('DATA.colonialParent', context) as Record<string, string>;
  const count = Object.keys(colonial).length;
  const brz = colonial.BRZ;
  const ok = count > 20 && count < 60 && typeof brz === 'string';
  if (!ok) process.exitCode = 1;
  console.log(`  colonial nations: ${count} (BRZ -> ${brz}) ${ok ? 'OK' : 'WRONG'}`);
}

console.log('\n=== 10. the host-supplied facts and panel tables land in the page ===');
{
  // A blank headline or an empty leaderboard is what a broken hand-off looks like,
  // and it is invisible in every other check.
  const facts = vm.runInContext('VIEWER_FACTS', context) as Record<string, unknown>;
  const panels = vm.runInContext('VIEWER_PANELS', context) as Record<string, string>;
  const shown = factEls.map((el) => ({
    key: String(el.getAttribute('data-fact')),
    text: String((el as { textContent: string }).textContent),
  }));
  const blanks = shown.filter((entry) => entry.text === '').map((entry) => entry.key);
  const wrong = shown.filter((entry) => entry.text !== String(facts[entry.key] ?? '')).map((entry) => entry.key);
  const title = String((sandbox.document as { title: string }).title);
  const sliderMax = String((els.get('slider') as { max?: string } | undefined)?.max ?? '');
  const bodies = ['leaderBody', 'cityBody', 'institutionBody'].map((id) => ({
    id,
    length: String((els.get(id) as { innerHTML: string } | undefined)?.innerHTML ?? '').length,
  }));
  const emptyBodies = bodies.filter((body) => body.length < 20).map((body) => body.id);

  const ok =
    blanks.length === 0 &&
    wrong.length === 0 &&
    emptyBodies.length === 0 &&
    // The player owns the title: it rewrites it with the frame's date as it draws, so
    // the check is that it followed the player, not that the host set it.
    /版图时间线/.test(title) &&
    sliderMax === String((vm.runInContext('DATA.months.length', context) as number) - 1);
  if (!ok) process.exitCode = 1;
  console.log(`  facts shown: ${shown.length - blanks.length}/${shown.length} (blank: ${blanks.join(',') || 'none'}, wrong: ${wrong.join(',') || 'none'})`);
  console.log(`  document.title: "${title}"`);
  console.log(`  slider max: ${sliderMax} ${sliderMax ? 'OK' : 'MISSING'}`);
  console.log(`  panels: ${bodies.map((b) => `${b.id}=${b.length}`).join(' ')} ${emptyBodies.length ? 'EMPTY' : 'OK'}`);
  console.log(`  -> ${ok ? 'OK' : 'WRONG'}`);
}

console.log('\n=== 10b. heading, field summary and the acrylic nav ===');
{
  // Requirement 6: the heading is "国名 · 起 → 止". The suffix the user asked to delete named
  // the *site*, not this document, so it must be gone from the <h1> while the tab title and
  // the navigation keep it.
  // The heading is matched from its own opening span, not from a bare <h1>: the stylesheet
  // above it *mentions* <h1> in a comment, and a lazy match from there would swallow the
  // whole head of the document.
  const h1 = /<h1>(<span id="titleText"[\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '';
  const pageTitle = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const navTitle = /<div class="navTitle">([^<]*)<\/div>/.exec(html)?.[1] ?? '';
  const headingOk =
    h1 !== '' &&
    !h1.includes('月度版图时间线') &&
    ['title', 'start', 'end'].every((key) => h1.includes(`data-fact="${key}"`)) &&
    pageTitle.includes('月度版图时间线') &&
    navTitle.includes('月度版图时间线');
  if (!headingOk) process.exitCode = 1;
  console.log(`  <h1> "${h1.replace(/\s+/g, ' ').trim()}" ${headingOk ? 'OK' : 'WRONG'}`);
  console.log(`  tab "${pageTitle}", nav "${navTitle}" (both keep the site suffix)`);

  // Requirement 7: the line under the heading is the archive's fields, not the parsed frame
  // counts, and every one of the four is really filled — a label with an empty span is what
  // a missing hand-off looks like, and it is invisible everywhere else.
  const sub = /<div class="sub">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const facts = vm.runInContext('VIEWER_FACTS', context) as Record<string, unknown>;
  const FIELDS = ['version', 'endDate', 'sealedAt', 'mods'];
  const summaryOk =
    ['版本：', '结档日期：', '封档日期：', '模组：'].every((label) => sub.includes(label)) &&
    FIELDS.every((key) => sub.includes(`data-fact="${key}"`)) &&
    FIELDS.every((key) => String(facts[key] ?? '') !== '') &&
    !/个省份|个月度帧|条带日期事件/.test(sub);
  if (!summaryOk) process.exitCode = 1;
  console.log(`  sub "${sub.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()}" ${summaryOk ? 'OK' : 'WRONG'}`);
  console.log(`  facts ${FIELDS.map((key) => `${key}="${String(facts[key] ?? '')}"`).join(' ')}`);

  // Requirement 8: the navigation is acrylic on all four themes. The translucent tint is a
  // per-theme variable (one rgba cannot be right for both a slate dark and a parchment
  // light), and both spellings of the filter are present — the -webkit- one is what makes
  // this work outside Chromium.
  const glass = [...html.matchAll(/--nav-glass:([^;}]+)/g)].map((m) => (m[1] as string).trim());
  const acrylicOk =
    glass.length === 4 &&
    glass.every((value) => /^rgba\(/.test(value)) &&
    html.includes('-webkit-backdrop-filter:blur(18px) saturate(1.4)') &&
    html.includes('backdrop-filter:blur(18px) saturate(1.4)') &&
    // The opaque chrome stays as the fallback for an engine that ignores the feature.
    /#nav\{[^}]*background:var\(--nav-bg\)/.test(html);
  if (!acrylicOk) process.exitCode = 1;
  console.log(`  nav glass: ${glass.length} theme tint(s) ${glass.join(' / ')}`);
  console.log(`  blur(18px) saturate(1.4) with -webkit- fallback and an opaque base ${acrylicOk ? 'OK' : 'WRONG'}`);
}

console.log('\n=== 11. colour modes ===');
{
  // `fire` is defined per section, so this block needs its own.
  const click = (id: string): void => {
    if (!listeners.has(`${id}:click`)) return;
    for (const fn of listeners.get(`${id}:click`) ?? []) fn({ preventDefault: () => {}, stopPropagation: () => {} });
  };
  // The three modes are the answer to "the recolouring mod painted my empire and its
  // subjects one colour". A button that only relabels itself would pass a static check,
  // so the frame is sampled: switching modes must actually repaint the map.
  const label = (): string => String((els.get('colour') as { textContent?: string } | undefined)?.textContent ?? '(missing #colour)');
  const signature = (): string => {
    const data = lastImage?.data;
    if (!data) return 'no-frame';
    let sum = 0;
    for (let p = 0; p < data.length / 4; p += 211) {
      sum = (sum + data[p * 4] * 65536 + data[p * 4 + 1] * 256 + data[p * 4 + 2]) % 2147483647;
    }
    return String(sum);
  };

  const labels: string[] = [label()];
  const frames: string[] = [signature()];
  for (let i = 0; i < 3; i += 1) {
    click('colour');
    labels.push(label());
    frames.push(signature());
  }

  const modes = labels.slice(0, 3);
  const cycled = new Set(modes).size === 3 && labels[3] === labels[0];
  const distinct = new Set(frames.slice(0, 3)).size;
  const palette = vm.runInContext('DATA.colours', context) as { subjects?: number; from?: number[] } | undefined;
  const subjects = palette?.subjects ?? 0;
  // Two of the three modes must differ on this save (it has both a recolouring mod and
  // subjects); identical frames would mean the button does nothing.
  const ok = cycled && distinct >= 2 && subjects > 0 && frames[3] === frames[0];
  if (!ok) process.exitCode = 1;
  console.log(`  button cycles: ${labels.slice(0, 4).join(' -> ')} ${cycled ? 'OK' : 'WRONG'}`);
  console.log(`  frames differ across ${distinct}/3 modes, returns to the first: ${frames[3] === frames[0]} ${ok ? 'OK' : 'WRONG'}`);
  console.log(`  DATA.colours.subjects=${subjects}, from[] entries=${(palette?.from ?? []).filter((o) => o >= 0).length}`);
}

// ---------------------------------- 12. the archive record drawer (📝) -----
console.log('\n=== 12. archive info drawer (📝) ===');
{
  // One client, two hosts. The page verified above is the *generated* one: a file with
  // no catalogue record behind it, so the host hands the client no VIEWER_META and the
  // drawer must not exist at all — and the heading must stay plain, un-clickable text.
  // The hosted page hands it { id, name, custom } and the drawer must prefill from that
  // record, edit it, and send one PATCH to the record's own URL; its heading is a second
  // editor for the same title. Both halves are checked here: a 📝 that shows up on the
  // offline file (or one that saves to the wrong address) is invisible to every other
  // check in this file.
  const children = bodyEl.appended as Array<Record<string, unknown>>;
  const headRow = els.get('headRow');
  if (!headRow) throw new Error('viewer.html must declare #headRow for the heading row');
  const headRowChildren = headRow.appended as Array<Record<string, unknown>>;
  const titleText = els.get('titleText') as { textContent: string };
  const headerTitle = String(
    (vm.runInContext('VIEWER_FACTS', context) as { title?: unknown }).title ?? '',
  );
  const offlineReasons: string[] = [];
  if (headRowChildren.some((el) => el.id === 'profileBtn')) offlineReasons.push('button in the heading row');
  if (children.some((el) => el.id === 'profileBtn')) offlineReasons.push('button floating on the body');
  if (listeners.has('profileBtn:click')) offlineReasons.push('button wired');
  if (listeners.has('titleText:click')) offlineReasons.push('heading wired for rename');
  if (titleText.textContent !== headerTitle) {
    offlineReasons.push(`heading is "${titleText.textContent}", expected the country name "${headerTitle}"`);
  }
  const offlineOk = offlineReasons.length === 0;
  if (!offlineOk) process.exitCode = 1;
  console.log(
    `  offline page (no record): 📝 buttons=${headRowChildren.filter((el) => el.id === 'profileBtn').length}, ` +
      `wired=${listeners.has('profileBtn:click')}, heading="${titleText.textContent}", rename wired=${listeners.has('titleText:click')} ` +
      `${offlineOk ? 'OK' : 'WRONG'}`,
  );
  if (!offlineOk) console.log(`    !! ${offlineReasons.join('; ')}`);

  // The trigger is a labelled button on the heading's own line, not a corner bubble: the
  // CSS says so (the drawer styles are the only part of the markup it owns) and so does
  // the DOM (the client appends it to #headRow).
  const buttonRule = /#profileBtn\{([^}]*)\}/.exec(html)?.[1] ?? '';
  const rowRule = /\.headrow\{([^}]*)\}/.exec(html)?.[1] ?? '';
  const layoutOk =
    rowRule.includes('position:relative') &&
    rowRule.includes('display:flex') &&
    buttonRule.includes('margin-left:auto') &&
    !buttonRule.includes('position:fixed') &&
    html.includes('@media (max-width:900px){#profileBtn .lbl{display:none}}');
  if (!layoutOk) process.exitCode = 1;
  console.log(
    `  heading row is the trigger's home: flex=${rowRule.includes('display:flex')} ` +
      `relative=${rowRule.includes('position:relative')} margin-left:auto=${buttonRule.includes('margin-left:auto')} ` +
      `still fixed=${buttonRule.includes('position:fixed')} ${layoutOk ? 'OK' : 'WRONG'}`,
  );

  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  // 200 for the first save, 401 for the second: a refused write has to say what to do.
  const statuses = [200, 401];
  // The great powers the picker lists: exactly the fifteen the leaderboard shows, in the
  // "TAG-国名" shape the user asked for. The picker must produce that list from this array
  // and, when it is missing, from the table body instead — see the static guard.
  const POWERS = [
    'RUS-俄罗斯', 'MNG-明', 'HAB-奥地利', 'FRA-法兰西', 'TUR-奥斯曼',
    'ESP-西班牙', 'ENG-英格兰', 'POL-波兰', 'SWE-瑞典', 'VEN-威尼斯',
    'MOS-莫斯科', 'BRA-勃兰登堡', 'PAP-教皇国', 'HUN-匈牙利', 'POR-葡萄牙',
  ].map((entry) => ({
    tag: entry.slice(0, entry.indexOf('-')),
    name: entry.slice(entry.indexOf('-') + 1),
  }));
  const record = {
    id: 'b6263f5baf54',
    name: 'mp_俄罗斯1574_11_12.eu4',
    uploadedAt: '2026-09-18T04:05:06.000Z',
    info: { version: '1.37.5.0', campaignDate: '1574.11.12', playerTag: 'MNG' },
    custom: {
      title: '大汉 · 我的第一次统一',
      mods: '风云世纪两千年',
      endDate: '1574.11.12',
      sealedAt: '2026-09-19',
      protagonists: [{ tag: 'MNG', player: '张三' }],
    },
    leaders: POWERS,
  };
  settingsStore.set('catalogue.token', 'tok-123');
  // A second context over the same DOM: the primary page keeps its state (the checks
  // above already read it) and this one runs the identical scripts with the two globals
  // the hosted page adds.
  const hosted: Record<string, unknown> = Object.assign({}, sandbox, {
    VIEWER_META: record,
    fetch: (url: string, init: Record<string, unknown>) => {
      // The viewer also reads S2's key -> 中文名 table at load, which is not one of the
      // catalogue's own API calls: answering it 404 keeps this section's call log exactly
      // the sequence of PATCHes it is asserting on (the sheet falls back to raw keys).
      if (String(url).indexOf('/assets/ui/') === 0) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      calls.push({ url, init });
      const status = statuses.shift() ?? 200;
      return Promise.resolve({ ok: status < 400, status, json: async () => ({ save: {} }) });
    },
  });
  hosted.window = hosted;
  hosted.globalThis = hosted;
  const hostedContext = vm.createContext(hosted);
  for (const [i, body] of scripts.entries()) {
    try {
      new vm.Script(body, { filename: `hosted-${i}.js` }).runInContext(hostedContext);
    } catch (error) {
      console.log(`  hosted script ${i}: THREW\n${(error as Error).stack}`);
      process.exit(1);
    }
  }

  const fire = (id: string, target?: Record<string, unknown>): void => {
    for (const fn of listeners.get(`${id}:click`) ?? []) {
      fn({ preventDefault: () => {}, stopPropagation: () => {}, target: target ?? { id } });
    }
  };
  const button = headRowChildren.find((el) => el.id === 'profileBtn');
  const panel = headRowChildren.find((el) => el.id === 'profilePanel');
  const titleStatus = headRowChildren.find((el) => el.id === 'titleStatus') as
    | { textContent: string }
    | undefined;
  const q = (id: string): Record<string, unknown> | null =>
    panel ? (panel.querySelector as (s: string) => Record<string, unknown> | null)(`#${id}`) : null;
  const value = (id: string): string => String(q(id)?.value ?? '');
  const shown = (id: string): string => String(q(id)?.textContent ?? '');
  const set = (id: string, next: string): void => {
    const el = q(id);
    if (el) el.value = next;
  };
  const isOpen = (): boolean =>
    Boolean(panel && (panel.classList as { contains: (c: string) => boolean }).contains('open'));
  const markup = (): string => (panel ? String(panel.innerHTML) : '');

  // On the heading's own line — the two children of #headRow, and neither of them on the
  // body, which is what "no longer a floating corner button" has to mean in the DOM.
  const placed =
    Boolean(button && panel && titleStatus) &&
    !children.some((el) => el.id === 'profileBtn' || el.id === 'profilePanel') &&
    String(button?.innerHTML ?? '').includes('修改存档信息') &&
    String(button?.innerHTML ?? '').includes('📝');
  if (!placed) process.exitCode = 1;
  console.log(
    `  trigger on the heading row: mounted=${Boolean(button)} panel=${Boolean(panel)} ` +
      `label="${String(button?.innerHTML ?? '')}" on body=${children.some((el) => el.id === 'profileBtn')} ${placed ? 'OK' : 'WRONG'}`,
  );

  const present =
    Boolean(button && panel) && listeners.has('profileBtn:click') && listeners.has('profilePanel:click');
  fire('profileBtn');
  const opened = isOpen();
  const prefill = ['profileTitle', 'profileMods', 'profileEndDate', 'profileSealedAt'].map(value);
  // 封档日期 sits directly under 结档日期, is prefilled with custom.sealedAt, and its
  // placeholder repeats that same value — the field never starts empty, because "the default
  // is the upload date" is exactly what the user asked to see in it. Section 13 covers the
  // other half: an unset custom.sealedAt prefills the upload day instead.
  const endLabelAt = markup().indexOf('<label>结档日期</label>');
  const sealLabelAt = markup().indexOf('<label>封档日期</label>');
  const sealedRow = sealLabelAt > 0 && sealLabelAt > endLabelAt;
  const sealedPlaceholder = markup().includes('placeholder="2026-09-19"');
  const prefilled =
    prefill[0] === '大汉 · 我的第一次统一' &&
    prefill[1] === '风云世纪两千年' &&
    prefill[2] === '1574.11.12' &&
    prefill[3] === '2026-09-19' &&
    sealedRow &&
    sealedPlaceholder &&
    value('profileTag0') === 'MNG' &&
    value('profilePlayer0') === '张三';
  if (!prefilled) process.exitCode = 1;
  console.log(
    `  panel prefill: title/mods/endDate/sealedAt=${JSON.stringify(prefill)} tag=${value('profileTag0')} ` +
      `player=${value('profilePlayer0')} sealBelowEnd=${sealedRow} placeholder=${sealedPlaceholder} ` +
      `${prefilled ? 'OK' : 'WRONG'}`,
  );

  // ---- requirement 4: the protagonist flag strip, immediately left of 📝 ----
  // The card's own block, in the heading row: one figure per protagonist, five to a page,
  // arrows only when there is a second page, and the artwork set following the 旗帜 button.
  // This record has one protagonist, so there is no arrow at all here; section 13 has seven.
  const stripEl = headRowChildren.find((el) => el.id === 'heroStrip');
  const stripHtml = (): string => String(stripEl?.innerHTML ?? '');
  const stripAt = (id: string): Record<string, unknown> | null =>
    stripEl ? (stripEl.querySelector as (s: string) => Record<string, unknown> | null)(`#${id}`) : null;
  const stripCap = (i: number): string => String(stripAt(`heroCap${i}`)?.textContent ?? '');
  const stripBtn = (id: string): string =>
    (new RegExp('<button[^>]*id="' + id + '"[^>]*>').exec(stripHtml()) ?? [''])[0];
  const stripPlaced =
    Boolean(stripEl) &&
    headRowChildren.indexOf(stripEl as Record<string, unknown>) ===
      headRowChildren.indexOf(button as Record<string, unknown>) - 1 &&
    (stripHtml().match(/class="heroFig"/g) ?? []).length === 1 &&
    // Every flag sits in its own wrapper, and a country that is not a colony carries no
    // block: the wrapper is what makes a colonial flag possible, the block is the colony.
    (stripHtml().match(/class="flagBox"/g) ?? []).length === 1 &&
    (stripHtml().match(/class="flagTint"/g) ?? []).length === 0 &&
    stripBtn('heroPrev') === '' &&
    stripBtn('heroNext') === '' &&
    stripCap(0) === '张三-明' &&
    String(stripAt('heroFlag0')?.src ?? '') === '/assets/flags/base/MNG.png';
  if (!stripPlaced) process.exitCode = 1;
  console.log(
    `  protagonist strip: mounted=${Boolean(stripEl)} leftOfButton=${
      headRowChildren.indexOf(stripEl as Record<string, unknown>) ===
      headRowChildren.indexOf(button as Record<string, unknown>) - 1
    } figures=${(stripHtml().match(/class="heroFig"/g) ?? []).length} boxes=${(stripHtml().match(/class="flagBox"/g) ?? []).length} ` +
      `blocks=${(stripHtml().match(/class="flagTint"/g) ?? []).length} arrows=${Boolean(stripBtn('heroPrev') || stripBtn('heroNext'))} ` +
      `caption="${stripCap(0)}" src="${String(stripAt('heroFlag0')?.src ?? '')}" ${stripPlaced ? 'OK' : 'WRONG'}`,
  );

  // One 旗帜 button for the page: it has to move the strip's artwork as well as the map's.
  fire('flagset');
  const stripFollows = String(stripAt('heroFlag0')?.src ?? '') === '/assets/flags/modded/MNG.png';
  fire('flagset');
  const stripRestored = String(stripAt('heroFlag0')?.src ?? '') === '/assets/flags/base/MNG.png';
  if (!stripFollows || !stripRestored) process.exitCode = 1;
  console.log(
    `  旗帜 button moves the strip: base -> modded=${stripFollows} -> base=${stripRestored} ` +
      `${stripFollows && stripRestored ? 'OK' : 'WRONG'}`,
  );

  // A flag with no artwork becomes the TAG block rather than a broken image. MNG is no
  // colonial nation, so it carries no right-half block and there is nothing else to ask
  // for: the figure turns over at once.
  const stripImg0 = stripAt('heroFlag0');
  if (stripImg0 && typeof stripImg0.onerror === 'function') (stripImg0.onerror as () => void)();
  const stripFallback =
    String(stripAt('heroFig0')?.innerHTML ?? '').includes('heroFallback') &&
    String(stripAt('heroFig0')?.innerHTML ?? '').includes('MNG');
  if (!stripFallback) process.exitCode = 1;
  console.log(
    `  a flag with no artwork becomes a TAG block: "${String(stripAt('heroFig0')?.innerHTML ?? '')}" ${stripFallback ? 'OK' : 'WRONG'}`,
  );
  fire('profileBtn');
  const closedAgain = !isOpen();
  fire('profileBtn');

  // ---- requirement 3: the TAG field offers the fifteen great powers -------------
  // The field is still a plain text input (manual typing is never taken away), and clicking
  // it opens the leaderboard's top fifteen under that row. Picking one fills the field and
  // puts the list away; the list is a class flip rather than a re-render, so the caret is
  // not torn out of the field the click landed in.
  const picker = q('profileTagList0') as
    | { classList: { contains: (c: string) => boolean } }
    | null;
  const listOpen = (): boolean => (picker ? picker.classList.contains('open') : false);
  const sixth = POWERS[5] ?? { tag: '', name: '' };
  const listHidden = picker !== null && !listOpen();
  fire('profilePanel', q('profileTag0') ?? { id: 'profileTag0' });
  const listShown = listOpen();
  const items = (markup().match(/id="profilePick0_\d+"/g) ?? []).length;
  const labelled = markup().includes('RUS-俄罗斯') && markup().includes('POR-葡萄牙');
  fire('profilePanel', { id: 'profilePick0_5' });
  const picked = value('profileTag0') === sixth.tag && !listOpen();
  // Typing still wins over the list: the field keeps whatever the user puts in it.
  set('profileTag0', 'mos');
  const manual = value('profileTag0') === 'mos';
  const pickerOk = listHidden && listShown && items === 15 && labelled && picked && manual;
  if (!pickerOk) process.exitCode = 1;
  console.log(
    `  TAG picker: hidden=${listHidden} -> open=${listShown}, ${items} entries, "TAG-国名" labels=${labelled}, ` +
      `pick -> "${sixth.tag}" (${sixth.name}) ${picked}, manual typing still works=${manual} ${pickerOk ? 'OK' : 'WRONG'}`,
  );

  // Remove the only protagonist, then add a fresh one: both are real DOM edits, so the
  // rendered markup is what proves the list reacted. A fresh row prefills the tag the save
  // already recorded as the player's (info.playerTag), which is the one-off bonus the task
  // asked for.
  fire('profilePanel', q('profileDel0') ?? { id: 'profileDel0' });
  const emptied = markup().includes('还没有主角国家') && !markup().includes('profileTag0');
  // With the last protagonist gone the strip leaves the heading row entirely — no block, no
  // arrows — which is what "没有设置主角国家就整块不显示" has to mean in the DOM.
  const stripGone = !headRowChildren.some((el) => el.id === 'heroStrip');
  fire('profilePanel', q('profileAdd') ?? { id: 'profileAdd' });
  const refilled = markup().includes('profileTag0');
  // Adding one back mounts it again, and a row with no player name captions the country alone.
  const stripBack =
    headRowChildren.filter((el) => el.id === 'heroStrip').length === 1 &&
    stripCap(0) === '明' &&
    String(stripAt('heroFlag0')?.src ?? '') === '/assets/flags/base/MNG.png';
  if (!stripGone || !stripBack) process.exitCode = 1;
  console.log(
    `  the strip follows the rows: removed with the last protagonist=${stripGone}, ` +
      `back after adding one=${stripBack} (caption "${stripCap(0)}") ${stripGone && stripBack ? 'OK' : 'WRONG'}`,
  );
  const prefilledTag = value('profileTag0') === 'MNG';
  if (!prefilledTag) process.exitCode = 1;
  set('profileTitle', '大汉');
  set('profileMods', '');
  set('profileSealedAt', '2026-09-20');
  set('profileTag0', 'mos');
  set('profilePlayer0', '李四');
  fire('profilePanel', q('profileSave') ?? { id: 'profileSave' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const sent = calls[0];
  const headers = (sent?.init?.headers ?? {}) as Record<string, string>;
  let sentBody: unknown = null;
  try {
    sentBody = JSON.parse(String(sent?.init?.body ?? ''));
  } catch {
    sentBody = null;
  }
  const expected = {
    custom: {
      title: '大汉',
      mods: '',
      endDate: '1574.11.12',
      sealedAt: '2026-09-20',
      protagonists: [{ tag: 'mos', player: '李四' }],
    },
  };
  const patchOk =
    calls.length === 1 &&
    sent?.url === '/api/saves/b6263f5baf54' &&
    sent?.init?.method === 'PATCH' &&
    headers['content-type'] === 'application/json' &&
    headers['x-upload-token'] === 'tok-123' &&
    JSON.stringify(sentBody) === JSON.stringify(expected);
  if (!patchOk) process.exitCode = 1;
  console.log(`  save -> ${String(sent?.init?.method)} ${String(sent?.url)} token=${headers['x-upload-token'] ?? '(none)'}`);
  console.log(`  body ${JSON.stringify(sentBody)}`);
  console.log(`  status after 200: "${shown('profileStatus')}" ${patchOk ? 'OK' : 'WRONG'}`);

  // The form and the heading are two readers of one state.title, so a save from the form
  // has to move the heading as well — otherwise the page shows one title and the input
  // another, which is exactly what the user asked never to see.
  const panelSync = titleText.textContent === '大汉';
  if (!panelSync) process.exitCode = 1;
  console.log(`  heading follows a form save: "${titleText.textContent}" ${panelSync ? 'OK' : 'WRONG'}`);

  // The summary line is the drawer's other reader: the 封档日期 just saved has to be on screen
  // without a reload, or the line and the field would show two different dates.
  const sealFact = factEls.find((el) => el.getAttribute('data-fact') === 'sealedAt') as
    | { textContent: string }
    | undefined;
  const summarySync = String(sealFact?.textContent ?? '') === '2026-09-20';
  if (!summarySync) process.exitCode = 1;
  console.log(
    `  summary follows a form save: 封档日期="${String(sealFact?.textContent ?? '')}" ` +
      `${summarySync ? 'OK' : 'WRONG'}`,
  );
  // A refused write is the one failure the user can act on, so it must not be silent.
  fire('profilePanel', q('profileSave') ?? { id: 'profileSave' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const refused = shown('profileStatus');
  const refusedOk = calls.length === 2 && /口令/.test(refused);
  if (!refusedOk) process.exitCode = 1;
  console.log(`  status after 401: "${refused}" ${refusedOk ? 'OK' : 'WRONG'}`);

  // ---- the heading is the second editor for the same title -------------------
  // Clicking the heading prompts, and the answer has to (a) go out as a one-field PATCH
  // of custom.title, (b) repaint the heading, (c) repaint the panel's 标题 input from the
  // same state.title, and (d) say that the catalogue card will follow. Anything less and
  // the two editors drift apart, which is the one thing the user asked to avoid.
  const body = (index: number): unknown => {
    try {
      return JSON.parse(String(calls[index]?.init?.body ?? ''));
    } catch {
      return null;
    }
  };
  const renameCall = (index: number, title: string): boolean =>
    calls[index]?.url === '/api/saves/b6263f5baf54' &&
    calls[index]?.init?.method === 'PATCH' &&
    (calls[index]?.init?.headers as Record<string, string>)['x-upload-token'] === 'tok-123' &&
    JSON.stringify(body(index)) === JSON.stringify({ custom: { title } });

  statuses.push(200);
  promptAnswers.push('大汉帝国');
  fire('titleText');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const renamed =
    calls.length === 3 &&
    renameCall(2, '大汉帝国') &&
    titleText.textContent === '大汉帝国' &&
    value('profileTitle') === '大汉帝国' &&
    /已保存/.test(String(titleStatus?.textContent ?? '')) &&
    /目录页/.test(String(titleStatus?.textContent ?? ''));
  if (!renamed) process.exitCode = 1;
  console.log(
    `  rename from the heading -> ${String(calls[2]?.init?.method)} ${String(calls[2]?.url)} ` +
      `body=${JSON.stringify(body(2))}`,
  );
  console.log(
    `  heading="${titleText.textContent}" panel title="${value('profileTitle')}" ` +
      `note="${titleStatus?.textContent ?? ''}" ${renamed ? 'OK' : 'WRONG'}`,
  );

  // An empty answer clears custom.title, so the heading falls back to the country name —
  // and the two editors still agree, because both read state.title. The panel input falls
  // back to the country name as well (then to the file name), never to something else.
  statuses.push(200);
  promptAnswers.push('');
  fire('titleText');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cleared =
    calls.length === 4 &&
    renameCall(3, '') &&
    titleText.textContent === headerTitle &&
    value('profileTitle') === headerTitle;
  if (!cleared) process.exitCode = 1;
  console.log(
    `  empty answer -> heading back to "${titleText.textContent}" (panel "${value('profileTitle')}") ` +
      `body=${JSON.stringify(body(3))} ${cleared ? 'OK' : 'WRONG'}`,
  );

  // Cancelling must not write anything at all.
  promptAnswers.push(null);
  fire('titleText');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cancelled = calls.length === 4 && titleText.textContent === headerTitle;
  if (!cancelled) process.exitCode = 1;
  console.log(`  prompt cancelled -> no extra PATCH (calls=${calls.length}) ${cancelled ? 'OK' : 'WRONG'}`);

  const ok =
    present &&
    placed &&
    opened &&
    prefilled &&
    stripPlaced &&
    stripFollows &&
    stripRestored &&
    stripFallback &&
    pickerOk &&
    closedAgain &&
    emptied &&
    stripGone &&
    refilled &&
    stripBack &&
    prefilledTag &&
    patchOk &&
    panelSync &&
    summarySync &&
    refusedOk &&
    renamed &&
    cleared &&
    cancelled;
  if (!ok) process.exitCode = 1;
  console.log(
    `  drawer: present=${present} inHeadingRow=${placed} opened=${opened} prefilled=${prefilled} toggles=${closedAgain}` +
      ` strip=${stripPlaced}/${stripFollows}/${stripRestored}/${stripFallback}/${stripGone}/${stripBack}` +
      ` picker=${pickerOk} delete=${emptied} add=${refilled} addPrefillsPlayerTag=${prefilledTag}` +
      ` formSync=${panelSync} summarySync=${summarySync} rename=${renamed} clear=${cleared} cancel=${cancelled} ` +
      `${ok ? 'OK' : 'WRONG'}`,
  );
}

// ------------- 13. the strip paginates, and 封档日期 defaults to the upload day -----
console.log('\n=== 13. protagonist strip paging and the 封档日期 default ===');
{
  // A second hosted page with its own heading row: seven protagonists (two pages of five)
  // and no custom.sealedAt at all. That is the pair of rules section 12 cannot reach — the
  // upload day standing in for an unset 封档日期, and the arrows that exist only when there is
  // a second page, disabled at the ends. The row is swapped in for the length of the run so
  // the two pages' strips can never be mistaken for one another.
  const row = makeEl('headRow');
  const previousRow = els.get('headRow');
  els.set('headRow', row);
  const second: Record<string, unknown> = Object.assign({}, sandbox, {
    VIEWER_META: {
      id: 'ffffffffffff',
      name: 'mp_多主角.eu4',
      // No custom.sealedAt: the drawer has to fall back to this day, in the field and in the
      // placeholder alike. The upload day is taken as UTC, the way the card takes it.
      uploadedAt: '2026-01-02T09:00:00.000Z',
      info: { version: '1.37.5.0', campaignDate: '1600.1.1', modCount: 2, playerTag: '' },
      custom: {
        protagonists: [
          { tag: 'RUS', player: '玩家A' },
          { tag: 'HAB', player: '' },
          { tag: 'FRA', player: 'F' },
          { tag: 'POL', player: 'P' },
          { tag: 'SWE', player: 'S' },
          { tag: 'TUR', player: 'T' },
          { tag: 'BRZ', player: '' },
        ],
      },
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ save: {} }) }),
  });
  second.window = second;
  second.globalThis = second;
  const secondContext = vm.createContext(second);
  for (const [i, body] of scripts.entries()) {
    try {
      new vm.Script(body, { filename: `second-${i}.js` }).runInContext(secondContext);
    } catch (error) {
      console.log(`  second hosted script ${i}: THREW\n${(error as Error).stack}`);
      process.exit(1);
    }
  }
  els.set('headRow', previousRow);

  const kids = row.appended as Array<Record<string, unknown>>;
  const strip = kids.find((el) => el.id === 'heroStrip');
  const panel2 = kids.find((el) => el.id === 'profilePanel');
  const inner = (): string => String(strip?.innerHTML ?? '');
  const at = (id: string): Record<string, unknown> | null =>
    strip ? (strip.querySelector as (s: string) => Record<string, unknown> | null)(`#${id}`) : null;
  const pit = (id: string): Record<string, unknown> | null =>
    panel2 ? (panel2.querySelector as (s: string) => Record<string, unknown> | null)(`#${id}`) : null;
  const figCount = (): number => (inner().match(/class="heroFig"/g) ?? []).length;
  const caption = (i: number): string => String(at(`heroCap${i}`)?.textContent ?? '');
  const imgSrc = (i: number): string => String(at(`heroFlag${i}`)?.src ?? '');
  /** The arrow's opening tag, so `disabled` is read from what a browser would receive. */
  const arrow = (id: string): string =>
    (new RegExp('<button[^>]*id="' + id + '"[^>]*>').exec(inner()) ?? [''])[0];
  const click = (id: string, target?: Record<string, unknown>): void => {
    for (const fn of listeners.get(`${id}:click`) ?? []) {
      fn({ preventDefault: () => {}, stopPropagation: () => {}, target: target ?? { id } });
    }
  };

  // The drawer's 封档日期 field, with nothing custom to show: it is prefilled with the upload
  // day rather than left empty, and the placeholder repeats that value.
  const drawerPrefill =
    String(pit('profileSealedAt')?.value ?? '') === '2026-01-02' &&
    String(panel2?.innerHTML ?? '').includes('placeholder="2026-01-02"');
  if (!drawerPrefill) process.exitCode = 1;
  console.log(
    `  封档日期 without a custom value: field="${String(pit('profileSealedAt')?.value ?? '')}" ` +
      `placeholder=${String(panel2?.innerHTML ?? '').includes('placeholder="2026-01-02"')} ` +
      `${drawerPrefill ? 'OK' : 'WRONG'}`,
  );

  // Page one: five figures, the left arrow disabled (there is nothing before it), the right
  // one live. The captions are 玩家名字-国家名字, and a row without a player name shows the
  // country alone instead of a bare hyphen.
  const pageOne =
    figCount() === 5 &&
    / disabled/.test(arrow('heroPrev')) &&
    arrow('heroNext') !== '' &&
    !/ disabled/.test(arrow('heroNext')) &&
    caption(0) === '玩家A-俄罗斯' &&
    caption(1) === '奥地利' &&
    imgSrc(0) === '/assets/flags/base/RUS.png';
  if (!pageOne) process.exitCode = 1;
  console.log(
    `  page 1: figures=${figCount()} prevDisabled=${/ disabled/.test(arrow('heroPrev'))} ` +
      `nextDisabled=${/ disabled/.test(arrow('heroNext'))} captions="${caption(0)}"/"${caption(1)}" ` +
      `src="${imgSrc(0)}" ${pageOne ? 'OK' : 'WRONG'}`,
  );

  click('heroStrip', { id: 'heroNext' });
  const pageTwo =
    figCount() === 2 &&
    !/ disabled/.test(arrow('heroPrev')) &&
    / disabled/.test(arrow('heroNext')) &&
    caption(0) === 'T-奥斯曼' &&
    caption(1) === '巴西';
  if (!pageTwo) process.exitCode = 1;
  console.log(
    `  page 2: figures=${figCount()} prevDisabled=${/ disabled/.test(arrow('heroPrev'))} ` +
      `nextDisabled=${/ disabled/.test(arrow('heroNext'))} captions="${caption(0)}"/"${caption(1)}" ` +
      `${pageTwo ? 'OK' : 'WRONG'}`,
  );

  // ---- a colonial nation is its mother country's flag plus its own colour ----
  // BRZ (Brazil) is POR's colony in this save, so the artwork is Portugal's and the right
  // half carries the colour the map gives Brazil. The colour is the frozen hash the build
  // side uses (`hslToRgb(h % 360, 0.6, 0.45)` after fmix32), pinned here as the hex
  // `tmp/colonial-preview.html` prints for the same tag — a different hue means the two
  // copies of the algorithm have drifted. The block belongs to the colony, so the second
  // figure has one and the first (TUR) has none.
  const blockOf = (i: number): string =>
    (new RegExp('<i class="flagTint" id="heroTint' + i + '"[^>]*style="background:(#[0-9a-f]{6})"').exec(inner()) ??
      [])[1] ?? '';
  /** Figure i's own wrapper, read from the markup the browser would receive. */
  const boxOf = (i: number): string =>
    (new RegExp('<span class="flagBox" id="heroBox' + i + '">').exec(inner()) ?? [''])[0];
  const blocksOfPage = (): number => (inner().match(/class="flagTint"/g) ?? []).length;
  const boxesOfPage = (): number => (inner().match(/class="flagBox"/g) ?? []).length;
  const colonialOk =
    imgSrc(1) === '/assets/flags/base/POR.png' &&
    blockOf(1) === '#372eb8' &&
    boxOf(1) !== '' &&
    blocksOfPage() === 1 &&
    boxesOfPage() === 2;
  if (!colonialOk) process.exitCode = 1;
  console.log(
    `  a colonial flag is its mother country's artwork plus a right-half block: ` +
      `BRZ -> ${imgSrc(1) || '(none)'} with ${blockOf(1) || '(no block)'} ` +
      `(boxes=${boxesOfPage()} blocks=${blocksOfPage()}) ${colonialOk ? 'OK' : 'WRONG'}`,
  );

  // The artwork switch moves the picture underneath and leaves the block alone: the block
  // colour is a property of the colony, not of the artwork set, and 原版/国家娘 must not
  // change it (nor add a second one).
  click('flagset');
  const moddedSrc = imgSrc(1);
  const switchedPic = moddedSrc === '/assets/flags/modded/POR.png';
  const switchedBlock = blockOf(1) === '#372eb8' && blocksOfPage() === 1;
  click('flagset');
  const restoredPic = imgSrc(1) === '/assets/flags/base/POR.png';
  const restoredBlock = blockOf(1) === '#372eb8' && blocksOfPage() === 1;
  const switchOk = switchedPic && switchedBlock && restoredPic && restoredBlock;
  if (!switchOk) process.exitCode = 1;
  console.log(
    `  旗帜 switch moves the artwork, not the block: modded=${moddedSrc} block=${blockOf(1)} ` +
      `-> back=${imgSrc(1)} ${switchOk ? 'OK' : 'WRONG'}`,
  );

  // The mother country's flag is the last thing there is to ask for, so a failure there is
  // the TAG block — never a broken image, and never a second round of guesses.
  const colonial = at('heroFlag1') as { onerror?: () => void; src?: string } | null;
  if (colonial && typeof colonial.onerror === 'function') colonial.onerror();
  if (colonial && typeof colonial.onerror === 'function') colonial.onerror();
  const tagBlock =
    String(at('heroFig1')?.innerHTML ?? '').includes('heroFallback') &&
    String(at('heroFig1')?.innerHTML ?? '').includes('BRZ');
  if (!tagBlock) process.exitCode = 1;
  console.log(`  a colonial flag with no artwork becomes the TAG block=${tagBlock} ${tagBlock ? 'OK' : 'WRONG'}`);

  click('heroStrip', { id: 'heroPrev' });
  const backToOne = figCount() === 5 && caption(0) === '玩家A-俄罗斯' && blocksOfPage() === 0;
  // One 旗帜 switch for the whole page, the strip included — the artwork set the user picks
  // is the one the heading shows, not a second copy of it.
  click('flagset');
  const modded = imgSrc(0) === '/assets/flags/modded/RUS.png';
  click('flagset');
  const restored = imgSrc(0) === '/assets/flags/base/RUS.png';
  if (!backToOne || !modded || !restored) process.exitCode = 1;
  console.log(
    `  paging back=${backToOne}, 旗帜 button moves the strip: modded=${modded} base=${restored} ` +
      `${backToOne && modded && restored ? 'OK' : 'WRONG'}`,
  );

  const ok =
    Boolean(strip) && drawerPrefill && pageOne && pageTwo && colonialOk && switchOk && tagBlock && backToOne && modded && restored;
  if (!ok) process.exitCode = 1;
  console.log(`  protagonist strip: ${ok ? 'OK' : 'WRONG'}`);
}

// ------------- 14. the province and country detail sheet ----------------------
console.log('\n=== 14. the province / country detail sheet ===');
{
  // ---- a data plane that carries the frozen detail keys --------------------
  // S1 packs the province/country detail tables into BOTH data planes, and the sheet is
  // written against that frozen schema — so this section runs a *patched* copy of the real
  // plane: the same replay and the same dictionaries, plus the detail keys with values this
  // test owns. That is the only way to assert the panel's content without asserting the
  // build's.
  const patched = JSON.parse(JSON.stringify(DATA)) as Record<string, unknown>;
  const cols = Math.ceil(DATA.w / 64);
  const sea = new Set<number>([...(DATA.waterSea as number[]), ...(DATA.waterLakes as number[])]);
  const ids = provinceIds as number[];
  /** The id the stub's synthetic raster holds in one 64x64 block. */
  const blockId = (bx: number, by: number): number => ids[((bx + by * cols) * 7) % ids.length] as number;
  /** The half-resolution id at one half-raster pixel — halfIds' own majority vote. */
  const idAtHalf = (sx: number, sy: number): number => {
    const full = (px: number, py: number): number => blockId(Math.floor(px / 64), Math.floor(py / 64));
    const a = full(2 * sx, 2 * sy);
    const b = full(2 * sx + 1, 2 * sy);
    const c = full(2 * sx, 2 * sy + 1);
    const d = full(2 * sx + 1, 2 * sy + 1);
    return a === b || a === c || a === d ? a : b === c || b === d ? b : a;
  };
  const land = (id: number): boolean => id > 0 && !sea.has(id);
  const blockRows = Math.floor(DATA.h / 64);
  const scan = (wanted: (id: number) => boolean): { bx: number; by: number; id: number } => {
    for (let by = 0; by < blockRows; by += 1) {
      for (let bx = 0; bx < cols; bx += 1) {
        const id = blockId(bx, by);
        if (wanted(id)) return { bx, by, id };
      }
    }
    throw new Error('section 14: no matching block in the synthetic raster');
  };
  // A is the first land province the raster holds (province 1, Stockholm, for this save).
  // B is a *far* one — at least eight columns away — because the drag test below has to move
  // the pointer further than the 15px click threshold while still coming up over a different,
  // known province. It also has to be *owned*: the country drawer is opened through the
  // province's own 转到国家, which is disabled for a province nobody holds.
  const ownerField = (DATA.provinceFields as string[]).indexOf('owner');
  const ownerAtStart = new Map<number, number>();
  for (const row of DATA.provinceInit as number[][]) {
    if (row[1] === ownerField) ownerAtStart.set(row[0], row[2]);
  }
  for (const row of DATA.provinceEvents as number[][]) {
    if (row[0] > (DATA.months as number[])[0]) break;
    if (row[2] === ownerField) ownerAtStart.set(row[1], row[3]);
  }
  const owned = (id: number): boolean => (ownerAtStart.get(id) ?? -1) > 0;
  const A = scan(land);
  let B: { bx: number; by: number; id: number } | null = null;
  let bestDistance = 0;
  for (let by = 0; by < blockRows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      const id = blockId(bx, by);
      if (!land(id) || !owned(id) || id === A.id) continue;
      const distance = Math.abs(bx - A.bx) + Math.abs(by - A.by);
      if (distance > bestDistance) {
        bestDistance = distance;
        B = { bx, by, id };
      }
    }
  }
  if (!B) throw new Error('section 14: no far owned land province in the synthetic raster');
  const water = scan((id) => id > 0 && sea.has(id));

  // The map's CSS geometry, straight off the stub: the client divides by these numbers, so
  // a click the test predicts on paper lands on the province the client predicts too.
  const mapEl14 = els.get('map') as { clientWidth: number; clientHeight: number };
  const halfW = DATA.w >> 1;
  const halfH = DATA.h >> 1;
  const cssOfBlock = (bx: number, by: number): { x: number; y: number } => ({
    x: ((bx * 32 + 16) * mapEl14.clientWidth) / halfW,
    y: ((by * 32 + 16) * mapEl14.clientHeight) / halfH,
  });
  const idAtCss = (x: number, y: number): number =>
    idAtHalf(Math.floor((x * halfW) / mapEl14.clientWidth), Math.floor((y * halfH) / mapEl14.clientHeight));

  const nameList = patched.provinceNames as string[];
  const idList = patched.provinceIds as number[];
  const nameOf = (id: number): string => String(nameList[idList.indexOf(id)] ?? `省 ${id}`);
  const tags = patched.tags as string[];
  const tagIdxOf = (tag: string): number => tags.indexOf(tag);

  // ---- the province tables (the S1 schema frozen in 省份国家界面阶段任务书.md §2) ----
  const maxId = Math.max(A.id, B.id, water.id) + 4;
  const terrainById = new Array<number>(maxId).fill(-1);
  terrainById[A.id] = 0;
  terrainById[B.id] = 1;
  const areaById = new Array<number>(maxId).fill(-1);
  areaById[A.id] = 0;
  const devastation = new Array<number>(maxId).fill(0);
  devastation[A.id] = 4.5;
  const tradeCompany = new Array<number>(maxId).fill(0);
  tradeCompany[A.id] = 1;
  const claimTag = Math.max(0, tagIdxOf('POL'));
  const detailTag = Math.max(0, tagIdxOf('DAN'));

  patched.provinceBuildings = {
    dict: ['marketplace', 'workshop', 'temple', 'shipyard', 'university'],
    names: ['市场', '工场', '神庙', '船坞', '大学'],
    rows: [[A.id, 0, 1, 2, 3]],
    builders: [[A.id, 'SWE', 'SWE', 'SWE', 'SWE']],
  };
  patched.provinceTerrain = { dict: ['grasslands', 'forest'], names: ['草原', '森林'], byId: terrainById };
  patched.provinceGreatProjects = { dict: ['kronborg'], names: ['克伦堡'], rows: [[A.id, 0]] };
  patched.provinceCores = { dict: [], rows: [[A.id, claimTag]] };
  patched.provinceClaims = {
    dict: [],
    // A tag with no rename in this save: a claim by ENG would resolve to GBR (the save's own
    // changed_tag ledger), and the flag assertion below would be looking for the wrong name.
    rows: [[A.id, Math.max(0, tagIdxOf('FRA')), Math.max(0, tagIdxOf('PER'))]],
  };
  patched.provinceLatentTradeGoods = { dict: ['grain'], rows: [[A.id, 0]] };
  patched.provinceImprove = { dict: [], rows: [[A.id, detailTag, 3]] };
  patched.provinceDevastation = devastation;
  patched.provinceTradeCompany = tradeCompany;
  patched.provinceArea = { dict: ['stockholm_area'], names: ['斯德哥尔摩地区'], byId: areaById };
  patched.areaDetail = {
    '0': {
      states: [{ tagIdx: detailTag, prosperity: 12.5 }],
      investments: [{ tagIdx: detailTag, icons: ['trade_company_1'] }],
    },
  };

  // ---- the country table, for every tag -----------------------------------
  // The country drawer is opened through a province's own 拥有者, and which tag that is
  // depends on the replay — so every tag carries the same record and the assertions are on
  // the values, not on which country they belong to.
  const countryDetail: Record<string, unknown> = {};
  tags.forEach((tag, i) => {
    countryDetail[tag] = {
      powers: [400 + i, 300 + i, 200 + i],
      treasury: 1234, debt: 12, inflation: 2.7,
      prestige: 84, stability: 1, powerProjection: 42, innovativeness: 3, corruption: 1.17,
      governmentStrengthKind: 'legitimacy', governmentStrength: 89,
      government: 'russian_monarchy', governmentRank: 3, governmentReforms: ['tsardom'],
      development: 3000, rawDevelopment: 2500, autonomyPercent: 12.5,
      cities: 373, overextension: 0, religiousUnity: 88, absolutism: null,
      mercantilism: 100, splendor: 500, tech: [12, 13, 13],
      envoys: { merchants: 3, colonists: 1, diplomats: 2, missionaries: 1 },
      religion: 'orthodox', primaryCulture: 'russian', countryId: 1000,
      army: [200, 60, 40, 10], navy: [20, 30, 5, 8],
      manpower: 97000, reinforce: 1200, maxManpower: 150000,
      landMorale: 5.2, navalMorale: 4.1, professionalism: 0.42,
      armyTradition: 65, navyTradition: 30,
      ideas: [{ group: 'defensive_ideas', unlocked: 4, total: 7 }],
      monarch: {
        name: '伊凡四世', dynasty: '留里克', adm: 4, dip: 3, mil: 5, age: 44,
        culture: 'russian', religion: 'orthodox', inaugurated: '1533.12.4', personalities: ['严格要求'],
      },
      rulers: [
        { name: '伊凡四世', start: '1533.12.4', end: '', months: 492, personalities: ['严格要求'], adm: 4, dip: 3, mil: 5 },
      ],
      failedHeirs: [{ name: '德米特里', birth: '1552.10.1', personalities: [], adm: 2, dip: 2, mil: 2 }],
      leaders: [
        { name: '彼得·舒伊斯基', kind: 'general', active: true, activation: '1560.3.1', fire: 3, shock: 4, maneuver: 2, siege: 1 },
      ],
      bestGeneral: { name: '彼得·舒伊斯基', fire: 3, shock: 4, maneuver: 2, siege: 1 },
      bestAdmiral: null,
      religionDev: { orthodox: 900 },
      cultureStats: [
        { culture: 'russian', group: 'east_slavic', provinces: 300, dev: 2000, statedProvinces: 200, statedDev: 1500 },
      ],
      rivals: ['FRA', 'ENG', 'PER'], allies: ['POL'], subjects: ['RIG', 'VOL', 'SME'],
      atWar: ['PER', 'ENG'], overlord: '', colonialParent: '',
      // ---- wave 2 (建筑 / 州 / 阶级 / 顾问）----
      buildingCount: [
        { building: 'marketplace', provinces: 373 },
        { building: 'temple', provinces: 200 },
      ],
      states: [
        { area: 'stockholm_area', name: '斯德哥尔摩地区', dev: 42, capitalState: true, prosperity: 55, prosperityMode: 'growing', stateHouse: true },
      ],
      estates: [
        {
          kind: 'burghers', loyalty: 62.5, territory: 18.2, agendas: 2,
          privileges: [{ name: '城镇特权', since: '1450.1.1' }],
          influences: [{ name: '贸易实力', value: '+10%', expires: '1500.1.1' }],
        },
      ],
      crownland: 21.4,
      // ---- wave 3 (财政 / 点数）----
      budget: [
        { period: 'lastMonth', income: [1000, 500, 0], expense: [200, 0, 300] },
        { period: 'ytd', income: [12000, 6000, 0], expense: [2400, 0, 3600] },
        { period: 'lastYear', income: [9000, 4000, 0], expense: [1800, 0, 2700] },
        { period: 'total', income: [12000, 6000, 0], expense: [2400, 0, 3600] },
      ],
      manaSpent: { adm: [400, 300, 0], dip: [0, 250, 100], mil: [900, 0, 0] },
      // One name is a plane key (so the test proves the name table is read), one is literal.
      advisors: [
        { id: 'philosopher', name: 'Beria', date: '1450.3.2' },
        { id: 'statesman', name: '孔子', date: '1460.7.9' },
      ],
      history: [{ date: '1552.10.2', ordinal: 696, kind: 'conquest', text: '攻占喀山', tag: 'RUS' }],
    };
  });
  // FRA is the country the fake leaderboard row opens, so it carries the "empty list is a fact"
  // cases (无阶级 / 没有名臣顾问) and the wave-3 fallback: no ledger and no mana breakdown, which
  // must read 数据待补 rather than borrow another country's subjects.
  countryDetail.FRA = Object.assign({}, countryDetail.FRA, {
    estates: [], advisors: [], crownland: 0, budget: undefined, manaSpent: undefined,
  });
  patched.countryDetail = countryDetail;
  // The slot enumeration, exactly the shape S2 publishes (index/key/name), so the renderers can be
  // asserted without guessing a position: a slot index with no name prints no row at all.
  patched.ledgerSlots = {
    income: {
      slots: [
        { index: 0, key: 'taxation', name: '税收' },
        { index: 1, key: 'production', name: '生产' },
        { index: 2, key: 'trade', name: '贸易' },
      ],
    },
    expense: {
      slots: [
        { index: 0, key: 'advisor_maintenance', name: '顾问维护' },
        { index: 1, key: 'interest', name: '利息' },
        { index: 2, key: 'army_maintenance', name: '陆军维护费' },
      ],
    },
  };
  patched.manaSlots = {
    slots: [
      { index: 0, key: 'buy_idea', name: '购买理念' },
      { index: 1, key: 'advance_tech', name: '提升科技' },
      { index: 2, key: 'boost_stab', name: '提升稳定度' },
    ],
  };
  // The *actual* trade good is not in the frozen schema (only the latent one is), so the
  // sheet has to write that down rather than invent one.
  delete patched.provinceTradeGoods;

  // ---- run the client against the patched plane ---------------------------
  // Fresh elements and fresh listener registries: the sheet's controls are ids the earlier
  // sections used for other purposes, and a stale listener firing on a new element would
  // make every assertion below meaningless. Section 14 is last, so nothing needs them back.
  const freshEls = new Map<string, Record<string, unknown>>();
  const freshBody = makeEl('body');
  const freshHead = makeEl('head');
  for (const id of els.keys()) freshEls.set(id, makeEl(id));
  freshEls.set('body', freshBody);
  freshEls.set('head', freshHead);
  // viewer.html declares the sheet hidden, so the stub starts it hidden too: "it is still
  // hidden before anything is clicked" then actually means something.
  (freshEls.get('detail') as Record<string, unknown>).hidden = true;
  listeners.clear();
  windowListeners.clear();
  paintCalls.clear();
  lastByCanvas.clear();
  putImageDataCalls = 0;
  lastImage = null;

  const doc14 = Object.assign({}, sandbox.document, {
    body: freshBody,
    head: freshHead,
    documentElement: makeEl('html'),
    getElementById: (id: string) => freshEls.get(id) ?? null,
  });
  const sandbox14: Record<string, unknown> = Object.assign({}, sandbox, {
    document: doc14,
    // S2's key -> 中文名 table, which the viewer fetches to fill the two groups the data
    // plane does not name (religions, government reforms). Two entries are enough to prove
    // the supplement is read and applied.
    fetch: () =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          religions: { orthodox: '东正教', catholic: '天主教' },
          governmentReforms: { tsardom: '沙皇制' },
        }),
      }),
  });
  // `Object.assign` copied the first context's window/globalThis aliases, which point at the
  // *first* sandbox: without this the page would call the first context's mountPageTheme and
  // write its CSS variables into the first context's document. Exactly the trap sections 12
  // and 13 avoid by re-pointing the alias after assigning.
  sandbox14.window = sandbox14;
  sandbox14.globalThis = sandbox14;

  const dataIndex = scripts.findIndex((body) =>
    body.split('\n').some((line) => line.startsWith('const DATA = ')),
  );
  const patchedScripts = scripts.slice();
  patchedScripts[dataIndex] = (scripts[dataIndex] as string).replace(
    /^const DATA = .*$/m,
    `const DATA = ${JSON.stringify(patched)};`,
  );

  const context14 = vm.createContext(sandbox14);
  let loadError: Error | null = null;
  for (const [i, body] of patchedScripts.entries()) {
    try {
      new vm.Script(body, { filename: `detail-${i}.js` }).runInContext(context14);
    } catch (error) {
      loadError = error as Error;
      break;
    }
  }
  const ok: boolean[] = [];
  const check = (pass: boolean, label: string): void => {
    ok.push(pass);
    if (!pass) process.exitCode = 1;
    console.log(`  ${pass ? 'OK  ' : 'WRONG'} ${label}`);
  };
  check(!loadError, '1) every script still executes against the frozen detail schema');
  if (loadError) {
    console.log(loadError.stack);
    process.exit(1);
  }
  // S2's key -> 中文名 table arrives through a promise; let it land before asserting on any
  // name, or the sheet would still be showing the raw keys.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const fire = (key: string, event: Record<string, unknown> = {}): void => {
    for (const fn of listeners.get(key) ?? []) {
      fn(Object.assign({ preventDefault: () => {}, stopPropagation: () => {} }, event));
    }
  };
  const detail = freshEls.get('detail') as Record<string, unknown>;
  const detailBody14 = freshEls.get('detailBody') as Record<string, unknown>;
  const detailTitle = freshEls.get('detailTitle') as { textContent: string };
  const detailBack = freshEls.get('detailBack') as { textContent: string };
  const mapCanvas = freshEls.get('map') as Record<string, unknown>;
  const hoverCanvas = freshEls.get('hover') as Record<string, unknown>;
  const sliderValue = (): string => String((freshEls.get('slider') as { value: string }).value);
  const markup = (): string => String(detailBody14.innerHTML);
  const named = (el: Record<string, unknown>): Map<string, Record<string, unknown>> =>
    el.named as Map<string, Record<string, unknown>>;
  /**
   * Every flag the sheet mounted, found through the slots the client appended them into.
   * The box holds only the artwork; the name is a sibling inside the slot.
   */
  const panelFlags = (): Array<{ img: Record<string, unknown>; label: Record<string, unknown>; box: Record<string, unknown> }> => {
    const out: Array<{ img: Record<string, unknown>; label: Record<string, unknown>; box: Record<string, unknown> }> = [];
    for (const host of named(detailBody14).values()) {
      const kids = (host.appended as Array<Record<string, unknown>> | undefined) ?? [];
      const label = kids.find((kid) => kid.className === 'dName') as Record<string, unknown>;
      for (const kid of kids) {
         if (kid.className !== 'detailFlagBox') continue;
        const boxKids = (kid.appended as Array<Record<string, unknown>> | undefined) ?? [];
        const img = boxKids.find((boxKid) => boxKid.className === 'detailFlag') as Record<string, unknown> | undefined;
        if (img) out.push({ img, label, box: kid });
      }
    }
    return out;
  };
  /** Every icon cell the sheet mounted: key, Chinese caption and the artwork URL. */
  const panelIcons = (): Array<{ key: string; cap: string; src: string }> => {
    const out: Array<{ key: string; cap: string; src: string }> = [];
    for (const host of named(detailBody14).values()) {
      const kids = (host.appended as Array<Record<string, unknown>> | undefined) ?? [];
      const cap = kids.find((kid) => kid.className === 'dCap') as { textContent?: string } | undefined;
      for (const kid of kids) {
        if (kid.className !== 'dIcon') continue;
        out.push({
          key: String(kid.getAttribute('data-key') ?? ''),
          cap: String(cap?.textContent ?? ''),
          src: String(kid.src ?? ''),
        });
      }
    }
    return out;
  };
  const hoverPaints = (): number => paintCalls.get('hover') ?? 0;
  // The map listens for Pointer Events since C3; a mouse is one of them, and these two
  // helpers are the same click this section has always made (第四对话任务书.md §4.3 C3).
  const mousePointer = { pointerType: 'mouse', pointerId: 1, isPrimary: true };
  const clickAt = (x: number, y: number): void => {
    fire('map:pointerdown', { ...mousePointer, button: 0, clientX: x, clientY: y });
    fire('map:pointerup', { ...mousePointer, button: 0, clientX: x, clientY: y });
  };
  const a = cssOfBlock(A.bx, A.by);
  const b = cssOfBlock(B.bx, B.by);
  const w = cssOfBlock(water.bx, water.by);
  const titleA = `${A.id}: ${nameOf(A.id)}`;
  const titleB = `${B.id}: ${nameOf(B.id)}`;

  // ---- 2) the sheet starts closed ----------------------------------------
  check(
    detail.hidden === true && hoverCanvas.width === mapCanvas.width && hoverCanvas.height === mapCanvas.height,
    '2) the sheet starts closed and #hover carries the same raster as #map',
  );

  // ---- 3) hover paints the province, and only it -------------------------
  const before = hoverPaints();
  fire('map:pointermove', { ...mousePointer, clientX: a.x, clientY: a.y });
  const frame = lastByCanvas.get('hover') as { data: Uint8ClampedArray } | undefined;
  const halfX = Math.floor((a.x * halfW) / mapEl14.clientWidth);
  const halfY = Math.floor((a.y * halfH) / mapEl14.clientHeight);
  const hitAt = (halfY * halfW + halfX) * 4;
  const farY = halfY + 40 < halfH ? halfY + 40 : halfY - 40;
  const farAt = (farY * halfW + halfX) * 4;
  check(
    hoverPaints() === before + 1 &&
      Boolean(frame) &&
      (frame?.data[hitAt + 3] as number) > 0 &&
      (frame?.data[hitAt] as number) > 200 &&
      (frame?.data[farAt + 3] as number) === 0,
    `3) hovering land highlights exactly that province (putImageData ${before}->${hoverPaints()}, ` +
      `alpha ${frame?.data[hitAt + 3]}, elsewhere ${frame?.data[farAt + 3]})`,
  );

  const beforeWater = hoverPaints();
  fire('map:pointermove', { ...mousePointer, clientX: w.x, clientY: w.y });
  check(
    hoverPaints() === beforeWater,
    '4) hovering the ocean neither clears nor paints — the user asked for nothing to happen there',
  );

  // ---- 5) a click opens the province sheet ------------------------------
  clickAt(a.x, a.y);
  check(
    detail.hidden === false && detailTitle.textContent === titleA,
    `5) clicking a province opens the sheet titled "${detailTitle.textContent}"`,
  );

  const body5 = markup();
  // The icon and flag cells are *appended* elements, not markup, so they are read back
  // through the slots they were mounted into rather than from the innerHTML string.
  const icons5 = panelIcons();
  const flags5 = panelFlags();
  check(
    body5.includes('4 座') &&
      ['marketplace', 'workshop', 'temple', 'shipyard'].every((key) =>
        icons5.some((icon) => icon.key === key),
      ) &&
      ['市场', '工场', '神庙', '船坞'].every((name) => icons5.some((icon) => icon.cap === name)),
    '6) the building grid lists the province exactly four buildings, each captioned in Chinese',
  );
  const devLine = String(named(detailBody14).get('dDev')?.textContent ?? '');
  check(
    icons5.some((icon) => icon.key === 'grasslands' && icon.cap === '草原') &&
      icons5.some((icon) => icon.key === 'kronborg' && icon.cap === '克伦堡') &&
      String(named(detailBody14).get('dRelName')?.textContent ?? '') === '天主教' &&
      /^\d+ \/ \d+ \/ \d+（合计 \d+）$/.test(devLine) &&
      body5.includes('斯德哥尔摩地区') &&
      body5.includes('4.5%'),
    '7) terrain, great projects, the area, the devastation, the religion name and the 发展度 line are on the sheet',
  );
  check(
    /贸易品<\/span><span class="v">—/.test(body5) && body5.includes('潜在贸易品') && body5.includes('grain'),
    '8) a key the test plane deliberately drops is written down as —, never faked (贸易品 absent, 潜在贸易品 present)',
  );
  check(
    body5.includes('是') && body5.includes('属于贸易公司'),
    '9) the trade-company flag is read from provinceTradeCompany',
  );
  check(
    body5.includes('繁荣度') &&
      body5.includes('12.5') &&
      body5.includes('贸易公司投资') &&
      body5.includes('trade_company_1') &&
      body5.includes('扩建基础设施') &&
      body5.includes('省份历史'),
    '10) all four grouped tables render (state / trade-company investment / infrastructure / history)',
  );
  check(
    body5.includes('宣称') &&
      body5.includes('核心') &&
      body5.includes('转到国家') &&
      (body5.match(/id="dJump\d+"/g) ?? []).length > 0 &&
      body5.includes('⏱'),
    '11) cores, claims, 转到国家 and the per-entry ⏱ buttons are on the sheet',
  );

  const flags5After = panelFlags();
  check(
    flags5After.length >= 3 && String(flags5After[0]?.img.src ?? '').startsWith('/assets/flags/base/'),
    `12) the sheet mounts real flag artwork (${flags5After.length} flags, first "${String(flags5After[0]?.img.src ?? '')}")`,
  );

  // ---- 13) a drag is not a click ----------------------------------------
  // Down on A, up on B: a pan across two known, different land provinces. Nothing may
  // change, and the pointer really did come up over another province, so a drag read as a
  // click would fail this check rather than pass it by accident. The baseline is taken
  // *after* the click that opened the sheet, because opening it highlights the selected
  // province and that is a paint of its own.
  const hoverBeforeDrag = hoverPaints();
  fire('map:pointerdown', { ...mousePointer, button: 0, clientX: a.x, clientY: a.y });
  fire('map:pointermove', { ...mousePointer, button: 0, clientX: b.x, clientY: b.y });
  const hoverWhileDragging = hoverPaints();
  fire('map:pointerup', { ...mousePointer, button: 0, clientX: b.x, clientY: b.y });
  check(
    detailTitle.textContent === titleA && detail.hidden === false && hoverWhileDragging === hoverBeforeDrag,
    `13) a drag changes nothing and does not update the highlight (still "${detailTitle.textContent}")`,
  );

  // ---- 14) 转到国家 opens the country drawer -----------------------------
  const goto = named(detailBody14).get('detailGotoCountry');
  if (goto) fire('detailBody:click', { target: goto });
  check(
    detail.classList.contains('country') === true &&
      /（[A-Z0-9]{3}）$/.test(detailTitle.textContent) &&
      detailBack.textContent.includes(nameOf(A.id)),
    `14) 转到国家 opens the country drawer "${detailTitle.textContent}" with 返回 to "${detailBack.textContent}"`,
  );

  const pane = markup();
  check(
    pane.includes('84') &&
      pane.includes('89') &&
      pane.includes('100') &&
      pane.includes('65') &&
      pane.includes('30') &&
      pane.includes('2.7%') &&
      pane.includes('12 / 13 / 13') &&
      pane.includes('russian_monarchy'),
    '15) 总览 prints the packed scalars (威望 84 / 正统 89 / 重商 100 / 传统 65·30 / 通胀 2.7% / 科技 12-13-13 / 政体)',
  );
  check(
    pane.includes('专制主义') && pane.includes('存档未记录'),
    '16) 专制主义 shows — and says the save does not record it',
  );
  check(
    pane.includes('宿敌') &&
      pane.includes('盟友') &&
      pane.includes('附属国') &&
      pane.includes('正在交战') &&
      !pane.includes('宗主') &&
      !pane.includes('母国'),
    '17) empty relation rows are left out entirely rather than printed blank',
  );
  check(
    (pane.match(/id="dTab-/g) ?? []).length === 13 && (pane.match(/disabled/g) ?? []).length === 0,
    "18) the tab bar carries pdx-tools' thirteen tabs, and with wave 3 landed none of them is parked",
  );
  // The idea group prints with its Chinese name now, so the assertion resolves that name from
  // the plane rather than hard-coding either the key or a translation.
  const defensiveIdeas = ((DATA as { uiNames?: { ideaGroups?: Record<string, string> } }).uiNames?.ideaGroups ?? {}).defensive_ideas ?? '';
  check(
    pane.includes('伊凡四世') && pane.includes('留里克') && defensiveIdeas !== '' && pane.includes(defensiveIdeas),
    '19) the monarch card and the idea pips are on 总览 (idea group = ' + defensiveIdeas + ')',
  );

  // ---- 20) the other five wave-1 tabs -----------------------------------
  const tabAt = (tab: string): Record<string, unknown> =>
    named(detailBody14).get(`dTab-${tab}`) as Record<string, unknown>;
  fire('detailBody:click', { target: tabAt('history') });
  check(markup().includes('攻占喀山') && markup().includes('1552.10.2'), '20) 历史 lists the packed history flow');
  fire('detailBody:click', { target: tabAt('rulers') });
  check(markup().includes('伊凡四世') && markup().includes('492'), '21) 君主 lists the rulers with their reign length');
  fire('detailBody:click', { target: tabAt('leaders') });
  check(markup().includes('彼得·舒伊斯基') && markup().includes('将军'), '22) 将领 lists the leaders and localises their kind');
  fire('detailBody:click', { target: tabAt('culture') });
  // Culture names come from the plane's index-aligned table, so a key like 'russian' is no
  // longer printed: the assertion resolves the name exactly as the panel does.
  const cultures = (DATA as { cultures?: string[] }).cultures ?? [];
  const russianCulture = ((DATA as { cultureNames?: string[] }).cultureNames ?? [])[cultures.indexOf('russian')] ?? '';
  check(
    markup().includes('east_slavic') && russianCulture !== '' && markup().includes(russianCulture),
    '23) 文化 lists the packed culture stats with the plane Chinese names (russian = ' + russianCulture + ')',
  );
  fire('detailBody:click', { target: tabAt('religion') });
  check(
    markup().includes('东正教') && markup().includes('900'),
    '24) 宗教 lists the packed religion breakdown, with names from S2\'s key -> 中文名 table',
  );
  fire('detailBody:click', { target: tabAt('general') });

  // ---- 25) 返回 goes back, and a flag is a way into its country ----------
  fire('detailBack:click');
  const onProvinceAgain = detail.classList.contains('country') === false && detailTitle.textContent === titleA;
  const claimFlag = panelFlags().find((flag) => String(flag.img.getAttribute('data-tag')) === 'FRA');
  if (claimFlag) fire('detailBody:click', { target: claimFlag.img });
  check(
    onProvinceAgain && detail.classList.contains('country') === true && detailBack.textContent.includes(nameOf(A.id)),
    "25) 返回 returns to the province, and a flag in it opens that country (pdx-tools' one-action entry)",
  );

  // ---- 26) the timeline jumps, and jumps back ---------------------------
  // The frame containing a date, not the frame *equal* to it: history is dated to the day
  // while the timeline is monthly, which is why an exact-match lookup would find nothing.
  const monthIndexOf = (ord: number): number => {
    const months = DATA.months as number[];
    if (!isFinite(ord) || ord < months[0]) return -1;
    let lo = 0;
    let hi = months.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (months[mid] <= ord) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };
  fire('detailBack:click');
  let jump: Record<string, unknown> | undefined;
  let jumpIndex = -1;
  for (let i = 0; i < 40 && jumpIndex < 0; i += 1) {
    const candidate = named(detailBody14).get(`dJump${i}`);
    if (!candidate) break;
    const at = monthIndexOf(Number(candidate.getAttribute('data-ord')));
    if (at >= 0 && at !== Number(sliderValue())) {
      jump = candidate;
      jumpIndex = at;
    }
  }
  const beforeJump = sliderValue();
  if (jump) fire('detailBody:click', { target: jump });
  const jumped = sliderValue();
  if (jump) fire('detailBody:click', { target: jump });
  check(
    jumpIndex >= 0 && jumped === String(jumpIndex) && sliderValue() === beforeJump,
    `26) ⏱ jumps the map to that day (${beforeJump} -> ${jumped}) and returns on a second press`,
  );

  // ---- 27) ocean closes the sheet outright ------------------------------
  clickAt(w.x, w.y);
  check(detail.hidden === true, '27) clicking the ocean closes the sheet outright, without routing through the province panel');

  // ---- 28) another province, and the country drawer follows -------------
  clickAt(b.x, b.y);
  check(
    detail.hidden === false && detailTitle.textContent === titleB,
    `28) another province opens its own sheet ("${detailTitle.textContent}")`,
  );
  const gotoB = named(detailBody14).get('detailGotoCountry');
  if (gotoB) fire('detailBody:click', { target: gotoB });
  const openedFromB = detail.classList.contains('country') === true;
  clickAt(a.x, a.y);
  // In the country state a click on a province re-selects the *country* with the new province
  // as its back target — the frozen state machine's own rule (第三对话任务书.md §1.7), not a
  // bug: the drawer stays open and 返回 follows the pointer.
  check(
    openedFromB && detail.classList.contains('country') === true && detailBack.textContent.includes(nameOf(A.id)),
    `29) clicking a province while the country drawer is open re-aims it at that province ("${detailBack.textContent}")`,
  );
  clickAt(b.x, b.y);
  check(
    detail.classList.contains('country') === true && detailBack.textContent.includes(nameOf(B.id)),
    `30) clicking another province re-aims the open drawer again ("${detailBack.textContent}")`,
  );

  // ---- 31) the great-power table is the other way in --------------------
  const fakeRow = {
    tagName: 'TR',
    querySelector: (selector: string) => (selector === 'img.flag' ? { getAttribute: () => 'FRA' } : null),
  };
  fire('leaderBody:click', { target: { tagName: 'TD', parentNode: fakeRow } });
  check(
    detailTitle.textContent.includes('（FRA）'),
    `31) a great-power row opens that country ("${detailTitle.textContent}")`,
  );

  // ---- 32) full screen keeps the toolbar -------------------------------
  const player14 = freshEls.get('player') as Record<string, unknown>;
  fire('mapFull:click');
  const entered =
    player14.classList.contains('screen') === true &&
    freshBody.classList.contains('screen') === true &&
    String((freshEls.get('mapFull') as { textContent: string }).textContent).includes('退出全屏');
  fire('mapFull:click');
  const left = player14.classList.contains('screen') === false && freshBody.classList.contains('screen') === false;
  fire('mapFull:click');
  for (const handler of windowListeners.get('keydown') ?? []) handler({ key: 'Escape' });
  check(
    entered && left && player14.classList.contains('screen') === false && Boolean(freshEls.get('play')),
    '32) ⛶ 全屏 toggles .player.screen with the toolbar still mounted, and ESC leaves it',
  );

  // ---- 33) the 面板 slider drives --panel-opacity ----------------------
  const themePanels = (freshBody.appended as Array<Record<string, unknown>>).filter((el) => el.id === 'pageThemePanel');
  const themePanel = themePanels[themePanels.length - 1];
  const opacityRange = themePanel ? named(themePanel).get('pageThemePanelOpacity') : null;
  const htmlRoot = doc14.documentElement as Record<string, unknown>;
  const cssVar = (): string =>
    String((htmlRoot.style as Record<string, (name: string) => string>).getPropertyValue('--panel-opacity'));
  const beforeOpacity = cssVar();
  if (opacityRange) {
    (opacityRange as { value: string }).value = '20';
    fire('pageThemePanelOpacity:input');
  }
  check(
    Boolean(themePanel) &&
      String(themePanel?.innerHTML ?? '').includes('面板') &&
      beforeOpacity === '0.88' &&
      cssVar() === '0.2',
    `33) the 🎨 面板 slider — which only the viewer page mounts — drives --panel-opacity ${beforeOpacity} -> ${cssVar()}`,
  );

  // ---- 34) both canvases share one transform ---------------------------
  const mapTransform = (): string => String((mapCanvas.style as Record<string, string>).transform ?? '');
  const hoverTransform = (): string => String((hoverCanvas.style as Record<string, string>).transform ?? '');
  const t0 = mapTransform();
  const h0 = hoverTransform();
  fire('zoomIn:click');
  check(
    t0 === h0 && mapTransform() === hoverTransform() && mapTransform() !== t0,
    '34) applyView writes the same transform to #map and #hover — the one exit for a view change',
  );

  // ---- 35) hit testing follows the canvas's own box ----------------------
  // The canvas is moved by a CSS transform, and its bounding box already contains that
  // transform — so a hit test maps a screen point straight through the box. The version the
  // user caught in full screen subtracted zx/zy and rescaled with clientWidth, i.e. applied
  // the transform twice; at 1:1 with no pan the two agree, and the offset only appears once
  // the view changes. Zooming first makes zx/zy non-zero, so a regression cannot pass here
  // by accident.
  const boxOf = (left: number, top: number, width: number, height: number): Record<string, number> => ({
    left, top, right: left + width, bottom: top + height, width, height,
  });
  const setMapBox = (box: Record<string, number>): void => {
    (mapCanvas as { rect: Record<string, number> }).rect = box;
  };
  /** The screen point that lands on raster pixel (sx, sy) for a given canvas box. */
  const pointFor = (box: Record<string, number>, sx: number, sy: number): { x: number; y: number } => ({
    x: box.left + ((sx + 0.5) / halfW) * box.width,
    y: box.top + ((sy + 0.5) / halfH) * box.height,
  });
  const transformOf = (): { x: number; y: number; scale: number } => {
    const numbers = (String((mapCanvas.style as Record<string, string>).transform ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []);
    return { x: Number(numbers[0] ?? 0), y: Number(numbers[1] ?? 0), scale: Number(numbers[2] ?? 1) };
  };
  /** Is any pixel of the highlight layer non-transparent? */
  const anyHoverAlpha = (): boolean => {
    const frame35 = lastByCanvas.get('hover') as { data: Uint8ClampedArray } | undefined;
    if (!frame35) return false;
    for (let p = 3; p < frame35.data.length; p += 4) if ((frame35.data[p] as number) > 0) return true;
    return false;
  };

  fire('detailClose:click');
  fire('zoomIn:click');
  const view = transformOf();
  const normalBox = boxOf(0, 0, 1100, 400);
  const screenBox = boxOf(20, 64, 1500, 545);
  const pixelA = { sx: A.bx * 32 + 16, sy: A.by * 32 + 16 };
  setMapBox(normalBox);
  const atNormal = pointFor(normalBox, pixelA.sx, pixelA.sy);
  clickAt(atNormal.x, atNormal.y);
  const viaNormal = detailTitle.textContent;
  fire('detailClose:click');
  setMapBox(screenBox);
  const atScreen = pointFor(screenBox, pixelA.sx, pixelA.sy);
  clickAt(atScreen.x, atScreen.y);
  const viaScreen = detailTitle.textContent;
  check(
    (view.x !== 0 || view.y !== 0 || view.scale !== 1) && viaNormal === titleA && viaScreen === titleA,
    '35) hit testing maps through the canvas box, transform included (scale ' + view.scale + ', offset ' +
      view.x + ',' + view.y + '): "' + viaNormal + '" then "' + viaScreen + '" for province ' + A.id,
  );

  // ---- 36) a flag with no artwork becomes the 48x48 TAG block ------------
  const firstFlag = panelFlags()[0];
  const firstBox = firstFlag ? firstFlag.box : null;
  const firstImg = firstFlag ? firstFlag.img : null;
  const fireMissing = firstImg ? (firstImg as { onerror?: () => void }).onerror : undefined;
  if (typeof fireMissing === 'function') fireMissing();
  const tagBlock = ((firstBox?.appended as Array<Record<string, unknown>> | undefined) ?? []).find(
    (kid) => kid.className === 'detailFallback',
  );
  check(
    Boolean(firstBox) &&
      String(firstBox?.className) === 'detailFlagBox' &&
      Boolean(tagBlock) &&
      String(tagBlock?.textContent ?? '').length > 0,
    '36) a flag whose artwork is missing becomes the TAG block inside the same box ("' +
      String(tagBlock?.textContent ?? '') + '")',
  );

  // ---- 37) entering full screen repaints the highlight -------------------
  // Nothing selected on purpose: with a sheet open the selection alone would repaint the
  // layer, and the check could not tell a re-resolved hover from a redrawn selection.
  fire('detailClose:click');
  // The point that lands on province A once the full-screen box is in place — under the
  // normal box the same screen point is somewhere else entirely, which is the point.
  const hoverPoint = pointFor(screenBox, pixelA.sx, pixelA.sy);
  setMapBox(normalBox);
  fire('map:pointermove', { ...mousePointer, clientX: hoverPoint.x, clientY: hoverPoint.y });
  const beforeFull = hoverPaints();
  // What the browser reports once .player.screen is on: a taller, wider, offset box.
  setMapBox(screenBox);
  fire('mapFull:click');
  const afterFull = hoverPaints();
  const hoverFrame = lastByCanvas.get('hover') as { data: Uint8ClampedArray } | undefined;
  const hoverX = Math.floor(((hoverPoint.x - screenBox.left) / screenBox.width) * halfW);
  const hoverY = Math.floor(((hoverPoint.y - screenBox.top) / screenBox.height) * halfH);
  const hoveredNow = idAtHalf(hoverX, hoverY);
  const alphaNow = hoverFrame ? (hoverFrame.data[(hoverY * halfW + hoverX) * 4 + 3] as number) : 0;
  fire('mapFull:click');
  check(
    afterFull === beforeFull + 1 && hoveredNow === A.id && alphaNow > 0,
    '37) entering full screen repaints the highlight from the last pointer at its new position ' +
      '(paints ' + beforeFull + '->' + afterFull + ', province under the pointer now ' + hoveredNow + ', alpha ' + alphaNow + ')',
  );

  // ---- 38) the panel's flags are the card's 48x48 box --------------------
  // Static: the sizes are declared once, in the shared markup, and copied from style.css
  // lines 121-123 (the catalogue card's protagonist flag).
  const flagBoxRule = /\.detailFlagBox\{[^}]*width:48px;height:48px[^}]*border-radius:4px[^}]*border:1px solid var\(--border-soft\)[^}]*background:var\(--panel2\)/.test(html);
  const flagImgRule = /\.detailFlagBox>img\{[^}]*width:100%;height:100%;object-fit:contain/.test(html);
  const everyBoxIsOurs = panelFlags().length > 0 && panelFlags().every((flag) => String(flag.box.className) === 'detailFlagBox');
  check(
    flagBoxRule && flagImgRule && everyBoxIsOurs,
    '38) panel flags use one 48x48 box (border-radius 4px, --border-soft hairline, --panel2, contain) for all ' +
      panelFlags().length + ' mounted flags',
  );

  // ---- 39) the map's pointer is the plain arrow --------------------------
  const viewRule = /\.view\{[^}]*cursor:default/.test(html);
  const canvasRule = /\.view canvas\{cursor:default\}/.test(html);
  const noGrab = !/cursor:\s*(grab|grabbing)/.test(html) && !html.includes('grabbing');
  check(
    viewRule && canvasRule && noGrab,
    '39) the map is the plain arrow: .view and .view canvas are cursor:default, and no grab/grabbing rule is left',
  );

  // ---- 40) the country drawer opens with flag + name ---------------------
  // A province first: 转到国家 reads the *current* selection, so something must be selected.
  clickAt(hoverPoint.x, hoverPoint.y);
  const gotoHead = named(detailBody14).get('detailGotoCountry');
  if (gotoHead) fire('detailBody:click', { target: gotoHead });
  const headMarkup = markup();
  const countryName = detailTitle.textContent.replace(/（.*$/, '');
  const headSlot = /id="dCountryHead"><span class="dSlot" id="([^"]+)"/.exec(headMarkup)?.[1] ?? '';
  const headKids = ((named(detailBody14).get(headSlot)?.appended as Array<Record<string, unknown>> | undefined) ?? []);
  const headBox = headKids.find((kid) => kid.className === 'detailFlagBox');
  const headLabel = String((headKids.find((kid) => kid.className === 'dName') as { textContent?: string } | undefined)?.textContent ?? '');
  check(
    Boolean(headSlot) &&
      Boolean(headBox) &&
      headLabel === countryName &&
      headMarkup.indexOf('id="dCountryHead"') < headMarkup.indexOf('id="dPane"'),
    '40) 总览 opens with a 48x48 flag + the country name ("' + headLabel + '" / ' + countryName + ') above the pane',
  );

  // ---- 41) 建筑：一条一栋建筑，按名字排序 -------------------------------
  fire('detailBody:click', { target: tabAt('buildings') });
  const buildingsHtml = markup();
  const barNames = [...buildingsHtml.matchAll(/<span class="dBarName">([^<]*)<\/span>/g)].map((m) => m[1] as string);
  const barsSorted = barNames.length === 2 && barNames.join('|') === [...barNames].sort((a, b) => a.localeCompare(b, 'zh-CN')).join('|');
  check(
    buildingsHtml.includes('全国建筑') &&
      barNames.length === 2 &&
      buildingsHtml.includes('市场') &&
      buildingsHtml.includes('373') &&
      barsSorted,
    '41) 建筑 renders one bar per building (name | province count), sorted by name: ' + barNames.join(' , '),
  );

  // ---- 42) 州：中文州名、发展度、繁荣度、首都州★ -------------------------
  fire('detailBody:click', { target: tabAt('states') });
  const statesHtml = markup();
  check(
    statesHtml.includes('斯德哥尔摩地区') &&
      statesHtml.includes('★') &&
      statesHtml.includes('42') &&
      statesHtml.includes('55') &&
      statesHtml.includes('暂不提供'),
    '42) 州 lists the state with 发展度/繁荣度, marks the capital state with ★ and says 治理成本/集权 are 暂不提供',
  );

  // ---- 43) 阶级：王室领地条 ＋ 每阶级一张卡 -----------------------------
  fire('detailBody:click', { target: tabAt('estates') });
  const estatesHtml = markup();
  check(
    estatesHtml.includes('王室领地') &&
      estatesHtml.includes('21.4') &&
      estatesHtml.includes('62.5') &&
      estatesHtml.includes('城镇特权') &&
      estatesHtml.includes('贸易实力'),
    '43) 阶级 shows the crownland bar and one card per estate (loyalty / territory / privileges / influences)',
  );

  // ---- 44) 顾问：名臣名字（走数据面的名字表）＋ 获得日期 ----------------
  fire('detailBody:click', { target: tabAt('advisors') });
  const advisorsHtml = markup();
  const beria = ((DATA as { uiNames?: { advisors?: Record<string, string> } }).uiNames?.advisors ?? {}).Beria ?? '';
  check(
    advisorsHtml.includes('名臣顾问') &&
      advisorsHtml.includes('孔子') &&
      advisorsHtml.includes('1450.3.2') &&
      beria !== '' &&
      advisorsHtml.includes(beria),
    '44) 顾问 lists each named advisor with its date, naming a key through the plane table (' + beria + ')',
  );
  fire('detailBody:click', { target: tabAt('general') });

  // ---- 45/46) an empty list is a fact, not missing data ------------------
  // The same drawer, on a country the plane says has no estates and hired no advisor: the panel
  // must say so in words (the acceptance checklist's 无阶级 / 没有名臣顾问 rules), not show a
  // blank card or the 数据面待补 note.
  const fakeRow2 = {
    tagName: 'TR',
    querySelector: (selector: string) => (selector === 'img.flag' ? { getAttribute: () => 'FRA' } : null),
  };
  fire('leaderBody:click', { target: { tagName: 'TD', parentNode: fakeRow2 } });
  fire('detailBody:click', { target: tabAt('estates') });
  const emptyEstates = markup();
  fire('detailBody:click', { target: tabAt('advisors') });
  const emptyAdvisors = markup();
  check(
    emptyEstates.includes('无阶级') && !emptyEstates.includes('数据面待补'),
    '45) a country whose estates list is empty says 无阶级 instead of showing a blank card',
  );
  check(
    emptyAdvisors.includes('没有名臣顾问') && !emptyAdvisors.includes('数据面待补'),
    '46) a country with no hired advisor says 没有名臣顾问 rather than 数据面待补',
  );
  fire('detailBody:click', { target: tabAt('general') });

  // ---- 47) 思潮：徽章 ＋ 各省进度条 --------------------------------------
  // Back to the country that owns province A: the two checks above ended on FRA (the fake
  // leaderboard row), and FRA is deliberately the record *without* a ledger.
  clickAt(atScreen.x, atScreen.y);
  const gotoW3 = named(detailBody14).get('detailGotoCountry');
  if (gotoW3) fire('detailBody:click', { target: gotoW3 });
  // The badge is the *capital province's* count (the save records institutions per province), so the
  // expectation is computed here from the same two plane keys the panel reads.
  fire('detailBody:click', { target: tabAt('institution') });
  const institutionHtml = markup();
  const capitals = (DATA as { hre: { capitals: number[][] } }).hre.capitals;
  const sweRow = capitals.find((row) => (DATA.tags as string[])[row[0] as number] === 'SWE') ?? [];
  const sweCapital = sweRow[1] as number | undefined;
  const capInstitutions = (DATA.provinceInstitutions as number[][]).find((row) => row[0] === sweCapital);
  const expectedBadge = capInstitutions ? capInstitutions[1] : 0;
  check(
    institutionHtml.includes('思潮') &&
      institutionHtml.includes('已接纳 ' + expectedBadge + ' / 8') &&
      (institutionHtml.match(/class="dBar"/g) ?? []).length > 0 &&
      institutionHtml.includes('各省进度'),
    '47) 思潮 shows the 已接纳 ' + expectedBadge + '/8 badge and a progress bar per province (' +
      ((institutionHtml.match(/class="dBar"/g) ?? []).length) + ' bars)',
  );

  // ---- 48) 财政：指标卡 ＋ 瀑布图 ＋ 四区间明细 ＋ 支出树 ---------------
  fire('detailBody:click', { target: tabAt('budget') });
  const budgetHtml = markup();
  const waterfallColumns = (budgetHtml.match(/class="dWfCol/g) ?? []).length;
  check(
    budgetHtml.includes('营业利润') &&
      budgetHtml.includes('瀑布图') &&
      waterfallColumns >= 4 &&
      ['上月', '年初至今', '去年', '合计'].every((label) => budgetHtml.includes(label)) &&
      budgetHtml.includes('占比') &&
      budgetHtml.includes('税收') &&
      budgetHtml.includes('陆军维护费') &&
      budgetHtml.includes('支出树'),
    '48) 财政 renders the cards, a ' + waterfallColumns + '-column waterfall, the four-period table with 占比 and the expense tree',
  );

  // ---- 49) 点数：三条量条 ＋「点数去哪了」--------------------------------
  fire('detailBody:click', { target: tabAt('mana') });
  const manaHtml = markup();
  const manaBars = (manaHtml.match(/class="dBar"/g) ?? []).length;
  check(
    manaHtml.includes('君主点数') &&
      manaBars >= 3 &&
      manaHtml.includes('行政 (ADM)') &&
      manaHtml.includes('点数去哪了') &&
      manaHtml.includes('购买理念') &&
      manaHtml.includes('提升科技'),
    '49) 点数 shows the three power bars (' + manaBars + ') and the named breakdown table',
  );

  // ---- 50) 没有账本的国家说 数据待补，不借别人的科目名 -----------------
  const fakeRow3 = {
    tagName: 'TR',
    querySelector: (selector: string) => (selector === 'img.flag' ? { getAttribute: () => 'FRA' } : null),
  };
  fire('leaderBody:click', { target: { tagName: 'TD', parentNode: fakeRow3 } });
  fire('detailBody:click', { target: tabAt('budget') });
  const noBudget = markup();
  fire('detailBody:click', { target: tabAt('mana') });
  const noMana = markup();
  check(
    noBudget.includes('数据待补') && !noBudget.includes('税收') &&
      noMana.includes('数据待补') && !noMana.includes('购买理念'),
    '50) a country with no ledger and no mana breakdown says 数据待补 and prints no slot name at all',
  );
  fire('detailBody:click', { target: tabAt('general') });

  const all = ok.every(Boolean);
  console.log(`  detail sheet: ${ok.filter(Boolean).length}/${ok.length} checks ${all ? 'OK' : 'WRONG'}`);
  if (!all) process.exitCode = 1;
}

// ------------- 15. every table sorts from its own header ---------------------
console.log('\n=== 15. tables sort from their own header ===');
{
  // 第四对话任务书.md §3.3. A sorter exists only in the DOM: it reads a cell's text, moves a
  // body's children and writes aria-sort back, and the rest of this file asserts on innerHTML
  // *strings*, which can show none of that. So this section turns the page's own table markup
  // (and, once the drawer opens, the sheet's) into a small element tree with exactly the few
  // properties the sorter and the renderers touch — and then drives the real client against it.
  type TNode = { tag: string; attrs: Map<string, string>; kids: TNode[]; parent: TNode | null; text: string };
  type TEl = Record<string, unknown>;

  const VOID_TAGS = new Set([
    'img', 'br', 'hr', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr',
    'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop',
  ]);
  const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  function parseAttrs(src: string): Map<string, string> {
    const out = new Map<string, string>();
    ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR_RE.exec(src)) !== null) {
      if (m[0] === '') {
        ATTR_RE.lastIndex += 1;
        continue;
      }
      out.set(m[1] as string, (m[2] ?? m[3] ?? m[4] ?? '') as string);
    }
    return out;
  }
  /** Tag soup in, tree out. The markup here is machine-written, so every tag is closed. */
  function parseMarkup(src: string): TNode[] {
    const root: TNode = { tag: '#root', attrs: new Map(), kids: [], parent: null, text: '' };
    let cur = root;
    const re = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m[5] !== undefined) {
        cur.kids.push({ tag: '#text', attrs: new Map(), kids: [], parent: cur, text: m[5] as string });
        continue;
      }
      const tag = String(m[2]).toLowerCase();
      if (m[1] === '/') {
        let open: TNode | null = cur;
        while (open && open.tag !== tag) open = open.parent;
        if (open && open.parent) cur = open.parent;
        continue;
      }
      const node: TNode = { tag, attrs: parseAttrs(m[3] ?? ''), kids: [], parent: cur, text: '' };
      cur.kids.push(node);
      if (m[4] !== '/' && !VOID_TAGS.has(tag)) cur = node;
    }
    return root.kids;
  }

  const textOf = (node: TNode): string => {
    if (node.tag === '#text') return node.text;
    let out = '';
    for (const kid of node.kids) out += textOf(kid);
    return out;
  };
  const elementKids = (node: TNode): TNode[] => node.kids.filter((kid) => kid.tag !== '#text');
  const descendantsOf = (node: TNode): TNode[] => {
    const out: TNode[] = [];
    for (const kid of node.kids) {
      if (kid.tag === '#text') continue;
      out.push(kid);
      for (const deep of descendantsOf(kid)) out.push(deep);
    }
    return out;
  };
  const classListOf = (node: TNode): string[] => String(node.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
  const serialize = (node: TNode): string => {
    if (node.tag === '#text') return node.text;
    const attrs = [...node.attrs.entries()].map(([name, value]) => ` ${name}="${value}"`).join('');
    if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
    return `<${node.tag}${attrs}>${node.kids.map(serialize).join('')}</${node.tag}>`;
  };

  type Compound = { tag: string; id: string; classes: string[]; attrs: Array<[string, string | null]> };
  function parseCompound(part: string): Compound {
    const out: Compound = { tag: '', id: '', classes: [], attrs: [] };
    const re = /([A-Za-z][A-Za-z0-9-]*)|#([A-Za-z0-9_-]+)|\.([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(part)) !== null) {
      if (m[1]) out.tag = m[1].toLowerCase();
      else if (m[2]) out.id = m[2];
      else if (m[3]) out.classes.push(m[3]);
      else if (m[4]) out.attrs.push([m[4], m[5] ?? null]);
    }
    return out;
  }
  function matchesCompound(node: TNode, compound: Compound): boolean {
    if (node.tag === '#text') return false;
    if (compound.tag && node.tag !== compound.tag) return false;
    if (compound.id && node.attrs.get('id') !== compound.id) return false;
    const classes = classListOf(node);
    for (const wanted of compound.classes) if (!classes.includes(wanted)) return false;
    for (const [name, value] of compound.attrs) {
      const got = node.attrs.get(name);
      if (got === undefined) return false;
      if (value !== null && got !== value) return false;
    }
    return true;
  }
  function queryAll(root: TNode, selector: string): TNode[] {
    const parts = selector.trim().split(/\s+/).filter(Boolean).map(parseCompound);
    if (!parts.length) return [];
    const last = parts[parts.length - 1] as Compound;
    const out: TNode[] = [];
    for (const node of descendantsOf(root)) {
      if (!matchesCompound(node, last)) continue;
      let ok = true;
      let at: TNode | null = node.parent;
      let need = parts.length - 2;
      while (need >= 0) {
        while (at && !matchesCompound(at, parts[need] as Compound)) at = at.parent;
        if (!at) { ok = false; break; }
        at = at.parent;
        need -= 1;
      }
      if (ok) out.push(node);
    }
    return out;
  }

  const wrappers = new Map<TNode, TEl>();
  const ownListeners = new Map<TNode, Map<string, Array<(event: unknown) => void>>>();
  function wrap(node: TNode): TEl {
    const cached = wrappers.get(node);
    if (cached) return cached;
    const el: TEl = { node: node, tagName: node.tag.toUpperCase(), dataset: {}, value: '0', width: 0, height: 0, clientWidth: 0, clientHeight: 0 };
    wrappers.set(node, el);
    Object.defineProperties(el, {
      id: { get: () => node.attrs.get('id') ?? '' },
      className: {
        get: () => node.attrs.get('class') ?? '',
        set: (value: string) => { node.attrs.set('class', String(value)); },
      },
      hidden: {
        get: () => node.attrs.has('hidden'),
        set: (value: boolean) => { if (value) node.attrs.set('hidden', 'hidden'); else node.attrs.delete('hidden'); },
      },
      textContent: {
        get: () => textOf(node),
        set: (value: string) => { node.kids = [{ tag: '#text', attrs: new Map(), kids: [], parent: node, text: String(value) }]; },
      },
      innerHTML: {
        get: () => serialize(node),
        set: (value: string) => {
          node.kids = parseMarkup(String(value));
          for (const kid of node.kids) kid.parent = node;
        },
      },
      children: { get: () => elementKids(node).map(wrap) },
      cells: { get: () => elementKids(node).map(wrap) },
      rows: { get: () => elementKids(node).map(wrap) },
      parentNode: { get: () => (node.parent ? wrap(node.parent) : null) },
      classList: {
        get: () => ({
          add: (name: string) => { node.attrs.set('class', [...classListOf(node), name].join(' ')); },
          remove: (name: string) => { node.attrs.set('class', classListOf(node).filter((one) => one !== name).join(' ')); },
          contains: (name: string) => classListOf(node).includes(name),
          toggle: (name: string, force?: boolean) => {
            const on = force === undefined ? !classListOf(node).includes(name) : force;
            if (on) node.attrs.set('class', [...classListOf(node), name].join(' '));
            else node.attrs.set('class', classListOf(node).filter((one) => one !== name).join(' '));
            return on;
          },
        }),
      },
    });
    Object.assign(el, {
      getAttribute: (name: string) => node.attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => { node.attrs.set(name, String(value)); },
      hasAttribute: (name: string) => node.attrs.has(name),
      removeAttribute: (name: string) => { node.attrs.delete(name); },
      style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => '' },
      appendChild: (child: TEl) => {
        const moved = child.node as TNode | undefined;
        if (moved) {
          if (moved.parent) {
            const at = moved.parent.kids.indexOf(moved);
            if (at >= 0) moved.parent.kids.splice(at, 1);
          }
          moved.parent = node;
          node.kids.push(moved);
        }
        return child;
      },
      insertBefore: (child: TEl) => el.appendChild(child),
      removeChild: (child: TEl) => {
        const gone = child.node as TNode | undefined;
        if (gone && gone.parent) {
          const at = gone.parent.kids.indexOf(gone);
          if (at >= 0) gone.parent.kids.splice(at, 1);
        }
        return child;
      },
      querySelector: (selector: string) => {
        const found = queryAll(node, selector)[0];
        return found ? wrap(found) : null;
      },
      querySelectorAll: (selector: string) => queryAll(node, selector).map(wrap),
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        let map = ownListeners.get(node);
        if (!map) { map = new Map(); ownListeners.set(node, map); }
        map.set(type, [...(map.get(type) ?? []), fn]);
        const id = node.attrs.get('id');
        if (id) {
          const key = `${id}:${type}`;
          listeners.set(key, [...(listeners.get(key) ?? []), fn]);
        }
      },
      click: () => {
        for (const fn of ownListeners.get(node)?.get('click') ?? []) fn({ preventDefault: () => {}, stopPropagation: () => {} });
      },
      getContext: () => makeCtx('sort'),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    });
    return el;
  }

  // ---- the page's three bottom tables, straight out of the generated markup ----
  // Everything after the first <script> is the inlined client, whose source is full of
  // table markup inside string literals; the page's own tables all live before it.
  const pageMarkup = html.slice(0, html.indexOf('<script>'));
  const tablesByName = new Map<string, TEl>();
  for (const match of pageMarkup.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)) {
    const parsed = parseMarkup(match[0])[0];
    if (!parsed) continue;
    const name = parsed.attrs.get('data-table');
    if (name) tablesByName.set(name, wrap(parsed));
  }

  const detailBodyNode: TNode = { tag: 'div', attrs: new Map([['id', 'detailBody']]), kids: [], parent: null, text: '' };
  const detailBody15 = wrap(detailBodyNode);

  const freshEls15 = new Map<string, Record<string, unknown>>();
  for (const id of els.keys()) freshEls15.set(id, makeEl(id));
  freshEls15.set('body', makeEl('body'));
  freshEls15.set('head', makeEl('head'));
  freshEls15.set('detailBody', detailBody15);
  (freshEls15.get('detail') as Record<string, unknown>).hidden = true;
  // The three bodies are the parsed <tbody> elements, so what the client writes into them is
  // read back through the very table the sorter walks.
  for (const table of tablesByName.values()) {
    const body = (table.querySelectorAll as (s: string) => TEl[])('tbody')[0];
    const id = body ? String(body.id ?? '') : '';
    if (id) freshEls15.set(id, body as Record<string, unknown>);
  }

  const doc15: Record<string, unknown> = {
    title: '',
    body: freshEls15.get('body'),
    head: freshEls15.get('head'),
    documentElement: makeEl('html'),
    getElementById: (id: string) => freshEls15.get(id) ?? null,
    createElement: (tag: string) => makeEl(`created-${tag}`, String(tag).toUpperCase()),
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === '[data-fact]'
        ? factEls
        : selector === 'table[data-sortable]'
          ? [...tablesByName.values()]
          : [],
  };

  listeners.clear();
  windowListeners.clear();
  paintCalls.clear();
  lastByCanvas.clear();
  putImageDataCalls = 0;
  lastImage = null;

  const sandbox15: Record<string, unknown> = Object.assign({}, sandbox, { document: doc15 });
  sandbox15.window = sandbox15;
  sandbox15.globalThis = sandbox15;
  const context15 = vm.createContext(sandbox15);
  let sortLoadError: Error | null = null;
  for (const [i, body] of scripts.entries()) {
    try {
      new vm.Script(body, { filename: `sort-${i}.js` }).runInContext(context15);
    } catch (error) {
      sortLoadError = error as Error;
      break;
    }
  }
  const ok15: boolean[] = [];
  const check15 = (pass: boolean, label: string): void => {
    ok15.push(pass);
    if (!pass) process.exitCode = 1;
    console.log(`  ${pass ? 'OK  ' : 'WRONG'} ${label}`);
  };
  check15(!sortLoadError, '1) the client still executes against the page\'s own table markup');
  if (sortLoadError) {
    console.log(sortLoadError.stack);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  const fire15 = (key: string, event: Record<string, unknown> = {}): void => {
    for (const fn of listeners.get(key) ?? []) {
      fn(Object.assign({ preventDefault: () => {}, stopPropagation: () => {} }, event));
    }
  };
  const tableOf = (name: string): TEl => {
    const table = tablesByName.get(name);
    if (!table) throw new Error(`section 15: the page has no ${name} table`);
    return table;
  };
  const headersOf = (table: TEl): TEl[] => (table.querySelectorAll as (s: string) => TEl[])('thead th');
  const rowsOf = (table: TEl): TEl[] => {
    const body = (table.querySelectorAll as (s: string) => TEl[])('tbody')[0] as TEl;
    return body.children as TEl[];
  };
  const cellText = (row: TEl, index: number): string =>
    String(((row.cells as TEl[])[index] as { textContent?: string } | undefined)?.textContent ?? '');
  const numbersOf = (table: TEl, column: number): number[] =>
    rowsOf(table).map((row) => Number(cellText(row, column).replace(/,/g, '')));
  const namesOf = (table: TEl, column: number): string[] => rowsOf(table).map((row) => cellText(row, column));
  const sortedDesc = (values: number[]): boolean => values.every((value, i) => i === 0 || (values[i - 1] as number) >= value);
  const sortedAsc = (values: number[]): boolean => values.every((value, i) => i === 0 || (values[i - 1] as number) <= value);

  const leader = tableOf('leader');
  const city = tableOf('city');
  const leaderTh = headersOf(leader);
  check15(
    tablesByName.has('leader') && tablesByName.has('city') && tablesByName.has('institution') &&
      leaderTh.length === 9 && !leaderTh[0]?.getAttribute('data-sort') &&
      leaderTh.slice(1).every((th) => Boolean(th.getAttribute('data-sort'))),
    `2) the three bottom tables declare data-sortable, and every column of #leader except # declares a type (${leaderTh.length} columns)`,
  );

  // ---- ① one click descending, the next ascending, the third back again ----
  const clickTh = (th: TEl): void => { (th.click as () => void)(); };
  const scoreColumn = 3;
  const scoreTh = leaderTh[scoreColumn] as TEl;
  // The "#" column as it stands before anything is clicked: every row's own rank, paired
  // with the row it belongs to. Sorting must move rows without editing that cell.
  const original = rowsOf(leader).map((row) => ({ rank: cellText(row, 0), name: cellText(row, 1) }));
  clickTh(scoreTh);
  const firstScores = numbersOf(leader, scoreColumn);
  check15(
    scoreTh.getAttribute('aria-sort') === 'descending' && sortedDesc(firstScores),
    `3) ① first click on 时代评分 sorts descending (top ${firstScores[0]})`,
  );
  clickTh(scoreTh);
  const secondScores = numbersOf(leader, scoreColumn);
  check15(
    scoreTh.getAttribute('aria-sort') === 'ascending' && sortedAsc(secondScores) && secondScores[0] === firstScores[firstScores.length - 1],
    `4) ① second click sorts ascending (top ${secondScores[0]})`,
  );
  clickTh(scoreTh);
  const thirdScores = numbersOf(leader, scoreColumn);
  check15(
    scoreTh.getAttribute('aria-sort') === 'descending' && JSON.stringify(thirdScores) === JSON.stringify(firstScores),
    '5) ① third click is descending again — the cycle, not a fourth state',
  );

  // ---- ② exactly one header carries aria-sort -----------------------------
  const ariaSorted = leaderTh.filter((th) => Boolean(th.getAttribute('aria-sort')));
  check15(
    ariaSorted.length === 1 && ariaSorted[0] === scoreTh,
    `6) ② exactly one header of the table carries aria-sort (${ariaSorted.length})`,
  );

  // ---- ④ the "#" column is never rewritten --------------------------------
  const rankByName = new Map(original.map((entry) => [entry.name, entry.rank]));
  const ranksNow = rowsOf(leader).map((row) => ({ rank: cellText(row, 0), name: cellText(row, 1) }));
  check15(
    ranksNow.every((row) => rankByName.get(row.name) === row.rank) &&
      ranksNow.map((row) => row.rank).sort().join(',') === original.map((entry) => entry.rank).sort().join(','),
    '7) ④ the # column still carries each row\'s original rank after sorting (1..15, never rewritten)',
  );

  // ---- ⑥ a header with no data-sort does nothing --------------------------
  const orderBefore = namesOf(leader, 1).join('|');
  clickTh(leaderTh[0] as TEl);
  check15(
    namesOf(leader, 1).join('|') === orderBefore &&
      !(leaderTh[0] as TEl).getAttribute('aria-sort') &&
      !(leaderTh[0] as TEl).getAttribute('data-sort-bound'),
    '8) ⑥ the # header is not bound at all: clicking it changes nothing',
  );

  // ---- ③ stable sort on a real tie ---------------------------------------
  // The city table is the host's own markup and this save has ties in 发展度 (柏林 and 伦敦
  // are both 37), so the tie order is the one thing that proves the sort is stable: with
  // equal values the original order has to survive, or the head of the tie would depend on
  // the engine. The expectation below is computed the same way the sorter is specified to.
  const cityTh = headersOf(city);
  const cityBefore = rowsOf(city).map((row, i) => ({
    i,
    rank: cellText(row, 0),
    name: cellText(row, 1),
    dev: Number(cellText(row, 2)),
  }));
  const tieCount = cityBefore.filter((entry) => cityBefore.some((other) => other.i !== entry.i && other.dev === entry.dev)).length;
  clickTh(cityTh[2] as TEl);
  const cityExpected = cityBefore
    .slice()
    .sort((a, b) => b.dev - a.dev || a.i - b.i)
    .map((entry) => entry.name);
  check15(
    JSON.stringify(namesOf(city, 1)) === JSON.stringify(cityExpected) && sortedDesc(numbersOf(city, 2)),
    `9) ③ 城市发展度 sorts descending and equal values keep their original order (${tieCount} rows in a tie)`,
  );
  const cityRanks = new Map(cityBefore.map((entry) => [entry.name, entry.rank]));
  check15(
    rowsOf(city).every((row) => cityRanks.get(cellText(row, 1)) === cellText(row, 0)),
    '10) the city table\'s # column is untouched too',
  );

  // ---- the sheet: open the country drawer from a leaderboard row ----------
  // The row's own flag is the way into that country (that is how the drawer has always been
  // opened from the table), which also exercises the row lookup against reordered rows.
  const withFlag = rowsOf(leader).find((row) => Boolean((row.querySelector as (s: string) => TEl | null)('img.flag')));
  if (!withFlag) throw new Error('section 15: no leaderboard row carries a flag');
  const flagEl = (withFlag.querySelector as (s: string) => TEl | null)('img.flag') as TEl;
  const openedTag = String(flagEl.getAttribute('data-tag'));
  // The drawer's own record comes from the real plane; only the two lists this section
  // asserts on are replaced, so 总览 still renders its real values. The tag aliases are
  // emptied first, so the tag the flag names is the tag the drawer opens.
  vm.runInContext('DATA.tagAlias.length = 0;', context15);
  const rulers = [
    { name: '甲', start: '1444.11.11', end: '1460.1.1', months: 180, personalities: [], adm: 3, dip: 3, mil: 3 },
    { name: '乙', start: '1460.1.2', end: '1480.1.1', months: 240, personalities: [], adm: 5, dip: 4, mil: 6 },
    { name: '丙', start: '1480.1.2', end: '', months: 300, personalities: [], adm: 4, dip: 5, mil: 6 },
    { name: '丁', start: '1500.1.1', end: '1510.1.1', months: 120, personalities: [], adm: 1, dip: 1, mil: 1 },
  ];
  const hasRecord = vm.runInContext(
    `Boolean(DATA.countryDetail && DATA.countryDetail[${JSON.stringify(openedTag)}])`,
    context15,
  ) as boolean;
  if (!hasRecord) throw new Error(`section 15: ${openedTag} has no countryDetail record to open`);
  vm.runInContext(
    `DATA.countryDetail[${JSON.stringify(openedTag)}].rulers = ${JSON.stringify(rulers)};`,
    context15,
  );
  fire15('leaderBody:click', { target: flagEl });
  const drawerOpen = String((freshEls15.get('detailTitle') as { textContent?: string } | undefined)?.textContent ?? '');
  check15(
    String((freshEls15.get('detail') as { hidden?: boolean }).hidden) === 'false' && drawerOpen !== '',
    `11) clicking a leaderboard row's flag opens that country's drawer (${drawerOpen})`,
  );

  const tabAt15 = (tab: string): TEl => {
    const found = (detailBody15.querySelector as (s: string) => TEl | null)(`#dTab-${tab}`);
    if (!found) throw new Error(`section 15: no #dTab-${tab} in the drawer`);
    return found;
  };
  const panelTable = (name: string): TEl => {
    const found = (detailBody15.querySelector as (s: string) => TEl | null)(`table[data-table="${name}"]`);
    if (!found) throw new Error(`section 15: the drawer has no ${name} table`);
    return found;
  };
  fire15('detailBody:click', { target: tabAt15('rulers') });
  const rulersTable = panelTable('rulers');
  const totalColumn = 6;
  check15(
    rowsOf(rulersTable).length === rulers.length,
    `12) 君主 renders the patched reign list (${rowsOf(rulersTable).length} rows)`,
  );
  clickTh(headersOf(rulersTable)[totalColumn] as TEl);
  const totals = numbersOf(rulersTable, totalColumn);
  check15(
    sortedDesc(totals) && JSON.stringify(namesOf(rulersTable, 0)) === JSON.stringify(['乙', '丙', '甲', '丁']),
    `13) ③ 合计 sorts descending, and the two 15s keep the order they were rendered in (${namesOf(rulersTable, 0).join('/')})`,
  );

  // ---- ⑤ a rebuilt panel comes back with its sort -------------------------
  // Switching tabs throws the table away and builds a fresh one; coming back has to find the
  // remembered column again, which is the whole point of data-table plus applyStoredSort.
  fire15('detailBody:click', { target: tabAt15('budget') });
  fire15('detailBody:click', { target: tabAt15('rulers') });
  const rebuilt = panelTable('rulers');
  const rebuiltTh = headersOf(rebuilt)[totalColumn] as TEl;
  check15(
    rebuilt !== rulersTable &&
      rebuiltTh.getAttribute('aria-sort') === 'descending' &&
      JSON.stringify(namesOf(rebuilt, 0)) === JSON.stringify(['乙', '丙', '甲', '丁']),
    '14) ⑤ the sort survives a tab switch: the rebuilt 君主 table is still descending on 合计',
  );
  clickTh(rebuiltTh);
  // Stable again, and now on top of the *descending* order the rebuild replayed: the two 15s
  // were left as 乙,丙, so ascending puts 丁, 甲 and then that same pair.
  check15(
    rebuiltTh.getAttribute('aria-sort') === 'ascending' &&
      JSON.stringify(namesOf(rebuilt, 0)) === JSON.stringify(['丁', '甲', '乙', '丙']),
    `15) and the rebuilt table keeps cycling: the next click is ascending (${namesOf(rebuilt, 0).join('/')})`,
  );

  // ---- every panel table carries a stable name ----------------------------
  // Without data-table there is nothing to remember a column under, so each of these would
  // silently lose its sort on the next render.
  const client = scripts[scripts.length - 1] as string;
  const named = [...client.matchAll(/data-sortable data-table="([A-Za-z]+)"/g)].map((m) => m[1] as string);
  const wanted = ['rulers', 'leaders', 'states', 'history', 'culture', 'religion', 'budget', 'mana', 'improve', 'tradecompany', 'area', 'estates'];
  check15(
    wanted.every((name) => named.includes(name)) && named.length >= wanted.length,
    `16) every panel table carries a stable data-table name (${named.length} tables: ${[...new Set(named)].join(', ')})`,
  );

  const all15 = ok15.every(Boolean);
  console.log(`  sorting: ${ok15.filter(Boolean).length}/${ok15.length} checks ${all15 ? 'OK' : 'WRONG'}`);
  if (!all15) process.exitCode = 1;

  // ---- 16. the two rankings (第四对话任务书.md §3.4 / §3.6) -----------------
  // They share this section's mini-DOM on purpose: the page's table markup is parsed by
  // data-table name, so the two new tables arrived here by themselves. This half checks what
  // only *this* pair needs — that the client really drew DATA.rankings into them (row count,
  // row order, values), that their notes are the plane's own weights and coverage, and that
  // the generic sorter drives them like any other table.
  console.log('\n=== 16. the two rankings ===');
  const ok16: boolean[] = [];
  const check16 = (pass: boolean, label: string): void => {
    ok16.push(pass);
    if (!pass) process.exitCode = 1;
    console.log(`  ${pass ? 'OK  ' : 'WRONG'} ${label}`);
  };
  const rankings = vm.runInContext('DATA.rankings', context15) as {
    meta: Record<string, any>;
    generals: Array<Record<string, any>>;
    monarchs: Array<Record<string, any>>;
  };
  const textOf16 = (id: string): string =>
    String((freshEls15.get(id) as { textContent?: string } | undefined)?.textContent ?? '');
  const general = tableOf('general');
  const monarch = tableOf('monarch');
  const generalTh = headersOf(general);
  const monarchTh = headersOf(monarch);
  const generalRows = rowsOf(general);
  const monarchRows = rowsOf(monarch);

  // ---- ① both tables are drawn, 15 rows each, from the plane's own arrays ----
  const generalScores = numbersOf(general, 11);
  const monarchScores = numbersOf(monarch, 10);
  check16(
    generalRows.length === rankings.generals.length && monarchRows.length === rankings.monarchs.length &&
      generalRows.length === 15 && monarchRows.length === 15,
    `1) the client drew both rankings from DATA.rankings (${generalRows.length} generals, ${monarchRows.length} monarchs)`,
  );
  check16(
    generalRows.every((row, i) => cellText(row, 11) === Number(rankings.generals[i]?.score).toFixed(1)) &&
      monarchRows.every((row, i) => cellText(row, 10) === Number(rankings.monarchs[i]?.score).toFixed(1)) &&
      generalScores.every((value) => isFinite(value)) && monarchScores.every((value) => isFinite(value)),
    `2) every row carries the plane's score, in the plane's order (top: ${cellText(generalRows[0] as TEl, 1)} ` +
      `${generalScores[0]} / ${cellText(monarchRows[0] as TEl, 1)} ${monarchScores[0]})`,
  );
  // ---- ② the note is built from rankings.meta, not hand-copied -----------------
  const weights = rankings.meta.weights;
  const floors = rankings.meta.floors;
  const coverage = rankings.meta.coverage;
  const expectedGeneralBits = [
    Math.round(weights.general.skill * 100) + '%',
    Math.round(weights.general.war * 100) + '%',
    Math.round(weights.general.win * 100) + '%',
    String(floors.minBattles),
    Number(coverage.commandedSides).toLocaleString('zh-CN'),
    Number(coverage.joinedSides).toLocaleString('zh-CN'),
  ];
  const expectedMonarchBits = [
    Math.round(weights.monarch.ability * 100) + '%',
    Math.round(weights.monarch.tenure * 100) + '%',
    Math.round(weights.monarch.growth * 100) + '%',
    Math.round(weights.monarch.pace * 100) + '%',
    Math.round(floors.minReignMonths / 12) + ' 年',
    Number(rankings.meta.monarchPool).toLocaleString('zh-CN'),
  ];
  const generalNoteText = textOf16('generalNote');
  const monarchNoteText = textOf16('monarchNote');
  check16(
    expectedGeneralBits.every((bit) => generalNoteText.includes(bit)) && generalNoteText.includes('覆盖率'),
    `3) the generals note is rankings.meta itself (${generalNoteText.slice(0, 46)}…)`,
  );
  check16(
    expectedMonarchBits.every((bit) => monarchNoteText.includes(bit)) && monarchNoteText.includes('完整任职链'),
    `4) the monarchs note is rankings.meta itself (${monarchNoteText.slice(0, 46)}…)`,
  );
  // ---- ③ the sorter drives the new tables like any other ----------------------
  const scoreColumn16 = 11;
  const generalScoreTh = generalTh[scoreColumn16] as TEl;
  clickTh(generalScoreTh);
  const down = numbersOf(general, scoreColumn16);
  clickTh(generalScoreTh);
  const up = numbersOf(general, scoreColumn16);
  check16(
    generalScoreTh.getAttribute('aria-sort') === 'ascending' && sortedDesc(down) && sortedAsc(up) &&
      down[0] === up[up.length - 1] && up[0] === down[down.length - 1],
    `5) 综合评分 cycles descending→ascending on click (${down[0]} then ${up[0]})`,
  );
  // ---- ④ the country column sorts by the Chinese name, flag and all ------------
  const countryColumn16 = 2;
  const countryTh = generalTh[countryColumn16] as TEl;
  const countryNames = namesOf(general, countryColumn16);
  clickTh(countryTh);
  const countriesDown = namesOf(general, countryColumn16);
  const expectedCountries = countryNames.slice().sort((a, b) => b.localeCompare(a, 'zh-CN'));
  check16(
    countryTh.getAttribute('aria-sort') === 'descending' &&
      JSON.stringify(countriesDown) === JSON.stringify(expectedCountries) &&
      countryNames.every((name) => name !== ''),
    `6) 国家 sorts by the Chinese name, the flag cell included (top: ${countriesDown[0]})`,
  );
  // ---- ⑤ the 三维 cell shows 4 / 2 / 5 and sorts by its total ------------------
  const statsColumn = 3;
  const statsTh = monarchTh[statsColumn] as TEl;
  const statsDisplay = monarchRows.map((row, i) => ({
    three: cellText(row, 3),
    total: cellText(row, 4).replace(/,/g, ''),
    want: rankings.monarchs[i] as Record<string, number>,
  }));
  const statsOrder = statsDisplay.map((entry, i) => ({ i, stats: Number(entry.total), name: cellText(monarchRows[i] as TEl, 1) }));
  clickTh(statsTh);
  const statsExpected = statsOrder
    .slice()
    .sort((a, b) => b.stats - a.stats || a.i - b.i)
    .map((entry) => entry.name);
  check16(
    statsTh.getAttribute('aria-sort') === 'descending' &&
      statsTh.getAttribute('data-sort') === 'num' &&
      statsDisplay.every((entry) =>
        entry.three === entry.want.adm + ' / ' + entry.want.dip + ' / ' + entry.want.mil &&
        entry.total === String(entry.want.stats)) &&
      JSON.stringify(namesOf(monarch, 1)) === JSON.stringify(statsExpected),
    `7) ADM/DIP/MIL displays the three stats and sorts by their total (top: ${namesOf(monarch, 1)[0]})`,
  );
  // ---- ⑥ a monarch still on the throne is written 在位 and always last ---------
  const stillRuling = monarchRows.filter((row) => cellText(row, 6) === '在位').length;
  const endTh = monarchTh[6] as TEl;
  clickTh(endTh);
  const rulingLastDown = rowsOf(monarch).slice(-stillRuling).every((row) => cellText(row, 6) === '在位');
  clickTh(endTh);
  const rulingLastUp = rowsOf(monarch).slice(-stillRuling).every((row) => cellText(row, 6) === '在位');
  check16(
    stillRuling > 0 && rulingLastDown && rulingLastUp && endTh.getAttribute('aria-sort') === 'ascending',
    `8) 止 writes 在位 for ${stillRuling} monarch(s) and keeps them last in both directions`,
  );
  const all16 = ok16.every(Boolean);
  console.log(`  rankings: ${ok16.filter(Boolean).length}/${ok16.length} checks ${all16 ? 'OK' : 'WRONG'}`);
  if (!all16) process.exitCode = 1;
}

// ------------- 17. a data plane without rankings -----------------------------
console.log('\n=== 17. an old data plane with no rankings ===');
{
  // 第四对话任务书.md §4.3 C2: a payload built before this feature has no `rankings` key at
  // all, and the page must write that down rather than throw (the stored products in
  // .dev-storage are exactly this until the rebuild task runs). The client is loaded again
  // with the key deleted from its own data line — the only honest way to reproduce an old
  // product — and both tables must answer 数据面待补 while every other script still runs.
  const dataAt = scripts.findIndex((body) =>
    body.split('\n').some((line) => line.startsWith('const DATA = ')),
  );
  if (dataAt < 0) throw new Error('section 17: the page carries no DATA line');
  const withoutRankings = scripts.slice();
  withoutRankings[dataAt] = (scripts[dataAt] as string).replace(
    /^const DATA = (.*)$/m,
    (_whole, data: string) => `const DATA = (function(){ var d = ${data}; delete d.rankings; return d; })();`,
  );

  const freshEls17 = new Map<string, Record<string, unknown>>();
  for (const id of els.keys()) freshEls17.set(id, makeEl(id));
  freshEls17.set('body', makeEl('body'));
  freshEls17.set('head', makeEl('head'));
  const doc17: Record<string, unknown> = Object.assign({}, sandbox.document, {
    body: freshEls17.get('body'),
    head: freshEls17.get('head'),
    documentElement: makeEl('html'),
    getElementById: (id: string) => freshEls17.get(id) ?? null,
  });
  const sandbox17: Record<string, unknown> = Object.assign({}, sandbox, { document: doc17 });
  sandbox17.window = sandbox17;
  sandbox17.globalThis = sandbox17;
  listeners.clear();
  windowListeners.clear();
  const context17 = vm.createContext(sandbox17);
  let loadError17: Error | null = null;
  for (const [i, body] of withoutRankings.entries()) {
    try {
      new vm.Script(body, { filename: `no-rankings-${i}.js` }).runInContext(context17);
    } catch (caught) {
      loadError17 = caught as Error;
      break;
    }
  }
  const body17 = (id: string): string =>
    String((freshEls17.get(id) as { innerHTML?: string } | undefined)?.innerHTML ?? '');
  const note17 = (id: string): string =>
    String((freshEls17.get(id) as { textContent?: string } | undefined)?.textContent ?? '');
  const checks17: Array<[boolean, string]> = [
    [!loadError17, '1) the client still loads with no DATA.rankings'],
    [body17('generalBody').includes('数据面待补') && body17('monarchBody').includes('数据面待补'),
      '2) both rankings say 数据面待补 instead of staying empty'],
    [note17('generalNote').includes('数据面待补') && note17('monarchNote').includes('数据面待补'),
      '3) and their notes say it too, rather than showing a weight of NaN%'],
    [body17('generalBody').includes('colspan="12"') && body17('monarchBody').includes('colspan="11"'),
      '4) each is a single full-width row, not a broken table'],
  ];
  for (const [pass, label] of checks17) {
    if (!pass) process.exitCode = 1;
    console.log(`  ${pass ? 'OK  ' : 'WRONG'} ${label}`);
  }
  if (loadError17) console.log(loadError17.stack);
  const all17 = checks17.every(([pass]) => pass);
  console.log(`  old payload: ${checks17.filter(([pass]) => pass).length}/${checks17.length} checks ${all17 ? 'OK' : 'WRONG'}`);
}

// ------------- 18. the phone: pointer events and mobile defaults -------------
console.log('\n=== 18. phone: one finger pans, two fingers pinch ===');
{
  // 第四对话任务书.md §4.3 C3. The map listens for Pointer Events now, so a finger arrives
  // through the very same handlers a mouse does — the desktop half of that claim is section
  // 6, unchanged, and this section is the touch half: pan, pinch, cancel, the two click
  // thresholds and the two phone-only defaults. `matchMedia` reports a coarse pointer here
  // and nowhere else in this file, which is what makes it a phone.
  const freshEls18 = new Map<string, Record<string, unknown>>();
  for (const id of els.keys()) freshEls18.set(id, makeEl(id));
  freshEls18.set('body', makeEl('body'));
  freshEls18.set('head', makeEl('head'));
  (freshEls18.get('detail') as Record<string, unknown>).hidden = true;
  const doc18: Record<string, unknown> = Object.assign({}, sandbox.document, {
    body: freshEls18.get('body'),
    head: freshEls18.get('head'),
    documentElement: makeEl('html'),
    getElementById: (id: string) => freshEls18.get(id) ?? null,
  });
  const sandbox18: Record<string, unknown> = Object.assign({}, sandbox, {
    document: doc18,
    matchMedia: (query: string) => ({
      matches: query.indexOf('pointer:coarse') >= 0,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  sandbox18.window = sandbox18;
  sandbox18.globalThis = sandbox18;
  listeners.clear();
  windowListeners.clear();
  paintCalls.clear();
  lastByCanvas.clear();
  putImageDataCalls = 0;
  lastImage = null;
  const context18 = vm.createContext(sandbox18);
  let loadError18: Error | null = null;
  for (const [i, body] of scripts.entries()) {
    try {
      new vm.Script(body, { filename: `phone-${i}.js` }).runInContext(context18);
    } catch (error) {
      loadError18 = error as Error;
      break;
    }
  }
  const ok18: boolean[] = [];
  const check18 = (pass: boolean, label: string): void => {
    ok18.push(pass);
    if (!pass) process.exitCode = 1;
    console.log(`  ${pass ? 'OK  ' : 'WRONG'} ${label}`);
  };
  check18(!loadError18, '1) the client still executes on a coarse-pointer device');
  if (loadError18) {
    console.log(loadError18.stack);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  const fire18 = (key: string, event: Record<string, unknown> = {}): void => {
    for (const fn of listeners.get(key) ?? []) {
      fn(Object.assign({ preventDefault: () => {}, stopPropagation: () => {} }, event));
    }
  };
  const fireWindow18 = (type: string, event: Record<string, unknown> = {}): void => {
    for (const fn of windowListeners.get(type) ?? []) {
      fn(Object.assign({ preventDefault: () => {}, stopPropagation: () => {} }, event));
    }
  };
  const canvasEl18 = freshEls18.get('map') as { style: Record<string, string>; width: number; clientWidth: number };
  const view = (): { scale: number; x: number; y: number } => {
    const transform = canvasEl18.style.transform ?? '';
    const scale = /scale\(([\d.]+)\)/.exec(transform);
    const place = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform);
    return {
      scale: scale ? Number(scale[1]) : -1,
      x: place ? Number(place[1]) : 0,
      y: place ? Number(place[2]) : 0,
    };
  };
  const finger = (pointerId: number): Record<string, unknown> => ({ pointerType: 'touch', pointerId, isPrimary: pointerId === 1 });

  // ---- ① one finger pans -------------------------------------------------
  fire18('zoomReset:click');
  fire18('zoomIn:click');
  fire18('zoomIn:click');
  const panStart = view();
  fire18('map:pointerdown', { ...finger(1), clientX: 500, clientY: 200 });
  fireWindow18('pointermove', { ...finger(1), clientX: 460, clientY: 170 });
  const panned = view();
  fireWindow18('pointerup', { ...finger(1) });
  check18(
    Math.abs(panned.x - (panStart.x - 40)) < 0.01 && Math.abs(panned.y - (panStart.y - 30)) < 0.01 &&
      panned.scale === panStart.scale,
    `2) ① one finger pans by the same (-40,-30) the mouse does (translate ${panned.x},${panned.y})`,
  );

  // ---- ② two fingers pinch, anchored on their midpoint --------------------
  fire18('zoomReset:click');
  fire18('map:pointerdown', { ...finger(1), clientX: 400, clientY: 200 });
  fire18('map:pointerdown', { ...finger(2), clientX: 600, clientY: 200 });
  fireWindow18('pointermove', { ...finger(2), clientX: 800, clientY: 200 });
  const pinched = view();
  fireWindow18('pointerup', { ...finger(2) });
  fireWindow18('pointerup', { ...finger(1) });
  // Distance doubles (200 -> 400), so the scale must double; the anchor is the fingers'
  // current midpoint (600,200), and zoomAt() leaves the map point under it exactly where
  // it was.
  const midX = 600;
  const midY = 200;
  const anchorHeld = Math.abs((midX - 0) / 1 - (midX - pinched.x) / pinched.scale) < 0.01 &&
    Math.abs((midY - 0) / 1 - (midY - pinched.y) / pinched.scale) < 0.01;
  check18(
    Math.abs(pinched.scale - 2) < 0.001 && anchorHeld,
    `3) ② two fingers scale by the distance ratio (200 -> 400 = ${pinched.scale.toFixed(2)}x) and the midpoint stays put`,
  );

  // ---- ③ a cancelled touch leaves no gesture behind ----------------------
  fire18('zoomReset:click');
  fire18('zoomIn:click');
  fire18('zoomIn:click');
  const beforeCancel = view();
  fire18('map:pointerdown', { ...finger(1), clientX: 500, clientY: 200 });
  fire18('map:pointerdown', { ...finger(2), clientX: 700, clientY: 200 });
  fireWindow18('pointercancel', { ...finger(1) });
  fireWindow18('pointercancel', { ...finger(2) });
  // The gesture is over, so a stray move from either finger must not pan or pinch.
  fireWindow18('pointermove', { ...finger(1), clientX: 100, clientY: 100 });
  const afterCancel = view();
  check18(
    afterCancel.x === beforeCancel.x && afterCancel.y === beforeCancel.y && afterCancel.scale === beforeCancel.scale,
    '4) ③ pointercancel ends the gesture like a lift — a stray move afterwards changes nothing',
  );

  // ---- ④ the two click thresholds are really different -------------------
  // A land province in the synthetic raster, the way section 14 finds one: the same point
  // then decides the panel for a finger and for a mouse, 20px of travel apart.
  const cols18 = Math.ceil(DATA.w / 64);
  const ids18 = provinceIds as number[];
  const sea18 = new Set<number>([...(DATA.waterSea as number[]), ...(DATA.waterLakes as number[])]);
  const blockId18 = (bx: number, by: number): number => ids18[((bx + by * cols18) * 7) % ids18.length] as number;
  const blockRows18 = Math.floor(DATA.h / 64);
  let land18: { bx: number; by: number; id: number } | null = null;
  for (let by = 0; by < blockRows18 && !land18; by += 1) {
    for (let bx = 0; bx < cols18; bx += 1) {
      const id = blockId18(bx, by);
      if (id > 0 && !sea18.has(id)) { land18 = { bx, by, id }; break; }
    }
  }
  if (!land18) throw new Error('section 18: no land province in the synthetic raster');
  const halfW18 = DATA.w >> 1;
  const halfH18 = DATA.h >> 1;
  const spot = {
    x: ((land18.bx * 32 + 16) * canvasEl18.clientWidth) / halfW18,
    y: ((land18.by * 32 + 16) * (canvasEl18 as unknown as { clientHeight: number }).clientHeight) / halfH18,
  };
  const detail18 = freshEls18.get('detail') as { hidden: boolean };
  fire18('zoomReset:click');
  detail18.hidden = true;
  // Touch: 20px of travel is inside the finger's 24px slop, so this is still a tap.
  fire18('map:pointerdown', { ...finger(1), clientX: spot.x, clientY: spot.y });
  fire18('map:pointerup', { ...finger(1), clientX: spot.x + 20, clientY: spot.y });
  const touchOpened = detail18.hidden === false;
  fire18('detailClose:click');
  detail18.hidden = true;
  // Mouse: the same 20px is already a drag at the mouse's 15px slop, so no panel.
  fire18('map:pointerdown', { ...finger(1), pointerType: 'mouse', clientX: spot.x, clientY: spot.y });
  fire18('map:pointerup', { ...finger(1), pointerType: 'mouse', clientX: spot.x + 20, clientY: spot.y });
  const mouseOpened = detail18.hidden === false;
  check18(
    touchOpened && !mouseOpened,
    `5) ④ 20px is a tap for a finger (24px slop) and a drag for a mouse (15px): touch ${touchOpened ? 'opens' : 'does not open'}, mouse ${mouseOpened ? 'opens' : 'does not open'}`,
  );

  // ---- ⑤ the two phone-only defaults -------------------------------------
  const speedEl18 = freshEls18.get('speed') as { value: string };
  const speedVal18 = freshEls18.get('speedVal') as { textContent: string };
  const resEl18 = freshEls18.get('res') as { textContent: string };
  // Both were decided at load, before this section touched anything.
  const initialSpeed = String(speedEl18.value);
  const initialLabel = String(speedVal18.textContent);
  const halfCanvas = { w: DATA.w >> 1, h: DATA.h >> 1 };
  fire18('res:click');
  const resHeld = canvasEl18.width === halfCanvas.w && String(resEl18.textContent).indexOf('手机上不支持原生分辨率') >= 0;
  speedEl18.value = '10';
  fire18('speed:input');
  const hinted = String(speedVal18.textContent).indexOf('高倍速') >= 0;
  check18(
    initialSpeed === '1' && initialLabel.indexOf('1×') === 0 &&
      canvasEl18.width === halfCanvas.w && canvasEl18.style.transform !== undefined,
    `6) ⑤ the phone starts at ${initialSpeed}× (label "${initialLabel}") and on the half raster`,
  );
  check18(
    resHeld,
    `7) ⑤ 分辨率 refuses to switch on a phone: still ${canvasEl18.width}x${canvasEl18.height}, and it says "${resEl18.textContent}"`,
  );
  check18(
    hinted,
    `8) ⑤ past 8× the phone says so instead of pretending ("${speedVal18.textContent}")`,
  );

  const all18 = ok18.every(Boolean);
  console.log(`  phone: ${ok18.filter(Boolean).length}/${ok18.length} checks ${all18 ? 'OK' : 'WRONG'}`);
  if (!all18) process.exitCode = 1;
}

console.log(process.exitCode ? '\nFAILED' : '\nall player runtime checks passed');

