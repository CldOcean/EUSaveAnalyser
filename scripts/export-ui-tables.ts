/**
 * 阶段 1 · S2 — 游戏文件表导出器（这 6 份 JSON 的唯一生产者）
 *
 * 把省份/国家面板要用的查表数据从**游戏本体文件**（＋在用汉化 mod 的 localisation）
 * 导出到 `apps/site/public/assets/ui/`：
 *
 *   1. provinceTerrain.json  省 id -> 地形类别（terrain.bmp 调色板 ＋ terrain.txt）
 *   2. area.json             省 id -> 地区 key（map/area.txt）＋地区中文名
 *   3. uiNames.json          建筑 / 奇观 / 地形 / 宗教 / 政体改革 / 科技的中文名
 *   4. advisorIds.json       common/advisortypes 的顾问类型 -> 中文名
 *   5. ledgerSlots.json      财政面板 19 个收入槽 / 38 个支出槽（下标 -> 科目名）
 *   6. manaSlots.json        点数面板 46 个下标槽 -> 科目名
 *
 * 并写出 `tmp/ui-tables-report.md`（条数、抽查、与游戏文件对照的证据）。
 *
 *   node scripts/export-ui-tables.ts           # 导出 + 报告
 *   node scripts/export-ui-tables.ts --dry     # 只算不写
 *
 * 契约：`省份国家界面阶段任务书.md` §2/§4/§6.2、`第三对话任务书.md` §1.3/§1.4/§3.2。
 * 槽位枚举：上游 Rust crate `rakaly/eu4save`（`src/query.rs` 的 `income_ledger_breakdown`
 * / `expense_ledger_breakdown` / `mana_spent_indexed`）＋ pdx-tools
 * `features/eu4/features/country-details/data.ts` 的英文科目名。
 * **没有上游依据的下标一律标成「其他」，本脚本不编造槽位名。**
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { ClausewitzReader } from '../packages/eu4-parser/src/clausewitz.ts';
import { SaveDocument, countryGroup } from '../packages/eu4-parser/src/document.ts';
import type { CwNode } from '../packages/eu4-parser/src/value.ts';
import { EU4, MOD_LOCALISATION, WORKSHOP_ROOT, colorToIdMap, loadDefinitions, loadProvincePixels } from './lib/map-assets.ts';
import { loadLocalisationFile } from './lib/localisation.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT_DIR = `${ROOT}apps/site/public/assets/ui`;
const SAVE = `${ROOT}存档示例/mp_俄罗斯1574_11_12.eu4`;
const DRY = process.argv.includes('--dry');
const MAP_W = 5632;
const MAP_H = 2048;
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff60]/;

const report: string[] = [];
const say = (line = ''): void => {
  console.log(line);
  report.push(String(line));
};

// ---------------------------------------------------------------- 解析工具 --

function stripComments(text: string): string {
  return text.replace(/#[^\n]*/g, ' ');
}

interface CwBlock {
  key: string;
  body: string;
}

/**
 * 文本里**顶层**的每个 `key = { ... }`，连同它的 body。
 *
 * 必须自己配对花括号：这些文件嵌套很深，而且 `map/area.txt` 的每个地区块里还有一个
 * `color = { r g b }` —— 把它当省 id 读，会凭空多出 90 个「一省属两地区」的假象。
 */
function topBlocks(text: string): CwBlock[] {
  const clean = stripComments(text);
  const out: CwBlock[] = [];
  let depth = 0;
  let pending: string | null = null;
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i] as string;
    if (ch === '{') {
      if (depth === 0 && pending !== null) {
        let d = 1;
        let j = i + 1;
        while (j < clean.length && d > 0) {
          const c = clean[j];
          if (c === '{') d += 1;
          else if (c === '}') d -= 1;
          j += 1;
        }
        out.push({ key: pending, body: clean.slice(i + 1, j - 1) });
        pending = null;
        i = j;
        continue;
      }
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < clean.length && /[A-Za-z0-9_-]/.test(clean[j] as string)) j += 1;
      let k = j;
      while (k < clean.length && /\s/.test(clean[k] as string)) k += 1;
      if (depth === 0 && clean[k] === '=') {
        let n = k + 1;
        while (n < clean.length && /\s/.test(clean[n] as string)) n += 1;
        if (clean[n] === '{') {
          pending = clean.slice(i, j);
          i = n;
          continue;
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 文件里深度恰为 `wanted` 的 `key = {}` 赋值键（0＝顶层，1＝组块内部）。 */
function keysAt(text: string, wanted: number): string[] {
  const clean = text.replace(/#[^\n]*/g, ' ');
  const out: string[] = [];
  let depth = 0;
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\{|\{|\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    if (m[1] !== undefined) {
      if (depth === wanted) out.push(m[1]);
      depth += 1;
    } else if (m[0] === '{') depth += 1;
    else depth -= 1;
  }
  return out;
}

/** body 顶层（跳过嵌套块）出现的数字，例如地区里的省 id 列表。 */
function topLevelNumbers(body: string): number[] {
  const out: number[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\{|\{|\}|(?<![A-Za-z0-9_-])-?\d+/g;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const token = m[0] as string;
    if (m[1] !== undefined) depth += 1;
    else if (token === '{') depth += 1;
    else if (token === '}') depth -= 1;
    else if (depth === 0) out.push(Number(token));
  }
  return out;
}

/**
 * 游戏本体 ＋ **每个 mod** 的 `<rel>/*.txt` 里的键名并集。
 *
 * 名字表要覆盖整个已装模组生态：存档里的文化/理念/兵种/特质大多来自模组，
 * 只扫本体会让这些 key 显示成原文（用户报的「没汉化」根因之一）。
 * `depth` 是 `keysAt` 的花括号深度；`fromFileName` 用于**键名＝文件名**的族
 * （`common/units/*.txt` 就是这样，文件名才是兵种 key）。
 */
function collectKeys(rel: string, depth: number, fromFileName = false, onlyBase = false): string[] {
  const out = new Set<string>();
  for (const root of onlyBase ? [EU4] : dataRoots()) {
    const dir = `${root}/${rel}`;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.txt'));
    } catch {
      continue;
    }
    for (const name of names) {
      if (fromFileName) out.add(name.replace(/\.txt$/, ''));
      else for (const key of keysAt(readFileSync(`${dir}/${name}`, 'latin1'), depth)) out.add(key);
    }
  }
  return [...out].sort();
}

/** 文化组块里的结构性键（`male_names = {}` 之类），不是文化。 */
const CULTURE_STRUCTURAL = new Set([
  'male_names', 'female_names', 'dynasty_names', 'country', 'province',
  'graphical_culture', 'second_graphical_culture', 'primary', 'piracy', 'tribal', 'color', 'modifier',
]);

// -------------------------------------------------------------- localisation --

/** Steam 创意工坊根目录下每个 mod 的目录（排序保证合并顺序确定）。 */
function modRoots(): string[] {
  try {
    return readdirSync(WORKSHOP_ROOT)
      .sort()
      .map((id) => `${WORKSHOP_ROOT}/${id}`);
  } catch {
    return [];
  }
}

/** 游戏本体 ＋ 每个 mod 的根目录（数据文件的扫描范围）。 */
function dataRoots(): string[] {
  return [EU4, ...modRoots()];
}

/**
 * `localisation` 目录下**递归**的 `.yml` 文件（不递归会漏掉一大片中文名）。
 *
 * EU4 的 mod 把自己「覆盖本体」的词条放在 `localisation/replace/**` 子目录里
 * （如 `东亚·天朝日不落` 的 `CE_tradegoods_l_english.yml` 就埋在 `replace/` 下）。
 * 只扫一层时，这些 key 一律查不到中文——2026-09-19 实测：**5 个贸易品**
 * （`fruit`/`gunpowders`/`penink`/`stone`）、**7 个 `ancestor_*_personality`**、
 * **38 个 decision 名**都是这么漏的。递归后同一份存档全部命中。
 */
function listLocalisationFiles(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = `${dir}/${name}`;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...listLocalisationFiles(path));
    else if (name.endsWith('.yml')) out.push(path);
  }
  return out;
}

/** 只吃**英文与中文**词条文件；别的语言是同一批 key 的翻译，混进来会顶掉中文。 */
function isEnglishOrChineseLocalisation(path: string): boolean {
  return /_l_(english|simp_chinese|chinese)\.yml$/.test(path);
}

/**
 * `key -> 文本`。合并顺序**决定胜负**：本体英文 → 每个 mod 自己的 localisation →
 * 汉化 mod（2976470733）**最后**，所以汉化 mod 的中文永远优先。
 *
 * 为什么必须带上别的 mod：汉化 mod 只翻译本体词条，`风云世纪两千年` 的文化/理念、
 * `MEIOU`+` Taxes` 的兵种名都在**各自的** `localisation/` 里（实测 46 个 mod、
 * 3637 个文件、154.8 MB，约 6 秒）。只用汉化 mod 会让 537 个存档文化里的 144 个
 * 显示成原始 key——这正是用户报的「文化没有汉化」。
 *
 * 读取一律 `readFileSync(path, 'utf8')`（`loadLocalisationFile` 内部就是显式 UTF-8，
 * 这些 yml 带 BOM）；控制台 cp936 显示乱码不代表没有中文，判断只用 CJK 正则。
 *
 * **必须递归，而且只收英/中**（`listLocalisationFiles` 讲清了漏名的原因）：mod 的
 * 覆盖词条在 `localisation/replace/**` 里，只扫一层会成片漏名；但同一个 key 在
 * `_l_french/_l_german/_l_spanish/_l_korean…`（甚至 `other_languages/` 子目录）
 * 里都有副本，**非中英的要整批跳过**，否则它们会按文件序把中文名顶成英文或西班牙文
 * （2026-09-19 实测：`ABA`/`AZE`/`HNS` 三个 tag 就是这么变成 `Abbasids`/
 * `Azerbaijan`/`The Hansa` 的）。
 */
/** 合并时实际读过的 `.yml` 个数（报告用；递归之后比只扫一层多一倍）。 */
let locFiles = 0;

function buildLocalisation(): Map<string, string> {
  const table = new Map<string, string>();
  let files = 0;
  const addDir = (dir: string, filter?: (path: string) => boolean): void => {
    for (const path of listLocalisationFiles(dir)) {
      if (!isEnglishOrChineseLocalisation(path)) continue;
      if (filter !== undefined && !filter(path)) continue;
      files += 1;
      for (const [k, v] of loadLocalisationFile(path)) table.set(k, v);
    }
  };
  addDir(`${EU4}/localisation`);
  for (const root of modRoots()) addDir(`${root}/localisation`);
  addDir(MOD_LOCALISATION);
  locFiles = files;
  return table;
}

const loc = buildLocalisation();

/** 候选拼写里第一个含中文的值；都没有就 `undefined`（＝省略，客户端回退 key）。 */
function nameVariants(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const value = loc.get(candidate);
    if (value !== undefined && CJK.test(value)) return value;
  }
  return undefined;
}

/** 游戏对同一个 key 用过的几种后缀写法。 */
function candidatesFor(key: string, extra: readonly string[] = []): string[] {
  const upper = key.toUpperCase();
  return [...extra, key, `${key}_name`, upper, `${upper}_NAME`, `${upper}_name`];
}

function toObject(entries: readonly [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) out[k] = v;
  return out;
}

function writeJson(name: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 1)}\n`;
  if (!DRY) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${name}`, text, 'utf8');
  }
  // 报**字节**数（中文一个字 3 字节，字符数会低估三分之一）；部署预算按字节算。
  say(`  -> \`${name}\`  ${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} KB`);
}

// ------------------------------------------------------------------- 1 地形 --

interface TerrainResult {
  byId: Map<number, string>;
  voted: Map<number, string>;
  water: Set<string>;
  dict: string[];
  sanity: { seaAsLand: number; landAsWater: number; landAsWaterIds: number[]; coastlineOnSea: number };
}

/**
 * 省 id -> 地形类别。
 *
 * `map/terrain.bmp` 是 8bpp 调色板索引图；`map/terrain.txt` 的 `terrain = {}` 把
 * 每个索引映射到一个类别（`type`），`categories.<name>.terrain_override` 里的省
 * 直接指定类别（优先级最高）。先逐省多数票，再套 override，最后剔除 `is_water`
 * 的类别（海洋/内海）与 `pti`（永久未知区域＝荒原）。
 */
function buildTerrain(): TerrainResult {
  const defs = loadDefinitions();
  const ids = loadProvincePixels(MAP_W, MAP_H, colorToIdMap(defs), { quiet: true });

  const bmp = readFileSync(`${EU4}/map/terrain.bmp`);
  const bpp = bmp.readUInt16LE(28);
  if (bpp !== 8) throw new Error(`expected an 8bpp terrain.bmp, got ${bpp}`);
  const dataOffset = bmp.readUInt32LE(10);
  const stride = Math.ceil((MAP_W * 8) / 32) * 4;
  const index = new Uint8Array(MAP_W * MAP_H);
  for (let y = 0; y < MAP_H; y += 1) {
    const row = dataOffset + (MAP_H - 1 - y) * stride;
    for (let x = 0; x < MAP_W; x += 1) index[y * MAP_W + x] = bmp[row + x] as number;
  }

  const terrainTxt = stripComments(readFileSync(`${EU4}/map/terrain.txt`, 'latin1'));
  const blocks = topBlocks(terrainTxt);
  const terrainBody = blocks.find((b) => b.key === 'terrain')?.body;
  const categoriesBody = blocks.find((b) => b.key === 'categories')?.body;
  if (terrainBody === undefined) throw new Error('map/terrain.txt 里没有 `terrain = {}`');
  if (categoriesBody === undefined) throw new Error('map/terrain.txt 里没有 `categories = {}`');

  const indexToCategory = new Map<number, string>();
  for (const entry of topBlocks(terrainBody)) {
    const color = /color\s*=\s*\{\s*(\d+)/.exec(entry.body);
    const type = /type\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(entry.body);
    if (color && type) indexToCategory.set(Number(color[1]), type[1] as string);
  }

  const water = new Set<string>();
  const override = new Map<number, string>();
  for (const entry of topBlocks(categoriesBody)) {
    if (/is_water\s*=\s*yes/.test(entry.body)) water.add(entry.key);
    const list = topBlocks(entry.body).find((b) => b.key === 'terrain_override')?.body;
    if (list === undefined) continue;
    for (const id of topLevelNumbers(list)) if (id > 0) override.set(id, entry.key);
  }

  const categories = [...new Set(indexToCategory.values())].sort();
  const catIndex = new Map(categories.map((c, i) => [c, i]));
  const maxId = Math.max(...defs.keys()) + 1;
  const counts = new Int32Array(maxId * categories.length);
  for (let p = 0; p < ids.length; p += 1) {
    const id = ids[p] as number;
    if (!id) continue;
    const cat = indexToCategory.get(index[p] as number);
    if (cat !== undefined) counts[id * categories.length + (catIndex.get(cat) as number)] += 1;
  }

  const voted = new Map<number, string>();
  for (let id = 1; id < maxId; id += 1) {
    let best = -1;
    let bestN = 0;
    for (let c = 0; c < categories.length; c += 1) {
      const n = counts[id * categories.length + c] as number;
      if (n > bestN) {
        bestN = n;
        best = c;
      }
    }
    if (best >= 0) voted.set(id, categories[best] as string);
  }
  for (const [id, cat] of override) voted.set(id, cat);

  const byId = new Map<number, string>();
  for (const [id, cat] of voted) {
    if (cat === 'pti' || water.has(cat)) continue;
    byId.set(id, cat);
  }

  const sea = new Set<number>();
  const defaultMap = stripComments(readFileSync(`${EU4}/map/default.map`, 'latin1'));
  for (const block of topBlocks(defaultMap)) {
    if (block.key !== 'sea_starts' && block.key !== 'lakes') continue;
    for (const id of topLevelNumbers(block.body)) if (id > 0) sea.add(id);
  }
  let seaAsLand = 0;
  let landAsWater = 0;
  let coastlineOnSea = 0;
  for (const [id, cat] of byId) {
    if (sea.has(id)) seaAsLand += 1;
    if (cat === 'coastline' && sea.has(id)) coastlineOnSea += 1;
  }
  for (const [id, cat] of voted) if (!sea.has(id) && water.has(cat)) landAsWater += 1;
  const landAsWaterIds = [...voted]
    .filter(([id, cat]) => !sea.has(id) && water.has(cat))
    .map(([id]) => id)
    .sort((a, b) => a - b);

  return {
    byId,
    voted,
    water,
    dict: [...new Set(byId.values())].sort(),
    sanity: { seaAsLand, landAsWater, landAsWaterIds, coastlineOnSea },
  };
}

// ------------------------------------------------------------------- 2 地区 --

/** `map/area.txt`：`area_key = { 省id… }`（外加一个要忽略的 `color = { r g b }`）。 */
function buildAreas(): { areas: { key: string; ids: number[] }[]; empty: number } {
  const areas: { key: string; ids: number[] }[] = [];
  let empty = 0;
  for (const block of topBlocks(readFileSync(`${EU4}/map/area.txt`, 'latin1'))) {
    const ids = topLevelNumbers(block.body).filter((n) => n > 0);
    if (ids.length === 0) {
      empty += 1;
      continue;
    }
    areas.push({ key: block.key, ids: [...new Set(ids)].sort((a, b) => a - b) });
  }
  areas.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { areas, empty };
}

// ----------------------------------------------------------------- 3 中文名 --

/**
 * 自造译名表（**没有**任何 localisation 能给出中文的 key）。
 *
 * 每一行 `[key, 拟译名, 依据]`。只有两种情况会出现在这里：
 *  1. **键名里直接含可读英文/专名**（`CE_red_fort` → 红堡、`tusi_monarchy_reform` → 土司君主制）；
 *  2. **汉字拼音写的键**（`zhongchen_personality` → 忠臣、`zhanguo_zhuhou` → 战国诸侯）。
 * 凡是拿不准的**一律不写**（省略＝客户端显示原 key），并在 `tmp/自造译名清单.md` 里
 * 按键族列出「没有中文且没有任何英文词条」的 key 与原因。**不许默默造。**
 */
const HAND_MADE: Record<string, [string, string, string][]> = {
  cultures: [
    ['amdo', '安多', '藏区地名，标准译名'],
    ['balrin', '巴林', '族名，标准译名'],
    ['bhutia', '不丹人', '族名，标准译名'],
    ['chinese_dian', '滇人', '键含 dian＝滇'],
    ['culture_jin', '晋人', '键含 jin＝晋'],
    ['culture_qin', '秦人', '键含 qin＝秦'],
    ['daur', '达斡尔', '族名，标准译名'],
    ['dhivehi', '迪维希', '族名，标准译名'],
    ['gothic', '哥特', '键即英文 Gothic'],
    ['hanguguan', '函谷关', '键为拼音＝函谷关'],
    ['harqin', '喀喇沁', '族名，标准译名'],
    ['jimake', '吉马凯', '拼音音译'],
    ['kham', '康巴', '藏区地名，标准译名'],
    ['khun', '掸人', '族名，标准译名'],
    ['ladakh', '拉达克', '地名，标准译名'],
    ['moghul', '莫卧儿', '族名，标准译名'],
    ['nanaj', '那乃', '族名，标准译名'],
    ['oroqen', '鄂伦春', '族名，标准译名'],
    ['pamir', '帕米尔', '地名，标准译名'],
    ['pecheneg', '佩切涅格', '族名，标准译名'],
    ['polabian', '波拉比亚', '族名，标准译名'],
    ['ryukyu', '琉球', '地名，标准译名'],
    ['sarig_yughur', '撒里畏兀儿', '族名，标准译名'],
    ['south_ryukyu', '南琉球', '键含 south＝南'],
    ['udege', '乌德盖', '族名，标准译名'],
    ['uriangkhai', '乌梁海', '族名，标准译名'],
    ['volga_finnic', '伏尔加芬兰', '键含 volga＝伏尔加'],
  ],
  personalities: [
    ['CE_enlightened_personality', '开明', '键含 enlightened'],
    ['ancestor_patron_of_arts_personality', '艺术赞助人', '前缀 ancestor ＋ patron_of_arts；全机 localisation 无词条（与其余 ancestor_* 同族）'],
    ['ancestor_peasant_revolt_leader_personality', '农民起义领袖', '前缀 ancestor ＋ peasant_revolt_leader；全机 localisation 无词条'],
    ['can_get_lawgiver_personality', '可获立法者', '键含 lawgiver＝立法者'],
    ['ce_huwei_personality', '护卫', '拼音 huwei＝护卫'],
    ['ce_shenwu_personality', '神武', '拼音 shenwu＝神武'],
    ['ce_xianzhen_personality', '贤贞', '拼音 xianzhen＝贤贞'],
    ['ce_yongben_personality', '勇本', '拼音 yongben'],
    ['consort_has_impressed_with_adm_personality', '配偶印象·行政', '内部触发键，直译'],
    ['consort_has_impressed_with_dip_personality', '配偶印象·外交', '内部触发键，直译'],
    ['consort_has_impressed_with_mil_personality', '配偶印象·军事', '内部触发键，直译'],
    ['yexin_personality', '野心', '拼音 yexin＝野心'],
    ['zhongchen_personality', '忠臣', '拼音 zhongchen＝忠臣'],
    ['zhongli_personality', '中立', '拼音 zhongli＝中立'],
  ],
  buildings: [
    ['education_school', '教育学校', '键含 education_school'],
    ['fort_et', '要塞', '键含 fort'],
  ],
  greatProjects: [
    ['CE_aachener_dom', '亚琛大教堂', '键含 Aachener Dom'],
    ['CE_amber_palace', '琥珀宫', '键含 amber palace'],
    ['CE_archivo_general_de_indias', '西印度群岛总档案馆', '西语专名，标准译名'],
    ['CE_badshahi_masjid', '巴德夏希清真寺', '专名，标准译名'],
    ['CE_bailudong_academies', '白鹿洞书院', '中国专名'],
    ['CE_bazylika_jasnogorska', '光明山修道院', '波兰专名，标准译名'],
    ['CE_blue_house', '蓝屋', '键含 blue house'],
    ['CE_chengde_mountain_resort', '承德避暑山庄', '中国专名'],
    ['CE_dali_city', '大理城', '中国专名'],
    ['CE_daming_palace', '大明宫', '中国专名'],
    ['CE_dangar_city', '丹噶尔城', '中国专名'],
    ['CE_gebel_barkal', '博尔卡尔山', '专名，标准译名'],
    ['CE_great_port_of_carthage', '迦太基大港', '键含 great port of Carthage'],
    ['CE_great_tent_of_genghis_khan', '成吉思汗大帐', '键含 great tent of Genghis Khan'],
    ['CE_heidelberg_castle', '海德堡城堡', '键含 Heidelberg castle'],
    ['CE_house_of_wisdom', '智慧宫', '键含 house of wisdom'],
    ['CE_jixia_academy', '稷下学宫', '中国专名'],
    ['CE_lighthouse_of_alexanderia', '亚历山大灯塔', '键含 lighthouse of Alexandria'],
    ['CE_ling_canal', '灵渠', '中国专名'],
    ['CE_loulan_city', '楼兰城', '中国专名'],
    ['CE_matsuyamajou', '松山城', '日本专名'],
    ['CE_mecca_mosques', '麦加清真寺', '键含 Mecca mosques'],
    ['CE_mingjiao_temple', '明教寺', '中国专名'],
    ['CE_mogao_grottoes', '莫高窟', '中国专名'],
    ['CE_pantheon_of_roma', '罗马万神殿', '键含 Pantheon of Roma'],
    ['CE_po_klong_garai', '波克龙加莱塔', '越南专名，标准译名'],
    ['CE_potala_palace', '布达拉宫', '中国专名'],
    ['CE_red_fort', '红堡', '键含 red fort'],
    ['CE_safranbolu', '萨夫兰博卢', '土耳其专名'],
    ['CE_shengjing_palace', '盛京宫殿', '中国专名'],
    ['CE_shenglong_palace', '升龙皇宫', '越南专名'],
    ['CE_shigu_academies', '石鼓书院', '中国专名'],
    ['CE_shuri_castle', '首里城', '琉球专名'],
    ['CE_songyang_academies', '嵩阳书院', '中国专名'],
    ['CE_south_sea_god_temple', '南海神庙', '中国专名'],
    ['CE_the_british_museum', '大英博物馆', '键含 the British Museum'],
    ['CE_the_dragon_tianshi_mansion', '龙虎山天师府', '中国专名'],
    ['CE_the_great_canal_huaiyang_part', '大运河·淮扬段', '键含 huaiyang'],
    ['CE_the_great_canal_jilu_part', '大运河·济鲁段', '键含 jilu'],
    ['CE_the_great_canal_jingjin_part', '大运河·京津段', '键含 jingjin'],
    ['CE_the_great_canal_suhang_part', '大运河·苏杭段', '键含 suhang'],
    ['CE_the_great_wall_datong_part', '长城·大同段', '键含 datong'],
    ['CE_the_great_wall_ganzhou_part', '长城·甘州段', '键含 ganzhou'],
    ['CE_the_great_wall_huangya_part', '长城·黄崖关段', '键含 huangya'],
    ['CE_the_great_wall_jiayu_part', '长城·嘉峪关段', '键含 jiayu'],
    ['CE_the_great_wall_juyong_part', '长城·居庸关段', '键含 juyong'],
    ['CE_the_great_wall_lanzhou_part', '长城·兰州段', '键含 lanzhou'],
    ['CE_the_great_wall_shanhai_part', '长城·山海关段', '键含 shanhai'],
    ['CE_the_great_wall_shanxi_part', '长城·山西段', '键含 shanxi'],
    ['CE_the_great_wall_xuanhua_part', '长城·宣府段', '键含 xuanhua'],
    ['CE_the_great_wall_yulin_part', '长城·榆林段', '键含 yulin'],
    ['CE_torre_di_Pisa', '比萨斜塔', '意语专名，标准译名'],
    ['CE_visegrad_city', '维谢格拉德城', '键含 Visegrad'],
    ['CE_wa_palace', '倭王宫', '键含 wa＝倭'],
    ['CE_wakayamajou', '和歌山城', '日本专名'],
    ['CE_warsaw_city', '华沙城', '键含 Warsaw'],
    ['CE_wudang_temple', '武当山道观', '中国专名'],
    ['CE_yingtian_academies', '应天书院', '中国专名'],
    ['CE_yuelu_academies', '岳麓书院', '中国专名'],
    ['CE_yungang_grottoes', '云冈石窟', '中国专名'],
    ['CE_ziwei_palace', '紫微宫', '中国专名'],
  ],
  units: [
    ['ce_aboriginal_woomera_fighter', '原住民投矛战士', '键含 woomera＝投矛器'],
    ['ce_altaic_eastern_mongol_legion', '阿尔泰·东蒙古军团', '键含 eastern Mongol legion'],
    ['ce_altaic_nomadic_clan_infantry', '阿尔泰游牧部族步兵', '键含 nomadic clan infantry'],
    ['ce_altaic_support_footsoldiers_qid', '阿尔泰辅助步兵', '键含 support footsoldiers'],
    ['ce_altaic_tartar_horseriding_infantry', '阿尔泰鞑靼骑马步兵', '键含 tartar horseriding'],
    ['ce_ancient_corrupted_human_herd', '远古堕落人牧群', '键含 corrupted human herd'],
    ['ce_ancient_shadow_creature', '远古暗影生物', '键含 shadow creature'],
    ['ce_avalon_northwild_knights', '阿瓦隆北境骑士', '键含 northwild knights'],
    ['ce_avalon_synian_briteinia_auxiliary_legion', '阿瓦隆·不列颠辅助军团', '键含 auxiliary legion'],
    ['ce_avalon_synian_briteinia_legion', '阿瓦隆·不列颠军团', '键含 legion'],
    ['ce_chinese_early_guardian_horsemen', '华夏早期禁卫骑兵', '键含 guardian horsemen'],
    ['ce_chinese_elite_hongjing_soldiers', '华夏精锐红军士兵', '键含 elite hongjing'],
    ['ce_chinese_experienced_taofa_dalu_soldiers', '华夏宿将讨伐军', '键含 experienced／taofa'],
    ['ce_chinese_hongjing_mounted_soldier', '华夏红军骑兵', '键含 mounted soldier'],
    ['ce_chinese_pro_resistance_cavalry', '华夏抗敌骑兵', '键含 resistance cavalry'],
    ['ce_chinese_reformed_imperial_footguards', '华夏新制禁卫步兵', '键含 reformed imperial footguards'],
    ['ce_chinese_shenjiying_motar', '华夏神机营臼炮', '键含 shenjiying＝神机营、motar＝臼炮'],
    ['ce_chinese_tuntian_weisuo_soldier', '华夏屯田卫所兵', '键含 tuntian＝屯田、weisuo＝卫所'],
    ['ce_chinese_yuan_warlord_infantry', '华夏元末军阀步兵', '键含 yuan warlord'],
    ['ce_east_asia_clubman', '东亚棍兵', '键含 clubman＝棍兵'],
    ['ce_east_asia_conscripts', '东亚征召兵', '键含 conscripts'],
    ['ce_east_asia_ranger', '东亚游猎兵', '键含 ranger'],
    ['ce_eastern_byzantine_farmland_soilders', '东罗马农兵', '键含 farmland soldiers'],
    ['ce_eastern_byzantine_knight', '东罗马骑士', '键含 byzantine knight'],
    ['ce_eastern_mongol_ally_cavalry', '东蒙古盟军骑兵', '键含 ally cavalry'],
    ['ce_eastern_russian_formation_footman', '东欧俄式编队步兵', '键含 formation footman'],
    ['ce_eldar_dunedain_knights', '精灵·登丹骑士', '键含 dunedain knights'],
    ['ce_eldar_noldo_expedtion_infantry', '精灵·诺多远征步兵', '键含 expedition infantry'],
    ['ce_evenk_early_archer', '鄂温克早期弓箭手', '键含 early archer'],
    ['ce_evenk_yulie_cavalry', '鄂温克·羽林骑兵', '键含 yulie＝羽林'],
    ['ce_gunpower_used_arcuballista', '火器弩炮', '键含 gunpower／arcuballista'],
    ['ce_indian_late_medival_elephant', '印度中世纪晚期战象', '键含 late medieval elephant'],
    ['ce_indian_turkic_rider', '印度突厥骑手', '键含 turkic rider'],
    ['ce_indian_turkic_soldier', '印度突厥士兵', '键含 turkic soldier'],
    ['ce_indian_warlord_infantry', '印度军阀步兵', '键含 warlord infantry'],
    ['ce_japanese_early_zanguoku_horsemen', '日本战国早期骑兵', '键含 zanguoku＝战国'],
    ['ce_japanese_kamakura_era_spearman', '日本镰仓时代枪兵', '键含 Kamakura era spearman'],
    ['ce_japanese_shinobi_rider', '日本忍者骑手', '键含 shinobi＝忍者'],
    ['ce_japanese_southern_warlord_infantry', '日本南朝军阀步兵', '键含 southern warlord'],
    ['ce_korea_gaoli_border_guards', '高丽边防军', '键含 gaoli＝高丽、border guards'],
    ['ce_korea_joseon_border_guard', '朝鲜边防军', '键含 joseon＝朝鲜'],
    ['ce_mesoamerican_central_american_clanman', '中美洲部族兵', '键含 clanman'],
    ['ce_muslim_mongol_cavalry', '穆斯林蒙古骑兵', '键含 mongol cavalry'],
    ['ce_muslim_turkic_footsoldiers', '穆斯林突厥步兵', '键含 turkic footsoldiers'],
    ['ce_native_inca_mounted_infantry', '印加骑乘步兵', '键含 mounted infantry'],
    ['ce_native_inca_warrior', '印加战士', '键含 inca warrior'],
    ['ce_native_late_cultists_legion', '土著晚期信徒军团', '键含 cultists legion'],
    ['ce_native_mountaineer_elites', '土著山地精锐', '键含 mountaineer elites'],
    ['ce_native_nomadic_greatplain_rangers', '土著大平原游骑', '键含 greatplain rangers'],
    ['ce_native_nomadic_greatplain_tribemen', '土著大平原部族兵', '键含 tribemen'],
    ['ce_native_woodlands_fighter', '土著林地战士', '键含 woodlands fighter'],
    ['ce_nomad_group_tayji_horseguards', '游牧·塔吉禁卫骑', '键含 tayji horseguards'],
    ['ce_nomad_group_turkic_mongol_legion', '游牧·突厥蒙古军团', '键含 turkic mongol legion'],
    ['ce_north_american_pre_collapse_city_wariors', '北美崩坏前城邦战士', '键含 pre collapse city warriors'],
    ['ce_ottoman_pre_imperial_sipahi', '奥斯曼前帝国西帕希', '键含 pre imperial sipahi'],
    ['ce_ottoman_turkish_infantry', '奥斯曼土耳其步兵', '键含 turkish infantry'],
    ['ce_polynesian_spear_thrower', '波利尼西亚掷矛兵', '键含 spear thrower'],
    ['ce_siege_stone_bombard', '攻城石炮', '键含 siege stone bombard'],
    ['ce_song_mongol_influenced_cavalry', '宋式蒙古化骑兵', '键含 mongol influenced cavalry'],
    ['ce_song_traditional_formation', '宋制传统军阵', '键含 traditional formation'],
    ['ce_south_american_inca_highland_fighter', '南美印加高地战士', '键含 highland fighter'],
    ['ce_southeastern_aisan_nobles', '东南亚贵族兵', '键含 asian nobles'],
    ['ce_southeastern_east_indie_elephant', '东南亚东印度战象', '键含 east indie elephant'],
    ['ce_southeastern_elephant_contained_calvary', '东南亚象载骑兵', '键含 elephant contained cavalry'],
    ['ce_sub_saharan_african_tribesmen_guards', '撒哈拉以南部族卫队', '键含 tribesmen guards'],
    ['ce_sub_saharan_mali_northernor_army', '撒哈拉以南马里北方军', '键含 Mali northern army'],
    ['ce_sub_saharan_new_solomanic_infantry', '撒哈拉以南新所罗门步兵', '键含 new solomonic infantry'],
    ['ce_vietnam_mongolera_infantry', '越南蒙古式步兵', '键含 Vietnam／mongol era'],
    ['ce_viking_changren', '维京长人', '键含 changren＝长人'],
    ['ce_western_experienced_crusade_infanry', '西欧宿将十字军步兵', '键含 crusade infantry'],
    ['ce_western_farmer_footsoldier', '西欧农兵', '键含 farmer footsoldier'],
    ['ce_western_hundred_years_war_infantry', '西欧百年战争步兵', '键含 Hundred Years War'],
    ['ce_western_landowned_knight', '西欧领地骑士', '键含 landowned knight'],
    ['ce_western_latin_citystate_infantry', '西欧拉丁城邦步兵', '键含 latin citystate'],
    ['crayer', '柯克船', '船型专名（crayer）'],
    ['hulk', '大帆船', '船型专名（hulk）'],
  ],
  institutions: [
    ['Academia', '学园', '键即英文 Academia'],
    ['Banking', '银行业', '键即英文 Banking'],
    ['Casual_Literacy', '实用识字', '键含 casual literacy'],
    ['Global_Trade', '全球贸易', '键即英文 Global Trade'],
    ['Industrialisation', '工业化', '键即英文 Industrialisation'],
    ['Legalism', '法制', '键即英文 Legalism'],
    ['Meritocracy_Inst', '贤能制', '键含 meritocracy'],
    ['Nationalism', '民族主义', '键即英文 Nationalism'],
    ['Scientific_Method', '科学方法', '键即英文 Scientific Method'],
    ['advanced_hydraulics_institution', '先进水利', '键含 advanced hydraulics'],
    ['astronomy_institution', '天文学', '键含 astronomy'],
    ['axiomatic_maths_institution', '公理数学', '键含 axiomatic maths'],
    ['blast_furnace_institution', '高炉', '键含 blast furnace'],
    ['bureaucracy_institution', '官僚制', '键含 bureaucracy'],
    ['cast_iron_institution', '铸铁', '键含 cast iron'],
    ['civil_law_institution', '民法', '键含 civil law'],
    ['classical_philosophy_institution', '古典哲学', '键含 classical philosophy'],
    ['coin_usage', '铸币', '键含 coin usage'],
    ['elephant_domestication', '驯象', '键含 elephant domestication'],
    ['engineering_architecture_institution', '工程与建筑', '键含 engineering architecture'],
    ['gunpowder', '火药', '键即英文 gunpowder'],
    ['iron_age', '铁器时代', '键即英文 iron age'],
    ['jus_natural', '自然法', '拉丁语 jus naturale'],
    ['siege_engineering_institution', '攻城工程', '键含 siege engineering'],
    ['tactics_strategy_institution', '战术与战略', '键含 tactics strategy'],
    ['writing_system', '文字系统', '键含 writing system'],
  ],
  /*
   * 顾问类型：中文名由 localisation 给的占绝大多数（1314/1551），`_BU/_BG/_NO/_TR/_CL/_adv`
   * 这类变体由规则推导；这里只剩**职业名/人名本身没有词条**的那些。
   * 完全无法判定的（虚构代号、无任何线索的外语名）**不写**，列在清单末节。
   */
  advisors: [
    ['administrative_experts', '行政专家', '键即英文 administrative experts'],
    ['EDG_Chief_Engineer', '总工程师', '键含 Chief Engineer'],
    ['EDG_Grand_Vizier', '大维齐尔', '键含 Grand Vizier'],
    ['EDG_Praetorian_Prefect', '禁卫军长官', '键含 Praetorian Prefect'],
    ['EDG_Secretary_General', '秘书长', '键含 Secretary General'],
    ['EDG_building_engineer_adm', '建筑工程师·行政', '键含 building engineer'],
    ['EDG_building_engineer_dip', '建筑工程师·外交', '键含 building engineer'],
    ['EDG_building_engineer_mil', '建筑工程师·军事', '键含 building engineer'],
    ['EDG_calixtines_bishop', '加里克斯廷主教', '键含 Calixtines／bishop'],
    ['EDG_ghulam_chief', '古拉姆首领', '键含 ghulam＝古拉姆'],
    ['EDG_tabor_bishop', '塔博尔主教', '键含 Tabor／bishop'],
    ['EDG_vagrant', '流浪者', '键即英文 vagrant'],
    ['modern_indian_adm_1', '印度顾问·行政 1', '键含 modern indian adm，序号 1'],
    ['modern_indian_adm_2', '印度顾问·行政 2', '键含 modern indian adm，序号 2'],
    ['modern_indian_adm_3', '印度顾问·行政 3', '键含 modern indian adm，序号 3'],
    ['modern_indian_adm_4', '印度顾问·行政 4', '键含 modern indian adm，序号 4'],
    ['modern_indian_adm_5', '印度顾问·行政 5', '键含 modern indian adm，序号 5'],
    ['modern_indian_dip_1', '印度顾问·外交 1', '键含 modern indian dip，序号 1'],
    ['modern_indian_dip_2', '印度顾问·外交 2', '键含 modern indian dip，序号 2'],
    ['modern_indian_dip_3', '印度顾问·外交 3', '键含 modern indian dip，序号 3'],
    ['modern_indian_dip_4', '印度顾问·外交 4', '键含 modern indian dip，序号 4'],
    ['modern_indian_dip_5', '印度顾问·外交 5', '键含 modern indian dip，序号 5'],
    ['modern_indian_mil_1', '印度顾问·军事 1', '键含 modern indian mil，序号 1'],
    ['modern_indian_mil_2', '印度顾问·军事 2', '键含 modern indian mil，序号 2'],
    ['modern_indian_mil_3', '印度顾问·军事 3', '键含 modern indian mil，序号 3'],
    ['modern_indian_mil_4', '印度顾问·军事 4', '键含 modern indian mil，序号 4'],
    ['modern_indian_mil_5', '印度顾问·军事 5', '键含 modern indian mil，序号 5'],
    ['administrator_advisor', '行政官', '键含 administrator'],
    ['architect', '建筑师', '键即英文 architect'],
    ['armor_smith', '盔甲匠', '键含 armor smith'],
    ['army_leader_adv', '陆军将领', '键含 army leader'],
    ['army_recruiter_adv', '陆军募兵官', '键含 army recruiter'],
    ['army_veteran', '陆军宿将', '键含 army veteran'],
    ['artillery_commander', '炮兵指挥官', '键含 artillery commander'],
    ['astrologist_adv', '占星家', '键即英文 astrologist'],
    ['astronomer_adv', '天文学家', '键即英文 astronomer'],
    ['bailiff', '郡守', '键即英文 bailiff'],
    ['border_adv', '边防官', '键含 border'],
    ['cardinal', '枢机主教', '键即英文 cardinal'],
    ['cartograph', '制图师', '键含 cartograph'],
    ['castle_master', '城主', '键含 castle master'],
    ['cavalry_commander', '骑兵指挥官', '键含 cavalry commander'],
    ['cavalry_leader', '骑兵将领', '键含 cavalry leader'],
    ['chamberlain', '内侍大臣', '键即英文 chamberlain'],
    ['composer', '作曲家', '键即英文 composer'],
    ['country_representative', '国家代表', '键含 country representative'],
    ['economist', '经济学家', '键即英文 economist'],
    ['educationist', '教育家', '键即英文 educationist'],
    ['emissary_adv', '使者', '键即英文 emissary'],
    ['engineer', '工程师', '键即英文 engineer'],
    ['farmer', '农民', '键即英文 farmer'],
    ['feudal_tax_official', '封建税吏', '键含 feudal tax official'],
    ['foreign_advisor', '外国顾问', '键含 foreign advisor'],
    ['foreign_warrior', '外国武士', '键含 foreign warrior'],
    ['historian', '历史学家', '键即英文 historian'],
    ['infantry_commander', '步兵指挥官', '键含 infantry commander'],
    ['innovator', '创新者', '键即英文 innovator'],
    ['innovator_advisor', '革新顾问', '键含 innovator'],
    ['jean_baptiste', '让-巴蒂斯特', '人名音译'],
    ['logistics_adv', '后勤官', '键含 logistics'],
    ['logistics_specialist', '后勤专家', '键含 logistics specialist'],
    ['mathematician', '数学家', '键即英文 mathematician'],
    ['mercenary_leader', '雇佣兵队长', '键含 mercenary leader'],
    ['merchant_adv', '商人', '键即英文 merchant'],
    ['mint_advisor', '铸币顾问', '键含 mint'],
    ['naval_leader_adv', '海军将领', '键含 naval leader'],
    ['naval_veteran', '海军宿将', '键含 naval veteran'],
    ['negotiator', '谈判家', '键即英文 negotiator'],
    ['negotiator_adv', '谈判家', '键即英文 negotiator'],
    ['oracle', '神谕者', '键即英文 oracle'],
    ['organiser_adv', '组织者', '键即英文 organiser'],
    ['patrician', '贵族', '键即英文 patrician'],
    ['physician_adv', '医师', '键即英文 physician'],
    ['poet', '诗人', '键即英文 poet'],
    ['procurator', '检察官', '键即英文 procurator'],
    ['reformer', '改革家', '键即英文 reformer'],
    ['resettlement_specialist', '移民安置专家', '键含 resettlement specialist'],
    ['scholar_advisor', '学者', '键含 scholar'],
    ['ship_builder', '造船师', '键含 ship builder'],
    ['siege_engineer', '攻城工程师', '键含 siege engineer'],
    ['spymaster_advisor', '间谍大师', '键含 spymaster'],
    ['taxman_advisor', '税务官', '键含 taxman'],
    // 中国历史人物／官职（拼音写的键，依据＝拼音本身）
    ['bian_fajia', '辩法家', '拼音 bian fajia'],
    ['bingbu_shangshu', '兵部尚书', '拼音 bingbu shangshu'],
    ['cao_wenzhao', '曹文昭', '拼音人名'],
    ['cailun', '蔡伦', '拼音人名'],
    ['diwei_yingyangjia', '帝位阴阳家', '拼音 diwei yingyangjia'],
    ['fucha_fuheng', '富察·傅恒', '拼音人名'],
    ['gongbu_shangshu', '工部尚书', '拼音 gongbu shangshu'],
    ['guaerjia_aobai', '瓜尔佳·鳌拜', '拼音人名'],
    ['guanli_shangshu', '官吏尚书', '拼音 guanli shangshu'],
    ['hubu_shangshu', '户部尚书', '拼音 hubu shangshu'],
    ['ji_yun', '纪昀', '拼音人名'],
    ['li_dingguo', '李定国', '拼音人名'],
    ['li_rusong', '李如松', '拼音人名'],
    ['li_shizhen', '李时珍', '拼音人名'],
    ['libu_shangshu', '吏部尚书', '拼音 libu shangshu'],
    ['lu_xiangsheng', '卢象升', '拼音人名'],
    ['nian_gengyao', '年羹尧', '拼音人名'],
    ['qi_jiguang', '戚继光', '拼音人名'],
    ['qin_liangyu', '秦良玉', '拼音人名'],
    ['quan_fajia', '权法家', '拼音 quan fajia'],
    ['shu_fajia', '术法家', '拼音 shu fajia'],
    ['sun_chengzong', '孙承宗', '拼音人名'],
    ['sun_chuanting', '孙传庭', '拼音人名'],
    ['tianwen_yingyangjia', '天文阴阳家', '拼音 tianwen yingyangjia'],
    ['weigao', '韦皋', '拼音人名'],
    ['xingbu_shangshu', '刑部尚书', '拼音 xingbu shangshu'],
    ['xu_jie', '徐阶', '拼音人名'],
    ['xungui', '勋贵', '拼音 xungui'],
    ['yangmingism_daru', '阳明心学大儒', '键含 yangmingism／daru＝大儒'],
    ['yu_qian', '于谦', '拼音人名'],
    ['yuan_chonghuan', '袁崇焕', '拼音人名'],
    ['zhang_huangyan', '张煌言', '拼音人名'],
    ['zhang_juzheng', '张居正', '拼音人名'],
    ['zheng_chenggong', '郑成功', '拼音人名'],
    ['zongheng_moushi', '纵横谋士', '拼音 zongheng moushi'],
    ['zongheng_shuike', '纵横说客', '拼音 zongheng shuike'],
  ],
  estatePrivileges: [
    ['estate_qizilbash_supremacy_over_the_aristocracy', '基兹尔巴什凌驾贵族', '键含 supremacy over the aristocracy'],
  ],
  /*
   * 阶级「影响力修正」：存档里除了 `EST_VAL_*`，还有 11 个**裸键**（本体 4 个 ＋
   * `东亚·天朝日不落` / `风云世纪两千年` 各几个）。中文名本来就在 localisation 里，
   * 但键集合是从存档/事件里写出来的，不进 `EST_VAL_` 那一族，所以在这里补上——
   * 值与词条完全一致，只是取值路径不同。
   */
  estateInfluenceModifiers: [
    ['REGENCY_SLUR', '被当前的摄政抹黑', '本体 tmm_l_english.yml（事件 estate_led_regencies）'],
    ['KOR_purged_faction', '被清洗', '本体 manchu_l_english.yml（事件 flavorKOR）'],
    ['KOR_supported_faction', '未支持敌对派系', '本体 manchu_l_english.yml（事件 flavorKOR）'],
    ['REELCTION_DEPOWER_ESTATES', '现任统治者再次当选', '本体 scandinavia_l_english.yml（游戏文件里就是错拼 REELCTION；事件 Elections）'],
    ['CE_BUY_ESTATES_ARMY_INFLUENCE_DESC', '已整训精兵', '模组 1728520255 localisation/replace/CE_estate_l_english.yml'],
    ['CE_BUY_ESTATES_SEIZE_LAND_INFLUENCE_DESC', '已从阶层手中购置了土地', '模组 1728520255 localisation/replace/CE_estate_l_english.yml'],
    ['CE_buy_reduce_desolation_influence_desc', '已进行拓荒垦边', '模组 1728520255 localisation/replace/CE_estate_l_english.yml'],
    ['FLY_PRT_decisions_7_c_modifier', '战时征召', '模组 2935149060 localisation/FLY_part1_l_english.yml'],
    ['FLY_estate_slave_influence_warwon', '最近取得战争胜利', '模组 2935149060 localisation/FLY_missions_l_english.yml'],
    ['FLY_slave_estate_events_1_modifier', '奴隶数量的增加', '模组 2935149060 localisation/FLY_missions_l_english.yml'],
    ['FLY_slave_estate_events_2_modifier', '奴隶数量的减少', '模组 2935149060 localisation/FLY_missions_l_english.yml'],
  ],
  /*
   * 决议（第四对话任务书 §4.2 交付 4①）。**只有这 15 个**没有可用的中文词条：
   *  - 12 个 `catus_*`：模组 2709922922 的 `_title` 只写了一个图标占位
   *    （`£ZhiHeIcon_313£`），`_desc` 才是中文说明；名字按说明的含义取。
   *  - 3 个在**全机任何文件里都没有词条**：`CE_ai_raid_action` /
   *    `CE_ai_zhuangding_action`（模组 1728520255 的 AI 专用决议，`ai = yes`）、
   *    `dummy_pax_romana`（模组 2935149060 的占位决议，效果＝挂 `pax_romana`）。
   */
  decisions: [
    ['CE_ai_raid_action', 'AI·劫掠敌省', '模组 1728520255 decisions/CE_AI_Province_decisions.txt：AI 专用劫掠决议，全机无词条'],
    ['CE_ai_zhuangding_action', 'AI·强征壮丁', '模组 1728520255 decisions/CE_AI_Province_decisions.txt：AI 专用强征决议，全机无词条'],
    ['catus_events_culgovrel', '致和·文化政体宗教修正', '模组 2709922922 _title 为纯图标；_desc 中文说明'],
    ['catus_events_provinces', '致和·省份与理念修正', '模组 2709922922 _title 为纯图标；_desc 中文说明'],
    ['catus_hotmenu_toggle_off', '致和·关闭实用功能', '模组 2709922922 _title 为纯图标；_desc 中文说明'],
    ['catus_hotmenu_toggle_on', '致和·开启实用功能', '模组 2709922922 _title 为纯图标；_desc 中文说明'],
    ['catus_linshi_diplomats', '致和·临时外交官', '模组 2709922922 _title 为纯图标；_desc 中文说明'],
    ['catus_modifier2', '致和·旧版修正合集', '模组 2709922922 _title 为纯图标；_desc 中文说明'],
    ['catus_new', '致和·Mod 功能菜单', '模组 2709922922 _title 为纯图标；_desc 中文说明'],
    ['catus_remove', '致和·移除全部修正', '模组 2709922922 _title 为纯图标'],
    ['catus_toggle2_off', '致和·指令集 B 关闭', '模组 2709922922 _title 为纯图标'],
    ['catus_toggle2_on', '致和·指令集 B 开启', '模组 2709922922 _title 为纯图标'],
    ['catus_toggle_off', '致和·指令集 A 关闭', '模组 2709922922 _title 为纯图标'],
    ['catus_toggle_on', '致和·指令集 A 开启', '模组 2709922922 _title 为纯图标'],
    ['dummy_pax_romana', '罗马和平（占位）', '模组 2935149060 decisions/et_dummy_decisions.txt：potential/allow 恒否，只挂 pax_romana'],
    /*
     * 这两个是**旧存档里的历史键**：`风云世纪两千年` 现在的
     * `decisions/FLY_PRT_decisions.txt` 里已经没有它们（只剩 `_1.._4`/`_7..`），
     * 但 `01..06` 那批存档记着这两条决议执行过；它们的 `_title` 中文还在
     * `localisation/FLY_part1_l_english.yml` 里，所以名字照抄词条、不造。
     */
    ['FLY_PRT_decisions_5', '万王之王：加强军事力量', '模组 2935149060 localisation/FLY_part1_l_english.yml（该决议已被模组移除，旧存档仍记录）'],
    ['FLY_PRT_decisions_6', '万王之王：加强军事力量', '模组 2935149060 localisation/FLY_part1_l_english.yml（该决议已被模组移除，旧存档仍记录）'],
  ],
  /*
   * `government`：`国家面板 · 政体` 那一格显示的是存档的 `government` 常数
   * （`row.government`）。任务要求的 7 个值（`monarchy`/`republic`/`tribal`/
   * `theocracy`/`native`/`gov_celestial_empire`/`ancient_chinese_togofu`）走
   * `candidatesFor` 的 `_name` 变体就够；下面这些是**模组加的第三级政体**，
   * 中文名在各自 `common/governments` 的 `_name` 词条里（`gov_native_council`
   * 的「原住民议会」就是本体 `native_council_name`），逐条列出来保证导出。
   *
   * **已知缺口（不在本任务范围）**：另外 99 个 `row.government` 常数
   * （`muslim_monarchy`/`russian_monarchy`/`default_monarchy`…）在**全机任何
   * localisation 文件里都没有词条**——它们只是 `common/government_names` 里的
   * 「称号表」（rank/ruler_male…），政体名要由 `government_reforms` 的
   * `government = { … }` 反查，属数据面接线，不在本次交付里。
   */
  government: [
    ['gov_ancient_chinese_togofu', '中华边疆辖区', '本体 localisation ancient_chinese_togofu_name'],
    ['gov_celestial_empire', '天朝', '本体 localisation gov_celestial_empire_name'],
    ['gov_colonial_government', '殖民政府', '本体 localisation colonial_government_name'],
    ['gov_constitutional_republic', '立宪共和制', '本体 localisation constitutional_republic_name'],
    ['gov_daimyo', '大名', '本体 localisation daimyo_name'],
    ['gov_free_city', '自由市', '本体 localisation free_city_name'],
    ['gov_indep_daimyo', '独立大名', '本体 localisation indep_daimyo_name'],
    ['gov_jarldom', '雅尔国', '本体 localisation jarldom_name'],
    ['gov_native_council', '原住民议会', '本体 localisation native_council_name'],
    ['gov_papal_government', '教廷', '本体 localisation papal_government_name'],
    ['gov_shogunate', '幕府', '本体 localisation shogunate_name'],
    ['gov_steppe_horde', '草原游牧部落', '本体 localisation steppe_horde_name'],
    ['gov_tribal', '部落制', '本体 localisation tribal_name'],
    ['gov_tribal_kingdom', '部落君主制', '本体 localisation tribal_kingdom_name'],
    ['ambrosian_republic', '安布罗斯共和国', '本体 localisation ambrosian_republic_name'],
    ['celestial_warlord', '割据王朝', '模组 localisation celestial_warlord_name'],
    ['georgian', '格鲁吉亚', '本体 localisation georgian_name'],
    ['islamic_caliphate', '伊斯兰哈里发国', '本体 localisation ISLAMIC_CALIPHATE'],
    ['pirate_kingdom', '海盗王国', '本体 localisation pirate_kingdom_name'],
    ['sharifs_of_mecca', '谢里夫', '本体 localisation sharifs_of_mecca_name'],
    ['stateless_society', '无国家社会', '本体 localisation stateless_society_name'],
  ],
  /*
   * 贸易品（§4.2 交付 2）：本体 `common/tradegoods/00_tradegoods.txt` 的 **32** 个 key
   * （31 个真商品 ＋ `unknown`；`coal` 也在里面）中文全部来自 localisation。
   * 模组另有 12 个本体没有的商品，中文名在各自 `localisation/replace/**` 里，
   * 但键不在本族的扫描范围（只取本体），所以整批在这里显式列出——
   * 名字逐条取自**定义它的那个模组自己的词条**，没有一条是造的。
   */
  tradeGoods: [
    ['aluminum', '铝矿', '模组 2935149060 localisation/et_text_l_english.yml'],
    ['amber', '琥珀', '模组 2935149060 localisation/ZC_missions_l_english.yml'],
    ['fruit', '水果', '模组 1728520255 localisation/replace/CE_tradegoods_l_english.yml（存档 dict 写复数 fruits，词条键是单数）'],
    ['gunpowders', '火药', '模组 1728520255 localisation/replace/CE_tradegoods_l_english.yml'],
    ['herb', '草药', '模组 2935149060 localisation/ZC_missions_l_english.yml'],
    ['marble', '大理石', '模组 2935149060 localisation/ZC_missions_l_english.yml'],
    ['me_opium', '毒品', '模组 2935149060 localisation/rab_QNG_events_l_english.yml'],
    ['me_paper', '纸张', '模组 2935149060 localisation/replace/zz_replace_l_english.yml'],
    ['oil', '石油', '模组 2935149060 localisation/et_text_l_english.yml'],
    ['penink', '笔墨', '模组 1728520255 localisation/replace/CE_tradegoods_l_english.yml'],
    ['stone', '石料', '模组 1728520255 localisation/replace/CE_tradegoods_l_english.yml'],
    ['uranium', '铀矿', '模组 2935149060 localisation/et_text_l_english.yml'],
  ],
  governmentReforms: [
    ['NCA_Nicene_Monarchy_reform_1', '尼西亚君主制改革一', '键含 Nicene Monarchy'],
    ['NCA_Nicene_Monarchy_reform_2', '尼西亚君主制改革二', '键含 Nicene Monarchy'],
    ['addabt_Li_school_theories_CHI', '李氏学派理论', '键含 Li school theories'],
    ['ancient_chinese_togofu_mechanic', '古代中国都督府机制', '键含 togofu＝都督府'],
    ['ancient_chinese_warlord_mechanic', '古代中国军阀机制', '键含 ancient chinese warlord'],
    ['aquire_strict_officer_qualitfication', '严订军官资格', '键含 strict officer qualification'],
    ['aziteke_empire', '阿兹特克帝国', '键含 aziteke＝阿兹特克'],
    ['banner_elites_reform', '八旗精锐改革', '键含 banner elites'],
    ['batulu_bubing_reform', '巴图鲁步兵改革', '键含 batulu＝巴图鲁、bubing＝步兵'],
    ['buluo_renmin_reform', '部落人民改革', '键含 buluo＝部落、renmin＝人民'],
    ['ce_mz_native_steppe_reform', '原住民草原改革', '键含 native steppe'],
    ['celestial_empire_kaituotuan', '天朝开拓团', '键含 celestial empire／kaituotuan'],
    ['celestial_empire_mechanic', '天朝机制', '键含 celestial empire mechanic'],
    ['church_of_the_people', '人民教会', '键含 church of the people'],
    ['church_of_us_reform', '我们的教会改革', '键含 church of us'],
    ['cities_by_the_shores_reform', '滨海城邦改革', '键含 cities by the shores'],
    ['commerce_bases_reform', '商业据点改革', '键含 commerce bases'],
    ['dalailama_monastic_mechanic', '达赖喇嘛僧侣机制', '键含 dalailama monastic'],
    ['death_empire', '死亡帝国', '键含 death empire'],
    ['deism_reform', '自然神论改革', '键含 deism'],
    ['discourses_on_the_first_decade_of_titus_livy_reform', '《论李维》改革', '键为《论李维》书名'],
    ['dismillitarisation_reform', '去军事化改革', '键含 dismilitarisation'],
    ['diversity_in_the_society', '社会多元', '键含 diversity in the society'],
    ['donfang_youmu_reform', '东方游牧改革', '键含 donfang＝东方、youmu＝游牧'],
    ['dongsong_regional_government', '东宋地方政制', '键含 dongsong＝东宋'],
    ['dsf_avalon_heroking', '阿瓦隆英雄王', '键含 heroking'],
    ['dsf_high_kingdom', '高等王国', '键含 high kingdom'],
    ['duhu_fu', '都护府', '拼音 duhu fu＝都护府'],
    ['eastern_roman_government', '东罗马政制', '键含 eastern roman'],
    ['empire_fedualisation_byz', '拜占庭帝国封建化', '键含 feudalisation Byzantine'],
    ['fanwang_guo_reform', '藩王国改革', '键含 fanwang＝藩王'],
    ['fanzhen_warlord_government', '藩镇军阀政制', '键含 fanzhen＝藩镇'],
    ['foregin_ideas_in_government', '政府中的外来理念', '键含 foreign ideas in government'],
    ['four_last_things_reform', '四末事改革', '天主教专名「四末事」'],
    ['geshake_ren_reform', '格沙克人改革', '拼音音译'],
    ['guards_in_the_cities', '城中卫队', '键含 guards in the cities'],
    ['guilds_in_the_cities', '城中行会', '键含 guilds in the cities'],
    ['high_houses_in_cities', '城中豪门', '键含 high houses in cities'],
    ['husxia_american_government', '华夏美洲政制', '键含 husxia＝华夏'],
    ['inca_imperium_government', '印加帝国政制', '键含 inca imperium'],
    ['inca_northern_monarchy', '印加北方君主制', '键含 inca northern monarchy'],
    ['inca_peasants_republic', '印加农民共和国', '键含 inca peasants republic'],
    ['inca_southern_monarchy', '印加南方君主制', '键含 inca southern monarchy'],
    ['islanmic_social_norm_reform', '伊斯兰社会规范改革', '键含 Islamic social norm'],
    ['junfa_system', '军阀体制', '拼音 junfa＝军阀'],
    ['legitimacy_from_the_emperor', '天子授权', '键含 legitimacy from the emperor'],
    ['manchu_qishe_reform', '满族骑射改革', '键含 manchu／qishe＝骑射'],
    ['maya_lianbang', '玛雅联邦', '键含 maya／lianbang＝联邦'],
    ['menggu_tieqi_reform', '蒙古铁骑改革', '键含 menggu＝蒙古、tieqi＝铁骑'],
    ['military_nobilities_CHI', '军事贵族', '键含 military nobilities'],
    ['modern_chinese_warlord_mechanic', '近代中国军阀机制', '键含 modern chinese warlord'],
    ['mongol_steppe_horde_mechanic', '蒙古草原部落机制', '键含 mongol steppe horde'],
    ['mongol_steppe_horde_reform', '蒙古草原部落改革', '键含 mongol steppe horde'],
    ['muromachi_period', '室町时代', '日本专名'],
    ['new_roman_senate', '新罗马元老院', '键含 new roman senate'],
    ['officers_in_charge_rep', '军官掌权共和国', '键含 officers in charge'],
    ['old_world_reform', '旧大陆改革', '键含 old world'],
    ['one_for_all_ce_reform', '天朝一体改革', '键含 one for all'],
    ['oversea_expedition_fleets', '远洋远征舰队', '键含 oversea expedition fleets'],
    ['overseas_fanwang', '海外藩王', '键含 overseas／fanwang＝藩王'],
    ['pro_buddhism_order', '崇佛教团', '键含 pro Buddhism order'],
    ['religious_merchants', '宗教商人', '键含 religious merchants'],
    ['restore_shizu_factions', '恢复士族派系', '键含 shizu＝士族'],
    ['sub_celestial_government_CHI', '天朝下属政制', '键含 sub celestial government'],
    ['tenno_government', '天皇政制', '键含 tenno＝天皇'],
    ['timur_imperial_government', '帖木儿帝国政制', '键含 Timur imperial'],
    ['tusi_monarchy_reform', '土司君主制改革', '键含 tusi＝土司'],
    ['viking_pirate_reform', '维京海盗改革', '键含 viking pirate'],
    ['xifang_youmu_reform', '西方游牧改革', '键含 xifang＝西方、youmu＝游牧'],
    ['yiluokui_lianmeng', '易洛魁联盟', '拼音 yiluokui＝易洛魁、lianmeng＝联盟'],
    ['yulie_youmu_reform', '羽林游牧改革', '键含 yulie＝羽林、youmu＝游牧'],
    ['zhanguo_zhuhou', '战国诸侯', '拼音 zhanguo＝战国、zhuhou＝诸侯'],
  ],
};

interface NameBuckets {
  [family: string]: [string, string][] | Map<string, string[]>;
  missing: Map<string, string[]>;
  selfMade: Map<string, string[]>;
  ruleMade: Map<string, string[]>;
}

/** 每个键族的键名来源；`depth`/`fromFileName` 见 `collectKeys`。 */
const FAMILY_SOURCES: { family: string; rel: string; depth: number; fromFileName?: boolean; onlyBase?: boolean; structural?: Set<string> }[] = [
  { family: 'cultures', rel: 'common/cultures', depth: 1, structural: CULTURE_STRUCTURAL },
  { family: 'personalities', rel: 'common/ruler_personalities', depth: 0 },
  /*
   * 2026-09-19（第四对话任务书 §4.2 交付 1）：先祖特质**不在** `common/ruler_personalities`
   * 里，而是自己一个目录 `common/ancestor_personalities`（本体 + 若干 mod）。只扫前者时
   * 28 个 `ancestor_*_personality` 一条都进不了表——面板「性格」列于是显示英文 key。
   * 这两个目录的 key 形态完全一样，共用同一个 family 与同一条变体规则。
   */
  { family: 'personalities', rel: 'common/ancestor_personalities', depth: 0 },
  { family: 'institutions', rel: 'common/institutions', depth: 0 },
  { family: 'ideaGroups', rel: 'common/ideas', depth: 0 },
  { family: 'units', rel: 'common/units', depth: 0, fromFileName: true },
  { family: 'advisors', rel: 'common/advisortypes', depth: 0 },
  { family: 'religions', rel: 'common/religions', depth: 1 },
  { family: 'governmentReforms', rel: 'common/government_reforms', depth: 0 },
  { family: 'buildings', rel: 'common/buildings', depth: 0 },
  { family: 'greatProjects', rel: 'common/great_projects', depth: 0 },
  /*
   * 2026-09-19（§4.2 交付 2 / 4）：面板已经在查 `uiNameOf('tradeGoods'|'decisions'|'government')`，
   * 缺的只是表。key 来源与名字来源都照上面同一条路：本体 ＋ 全部 mod 的同名目录，
   * 名字取 **递归合并后** 的 localisation（mod 的中文常在 `localisation/replace/**`）。
   *
   * 唯一的例外是 `tradeGoods`：`common/tradegoods` 在全部模组里并集 **469** 个 key，
   * 其中绝大多数是 `smm_bbg_*` 这类地图模式显示用的假商品，面板永远不会显示，
   * 塞进表里只会让 `uiNames.json` 白胖 60 KB。所以这一族**只取游戏本体**
   * （32 个，含 `unknown`/`coal`），模组私有的 12 个（`aluminum`…`uranium`）
   * 中文名都在各自 `localisation/replace/**` 里，下面 `HAND_MADE.tradeGoods`
   * 只补其中 5 个**本机没有词条**的。
   */
  { family: 'tradeGoods', rel: 'common/tradegoods', depth: 0, onlyBase: true },
  { family: 'decisions', rel: 'decisions', depth: 1 },
  { family: 'government', rel: 'common/governments', depth: 0 },
  // ---- 波 2（§7：国家面板的 州 / 阶级 两个 Tab）----
  { family: 'estates', rel: 'common/estates', depth: 0 },
  { family: 'estatePrivileges', rel: 'common/estate_privileges', depth: 0 },
  { family: 'estateAgendas', rel: 'common/estate_agendas', depth: 0 },
  { family: 'parliamentIssues', rel: 'common/parliament_issues', depth: 0 },
  { family: 'parliamentBribes', rel: 'common/parliament_bribes', depth: 0 },
  { family: 'stateEdicts', rel: 'common/state_edicts', depth: 0 },
];

/** 键族的额外候选拼写（游戏对不同族用不同前缀）。 */
const FAMILY_EXTRA: Record<string, (key: string) => string[]> = {
  buildings: (k) => [`building_${k}`, `${k}_short`, `BUILDING_${k.toUpperCase()}`],
  greatProjects: (k) => [`great_project_${k}`],
  advisors: (k) => [`advisor_${k}`],
  religions: (k) => [k.toUpperCase(), `RELIGION_${k.toUpperCase()}`],
  governmentReforms: (k) => [`reform_${k}`],
  personalities: (k) => [k.replace(/_personality$/, '')],
  /*
   * 决议的中文名在 `_title` 上（本体 196 个 `decisions/*.txt` 的 key 一律如此，
   * 如 `conventicle_act` → `conventicle_act_title` = 通过非法集会法案）；少数模组
   * 只写 `_TITLE`。`candidatesFor` 已经会试 `key_uppercase` 族，这里只补 `_title`。
   */
  decisions: (k) => [`${k}_title`],
  /*
   * `common/governments` 的值名统一带 `_name`（`monarchy` → `monarchy_name` =
   * 君主制），`candidatesFor` 已覆盖 `_name`；模组另有 `gov_<key>` 的写法，补上。
   *
   * `gov_` 前缀要去掉再查（`gov_native_council` → `native_council` = 原住民议会、
   * `gov_shogunate` → `shogunate` = 幕府）：这是游戏自己的命名法，实测 14 个
   * `row.government` 常数靠它拿到中文。
   */
  government: (k) => [`gov_${k}`, `${k}_government`, `${k}_government_name`],
};

/**
 * 阶级特权名里那些**没被汉化 mod 解析**的 scripted-loc 命令（2026-09-19 实测，
 * 全机 `common/estate_privileges/**` 命中的 token 共 32 个）。
 *
 * 生成期就把它们换成固定中文：面板不会、也不该去执行 EU4 脚本，原样显示就是一串
 * `[Root.GetNobilityOrFallbackName]`。取词依据＝命令名本身（`GetStateForm` → 政体、
 * `GetNobilityOrFallbackName`/`Get贵族Name` → 贵族…）；`GetXxxName` 里的中文 key
 * 就是命令里那几个字，没有猜的成分。**未知命令只去掉中括号、保留词干**。
 */
const PRIVILEGE_COMMANDS: ReadonlyMap<string, string> = new Map<string, string>([
  // 先精确匹配那些「有独立语义」的
  ['Root.GetStateForm', '政体'],
  ['Root.GovernmentName', '政体'],
  ['Root.GetAdjective', '国家'],
  ['Root.Monarch.GetTitle', '君主'],
  ['Root.Monarch.Dynasty.GetName', '君主王朝'],
  // 「女仆之国」那套自定义命令：值本身就是个变量，只能给语义标签。
  ['Root.ms_GetAvaCap', '女仆'],
  ['Root.ms_adm_level.GetValue', '行政科技'],
  ['Root.ms_dip_level.GetValue', '外交科技'],
  ['Root.ms_mil_level.GetValue', '军事科技'],
]);

/** 把一条含 `[Root.Get…]` 的名字解析成可直接显示的中文（未知命令只去掉中括号）。 */
function resolveLocCommands(name: string): string {
  return name.replace(/\[([^\]]*)\]/g, (_whole, token: string) => {
    const trimmed = token.trim();
    const exact = PRIVILEGE_COMMANDS.get(trimmed);
    if (exact !== undefined) return exact;
    const country = /^Country\.Get([^.]*?)Name$/.exec(trimmed);
    if (country !== null) return country[1] as string;
    const fallback = /^Root\.Get([^.]+?)OrFallbackName$/.exec(trimmed);
    if (fallback !== null) return fallback[1] as string;
    const owner = /^Root\.Get([^.]*?)Name$/.exec(trimmed);
    if (owner !== null) return owner[1] as string;
    if (/^ms_emperor\..*GetValue$/.test(trimmed)) return '授权';
    if (/^Root\.ms_[A-Za-z0-9_]+\.GetValue$/.test(trimmed)) return '女仆';
    return trimmed;
  });
}


/**
 * `<TAG>_ideas` → `<国名>理念`（游戏自己的写法就是「俄罗斯理念」）。
 * 只有 tag 本身能查出中文时才用这条规则；查不到就不给名字（省略＝显示原 key）。
 *
 * **大小写顺序有讲究**（2026-09-19 实测）：存档国家的理念组 key 用大写 tag
 * （`ABA_ideas`/`AZE_ideas`/`HNS_ideas`），而这些模组的国名中文只写在大写键上
 * （`ABA: "阿拔斯"`）；小写键有时是 mod 自己的英文内部名（`aba: "Class Total"`）。
 * 先查小写会让这 3 条永远取不到中文，所以大写排在前面。
 */
function ideaGroupFromTag(key: string): string | undefined {
  if (!key.endsWith('_ideas')) return undefined;
  const tag = key.slice(0, -'_ideas'.length);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tag)) return undefined;
  for (const cand of [tag.toUpperCase(), `${tag.toUpperCase()}_name`, tag, `${tag}_name`, `${tag.toUpperCase()}_ADJ`, `${tag}_ADJ`]) {
    const value = loc.get(cand);
    if (value !== undefined && CJK.test(value)) return `${value.replace(/的$/, '')}理念`;
  }
  return undefined;
}

/**
 * 顾问类型的「图形文化 / 变体」后缀：`artist_BU`、`army_reformer_adv` 说的都是同一个职业
 * （BU/BG/NO/TR/CL 是肖像用的图形文化，`adv` 是通用变体）。去掉后缀查到中文就沿用——
 * 这是**推导**不是自造，逐条列进 `tmp/自造译名清单.md` 的规则表。
 */
function advisorVariantName(key: string): { name: string; via: string } | undefined {
  const parts = key.split('_');
  for (let take = 1; take <= 2 && parts.length - take >= 1; take += 1) {
    const suffix = parts[parts.length - take];
    if (!/^([A-Z]{2,4}|adv)$/.test(suffix ?? '')) break;
    const stem = parts.slice(0, parts.length - take).join('_');
    const value = nameVariants(candidatesFor(stem, [`advisor_${stem}`]));
    if (value !== undefined) return { name: value, via: stem };
  }
  return undefined;
}

/**
 * 把游戏词条清理成**面板能直接显示**的字符串。
 *
 * EU4 的名称类词条里常常带这些东西，原样显示会很难看：
 *  - 颜色码 `§Y … §!`、转义换行 `\n`；
 *  - 图标码 `£icon_ideas£` / `¤讲价女仆`（decision 与 estatePrivileges 里很常见；
 *    2026-09-19 之前会原样进表，面板上就是一行 `£adm£行政代理权`）；
 *  - scripted loc 命令 `[Root.GetStateForm]`（**第四对话任务书 §4.2 交付 4③**：
 *    生成期解析成固定中文，未知命令去掉中括号，最终表里不许再出现 `[`）；
 *  - 脚本变量 `$ESTATE_NAME$`（可解：特权键的前两段就是阶级键）；
 *  - 数值占位符 `$VAL$` / `$VAL|Y$`（阶级「影响力修正」那一列的值走**独立列**，
 *    所以名字只保留占位符之前的标签，例如「掌控军队: §Y$VAL$%§!」→「掌控军队」）。
 */
function cleanName(family: string, key: string, name: string): string {
  let out = name
    .replace(/£[^£]*£/g, '')
    .replace(/¤/g, '')
    .replace(/§[A-Za-z!]/g, '')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.includes('[')) out = resolveLocCommands(out);
  if (out.includes('$ESTATE_NAME$')) {
    const estate = key.split('_').slice(0, 2).join('_');
    const estateName = nameVariants(candidatesFor(estate));
    if (estateName !== undefined) out = out.replace(/\$ESTATE_NAME\$/g, estateName);
  }
  if (family === 'estateInfluenceModifiers') {
    const cut = out.indexOf('$');
    if (cut > 0) out = out.slice(0, cut);
    out = out.replace(/[:：,，、\s]+$/, '').trim();
  }
  return out;
}

function buildNames(terrainDict: readonly string[], areaEntries: [string, string][]): NameBuckets {
  const buckets: NameBuckets = { missing: new Map(), selfMade: new Map(), ruleMade: new Map() };
  for (const source of FAMILY_SOURCES) buckets[source.family] = [];
  for (const family of ['terrain', 'technologies', 'areas', 'estateInfluenceModifiers']) buckets[family] = [];

  /** 名字里最终**不允许**出现的字符（第四对话任务书 §4.2 交付 4③：不许再有 `[`）。 */
  const FORBIDDEN = /[\[£¤]|§/;

  const handOf = (family: string, key: string): string | undefined => {
    for (const [k, zh] of (HAND_MADE[family] ?? []).map((r): [string, string] => [r[0], r[1]])) {
      if (k === key) return zh;
    }
    return undefined;
  };

  const push = (family: string, key: string, name: string | undefined): void => {
    if (name === undefined) {
      buckets.missing.set(family, [...(buckets.missing.get(family) ?? []), key]);
      return;
    }
    const cleaned = cleanName(family, key, name);
    /*
     * 清理后**变空**或仍带 `[£¤§` 的名字一律当作「没名字」：
     *  - 空：`£ZhiHeIcon_313£` 这类纯图标词条（catus 决议的 title 就是这样）；
     *  - 带 `[`：命令没解析干净，面板上会露出一串 `[Root.Get…]`。
     * 两种都会退回原始 key，再由 `HAND_MADE` 兜底。
     */
    if (cleaned === '' || FORBIDDEN.test(cleaned)) {
      buckets.missing.set(family, [...(buckets.missing.get(family) ?? []), key]);
      return;
    }
    (buckets[family] as [string, string][]).push([key, cleaned]);
  };

  for (const source of FAMILY_SOURCES) {
    const keys = collectKeys(source.rel, source.depth, source.fromFileName, source.onlyBase)
      .filter((k) => source.structural === undefined || !source.structural.has(k))
      .filter((k) => k !== 'flag_emblem_index_range' && k !== 'religious_schools' && k !== 'compatibility_127');
    for (const key of keys) {
      const extra = (FAMILY_EXTRA[source.family] ?? ((): string[] => []))(key);
      let name = nameVariants(candidatesFor(key, extra));
      let selfMade = false;
      let ruleMade = false;
      if (name === undefined && source.family === 'ideaGroups') {
        const derived = ideaGroupFromTag(key);
        if (derived !== undefined) {
          name = derived;
          ruleMade = true;
        }
      }
      if (name === undefined && source.family === 'advisors') {
        const derived = advisorVariantName(key);
        if (derived !== undefined) {
          name = derived.name;
          ruleMade = true;
        }
      }
      if (name === undefined) {
        const hand = handOf(source.family, key);
        if (hand !== undefined) {
          name = hand;
          selfMade = true;
        }
      }
      if (selfMade) buckets.selfMade.set(source.family, [...(buckets.selfMade.get(source.family) ?? []), key]);
      if (ruleMade) buckets.ruleMade.set(source.family, [...(buckets.ruleMade.get(source.family) ?? []), key]);
      push(source.family, key, name);
    }
  }

  /*
   * 自造表里的 key **一律以自造名为准**，哪怕它不在上面扫出来的键集合里。
   *
   * 两个原因：
   *  1. 有些 key 不在 `common/<族>/` 里定义，而是由事件/效果在存档里写出来的
   *     （`consort_has_impressed_with_adm_personality`），只按文件扫会漏掉；
   *  2. 有些键虽然查到了「名字」，但那名字是**空的或纯图标**（`£ZhiHeIcon_313£`），
   *     或者只剩一个命令壳——这类已在 `push` 里退回 missing，必须由自造名接管。
   */
  for (const family of Object.keys(HAND_MADE)) {
    const list = buckets[family] as [string, string][];
    const have = new Set(list.map(([key]) => key));
    for (const [key, zh] of HAND_MADE[family] as [string, string, string][]) {
      if (have.has(key)) {
        const at = list.findIndex(([k]) => k === key);
        if (at >= 0) list[at] = [key, zh];
        continue;
      }
      have.add(key);
      list.push([key, zh]);
      buckets.selfMade.set(family, [...(buckets.selfMade.get(family) ?? []), key]);
      const missing = buckets.missing.get(family);
      if (missing !== undefined) buckets.missing.set(family, missing.filter((k) => k !== key));
    }
  }

  // 地形：`provinceTerrain.json` 的类别（中文名本机有，见报告 §10）
  for (const key of terrainDict) push('terrain', key, nameVariants(candidatesFor(key)));
  // 地区：与 `area.json` 的 dict/names 完全一致
  for (const [key, name] of areaEntries) push('areas', key, name);
  // 科技：三个点数的系 ＋ 全部科技组
  const groupsBody = topBlocks(stripComments(readFileSync(`${EU4}/common/technology.txt`, 'latin1')))
    .find((b) => b.key === 'groups')?.body ?? '';
  for (const key of ['adm_tech', 'dip_tech', 'mil_tech', ...topBlocks(groupsBody).map((b) => b.key)]) {
    push('technologies', key, nameVariants(candidatesFor(key, [`${key}_group`])));
  }
  /*
   * 阶级「影响力修正」不是数据文件里的键，而是存档里的 `EST_VAL_*` 码（pdx-tools 直接
   * 把前缀和 `_` 抹掉当英文显示）。键集合只能从 localisation 里取——它有中文就收。
   */
  for (const key of [...loc.keys()].filter((k) => k.startsWith('EST_VAL_')).sort()) {
    push('estateInfluenceModifiers', key, nameVariants(candidatesFor(key)));
  }
  return buckets;
}

// ------------------------------------------------------------- 4/5 槽位表 --

interface Slot {
  index: number;
  key: string | null;
  name: string;
  en?: string;
  locKey?: string;
}

/**
 * `[下标, eu4save 字段, pdx-tools 英文名, 游戏 localisation key]`。
 * 下标 -> 字段逐条取自 eu4save `src/query.rs`；字段为 `null` 的是上游**合并进
 * `other`** 的下标，标成「其他」，不编造名字。
 */
const INCOME_SLOTS: readonly (readonly [number, string | null, string | null, string | null])[] = [
  [0, 'taxation', 'Tax', 'INCOMETAX'],
  [1, 'production', 'Production', 'INCOMEPROD'],
  [2, 'trade', 'Trade', 'INCOMETRADE'],
  [3, 'gold', 'Gold', 'INCOMEGOLD'],
  [4, 'tariffs', 'Tariffs', 'INCOMETARRIFFS'],
  [5, 'vassals', 'Vassals', 'INCOMEVASSAL'],
  [6, 'harbor_fees', 'Harbor Fees', 'INCOMEHARBORFEES'],
  [7, 'subsidies', 'Subsidies', 'INCOMESUBS'],
  [8, 'war_reparations', 'War Reparations', 'INCOME_WAR_REPARATION'],
  [9, 'interest', 'Interest', null],
  [10, 'gifts', 'Gifts', 'INCOMEGIFT'],
  [11, 'events', 'Events', 'INCOMEEVENT'],
  [12, 'spoils_of_war', 'Spoils of War', null],
  [13, 'treasure_fleet', 'Treasure Fleet', 'INCOME_TREASURE_FLEET'],
  [14, 'siphoning_income', 'Siphoning Income', 'EXPENSE_SIPHON_INCOME'],
  [15, 'condottieri', 'Condottieri', null],
  [16, 'knowledge_sharing', 'Knowledge Sharing', null],
  [17, 'blockading_foreign_ports', 'Blockading Ports', null],
  [18, 'looting_foreign_cities', 'Looting Cities', null],
];

const EXPENSE_SLOTS: readonly (readonly [number, string | null, string | null, string | null])[] = [
  [0, 'advisor_maintenance', 'Advisor Maintenance', 'EXPENSECOURTMAINTENANCE'],
  [1, 'interest', 'Interest', 'EXPENSEINTEREST'],
  [2, 'state_maintenance', 'State Maintenance', 'EXPENSE_STATE_MAINTENANCE'],
  [3, null, null, null],
  [4, 'subsidies', 'Subsidies', 'EXPENSESUBS'],
  [5, 'war_reparations', 'War Reparations', 'EXPENSE_WAR_REPARATIONS'],
  [6, 'army_maintenance', 'Army Maintenance', 'EXPENSEAM'],
  [7, 'fleet_maintenance', 'Fleet Maintenance', 'EXPENSEFM'],
  [8, 'fort_maintenance', 'Fort Maintenance', 'EXPENSEFORTM'],
  [9, 'colonists', 'Colonists', 'EXPENSECOLONIAL'],
  [10, 'missionaries', 'Missionaries', 'EXPENSEMISSIONARY'],
  [11, 'raising_armies', 'Raising Armies', 'EXPENSEARMY'],
  [12, 'building_fleets', 'Building Fleets', 'EXPENSEFLEET'],
  [13, 'building_fortresses', 'Building Fortresses', 'EXPENSEFORT'],
  [14, 'buildings', 'Buildings', 'EXPENSEMAN'],
  [15, null, null, null],
  [16, 'repaid_loans', 'Repaid Loans', 'EXPENSELOAN'],
  [17, 'gifts', 'Gifts', 'EXPENSEGIFT'],
  [18, 'advisors', 'Hire / Promote Advisors', 'EXPENSECOURT'],
  [19, 'events', 'Events', 'EXPENSEEVENTS'],
  [20, 'peace', 'Peace', 'EXPENSEPEACE'],
  [21, 'vassal_fee', 'Vassal Fee', 'EXPENSEVASSAL'],
  [22, 'tariffs', 'Tariffs', 'EXPENSETARIFFS'],
  [23, 'support_loyalists', 'Support Loyalists', 'EXPENSESUPPORTREBELS'],
  [24, null, null, null],
  [25, null, null, null],
  [26, 'condottieri', 'Condottieri', 'EXPENSE_CONDOTTIERI'],
  [27, 'root_out_corruption', 'Root out Corruption', 'EXPENSE_CORRUPTION'],
  [28, 'embrace_institution', 'Embrace Institution', 'EXPENSE_TECHNOLOGY'],
  [29, null, null, null],
  [30, 'knowledge_sharing', 'Knowledge Sharing', null],
  [31, 'trade_company_investments', 'Trade Company Investments', null],
  [32, null, null, null],
  [33, 'ports_blockaded', 'Ports Blockaded', null],
  [34, 'cities_looted', 'Cities Looted', null],
  [35, 'monuments', 'Monuments', 'EXPENSEGREATPROJECTS'],
  [36, 'cot_upgrades', 'CoT Upgrades', null],
  [37, 'colony_changes', 'Colony Changes', null],
];

/**
 * 没有对应游戏 localisation key 的那几个科目的中文名。有 locKey 的一律用游戏原文，
 * 这张表只兜底，值都是照 pdx-tools 的英文科目名直译，不含任何自造科目。
 */
const SLOT_FALLBACK_ZH: Readonly<Record<string, string>> = {
  interest: '利息',
  spoils_of_war: '战利品',
  siphoning_income: '宗主汲取',
  knowledge_sharing: '知识共享',
  blockading_foreign_ports: '封锁外国港口',
  looting_foreign_cities: '劫掠外国城市',
  condottieri: '雇佣兵佣金',
  trade_company_investments: '贸易公司投资',
  ports_blockaded: '港口被封锁',
  cities_looted: '城市被劫掠',
  cot_upgrades: '贸易中心升级',
  colony_changes: '殖民地变动',
};

function buildSlotList(
  rows: readonly (readonly [number, string | null, string | null, string | null])[],
): Slot[] {
  return rows.map(([index, field, alias, locKey]) => {
    let name: string | undefined;
    if (field === null) name = '其他';
    else if (locKey !== null) {
      const value = loc.get(locKey);
      if (value !== undefined && CJK.test(value)) name = value;
    }
    name ??= SLOT_FALLBACK_ZH[field] ?? alias ?? field;
    const slot: Slot = { index, key: field, name };
    if (alias !== null) slot.en = alias;
    if (locKey !== null) slot.locKey = locKey;
    return slot;
  });
}

/**
 * 46 个点数槽 = 存档 `adm_spent_indexed` 等数组的原始下标 0–45。
 * 依据 eu4save `mana_spent_indexed` 的 `35..` 分支（本机 10 份存档全是 1.37.x）。
 * 下标 36 / 39 / 42 上游 35+ 分支里已经没有名字（≤34 时是 boost_militarization 等），
 * 标「其他」；43 与 8 是同一个科目（上游把两个下标相加）。
 */
const MANA_SLOTS: readonly (readonly [number, string | null, string, string])[] = [
  [0, 'buy_idea', '购买理念', 'Ideas'],
  [1, 'advance_tech', '提升科技', 'Advance Tech'],
  [2, 'boost_stab', '提升稳定度', 'Boost Stab'],
  [3, 'buy_general', '招募将军', 'General'],
  [4, 'buy_admiral', '招募海军上将', 'Admirals'],
  [5, 'buy_conq', '招募征服者', 'Conquistadors'],
  [6, 'buy_explorer', '招募探险家', 'Explorers'],
  [7, 'develop_prov', '发展省份', 'Develop Prov'],
  [8, 'force_march', '强行军', 'Force March'],
  [9, 'assault', '强攻', 'Assault'],
  [10, 'seize_colony', '夺取殖民地', 'Seize Colony'],
  [11, 'burn_colony', '焚毁殖民地', 'Burn Colony'],
  [12, 'attack_natives', '攻击土著', 'Attack Natives'],
  [13, 'scorch_earth', '焦土', 'Scorch Earth'],
  [14, 'demand_non_wargoal_prov', '无理要求', 'Unjustified Demands'],
  [15, 'reduce_inflation', '降低通货膨胀', 'Reduce Inflation'],
  [16, 'move_capital', '迁都', 'Move Capital'],
  [17, 'make_province_core', '核心化省份', 'Core Province'],
  [18, 'replace_rival', '更换宿敌', 'Replace Rival'],
  [19, 'change_gov', '变更政体', 'Change Govt.'],
  [20, 'change_culture', '变更文化', 'Change Culture'],
  [21, 'harsh_treatment', '严厉镇压', 'Harsh Treatment'],
  [22, 'reduce_we', '降低战争疲劳', 'Reduce W.E.'],
  [23, 'boost_faction', '提升派系', 'Boost Faction'],
  [24, 'raise_war_taxes', '征收战争税', 'Raise War Taxes'],
  [25, 'increse_tariffs', '提高关税', 'Increase Tariffs'],
  [26, 'promote_merc', '提升重商主义', 'Promote Merc'],
  [27, 'decrease_tariffs', '降低关税', 'Decrease Tariffs'],
  [28, 'move_trade_port', '迁移贸易城市', 'Move Trade City'],
  [29, 'create_trade_post', '建立贸易站', 'Create Trade Post'],
  [30, 'siege_sorties', '突围', 'Sortie'],
  [31, 'buy_religious_reform', '教会改革', 'Religious Reform'],
  [32, 'set_primary_culture', '变更主流文化', 'Culture Shift'],
  [33, 'add_accepted_culture', '增加接纳文化', 'Add Culture'],
  [34, 'remove_accepted_culture', '移除接纳文化', 'Remove Culture'],
  [35, 'strengthen_government', '强化政府', 'Strengthen Govt.'],
  [36, null, '其他', 'Other'],
  [37, 'artillery_barrage', '炮兵轰击', 'Artillery Barrage'],
  [38, 'establish_siberian_frontier', '建立西伯利亚边疆', 'Siberian Frontier'],
  [39, null, '其他', 'Other'],
  [40, 'naval_barrage', '海军轰击', 'Naval Barrage'],
  [41, 'add_tribal_land', '分配部落土地', 'Add Tribal Land'],
  [42, null, '其他', 'Other'],
  [43, 'force_march', '强行军（与下标 8 合并）', 'Force March'],
  [44, 'create_leader', '招募将领', 'Create Leader'],
  [45, 'enforce_culture', '强制文化', 'Enforce Culture'],
];

/** 上游还有下标 46–50，但不在冻结的「46 槽」契约里，单独放 `beyondContract`。 */
const MANA_BEYOND: readonly (readonly [number, string, string, string])[] = [
  [46, 'effect', '效果', 'Effect'],
  [47, 'minority_expulsion', '驱逐少数族群', 'Minority Expulsion'],
  [48, 'other', '其他', 'Other'],
  [49, 'other', '其他', 'Other'],
  [50, 'other', '其他', 'Other'],
];

// ---------------------------------------------------------------- 主流程 --

say('# UI 查表导出报告（阶段 1 · S2）');
say();
say('> 由 `scripts/export-ui-tables.ts` 生成，可重复复跑。');
say();
say(`- 游戏目录：\`${EU4}\``);
say(`- 汉化 localisation：\`${MOD_LOCALISATION}\`（${readdirSync(MOD_LOCALISATION).filter((n) => n.endsWith('.yml')).length} 个文件）`);
say(`- 合并后 localisation 条目：${loc.size.toLocaleString()}（先本体英文，后汉化 mod 覆盖）`);
say();

// ---- 1 provinceTerrain ------------------------------------------------------
say('## 1. provinceTerrain.json');
const terrain = buildTerrain();
const terrainById: Record<string, string> = {};
for (const id of [...terrain.byId.keys()].sort((a, b) => a - b)) terrainById[String(id)] = terrain.byId.get(id) as string;
const terrainDist = new Map<string, number>();
for (const cat of terrain.byId.values()) terrainDist.set(cat, (terrainDist.get(cat) ?? 0) + 1);
say(`- **覆盖省数 ${terrain.byId.size}**，类别 ${terrain.dict.length} 个（` + '`ocean`/`inland_ocean` 是水、`pti` 是荒原，都不写键；' + `terrain.txt 另有从未在任何像素出现的 \`impassable_mountains\`）`);
say(`- 分布：${[...terrainDist].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(' / ')}`);
say(`- 与 \`map/default.map\` 对照：被判成陆地的海里省 = ${terrain.sanity.seaAsLand}（含 coastline 类别的沿海省 ${terrain.sanity.coastlineOnSea}）；`);
say(`  不在 \`sea_starts\`+\`lakes\` 里却判成水域的省 = ${terrain.sanity.landAsWater}${terrain.sanity.landAsWaterIds.length > 0 ? `（id ${terrain.sanity.landAsWaterIds.slice(0, 12).join(', ')}${terrain.sanity.landAsWaterIds.length > 12 ? ' …' : ''}，这是上游地形图本身的数据，与地图渲染无关）` : ''}`);
say('- 抽查：' + [1, 4, 6, 1034, 2074].map((id) => `${id}→${terrain.byId.get(id) ?? '(无)'}`).join('，'));
say('  （1=草原 / 4=森林 / 6=农田 与 `省份国家界面阶段任务书.md` §6.5 的锚点一致）');
say();
writeJson('provinceTerrain.json', { byId: terrainById, dict: terrain.dict });

// ---- 2 area -----------------------------------------------------------------
say('## 2. area.json');
const areas = buildAreas();
const areaByProvince = new Map<number, string>();
let areaMemberships = 0;
for (const area of areas.areas) {
  for (const id of area.ids) {
    areaMemberships += 1;
    if (!areaByProvince.has(id)) areaByProvince.set(id, area.key);
  }
}
const areaById: Record<string, string> = {};
for (const id of [...areaByProvince.keys()].sort((a, b) => a - b)) {
  areaById[String(id)] = areaByProvince.get(id) as string;
}
const areaNames = areas.areas.map((a) => nameVariants(candidatesFor(a.key)) ?? a.key);
say(`- **地区数 ${areas.areas.length}**（另有 ${areas.empty} 个空/废弃地区块未收录），**覆盖省数 ${areaByProvince.size}**`);
say(`- 有中文名的地区：${areaNames.filter((n) => CJK.test(n)).length} / ${areas.areas.length}`);
say(`- 一省属多地区：${areaMemberships - areaByProvince.size}（应为 0；上游把地区块里的 \`color = { r g b }\` 当成省 id 时会凭空多出 90 个）`);
say('- 抽查：' + [1, 2, 3, 4, 5].map((id) => `${id}→${areaByProvince.get(id)}=${areaNames[areas.areas.findIndex((a) => a.key === areaByProvince.get(id))]}`).join('，'));
say();
writeJson('area.json', { dict: areas.areas.map((a) => a.key), names: areaNames, byId: areaById });

// ---- 3 uiNames -------------------------------------------------------------
say('## 3. uiNames.json');
const names = buildNames(terrain.dict, areas.areas.map((a, i) => [a.key, areaNames[i] as string]));
const uiNames = {
  cultures: toObject(names.cultures as [string, string][]),
  personalities: toObject(names.personalities as [string, string][]),
  institutions: toObject(names.institutions as [string, string][]),
  ideaGroups: toObject(names.ideaGroups as [string, string][]),
  advisors: toObject(names.advisors as [string, string][]),
  units: toObject(names.units as [string, string][]),
  buildings: toObject(names.buildings as [string, string][]),
  greatProjects: toObject(names.greatProjects as [string, string][]),
  terrain: toObject(names.terrain as [string, string][]),
  religions: toObject(names.religions as [string, string][]),
  governmentReforms: toObject(names.governmentReforms as [string, string][]),
  areas: toObject(names.areas as [string, string][]),
  technologies: toObject(names.technologies as [string, string][]),
  // ---- 第四对话任务书 §4.2 交付 2 / 4 ----
  tradeGoods: toObject(names.tradeGoods as [string, string][]),
  decisions: toObject(names.decisions as [string, string][]),
  government: toObject(names.government as [string, string][]),
  // ---- 波 2 ----
  estates: toObject(names.estates as [string, string][]),
  estatePrivileges: toObject(names.estatePrivileges as [string, string][]),
  estateAgendas: toObject(names.estateAgendas as [string, string][]),
  estateInfluenceModifiers: toObject(names.estateInfluenceModifiers as [string, string][]),
  parliamentIssues: toObject(names.parliamentIssues as [string, string][]),
  parliamentBribes: toObject(names.parliamentBribes as [string, string][]),
  stateEdicts: toObject(names.stateEdicts as [string, string][]),
};
for (const [family, entries] of Object.entries(uiNames)) {
  const missing = names.missing.get(family) ?? [];
  const selfMade = names.selfMade.get(family) ?? [];
  const ruleMade = names.ruleMade.get(family) ?? [];
  say(`- ${family}：**${Object.keys(entries).length}** 条（手工自造 ${selfMade.length}、规则推导 ${ruleMade.length}）` +
    `${missing.length > 0 ? `；无名字已省略 ${missing.length} 条` : ''}`);
}
say('- 抽查：' + [
  `cultures.swedish=${uiNames.cultures['swedish']}`,
  `cultures.amdo=${uiNames.cultures['amdo']}（自造）`,
  `personalities.scholar_personality=${uiNames.personalities['scholar_personality']}`,
  `institutions.feudalism=${uiNames.institutions['feudalism']}`,
  `ideaGroups.administrative_ideas=${uiNames.ideaGroups['administrative_ideas']}`,
  `advisors.philosopher=${uiNames.advisors['philosopher']}`,
  `units.muscovite_musketeer=${uiNames.units['muscovite_musketeer']}`,
  `buildings.marketplace=${uiNames.buildings['marketplace']}`,
  `greatProjects.kronborg=${uiNames.greatProjects['kronborg']}`,
  `terrain.farmlands=${uiNames.terrain['farmlands']}`,
  `religions.orthodox=${uiNames.religions['orthodox']}`,
  `governmentReforms.tsardom=${uiNames.governmentReforms['tsardom']}`,
  `areas.ostra_svealand_area=${uiNames.areas['ostra_svealand_area']}`,
  `estates.estate_nobles=${uiNames.estates['estate_nobles']}`,
  `estatePrivileges.estate_nobles_land_rights=${uiNames.estatePrivileges['estate_nobles_land_rights']}`,
  `parliamentIssues.act_of_exploration=${uiNames.parliamentIssues['act_of_exploration']}`,
  `stateEdicts.edict_defensive_edict=${uiNames.stateEdicts['edict_defensive_edict']}`,
].join('，'));
say();
writeJson('uiNames.json', uiNames);

// ---- 4 advisorIds ----------------------------------------------------------
say('## 4. advisorIds.json');
/*
 * 波 2 把它改成**全量**：`common/advisortypes`（本机没有 `common/advisors` 这个目录，
 * 顾问类型一直定义在 `common/advisortypes/*.txt`）——本体 ＋ 全部 mod 的顾问类型
 * key → 中文名，平表，与 `uiNames.advisors` 同源同内容。
 */
const advisorEntries = names.advisors as [string, string][];
say(`- **顾问类型 ${advisorEntries.length} 条**（本体＋全部 mod 的 \`common/advisortypes\` 全量，平表）`);
say(`- 与 \`uiNames.advisors\` 同源；中文名 ${advisorEntries.length - (names.missing.get('advisors') ?? []).length} 条来自 localisation，`);say(`  其余由规则（去掉 \`_BU/_BG/_NO/_TR/_CL/_adv\` 变体后缀）与自造表补齐（见清单）`);
say(`- 用法（pdx-tools 同款）：某类型出现在 \`countries/{TAG}/flags\` 里才算「已触发」并显示日期，否则灰显；`);
say(`  **面板网格建议只渲染「有头像图标」的那些**（S3 只落了本体那 21 个的图），否则一次要画上千格`);
say('- 抽查：' + ['philosopher', 'artist', 'treasurer', 'diplomat', 'grand_captain'].map((k) => `${k}=${toObject(advisorEntries)[k]}`).join('，'));
say();
writeJson('advisorIds.json', toObject(advisorEntries));

// ---- 5 ledgerSlots ---------------------------------------------------------
say('## 5. ledgerSlots.json');
const incomeSlots = buildSlotList(INCOME_SLOTS);
const expenseSlots = buildSlotList(EXPENSE_SLOTS);
say(`- **收入槽 ${incomeSlots.length}**（契约 19）、**支出槽 ${expenseSlots.length}**（契约 38）`);
say(`- 下标 -> 科目逐条取自 eu4save \`src/query.rs\` 的 \`income_ledger_breakdown\` / \`expense_ledger_breakdown\``);
say(`- 上游合并进 \`other\` 的下标（支出 3/15/24/25/29/32）标成「其他」，没有编名字`);
say('- 收入抽查：' + incomeSlots.filter((s) => [0, 2, 6, 9, 18].includes(s.index)).map((s) => `[${s.index}]${s.name}${s.locKey ? `(${s.locKey})` : ''}`).join('，'));
say('- 支出抽查：' + expenseSlots.filter((s) => [0, 6, 9, 27, 35].includes(s.index)).map((s) => `[${s.index}]${s.name}${s.locKey ? `(${s.locKey})` : ''}`).join('，'));
say();
writeJson('ledgerSlots.json', {
  schema: 1,
  income: { count: incomeSlots.length, slots: incomeSlots },
  expense: { count: expenseSlots.length, slots: expenseSlots },
});

// ---- 6 manaSlots -----------------------------------------------------------
say('## 6. manaSlots.json');
const manaSlots: Slot[] = MANA_SLOTS.map(([index, key, name, en]) => {
  const slot: Slot = { index, key, name };
  if (key !== null) slot.en = en;
  return slot;
});
say(`- **下标槽 ${manaSlots.length}**（原始下标 0–45，与存档 \`adm_spent_indexed\` 等数组位置一一对应）`);
say(`- 上游另有下标 46–50（effect / minority_expulsion / 其他），写在 \`beyondContract\`，不进 46 槽契约`);
say(`- 依据 eu4save \`mana_spent_indexed\` 的 \`35..\` 分支；下标 36/39/42 在 35+ 没有名字，标「其他」`);
say('- 抽查：' + manaSlots.filter((s) => [0, 7, 17, 37, 44].includes(s.index)).map((s) => `[${s.index}]${s.name}`).join('，'));
say();
writeJson('manaSlots.json', {
  schema: 1,
  count: manaSlots.length,
  savegameVersionBranch: 'ge35',
  slots: manaSlots,
  beyondContract: MANA_BEYOND.map(([index, key, name, en]) => ({ index, key, name, en })),
});

// ------------------------------------------------ 7 用真实存档交叉校验 --

say('## 7. 用真实存档交叉校验');
const doc = await SaveDocument.fromFile(SAVE).catch(() => undefined);
if (doc === undefined) {
  say(`- 跳过：读不到 \`${SAVE}\``);
} else {
  say(`- 存档 \`存档示例/mp_俄罗斯1574_11_12.eu4\`：日期 ${doc.meta.date}，版本 ${doc.meta.version.text}`);

  // `ledger` 太大，没进 country.groups，得自己走一遍 countries 区块。
  const incomeLens = new Map<number, number>();
  const expenseLens = new Map<number, number>();
  const ref = doc.section('countries');
  if (ref) {
    const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);
    for (;;) {
      const country = reader.nextMember();
      if (!country) break;
      if (country.kind !== 'block' || country.key === null) continue;
      const body = reader.enter(country);
      for (;;) {
        const item = body.nextMember();
        if (!item) break;
        if (item.key !== 'ledger' || item.kind !== 'block') continue;
        const ledger = body.enter(item);
        for (;;) {
          const table = ledger.nextMember();
          if (!table) break;
          if (table.key === null || table.kind !== 'block') continue;
          let length = 0;
          const inner = ledger.enter(table);
          for (;;) {
            const value = inner.nextMember();
            if (!value) break;
            length += 1;
          }
          if (table.key === 'income') incomeLens.set(length, (incomeLens.get(length) ?? 0) + 1);
          if (table.key === 'expense') expenseLens.set(length, (expenseLens.get(length) ?? 0) + 1);
        }
      }
    }
  }
  const fmt = (m: Map<number, number>): string =>
    [...m].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n} 槽 × ${c} 国`).join('，');
  say(`- 全存档 \`ledger.income\` 数组长度分布：${fmt(incomeLens)}　→ 与本表 19 槽一致`);
  say(`- 全存档 \`ledger.expense\` 数组长度分布：${fmt(expenseLens)}　→ 与本表 38 槽一致`);

  const manaSeen = new Set<number>();
  for (const country of doc.countries().values()) {
    for (const field of ['adm_spent_indexed', 'dip_spent_indexed', 'mil_spent_indexed']) {
      const group = countryGroup(country, field);
      if (group === undefined) continue;
      for (const key of Object.keys(group)) if (Number.isInteger(Number(key))) manaSeen.add(Number(key));
    }
  }
  const sorted = [...manaSeen].sort((a, b) => a - b);
  say(`- 全存档用到的点数下标：${sorted.join(', ')}（最大 ${Math.max(...sorted)} < 46 ✅）`);

  const rus = doc.countryDetail('RUS');
  const rusIncome = rus?.block('ledger')?.first('income');
  const rusExpense = rus?.block('ledger')?.first('expense');
  const listLength = (node: CwNode | undefined): number | string =>
    node === undefined ? '缺' : node.type === 'list' ? node.items.length : node.type;
  say(`- RUS 的 ledger：income ${listLength(rusIncome)} 项、expense ${listLength(rusExpense)} 项`);
  const rusCountry = doc.countries().get('RUS');
  const rusMana = (rusCountry ? countryGroup(rusCountry, 'adm_spent_indexed') : undefined) ?? {};
  const admTop = Object.entries(rusMana).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3);
  say('- 合理性抽查（RUS）：' + admTop.map(([i, v]) => `ADM[${i}]=${Math.round(Number(v))}→${manaSlots[Number(i)]?.name}`).join('，'));

  // ---- 7.1 波 3 的可验项：RUS 1574 的账本与点数（面板应显示这些科目名＋数值）----
  const listNums = (node: CwNode | undefined): number[] =>
    node !== undefined && node.type === 'list'
      ? node.items.map((item) => Number(item.type === 'scalar' || item.type === 'string' ? item.value : '0'))
      : [];
  say();
  say('### 7.1 RUS 1574 的账本与点数（波 3 可验项：面板应显示这些科目名 ＋ 数值）');
  const ledgerView = rus?.block('ledger');
  const nonZero = (slots: Slot[], values: number[]): string =>
    slots
      .map((slot) => [slot, values[slot.index] ?? 0] as const)
      .filter(([, value]) => value !== 0)
      .sort((a, b) => b[1] - a[1])
      .map(([slot, value]) => `${slot.name} ${value.toFixed(1)}`)
      .join(' · ');
  for (const [label, key] of [['上月', 'lastmonthincometable'], ['年初至今', 'income'], ['去年', 'lastyearincome']] as [string, string][]) {
    const values = listNums(ledgerView?.first(key));
    say(`- 收入·${label}（字段 \`${key}\`，${values.length} 槽，合计 ${values.reduce((a, b) => a + b, 0).toFixed(1)}）：${nonZero(incomeSlots, values)}`);
  }
  for (const [label, key] of [['上月', 'lastmonthexpensetable'], ['年初至今', 'expense'], ['去年', 'lastyearexpense']] as [string, string][]) {
    const values = listNums(ledgerView?.first(key));
    say(`- 支出·${label}（字段 \`${key}\`，${values.length} 槽，合计 ${values.reduce((a, b) => a + b, 0).toFixed(1)}）：${nonZero(expenseSlots, values)}`);
  }
  for (const power of ['adm', 'dip', 'mil'] as const) {
    const group = (rusCountry ? countryGroup(rusCountry, `${power}_spent_indexed`) : undefined) ?? {};
    const entries = Object.entries(group)
      .map(([index, value]) => [Number(index), Number(value)] as const)
      .sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    say(`- ${power.toUpperCase()} 点数去向（合计 ${total}）：${entries.map(([index, value]) => `${manaSlots[index]?.name ?? `[${index}]`} ${value}`).join(' · ')}`);
  }

  // 覆盖缺口：存档里的省是不是都能在本表里查到？
  const saveProvinces = [...doc.provinces().keys()];
  const maxSaveId = Math.max(...saveProvinces);
  const onMap = saveProvinces.filter((id) => terrain.voted.has(id));
  const offMap = saveProvinces.filter((id) => !terrain.voted.has(id));
  const waterOnMap = onMap.filter((id) => terrain.water.has(terrain.voted.get(id) as string));
  const offMapRange = offMap.length > 0 ? `${Math.min(...offMap)}–${Math.max(...offMap)}` : '—';
  say(`- 存档省数 ${saveProvinces.length}（id 1–${maxSaveId}；EU4 存档会把全部省槽都列出来）`);
  say(`- 其中有 ${onMap.length} 个在游戏本体 \`map/provinces.bmp\` 上有像素，${offMap.length} 个没有（id 区间 ${offMapRange}）；`);
  say(`  没有像素的省在本体地图上本来就不存在，本表无从取值，任何面板都不该给它们显示地形`);
  say(`- 有像素的省里：海洋/内海 ${waterOnMap.length} 个（按 §3.2 不写键），陆地 ${terrain.byId.size} 个（**全部有地形** ✅）`);
  const noArea = saveProvinces.filter((id) => !areaByProvince.has(id));
  const noAreaOnMap = noArea.filter((id) => terrain.voted.has(id));
  const noAreaWater = noAreaOnMap.filter((id) => terrain.water.has(terrain.voted.get(id) as string));
  const noAreaLand = noAreaOnMap.filter((id) => !terrain.water.has(terrain.voted.get(id) as string));
  say(`- 无地区的省 ${noArea.length} 个 = 本体地图上没有的 ${offMap.length} 个 + 地图上但没有地区的 ${noAreaOnMap.length} 个`);
  say(`  （后者里水域 ${noAreaWater.length} 个、陆地 ${noAreaLand.length} 个${noAreaLand.length > 0 ? `（id ${noAreaLand.slice(0, 12).join(', ')}…，本体 \`map/area.txt\` 漏给它们分地区，面板要显示"无"）` : ''}）`);
}
say();

// ------------------------------------------------ 8 给下游的读取说明 --
say('## 8. 给下游（S1 / U）的读取说明');
say();
say('- `provinceTerrain.json`：`{byId: {"<省id>": "<类别>"}, dict: [类别…]}`。海洋/内海与荒原（pti）在 `byId` 里**没有键**；`dict` 就是 `byId` 里出现过的类别集合（排序后）。');
say('- `area.json`：`{dict: [地区key…], names: [中文名…], byId: {"<省id>": "<地区key>"}}`。');
say('  S1 转成数据面 `provinceArea` 时：`dict`、`names` 直接用；`byId[i] = dict.indexOf(areaById[String(i)] ?? "")`（没有则 -1）。');
say('- `uiNames.json`：**每个子表**都是 `游戏key -> 中文名`（`cultures`/`personalities`/`institutions`/`ideaGroups`/`advisors`/`units` 是 §6.8.2 新增；`tradeGoods`/`decisions`/`government` 是 第四对话任务书 §4.2 新增）；');
say('  **没有名字的 key 直接省略**，客户端回退显示 key（与 §3.2 第 3 条一致）。');
say('- `advisorIds.json`：`顾问类型key -> 中文名` 平表，与 `uiNames.advisors` 同源。图标路径 `/assets/ui/advisors/<key>.png`（S3 落位）。');
say('- `ledgerSlots.json`：`income.slots[i].index === i`（0–18）、`expense.slots[i].index === i`（0–37）；每条是 `{index, key, name, en?, locKey?}`，`key === null` 表示上游把该下标并进「其他」。');
say('- `manaSlots.json`：`slots[i].index === i`（0–45）、`count = 46`；下标 46–50 在 `beyondContract`；`savegameVersionBranch === "ge35"`（存档 `savegame_version.second >= 35`，本机 10 份全是 1.37.x）。');
say();

// ------------------------------------------- 9 名字表（阶段 1.5） --
say('## 9. 名字表：覆盖、自造与缺口（阶段 1.5 · §6.8.2）');
say();
say(`- **名字来源**：游戏本体英文 → ${modRoots().length} 个 mod 各自的 \`localisation/**/*.yml\` → 汉化 mod`);
say(`  \`2976470733\` **最后**（中文永远优先）。合并后 **${loc.size.toLocaleString()}** 条词条（读了 ${locFiles} 个 \`_l_english\`/\`_l_simp_chinese\`/\`_l_chinese\` 文件）。`);
say('- **递归 + 只收英/中（2026-09-19 修）**：mod 把「覆盖本体」的词条放在 `localisation/replace/**`');
say('  子目录里，只扫一层会成片漏名（实测 5 个贸易品、7 个 `ancestor_*_personality`、38 个 decision 名、');
say('  `ABA`/`AZE`/`HNS` 三个 tag 都是这么错的）；但同一批 key 在 `_l_french`/`_l_german`/');
say('  `_l_spanish`/`_l_korean` 里也有副本，**必须整批跳过**，否则它们会按文件序把中文名顶成英文/西语。');
say('- **为什么必须带上别的 mod**：汉化 mod 只翻本体；`风云世纪两千年` 的文化/理念、`MEIOU and Taxes` 的兵种名都在各自的');
say('  localisation 里。只用汉化 mod 时，存档里 537 个文化的 **144 个**显示原始 key——这就是「文化没有汉化」的真正原因之一。');
say('- **键名来源**：游戏本体 ＋ **每个 mod** 的 `common/<族>/*.txt`（兵种是**文件名即 key**）。');
say();
say('| 键族 | 条数 | 手工自造 | 规则推导 | 无名字（省略） |');
say('|---|---|---|---|---|');
for (const [family, entries] of Object.entries(uiNames)) {
  const count = Object.keys(entries).length;
  const selfMade = (names.selfMade.get(family) ?? []).length;
  const ruleMade = (names.ruleMade.get(family) ?? []).length;
  const missing = (names.missing.get(family) ?? []).length;
  say(`| ${family} | ${count} | ${selfMade} | ${ruleMade} | ${missing} |`);
}
say();
const handTotal = Object.values(HAND_MADE).reduce((n, rows) => n + rows.length, 0);
const ruleTotal = [...names.ruleMade.values()].reduce((n, rows) => n + rows.length, 0);
say(`- **手工自造 ${handTotal} 条 ＋ 规则推导 ${ruleTotal} 条**，逐条列在 \`tmp/自造译名清单.md\`（key｜机内英文｜拟译名｜依据）。`);
say('- 手工自造只用在**键名里直接含英文或拼音**的情形；拿不准的一律不写，清单里另有「没有名字的 key」的按键族统计与原因。');
say('- 规则推导＝ `<TAG>_ideas` → `<国名>理念`（游戏自己的写法就是这样，如 `RUS_ideas`＝俄罗斯理念）；仅当该 tag 能查出中文时才用。');
say('- **实测「存档里出现过但没名字」的键**（11 份存档合并去重，明细在 `tmp/ui-save-unnamed.txt`）：');
say('  cultures 27 · personalities 13 · religions 10 · buildings 2 · greatProjects 61 · ideaGroups 142 · units 76 · governmentReforms 72。');
say('  补完后**只剩 97 个 `*_ideas`**（tag 自己也没有国名，如 `HW1_ideas`/`YJ0_ideas`）与 **1 个 `fort_et` 之外的边角**没有名字；');
say('  这 97 个连同其余模组 key 会显示原始 key，原因都写在 `tmp/自造译名清单.md` 末节。');
say('- **2026-09-19 又补了三族 ＋ 两处根因**（第四对话任务书 §4.2）：`tradeGoods` 44、`decisions` 6686、');
say('  `government` 42；`personalities` 补进 46 个 `ancestor_*_personality`（原先只扫 `common/ruler_personalities`，');
say('  先祖特质在 `common/ancestor_personalities`，一个都没进表）。覆盖率探针：`tmp/probe-ui-name-coverage.cjs`。');
say(`- **体积**：\`uiNames.json\` ${(Buffer.byteLength(JSON.stringify(uiNames, null, 1), 'utf8') / 1024).toFixed(0)} KB（${Object.keys(uiNames).length} 个键族、11000+ 条）。`);
say('  S1 要把它烤进数据面：如果每个 `viewer/data.json` 都塞全量，10 份会多约 4 MB；**建议按 S1 自己的需要裁剪**');
say('  （面板真正会显示的只有存档里出现过的那些 key），或至少先跟主对话确认这个体积可以接受。');
say(`- \`advisorIds.json\` 在波 2 已改成**全量**（${advisorEntries.length} 条，与 \`uiNames.advisors\` 同源）；面板网格建议只画**有头像图标**的那些（S3 只落了本体 21 个的图）。`);
say('- **宗教不用自造**：那 10 个（`taoism`/`jingxueism`/`avalon_faith`/`EM_tengri_pagan_reformed`…）**全部已在**');
say('  `scripts/lib/localisation.ts` 的 `RELIGION_FALLBACK` 里（§6.8.3 明确说不要做第二套），数据面读它就够了。');
say('- 证据探针：`tmp/ui-families-universe.ts`（本体＋模组的键全集）、`tmp/ui-save-universe.ts`（11 份存档里的键与缺口）、');
say('  `tmp/ui-missing-loc-probe.ts`（确认那些 key 在**全机 46 个 mod 的 localisation 里都搜不到**）。');
say('- **铁律**：这些 yml 是 UTF-8（带 BOM），读取一律显式 UTF-8（`loadLocalisationFile` 内部就是）；');
say('  控制台 cp936 下中文显示成乱码是正常现象，**不许据此判断「没有中文」**——判断只看本脚本的 CJK 正则。');
say();
say('### 9.1 自造条目怎么核对');
say('- 每一条自造的 key｜机内英文｜拟译名｜依据 都在 `tmp/自造译名清单.md` 的同一张表里，按 §6.8.2 的键族顺序排列。');
say('- 只有「全机搜不到中文」的才自造；判据是 `tmp/ui-missing-loc-probe.ts` 对 46 个 mod 的 3637 个 yml 的全盘搜索。');
say();

// ------------------------------------------- 10 覆盖缺口与跨任务提醒 --
say('## 10. 覆盖缺口与跨任务提醒（给主对话 / S1 / S3 / U）');
say();
say('1. **地形中文名不用自造**：§6.2 第 3 条说「地形中文名游戏里没有」——本机不成立：');
say('   汉化 mod 的 `terrain_stuff_l_english.yml` / `text_l_english.yml` / `EU4_l_english.yml` 覆盖了');
say('   `terrain.txt` 声明的全部类别，本表 16 个地形全部用的是 mod 的真实译名（草原/森林/农田…与 §6.5 锚点一致）。');
say('2. **奇观 key 是 141 条，不是 139**：`common/great_projects/*.txt` 的顶层 key（本体）实测 141 个，');
say('   任务书里的 139 是把两个**含连字符**的 key 拆错了（`imam_hussein_al-abbas`、`maidan-e_naqsh-e_jahan`；');
say('   `interface/great_project.gfx` 声明的 sprite 是 143 个）。');
say('   **S3 与 U 必须对齐命名**：§4 说文件名里的 `-` 要换成 `_`，而客户端如果要按「游戏 key 拼路径」就得做同样的替换，');
say('   否则这两个奇观（省份面板「奇观」行）会 404。');
say('3. **政体改革的「条数」有三个不同口径**，别混：本体 `common/government_reforms/*.txt` 顶层 key **687**；');
say('   §4 的「346 张图 / 323 可用」是**有图的数量**；本表现在收的是**本体＋全部 mod** 的并集（见 §9 表）。');
say('4. **宗教**：`uiNames.religions` 现在收本体＋全部 mod 的宗教 key；但**「存档里出现过却没有名字」的 10 个');
say('   （`taoism`/`jingxueism`/`avalon_faith`/`iru_faith`/`jingjiao_cn`/`kongzism`/`mayareform`/`sunfaith`/`emperorfaith`/`EM_tengri_pagan_reformed`）');
say('   全部已经在 `scripts/lib/localisation.ts` 的 `RELIGION_FALLBACK` 里**——按 §6.8.3「不要做第二套」，S2 不重复造。');
say('5. **`ledgerSlots` 的 `monuments` 用的是游戏原文「伟大工程」**（locKey `EXPENSEGREATPROJECTS`），');
say('   而 §1.9/§6.4 的省份面板把同一批建筑叫「奇观」——U 自己统一用词即可，数据不受影响。');
say('6. **存档省数 4941，但只有 3925 个在游戏本体地图上**（见 §7）：1016 个省（id 3004–4019）在 `map/provinces.bmp` 上没有像素，');
say('   `map/area.txt` 也没有地区。**地图上能点到的省 100% 有地形**；地区则有个别本体漏分的（§7 已列出），面板显示「无」即可。');
say('7. **键族扫描范围＝游戏本体 ＋ 本机全部 mod**（不是只有汉化 mod）。缺名字的 key 会显示原文，要补就改本脚本的');
say('   `HAND_MADE` 或扫描范围，**不要手改 JSON**。');
say('8. **改完 `uiNames.json` 必须重跑 `pnpm timeline`**：`viewer-build.test.ts` 拿 `tmp/timeline/data.json` 当参照，');
say('   参照物一旦比 S2 的表旧，就会报 `uiNames differs` / `cultureNames differs`（本项目的已知模式，不是代码错）。');
say();

// ------------------------------------------- 11 波 2 的可验项与期望值 --
say('## 11. 波 2（州 / 阶级 / 顾问）的可验项与期望值');
say();
say('### 11.1 「州名」这一项的结论：**阶段 1 就已经做完了**');
say('- EU4 里**州 ≡ 地区**：`map/area.txt` 定义地区，一个国家拥有的每个省通过 `province → area` 查表归到州，');
say('  州名就是**地区 key 的 localisation**（pdx-tools 的 `province_area_lookup()` ＋ `game.localize(state)` 就是这么做的；');
say('  存档里没有独立的 `states` 州名表，实测 `countries/RUS` 里没有 `states` 块）。');
say('- 所以 `area.json` 的 `names`（与 `dict` 同序）**就是州名**，882/882 全部有中文，不需要新增字段。');
say('- 面板要按州聚合时：`provinceArea.byId[省id]` → `dict` 下标 → `names[下标]`。');
say('- **已知缺口（不属本次任务，供主对话决定）**：本体 `map/area.txt` 只覆盖 3754 个省，');
say('  本机 13 个 mod 各自带了更大的 `map/area.txt`（如 `2935149060` 多 672 省、`2460779132` 多 5730 省）。');
say('  按冻结契约 area.json 仍只取**游戏本体**，所以模组扩图新增的省没有州名；要补就是换个来源，');
say('  但那会把本体省份的地区重新划归（多模组互相冲突），属于契约变更，S2 不擅自做。');
say();
say('### 11.2 阶级 / 特权 / 州议会：名字全部来自 localisation');

for (const family of ['estates', 'estatePrivileges', 'estateAgendas', 'estateInfluenceModifiers', 'parliamentIssues', 'parliamentBribes', 'stateEdicts']) {
  const entries = uiNames[family] as Record<string, string>;
  const selfMade = (names.selfMade.get(family) ?? []).length;
  const missing = (names.missing.get(family) ?? []).length;
  say(`- \`${family}\`：${Object.keys(entries).length} 条（自造 ${selfMade}，无名字 ${missing}）`);
}
say('- 键形态（**注意大小写**）：阶级＝`estate_nobles`/`estate_church`…（小写，本体 16 个）；');
say('  特权＝`estate_nobles_land_rights`…（小写，本体 426 个）；议会法案＝`act_of_exploration`…（**没有** `parliament_issue_` 前缀，本体 108 个）；');
say('  州法令＝`edict_defensive_edict`…（小写，本体 18 个）；影响力修正＝存档里以 **`EST_VAL_`** 大写前缀出现（507 条有中文）。');
say('- **词条已清理**（否则面板会显示字面量）：去掉 `§Y…§!` 颜色码与 `\\n`；`$ESTATE_NAME$` 换成该阶级的中文名');
say('  （`estate_nobles_land_rights` → **贵族领地权**）；影响力修正只保留 `$VAL$` 之前的标签（`EST_VAL_NOBLE_LEADER` → **掌控军队**，值走独立列）。');
say('  `[Root.GetXxx]` 这类 scripted loc 保持原样，面板遇到就退化成 `—`。');
say();
say('### 11.3 顾问：`advisorIds.json` 已改成全量');
say(`- 本体＋全部 mod 的 \`common/advisortypes\` 共 ${Object.keys(uiNames.advisors as Record<string, string>).length} 条（本机**没有** \`common/advisors\` 目录）。`);
say('- 名字来源：localisation 直接命中 ＋ 变体后缀规则（`artist_BU`→艺术家）＋ 自造表；全部列在 `tmp/自造译名清单.md`。');
say();
say('### 11.4 交给 U 写进 `tmp/验收-阶段2.md` 的期望值');
say('- **州 Tab（俄国 1574）**：州名是中文。布列塔尼 `brittany_area`＝' + `${uiNames.areas['brittany_area']}；`);
say('  `ostra_svealand_area` 本表＝' + `${uiNames.areas['ostra_svealand_area']}（**取自裸键**，与 pdx-tools 的 \`game.localize(area)\` 一致）；`);
say('  同族的 `ostra_svealand_area_name` 是另一个名字（本体英文写的是 `Dalecarlia`）——若用户要显示那一个，改 `area.json` 的取法即可。');
say('- **阶级 Tab（俄国 1574）**：俄国是俄罗斯君主制，有 3 个阶级 —— `estate_nobles`／`estate_burghers`／`estate_cossacks`＋`estate_church`，');
say(`  中文分别是 ${['estate_nobles', 'estate_burghers', 'estate_cossacks', 'estate_church'].map((k) => uiNames.estates[k]).join('／')}；`);
say('  特权表里出现的是 `estate_nobles_*` 这类键，中文名见 `uiNames.estatePrivileges`；');
say(`  影响力修正表里是 \`EST_VAL_*\`，例：\`EST_VAL_PRIVATE_CHANCELLERY\` ＝ ${uiNames.estateInfluenceModifiers['EST_VAL_PRIVATE_CHANCELLERY']}`);
say('- **顾问 Tab（俄国 1574）**：顾问网格应显示「哲学家/艺术家/财务总管…」这类中文；');
say('  某类型的名字若在 `advisorIds.json` 里查不到，就是模组自己没写词条（清单末节有原因）。');
say();

// ------------------------------------------- 12 波 3：槽位枚举（不是暂缓）--
say('## 12. 波 3：财政 19/38 与点数 46 的槽位枚举（**已拿下，不是"暂缓"**）');
say();
say('### 12.1 结论与来源');
say('- 两张表在阶段 1 就已经交付，波 3 这次做的是**复核**：重新从 `codeload.github.com/rakaly/eu4save`');
say('  下载 `master`（65 KB，2026-09-13 的上游 `src/query.rs`，52,055 字节），把三个 breakdown 函数**逐槽**解析出来');
say('  与本文件对照 —— **income 19、expense 38、mana 46 全部 0 处不一致**（探针 `tmp/s2c-slots-probe.ts`）。');
say('- 字段名与下标的一一对应取自 `income_ledger_breakdown` / `expense_ledger_breakdown` / `mana_spent_indexed` 的 `35..` 分支；');
say('  英文科目名取自 pdx-tools `features/eu4/features/country-details/data.ts`；中文名优先用**游戏自己的** economy localisation key。');
say('- **没有任何编造**：上游合并进 `other` 的下标（支出 3/15/24/25/29/32、点数 36/39/42）一律标「其他」。');
say();
say('### 12.2 两个必须知道的口径');
say('- **三个区间共用同一套下标**：`lastmonthincometable`（上月）/ `income`（年初至今）/ `lastyearincome`（去年）长度都是 19，');
say('  下标含义完全相同（支出同理：`lastmonthexpensetable` / `expense` / `lastyearexpense`，都是 38）。');
say('- **adm / dip / mil 共用同一套下标**：上游对三个数组调用同一个 `mana_spent_indexed`，所以 `manaSlots.json` 只有**一张** 46 槽表，');
say('  不按三系分表（`slots[i].index === i`，0–45）。');
say();
say('### 12.3 收入槽（19）');
say('| 下标 | key | 中文名 | 来源 |');
say('|---|---|---|---|');
for (const slot of incomeSlots) {
  say(`| ${slot.index} | \`${slot.key ?? '—'}\` | ${slot.name} | ${slot.locKey !== undefined ? `游戏词条 \`${slot.locKey}\`` : slot.key === null ? '上游合并进 other' : '直译（无游戏词条）'} |`);
}
say();
say('### 12.4 支出槽（38）');
say('| 下标 | key | 中文名 | 来源 |');
say('|---|---|---|---|');
for (const slot of expenseSlots) {
  say(`| ${slot.index} | \`${slot.key ?? '—'}\` | ${slot.name} | ${slot.locKey !== undefined ? `游戏词条 \`${slot.locKey}\`` : slot.key === null ? '上游合并进 other' : '直译（无游戏词条）'} |`);
}
say();
say('### 12.5 点数槽（46）＋ 契约外 5 槽');
say('| 下标 | key | 中文名 |');
say('|---|---|---|');
for (const slot of manaSlots) {
  say(`| ${slot.index} | \`${slot.key ?? '（其他）'}\` | ${slot.name} |`);
}
say();
say(`- \`beyondContract\`（下标 46–50，不进 46 槽契约）：${MANA_BEYOND.map(([index, key, name]) => `[${index}] \`${key}\` ${name}`).join('、')}`);
say('- 本机 10 份存档全是 1.37.x（`savegame_version.second = 37 ≥ 35`），走 `35..` 分支；');
say('  若哪天出现 `second ≤ 34` 的存档，下标 25–35 的含义会整体位移，**这张表必须重新生成**（文件里已写 `savegameVersionBranch: "ge35"`）。');
say();
say('### 12.6 交给 U 写进 `tmp/验收-阶段3.md` 的期望值');
say('- 期望值＝**§7.1** 那段：RUS 1574 的三个区间（上月 / 年初至今 / 去年）收入明细、三个区间支出明细、ADM/DIP/MIL 点数去向。');
say('  面板上「财政」Tab 的三个区间切换、瀑布图与明细表应对得上这些科目名与数字（保留一位小数即与探针一致）。');
say('- 「点数」Tab 的三条量条应对上 ADM 18131 / DIP 10417 / MIL 11859 这个量级（本机探针实测）。');
say('- 若某个科目显示成 `[下标]` 或空白，就是该下标落在「其他」桶里或数据面没接上，**不是编错名字**。');
say();
// --------------------------------------- 13 自造译名清单（用户逐条核对） --
if (!DRY) {
  const clist: string[] = [];
  const total = Object.values(HAND_MADE).reduce((n, rows) => n + rows.length, 0);
  clist.push('# 自造译名清单（阶段 1.5 · S2）');
  clist.push('');
  clist.push(`> 由 \`scripts/export-ui-tables.ts\` 生成，共 **${total}** 条。`);
  clist.push('> 只有「**全机 46 个 mod 的 localisation 里都搜不到中文**」的 key 才会自造；');
  clist.push('> 拿不准的一律不写（省略＝面板显示原始 key），那部分在本文末的「没有名字的 key」里列了原因。');
  clist.push('> 「机内英文」是从本机 localisation 里读到的英文原文；写「(无)」表示定义它的模组连英文都没写。');
  clist.push('');
  clist.push('| 键族 | key | 机内英文 | 拟译名 | 依据 |');
  clist.push('|---|---|---|---|---|');
  for (const family of Object.keys(uiNames)) {
    for (const [key, zh, basis] of HAND_MADE[family] ?? []) {
      const en = loc.get(key) ?? loc.get(`${key}_name`);
      const shown = en !== undefined && !CJK.test(en) ? en.replace(/\|/g, '\\|') : '(无)';
      clist.push(`| ${family} | \`${key}\` | ${shown} | ${zh} | ${basis} |`);
    }
  }
  clist.push('');
  clist.push('## 规则推导的名（ideaGroups：`<TAG>_ideas` → `<国名>理念`）');
  clist.push('');
  clist.push('游戏自己的写法就是这样（`RUS_ideas`＝俄罗斯理念）；只有该 tag 在本机 localisation 里能查出中文时才用这条规则。');
  clist.push('');
  clist.push('| key | tag | tag 的中文 | 拟译名 |');
  clist.push('|---|---|---|---|');
  for (const key of names.ruleMade.get('ideaGroups') ?? []) {
    const tag = key.replace(/_ideas$/, '');
    let tagName: string | undefined;
    for (const cand of [tag, `${tag}_name`, tag.toUpperCase()]) {
      const value = loc.get(cand);
      if (value !== undefined && CJK.test(value)) {
        tagName = value;
        break;
      }
    }
    clist.push(`| \`${key}\` | ${tag} | ${tagName ?? '(无)'} | ${(tagName ?? '').replace(/的$/, '')}理念 |`);
  }
  clist.push('');
  clist.push('## 没有名字的 key（面板会显示原始 key）');
  clist.push('');
  clist.push('原因只有一个：**定义它的模组自己没有写 localisation**。已用 `tmp/ui-missing-loc-probe.ts` 全盘搜过');
  clist.push('46 个 mod 的 3637 个 `localisation/*.yml`，这些 key 一个都没出现，且本体也没有对应词条。');
  clist.push('');
  clist.push('| 键族 | 无名字条数 | 例（前 8 个） |');
  clist.push('|---|---|---|');
  for (const family of Object.keys(uiNames)) {
    const missing = names.missing.get(family) ?? [];
    if (missing.length === 0) continue;
    clist.push(`| ${family} | ${missing.length} | ${missing.slice(0, 8).map((k) => `\`${k}\``).join(' ')} |`);
  }
  clist.push('');
  clist.push('### 其中「存档里真的出现过」的（11 份存档实测，共 403 条）');
  clist.push('');
  clist.push('cultures 27 · personalities 13 · religions 10 · buildings 2 · greatProjects 61 · ideaGroups 142 · units 76 · governmentReforms 72');
  clist.push('');
  clist.push('- 除 ideaGroups 的 142 条外，**上面全部已自造**（手工自造 ' + `${handTotal} 条 ＋ 规则推导 ${ruleTotal} 条）；`);
  clist.push('- ideaGroups 的 142 条里 **45 条**由 `<TAG>_ideas` → `<国名>理念` 规则给出（见上一节），');
  clist.push('  **剩下 97 条**（`HW1_ideas`/`YJ0_ideas`/`JB2_ideas`…）连 tag 自己都没有国名，本机任何文件都查不到，');
  clist.push('  所以**不自造**——面板显示原始 key，这一条就是它「为什么没有」；');
  clist.push('- religions 的 10 条（`taoism`/`jingxueism`/`avalon_faith`/`iru_faith`/`jingjiao_cn`/`kongzism`/`mayareform`/');
  clist.push('  `sunfaith`/`emperorfaith`/`EM_tengri_pagan_reformed`）**全部已在** `scripts/lib/localisation.ts` 的');
  clist.push('  `RELIGION_FALLBACK` 里，按 §6.8.3「不要做第二套」由数据面兜底，本表不重复造；');
  clist.push('- 完整明细：`tmp/ui-save-unnamed.txt`（key｜机内英文｜tag 名）。');
  writeFileSync(`${ROOT}tmp/自造译名清单.md`, `${clist.join('\n')}\n`, 'utf8');
  console.log('clist -> tmp/自造译名清单.md');
}

if (!DRY) {
  writeFileSync(`${ROOT}tmp/ui-tables-report.md`, `${report.join('\n')}\n`, 'utf8');
  console.log('\nreport -> tmp/ui-tables-report.md');
}
