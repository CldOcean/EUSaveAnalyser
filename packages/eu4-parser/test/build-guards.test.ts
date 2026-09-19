/**
 * Guards for the generated single-file player.
 *
 * The browser player's markup lives inside a template literal in
 * `scripts/render-timeline.ts` so it can be inlined into one self-contained HTML
 * file. That has one sharp edge: a backtick anywhere inside the template — even in
 * a comment — ends it early and the rest of the file is parsed as TypeScript. It
 * has silently broken the build three times, always with a confusing syntax error,
 * so it is checked statically here (read as text, so this works even when the
 * script no longer parses).
 *
 * The client *code* no longer lives in that template: it is
 * `apps/site/public/viewer.js`, interpolated as a string, which is why a literal
 * `</script>` in it would still end the block early in the generated HTML — and why the
 * backtick ban is now checked rather than remembered: three separate incidents came from
 * a stray backtick in that file, and nobody can see one in a 1300-line diff.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../scripts/render-timeline.ts', import.meta.url));
const CLIENT = fileURLToPath(new URL('../../../apps/site/public/viewer.js', import.meta.url));
const MARKUP = fileURLToPath(new URL('../../../apps/site/public/viewer.html', import.meta.url));
/** The shared background/theme component, inlined into the generated page. */
const THEME = fileURLToPath(new URL('../../../apps/site/public/page-theme.js', import.meta.url));
/** The hosted bootstrap, the only host that knows the catalogue record exists. */
const BOOTSTRAP = fileURLToPath(new URL('../../../apps/site/public/viewer-page.js', import.meta.url));

test('the shared markup is a valid page on its own', () => {
  // The markup used to live in a template literal in the generator, where a stray
  // backtick ended it early (that broke the build three times). It is a real file
  // now: served as-is it is the hosted viewer, and the generator swaps only its
  // script tail for the inline scripts of the standalone file.
  const markup = readFileSync(MARKUP, 'utf8');
  assert.deepEqual(
    [...markup.matchAll(/\$\{[^}]*\}/g)].map((m) => m[0]),
    [],
    'the markup must be servable as-is: no interpolation tokens',
  );
  assert.ok(markup.includes('<!-- HOST_SCRIPTS:'), 'the hosted tail marker should be present');
  assert.ok(markup.includes('<script src="paint.js"></script>'), 'the hosted page should load the painter');
  // The bootstrap uses `import`, so it MUST be a module: as a classic script the
  // browser refuses to parse it and the page silently does nothing at all.
  assert.ok(
    markup.includes('<script type="module" src="viewer-page.js"></script>'),
    'viewer-page.js is an ES module and must be loaded as one',
  );
  // The generator must swap that exact block, or the offline page ships two players.
  const source = readFileSync(SCRIPT, 'utf8');
  assert.ok(source.includes('HOSTED_TAIL'), 'the generator should replace the hosted tail');
  assert.ok(source.includes('replace(HOSTED_TAIL'), 'the generator should key on the hosted tail');
});

test('the player template interpolates the shared client script', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  // The client was extracted so both hosts run one file; without this the offline
  // HTML would silently ship a player with no behaviour at all.
  assert.ok(source.includes("readFileSync('apps/site/public/viewer.js', 'utf8')"), 'VIEWER_SOURCE should be read from the shared asset');
  const tail = source.slice(source.indexOf('const hostScripts = ['), source.indexOf('].join', source.indexOf('const hostScripts = [')));
  for (const name of ['PAINT_SOURCE', 'THEME_SOURCE', 'VIEWER_SOURCE']) {
    assert.ok(tail.includes(name), `the host script tail should include ${name}`);
  }
  // The theme component must come *before* the player: it is what makes mountPageTheme a
  // global on the generated page, and the player mounts it on load.
  assert.ok(
    tail.indexOf('THEME_SOURCE') < tail.indexOf('VIEWER_SOURCE'),
    'the shared background/theme component should be inlined above the player',
  );
  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(client.includes('DATA.provinceFields'), 'the asset should be the client script');
});

test('the shared background/theme asset cannot end its own script block', () => {
  // It is inlined as a classic script (with `export ` stripped) on the generated page, so
  // the same two rules the client follows apply to it.
  const theme = readFileSync(THEME, 'utf8');
  assert.ok(!theme.includes('</script'), 'a literal </script> would close the tag in the generated HTML');
  assert.ok(/^export (async )?function mountPageTheme/m.test(theme), 'mountPageTheme must stay an exported declaration');
  assert.ok(!/^import\s/m.test(theme), 'the component must not import anything: it is inlined flat');
  assert.ok(
    theme
      .split('\n')
      .filter((line) => /^export\b/.test(line))
      .every((line) => /^export (const|async function|function|let|class)\b/.test(line)),
    'every export must be strippable by replace(/^export /gm, \'\')',
  );
});

test('the shared client script cannot end its own script block', () => {
  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(!client.includes('</script'), 'a literal </script> would close the tag in the generated HTML');
  // The backtick rule outlived the template literal it came from. The client spent its
  // first editions inside one, where a backtick in a comment silently ended the string
  // and the rest of the file was parsed as TypeScript — three times, always with a
  // confusing syntax error far from the cause.
  const withBackticks = client
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter((entry) => entry.text.includes('`'))
    .map((entry) => `${entry.line}: ${entry.text.trim()}`);
  assert.deepEqual(withBackticks, [], 'viewer.js must contain no backtick at all');
});

test('the archive-info trigger belongs to the heading row', () => {
  // The user's ask (2026-09-18): the 📝 belongs on the same line as the H1 it edits,
  // flush right and labelled, with the panel opening from under it — the bottom-right
  // corner is the shared 🎨 button's alone. So this pins the layout, and pins that the
  // client hangs the trigger off #headRow rather than off the body.
  const markup = readFileSync(MARKUP, 'utf8');
  assert.ok(markup.includes('<div class="headrow" id="headRow">'), 'the heading needs its own #headRow');
  assert.ok(
    /<div class="headrow" id="headRow">\s*<h1><span id="titleText" data-fact="title"><\/span>/.test(markup),
    'the heading row must wrap the title fact, not sit beside it',
  );
  const rowRule = /\.headrow\{([^}]*)\}/.exec(markup)?.[1] ?? '';
  assert.ok(rowRule.includes('position:relative'), '#headRow is the panel\'s positioned ancestor');
  assert.ok(rowRule.includes('display:flex'), 'the button is a flex sibling of the heading');
  const buttonRule = /#profileBtn\{([^}]*)\}/.exec(markup)?.[1] ?? '';
  assert.ok(buttonRule.includes('margin-left:auto'), 'the trigger is pushed to the right end of the row');
  assert.ok(!buttonRule.includes('position:fixed'), 'the trigger must not float over the page any more');
  const panelRule = /#profilePanel\{([^}]*)\}/.exec(markup)?.[1] ?? '';
  assert.ok(panelRule.includes('position:absolute'), 'the panel opens from under the trigger');
  assert.ok(panelRule.includes('right:0'), 'the panel is flush with the trigger');
  assert.ok(
    markup.includes('@media (max-width:900px){#profileBtn .lbl{display:none}}'),
    'a narrow window keeps the icon and drops the label',
  );

  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(
    client.includes("document.getElementById('headRow')"),
    'the client should hang the trigger off the heading row',
  );
  assert.ok(!client.includes('document.body.appendChild(button)'), 'the trigger is no longer a floating button');
  assert.ok(client.includes("document.getElementById('titleText')"), 'the client should own the heading rename');
  assert.ok(client.includes('修改存档信息'), 'the label is the wording the user asked for');
});

test('the heading, the field summary and the acrylic nav are the shared markup\'s', () => {
  // Third round, requirements 6, 7 and 8. None of the three is reachable from a unit test:
  // the heading is markup, the summary is filled at runtime by two different hosts, and the
  // acrylic chrome only shows up in a browser. The runtime half (the fields really get their
  // values) lives in scripts/verify-player-run.ts; this half pins the markup contract.
  const markup = readFileSync(MARKUP, 'utf8');
  const title = /<title>([^<]*)<\/title>/.exec(markup)?.[1] ?? '';
  const nav = /<div class="navTitle">([^<]*)<\/div>/.exec(markup)?.[1] ?? '';
  // From the heading's own opening span, not from a bare <h1>: the stylesheet mentions <h1>
  // in a comment above it, and a lazy match from there would swallow the document head.
  const h1 = /<h1>(<span id="titleText"[\s\S]*?)<\/h1>/.exec(markup)?.[1] ?? '';

  // "月度版图时间线" names the *site*, so it leaves the heading and stays on the tab and in
  // the navigation — that is the whole of what the user asked for.
  assert.ok(h1.includes('data-fact="title"'), 'the heading still names this save');
  assert.ok(
    h1.includes('data-fact="start"') && h1.includes('data-fact="end"'),
    'the heading still spans the campaign',
  );
  assert.ok(!h1.includes('月度版图时间线'), 'the redundant suffix is gone from the heading');
  assert.ok(title.includes('月度版图时间线'), 'the tab title still names the site');
  assert.ok(nav.includes('月度版图时间线'), 'the navigation still names the site');

  // The line under it names the archive's own fields rather than the parsed frame counts.
  const sub = /<div class="sub">([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? '';
  for (const label of ['版本：', '结档日期：', '封档日期：', '模组：']) {
    assert.ok(sub.includes(label), `the summary should print ${label}`);
  }
  for (const key of ['version', 'endDate', 'sealedAt', 'mods']) {
    assert.ok(sub.includes(`data-fact="${key}"`), `the summary should carry the ${key} fact`);
  }
  assert.ok(!/个省份|个月度帧|条带日期事件/.test(sub), 'the parsed counts are gone from the summary');

  // Acrylic, on all four themes: a per-theme translucent tint plus both spellings of the
  // filter recipe, with the opaque tint left underneath as the fallback.
  const glass = [...markup.matchAll(/--nav-glass:([^;}]+)/g)].map((m) => (m[1] as string).trim());
  assert.equal(glass.length, 4, 'every theme needs its own translucent nav tint');
  assert.ok(
    glass.every((value) => value.startsWith('rgba(')),
    'the tints must be translucent, not opaque',
  );
  assert.ok(markup.includes('-webkit-backdrop-filter:blur(18px) saturate(1.4)'), 'WebKit needs the prefixed filter');
  assert.ok(markup.includes('backdrop-filter:blur(18px) saturate(1.4)'), 'the standard filter carries the recipe');
  assert.ok(/#nav\{[^}]*background:var\(--nav-bg\)/.test(markup), 'the opaque tint stays as the fallback');

  // The TAG picker's two states, and the scroll the user asked for.
  assert.ok(markup.includes('#profilePanel .taglist.open{display:block}'), 'the TAG picker needs its open state');
  assert.ok(/\.taglist\{[^}]*max-height:172px/.test(markup), 'the picker must be capped in height');
  assert.ok(/\.taglist\{[^}]*overflow-y:auto/.test(markup), 'and scroll with the wheel');
});

test('the protagonist strip is the heading row\'s, and the real-world date is a 日期', () => {
  // Fourth round, requirements 2 and 4: the countries the player ran hang off the same row as
  // the 📝 that edits them — five to a page, arrows only when there is a second page — and the
  // real-world date is called 封档日期, not 封档时间. The runtime half (paging, the disabled
  // ends, the flagset follow, the upload-day prefill) lives in scripts/verify-player-run.ts;
  // this half pins the markup styles and the client's own rules.
  const markup = readFileSync(MARKUP, 'utf8');
  for (const rule of [
    '#heroStrip{',
    '#heroStrip .heroItems{',
    '#heroStrip .heroFlag{',
    '#heroStrip .heroCap{',
    '#heroStrip .heroPage{',
    '#heroStrip .heroFallback{',
  ]) {
    assert.ok(markup.includes(rule), `the strip needs its ${rule} rule`);
  }
  assert.ok(
    markup.includes('@media (max-width:900px){#heroStrip .heroCap{display:none}}'),
    'a narrow window drops the captions before it wraps the heading',
  );
  assert.ok(markup.includes('封档日期：'), 'the summary prints 封档日期');
  assert.ok(!markup.includes('封档时间'), 'the old 封档时间 wording is gone from the markup');

  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(client.includes("strip.id = 'heroStrip'"), 'the client owns the strip element');
  assert.ok(
    client.includes('headRow.insertBefore(strip, button)'),
    'the strip mounts immediately left of the 📝 trigger',
  );
  assert.ok(client.includes('var HERO_PER_PAGE = 5;'), 'five flags to a page, as the user asked');
  assert.ok(client.includes('<label>封档日期</label>'), 'the drawer field is labelled 封档日期');
  assert.ok(!client.includes('封档时间'), 'the old 封档时间 wording is gone from the client');
  // The field shows the value it falls back to — "the default is the upload day" is exactly
  // what the user asked to see in it, so an empty box would miss the point.
  assert.ok(
    client.includes("$('profileSealedAt').value = sealedPrefill();"),
    'the 封档日期 field is prefilled with the custom value or the upload day',
  );
  // One 旗帜 switch for the map and the strip: applyFlagSet is what repaints it.
  assert.ok(
    client.includes('if (paintHeroStrip) paintHeroStrip();'),
    'applyFlagSet repaints the strip as well as the map',
  );
});

test('the TAG picker reads the great powers, with the leaderboard as its fallback', () => {  // The picker lists the fifteen great powers the page already shows. The array the hosted
  // bootstrap publishes is the easy path; the rendered table body is what keeps the picker
  // working for an archive whose stored data.json predates that array — those files have the
  // HTML either way. Losing the second source would silently degrade to manual typing only.
  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(client.includes('meta.leaders'), 'the normalised array is the first source');
  assert.ok(client.includes('VIEWER_PANELS.leaders'), 'the rendered leaderboard is the fallback');
  assert.ok(client.includes('profileTagList'), 'the picker hangs off the TAG field as its own list');
  assert.ok(client.includes('profilePick'), 'one id per pickable great power');
  // Manual typing is never taken away: the picker fills a plain text input.
  assert.ok(client.includes("maxlength=\"4\""), 'the TAG field stays a plain, typeable input');

  const bootstrap = readFileSync(BOOTSTRAP, 'utf8');
  assert.ok(
    bootstrap.includes('leaders: Array.isArray(panels?.leaders)'),
    'the hosted bootstrap publishes the great powers',
  );
  assert.ok(bootstrap.includes('sealedAt:'), 'the bootstrap resolves 封档日期 for the summary');
  assert.ok(bootstrap.includes('uploadedAt'), 'and falls back to the upload day');

  const source = readFileSync(SCRIPT, 'utf8');
  assert.ok(source.includes("sealedAt: '—'"), 'the offline page has no real-world sealed date to show');
  assert.ok(source.includes('doc.meta.version.text'), 'the offline page reads the version out of the save');
});

test('artwork URLs are absolute from the site root', () => {
  // The generated page is served from /saves/<id>/viewer/index.html — three levels
  // down, not two. Every `../../assets/...` in it resolved to /saves/assets/... and
  // 404'd, so no flag or wallpaper ever appeared on that page; the client default and
  // the wallpapers are compared against the page URL in apps/site/test/viewer-flow.ts,
  // and this pins the spelling that makes that impossible.
  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(client.includes("{ flags: '/assets/flags/' }"), 'the client default must be root-absolute');
  assert.ok(!client.includes("'../../assets"), 'no relative artwork prefix may remain in the client');

  const source = readFileSync(SCRIPT, 'utf8');
  assert.ok(
    source.includes("const VIEWER_ASSETS = { flags: '/assets/flags/' };"),
    'the generator must hand the client a root-absolute flag prefix',
  );
  // Positive assertions only: the comments in both files *quote* the old relative
  // form to explain why it was wrong, so a `!includes('../../...')` check would trip
  // on the explanation rather than on the bug.
  assert.ok(source.includes('`/背景图/${f}`'), 'wallpapers must be emitted root-absolute');
  assert.ok(source.includes('背景图'), 'the generator should still read the wallpaper folder');
});

test('the player markup mentions the controls the UI promises', () => {
  // The markup is a shared asset now, so this also pins the contract between
  // viewer.html and viewer.js: a button the client looks up by id must exist here.
  const markup = readFileSync(MARKUP, 'utf8');
  for (const id of [
    'play', 'speed', 'speedUp', 'speedDown', 'zoomIn', 'zoomOut', 'zoomReset', 'res', 'flagset',
    'slider', 'chart',
  ]) {
    assert.ok(markup.includes(`id="${id}"`), `the player markup should define #${id}`);
  }
  // The three panels are filled by the host, so they must be empty containers. The two
  // rankings are different: the client draws those itself from DATA.rankings (第四对话任务书.md
  // §4.3 C2), so their bodies are the client's containers but still belong to the shared
  // markup — the offline page and the hosted page are one file.
  for (const id of ['leaderBody', 'cityBody', 'institutionBody', 'generalBody', 'monarchBody']) {
    assert.ok(markup.includes(`id="${id}"`), `the player markup should define #${id}`);
  }
  // The detail sheet's ids are frozen in 第三对话任务书.md §1.6 — two conversations build
  // against this table, so every one of them has to be in the shared markup. #detailGotoCountry
  // is deliberately absent: it only exists inside a province panel, so the client builds it.
  for (const id of [
    'hover', 'detail', 'detailBody', 'detailTitle', 'detailBack', 'detailClose', 'mapFull', 'player',
  ]) {
    assert.ok(markup.includes(`id="${id}"`), `the player markup should define #${id}`);
  }
  assert.ok(!markup.includes('id="detailGotoCountry"'), 'the 转到国家 button belongs to the province panel, not the markup');
});

test('the detail sheet is inside the map, and the hover layer tracks it', () => {
  // Where these live is not cosmetic. #view is the clipping wrapper (position:relative,
  // overflow:hidden) and the only element the pan/zoom transform is applied inside, so a
  // sheet parented anywhere else would escape the map's box or drift from it. The hover
  // canvas has to be a second canvas of the same intrinsic size as #map: a highlight is
  // redrawn on every mouse move while the map's own pixels are rewritten only when the
  // frame changes.
  const markup = readFileSync(MARKUP, 'utf8');
  const view = /<div class="view" id="view">([\s\S]*?)<div class="bar">/.exec(markup)?.[1] ?? '';
  assert.ok(view.includes('<canvas id="map" width="5632" height="2048">'), 'the map canvas belongs to #view');
  assert.ok(
    view.includes('<canvas id="hover" width="5632" height="2048">'),
    '#hover must sit beside #map with the same intrinsic size',
  );
  assert.ok(view.includes('<div id="detail" class="detail" hidden>'), 'the sheet starts hidden, inside #view');
  assert.ok(
    /<button id="detailBack" type="button"><\/button>[\s\S]*?<span id="detailTitle"><\/span>[\s\S]*?<button id="detailClose" type="button"/.test(
      view,
    ),
    'the sheet head is 返回 / 标题 / ✕, in that order',
  );
  assert.ok(view.includes('<div id="detailBody" class="dBody">'), 'the body is an empty container the client fills');
  const bar = /<div class="bar">([\s\S]*?)<\/div>\s*<div class="stats"/.exec(markup)?.[1] ?? '';
  assert.ok(bar.includes('id="mapFull"'), '⛶ 全屏 belongs to the toolbar, beside the zoom controls');

  // The sheet's tint is its own layer behind the content, which is what makes the 面板
  // slider fade the surface and never the text; --panel-opacity is the handover variable,
  // and each theme needs its own opaque base because --panel is already translucent.
  assert.ok(/#detail::before\{[^}]*background:var\(--detail-base\)/.test(markup), 'the tint is a ::before layer');
  assert.ok(/#detail::before\{[^}]*opacity:var\(--panel-opacity/.test(markup), 'and it is what the slider drives');
  for (const theme of ['', 'parchment', 'royal', 'light']) {
    const rule = theme
      ? new RegExp(`body\\[data-theme=${theme}\\]\\{--detail-base:#[0-9a-f]{6}\\}`)
      : /:root\{--panel-opacity:\.88;--detail-base:#[0-9a-f]{6}\}/;
    assert.ok(rule.test(markup), `the ${theme || 'default'} theme needs its own --detail-base`);
  }
  // Full screen lifts the player out of the page; .bar has to stay inside it, because the
  // user asked for the toolbar to remain visible while the map fills the screen.
  assert.ok(/\.player\.screen\{[^}]*position:fixed/.test(markup), 'the full-screen player is a fixed column');
  assert.ok(
    /body\.screen>:not\(\.player\):not\(script\)\{display:none\}/.test(markup),
    'everything but the player is hidden in full screen, so .bar survives by construction',
  );
});

test('the 面板 slider is the viewer page alone', () => {
  // The detail sheet belongs to the viewer, so the control that fades it must not exist in
  // the catalogue's 🎨 panel — and it can only be conditional if the component knows which
  // page mounted it. One flag, one row, one CSS variable.
  const theme = readFileSync(THEME, 'utf8');
  assert.ok(
    /export async function mountPageTheme\(\{ host = document.body, wallpapers, detailPanel = false \} = \{\}\)/.test(theme),
    'the component takes detailPanel, defaulting to off',
  );
  assert.ok(theme.includes("id=\"pageThemePanelOpacity\""), 'the row defines #pageThemePanelOpacity');
  assert.ok(theme.includes('min="20" max="100"'), 'and its frozen range is 20–100');
  assert.ok(theme.includes('panelOpacity: 88'), 'the default is 88%');
  assert.ok(
    theme.includes("setProperty('--panel-opacity'"),
    'it is published as --panel-opacity, the variable the sheet reads',
  );
  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(
    client.includes('mountPageTheme({ wallpapers: BG, detailPanel: true })'),
    'the viewer is the host that asks for it',
  );
});

test('the archive-info drawer is opt-in: the generated page has no record', () => {
  // The 📝 drawer edits the catalogue record through /api/saves/:id, so the client only
  // builds it when the host handed it a VIEWER_META.id. The hosted bootstrap publishes
  // that record; the generator must NOT, or the standalone file would ship a button that
  // can only fail (there is no server behind a file on disk).
  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(client.includes('profileBtn'), 'the client should own the 📝 button');
  assert.ok(/typeof VIEWER_META/.test(client), 'the client should read VIEWER_META defensively');
  const bootstrap = readFileSync(BOOTSTRAP, 'utf8');
  assert.ok(bootstrap.includes('globalThis.VIEWER_META ='), 'the hosted bootstrap must publish the record');
  const source = readFileSync(SCRIPT, 'utf8');
  assert.ok(!/VIEWER_META\s*=/.test(source), 'the generator must not define VIEWER_META');
  const markup = readFileSync(MARKUP, 'utf8');
  assert.ok(markup.includes('#profilePanel'), 'the shared markup should carry the drawer styles');
  assert.ok(!markup.includes('id="profileBtn"'), 'the button is built by the client, never declared in the markup');
});

test('the generator renders the shared markup', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.ok(source.includes("readFileSync('apps/site/public/viewer.html', 'utf8')"), 'the generator should read the shared markup');
  // Every palette name the client reads must be packed into DATA.constants.
  const published = source.slice(source.indexOf('constants: {'));
  for (const name of ['unowned', 'sea', 'lake', 'hre']) {
    assert.ok(published.includes(name), `DATA.constants should publish ${name}`);
  }
});
