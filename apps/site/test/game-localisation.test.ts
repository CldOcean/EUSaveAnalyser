/**
 * The browser's localisation reader must match the offline one.
 *
 * Chinese names are the visible result, so a disagreement here shows up as a
 * country labelled with a raw key (`russian_monarchy`) instead of text. The two
 * implementations are compared on the real game and mod files, which is also the
 * only way to exercise the CP1252/letter-stream quirk with real data.
 *
 * Assertions are deliberately "mine equals theirs" rather than hand-written
 * expectations: the encoding is subtle enough that inventing the expected string
 * by hand is how you end up testing your own misunderstanding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  RELIGION_FALLBACK as browserFallback,
  decodeLocalisationValue,
  loadLocalisation,
  localise,
  parseLocalisationText,
} from '../public/game-localisation.js';
import {
  RELIGION_FALLBACK as serverFallback,
  decodeLocalisationValue as serverDecode,
  loadLocalisationFile,
  localise as serverLocalise,
} from '../../../scripts/lib/localisation.ts';
import { EU4, MOD_LOCALISATION } from '../../../scripts/lib/map-assets.ts';

const BASE_DIR = `${EU4}/localisation`;
const hasGame = existsSync(BASE_DIR);
const hasMod = existsSync(MOD_LOCALISATION);

/** Pick the files both sides will read: this mod's, then anything from the game. */
function sample(paths, limit) {
  return [...paths].filter((p) => p.endsWith('.yml')).sort().slice(0, limit);
}

test('the CP1252 round-trip agrees with the offline decoder', () => {
  // Plain ASCII passes through, a CP1252 punctuation character is turned back
  // into its byte, and a letter-stream pair survives the trip.
  for (const value of ['London', 'Konstantinopel', 'K\u2019o', 'Habsburg']) {
    assert.equal(decodeLocalisationValue(value), serverDecode(value), `value ${JSON.stringify(value)}`);
  }
});

test('every localisation file in the mod parses identically', { skip: !hasMod }, () => {
  const files = sample(readdirSync(MOD_LOCALISATION).map((name) => join(MOD_LOCALISATION, name)), 6);
  assert.ok(files.length > 0, 'the mod should ship localisation files');
  let compared = 0;
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const mine = parseLocalisationText(text);
    const theirs = loadLocalisationFile(path);
    assert.equal(mine.size, theirs.size, `key count for ${path}`);
    for (const [key, value] of theirs) {
      assert.equal(mine.get(key), value, `key ${key} in ${path}`);
      compared += 1;
    }
  }
  console.log(`      ${files.length} mod files, ${compared.toLocaleString()} keys compared`);
});

test('the merged table agrees with the offline merge', { skip: !hasGame }, () => {
  const paths = sample(readdirSync(BASE_DIR).map((name) => join(BASE_DIR, name)), 8);
  assert.ok(paths.length > 0, 'the game should ship localisation files');
  const files = paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
  const mine = loadLocalisation(files);

  // The offline loader takes paths; feed it exactly the same files, in order.
  let theirs = new Map();
  for (const { path } of files) {
    for (const [key, value] of loadLocalisationFile(path)) theirs.set(key, value);
  }
  assert.equal(mine.size, theirs.size, 'merged key count');
  let checked = 0;
  for (const [key, value] of theirs) {
    assert.equal(mine.get(key), value, `key ${key}`);
    checked += 1;
  }
  console.log(`      merged ${paths.length} game files, ${checked.toLocaleString()} keys compared`);
  // A lookup helper: known keys resolve, unknown ones fall back to the key.
  assert.equal(localise(mine, 'ENG'), theirs.get('ENG') ?? 'ENG');
  assert.equal(localise(mine, 'definitely_not_a_key'), 'definitely_not_a_key');
});

test('merging the game folder then the Chinese mod yields Chinese names', { skip: !hasGame || !hasMod }, () => {
  // This is the whole reason the picker asks for a second folder. The base game's file
  // gives English; the mod overrides the same keys with Chinese. Since later entries
  // win, the order below IS the feature — reversed, every name reverts to English and
  // nothing else about the page changes.
  const basePath = join(BASE_DIR, 'countries_l_english.yml');
  const modPath = join(MOD_LOCALISATION, 'countries_l_english.yml');
  assert.ok(existsSync(basePath), 'the base game should ship countries_l_english.yml');
  assert.ok(existsSync(modPath), 'the mod should ship countries_l_english.yml');

  const text = (path: string) => ({ text: readFileSync(path, 'utf8'), source: path });
  const englishOnly = loadLocalisation([text(basePath)]);
  const merged = loadLocalisation([text(basePath), text(modPath)]);

  const chinese = /[\u4e00-\u9fff]/;
  const tags = ['ENG', 'RUS', 'FRA', 'HAB'];
  const resolved = tags.map((tag) => ({ tag, english: localise(englishOnly, tag), merged: localise(merged, tag) }));
  for (const row of resolved) {
    console.log(`      ${row.tag}: base="${row.english}" merged="${row.merged}"`);
  }
  const turnedChinese = resolved.filter((row) => chinese.test(row.merged));
  assert.ok(
    turnedChinese.length >= 3,
    `the mod's file should give Chinese names (got ${turnedChinese.length}/${tags.length})`,
  );
  assert.ok(
    resolved.some((row) => !chinese.test(row.english)),
    'the base game alone must be English, or this test proves nothing',
  );
  // And the reverse order really does lose the Chinese — otherwise the ordering rule
  // in `localisationSources` would be decorative.
  const reversed = loadLocalisation([text(modPath), text(basePath)]);
  assert.ok(
    resolved.some((row) => localise(reversed, row.tag) !== row.merged),
    'reading the mod first must change the result',
  );
});

test('the real save names would resolve through the merged table', { skip: !hasGame || !hasMod }, () => {
  // The renderer reads these two, so country tags must resolve through them.
  // (Sampling files alphabetically is not enough: the country names live in
  // countries_l_english.yml, which does not sort near the front.)
  const paths = [
    join(MOD_LOCALISATION, 'text_l_english.yml'),
    join(MOD_LOCALISATION, 'countries_l_english.yml'),
  ].filter((path) => existsSync(path));
  assert.ok(paths.length > 0, 'the mod should ship these two files');
  const names = loadLocalisation(paths.map((path) => ({ text: readFileSync(path, 'utf8'), source: path })));

  const found = ['ENG', 'RUS', 'HAB', 'FRA'].filter((tag) => names.has(tag));
  assert.ok(found.length > 0, `no country tag resolved (${names.size} keys loaded)`);
  for (const tag of found) {
    assert.ok(localise(names, tag).length > 0, `${tag} must resolve to text`);
    console.log(`      ${tag} -> ${localise(names, tag)}`);
  }
  console.log(`      resolved ${found.join(', ')} from ${names.size.toLocaleString()} keys`);
});

// ------------------------------------------------------- religion fallback ---

/**
 * The tables the viewer actually merges: the game's and the mod's two preferred
 * files. The religion names live in the mod's *other* files, which this merge
 * deliberately does not read — that is what the fallback exists for.
 */
function appMergedTables() {
  const preferred = (dir: string) =>
    ['text_l_english.yml', 'countries_l_english.yml']
      .map((name) => join(dir, name))
      .filter((path) => existsSync(path));
  const paths = [...preferred(BASE_DIR), ...preferred(MOD_LOCALISATION)];
  const mine = loadLocalisation(paths.map((path) => ({ text: readFileSync(path, 'utf8'), source: path })));
  const theirs = new Map<string, string>();
  for (const path of paths) for (const [key, value] of loadLocalisationFile(path)) theirs.set(key, value);
  return { mine, theirs, paths };
}

/** The three lookup forms `localise` tries before the fallback, without it. */
function rawLookup(table: Map<string, string>, key: string): string | undefined {
  return table.get(key) ?? table.get(`${key}_name`) ?? table.get(key.toUpperCase());
}

test('both mirrors ship the same religion fallback table', () => {
  assert.ok(serverFallback.size > 0, 'the offline fallback table must not be empty');
  assert.equal(browserFallback.size, serverFallback.size, 'fallback entry count');
  for (const [key, value] of serverFallback) {
    assert.equal(browserFallback.get(key), value, `fallback entry ${key}`);
  }
  const chinese = /[\u4e00-\u9fff]/;
  for (const [key, value] of serverFallback) {
    assert.ok(chinese.test(value), `${key} must fall back to a Chinese name, got "${value}"`);
  }
  console.log(`      ${serverFallback.size} religion fallback names, identical in both mirrors`);
});

test('a missing key takes the fallback, an existing entry still wins', () => {
  // These keys are what the tables printed as raw English keys before the fix.
  for (const key of ['tengri_pagan_reformed', 'nahuatl', 'mesoamerican_religion', 'zoroastrian']) {
    const expected = serverFallback.get(key);
    assert.ok(expected, `${key} should be in the fallback table`);
    assert.equal(localise(new Map(), key), expected, `browser localise(${key})`);
    const empty = new Map<string, string>();
    assert.equal(serverLocalise(empty, key), expected, `offline localise(${key})`);
  }
  // A real localisation entry always beats the fallback — the fallback is a floor,
  // and a future merge that does read the religion files must take over silently.
  const override = new Map([
    ['nahuatl', '测试纳瓦特尔'],
    ['tengri_pagan_reformed', '测试腾格里'],
  ]);
  assert.equal(localise(override, 'nahuatl'), '测试纳瓦特尔');
  assert.equal(localise(override, 'tengri_pagan_reformed'), '测试腾格里');
  assert.equal(serverLocalise(override, 'nahuatl'), '测试纳瓦特尔');
  assert.equal(serverLocalise(override, 'tengri_pagan_reformed'), '测试腾格里');
  // An unknown key is still returned verbatim, so a debug key stays readable.
  assert.equal(localise(new Map(), 'definitely_not_a_key'), 'definitely_not_a_key');
  assert.equal(serverLocalise(new Map(), 'definitely_not_a_key'), 'definitely_not_a_key');
});

test('every fallback key really is unresolvable in the real merge', { skip: !hasGame || !hasMod }, () => {
  // The guard the table needs: if a key *were* resolvable, the fallback would be
  // dead weight that could shadow a real translation. Checked on the real files,
  // for both mirrors, because the browser merges the game's copies too.
  const { mine, theirs, paths } = appMergedTables();
  assert.ok(mine.size > 0 && theirs.size > 0, `merged tables should not be empty (${paths.length} files)`);
  assert.equal(mine.size, theirs.size, 'merged table sizes must agree');
  let checked = 0;
  for (const key of serverFallback.keys()) {
    assert.equal(rawLookup(theirs, key), undefined, `${key} is resolvable in the real merge`);
    assert.equal(rawLookup(mine, key), undefined, `${key} is resolvable in the browser merge`);
    const expected = serverFallback.get(key);
    assert.equal(localise(mine, key), expected, `browser localise(${key})`);
    assert.equal(serverLocalise(theirs, key), expected, `offline localise(${key})`);
    checked += 1;
  }
  console.log(`      ${checked} fallback keys confirmed missing from ${paths.length} merged files`);
  console.log(`      merged ${mine.size.toLocaleString()} keys; sample: tengri_pagan_reformed -> ${localise(mine, 'tengri_pagan_reformed')}, nahuatl -> ${localise(mine, 'nahuatl')}`);
});
