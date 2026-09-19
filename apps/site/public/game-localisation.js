/*
 * Localisation, read in the browser.
 *
 * The viewer shows Chinese country/religion names, which come from the game's
 * and the mods' `localisation/*.yml`. Two quirks make this non-trivial:
 *
 * 1. Non-Latin text uses the same "letter stream" encoding as save files. The
 *    files are valid UTF-8, but each letter was produced by encoding a *byte*,
 *    and bytes 0x80..0x9F were round-tripped through CP1252 - so `'` (U+2018) has
 *    to become byte 0x91 again before decoding.
 * 2. Later files override earlier ones, and a mod may ship only a few, leaving
 *    the rest to the base game. Callers pass files in load order.
 *
 * `decodeSaveString` comes from the parser bundle, so the decoding is literally
 * the same code the save reader uses rather than a second implementation.
 *
 * Mirrors scripts/lib/localisation.ts; apps/site/test/game-localisation.test.ts
 * compares the two on the real files.
 */
import { decodeSaveString } from './eu4-parser.js';

/** Unicode code point -> the single byte it was CP1252-decoded from. */
const CP1252_REVERSE = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

const ENTRY = /^\s*([A-Za-z0-9_.\-]+)\s*:\s*\d*\s*"((?:[^"\\]|\\.)*)"/;

/** Turn one raw localisation value into text. */
export function decodeLocalisationValue(value) {
  const bytes = [];
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x100) {
      bytes.push(code);
      continue;
    }
    const original = CP1252_REVERSE.get(code);
    if (original === undefined) return value; // not a letter stream; keep as-is
    bytes.push(original);
  }
  return decodeSaveString(Uint8Array.from(bytes));
}

/** Parse one `.yml`'s text into `key -> text`. */
export function parseLocalisationText(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = ENTRY.exec(line);
    if (!match) continue;
    out.set(match[1], decodeLocalisationValue(match[2]));
  }
  return out;
}

/**
 * Merge several files in load order; later entries win.
 * @param {Array<{text: string, source?: string}>} files
 */
export function loadLocalisation(files) {
  const out = new Map();
  for (const { text } of files) {
    try {
      for (const [key, value] of parseLocalisationText(text)) out.set(key, value);
    } catch {
      // One unreadable file must not lose every other translation.
    }
  }
  return out;
}

/**
 * Chinese names for religion keys the merged table cannot resolve.
 *
 * Why a second table instead of more `localisation` files: the viewer merges only
 * a handful of files (`text_l_english.yml` / `countries_l_english.yml`; see
 * `localisationSources` and `render-timeline.ts`). The game and the Chinese mod
 * keep their religion names in *other* files - `religion_l_english.yml` (Tengri,
 * Norse), `EU4_l_english.yml` (Nahuatl, Mayan, Inti), `nw2_l_english.yml`
 * (Coptic, Ibadi, Sikh), `leviathan_l_english.yml` (Alcheringa/dreamtime),
 * `rule_britannia_l_english.yml` (Anglican), `domination_l_english.yml` (Slavic) -
 * so the merge drops them and the tables printed `tengri_pagan_reformed`,
 * `nahuatl`, ... as raw keys.
 *
 * Every name below was read out of a localisation file on this machine with the
 * offline reader, never invented:
 * - the base-game religions take the Chinese Language Mod's own wording
 *   (`2976470733/localisation/religion_l_english.yml` and friends), which is the
 *   same source the rest of the viewer's names come from;
 * - religions added by other installed mods take the name from the mod that
 *   defines them in `common/religions/`;
 * - `EM_tengri_pagan_reformed` has no text anywhere on this machine, so it is
 *   named after the base religion it re-skins.
 *
 * `localise` consults this table only after every table lookup failed, because a
 * localisation entry always wins: the fallback is a floor, not an override.
 *
 * Mirrors `RELIGION_FALLBACK` in scripts/lib/localisation.ts; the test compares
 * the two entry by entry.
 */
export const RELIGION_FALLBACK = new Map([
  // Base-game religions whose Chinese lives in the mod's other localisation files.
  ['anglican', '圣公宗'],
  ['coptic', '科普特正教'],
  ['dreamtime', '梦创神话'],
  ['ibadi', '伊巴德派'],
  ['inti', '因蒂崇拜'],
  ['jewish', '犹太教'],
  ['mesoamerican_religion', '玛雅宗教'],
  ['nahuatl', '纳瓦特尔宗教'],
  ['norse_pagan_reformed', '诺斯信仰'],
  ['sikhism', '锡克教'],
  ['slavic', '斯拉夫'],
  ['tengri_pagan_reformed', '腾格里'],
  ['zoroastrian', '祆教'],
  // Religions defined by other installed mods; the name is the defining mod's own.
  ['arianism', '阿里乌教'],
  ['armenian_religion', '亚美尼亚多神教'],
  ['ashurism', '阿舒尔教'],
  ['baihuojiao', '拜火教'],
  ['chalcedonism', '迦克敦信经'],
  ['communism', '共产主义'],
  ['confucianist', '儒道'],
  ['daoism', '道教'],
  ['druidism', '德鲁伊教'],
  ['egyptian', '古埃及宗教'],
  ['fascism', '法西斯主义'],
  ['georgian_religion', '卡特维利教'],
  ['hellenism', '希腊多神教'],
  ['jainism', '耆那教'],
  ['liberalism', '自由主义'],
  ['manchu_shamanism', '萨满'],
  ['manichaeism', '摩尼教'],
  ['military_strategist', '兵家思想'],
  ['muism', '巫俗教'],
  ['nabataean', '纳巴泰教'],
  ['nestorian', '景教'],
  ['romuva', '洛姆瓦教'],
  ['sanamahism', '萨那马希教'],
  ['satsana_phi', '梅山教'],
  ['shamanist', '极地萨满'],
  ['south_arabian', '南阿拉伯宗教'],
  ['suomenusko', '索米信仰'],
  ['taoism', '道教'],
  ['tibetan_bon', '苯教'],
  ['worship_god', '拜上帝会'],
  ['zamolxism', '扎莫尔克西斯教'],
  ['zunism', '樽教'],
  // Religions of the "Celestial empire" mod (1728520255).
  ['avalon_faith', '繁生诸法'],
  ['emperorfaith', '帝皇崇拜'],
  ['iru_faith', '一如'],
  ['jingjiao_cn', '景教'],
  ['jingjiao_wr', '聂斯脱里派'],
  ['jingxueism', '经学'],
  ['kongzism', '古学'],
  ['mayareform', '玛雅新教'],
  ['sunfaith', '太阳神教'],
  // Religions of the 风云世纪两千年 mod (2935149060). Same rule: the name is the one
  // that mod's own `localisation/*.yml` gives that key, read with this loader.
  ['bailianjiao', '白莲教'],
  ['geomancer', '阴阳五行'],
  ['irreligious', '无宗教'],
  ['legalist', '法家'],
  ['mohistschool', '墨家'],
  ['secularism', '世俗主义'],
  // No localisation text exists for this key anywhere on this machine; it is a
  // re-skin of the base Tengri religion, so it reuses that name.
  ['EM_tengri_pagan_reformed', '腾格里'],
]);

/**
 * Best-effort localisation lookup, byte-for-byte the offline reader's rules.
 *
 * EU4 appends suffixes to keys (`_ADJ`, `_name`) and some keys are bare constants
 * already (`orthodox`, `russian`). A plain `get` is not enough: the offline build
 * tries these three forms, and a browser that skipped them produced different
 * country names for keys that only exist in the suffixed or upper-cased form.
 * The religion fallback table comes last, so a localisation entry always wins.
 */
export function localise(names, key) {
  if (!key) return '';
  return (
    names.get(key) ??
    names.get(`${key}_name`) ??
    names.get(key.toUpperCase()) ??
    RELIGION_FALLBACK.get(key) ??
    String(key)
  );
}
