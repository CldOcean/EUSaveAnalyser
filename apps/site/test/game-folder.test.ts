/**
 * Picking the game folder out of a directory listing.
 *
 * A browser hands over a flat list of paths (`webkitRelativePath`), and the user
 * may have selected the game root, its `steamapps` parent, or just the three map
 * files. The matching rules are the part worth testing, and the real game folder
 * is the fixture: if the rules cannot find the files where they actually live,
 * the folder picker is broken no matter how nice the dialog looks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  GAME_FILES,
  gameRelative,
  localisationSources,
  mapCacheKey,
  matchGameFiles,
  normalisePath,
} from '../public/game-folder.js';
import { loadLocalisation, localise } from '../public/game-localisation.js';
import { EU4, MOD_LOCALISATION } from '../../../scripts/lib/map-assets.ts';

const hasGame = existsSync(EU4);
const hasMod = existsSync(MOD_LOCALISATION);

test('paths are normalised the same way whatever the picker reports', () => {
  assert.equal(normalisePath('Europa Universalis IV\\map\\provinces.bmp'), 'Europa Universalis IV/map/provinces.bmp');
  assert.equal(gameRelative('Europa Universalis IV/map/provinces.bmp'), 'map/provinces.bmp');
  assert.equal(gameRelative('C:/Games/steamapps/common/Europa Universalis IV/map/definition.csv'), 'map/definition.csv');
  assert.equal(gameRelative('common/religions/00_religion.txt'), 'common/religions/00_religion.txt');
  assert.equal(gameRelative('localisation/text_l_english.yml'), 'localisation/text_l_english.yml');
  // A file the viewer does not need keeps its name rather than disappearing.
  assert.equal(gameRelative('readme.txt'), 'readme.txt');
});

test('matching works for the three shapes a picker can report', () => {
  const asEntries = (paths) => paths.map((path) => ({ path, file: { name: path } }));
  const root = 'Europa Universalis IV/';
  const shapes = {
    'game root': asEntries([
      `${root}map/provinces.bmp`,
      `${root}map/definition.csv`,
      `${root}map/default.map`,
    ]),
    'steamapps parent': asEntries([
      `common/Europa Universalis IV/map/provinces.bmp`,
      `common/Europa Universalis IV/map/definition.csv`,
      `common/Europa Universalis IV/map/default.map`,
    ]),
    'backslash paths': asEntries([
      'Europa Universalis IV\\map\\provinces.bmp',
      'Europa Universalis IV\\map\\definition.csv',
      'Europa Universalis IV\\map\\default.map',
    ]),
  };
  for (const [label, entries] of Object.entries(shapes)) {
    const found = matchGameFiles(entries);
    assert.equal(found.complete, true, `${label} should be complete`);
    assert.deepEqual(found.missing, []);
  }
  // And an incomplete listing is reported, not silently accepted.
  const partial = matchGameFiles([{ path: `${root}map/provinces.bmp`, file: {} }]);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing.sort(), ['defaultMap', 'definitionCsv']);
});

test('the real game folder satisfies the requirements', { skip: !hasGame }, () => {
  // Walk the folders the viewer reads, the same way the picker would report them.
  const entries = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}${name}/`);
        continue;
      }
      entries.push({ path: `${prefix}${name}`, file: { name } });
    }
  };
  for (const dir of ['map', 'common/religions', 'common/countries', 'localisation']) {
    const full = join(EU4, dir);
    if (existsSync(full)) walk(full, `${dir}/`);
  }

  const found = matchGameFiles(entries);
  assert.equal(found.provincesBmp?.path, 'map/provinces.bmp');
  assert.equal(found.definitionCsv?.path, 'map/definition.csv');
  assert.equal(found.defaultMap?.path, 'map/default.map');
  assert.equal(found.complete, true, `missing: ${found.missing.join(', ')}`);
  assert.ok(found.religions.length >= 1, 'religion files should be found');
  assert.ok(found.localisation.length >= 1, 'localisation files should be found');
  console.log(
    `      matched from ${entries.length} files: ` +
      `${found.religions.length} religions, ${found.countryColours.length} country files, ` +
      `${found.localisation.length} localisation`,
  );
  // The declared candidates must actually exist in this install, otherwise the
  // list is guessing rather than describing the game.
  for (const candidate of GAME_FILES.provincesBmp) {
    assert.ok(existsSync(join(EU4, candidate)) || candidate !== GAME_FILES.provincesBmp[0], `${candidate} is stale`);
  }
});

test('the localisation files are read in the order that produces Chinese names', () => {
  const entry = (path, size = 1000) => ({ path, file: { size } });

  // The mod's two files last: later entries overwrite earlier ones, so this order is
  // what makes the Chinese text win over the base game's English.
  const chosen = localisationSources({
    game: [entry('localisation/aaa_l_english.yml'), entry('localisation/countries_l_english.yml')],
    mod: [entry('localisation/countries_l_english.yml'), entry('localisation/text_l_english.yml')],
  });
  assert.deepEqual(
    chosen.map((item) => item.path),
    [
      'localisation/countries_l_english.yml',
      'localisation/countries_l_english.yml',
      'localisation/text_l_english.yml',
    ],
  );
  assert.equal(chosen[0], chosen[0], 'the game file comes first');
  assert.notEqual(chosen[0], chosen[1], 'the mod file is a different entry, so it wins');

  // An unrecognisable mod folder still contributes, after the game folder.
  const fallback = localisationSources({
    game: [entry('localisation/countries_l_english.yml')],
    mod: [entry('localisation/some_mod_l_english.yml'), entry('localisation/other_l_english.yml')],
  });
  assert.deepEqual(
    fallback.map((item) => item.path),
    ['localisation/countries_l_english.yml', 'localisation/other_l_english.yml', 'localisation/some_mod_l_english.yml'],
  );

  // Anything a folder could get wrong about size or type is dropped, not read.
  const filtered = localisationSources({
    game: [entry('localisation/huge_l_english.yml', 99 * 1024 * 1024), entry('localisation/readme.txt')],
    mod: [],
  });
  assert.deepEqual(filtered.map((item) => item.path), ['localisation/readme.txt'], 'the oversized file is skipped');
});

test('the hosted pipeline resolves Chinese names from the two picked folders', { skip: !hasGame || !hasMod }, async () => {
  // The whole hosted chain, minus the browser's File API: walk the two folders the way
  // `webkitdirectory` reports them, pick the files the way the page does, decode them
  // with the browser's reader, and ask for a name. A `file` stand-in with `size` and
  // `text()` is all the page needs, which is what makes this testable at all.
  const entriesIn = (dir: string, prefix: string) => {
    const out: Array<{ path: string; file: { size: number; text: () => Promise<string> } }> = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!statSync(join(dir, name)).isFile()) continue;
      const absolute = join(dir, name);
      out.push({
        path: `${prefix}${name}`,
        file: { size: statSync(absolute).size, text: async () => readFileSync(absolute, 'utf8') },
      });
    }
    return out;
  };

  const chosen = localisationSources({
    game: entriesIn(`${EU4}/localisation`, 'localisation/'),
    mod: entriesIn(MOD_LOCALISATION, 'localisation/'),
  });
  assert.ok(chosen.length >= 2, `expected the game and the mod files, got ${chosen.length}`);
  const names = loadLocalisation(await Promise.all(chosen.map(async (entry) => ({ text: await entry.file.text(), source: entry.path }))));

  const chinese = /[\u4e00-\u9fff]/;
  const resolved = ['RUS', 'ENG', 'FRA', 'HAB'].map((tag) => ({ tag, name: localise(names, tag) }));
  for (const row of resolved) console.log(`      ${row.tag} -> ${row.name}`);
  assert.ok(
    resolved.every((row) => chinese.test(row.name)),
    `every sample tag must resolve to Chinese, got ${resolved.map((row) => `${row.tag}=${row.name}`).join(' ')}`,
  );
  console.log(`      ${chosen.length} file(s) read, ${names.size.toLocaleString()} keys`);
});

test('the map cache key changes when the map changes', () => {
  const ids = new Uint16Array(10_000);
  for (let i = 0; i < ids.length; i += 1) ids[i] = i % 4941;
  const key = mapCacheKey(5632, 2048, ids);
  assert.match(key, /^map-5632x2048-[0-9a-f]+-10000$/);

  const edited = Uint16Array.from(ids);
  edited[970] = 1234; // 970 is a sampled index (0, 97, 194, ...)
  assert.notEqual(mapCacheKey(5632, 2048, edited), key, 'a changed pixel must change the key');

  const unsampled = Uint16Array.from(ids);
  unsampled[1] = 4321;
  assert.equal(
    mapCacheKey(5632, 2048, unsampled),
    key,
    'the fingerprint samples every 97th id, so it is cheap and intentionally coarse',
  );
});
