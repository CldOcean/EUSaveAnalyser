# @eu4/parser

A dependency-free TypeScript parser for Europa Universalis IV `.eu4` save games.

```
pnpm parse  "存档示例/mp_俄罗斯1574_11_12.eu4" --out tmp/snapshot.json
pnpm info   "存档示例/mp_俄罗斯1574_11_12.eu4"
pnpm test
```

---

## 1. What a `.eu4` file actually is

Despite the extension it is a **ZIP archive**, not text:

| member      | size    | contents |
|-------------|---------|----------|
| `gamestate` | ~57 MB  | the whole simulation state, as Clausewitz text, deflate-compressed |
| `meta`      | ~3 KB   | date, engine version, DLC, mods, campaign stats |
| `ai`        | ~50 B   | an AI checksum |

`SaveArchive` reads the central directory and inflates `gamestate` once; every
later query works directly on that byte buffer.

## 2. The text grammar

```
document := member*
member   := key value | value          // a value with no key is a "bare" item
key      := bareword | quotedString
value    := block | quotedString | bareword
block    := '{' member* '}'
```

Three details bit us while writing this and are worth stating explicitly:

1. **Both spellings of a keyed block occur.** Most sections use `key={ … }`, but
   EU4 also writes `key{ … }` with no equals sign — for instance
   `map_area_data{` and `countries{` in some sections. A parser that only accepts
   `=` silently mis-nests and swallows entire sections.
2. **Bare list items are legal.** `id_counters={ 36372 17356 }` and
   `cores={ SWE RUS }` have members with no key. A token is a key only when `=`
   or `{` follows it.
3. **Keys may be negative or symbolic.** Province keys are negated (`-1`), and
   placeholder countries are named `---` and `ZZZ`.

## 3. The string encoding

This is the part that cannot be guessed, so it is documented in full.

EU4 does **not** store non-Latin text as UTF-8 inside a save. A string is a
sequence of *letters*:

* a byte `>= 0x20` is the Latin-1 code point of that byte;
* a byte `< 0x20` is an **escape marker**, followed by **two** bytes holding a
  little-endian 16-bit code unit.

The stored code unit is *not* the real code point — a marker-specific delta must
be added back:

| marker | delta   | notes |
|--------|---------|-------|
| `0x10` | `0`     | plain BMP code unit |
| `0x11` | `-14`   | |
| `0x12` | `+2304` | |
| `0x13` | `+2290` | equals `delta(0x12) + delta(0x11)` |

The low two bits of the marker therefore act as two independent flags, but for
decoding only the arithmetic matters.

Worked examples, all byte-exact from `gamestate`:

```
10 C4 4F 10 57 7F 10 AF 65                        -> 俄罗斯          (meta/displayed_country_name)
10 AF 65 12 B7 56 10 E5 54 12 14 53 10 69 64      -> 斯德哥尔摩      (provinces/-1/name)
12 26 72 11 8C 81 10 21 58                        -> 符腾堡          (marker 0x11 and 0x12 in one name)
```

### Two traps

* **Payload bytes can be anything.** `三` is stored as `10 09 4E`, so a payload
  byte may be `< 0x20`; it may also be `0x22` (`"`) or `0x5C` (`\`). A scanner
  must consume a marker's three bytes unconditionally, or it will see a premature
  closing quote and desynchronise for the rest of the file.
* **Names can be truncated mid-escape.** EU4 cuts some province names at a fixed
  byte budget (~26 bytes), leaving a marker with only one payload byte, whose
  missing byte would have been the closing quote. `escapeLengthAt` therefore
  treats a marker as a letter only when both payload bytes are present and the
  second is not `"`. Such half-letters decode to `U+FFFD` and are reported
  through `onTruncatedEscape`. Exactly 4 of 157,621 province strings in the
  sample save are affected.

### Not every string is in the letter stream

Strings the game read raw from disk stay **plain UTF-8**:

| field | encoding |
|-------|----------|
| `meta/save_game` | UTF-8 (`撒丁-皮埃蒙特1555_07_27.eu4`) |
| `meta/mods_enabled_names[].name` | UTF-8 (`更好的字体（我最喜欢的筑紫圆体）`) |
| `meta/displayed_country_name` | letter stream (`俄罗斯`) |
| province names, player nicknames, stat labels | letter stream |

`decodeSaveString` picks between them: a non-whitespace control byte can only be
a letter-stream marker, and a UTF-8 string with non-ASCII content never contains
one. `looksLikeLetterStream` exposes the test.

## 4. Province keys are negated

```
provinces={
    -1={ name="斯德哥尔摩" … }      <- province 1
    -4941={ name="卡维拉湖" … }     <- province 4941
}
```

Province 1 is Stockholm, so the key is `-id`, not `id`. `provinceIdFromKey`
takes the magnitude, which also keeps older saves with positive keys working.
Country `capital` fields, by contrast, use **positive** province ids
(`GBR` -> `236` -> 伦敦).

## 6. Timeline reconstruction (from a *single* save)

A save is **not** limited to the present state. Two dated logs turn one file into
a whole campaign history:

### Province history

Every province carries a `history` block that runs from the campaign start to the
current date. Undated keys are the starting state; dated keys are events:

```
history={
    owner="SWE"                      # 1444 state
    religion="catholic"
    base_tax="5.000"
    1436.4.28={ revolt={ … } controller={ tag="REB" } }
    1523.3.30={ controller={ tag="MOS" } }      # wartime occupation
    1525.6.4={ owner="MOS" fake_owner="RUS" add_core="RUS" }
    1532.5.22={ religion="protestant" }         # the Reformation
}
```

The sample save has **3,924 provinces / 147,337 dated events / 147,879 field
changes** covering `owner`, `controller`, `religion`, `culture`, `base_tax`,
`base_production`, `base_manpower`, buildings, cores and claims.

`TimelinePlayer` replays them with a forward-only cursor, so 100 map frames cost
the same as one:

```ts
const timeline = buildTimeline(doc);
const aliases = buildTagAliases(doc);
const player = new TimelinePlayer(timeline, ['owner', 'religion', 'culture']);

// Monthly frames — the finest granularity a save records.
for (const frame of frameMonths(timeline.campaignStart!, doc.meta.date)) {
  player.advanceTo(frame.ordinal);
  player.valueOf('owner', 1); // -> owner of province 1 at that date
}
```

`frameMonths` gives ~1,562 frames for a 130-year campaign and ends on the save's
exact date (the last day of a month can still carry events).

Country-level attributes — the state religion and primary culture that the
religion/culture map views hatch with — come from the same shape of log, read by
`buildCountryTimeline` + `CountryTimelinePlayer`:

```ts
const countryPlayer = new CountryTimelinePlayer(
  buildCountryTimeline(doc),
  ['religion', 'primary_culture'],
);
countryPlayer.advanceTo(ordinal);
countryPlayer.valueOf('religion', resolveTagLatest(aliases, 'MOS')); // 'orthodox'
```

### Tag changes must be resolved

Province logs record the tag that held the province **at the time**, so Stockholm
says `owner=MOS` from 1525 and never mentions RUS. The switch is written into the
successor's own country history instead:

```
countries/RUS/history = { 1529.2.5 = { changed_tag_from="MOS"  government_rank=3 } }
```

`buildTagAliases` scans for those; `resolveTag` follows the chain. The sample save
has 17 (Delhi, Persia, **Prussia** `BRA->PRU`, **Great Britain** `ENG->GBR`,
**Russia** `MOS->RUS`, Japan, …).

Without alias resolution a replayed 1574 map shows Muscovy holding 380 provinces.

### Correctness

`scripts/verify-timeline.ts` replaying every event up to the save's own date
reproduces the stored province table **exactly**:

| field | exact |
|-------|-------|
| owner | 2,856 / 2,856 (100%) |
| religion | 3,269 / 3,269 (100%) |
| culture | 3,269 / 3,269 (100%) |

## 7. Wars, battles and occupations

`previous_war` (621 in the sample) and `active_war` (17) each carry a dated
`history` recording join/leave events and every battle:

```
'1453.4.13': { battle: {
    name='苏腊巴亚' location=628 result='no'      # result=yes -> attacker won
    attacker={ cavalry=1964 infantry=6871 losses=3718 country=SUN commander='…' }
    defender={ cavalry=3000 infantry=9000 losses=1519 country=MAJ commander='…' }
    winner_alliance=16.000 loser_alliance=21.000 } }
```

`extractWars` yields 638 wars with **3,172 battles** (272 naval), plus sides,
war goals, dated join/leave events and peace terms. Battle `location` is a
province id and resolves against the province table (>98% of them).

One honest caveat: the `outcome` enum could **not** be established from the data
— 526 of 584 finished wars store `outcome=2` and 380 of those keep no war scores,
so no consistent attacker/defender split is derivable. `War.outcome` is exposed as
an opaque code; use `peaceTerms` instead.

### Country series

`income_statistics`, `nation_size_statistics`, `inflation_statistics` and
`score_statistics` hold one entry per country with a `data` block keyed by year
(`{ 1530=780 … 1574=2280 }`). Note this is a **rolling window of roughly 45
years**, not the whole campaign — the province and war logs are the long history.

## 8. Using the parser

```ts
import {
  SaveDocument,
  countryScalar,
  countryGroup,
} from '@eu4/parser';

const doc = await SaveDocument.fromFile('存档示例/mp_俄罗斯1574_11_12.eu4');

doc.meta.date;                                  // '1574.11.12'
doc.meta.player;                                // 'RUS'
doc.meta.displayedCountryName;                  // '俄罗斯'
doc.meta.version.text;                          // '1.37.5.0'

doc.sections;                                   // top-level index: key, kind, byte range
doc.section('countries')?.size;                 // 37,401,092
doc.describe('countries', 'RUS');               // member list of one country

doc.provinces().get(1)?.name;                   // '斯德哥尔摩'
doc.countries().get('GBR');
countryScalar(doc.countries().get('GBR')!, 'capital');   // '236'
countryGroup(doc.countries().get('RUS')!, 'technology'); // { adm_tech: '12', … }

doc.countryDetail('RUS');                       // verbatim, unresolved full block
doc.provinceDetail(295);

const snapshot = doc.snapshot();                // JSON-friendly typed state
```

### What the snapshot contains

* `meta` — date, version, player, DLC, mods (all 11 in the sample), campaign stats.
* `provinces` — one record per province: name, owner, controller, cores, culture
  (original/native), religion (original), trade node and good, base tax /
  production / manpower, city flag, institutions. Unrecognised flat fields go to
  `extra`, so nothing is lost.
* `countries` — flat scalars, bare list blocks, small sub-blocks flattened
  (`technology`, `colors`, …) and a summary for large ones (`history`, `army`,
  `navy`, `flags`, …) that can be pulled in full with `countryDetail(tag)`.
  Repeated keys widen to arrays — country blocks legitimately repeat `rival`,
  `estate`, `active_age_ability`.
* `sections` — a curated set of small top-level sections (`flags`, `diplomacy`,
  `map_area_data`, `great_projects`, …) parsed verbatim; `--sections all` takes
  everything below 2 MB except `countries`/`provinces`.

Large sections are **skipped, never materialised**: walking the 37 MB `countries`
block costs one brace-balanced scan.

## 9. Performance

Sample save: 8.3 MB on disk, 57.4 MB inflated, 375,385 strings, 2,000 top-level
sections.

| operation | time |
|-----------|------|
| open + inflate | ~0.6 s |
| index top-level sections (skipping both big blocks) | ~0.4 s |
| full snapshot (4,941 provinces + 1,380 countries) | ~1.1 s |
| snapshot JSON size | 20.7 MB |

## 10. How the encoding was reverse-engineered

Recorded because it is the only non-obvious part, and because any future
regression should be re-verified the same way.

1. `gamestate` starts with `EU4txt`, so the payload is text — but strings were
   not valid UTF-8, and the byte pattern `10 C4 4F` appeared for 俄.
2. Guessing `0x10 + UTF-16LE` decoded 俄罗斯, 十三殖民地 and friends exactly, but
   ~30% of strings produced rare, nonsensical characters.
3. The break came from pairing the Chinese localisation mod's escaped files with
   the same mods' `localisation_source` plain-UTF-8 sources (12 matching files).
   Aligning them character by character over **60,243 characters** gave a single
   delta per marker with no exceptions: `0`, `-14`, `+2304`, `+2290`.
4. Final validation: `scripts/verify.ts` re-checks the parser against
   `map/definition.csv` and the game's own localisation.

```
node scripts/verify.ts
```

Expected result: all 4,941 province ids resolve in `definition.csv`, capitals
resolve (GBR->伦敦, CAS->托雷多, SPI->都灵), and 3,343 of 3,633 localised province
names match the save exactly. The 290 differences are **not** encoding errors —
they are names the game changed during play (dynamic cultural names), which the
save stores and the localisation does not.

## 11. Known limits

* Country-level `capital` is trusted as-is; placeholder countries use `capital=0`.
* Only ZIP methods 0 (stored) and 8 (deflate) are supported — that is all EU4 uses.
* `node:zlib` is used for inflation. `extractEntry` accepts an injected
  `InflateRaw`, so a browser build can plug in `DecompressionStream`.
* The snapshot is a lossy *view*; `countryDetail`/`provinceDetail` and
  `readSection` give verbatim access whenever the view is not enough.
* The country ledger series only span a rolling ~45-year window, so long-range
  charts have to be built from the province and war logs.
* A save's last recorded province event is its own date, which makes
  100%-exact replay a usable regression test — keep that check when touching
  `timeline.ts`.
