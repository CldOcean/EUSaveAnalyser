/**
 * Syntax guard for the site's front-end files.
 *
 * `public/app.js` is loaded as an ES module straight from disk - there is no
 * bundler and no build step to catch mistakes, so a duplicate `const` in it ships
 * as a blank, dead page. That happened once (a redeclared `id` killed the whole
 * file), and the browser only tells you in the console.
 *
 * `node --check` parses the file without running it, so this catches exactly that
 * class of error before it ever reaches a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
// viewer.js is a classic script (both hosts inline or load it the same way) and
// viewer-page.js is the hosted bootstrap; neither has a bundler behind it.
const MODULES = ['app.js', 'parser.js', 'viewer.js', 'viewer-page.js', 'viewer-data.js', 'viewer-build.js', 'viewer-store.js', 'page-theme.js', 'game-folder.js'];

for (const name of MODULES) {
  test(`${name} parses as an ES module`, () => {
    const path = `${publicDir}${name}`;
    assert.ok(existsSync(path), `${name} should exist`);
    try {
      execFileSync(process.execPath, ['--check', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const detail = String((error as { stderr?: Buffer }).stderr ?? '').trim();
      assert.fail(`${name} failed to parse:\n${detail}`);
    }
  });
}

test('the catalogue page wires every control it shows', () => {
  const html = readFileSync(`${publicDir}index.html`, 'utf8');
  const script = readFileSync(`${publicDir}app.js`, 'utf8');
  // Every id the markup defines and the script looks up must exist.
  const used = [...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((match) => match[1] as string);
  const missing = [...new Set(used)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `app.js looks up ids the page does not define: ${missing.join(', ')}`);
  // And the module must tell the boot watchdog it came up.
  assert.ok(script.includes('window.__appReady'), 'app.js should signal that it initialised');
  assert.ok(html.includes('type="module"'), 'the page must load app.js as a module');
});

test('the viewer script only touches controls its markup defines', () => {
  // The analogue of the catalogue check above, and it exists because the real bug got
  // through: viewer.js asked for `miDark`, a control deleted from the markup in an
  // earlier redesign. On the real page the lookup returned null and addEventListener
  // threw, which silently killed every line after it — no flags, dead 旗帜 toggle —
  // while the DOM-stub harness stayed green because it fabricated missing elements.
  const markup = readFileSync(`${publicDir}viewer.html`, 'utf8');
  const defined = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] as string));
  const client = readFileSync(`${publicDir}viewer.js`, 'utf8');
  const used = [...client.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1] as string);
  const missing = [...new Set(used)].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `viewer.js looks up ids the markup does not define: ${missing.join(', ')}`);
  // The viewer's settings panel is gone: ⚙, #panel1..#panel3 and the wallpaper controls
  // all belong to the shared component now, so the markup must not carry them any more
  // (a leftover copy would be a second, dead settings surface) and the component must be
  // the thing that owns them.
  const shared = readFileSync(`${publicDir}page-theme.js`, 'utf8');
  for (const id of ['settings', 'panel1', 'panel2', 'panel3', 'bgA', 'bgB', 'bgDim', 'bgList', 'dimRange', 'dimVal', 'bgInterval']) {
    assert.ok(!defined.has(id), `#${id} belongs to page-theme.js now, not to viewer.html`);
  }
  for (const owned of ["button.id = 'pageThemeBtn'", "panel.id = 'pageThemePanel'", 'export async function mountPageTheme']) {
    assert.ok(shared.includes(owned), `page-theme.js should own ${owned}`);
  }
  assert.ok(
    client.includes('globalThis.mountPageTheme'),
    'viewer.js should mount the shared component instead of drawing its own panel',
  );
  assert.ok(
    !/bgLayers|bgListEl|themeSlate/.test(client),
    'the viewer must not keep a second copy of the wallpaper carousel or the theme buttons',
  );
});

test('the catalogue can open a viewer for a save with no pre-generated page', () => {
  const script = readFileSync(`${publicDir}app.js`, 'utf8');
  // The whole point of the hosted viewer: upload is enough. A card whose record has
  // no `viewer` must still offer a working link, and it must not be disabled.
  assert.ok(script.includes('viewer.html?id='), 'the card should link to the hosted viewer');
  assert.ok(
    !/class="view"[^>]*disabled/.test(script),
    'the view button must never be disabled: the browser builds the page on demand',
  );
  const html = readFileSync(`${publicDir}viewer.html`, 'utf8');
  assert.ok(html.includes('<script src="paint.js"></script>'), 'viewer.html should load the painter');
  // Loaded as a module on purpose: viewer-page.js imports the parser and builder,
  // and a classic <script> would refuse to parse it — a blank page with only a
  // console error, which is exactly the failure this file exists to catch.
  assert.ok(
    html.includes('<script type="module" src="viewer-page.js"></script>'),
    'viewer.html should load the bootstrap as a module',
  );
  const page = readFileSync(`${publicDir}viewer-page.js`, 'utf8');
  assert.ok(/^import\s/m.test(page), 'the bootstrap should really be a module');
});

test('the launchers are CRLF and stay ASCII-safe', () => {
  // cmd mis-parses an LF-only .bat (it has silently broken these before: arguments
  // were lost and a stray token was read as a command), and the established
  // convention is that the console prints ASCII only — Chinese text kills the batch
  // under chcp 65001, so it goes to a file for Notepad instead.
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const launchers = ['启动网站.bat', '生成查看页.bat', '解析存档.bat', '检查部署.bat', '修复存档数据.bat'];
  for (const name of launchers) {
    const path = `${root}${name}`;
    assert.ok(existsSync(path), `${name} should exist`);
    const text = readFileSync(path, 'utf8');
    const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
    assert.equal(lfOnly, 0, `${name} has ${lfOnly} LF-only line ending(s); cmd needs CRLF`);
    // The comments *mention* chcp to explain why it is avoided, so look for a real
    // command line, not the word.
    assert.ok(!/^\s*chcp\b/im.test(text), `${name} must not switch the code page`);
  }
  // The one launcher whose output is a report file must actually write it.
  const deployCheck = readFileSync(`${root}检查部署.bat`, 'utf8');
  assert.ok(deployCheck.includes('verify-deploy.ts'), '检查部署.bat should run the deploy gate');
  assert.ok(deployCheck.includes('tmp\\deploy-check.txt'), '检查部署.bat should write a report file');
});

test('the detail sheet belongs to the viewer page alone', () => {
  // The province/country sheet is the viewer's, and so is the 🎨 面板 slider that fades it.
  // The catalogue mounts the same shared component without `detailPanel`, so it must never
  // grow a control that drives a surface it does not have — and the sheet's ids must exist in
  // exactly one place, the shared markup both hosts render, rather than in either host's JS.
  const markup = readFileSync(`${publicDir}viewer.html`, 'utf8');
  for (const id of ['hover', 'detail', 'detailBody', 'detailTitle', 'detailBack', 'detailClose', 'mapFull']) {
    assert.ok(markup.includes(`id="${id}"`), `#${id} is the viewer's markup contract`);
  }
  const catalogue = readFileSync(`${publicDir}app.js`, 'utf8');
  assert.ok(
    catalogue.includes('mountPageTheme().catch'),
    'the catalogue mounts the component with no options, so it gets no 面板 row',
  );
  assert.ok(
    !catalogue.includes('detailPanel'),
    'and it must never ask for the viewer-only row',
  );
  const viewer = readFileSync(`${publicDir}viewer.js`, 'utf8');
  assert.ok(
    viewer.includes('mountPageTheme({ wallpapers: BG, detailPanel: true })'),
    'the viewer is the host that turns the row on',
  );
  // The sheet has to live inside #view: that wrapper owns the pan/zoom transform and clips
  // the map, so a sheet parented anywhere else escapes the map's box.
  const view = /<div class="view" id="view">([\s\S]*?)<div class="bar">/.exec(markup)?.[1] ?? '';
  assert.ok(view.includes('id="detail"'), '#detail must be inside #view');
  assert.ok(
    /<canvas id="hover" width="5632" height="2048">/.test(view),
    '#hover must be the map canvas\'s twin inside #view',
  );
});

test('a card never offers to build a viewer it already has', () => {
  // The mismatch that was actually seen: stored data existed, but the label still said
  // 在浏览器中生成. Label and link must therefore come from one decision function.
  const script = readFileSync(`${publicDir}app.js`, 'utf8');
  assert.ok(
    /const viewerState = \(save\) => \(save\.viewerData \? 'stored' : save\.viewer \? 'page' : 'none'\)/.test(script),
    'the three viewer states should be decided in one place, with stored data first',
  );
  assert.ok(
    script.includes(
      'const viewerHref = (save) =>\n    save.viewerData || !save.viewer ? `viewer.html?id=${encodeURIComponent(save.id)}` : save.viewer;',
    ),
    '「生成查看页」 must open the hosted page whenever the archive holds the data or nothing else exists',
  );
  assert.ok(script.includes('${viewerLabel(save)}'), 'the button label should come from that decision');
  assert.ok(script.includes('location.href = viewerHref(save)'), 'and so should the link');
  // A pre-generated page is never silently preferred any more: the offline page has no
  // server, so it cannot show or edit the archive metadata (📝) the user went looking for.
  assert.ok(
    !/save\.viewer \|\| `viewer\.html\?id=/.test(script),
    'the self-contained page must not be the first choice for 「生成查看页」',
  );
  // The re-parse button doubles as "rebuild the viewer data", so it must always show.
  assert.ok(
    /class="reparse" title="[^"]*"/.test(script) && !/class="reparse"[^>]*hidden/.test(script),
    '重新解析 must stay visible: it is also how an older save gets its viewer data',
  );
  assert.ok(script.includes('>重新解析</button>'), 'the re-parse button is labelled exactly 重新解析');
  assert.ok(script.includes(": '生成查看页';"), 'a ready viewer is labelled exactly 生成查看页');
});

test('the offline page stays reachable as a secondary card action', () => {
  // The other half of the trade above: the primary action (now 「生成查看页」) opens the
  // hosted page, so the single file that still works offline and by double-click keeps
  // its own quiet entry — labelled 「查看」 (user's naming, 2026-09-19: names only, the
  // behaviour of both entries is unchanged).
  const script = readFileSync(`${publicDir}app.js`, 'utf8');
  assert.ok(script.includes('class="offline"'), 'the card should offer the offline page');
  assert.ok(
    /class="offline"[^>]*target="_blank"/.test(script),
    'the offline page opens in its own tab, never replacing the catalogue',
  );
  assert.ok(script.includes('改不了存档信息'), 'its tooltip must say what it cannot do');
  assert.ok(script.includes('>查看</a>'), 'the secondary link is labelled exactly 查看');
  assert.ok(script.includes("'生成查看页'"), 'the primary action is labelled exactly 生成查看页');
  // Only a save that actually has one offers it, and it lives in the action row beside
  // the primary button rather than somewhere the card does not otherwise use.
  assert.ok(/if \(!save\.viewer\) return '';/.test(script), 'no offline page, no offline link');
  const actions = script.slice(script.indexOf('<div class="actions">'));
  assert.ok(actions.includes('${offlineMarkup(save)}'), 'the link belongs to the card action row');
  const css = readFileSync(`${publicDir}style.css`, 'utf8');
  assert.ok(css.includes('.card .actions .offline'), 'the quiet link needs its own styling');
});

test('the catalogue card shows the customisable form the user asked for', () => {
  // The card is now: title (click = rename) / map thumbnail / protagonist flags with
  // "player-country" captions / end date / version / mods, with everything the old card
  // showed demoted to small print. These assertions pin each of those decisions, because
  // none of it is covered by a runtime test and a silent regression here is invisible.
  const html = readFileSync(`${publicDir}index.html`, 'utf8');
  const script = readFileSync(`${publicDir}app.js`, 'utf8');
  // The flag toggle sits immediately left of the sort dropdown, as specified.
  const flagAt = html.indexOf('id="flagSet"');
  const sortAt = html.indexOf('<label class="sort">');
  assert.ok(flagAt > 0 && sortAt > flagAt, 'the flag toggle must come before the sort dropdown');
  // Title rename: prompt, PATCH of just the title, and an in-memory redraw.
  assert.ok(script.includes('prompt('), 'renaming should use the same prompt() as the upload token');
  assert.ok(script.includes('JSON.stringify({ custom: { title } })'), 'the rename should PATCH only custom.title');
  assert.ok(/if \(data\.save\) save\.custom = data\.save\.custom/.test(script), 'the record should be patched in memory');
  assert.ok(script.includes("'未授权：请在 ⚙ 里填入上传口令'"), 'a refused write must point at the upload token');
  // The flag artwork source is shared with the viewer through one settings key.
  assert.ok(/import \{[^}]*loadSettings[^}]*saveSettings[^}]*\} from '\.\/page-theme\.js'/.test(script), 'both settings helpers should be imported');
  assert.ok(script.includes('loadSettings().flagSet'), 'the stored flag set should be the starting value');
  assert.ok(script.includes('saveSettings({ flagSet: state.flagSet })'), 'toggling must persist to the shared key');
  assert.ok(script.includes('/assets/flags/') && script.includes('state.flagSet'), 'flags come from the base/modded prefixes');
  // Thumbnail, with the two fallbacks and the ratio that keeps the grid aligned.
  assert.ok(script.includes('/viewer/thumb.png'), 'the card should point at the stored thumbnail');
  assert.ok(/thumb\.remove\(\)/.test(script) && /classList\.add\('missing'\)/.test(script), 'a missing thumbnail is hidden, not broken');
  const css = readFileSync(`${publicDir}style.css`, 'utf8');
  assert.ok(css.includes('aspect-ratio:704/256'), 'the thumbnail needs a fixed ratio so cards do not jump');
  // Protagonists: three per page, a two-line caption, with a TAG fallback.
  assert.ok(script.includes('HERO_PER_PAGE = 3'), 'one page of the flag strip holds three protagonists');
  assert.ok(script.includes('class="capLine"'), 'the caption is drawn one line per field, not as one string');
  assert.ok(script.includes('heroFallback') && script.includes('figure.getAttribute'), 'a missing flag falls back to the TAG');
  // Country names come from the cached table, and the tag is the fallback.
  assert.ok(/cachedTables\(\)/.test(script) && /localise\(names, tag\)/.test(script), 'names come from the cached localisation table');
  // The old fields survive in small print.
  assert.ok(script.includes('class="secondary"'), 'the previously shown numbers should stay as small print');
});

test('the card carries 封档日期 and pages through more than three protagonists', () => {
  // Requirement 2 (the card row and both sort keys) and 4 (flag paging) of the fourth and
  // third rounds. None of it is reachable from a runtime test, and a silent regression
  // here would only be visible in a browser, so each decision is pinned statically.
  const html = readFileSync(`${publicDir}index.html`, 'utf8');
  const script = readFileSync(`${publicDir}app.js`, 'utf8');
  const css = readFileSync(`${publicDir}style.css`, 'utf8');

  // 封档日期 sits directly under 结档日期, falling back to the upload date and reduced to
  // the same YYYY-MM-DD shape either way, so the two rows can never disagree about
  // whether they carry a time of day.
  const endRow = script.indexOf('<dt>结档日期</dt>');
  const sealRow = script.indexOf('<dt>封档日期</dt>');
  assert.ok(endRow > 0 && sealRow > endRow, '封档日期 must be the row below 结档日期');
  assert.ok(
    script.includes('sealedDay(custom.sealedAt) || sealedDay(save.uploadedAt)'),
    'an empty 封档日期 falls back to the upload date',
  );
  assert.ok(
    !script.includes('封档时间'),
    'the label is 封档日期 everywhere: the old 封档时间 wording promised a time of day',
  );

  // Both new sort keys are offered, and the old option is relabelled - it was always
  // the same date. The old *value* stays understood, because localStorage still holds it.
  assert.ok(html.includes('<option value="endDate">结档日期</option>'), 'the sort dropdown must offer 结档日期');
  assert.ok(html.includes('<option value="sealedAt">封档日期</option>'), 'the sort dropdown must offer 封档日期');
  assert.ok(!html.includes('战役日期'), 'the old wording is gone');
  assert.ok(script.includes("SORT_ALIASES = { date: 'endDate' }"), 'a stored old value still selects the right option');

  // Paging: both arrows exist, only when there is a second page, disabled at the edges,
  // and turning a page redraws this card's strip rather than the whole list.
  assert.ok(script.includes('class="page prev"') && script.includes('class="page next"'), 'both arrows must exist');
  assert.ok(script.includes("current === 0 ? ' disabled' : ''"), 'the left arrow is disabled on the first page');
  assert.ok(script.includes("current === pages - 1 ? ' disabled' : ''"), 'the right arrow is disabled on the last page');
  assert.ok(script.includes('const paged = pages > 1;'), 'three or fewer protagonists get no arrows at all');
  assert.ok(script.includes('Math.ceil(items.length / HERO_PER_PAGE)'), 'the page count is ceil(n/3)');
  assert.ok(
    script.includes('pager.innerHTML = heroPagerInner(save, current, colonialLedgers.get(save.id) || null)'),
    'a page turn redraws the flag strip only, keeping the list order and the scroll position',
  );
  assert.ok(css.includes('.card .heroPager .page'), 'the arrows need their own styling');

  // A colonial protagonist is drawn as its mother country's flag with the colony's own
  // colour over the right half — the composite flags under assets/flags/colonial* are
  // gone, and the ledger the parent comes from is read back per save. The structure and
  // the colour algorithm itself are pinned in the dedicated test below.
  assert.ok(
    !script.includes('FLAG_COLONIAL_DIR') && !script.includes('colonial-modded'),
    'the build-time colonial composites must not be referenced any more',
  );
  assert.ok(
    script.includes('colonialParents') && script.includes('loadStoredSave'),
    'a card reads the colony ledger back from the save it is showing',
  );
  assert.ok(
    script.includes("img.dataset.heroBound === '1'"),
    'a flag is wired up once: wiring it twice would defeat the fallback retry',
  );

  // Frosted navigation bar: one shared recipe, one tint per theme, opaque fallback.
  assert.ok(css.includes('backdrop-filter:blur(18px) saturate(1.4)'), 'the agreed acrylic recipe');
  assert.ok(css.includes('-webkit-backdrop-filter:blur(18px) saturate(1.4)'), 'WebKit needs its own prefix');
  assert.equal((css.match(/--nav-glass:/g) ?? []).length, 4, 'each of the four themes defines a frosted tint');
  assert.ok(css.includes('@supports not'), 'without backdrop-filter the opaque colour has to come back');
});

test('the protagonist caption is two lines: the player, then the country', () => {
  // The requirement behind it: "玩家名字-国家名字" on one line ran out of room, and the
  // country is the part that has to stay readable. There is no runtime test for a card
  // (it needs a browser), so the three decisions are pinned here.
  const script = readFileSync(`${publicDir}app.js`, 'utf8');
  const css = readFileSync(`${publicDir}style.css`, 'utf8');

  // Line one is the player and only exists when there is a player; line two is always the
  // country, so an empty player name leaves no blank line and no bare "-".
  const lines = script.slice(script.indexOf('const lines ='), script.indexOf("'</figure>'"));
  assert.ok(
    lines.includes('player ? `<span class="capLine">${escapeHtml(player)}</span>` : \'\''),
    'the player line is conditional: empty means absent, not blank',
  );
  assert.ok(
    lines.includes('`<span class="capLine">${escapeHtml(name)}</span>`'),
    'the country line is drawn unconditionally',
  );
  assert.ok(
    !lines.includes("player}-${name}`") && !/capLine[^\n]*-\$\{/.test(lines),
    'no line is glued together with a hyphen any more',
  );

  // Each line ellipsises on its own (the old caption was one clipped line), and the full
  // "player-country" text stays in the tooltip.
  assert.ok(script.includes('title="${escapeHtml(caption)}"'), 'the whole caption stays reachable as the tooltip');
  assert.ok(script.includes('const caption = player ? `${player}-${name}` : name;'), 'the tooltip text is the old caption');
  assert.ok(
    /\.card \.hero figcaption\{[^}]*flex-direction:column/.test(css),
    'the two lines stack inside the caption',
  );
  assert.ok(
    /\.card \.hero figcaption \.capLine\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/.test(css),
    'a long name must be truncated rather than widen the card',
  );
});

test('a colonial flag is the mother country\'s artwork with a right-half block, on both pages', () => {
  // The user's rule (2026-09-19): a colonial nation has no artwork of the game, so it
  // borrows its mother country's flag and gets its own colour over the right half. It is
  // drawn in the DOM — no generated PNG, no canvas — because a file:// page cannot write
  // one, and because the parent must be read from *this* save: one dynamic tag (C11) is a
  // different country in every campaign. All four render points share one structure.
  //
  // There is no runtime test for a card (it needs a browser) and the viewer's runtime half
  // lives in scripts/verify-player-run.ts, so the contract is pinned statically here.
  const script = readFileSync(`${publicDir}app.js`, 'utf8');
  const client = readFileSync(`${publicDir}viewer.js`, 'utf8');
  const markup = readFileSync(`${publicDir}viewer.html`, 'utf8');
  const css = readFileSync(`${publicDir}style.css`, 'utf8');

  // The frozen structure: the image inside a positioned wrapper, the block absolutely
  // placed over the right half of it.
  const CORE = '.flagBox{position:relative;display:inline-block;line-height:0';
  const TINT = '.flagTint{position:absolute;left:50%;top:0;width:50%;height:100%;pointer-events:none}';
  assert.ok(markup.includes(CORE), 'the viewer needs the wrapper rule, byte for byte as frozen');
  assert.ok(markup.includes(TINT), 'and the right-half block rule');
  assert.ok(css.includes(CORE), 'the catalogue card draws the same wrapper');
  assert.ok(css.includes(TINT), 'and the same right-half block');
  assert.ok(/\.flagBox>img\{display:block\}/.test(markup + css), 'the image fills the wrapper');

  // Both pages build the same markup: the wrapper around the image, the block only for a
  // colony, and the block's colour from the shared algorithm written out on the client.
  for (const [name, source] of [['app.js', script], ['viewer.js', client]] as const) {
    assert.ok(source.includes('class="flagBox"'), `${name} must wrap a flag in .flagBox`);
    assert.ok(source.includes('class="flagTint"'), `${name} must draw the right-half block`);
    assert.ok(source.includes('function flagFill(tag)'), `${name} must carry the shared colour algorithm`);
    assert.ok(/Math\.imul\(h, 0x85ebca6b\)/.test(source), `${name} must mix the hash bits (fmix32) before taking a hue`);
    assert.ok(/0\.6/.test(source) && /0\.45/.test(source), `${name} must keep the frozen HSL parameters`);
  }

  // The parent comes from the save, never from the tag: app.js reads the ledger out of the
  // save's own viewer data, the viewer reads DATA.colonialParent. Neither guesses a family
  // from the C##/D## spelling any more.
  assert.ok(client.includes('DATA.colonialParent'), 'the viewer takes the parent from the data plane');
  assert.ok(!client.includes('FLAG_COLONIAL'), 'the build-time composite path is gone from the viewer');
  assert.ok(!/COLONIAL_TAG/.test(script), 'the card no longer guesses a colony from its tag spelling');
  assert.ok(
    script.includes('colonialParent') && script.includes('loadStoredSave'),
    'the card reads the colony ledger back from the viewer data it stored',
  );
  // A failure is still a TAG block on the card, never a broken image.
  assert.ok(
    script.includes("block.className = 'heroFallback'") && script.includes('img.replaceWith(block)'),
    'a flag with no artwork still becomes the TAG block',
  );
  // And the artwork set stays a property of the button, not of the colony: the block is
  // only ever coloured by flagFill(tag).
  assert.ok(
    script.includes('tint.style.background = flagFill(tag)'),
    'the card colours the block from the tag, never from the artwork set',
  );

  // The card's copy of the algorithm really is the build side's: these are the hexes the
  // frozen `hashColor` (fmix32 then hslToRgb(h % 360, 0.6, 0.45)) and the preview page
  // print for the same tags. A drift here would paint one colony two colours on two pages.
  const fn = /function flagFill\(tag\) \{[\s\S]*?\n  \}/.exec(script)?.[0] ?? '';
  assert.ok(fn !== '', 'the card should carry the flagFill function');
  const flagFill = (new Function(`${fn}\nreturn flagFill;`)() as (tag: string) => string);
  assert.equal(flagFill('C00'), '#b82e4c', 'C00 must keep the build side\'s hue');
  assert.equal(flagFill('C11'), '#2eb8a3', 'C11 must keep the build side\'s hue');
  assert.equal(flagFill('BRZ'), '#372eb8', 'BRZ must match tmp/colonial-preview.html exactly');
  // Distinct hues, not the old "everything is yellow" collapse.
  const hues = ['C00', 'C09', 'C11', 'C17', 'D05'].map(flagFill);
  assert.equal(new Set(hues).size, hues.length, 'nearby colonial tags must not share one colour');
});

test('the bottom tables declare their own sortable contract', () => {
  // 第四对话任务书.md §3.3: the user asked for "所有类似列表" to sort from their header. The
  // three host tables are the *host's* markup and the two rankings are drawn by the client
  // (§3.6) — but all five are in the shared markup, so what they declare here is the only
  // thing the sorter has to go on: a table with no data-sortable is silently unsortable and a
  // column with no data-sort is silently excluded, neither visible until someone clicks.
  const markup = readFileSync(`${publicDir}viewer.html`, 'utf8');
  const client = readFileSync(`${publicDir}viewer.js`, 'utf8');
  const bottom: Array<[string, string, number]> = [
    ['leaderBody', 'leader', 9],
    ['cityBody', 'city', 5],
    ['institutionBody', 'institution', 5],
    ['generalBody', 'general', 12],
    ['monarchBody', 'monarch', 11],
  ];
  for (const [id, name, columns] of bottom) {
    const table = new RegExp(
      `<table data-sortable data-table="${name}"><thead><tr>([\\s\\S]*?)</tr></thead>\\s*<tbody id="${id}">`,
    ).exec(markup);
    assert.ok(table, `#${id} must sit in a <table data-sortable data-table="${name}">`);
    const heads = [...(table?.[1] ?? '').matchAll(/<th([^>]*)>/g)].map((match) => match[1] as string);
    assert.equal(heads.length, columns, `#${id} should declare ${columns} columns`);
    // The "#" column is the rank the renderer computed: it sorts nothing and is never rewritten.
    assert.ok(!/data-sort=/.test(heads[0] as string), `the # column of #${id} must stay unsortable`);
    assert.ok(
      heads.slice(1).every((attrs) => /data-sort="(num|date|text)"/.test(attrs)),
      `every other column of #${id} must declare its type`,
    );
  }
  // The two rankings are the client's own tables, so their headings and the two notes the
  // weights/coverage are written into are part of the same frozen markup contract.
  assert.ok(markup.includes('<h2>历史十五个最优秀将军 · 综合评分</h2>'), 'the generals heading is frozen');
  assert.ok(markup.includes('<h2>十五个最优秀君主 · 综合评分</h2>'), 'the monarchs heading is frozen');
  for (const id of ['generalNote', 'monarchNote']) {
    assert.ok(markup.includes(`id="${id}"`), `#${id} is where rankings.meta is written`);
  }
  // The sorter is one implementation, driven only by those two attributes.
  for (const piece of ['function makeSortable(', 'function applyStoredSort(', "'data-sort-bound'", 'aria-sort']) {
    assert.ok(client.includes(piece), `viewer.js should carry the shared sorter (${piece})`);
  }
  // And the host's rows are never second-guessed: the three bodies get the packed string as
  // it is, and the client builds no row of its own for them.
  const fillAt = client.indexOf('const bodies = {');
  const sorterAt = client.indexOf('// ---- one generic sorter');
  assert.ok(fillAt > 0 && sorterAt > fillAt, 'the host tables are filled before the sorter is installed');
  const fill = client.slice(fillAt, sorterAt);
  assert.ok(fill.includes("el.innerHTML = bodies[id] || ''"), 'the host table HTML is copied verbatim');
  assert.ok(!/<t[rd][ >]/.test(fill), 'the client must not rebuild the host tables row by row');
  // A panel table that is rebuilt on every render needs a stable name to remember its sort
  // under, so each one declares data-table. This is the §3.3 list, plus the heirs table.
  const panelNames = [...client.matchAll(/data-sortable data-table="([A-Za-z]+)"/g)].map((match) => match[1] as string);
  for (const name of [
    'rulers', 'leaders', 'states', 'history', 'culture', 'religion', 'budget', 'mana',
    'improve', 'tradecompany', 'area', 'estates',
  ]) {
    assert.ok(panelNames.includes(name), `the panel's ${name} table must be sortable too`);
  }
});

test('the viewer page declares the phone contract', () => {
  // 第四对话任务书.md §4.3 C3. Without a viewport meta a phone renders the desktop layout
  // shrunk to fit and nothing is tappable — the catalogue page has had one all along, and
  // this is the viewer catching up. The rest of the phone behaviour lives in one media
  // query and in the Pointer Events the client listens for, so both are pinned here too:
  // a layout rule that escaped the query would change desktop pixels.
  const markup = readFileSync(`${publicDir}viewer.html`, 'utf8');
  const client = readFileSync(`${publicDir}viewer.js`, 'utf8');
  assert.ok(
    markup.includes('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'),
    'viewer.html must carry the frozen viewport meta',
  );
  const phone = /@media \(pointer:coarse\), \(max-width:820px\) \{([\s\S]*?)\n\s*\}/.exec(markup)?.[1] ?? '';
  assert.ok(phone !== '', 'the phone rules must live in one (pointer:coarse)/(max-width:820px) block');
  for (const rule of [
    '#detail,#detail.country{position:fixed',
    '.dTabs{flex-wrap:nowrap;overflow-x:auto',
    '.tableScroll{overflow-x:auto',
    'svg#chart{height:380px !important}',
    'min-height:40px',
  ]) {
    assert.ok(phone.includes(rule), `the phone block should carry ${rule}`);
  }
  // It has to be the *last* block in the sheet, or the equal-specificity desktop rules
  // above it would win the tie and the phone would keep desktop padding.
  assert.ok(
    markup.indexOf('@media (pointer:coarse)') > markup.indexOf('.player.screen .bar'),
    'the phone rules must come after the desktop rules they override',
  );
  // The five bottom tables get their own scroll wrapper — a table cannot scroll itself.
  assert.equal((markup.match(/<div class="tableScroll">/g) ?? []).length, 5, 'one scroll wrapper per bottom table');
  // And the map listens for pointers, not mice: one finger must be able to pan it.
  for (const piece of [
    "canvas.addEventListener('pointerdown'",
    "window.addEventListener('pointermove'",
    "window.addEventListener('pointercancel'",
    'TOUCH_DRAG_SLOP = 24',
  ]) {
    assert.ok(client.includes(piece), `viewer.js should carry the pointer wiring (${piece})`);
  }
  assert.ok(
    !/canvas\.addEventListener\('(mousedown|mousemove|mouseup)'/.test(client) &&
      !/window\.addEventListener\('(mousedown|mousemove|mouseup)'/.test(client),
    'the map must not keep a second, mouse-only copy of its drag logic',
  );
  assert.ok(
    client.includes('resBtn.textContent = MOBILE_RES_TEXT'),
    'a phone that asks for the native raster gets the sentence, not a switch',
  );
  assert.ok(
    client.includes("if (isCoarsePointer()) speedEl.value = '1';"),
    'a phone starts at 1×, and the desktop keeps the markup 3×',
  );
});

test('the dev server refuses to let stale code be cached', () => {
  // An old app.js in the browser cache is indistinguishable from a missing feature.
  const server = readFileSync(fileURLToPath(new URL('../src/dev-server.ts', import.meta.url)), 'utf8');
  assert.ok(server.includes('CODE_EXTENSIONS'), 'the dev server should know which files are code');
  assert.ok(server.includes("headers['cache-control'] = 'no-cache'"), 'code and markup must not be cached');
});

test('the catalogue builds the viewer data as part of the upload', () => {
  // The design decision: generate once at upload and store it, so opening a viewer is
  // instant and there is no longer a "has a viewer" and "has no viewer" kind of save.
  const script = readFileSync(`${publicDir}app.js`, 'utf8');
  assert.ok(script.includes('buildForSave'), 'app.js should build the data itself');
  assert.ok(script.includes('storeBuiltSave'), 'app.js should store what it built');
  assert.ok(
    /await generateViewerData\(id, new Uint8Array\(buffer\), file\.name\)/.test(script),
    'the upload path should generate after parsing',
  );
  // A failure to build must not read as a failed upload.
  assert.ok(
    /catch \(error\) \{\s*\/\/ Never a failed upload/.test(script) || script.includes('不是失败的上传') || script.includes('已加入目录，但查看页数据生成失败'),
    'a build failure must be reported without pretending the upload failed',
  );
  // The viewer reads the stored data back before falling back to building.
  const page = readFileSync(`${publicDir}viewer-page.js`, 'utf8');
  const storedAt = page.indexOf('loadStoredSave(id)');
  const buildAt = page.indexOf('buildForSave(');
  assert.ok(storedAt > 0 && buildAt > storedAt, 'the stored data must be tried before building');
  const store = readFileSync(`${publicDir}viewer-store.js`, 'utf8');
  assert.ok(store.includes("'viewer/data.json'") && store.includes("'viewer/raster.png'"), 'the stored paths are fixed');
  assert.ok(store.includes('canvas.toBlob'), 'the raster must be stored as real PNG bytes, not a data URI');
});

test('the hosted viewer asks the archive for exactly what it needs', () => {
  const page = readFileSync(`${publicDir}viewer-page.js`, 'utf8');
  // The save comes back through the same endpoint the catalogue uses, and the id is
  // escaped: a record id is opaque and may contain characters that break a URL.
  assert.ok(page.includes('/api/saves/${encodeURIComponent(id)}/original'), 'the bootstrap should fetch the original');
  // Every global the player reads must be installed before the player script is
  // added, or the page loads and does nothing.
  const setupAt = page.indexOf('globalThis.DATA');
  const loadAt = page.indexOf("loadScript('viewer.js')");
  assert.ok(setupAt > 0 && loadAt > setupAt, 'the player must load after its data is installed');
  for (const global of ['DATA', 'RASTER', 'BG', 'ALIAS', 'VIEWER_FACTS', 'VIEWER_PANELS', 'VIEWER_ASSETS']) {
    assert.ok(page.includes(`globalThis.${global}`) || page.includes(`globalThis.${global} =`), `the bootstrap should set ${global}`);
  }
  // The shared background/theme component is a global the player reads as well, so it has
  // to be imported and copied onto globalThis before viewer.js is added. The generated
  // page reaches the same state by inlining page-theme.js above the player, which is why
  // the player can read one set of names on both hosts (scripts/render-timeline.ts).
  const themeAt = page.indexOf("await import('./page-theme.js')");
  assert.ok(themeAt > 0 && themeAt < loadAt, 'the shared component must be installed before the player loads');
  for (const global of ['mountPageTheme', 'loadSettings', 'saveSettings']) {
    assert.ok(page.includes(`globalThis.${global} =`), `the bootstrap should expose ${global}`);
  }
  const player = readFileSync(`${publicDir}viewer.js`, 'utf8');
  assert.ok(player.includes('globalThis.mountPageTheme'), 'the player should mount the shared component');
});
