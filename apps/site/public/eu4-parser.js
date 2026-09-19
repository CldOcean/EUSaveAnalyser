/**
 * EU4 save parser, built for the browser by scripts/build-browser-parser.ts.
 *
 * Do not edit: it is generated from packages/eu4-parser/src/*.ts. The browser
 * cannot inflate synchronously, so pages unpack the zip themselves (see
 * public/parser.js) and call SaveDocument.fromMembers().
 */
// ---- colours.ts ----
/**
 * Colour maths for the viewer's three colour modes.
 *
 * sRGB triples in, sRGB triples out: no parsing, no state. It lives in the parser
 * package because both data planes need **identical** numbers — the browser build
 * (`apps/site/public/viewer-build.js`, which imports the generated
 * `public/eu4-parser.js`) and the offline generator (`scripts/render-timeline.ts`).
 * `apps/site/test/viewer-build.test.ts` compares their `colours` tables key by key,
 * so a divergence here is a failed build rather than a subtly different map.
 */

/** An `[r, g, b]` triple, one byte per channel. */
                                           

/**
 * How far a subject's colour may sit from its overlord's, as CIE76 ΔE.
 *
 * ΔE ≈ 2.3 is the just-noticeable difference, so 8–14 reads as "the same colour,
 * clearly its own country". The band is a *distance*, not a percentage: the old
 * fixed 28–60 % lightening landed anywhere from ΔE 16 (a pale overlord) to 73 (a
 * saturated one), which is a different colour rather than a shade of the overlord's.
 */
const SUBJECT_SHADE = { low: 8, high: 14 }         ;

/**
 * Whether a triple is the `255 255 255` an EU4 save writes for a country the
 * engine colours itself.
 *
 * Colonial nations and the `C##`/`D##` pools carry it in `color` while the colour
 * actually drawn is derived from the mother country (written to `map_color`), so
 * pure white is a placeholder there, not a colour.
 */
function isPlaceholderColour(rgb                   )          {
  return rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255;
}

/** Rec. 709 relative luminance; decides which way a shade moves. */
function luminance(rgb                                   )         {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** sRGB -> CIE L*a*b* (D65), the space ΔE is measured in. */
function toLab(rgb                                   )                           {
  const linear = (channel        ) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(rgb[0]);
  const g = linear(rgb[1]);
  const b = linear(rgb[2]);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t        ) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference: 2.3 is the just-noticeable difference, 10+ is obvious. */
function deltaE(a                                   , b                                   )         {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * The shade of `rgb` that sits `target` ΔE away from it.
 *
 * Direction follows the old hand-tuned version: a pale colour is darkened
 * (lightening Austria's white would not move it at all), everything else is pulled
 * towards white, which keeps the hue and is what the engine itself does to a
 * colonial nation. The *distance* is solved instead of guessed, so a near-white and
 * a nearly black overlord both hand their subjects a colour the same perceptual
 * distance away.
 */
function shadeRgb(rgb                                   , target        )      {
  const pale = luminance(rgb) > 150;
  const at = (amount        )      =>
    pale
      ? [
          Math.round(rgb[0] * (1 - amount * 0.7)),
          Math.round(rgb[1] * (1 - amount * 0.7)),
          Math.round(rgb[2] * (1 - amount * 0.7)),
        ]
      : [
          Math.round(rgb[0] + (255 - rgb[0]) * amount),
          Math.round(rgb[1] + (255 - rgb[1]) * amount),
          Math.round(rgb[2] + (255 - rgb[2]) * amount),
        ];
  // ΔE grows monotonically with the amount in both directions, so a bisection lands
  // on the requested distance; 24 steps is far below one 8-bit channel step.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (deltaE(at(middle), rgb) < target) low = middle;
    else high = middle;
  }
  return at((low + high) / 2);
}

/**
 * The ΔE target for every member of one family (a subject set, or one overlord's
 * colonial nations).
 *
 * Members are spread across the band in tag order rather than by a per-tag hash:
 * siblings are the ones that must not be confused with each other, and the hash
 * landed several of them on the same shade (CAS's five colonies were all `#736605`).
 * A family of one gets the middle of the band.
 */
function familyTargets(
  members                   ,
  band                                = SUBJECT_SHADE,
)                      {
  const sorted = [...new Set(members)].sort();
  const targets = new Map                ();
  sorted.forEach((member, rank) => {
    const target =
      sorted.length <= 1 ? (band.low + band.high) / 2 : band.low + ((band.high - band.low) * rank) / (sorted.length - 1);
    targets.set(member, target);
  });
  return targets;
}

/**
 * Countries drawn in another country's own colour although they are not a 属国.
 *
 * Two different things put a foreign colour into a save, and both land here:
 *
 *   * **A subjection that has ended.** A recolouring mod hands a subject its overlord's
 *     colour by writing it into `map_color` (EU4's `change_country_color`) and leaves the
 *     country its own `color`. Independence restores nothing: the mod's "I am nobody's
 *     subject any more" restore is a *decision* the country has to take, and a human
 *     player may never take it. In the sample save 瓦剌 (OIR) draws 明's `#b38068` while
 *     owning 56 provinces and holding its own `#ccb8b1`.
 *   * **A 朝贡国 (tributary).** By the user's rule tributaries are *not* 属国, so 属国染色
 *     never hands them an overlord's shade — but the mods paint with EU4's `is_subject`,
 *     which counts tributaries as subjects, so their saved colour is the overlord's too
 *     (in the sample save 17 of its 20 tributaries draw exactly that).
 *
 * Either way 属国染色 gives the country its own colour back: drawing the foreign one would
 * claim a relationship the mode does not acknowledge. 模组色 stays faithful — the game
 * really does draw that colour — and 原始色 already shows the country's own colour.
 *
 * The signature is four conditions, all read from the save:
 *
 *   1. it is not a subject now (`subject[index]` is false),
 *   2. it owns land (`landed[index]`), so it is actually drawn on the map,
 *   3. it does not draw its own colour (`drawn !== own`), so something recoloured it,
 *   4. the colour it draws is some **other** country's own colour (`drawn` is in `own`,
 *      and condition 3 guarantees it is not this one's).
 *
 * A country manually recoloured to exactly another country's own colour would also be
 * flagged; across the nine sample saves only the real leftovers and the painted
 * tributaries match, and the two manual recolours (`FRS`, arbitrary colours) do not.
 *
 * @param input index-aligned arrays: `own` is the country's recorded colour
 *   (`undefined` when it has none — a colonial nation's placeholder white), `drawn` is
 *   what the save actually draws, `subject` says whether the tag follows an overlord,
 *   `landed` whether it owns at least one province.
 * @returns one 0/1 flag per index.
 */
function foreignTintFlags(input   
                                       
                           
                              
                             
 )           {
  const { own, drawn, subject, landed } = input;
  const owners = new Set        ();
  for (const colour of own) if (colour !== undefined) owners.add(colour);
  return own.map((colour, index) =>
    colour !== undefined &&
    landed[index] &&
    !subject[index] &&
    drawn[index] !== colour &&
    owners.has(drawn[index]          )
      ? 1
      : 0,
  );
}


//# sourceURL=colours.ts

// ---- value.ts ----
/**
 * Generic (materialising) Clausewitz value tree.
 *
 * The streaming reader in `clausewitz.ts` is what big sections should use; this
 * module is for small documents such as the `meta` member of a save, and for
 * exploratory tooling where convenience matters more than memory.
 */

/** A block whose members are all unkeyed, e.g. `cores={ SWE RUS }`. */
                             
               
                  
 

                          
              
                
 

/** Parse the value described by `member`. */
function readNode(reader                  , member        )         {
  switch (member.kind) {
    case 'string':
      return { type: 'string', value: reader.stringValue(member) };
    case 'scalar':
      return { type: 'scalar', value: reader.rawValue(member) };
    case 'block':
      return readBlock(reader.enter(member));
  }
}

function readBlock(inner                  )                           {
  const entries            = [];
  const items           = [];
  let sawKey = false;
  let sawBare = false;
  for (;;) {
    const member = inner.nextMember();
    if (member === null) break;
    const node = readNode(inner, member);
    if (member.key === null) {
      sawBare = true;
      items.push(node);
    } else {
      sawKey = true;
      entries.push({ key: member.key, value: node });
    }
  }
  if (sawBare && !sawKey) return { type: 'list', items };
  if (sawBare) {
    // Mixed block: keep the unnamed items under a reserved key so nothing is lost.
    entries.push({ key: '$items', value: { type: 'list', items } });
  }
  return { type: 'block', entries };
}

/** Parse every member of a region into a block node. */
function readAllNodes(reader                  )                           {
  return readBlock(reader);
}

/** Convert a node tree into plain JSON-friendly data. */
function toPlain(node        )          {
  switch (node.type) {
    case 'scalar':
      return coerceScalar(node.value);
    case 'string':
      return node.value;
    case 'list':
      return node.items.map(toPlain);
    case 'block': {
      const out                          = {};
      for (const entry of node.entries) {
        const value = toPlain(entry.value);
        const existing = out[entry.key];
        if (existing === undefined) {
          out[entry.key] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          out[entry.key] = [existing, value];
        }
      }
      return out;
    }
  }
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/** Turn a raw scalar into a number/boolean when it clearly is one. */
function coerceScalar(raw        )                            {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  if (NUMERIC.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

/** Numeric interpretation of a raw scalar, or `undefined`. */
function toNumber(raw                    )                     {
  if (raw === undefined) return undefined;
  if (!NUMERIC.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function toBoolean(raw                    )                      {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  return undefined;
}

                           
               
                
              
                                                                            
                  
 

/** Parse an EU4 date such as `1444.11.11`. */
function parseGameDate(raw                    )                       {
  if (!raw) return undefined;
  const parts = raw.split('.');
  if (parts.length !== 3) return undefined;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }
  return { year, month, day, ordinal: year * 372 + month * 31 + day };
}

function formatGameDate(date          )         {
  return `${date.year}.${date.month}.${date.day}`;
}

                          


//# sourceURL=value.ts

// ---- types.ts ----
/**
 * Domain types for a parsed EU4 save.
 *
 * Vocabulary:
 *   - *tag*      three-letter country identifier as used by EU4 (`RUS`, `MOS`, `---`).
 *   - *province* numeric province id (0 is an uncolonised/placeholder entry, -1 sea).
 *   - *snapshot* the extracted, JSON-friendly state of one save at one date.
 */

/** `savegame_version` block from `meta`. */
                              
                
                 
                
                
                
                                
               
 

                          
                   
               
 

/** One row of the "campaign stats" scoreboard found in `meta`. */
                               
              
                      
               
                    
                        
                 
                       
                       
 

/** Everything read out of the archive's small `meta` member. */
                           
               
                                                                                
                    
                  
                                
                       
                                                        
                     
                
                  
                       
                       
                      
                          
                    
                                
                                                       
                
 

/** A province as stored in `gamestate/provinces`. */
                                 
             
                
                 
                      
                              
                                                     
                           
                                    
                  
                                                           
                   
                                                                                  
                      
                                                                       
                                           
                                                                    
                          
                                                                         
                             
                                                                                      
                                                        
                                                                               
                       
                                                                                  
                               
                   
                   
                           
                         
                    
                            
                 
                      
                   
                          
                        
                    
                   
                        
                         
                                                                 
                                
 

/**
 * A country as stored in `gamestate/countries`.
 *
 * Country blocks repeat keys legitimately (`rival`, `estate`, `active_age_ability`,
 * `ignore_decision`, ...), so every map below widens to an array as soon as a key
 * is seen twice. Use the `countryScalar` / `countryScalarList` / `countryGroup`
 * helpers in `document.ts` instead of indexing these maps directly.
 */
                                
              
                                                                          
                                             
                                                                
                                  
                                                                             
                                                                                 
                                                                                     
                                                        
 

                               
                  
                
                                                                       
                  
 

                                
                        
                             
                       
 

/** The complete extracted state of one save. */
                               
                                                                 
                 
                 
                                                                   
                     
                      
                             
                                                      
                                                
                                            
                                           
                                                                                 
                                    
                       
                                                                                 
                     
                                                                
                    
 

/** A top-level (or nested) member located inside the gamestate buffer. */
                             
              
                                      
                
              
                                  
               
                                
                
 


//# sourceURL=types.ts

// ---- encoding.ts ----
/**
 * EU4 "letter stream" string encoding.
 *
 * ## Why this exists
 *
 * Europa Universalis IV (Clausewitz engine) does not store non-Latin text as
 * UTF-8. Inside a save game every string is a sequence of *letters*, where a
 * letter is either
 *
 *   - a single byte `>= 0x20`, which is the Latin-1 code point of that byte, or
 *   - an escape: a marker byte `< 0x20` followed by **two** bytes holding a
 *     little-endian 16-bit code unit.
 *
 * The escape's stored 16-bit value is *not* the real code point: a marker
 * specific delta has to be added back. Empirically (verified against 60,243
 * characters of ground truth, and against 2,567 whole localisation strings with
 * zero mismatches) the four markers behave as follows:
 *
 *   marker  delta     meaning of the bits
 *   ------  --------  -------------------------------------------------------
 *   0x10    +0        plain BMP code unit
 *   0x11    -14       code unit was shifted by +14
 *   0x12    +2304     code unit was shifted by -2304
 *   0x13    +2290     both of the above at once
 *
 * Note `delta(0x13) === delta(0x12) + delta(0x11)`, i.e. the low two bits of the
 * marker act as two independent flag bits. That is exactly how the game's own
 * font/text layer treats them; we only need the resulting arithmetic.
 *
 * ## Consequences for parsing
 *
 * The two payload bytes may themselves be `< 0x20` (e.g. 三 is stored as
 * `10 09 4E`), and they may be `0x22` (`"`) or `0x5C` (`\`). Any scanner that
 * walks a quoted string therefore *must* consume escapes three bytes at a time;
 * otherwise it will see a premature closing quote or a bogus backslash escape.
 */

/** Marker byte -> value that must be added to the stored 16-bit code unit. */
const MARKER_DELTAS                                   = {
  0x10: 0,
  0x11: -0x0e,
  0x12: 0x09_00,
  0x13: 0x08_f2,
};

/** True if `byte` can start an escape letter. */
function isEscapeMarker(byte        )          {
  return byte >= 0x10 && byte <= 0x13;
}

/** Deltas, ordered by preference when *writing* text back out. */
const ENCODE_ORDER                                                          = [
  [0x10, 0],
  [0x12, 0x09_00],
  [0x11, -0x0e],
  [0x13, 0x08_f2],
];

                                
     
                                                                                 
                                                                               
     
                                                             
     
                                                                                
                                                                            
                                                                               
                     
     
                                               
                                                                  
                   
 

/** The `"` byte that delimits strings. */
const QUOTE = 0x22;

/**
 * How many bytes the letter starting at `i` occupies: 3 for a complete escape,
 * 1 for anything else.
 *
 * A letter is only treated as a three-byte escape when both payload bytes are
 * actually present and the second one is not the string's closing quote. The
 * closing quote always wins: a well-formed writer cannot emit a payload that
 * destroys its own delimiter, so a collision means the escape was truncated.
 */
function escapeLengthAt(
  bytes            ,
  i        ,
  end         = bytes.length,
)         {
  const byte = bytes[i];
  if (byte === undefined || !isEscapeMarker(byte)) return 1;
  if (i + 3 > end) return 1;
  if (bytes[i + 2] === QUOTE) return 1;
  return 3;
}

class Eu4DecodeError extends Error {
           offset        ;

  constructor(message        , offset        ) {
    super(message);
    this.name = 'Eu4DecodeError';
    this.offset = offset;
  }
}

const CHUNK = 8192;

function codePointsToString(codePoints                   )         {
  if (codePoints.length === 0) return '';
  if (codePoints.length <= CHUNK) return String.fromCharCode(...codePoints);
  let out = '';
  for (let i = 0; i < codePoints.length; i += CHUNK) {
    out += String.fromCharCode(...codePoints.slice(i, i + CHUNK));
  }
  return out;
}

/**
 * Decode a raw EU4 letter stream into a JavaScript string.
 *
 * @param bytes source buffer
 * @param start first byte of the encoded text
 * @param end one past the last byte
 */
function decodeEu4String(
  bytes            ,
  start = 0,
  end         = bytes.length,
  options                = {},
)         {
  const codePoints           = [];
  let i = start;
  while (i < end) {
    const byte = bytes[i]          ;

    if (isEscapeMarker(byte)) {
      if (escapeLengthAt(bytes, i, end) === 3) {
        const stored = (bytes[i + 1]          ) | ((bytes[i + 2]          ) << 8);
        codePoints.push(stored + (MARKER_DELTAS[byte]          ));
        i += 3;
        continue;
      }
      // Truncated escape: EU4 cut the name at a byte budget.
      if (options.strict) {
        throw new Eu4DecodeError('truncated escape', i);
      }
      options.onTruncatedEscape?.(i);
      codePoints.push(0xfffd);
      i += 1;
      continue;
    }

    if (byte < 0x20) {
      if (options.strict) {
        throw new Eu4DecodeError(
          `unknown escape marker 0x${byte.toString(16).padStart(2, '0')}`,
          i,
        );
      }
      options.onUnknownMarker?.(byte, i);
      // Degrade gracefully: treat as a plain control character.
      codePoints.push(byte);
      i += 1;
      continue;
    }

    if (byte === 0x5c) {
      // Backslash escape produced by the writer (\" and \\ are the common cases).
      i += 1;
      if (i < end) {
        codePoints.push(bytes[i]          );
        i += 1;
      }
      continue;
    }

    codePoints.push(byte);
    i += 1;
  }
  return codePointsToString(codePoints);
}

/** Encode a JavaScript string back into an EU4 letter stream. */
function encodeEu4String(text        )             {
  const out           = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)          ;
    if (cp > 0xffff) {
      // Astral characters are stored as a UTF-16 surrogate pair of escapes.
      writeEscape(out, ch.charCodeAt(0));
      writeEscape(out, ch.charCodeAt(1));
      continue;
    }
    // The two bytes the grammar reserves are written with a backslash escape,
    // which is unambiguous for any scanner.
    if (cp === 0x22 || cp === 0x5c) {
      out.push(0x5c, cp);
      continue;
    }
    // Letters below U+0100 occupy a single byte.
    if (cp >= 0x20 && cp <= 0xff) {
      out.push(cp);
      continue;
    }
    writeEscape(out, cp);
  }
  return Uint8Array.from(out);
}

function writeEscape(out          , codePoint        )       {
  for (const [marker, delta] of ENCODE_ORDER) {
    const stored = codePoint - delta;
    if (stored >= 0 && stored <= 0xffff) {
      out.push(marker, stored & 0xff, (stored >> 8) & 0xff);
      return;
    }
  }
  throw new Eu4DecodeError(
    `code point U+${codePoint.toString(16).toUpperCase()} cannot be encoded`,
    -1,
  );
}

// ---------------------------------------------------------------------------
// Mixed-encoding detection
// ---------------------------------------------------------------------------

/**
 * Not every string in a save uses the letter stream.
 *
 * Strings that the game read raw from disk — the recorded save-game file name
 * (`meta/save_game`) and mod names (`meta/mods_enabled_names[].name`) — stay
 * plain UTF-8. Everything that goes through the engine's font/text pipeline
 * (province names, displayed country names, player nicknames, campaign stat
 * labels) uses the letter stream.
 *
 * The two are reliably distinguishable:
 *
 *   - a letter stream containing any non-Latin character *must* contain an
 *     escape marker, i.e. a control byte other than tab/newline/CR;
 *   - a UTF-8 string with non-ASCII content never does.
 *
 * So: control byte present -> letter stream; otherwise valid UTF-8 with a high
 * byte -> UTF-8; otherwise the two agree (pure ASCII / Latin-1).
 */
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function isPlainWhitespace(byte        )          {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** True when the range contains a byte that can only be a letter-stream marker. */
function looksLikeLetterStream(
  bytes            ,
  start = 0,
  end         = bytes.length,
)          {
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i]          ;
    if (byte < 0x20) {
      if (isPlainWhitespace(byte)) continue;
      return true;
    }
    if (byte === 0x5c) i += 1; // skip the escaped character
  }
  return false;
}

/** Decode a string whose encoding may be either UTF-8 or the letter stream. */
function decodeSaveString(
  bytes            ,
  start = 0,
  end         = bytes.length,
  options                = {},
)         {
  if (looksLikeLetterStream(bytes, start, end)) {
    return decodeEu4String(bytes, start, end, options);
  }
  let hasHighByte = false;
  for (let i = start; i < end; i += 1) {
    if ((bytes[i]          ) >= 0x80) {
      hasHighByte = true;
      break;
    }
  }
  if (hasHighByte) {
    try {
      return unescapeBackslashes(utf8Strict.decode(bytes.subarray(start, end)));
    } catch {
      // Not valid UTF-8 after all: fall back to the letter stream.
    }
  }
  return decodeEu4String(bytes, start, end, options);
}

/** Remove the writer's backslash escapes from already-decoded text. */
function unescapeBackslashes(text        )         {
  if (!text.includes('\\')) return text;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]          ;
    if (ch === '\\' && i + 1 < text.length) {
      i += 1;
      out += text[i]          ;
      continue;
    }
    out += ch;
  }
  return out;
}


//# sourceURL=encoding.ts

// ---- clausewitz.ts ----
/**
 * Clausewitz (Paradox) text reader — the grammar used by `gamestate`/`meta`.
 *
 * ## Grammar
 *
 *   document := member*
 *   member   := key value | value          // a value with no key is a "bare" item
 *   key      := bareword | quotedString
 *   value    := block | quotedString | bareword
 *   block    := '{' member* '}'
 *
 * Two spellings of a keyed block appear in real saves and both must be handled:
 *
 *   countries={ ... }        // key '=' block   (the common form)
 *   map_area_data{ ... }     // key block       (no '=' — EU4 really writes this)
 *
 * A member whose key is followed by neither `=` nor `{` is a bare value; that is
 * how list-like blocks are written, e.g.
 *
 *   id_counters={ 36372 17356 29899 }
 *   cores={ SWE RUS }
 *
 * ## Strings
 *
 * String scanning is escape-aware. EU4 stores non-Latin characters as a marker
 * byte plus two payload bytes (see `encoding.ts`), and those payload bytes may be
 * anything — including `"` (0x22) and `\` (0x5C). A naive scanner would find a
 * premature closing quote. Inside a quoted string a byte `< 0x20` always starts a
 * three-byte escape letter.
 *
 * The reader is a cursor over a `Uint8Array`; it never copies unless asked, so
 * walking a 60 MB `gamestate` and skipping the 37 MB `countries` block is cheap.
 */

/** Bytes treated as whitespace by the format. */
function isWhitespace(byte        )          {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

const CHAR_LBRACE = 0x7b;
const CHAR_RBRACE = 0x7d;
const CHAR_QUOTE = 0x22;
const CHAR_EQUALS = 0x3d;
const CHAR_BACKSLASH = 0x5c;

                                                      

/** One parsed member header; the payload is still in the buffer. */
                         
                                                              
                     
                  
                                                                              
                     
                                             
                   
     
                                                                              
                                                                        
     
                       
                     
 

class ClausewitzError extends Error {
           offset        ;

  constructor(message        , offset        ) {
    super(`${message} (at byte offset ${offset})`);
    this.name = 'ClausewitzError';
    this.offset = offset;
  }
}

/**
 * Return the index just past the closing quote of the string starting at
 * `quoteIndex` (which must point at the opening quote).
 *
 * Only a *complete* escape letter (marker 0x10..0x13 plus two payload bytes that
 * do not collide with the delimiter) spans three bytes; see `escapeLengthAt`.
 * Getting this wrong does not merely garble one name — it desynchronises the
 * scan and swallows whole sections, because a mis-consumed quote flips the
 * scanner's in-string state for the rest of the file.
 */
function scanStringEnd(
  buf            ,
  quoteIndex        ,
  end        ,
)         {
  let i = quoteIndex + 1;
  while (i < end) {
    const byte = buf[i]          ;
    if (byte < 0x20) {
      // A complete escape consumes its two payload bytes, which may be anything
      // at all — including `"` or `\`. Any other control byte is one character.
      i += escapeLengthAt(buf, i, end);
      continue;
    }
    if (byte === CHAR_BACKSLASH) {
      i += 2;
      continue;
    }
    if (byte === CHAR_QUOTE) return i + 1;
    i += 1;
  }
  return end;
}

/** A cursor over one buffer region. Cheap to create; holds no state of its own. */
class ClausewitzReader {
           buf            ;
           end        ;
  pos        ;

  constructor(buf            , start = 0, end         = buf.length) {
    this.buf = buf;
    this.end = end;
    this.pos = start;
  }

  atEnd()          {
    return this.pos >= this.end;
  }

  peek()         {
    return this.pos < this.end ? (this.buf[this.pos]          ) : -1;
  }

  skipWhitespace()       {
    while (this.pos < this.end && isWhitespace(this.buf[this.pos]          )) {
      this.pos += 1;
    }
  }

  /** Read one key or bareword token, without decoding escapes. */
  #readBareword()                                 {
    const start = this.pos;
    while (this.pos < this.end) {
      const byte = this.buf[this.pos]          ;
      if (
        isWhitespace(byte) ||
        byte === CHAR_EQUALS ||
        byte === CHAR_LBRACE ||
        byte === CHAR_RBRACE
      ) {
        break;
      }
      this.pos += 1;
    }
    return { start, end: this.pos };
  }

  /**
   * Advance past the next member and describe it.
   * Returns `null` at the end of the region or on the block's closing brace.
   */
  nextMember()                {
    this.skipWhitespace();
    if (this.pos >= this.end) return null;
    const lead = this.buf[this.pos]          ;
    if (lead === CHAR_RBRACE) return null;

    // --- a block with no key at all, e.g. `mods_enabled_names={ { ... } { ... } }` ---
    if (lead === CHAR_LBRACE) {
      return this.#readValue(null);
    }

    // --- read the leading token (key, or a bare value) ---
    let tokenStart        ;
    let tokenEnd        ;
    let contentStart        ;
    let contentEnd        ;
    let tokenKind           ;

    if (lead === CHAR_QUOTE) {
      tokenStart = this.pos;
      tokenEnd = scanStringEnd(this.buf, tokenStart, this.end);
      contentStart = tokenStart + 1;
      contentEnd = Math.max(contentStart, tokenEnd - 1);
      this.pos = tokenEnd;
      tokenKind = 'string';
    } else {
      const span = this.#readBareword();
      if (span.start === span.end) {
        throw new ClausewitzError('unexpected token', span.start);
      }
      tokenStart = span.start;
      tokenEnd = span.end;
      contentStart = tokenStart;
      contentEnd = tokenEnd;
      this.pos = span.end;
      tokenKind = 'scalar';
    }

    // --- a key is only a key when '=' or '{' follows it ---
    this.skipWhitespace();
    const next = this.peek();
    if (next !== CHAR_EQUALS && next !== CHAR_LBRACE) {
      // Bare value: the token itself is the value, e.g. `cores={ SWE RUS }`.
      return {
        key: null,
        kind: tokenKind,
        valueStart: tokenStart,
        valueEnd: tokenEnd,
        contentStart,
        contentEnd,
      };
    }

    const key = this.#decodeKey(tokenKind, contentStart, contentEnd);
    if (next === CHAR_EQUALS) {
      this.pos += 1;
      this.skipWhitespace();
    }
    // For `key{`, the cursor already sits on the '{'; for `key = {` it was
    // advanced past the '=' and following whitespace.
    return this.#readValue(key);
  }

  #decodeKey(kind           , contentStart        , contentEnd        )         {
    return kind === 'string'
      ? decodeSaveString(this.buf, contentStart, contentEnd)
      : latin1(this.buf, contentStart, contentEnd);
  }

  /** Read the value at the cursor (block, string, or bareword). */
  #readValue(key               )         {
    const start = this.pos;
    const byte = this.buf[start]          ;
    if (byte === CHAR_LBRACE) {
      const end = this.skipBlock();
      return {
        key,
        kind: 'block',
        valueStart: start,
        valueEnd: end,
        contentStart: start,
        contentEnd: end,
      };
    }
    if (byte === CHAR_QUOTE) {
      const end = scanStringEnd(this.buf, start, this.end);
      this.pos = end;
      return {
        key,
        kind: 'string',
        valueStart: start,
        valueEnd: end,
        contentStart: start + 1,
        contentEnd: Math.max(start + 1, end - 1),
      };
    }
    const span = this.#readBareword();
    if (span.start === span.end) {
      throw new ClausewitzError('expected a value', span.start);
    }
    return {
      key,
      kind: 'scalar',
      valueStart: span.start,
      valueEnd: span.end,
      contentStart: span.start,
      contentEnd: span.end,
    };
  }

  /**
   * Skip the block starting at the cursor (which must be `{`).
   * @returns the index one past the matching `}`.
   */
  skipBlock()         {
    if (this.buf[this.pos] !== CHAR_LBRACE) {
      throw new ClausewitzError('expected "{"', this.pos);
    }
    let depth = 0;
    let i = this.pos;
    const end = this.end;
    while (i < end) {
      const byte = this.buf[i]          ;
      if (byte === CHAR_QUOTE) {
        i = scanStringEnd(this.buf, i, end);
        continue;
      }
      if (byte === CHAR_LBRACE) {
        depth += 1;
      } else if (byte === CHAR_RBRACE) {
        depth -= 1;
        if (depth === 0) {
          this.pos = i + 1;
          return i + 1;
        }
      }
      i += 1;
    }
    throw new ClausewitzError('unterminated block', this.pos);
  }

  /** Decode a string member's contents. */
  stringValue(member        )         {
    if (member.kind !== 'string') {
      throw new ClausewitzError('member is not a string', member.valueStart);
    }
    return decodeSaveString(this.buf, member.contentStart, member.contentEnd);
  }

  /** Raw (undecoded) text of a scalar or string member. */
  rawValue(member        )         {
    return latin1(this.buf, member.contentStart, member.contentEnd);
  }

  /** A reader positioned inside a block member, covering only its members. */
  enter(member        )                   {
    if (member.kind !== 'block') {
      throw new ClausewitzError('member is not a block', member.valueStart);
    }
    return new ClausewitzReader(this.buf, member.valueStart + 1, member.valueEnd - 1);
  }

  /** Collect every member of this region into an array. */
  readAll()           {
    const out           = [];
    for (;;) {
      const member = this.nextMember();
      if (member === null) return out;
      out.push(member);
    }
  }
}

/** Decode a run of bytes as Latin-1 (used for keys and barewords). */
function latin1(buf            , start        , end        )         {
  let out = '';
  const chunk = 4096;
  for (let i = start; i < end; i += chunk) {
    const stop = Math.min(i + chunk, end);
    out += String.fromCharCode(...buf.subarray(i, stop));
  }
  return out;
}

/** Convenience: read the first `limit` members of a region. */
function peekMembers(
  reader                  ,
  limit        ,
)                                                               {
  const out                                                               = [];
  const cursor = new ClausewitzReader(reader.buf, reader.pos, reader.end);
  for (let i = 0; i < limit; i += 1) {
    const member = cursor.nextMember();
    if (member === null) break;
    out.push({
      key: member.key,
      kind: member.kind,
      size: member.valueEnd - member.valueStart,
    });
  }
  return out;
}


//# sourceURL=clausewitz.ts

// ---- zip.ts ----
/**
 * Minimal ZIP reader for `.eu4` save files.
 *
 * Modern EU4 saves (1.26+) are plain ZIP archives. A typical save contains:
 *
 *   meta       ~3 KB   header data: date, version, DLC, mods, campaign stats
 *   gamestate  ~60 MB  the whole simulation state, as Clausewitz text
 *   ai         ~50 B   AI checksum
 *
 * The `gamestate` member is deflate-compressed, so it must be inflated before
 * any text parsing happens. Only what save files actually use is implemented:
 * stored (method 0) and deflate (method 8), no encryption, no data descriptors
 * (EU4 writes sizes into the local header — but the central directory is used
 * anyway, which is the reliable path).
 *
 * Deliberately dependency-free: `node:zlib` supplies the inflater, and the
 * inflate step is injectable so the same code can later run in a browser on top
 * of `DecompressionStream`.
 */

const inflateRawSync = () => { throw new Error("synchronous inflate needs Node; pass inflated members instead"); };

const LOCAL_FILE_HEADER_SIG = 0x04_03_4b_50;
const CENTRAL_DIRECTORY_SIG = 0x02_01_4b_50;
const END_OF_CENTRAL_DIRECTORY_SIG = 0x06_05_4b_50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIG = 0x07_06_4b_50;

const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;

                           
               
                                                     
                 
                         
                           
                                                      
                            
 

                                                                                    

class ZipError extends Error {
  constructor(message        ) {
    super(message);
    this.name = 'ZipError';
  }
}

function findEndOfCentralDirectory(buf            )         {
  const minOffset = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= minOffset; i -= 1) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      return i;
    }
  }
  throw new ZipError('not a ZIP archive: end of central directory not found');
}

/**
 * Read the central directory of a ZIP archive.
 *
 * @param buf whole file contents
 */
function readZipEntries(buf            )             {
  const eocd = findEndOfCentralDirectory(buf);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let entryCount = view.getUint16(eocd + 10, true);
  let directoryOffset = view.getUint32(eocd + 16, true);

  if (entryCount === 0xffff || directoryOffset === 0xffff_ffff) {
    // ZIP64: locate the ZIP64 EOCD record through its locator.
    const locatorOffset = findSignatureBackwards(
      buf,
      ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIG,
      eocd,
    );
    if (locatorOffset < 0) {
      throw new ZipError('ZIP64 archive without a ZIP64 EOCD locator');
    }
    const zip64EocdOffset = Number(view.getBigUint64(locatorOffset + 8, true));
    entryCount = Number(view.getBigUint64(zip64EocdOffset + 32, true));
    directoryOffset = Number(view.getBigUint64(zip64EocdOffset + 48, true));
  }

  const entries             = [];
  let pos = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(pos, true) !== CENTRAL_DIRECTORY_SIG) {
      throw new ZipError(
        `corrupt central directory: bad signature for entry ${i} at ${pos}`,
      );
    }
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder('utf-8').decode(
      buf.subarray(pos + 46, pos + 46 + nameLength),
    );
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findSignatureBackwards(
  buf            ,
  sig        ,
  from        ,
)         {
  const b0 = sig & 0xff;
  const b1 = (sig >>> 8) & 0xff;
  const b2 = (sig >>> 16) & 0xff;
  const b3 = (sig >>> 24) & 0xff;
  for (let i = from - 4; i >= 0; i -= 1) {
    if (buf[i] === b0 && buf[i + 1] === b1 && buf[i + 2] === b2 && buf[i + 3] === b3) {
      return i;
    }
  }
  return -1;
}

/** Extract and return one entry's decompressed contents. */
function extractEntry(
  buf            ,
  entry          ,
  inflateRaw             = defaultInflateRaw,
)             {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== LOCAL_FILE_HEADER_SIG) {
    throw new ZipError(`corrupt local header for "${entry.name}"`);
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data, entry.uncompressedSize);
  throw new ZipError(
    `unsupported compression method ${entry.method} for "${entry.name}"`,
  );
}

function defaultInflateRaw(data            , uncompressedSize        )             {
  const out = inflateRawSync(data, {
    maxOutputLength: Math.max(uncompressedSize, 1) + 1024,
  });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** A `.eu4` save opened as an archive of named members. */
class SaveArchive {
           entries                     ;
           #buffer            ;
           #byName                       ;
  /** Members supplied ready-inflated instead of read out of `#buffer`. */
           #inflated                         ;

  constructor(buffer            ) {
    this.#buffer = buffer;
    // An empty buffer is how `fromInflated` starts: there is no zip to read.
    this.entries = buffer.length > 0 ? readZipEntries(buffer) : [];
    this.#byName = new Map(this.entries.map((e) => [e.name, e]));
    this.#inflated = new Map();
  }

  /**
   * Build an archive from members that are already inflated.
   *
   * The browser side uses this: it can list the zip itself but cannot inflate
   * synchronously, so it inflates with `DecompressionStream` and hands the bytes
   * over. (`inflateRaw` stays injectable for the same reason - see `extractEntry`.)
   */
  static fromInflated(
    meta            ,
    gamestate            ,
    names                    = ['meta', 'gamestate'],
  )              {
    const archive = new SaveArchive(new Uint8Array(0));
    archive.#inflated.set('meta', meta);
    archive.#inflated.set('gamestate', gamestate);
    for (const name of names) {
      if (!archive.#inflated.has(name)) archive.#inflated.set(name, new Uint8Array(0));
    }
    return archive;
  }

  get names()           {
    if (this.entries.length) return this.entries.map((e) => e.name);
    return [...this.#inflated.keys()];
  }

  has(name        )          {
    return this.#byName.has(name) || this.#inflated.has(name);
  }

  /** Read a member, or `undefined` when it is absent. */
  read(name        )                         {
    const pre = this.#inflated.get(name);
    if (pre) return pre;
    const entry = this.#byName.get(name);
    return entry ? extractEntry(this.#buffer, entry) : undefined;
  }
}


//# sourceURL=zip.ts

// ---- document.ts ----
/**
 * `SaveDocument` — the entry point of the parser.
 *
 * ```ts
 * const doc = await SaveDocument.fromFile('存档示例/mp_俄罗斯1574_11_12.eu4');
 * console.log(doc.meta.date, doc.meta.displayedCountryName);
 * const snapshot = doc.snapshot();
 * ```
 *
 * The archive is read once, the `gamestate` member is inflated once, and every
 * later query works directly on that buffer. Large sections that are not needed
 * are *skipped*, never materialised — walking the 37 MB `countries` block costs a
 * single brace-balanced scan.
 */

const readFile = () => { throw new Error("fromFile() needs Node; in the browser use SaveDocument.fromMembers()"); };




const DEFAULT_MAX_GROUP_BYTES = 16 * 1024;

/** Sections that are cheap and genuinely useful in a snapshot. */
const DEFAULT_SNAPSHOT_SECTIONS                    = [
  'players_countries',
  'gameplaysettings',
  'used_client_names',
  'id_counters',
  'flags',
  'revolution',
  'map_area_data',
  'great_projects',
  'active_advisors',
  'diplomacy',
  'active_war',
  'empire',
  'hre_leagues_status',
  'hre_religion_status',
  'trade_company_manager',
  'tech_level_dates',
  'idea_dates',
  'achievement_ok',
  'start_date',
  'current_age',
  'checksum',
  'multiplayer_random_seed',
];

/** Read-only lookup over a parsed block. */
class BlockView {
           node                          ;
           #map = new Map                  ();

  constructor(node                          ) {
    this.node = node;
    if (node.type === 'block') {
      for (const entry of node.entries) {
        const list = this.#map.get(entry.key);
        if (list) list.push(entry.value);
        else this.#map.set(entry.key, [entry.value]);
      }
    }
  }

  static from(node                    )                        {
    if (!node) return undefined;
    if (node.type !== 'block' && node.type !== 'list') return undefined;
    return new BlockView(node);
  }

  has(key        )          {
    return this.#map.has(key);
  }

  first(key        )                     {
    return this.#map.get(key)?.[0];
  }

  all(key        )           {
    return this.#map.get(key) ?? [];
  }

  keys()           {
    return [...this.#map.keys()];
  }

  scalar(key        )                     {
    const node = this.first(key);
    return node && node.type === 'scalar' ? node.value : undefined;
  }

  string(key        )                     {
    const node = this.first(key);
    if (!node) return undefined;
    if (node.type === 'string') return node.value;
    if (node.type === 'scalar') return node.value;
    return undefined;
  }

  number(key        )                     {
    return toNumber(this.scalar(key));
  }

  bool(key        )                      {
    return toBoolean(this.scalar(key));
  }

  block(key        )                        {
    return BlockView.from(this.first(key));
  }

  /** A list block (`{ "a" "b" }`) rendered as strings. */
  stringList(key        )           {
    const node = this.first(key);
    if (!node) return [];
    if (node.type === 'list') {
      return node.items.map((item) =>
        item.type === 'scalar' || item.type === 'string' ? item.value : '',
      );
    }
    if (node.type === 'block') {
      return node.entries.map((entry) => entry.key);
    }
    return [];
  }
}

                              
                                                               
                  
 

class SaveDocument {
           archive             ;
           source        ;
  /** Raw `meta` member contents. */
           metaBytes            ;
  /** Raw, inflated `gamestate` member contents. */
           gamestate            ;
  /** Top-level `gamestate` members, in file order. */
           sections                       ;
  /** Non-fatal issues encountered while parsing. */
           warnings           = [];

  #meta                      ;
  #sectionIndex                                       ;
  #provinces                                         ;
  #countries                                        ;

          constructor(
    archive             ,
    source        ,
    metaBytes            ,
    gamestate            ,
  ) {
    this.archive = archive;
    this.source = source;
    this.metaBytes = metaBytes;
    this.gamestate = gamestate;
    this.sections = indexTopLevel(gamestate);
  }

  /**
   * Open a save whose members have already been inflated.
   *
   * Browsers cannot inflate synchronously (there is no `inflateRawSync`; the
   * native `DecompressionStream` is async), so the browser unpacks the zip itself
   * and hands the two members over here. Everything downstream is identical to
   * `fromBuffer`, which is what makes a browser build of this parser possible at
   * all: no DEFLATE implementation is needed on that side.
   */
  static fromMembers(
    members                                                                        ,
    source = '<browser>',
  )               {
    if (!members.meta || !members.gamestate) {
      throw new Error(`"${source}" is not a readable EU4 save: meta and gamestate are both required`);
    }
    const archive = SaveArchive.fromInflated(
      members.meta,
      members.gamestate,
      members.names ?? ['meta', 'gamestate'],
    );
    return new SaveDocument(archive, source, members.meta, members.gamestate);
  }

  /** Open a `.eu4` file from disk. */
  static async fromFile(path        , options              = {})                        {
    const buffer = await readFile(path);
    return SaveDocument.fromBuffer(new Uint8Array(buffer), options.source ?? path);
  }

  /** Open an in-memory `.eu4` archive (e.g. an upload). */
  static fromBuffer(buffer            , source = '<buffer>')               {
    const archive = new SaveArchive(buffer);
    const metaBytes = archive.read('meta');
    if (!metaBytes) {
      throw new Error(
        `"${source}" is not a readable EU4 save: missing the "meta" member ` +
          `(found: ${archive.names.join(', ') || 'nothing'})`,
      );
    }
    const gamestate = archive.read('gamestate');
    if (!gamestate) {
      throw new Error(
        `"${source}" is missing the "gamestate" member ` +
          `(found: ${archive.names.join(', ') || 'nothing'})`,
      );
    }
    return new SaveDocument(archive, source, metaBytes, gamestate);
  }

  // ---------------------------------------------------------------- meta ----

  get meta()           {
    this.#meta ??= parseMeta(this.metaBytes, this.warnings);
    return this.#meta;
  }

  // ------------------------------------------------------------ sections ----

  #index()                            {
    if (!this.#sectionIndex) {
      const index = new Map                      ();
      for (const section of this.sections) {
        const list = index.get(section.key);
        if (list) list.push(section);
        else index.set(section.key, [section]);
      }
      this.#sectionIndex = index;
    }
    return this.#sectionIndex;
  }

  section(key        )                         {
    return this.#index().get(key)?.[0];
  }

  /** All references for a repeated top-level key, e.g. `active_war`. */
  allSections(key        )               {
    return this.#index().get(key) ?? [];
  }

  hasSection(key        )          {
    return this.#index().has(key);
  }

  /** Parse a top-level section into a generic value tree. */
  readSection(key        )                     {
    const ref = this.section(key);
    if (!ref) return undefined;
    return this.#readRef(ref);
  }

  readSectionView(key        )                        {
    return BlockView.from(this.readSection(key));
  }

  #readRef(ref            )         {
    const reader = new ClausewitzReader(this.gamestate, ref.start, ref.end);
    const member = reader.nextMember();
    if (!member) throw new Error(`section "${ref.key}" is empty`);
    return readNode(reader, member);
  }

  /**
   * A reader positioned *inside* a block section, covering only its members.
   * `SectionRef.start` points at the opening brace, so callers that want to walk
   * the members must step one byte in on each side.
   */
  #bodyReader(ref            )                               {
    if (ref.kind !== 'block') return undefined;
    return new ClausewitzReader(this.gamestate, ref.start + 1, ref.end - 1);
  }

  // ------------------------------------------------------------ provinces ---

  /** Extract every province, keyed by id. Cached. */
  provinces()                              {
    if (this.#provinces) return this.#provinces;
    const out = new Map                        ();
    const ref = this.section('provinces');
    const reader = ref ? this.#bodyReader(ref) : undefined;
    if (reader) {
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.kind !== 'block' || member.key === null) continue;
        const id = provinceIdFromKey(member.key);
        if (id === undefined) continue;
        out.set(id, extractProvince(reader, member, id));
      }
    }
    this.#provinces = out;
    return out;
  }

  // ------------------------------------------------------------ countries ---

  /** Extract every country, keyed by tag. Cached. */
  countries(options                 = {})                             {
    if (this.#countries) return this.#countries;
    const maxGroupBytes = options.maxGroupBytes ?? DEFAULT_MAX_GROUP_BYTES;
    const out = new Map                       ();
    const ref = this.section('countries');
    const reader = ref ? this.#bodyReader(ref) : undefined;
    if (reader) {
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.kind !== 'block' || member.key === null) continue;
        out.set(
          member.key,
          extractCountry(reader, member, member.key, maxGroupBytes),
        );
      }
    }
    this.#countries = out;
    return out;
  }

  /** Parse a single country's complete block, unresolved and verbatim. */
  countryDetail(tag        )                        {
    for (const ref of this.allSections('countries')) {
      const reader = this.#bodyReader(ref);
      if (!reader) continue;
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.key === tag && member.kind === 'block') {
          return BlockView.from(readNode(reader, member));
        }
      }
    }
    return undefined;
  }

  /** Parse a single province's complete block, unresolved and verbatim. */
  provinceDetail(id        )                        {
    const ref = this.section('provinces');
    const reader = ref ? this.#bodyReader(ref) : undefined;
    if (!reader) return undefined;
    const wanted = new Set([String(id), String(-id)]);
    for (;;) {
      const member = reader.nextMember();
      if (!member) break;
      if (member.key !== null && wanted.has(member.key) && member.kind === 'block') {
        return BlockView.from(readNode(reader, member));
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- dump ----

  /**
   * Describe the immediate members of a section (or of one entry inside it).
   * Used by `cli.ts dump` and for exploring unfamiliar saves.
   */
  describe(
    key        ,
    entryKey         ,
    limit = 200,
  )                                                            {
    const ref = this.section(key);
    if (!ref) return [];
    let reader = this.#bodyReader(ref) ?? new ClausewitzReader(this.gamestate, ref.start, ref.end);
    if (entryKey !== undefined) {
      let found                              ;
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.key === entryKey && member.kind === 'block') {
          found = reader.enter(member);
          break;
        }
      }
      if (!found) return [];
      reader = found;
    }
    const out                                                            = [];
    for (let i = 0; i < limit; i += 1) {
      const member = reader.nextMember();
      if (!member) break;
      out.push({
        key: member.key,
        kind: member.kind,
        size: member.valueEnd - member.valueStart,
      });
    }
    return out;
  }

  // ------------------------------------------------------------ snapshot ----

  /** Build the full extracted snapshot used by the API and the UI. */
  snapshot(options                 = {})               {
    const startedAt = performance.now();
    const provinces = this.provinces();
    const countries = this.countries(options);
    const meta = this.meta;

    const players                                       = [];
    const playersRef = this.section('players_countries');
    const playersReader = playersRef ? this.#bodyReader(playersRef) : undefined;
    if (playersReader) {
      const reader = playersReader;
      const values           = [];
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.kind !== 'string') continue;
        values.push(reader.stringValue(member));
      }
      for (let i = 0; i + 1 < values.length; i += 2) {
        players.push({ name: values[i]          , tag: values[i + 1]           });
      }
    }

    const sections                          = {};
    const wanted =
      options.sections === 'all'
        ? this.sections
            .filter(
              (s) =>
                s.key !== 'countries' &&
                s.key !== 'provinces' &&
                s.size <= (options.maxSectionBytes ?? 2 * 1024 * 1024),
            )
            .map((s) => s.key)
        : (options.sections ?? DEFAULT_SNAPSHOT_SECTIONS);

    for (const key of new Set(wanted)) {
      if (key === 'countries' || key === 'provinces') continue;
      const refs = this.allSections(key);
      if (refs.length === 0) continue;
      if (refs.length === 1) {
        sections[key] = plainSection(this.#readRef(refs[0]              ));
      } else {
        sections[key] = refs.map((ref) => plainSection(this.#readRef(ref)));
      }
    }

    let owned = 0;
    for (const province of provinces.values()) {
      if (province.owner && province.owner !== '---') owned += 1;
    }

    return {
      source: this.source,
      meta,
      startDate: this.section('start_date')
        ? scalarOf(this.readSection('start_date'))
        : undefined,
      currentAge: this.section('current_age')
        ? scalarOf(this.readSection('current_age'))
        : undefined,
      gamestateChecksum: this.section('checksum')
        ? scalarOf(this.readSection('checksum'))
        : undefined,
      players,
      provinces: Object.fromEntries(provinces),
      countries: Object.fromEntries(countries),
      sections,
      stats: {
        provinceCount: provinces.size,
        ownedProvinceCount: owned,
        countryCount: countries.size,
      },
      warnings: [...this.warnings],
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }
}

// ---------------------------------------------------------------- helpers ----

/** Scan the top level of the gamestate without materialising anything. */
function indexTopLevel(buf            )               {
  const out               = [];
  const reader = new ClausewitzReader(buf, 0, buf.length);
  let order = 0;
  for (;;) {
    const member = reader.nextMember();
    if (!member) break;
    if (member.key === null) {
      // Leading `EU4txt` marker token; nothing to record.
      continue;
    }
    out.push({
      key: member.key,
      kind: member.kind,
      start: member.valueStart,
      end: member.valueEnd,
      size: member.valueEnd - member.valueStart,
      order: order++,
    });
  }
  return out;
}

/** Read a block whose members are all bare scalars, as raw text. */
function readBareList(reader                  , member                                  )           {
  const inner = reader.enter(member);
  const out           = [];
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.kind === 'string') out.push(inner.stringValue(item));
    else if (item.kind === 'scalar') out.push(inner.rawValue(item));
  }
  return out;
}

/**
 * Map a `gamestate/provinces` key to a province id.
 *
 * EU4 1.37 writes these keys *negated*: key `-1` holds province 1 (Stockholm),
 * `-4941` holds province 4941. Older saves used positive keys, so the magnitude
 * is the id in both cases.
 */
function provinceIdFromKey(key        )                     {
  const raw = Number(key);
  if (!Number.isInteger(raw)) return undefined;
  return Math.abs(raw);
}

const PROVINCE_FIELDS                                                 = {
  name: 'name',
  owner: 'owner',
  controller: 'controller',
  previous_controller: 'previousController',
  territorial_core: 'territorialCore',
  capital: 'capital',
  culture: 'culture',
  original_culture: 'originalCulture',
  native_culture: 'nativeCulture',
  religion: 'religion',
  original_religion: 'originalReligion',
  trade: 'trade',
  trade_goods: 'tradeGoods',
  likely_rebels: 'likelyRebels',
};

const PROVINCE_NUMBERS                                                 = {
  base_tax: 'baseTax',
  base_production: 'baseProduction',
  base_manpower: 'baseManpower',
  garrison: 'garrison',
};

function extractProvince(
  reader                  ,
  member                                  ,
  id        ,
)                 {
  const record                 = {
    id,
    cores: [],
    claims: [],
    institutions: [],
    buildings: [],
    buildingBuilders: {},
    greatProjects: [],
    latentTradeGoods: [],
    countryImprove: [],
    extra: {},
  };
  const inner = reader.enter(member);
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    if (item.kind === 'block') {
      // Every one of these used to be dropped on the floor: only `cores` and
      // `institutions` were read, so the detail panels had no buildings, no great
      // projects and no claims to show.
      if (item.key === 'cores') {
        record.cores = readBareList(inner, item);
      } else if (item.key === 'claims') {
        record.claims = readBareList(inner, item);
      } else if (item.key === 'institutions') {
        record.institutions = readBareList(inner, item)
          .map((raw) => toNumber(raw))
          .filter((n)              => n !== undefined);
      } else if (item.key === 'buildings') {
        record.buildings = readFlagKeys(inner, item);
      } else if (item.key === 'building_builders') {
        record.buildingBuilders = readKeyValues(inner, item);
      } else if (item.key === 'great_projects') {
        record.greatProjects = readBareList(inner, item);
      } else if (item.key === 'latent_trade_goods') {
        record.latentTradeGoods = readBareList(inner, item);
      } else if (item.key === 'country_improve_count') {
        record.countryImprove = readImproveCounts(inner, item);
      }
      continue;
    }
    const value =
      item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item);
    if (item.key === 'is_city') {
      record.isCity = toBoolean(value);
      continue;
    }
    // Two scalars the detail panels show are first-class fields now, not leftovers.
    if (item.key === 'devastation') {
      record.devastation = toNumber(value);
      continue;
    }
    if (item.key === 'active_trade_company') {
      record.activeTradeCompany = toBoolean(value);
      continue;
    }
    const textField = PROVINCE_FIELDS[item.key];
    if (textField) {
      (record                                      )[textField] = value;
      continue;
    }
    const numericField = PROVINCE_NUMBERS[item.key];
    if (numericField) {
      (record                                      )[numericField] = toNumber(value);
      continue;
    }
    record.extra[item.key] = value;
  }
  return record;
}

/** Keys of a `{ key=yes … }` block whose value is `yes`, in file order. */
function readFlagKeys(
  reader                  ,
  member                                  ,
)           {
  const inner = reader.enter(member);
  const out           = [];
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    const value = item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item);
    if (toBoolean(value)) out.push(item.key);
  }
  return out;
}

/**
 * A `{ key=value … }` block as a plain map.
 *
 * `building_builders` is the only user so far: `{ marketplace=SWE workshop=RUS }`,
 * i.e. which country paid for each building.
 */
function readKeyValues(
  reader                  ,
  member                                  ,
)                         {
  const inner = reader.enter(member);
  const out                         = {};
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    const value = item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item);
    if (value) out[item.key] = value;
  }
  return out;
}

/**
 * `country_improve_count`: a **repeating sequence** of `tag=`/`val=` pairs, e.g.
 * `{ tag="SWE" val=5 tag="RUS" val=2 }`, so a province can list several investors.
 * A nested `{ tag=… val=… }` form is tolerated too.
 */
function readImproveCounts(
  reader                  ,
  member                                  ,
)                                        {
  const inner = reader.enter(member);
  const out                                        = [];
  let tag                    ;
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null && item.kind !== 'block') continue;
    if (item.kind === 'block') {
      const nested = inner.enter(item);
      let nestedTag                    ;
      let nestedCount = 0;
      for (;;) {
        const x = nested.nextMember();
        if (!x) break;
        if (x.key === null) continue;
        const value = x.kind === 'string' ? nested.stringValue(x) : nested.rawValue(x);
        if (x.key === 'tag') nestedTag = value;
        else if (x.key === 'val') nestedCount = toNumber(value) ?? 0;
      }
      if (nestedTag !== undefined) out.push({ tag: nestedTag, count: nestedCount });
      continue;
    }
    if (item.key === null) continue;
    const value = item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item);
    if (item.key === 'tag') tag = value;
    else if (item.key === 'val') {
      out.push({ tag: tag ?? '', count: toNumber(value) ?? 0 });
      tag = undefined;
    }
  }
  return out;
}

/** Add `value` under `key`, widening to an array when the key repeats. */
function pushInto   (
  target                         ,
  key        ,
  value   ,
)       {
  const existing = target[key];
  if (existing === undefined) {
    target[key] = value;
  } else if (Array.isArray(existing)) {
    (existing       ).push(value);
  } else {
    target[key] = [existing     , value];
  }
}

/** Read a country scalar, taking the first value if the key repeated. */
function countryScalar(country               , key        )                     {
  const value = country.scalars[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Read every occurrence of a country scalar. */
function countryScalarList(country               , key        )           {
  const value = country.scalars[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

/** Read a flattened country sub-block, taking the first if it repeated. */
function countryGroup(
  country               ,
  key        ,
)                                     {
  const value = country.groups[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function extractCountry(
  reader                  ,
  member                                  ,
  tag        ,
  maxGroupBytes        ,
)                {
  const scalars                                    = {};
  const lists                           = {};
  const groups                                                                         = {};
  const blocks                                                = {};

  const inner = reader.enter(member);
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    if (item.kind !== 'block') {
      pushInto(
        scalars,
        item.key,
        item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item),
      );
      continue;
    }
    const bytes = item.valueEnd - item.valueStart;
    if (bytes <= maxGroupBytes) {
      const asList = tryReadBareScalarList(inner, item);
      if (asList) {
        lists[item.key] = asList;
        continue;
      }
      const flattened = tryFlatten(inner, item);
      if (flattened) {
        pushInto(groups, item.key, flattened);
        continue;
      }
    }
    pushInto(blocks, item.key, summariseBlock(inner, item));
  }

  return { tag, scalars, lists, groups, blocks };
}

/**
 * Read a block whose members are all unkeyed scalars, e.g. `institutions={ 0 0 0 }`.
 * Returns `undefined` when the block is keyed or nested, so the caller can try
 * another shape.
 */
function tryReadBareScalarList(
  reader                  ,
  member                                  ,
)                       {
  const inner = reader.enter(member);
  const out           = [];
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key !== null || item.kind === 'block') return undefined;
    out.push(item.kind === 'string' ? inner.stringValue(item) : inner.rawValue(item));
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Flatten a block whose members are all scalars, strings, or bare scalar lists.
 *
 * The list case matters: `colors={ color={ 128 34 64 } map_color={ … } }` has
 * members whose values are list blocks, and those are joined with spaces so the
 * caller can read `map_color` as `"128 34 64"`. Returns `undefined` as soon as a
 * member is neither, so genuinely nested data is left for `blocks`.
 */
function tryFlatten(
  reader                  ,
  member                                  ,
)                                     {
  const inner = reader.enter(member);
  const out                         = {};
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) return undefined;
    if (item.kind === 'string') {
      out[item.key] = inner.stringValue(item);
      continue;
    }
    if (item.kind === 'scalar') {
      out[item.key] = inner.rawValue(item);
      continue;
    }
    const list = tryReadBareScalarList(inner, item);
    if (list === undefined) return undefined;
    out[item.key] = list.join(' ');
  }
  return out;
}

function summariseBlock(
  reader                  ,
  member                                  ,
)               {
  const inner = reader.enter(member);
  const keys           = [];
  let members = 0;
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    members += 1;
    if (item.key !== null && keys.length < 64 && !keys.includes(item.key)) {
      keys.push(item.key);
    }
  }
  return { members, bytes: member.valueEnd - member.valueStart, keys };
}

function scalarOf(node                    )                     {
  if (!node) return undefined;
  if (node.type === 'scalar' || node.type === 'string') return node.value;
  return undefined;
}

function plainSection(node        )          {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return plainify(node);
}

function plainify(node        )          {
  switch (node.type) {
    case 'scalar': {
      const n = toNumber(node.value);
      if (node.value === 'yes') return true;
      if (node.value === 'no') return false;
      return n ?? node.value;
    }
    case 'string':
      return node.value;
    case 'list':
      return node.items.map(plainify);
    case 'block': {
      const out                          = {};
      for (const entry of node.entries) {
        const value = plainify(entry.value);
        const existing = out[entry.key];
        if (existing === undefined) out[entry.key] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else out[entry.key] = [existing, value];
      }
      return out;
    }
  }
}

/**
 * Parse the `meta` member into typed data.
 *
 * `meta` is not wrapped in braces — it is a flat run of members that begins with
 * the literal token `EU4txt`, e.g.
 *
 *   EU4txt
 *   date=1574.11.12
 *   savegame_version={ first=1 second=37 ... }
 */
function parseMeta(bytes            , warnings           = [])           {
  const reader = new ClausewitzReader(bytes, 0, bytes.length);
  const entries            = [];
  for (;;) {
    const member = reader.nextMember();
    if (!member) break;
    if (member.key === null) continue; // the leading `EU4txt` token
    entries.push({ key: member.key, value: readNode(reader, member) });
  }
  const view = new BlockView({ type: 'block', entries });

  const versionView = view.block('savegame_version');
  const version              = {
    first: versionView?.number('first') ?? 0,
    second: versionView?.number('second') ?? 0,
    third: versionView?.number('third') ?? 0,
    forth: versionView?.number('forth') ?? 0,
    name: versionView?.string('name'),
    text: '',
  };
  version.text = [
    version.first,
    version.second,
    version.third,
    version.forth,
  ].join('.');

  const mods            = [];
  const modsNode = view.first('mods_enabled_names');
  if (modsNode && modsNode.type === 'list') {
    for (const item of modsNode.items) {
      const entry = BlockView.from(item);
      if (!entry) continue;
      const filename = entry.string('filename');
      if (filename === undefined) continue;
      mods.push({ filename, name: entry.string('name') ?? filename });
    }
  } else if (modsNode?.type === 'block') {
    // `mods_enabled_names` is a bare list, but tolerate a keyed spelling.
    const entry = BlockView.from(modsNode);
    const filename = entry?.string('filename');
    if (filename !== undefined) mods.push({ filename, name: entry?.string('name') ?? filename });
  }

  const campaignStats                 = [];
  const statsNode = view.first('campaign_stats');
  const statsItems = statsNode?.type === 'list' ? statsNode.items : [];
  for (const item of statsItems) {
    const entry = BlockView.from(item);
    if (!entry) continue;
    campaignStats.push({
      id: entry.number('id'),
      comparison: entry.number('comparison'),
      key: entry.string('key'),
      selector: entry.string('selector'),
      localization: entry.string('localization'),
      value: entry.number('value'),
      sampleValue: entry.number('sample_value'),
      sampleCount: entry.number('sample_count'),
    });
  }

  return {
    date: view.scalar('date') ?? '',
    saveGame: view.string('save_game'),
    player: view.string('player'),
    displayedCountryName: view.string('displayed_country_name'),
    version,
    versions: view.stringList('savegame_versions'),
    dlc: view.stringList('dlc_enabled'),
    mods,
    multiPlayer: view.bool('multi_player') ?? false,
    notObserver: view.bool('not_observer') ?? false,
    campaignId: view.string('campaign_id'),
    campaignLength: view.number('campaign_length'),
    checksum: view.string('checksum'),
    campaignStats,
  };
}

//# sourceURL=document.ts

// ---- timeline.ts ----
/**
 * Province history replay — the basis for a map timeline.
 *
 * A single save is **not** limited to the present state. Every province carries a
 * `history` block that is a dated event log from the campaign's start date to the
 * current date, e.g. Stockholm in the sample save:
 *
 *   history={
 *       owner="SWE"                 # undated keys = state when the campaign began
 *       controller={ tag="SWE" }
 *       religion="catholic"
 *       base_tax="5.000"
 *       1436.4.28={ revolt={ … } controller={ tag="REB" } }
 *       1523.3.30={ controller={ tag="MOS" } }
 *       1523.3.30={ controller={ tag="RUS" } }
 *       1525.6.4={ owner="MOS" fake_owner="RUS" add_core="RUS" }
 *       1532.5.22={ religion="protestant" }
 *   }
 *
 * In the sample save 3,924 provinces carry such a log with 147,337 dated entries
 * between them, covering `owner`, `controller` (wartime occupation), `religion`,
 * `culture`, `base_tax`/`base_production`/`base_manpower`, buildings, cores and
 * claims. Replaying it yields the whole territorial timeline from one file.
 *
 * Replay is a forward sweep, not a per-frame re-scan: `TimelinePlayer` keeps a
 * cursor into the globally date-sorted event list and applies each event once, so
 * producing 100 map frames costs the same as producing one.
 */


const DATE_KEY = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/;

/** One field change: `owner=MOS`, `controller={tag=REB …}`. */
                                 
                
                                                                     
                
                                                                          
                                  
 

                                       
                                                      
               
                                             
                  
                     
                            
 

                                  
             
                                                                            
                            
                                 
 

                               
                                          
                                                                                   
                                 
                                                    
                    
                  
                                                                        
                   
                                                                            
                         
 

                                
                               
                     
                      
                    
                  
 

/**
 * Read the history of the province whose block starts at `member`.
 * `reader` must be positioned inside the `provinces` block.
 */
function readProvinceHistory(
  reader                  ,
  member        ,
  provinceId        ,
)                  {
  const history                  = { id: provinceId, initial: [], events: [] };
  const province = reader.enter(member);
  for (;;) {
    const item = province.nextMember();
    if (!item) break;
    if (item.key !== 'history' || item.kind !== 'block') continue;

    const block = province.enter(item);
    for (;;) {
      const entry = block.nextMember();
      if (!entry) break;
      if (entry.key === null) continue;
      const match = DATE_KEY.exec(entry.key);
      if (!match) {
        // Undated key -> part of the initial state.
        const change = readChange(block, entry);
        if (change) history.initial.push(change);
        continue;
      }
      const date = entry.key;
      const ordinal =
        Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]);
      const changes                   = [];
      if (entry.kind === 'block') {
        const body = block.enter(entry);
        for (;;) {
          const field = body.nextMember();
          if (!field) break;
          const change = readChange(body, field);
          if (change) changes.push(change);
        }
      }
      history.events.push({ date, ordinal, provinceId, changes });
    }
  }
  return history;
}

/** Turn one member into a change, flattening structured values to their `tag`. */
function readChange(reader                  , member        )                             {
  const field = member.key;
  if (field === null) return undefined;

  if (member.kind === 'scalar') {
    return { field, value: reader.rawValue(member) };
  }
  if (member.kind === 'string') {
    return { field, value: reader.stringValue(member) };
  }

  const detail                         = {};
  const inner = reader.enter(member);
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    detail[item.key] =
      item.kind === 'string'
        ? inner.stringValue(item)
        : item.kind === 'scalar'
          ? inner.rawValue(item)
          : '';
  }
  // `controller={ tag=REB rebel=… }` — the tag is the value callers care about.
  const value = detail['tag'] ?? detail['type'] ?? Object.values(detail)[0] ?? '';
  return { field, value, detail };
}

/** Build the replayed timeline for a save. */
function buildTimeline(doc              )               {
  const provinces = new Map                         ();
  const allEvents                         = [];
  const fieldCounts = new Map                ();

  const ref = doc.section('provinces');
  const reader = ref
    ? new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1)
    : undefined;

  if (reader) {
    for (;;) {
      const member = reader.nextMember();
      if (!member) break;
      if (member.kind !== 'block' || member.key === null) continue;
      const raw = Number(member.key);
      if (!Number.isInteger(raw)) continue;
      const id = Math.abs(raw);
      const history = readProvinceHistory(reader, member, id);
      if (history.initial.length === 0 && history.events.length === 0) continue;
      provinces.set(id, history);
      for (const event of history.events) {
        allEvents.push(event);
        for (const change of event.changes) {
          fieldCounts.set(change.field, (fieldCounts.get(change.field) ?? 0) + 1);
        }
      }
    }
  }

  // Stable sort keeps same-date entries in the order the game wrote them, which
  // matters: `1523.3.30 controller=MOS` then `controller=RUS` must stay ordered.
  allEvents.sort((a, b) => a.ordinal - b.ordinal);

  const fields = [...fieldCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([field]) => field);

  const campaignStart = doc.section('start_date')
    ? scalarOfSection(doc, 'start_date')
    : undefined;

  return {
    provinces,
    events: allEvents,
    startDate:
      campaignStart ??
      (allEvents[0]?.date ?? ''),
    endDate: allEvents[allEvents.length - 1]?.date ?? '',
    fields,
    campaignStart,
  };
}

function scalarOfSection(doc              , key        )                     {
  const node = doc.readSection(key);
  if (!node) return undefined;
  if (node.type === 'scalar' || node.type === 'string') return node.value;
  return undefined;
}

function timelineStats(timeline              )                {
  let changes = 0;
  for (const event of timeline.events) changes += event.changes.length;
  return {
    provincesWithHistory: timeline.provinces.size,
    eventCount: timeline.events.length,
    changeCount: changes,
    startDate: timeline.startDate,
    endDate: timeline.endDate,
  };
}

/**
 * Forward-only replay cursor.
 *
 * ```ts
 * const player = new TimelinePlayer(timeline, ['owner', 'religion', 'culture']);
 * for (const frame of frameDates) {
 *   player.advanceTo(frame.ordinal);
 *   player.valueOf('owner', 1); // -> current owner of province 1
 * }
 * ```
 */
class TimelinePlayer {
           #timeline              ;
           #fields                   ;
  /** field -> province id -> current value. */
           #state = new Map                  ();
  #cursor = 0;

  constructor(timeline              , fields                   ) {
    this.#timeline = timeline;
    this.#fields = fields;
    for (const field of fields) this.#state.set(field, []);
    this.reset();
  }

  /** The date the cursor currently sits on (the last applied event, if any). */
  get lastAppliedDate()                     {
    return this.#timeline.events[this.#cursor - 1]?.date;
  }

  get appliedEvents()         {
    return this.#cursor;
  }

  /** Rewind to the campaign's starting state. */
  reset()       {
    this.#cursor = 0;
    for (const field of this.#fields) {
      const column = this.#state.get(field)            ;
      column.length = 0;
    }
    for (const history of this.#timeline.provinces.values()) {
      for (const change of history.initial) {
        if (!this.#fields.includes(change.field)) continue;
        (this.#state.get(change.field)            )[history.id] = change.value;
      }
    }
  }

  /** Apply every event up to and including `ordinal`. */
  advanceTo(ordinal        )       {
    const events = this.#timeline.events;
    while (this.#cursor < events.length) {
      const event = events[this.#cursor]                        ;
      if (event.ordinal > ordinal) break;
      this.apply(event);
      this.#cursor += 1;
    }
  }

  apply(event                      )       {
    for (const change of event.changes) {
      const column = this.#state.get(change.field);
      if (column) column[event.provinceId] = change.value;
    }
  }

  valueOf(field        , provinceId        )                     {
    return this.#state.get(field)?.[provinceId];
  }

  /** Full tracked state of one province: initial values plus every event ≤ date. */
  stateOf(provinceId        , ordinal        )                         {
    const history = this.#timeline.provinces.get(provinceId);
    const out                         = {};
    if (!history) return out;
    for (const change of history.initial) {
      if (this.#fields.includes(change.field)) out[change.field] = change.value;
    }
    for (const event of history.events) {
      if (event.ordinal > ordinal) break;
      for (const change of event.changes) {
        if (this.#fields.includes(change.field)) out[change.field] = change.value;
      }
    }
    return out;
  }

  /** Every event that touched one province, optionally within a date range. */
  eventsFor(provinceId        )                                  {
    return this.#timeline.provinces.get(provinceId)?.events ?? [];
  }
}

/** Every province that ever had a given value for a field, in the whole timeline. */
function provincesEverMatching(
  timeline              ,
  field        ,
  value        ,
)           {
  const out           = [];
  for (const history of timeline.provinces.values()) {
    for (const change of history.initial) {
      if (change.field === field && change.value === value) {
        out.push(history.id);
        break;
      }
    }
    for (const event of history.events) {
      if (event.changes.some((c) => c.field === field && c.value === value)) {
        out.push(history.id);
        break;
      }
    }
  }
  return out;
}

/** Build a list of evenly spaced frame dates between two dates (inclusive). */
function frameDates(
  from        ,
  to        ,
  stepYears        ,
)                                                               {
  const start = parseGameDate(from);
  const end = parseGameDate(to);
  const out                                                               = [];
  if (!start || !end) return out;
  for (let year = start.year; year <= end.year; year += stepYears) {
    const month = year === start.year ? start.month : 1;
    const day = year === start.year ? start.day : 1;
    const ordinal = year * 372 + month * 31 + day;
    out.push({
      date: `${year}.${month}.${day}`,
      ordinal,
      gameDate: { year, month, day, ordinal },
    });
  }
  const endOrdinal = end.year * 372 + end.month * 31 + end.day;
  const last = out[out.length - 1];
  if (last && last.ordinal < endOrdinal) {
    out.push({ date: end.year + '.' + end.month + '.' + end.day, ordinal: endOrdinal, gameDate: end });
  }
  return out;
}

// --------------------------------------------------------------- tag changes --

/**
 * A country renaming itself, e.g. Muscovy -> Russia.
 *
 * Province histories record the tag that held the province *at the time*, so
 * Stockholm's log says `owner=MOS` from 1525 and never mentions RUS. The game
 * writes the switch into the successor's own country history instead:
 *
 *   countries/RUS/history = { 1529.2.5 = { changed_tag_from="MOS" … } }
 *
 * Without following that alias a replayed map shows Muscovy holding 380
 * provinces in 1574.
 */
                           
               
                  
                                      
               
                                   
             
 

/** Scan every country's history for `changed_tag_from` entries. */
function buildTagAliases(doc              )             {
  const aliases             = [];
  const ref = doc.section('countries');
  if (!ref) return aliases;
  const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);

  for (;;) {
    const country = reader.nextMember();
    if (!country) break;
    if (country.kind !== 'block' || country.key === null) continue;
    const tag = country.key;
    const body = reader.enter(country);
    for (;;) {
      const item = body.nextMember();
      if (!item) break;
      if (item.key !== 'history' || item.kind !== 'block') continue;
      const history = body.enter(item);
      for (;;) {
        const entry = history.nextMember();
        if (!entry) break;
        if (entry.key === null || entry.kind !== 'block') continue;
        const match = DATE_KEY.exec(entry.key);
        if (!match) continue;
        const event = history.enter(entry);
        for (;;) {
          const field = event.nextMember();
          if (!field) break;
          if (field.key !== 'changed_tag_from') continue;
          const from =
            field.kind === 'string' ? event.stringValue(field) : event.rawValue(field);
          if (!from) continue;
          aliases.push({
            date: entry.key,
            ordinal:
              Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]),
            from,
            to: tag,
          });
        }
      }
    }
  }

  aliases.sort((a, b) => a.ordinal - b.ordinal);
  return aliases;
}

/** Follow tag changes that had already happened by `ordinal`. */
function resolveTag(
  aliases                     ,
  tag        ,
  ordinal        ,
)         {
  let current = tag;
  // A handful of renames per campaign at most; the guard only stops bad data.
  for (let guard = 0; guard < 32; guard += 1) {
    const alias = aliases.find((a) => a.from === current && a.ordinal <= ordinal);
    if (!alias) return current;
    current = alias.to;
  }
  return current;
}

/** Map every tag that appears in a state array to its resolved successor. */
function resolveTagSet(
  aliases                     ,
  tags                  ,
  ordinal        ,
)                      {
  const out = new Map                ();
  for (const tag of tags) {
    if (!out.has(tag)) out.set(tag, resolveTag(aliases, tag, ordinal));
  }
  return out;
}

/**
 * Follow tag changes ignoring *when* they happened.
 *
 * Country attributes (state religion, primary culture, …) are carried over to the
 * successor: Muscovy's whole history ends up stored under RUS. So when a province
 * was owned by MOS in 1500, its owner's religion must be looked up on RUS.
 */
function resolveTagLatest(aliases                     , tag        )         {
  let current = tag;
  for (let guard = 0; guard < 32; guard += 1) {
    const alias = aliases.find((a) => a.from === current);
    if (!alias) return current;
    current = alias.to;
  }
  return current;
}

// ------------------------------------------------- country-level timelines ----

                                      
               
                  
              
                            
 

                                 
              
                                                                                  
                            
                                
 

                                  
                                         
                                                       
                                
                   
 

/**
 * Read the dated history of every country.
 *
 * Same shape as the province log (`countries/{TAG}/history`), which is where a
 * country's own `religion`, `primary_culture`, `capital` and government changes
 * are recorded. The religion view needs this: a province's fill is its own
 * religion, and the hatching is the *owner's* state religion at that date.
 */
function buildCountryTimeline(doc              )                  {
  const countries = new Map                        ();
  const allEvents                        = [];
  const fieldCounts = new Map                ();

  const ref = doc.section('countries');
  const reader = ref
    ? new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1)
    : undefined;

  if (reader) {
    for (;;) {
      const member = reader.nextMember();
      if (!member) break;
      if (member.kind !== 'block' || member.key === null) continue;
      const tag = member.key;
      const history                 = { tag, initial: [], events: [] };
      const body = reader.enter(member);
      for (;;) {
        const item = body.nextMember();
        if (!item) break;
        if (item.key !== 'history' || item.kind !== 'block') continue;
        const block = body.enter(item);
        for (;;) {
          const entry = block.nextMember();
          if (!entry) break;
          if (entry.key === null) continue;
          const match = DATE_KEY.exec(entry.key);
          if (!match) {
            const change = readChange(block, entry);
            if (change) history.initial.push(change);
            continue;
          }
          const changes                   = [];
          if (entry.kind === 'block') {
            const eventBody = block.enter(entry);
            for (;;) {
              const field = eventBody.nextMember();
              if (!field) break;
              const change = readChange(eventBody, field);
              if (change) changes.push(change);
            }
          }
          history.events.push({
            date: entry.key,
            ordinal:
              Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]),
            tag,
            changes,
          });
        }
      }
      if (history.initial.length === 0 && history.events.length === 0) continue;
      countries.set(tag, history);
      for (const event of history.events) {
        allEvents.push(event);
        for (const change of event.changes) {
          fieldCounts.set(change.field, (fieldCounts.get(change.field) ?? 0) + 1);
        }
      }
    }
  }

  allEvents.sort((a, b) => a.ordinal - b.ordinal);
  return {
    countries,
    events: allEvents,
    fields: [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f),
  };
}

/** Forward-only replay cursor for country-level attributes, keyed by tag. */
class CountryTimelinePlayer {
           #timeline                 ;
           #fields                   ;
           #state = new Map                             ();
  #cursor = 0;

  constructor(timeline                 , fields                   ) {
    this.#timeline = timeline;
    this.#fields = fields;
    for (const field of fields) this.#state.set(field, new Map());
    this.reset();
  }

  reset()       {
    this.#cursor = 0;
    for (const field of this.#fields) (this.#state.get(field)                       ).clear();
    for (const history of this.#timeline.countries.values()) {
      for (const change of history.initial) {
        if (!this.#fields.includes(change.field)) continue;
        (this.#state.get(change.field)                       ).set(history.tag, change.value);
      }
    }
  }

  advanceTo(ordinal        )       {
    const events = this.#timeline.events;
    while (this.#cursor < events.length) {
      const event = events[this.#cursor]                       ;
      if (event.ordinal > ordinal) break;
      for (const change of event.changes) {
        const column = this.#state.get(change.field);
        if (column) column.set(event.tag, change.value);
      }
      this.#cursor += 1;
    }
  }

  valueOf(field        , tag        )                     {
    return this.#state.get(field)?.get(tag);
  }

  /** All dated entries for one country, in order. */
  eventsFor(tag        )                                 {
    return this.#timeline.countries.get(tag)?.events ?? [];
  }
}

/**
 * Frame dates stepping one **month** at a time — the finest granularity a save
 * actually records, and what the map player scrubs through.
 *
 * The first frame is the campaign's exact start date; every later frame is the
 * 1st of a month so labels stay readable.
 */
function frameMonths(
  from        ,
  to        ,
)                                                                        {
  const start = parseGameDate(from);
  const end = parseGameDate(to);
  if (!start || !end) return [];
  const endOrdinal = end.year * 372 + end.month * 31 + end.day;
  const out = [
    { date: from, ordinal: start.ordinal, year: start.year, month: start.month },
  ];
  let year = start.year;
  let month = start.month;
  for (;;) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    const ordinal = year * 372 + month * 31 + 1;
    if (ordinal > endOrdinal) break;
    out.push({ date: `${year}.${month}.1`, ordinal, year, month });
  }
  // Land exactly on the save's date: the last day of the month can still carry
  // events (EU4 stamps the current state), and the final frame must show the
  // present, not the 1st of the month.
  const last = out[out.length - 1];
  if (last && last.ordinal < endOrdinal) {
    out.push({ date: to, ordinal: endOrdinal, year: end.year, month: end.month });
  }
  return out;
}

/** Decode an ordinal produced by the helpers above back into `Y.M.D`. */
function ordinalToDate(ordinal        )         {
  const year = Math.floor(ordinal / 372);
  const rest = ordinal - year * 372;
  const month = Math.floor(rest / 31);
  const day = rest - month * 31;
  return `${year}.${month}.${day}`;
}


//# sourceURL=timeline.ts

// ---- subjects.ts ----
/**
 * Who was whose subject, and since when.
 *
 * The save keeps a `diplomacy/dependency` ledger: one entry per relation that still
 * exists, each carrying the overlord (`first`), the subject (`second`), the date it
 * began (`start_date`) and its `subject_type`. Three consequences matter for the
 * colour modes:
 *
 *   1. The date a subjection began **is** recorded, so a recoloured subject can start
 *      exactly then instead of from the campaign start.
 *   2. A relation that already ended is **not** recorded anywhere — there is no
 *      "became independent on X" to be found. That is fine in practice: the mod hands
 *      a country its own colour back when the relation ends, so a country that is
 *      independent now already carries its own colour in the save.
 *   3. A dependency is not automatically a subjection. The user's rule, and what the
 *      recolouring mod actually did in the sample save, is that 朝贡国 (tributaries)
 *      do **not** count. Trade leagues and alliances are not dependencies at all —
 *      they live in their own diplomacy blocks — so they are excluded by construction.
 */


/**
 * Dependency types that are **not** subjection.
 *
 * 朝贡国 pay tribute and keep their own colour, so the user's colour modes must not
 * treat them as subjects. The sample saves carry `tributary_state` and also the
 * religious ones (`nahuatl_tributary`, and by the same pattern `mayan_tributary` /
 * `inti_tributary`), which is why the check is on the name rather than one exact
 * string. Trade leagues are not dependencies at all — they live in their own
 * diplomacy block — so they are excluded by construction.
 */
const NON_SUBJECT_TYPES = new Set(['tributary_state', 'trade_league']);

/** Whether a `subject_type` counts as 属国. */
function isSubjectType(type                    )          {
  if (!type) return false;
  const lower = type.toLowerCase();
  if (NON_SUBJECT_TYPES.has(lower)) return false;
  return !lower.includes('tributary');
}

                                
                                                                                             
                                          
                                                                   
                             
                                                           
                              
 

/**
 * Read the dependency ledger.
 *
 * @param doc a parsed save
 */
function readSubjectLedger(doc              )                {
  const relations = new Map                         ();
  const types = new Map                ();
  const excluded                    = [];

  const diplomacy = doc.readSectionView('diplomacy');
  for (const node of diplomacy?.all('dependency') ?? []) {
    const view = BlockView.from(node);
    if (!view) continue;
    const overlord = view.string('first');
    const subject = view.string('second');
    if (!overlord || !subject) continue;
    const type = view.string('subject_type') ?? '';
    const date = view.string('start_date');
    const ordinal = date === undefined ? undefined : parseGameDate(date)?.ordinal;
    types.set(type, (types.get(type) ?? 0) + 1);
    const relation                  = { overlord, subject, type, date, ordinal };
    if (!isSubjectType(type)) {
      excluded.push(relation);
      continue;
    }
    relations.set(subject, relation);
  }

  return { relations, types, excluded };
}


//# sourceURL=subjects.ts

// ---- wars.ts ----
/**
 * War, battle and occupation history.
 *
 * Every war the campaign has ever seen is stored in `previous_war` (621 of them in
 * the sample save) and ongoing ones in `active_war`. Each carries a **dated**
 * `history` block that records, in order:
 *
 *   `add_attacker` / `add_defender` / `rem_attacker` / `rem_defender`  who joined or left
 *   `battle`                                                          a land or naval battle
 *   `take_province` / `take_capital`                                  peace-deal terms
 *
 * and a `battle` entry is itself a full report:
 *
 *   '1453.4.13': {
 *       battle: {
 *           name: '苏腊巴亚'
 *           location: '628'
 *           result: 'no'                       # 'yes' -> the attacker won
 *           attacker: { cavalry: 1964, infantry: 6871, losses: 3718, country: SUN, commander: '…' }
 *           defender: { cavalry: 3000, infantry: 9000, losses: 1519, country: MAJ, commander: '…' }
 *           winner_alliance: 16.000
 *           loser_alliance: 21.000
 *       }
 *   }
 *
 * Combined with a province's `controller` changes in its own history, this gives
 * "who fought whom, when, where, and who was occupying what".
 */


const DATE_KEY__m9 = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/;

/** Non-`take_*` keys that are also peace terms. */
const PEACE_KEYS = new Set([
  'annul_treaties',
  'war_reparations',
  'independence',
  'transfer_trade_power',
  'guarantee',
  'dependency',
  'royal_marriage',
  'alliance',
  'military_access',
  'improve_relation',
  'knowledge_sharing',
  'trade_company',
  'change_religion',
  'release_country',
  'vassalize',
]);

                             
                   
                     
                  
                                                                      
                                
 

                         
               
               
                                               
                    
                                                     
                       
                 
                       
                       
                                   
                          
                         
 

                          
                  
                  
                  
                  
            
                
            

                           
               
                     
                                               
                 
                                                                               
                  
 

                                 
              
                    
                                               
                    
                 
 

                      
               
                   
                            
                            
                      
                      
                                                           
                     
                   
                        
                                                                                    
                    
                     
                                 
     
                                                                             
                                                                    
     
                          
                         
                         
     
                                                                             
                                                                              
                                                                                
                                                             
     
                   
                       
 

                            
               
                    
               
 

function asString(node                    )                     {
  if (!node) return undefined;
  if (node.type === 'string' || node.type === 'scalar') return node.value;
  return undefined;
}

function asStrings(node                    )           {
  if (!node) return [];
  if (node.type === 'string' || node.type === 'scalar') return [node.value];
  if (node.type === 'list') {
    return node.items.map((i) => asString(i) ?? '').filter((s) => s !== '');
  }
  return [];
}

function readEntry(reader                  , member                                  )         {
  return readNode(reader, member);
}

/** Collect the immediate members of a node as a key -> node map (repeats -> array). */
function entriesOf(node                    )                        {
  const map = new Map                  ();
  if (!node || node.type !== 'block') return map;
  for (const entry of node.entries) {
    const list = map.get(entry.key);
    if (list) list.push(entry.value);
    else map.set(entry.key, [entry.value]);
  }
  return map;
}

function parseBattle(date        , node        )                     {
  const map = entriesOf(node);
  const side = (key        )             => {
    const inner = entriesOf(map.get(key)?.[0]);
    const units                         = {};
    for (const [unit, values] of inner) {
      if (unit === 'country' || unit === 'commander' || unit === 'losses') continue;
      const n = toNumber(asString(values[0]));
      if (n !== undefined) units[unit] = n;
    }
    const losses = toNumber(asString(inner.get('losses')?.[0]));
    return {
      country: asString(inner.get('country')?.[0]),
      commander: asString(inner.get('commander')?.[0]),
      ...(losses !== undefined ? { losses } : {}),
      units,
    };
  };
  const attacker = side('attacker');
  const defender = side('defender');
  const naval =
    Object.keys(attacker.units).some((u) => u.includes('ship') || u === 'galley' || u === 'transport') ||
    Object.keys(defender.units).some((u) => u.includes('ship') || u === 'galley' || u === 'transport');
  const location = toNumber(asString(map.get('location')?.[0]));
  const resultRaw = asString(map.get('result')?.[0]) ?? map.get('result')?.[0]?.type;
  return {
    date,
    name: asString(map.get('name')?.[0]) ?? '',
    ...(location !== undefined ? { location } : {}),
    attackerWon: resultRaw === 'yes' || resultRaw === true,
    naval,
    attacker,
    defender,
    winnerAlliance: toNumber(asString(map.get('winner_alliance')?.[0])),
    loserAlliance: toNumber(asString(map.get('loser_alliance')?.[0])),
  };
}

function parseWar(name        , node        , ongoing         )      {
  const map = entriesOf(node);
  const war      = {
    name,
    ongoing,
    attackers: asStrings(map.get('attackers')?.[0]),
    defenders: asStrings(map.get('defenders')?.[0]),
    battles: [],
    events: [],
    participants: [],
    peaceTerms: [],
    isCoalition: toBoolean(asString(map.get('is_coalition')?.[0])) ?? false,
  };

  const original = (key        )                     => asString(map.get(key)?.[0]);
  war.originalAttacker = original('original_attacker');
  war.originalDefender = original('original_defender');
  if (war.attackers.length === 0) war.attackers = asStrings(map.get('persistent_attackers')?.[0]);
  if (war.defenders.length === 0) war.defenders = asStrings(map.get('persistent_defenders')?.[0]);

  const outcome = toNumber(asString(map.get('outcome')?.[0]));
  if (outcome !== undefined) war.outcome = outcome;
  war.attackerScore = toNumber(asString(map.get('attacker_score')?.[0]));
  war.defenderScore = toNumber(asString(map.get('defender_score')?.[0]));

  // Peace terms sit on the war block itself, repeated once per term.
  for (const [key, values] of map) {
    if (!key.startsWith('take_') && !PEACE_KEYS.has(key)) continue;
    for (const value of values) {
      if (value.type !== 'block') {
        war.peaceTerms.push({ kind: key, tag: asString(value) });
        continue;
      }
      const inner = entriesOf(value);
      const province = toNumber(asString(inner.get('province')?.[0]));
      war.peaceTerms.push({
        kind: key,
        ...(province !== undefined ? { province } : {}),
        tag: asString(inner.get('tag')?.[0]),
      });
    }
  }

  const goal = map.get('war_goal')?.[0] ?? map.get('superiority')?.[0];
  if (goal && goal.type === 'block') {
    const g = entriesOf(goal);
    const province = toNumber(asString(g.get('province')?.[0]));
    war.warGoal = {
      type: asString(g.get('type')?.[0]),
      casusBelli: asString(g.get('casus_belli')?.[0]),
      ...(province !== undefined ? { province } : {}),
      tag: asString(g.get('tag')?.[0]),
    };
  }

  // `history` is the dated log; it may also carry the war's own name/war_goal.
  const history = map.get('history')?.[0];
  if (history && history.type === 'block') {
    for (const entry of history.entries) {
      const match = DATE_KEY__m9.exec(entry.key);
      if (!match) continue;
      war.startDate ??= entry.key;
      war.endDate = entry.key;

      const items = entry.value.type === 'list' ? entry.value.items : [entry.value];
      const changes = new Map                  ();
      for (const item of items) {
        if (item.type !== 'block') continue;
        for (const [k, v] of entriesOf(item)) {
          const list = changes.get(k);
          if (list) list.push(...v);
          else changes.set(k, [...v]);
        }
      }

      for (const [key, values] of changes) {
        if (key === 'battle') {
          for (const value of values) {
            const battle = parseBattle(entry.key, value);
            if (battle) war.battles.push(battle);
          }
          war.events.push({ date: entry.key, kind: 'battle', tags: [] });
          continue;
        }
        if (
          key === 'add_attacker' ||
          key === 'add_defender' ||
          key === 'rem_attacker' ||
          key === 'rem_defender'
        ) {
          const tags = values.flatMap((v) => asStrings(v));
          war.events.push({ date: entry.key, kind: key, tags });
          continue;
        }
        if (key.startsWith('take_') || key === 'annul_treaties' || key === 'war_reparations') {
          const inner = entriesOf(values[0]);
          const province = asString(inner.get('province')?.[0]);
          const tag = asString(inner.get('tag')?.[0]);
          war.events.push({
            date: entry.key,
            kind: 'peace_term',
            tags: tag ? [tag] : [],
            detail: `${key}${province ? ` province ${province}` : ''}${tag ? ` tag ${tag}` : ''}`,
          });
        }
      }
    }
  }

  if (war.startDate && war.endDate) {
    const a = DATE_KEY__m9.exec(war.startDate);
    const b = DATE_KEY__m9.exec(war.endDate);
    if (a && b) {
      const toOrdinal = (m                 ) =>
        Number(m[1]) * 372 + Number(m[2]) * 31 + Number(m[3]);
      war.durationDays = toOrdinal(b) - toOrdinal(a);
    }
  }

  // `participants` repeats once per country and is a block (not a list).
  if (node.type === 'block') {
    for (const entry of node.entries) {
      if (entry.key !== 'participants' || entry.value.type !== 'block') continue;
      const p = entriesOf(entry.value);
      const tag = asString(p.get('tag')?.[0]);
      if (!tag) continue;
      const lossesNode = p.get('losses')?.[0];
      const losses =
        lossesNode && lossesNode.type === 'list'
          ? lossesNode.items
              .map((i) => toNumber(asString(i)))
              .filter((n)              => n !== undefined)
          : undefined;
      war.participants.push({
        tag,
        warScore: toNumber(asString(p.get('war_score')?.[0])),
        value: toNumber(asString(p.get('value')?.[0])),
        ...(losses ? { losses } : {}),
      });
    }
  }

  return war;
}

/** Extract every war in the save: finished ones plus those still running. */
function extractWars(doc              )        {
  const wars        = [];

  for (const ref of doc.allSections('previous_war')) {
    const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);
    const member = reader.nextMember();
    if (!member) continue;
    const name =
      member.kind === 'string' ? reader.stringValue(member) : reader.rawValue(member);
    // `previous_war` blocks are either a bare string name followed by fields, or a
    // single block; normalise both into one node.
    const node = readAsWarNode(reader, member);
    if (!node) continue;
    wars.push(parseWar(name, node, false));
  }

  for (const ref of doc.allSections('active_war')) {
    const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);
    const node = readBlockNode(reader);
    if (!node) continue;
    const map = entriesOf(node);
    const name = asString(map.get('name')?.[0]) ?? '(未命名战争)';
    wars.push(parseWar(name, node, true));
  }

  wars.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
  return wars;
}

/** `previous_war` starts with an unkeyed name string, then the fields. */
function readAsWarNode(
  reader                  ,
  first                                  ,
)                     {
  if (first.kind === 'block') return readNode(reader, first);
  const entries                                   = [];
  for (;;) {
    const member = reader.nextMember();
    if (!member) break;
    if (member.key === null) continue;
    entries.push({ key: member.key, value: readEntry(reader, member) });
  }
  return { type: 'block', entries };
}

/** A whole `active_war` section is one block. */
function readBlockNode(reader                  )                     {
  const member = reader.nextMember();
  if (!member) return undefined;
  if (member.kind === 'block') return readNode(reader, member);
  // Fall back to reading the members as a synthetic block.
  const entries                                   = [];
  entries.push({ key: member.key ?? '?', value: readEntry(reader, member) });
  for (;;) {
    const next = reader.nextMember();
    if (!next) break;
    if (next.key === null) continue;
    entries.push({ key: next.key, value: readEntry(reader, next) });
  }
  return { type: 'block', entries };
}

                           
                
                  
                   
                  
                       
                                               
                                     
                                            
                                   
 

function warStats(wars                )           {
  const participation = new Map                ();
  const battleCount = new Map                ();
  let battles = 0;
  let navalBattles = 0;
  let ongoing = 0;
  for (const war of wars) {
    if (war.ongoing) ongoing += 1;
    for (const tag of new Set([...war.attackers, ...war.defenders])) {
      participation.set(tag, (participation.get(tag) ?? 0) + 1);
    }
    for (const battle of war.battles) {
      battles += 1;
      if (battle.naval) navalBattles += 1;
      for (const side of [battle.attacker, battle.defender]) {
        if (!side.country) continue;
        battleCount.set(side.country, (battleCount.get(side.country) ?? 0) + 1);
      }
    }
  }
  return {
    total: wars.length,
    ongoing,
    finished: wars.length - ongoing,
    battles,
    navalBattles,
    participation,
    battleCount,
  };
}


//# sourceURL=wars.ts

// ---- institutions.ts ----
/**
 * Institutions ("思潮").
 *
 * EU4 1.30+ tracks eight institutions, in this fixed order (the slot order comes
 * from `common/institutions/00_Core.txt`):
 *
 *   feudalism · renaissance · colonialism · printing_press ·
 *   global_trade · manufactories · enlightenment · industrialization
 *
 * A province stores an **eight-element array of embracement percentages**, and a
 * country stores eight 0/1 "embraced" flags plus the province each institution
 * arrived from. The array is *ordered*, not independent: a province has embraced
 * the Nth institution only when every slot up to it has reached 100.
 *
 *   [  0,100,100,  0,0,0,0,0]  -> embraced nothing  (slot 0 is still 0)
 *   [100, 26,100,  0,0,0,0,0]  -> embraced 1        (slot 1 = 26 is in progress)
 *   [100,100,100,100, 10,0,0,0]-> embraced 4        (slot 4 = 10 is in progress)
 *
 * A province is *currently embracing* an institution when the first slot after
 * the leading run of 100s holds a value in (0, 100).
 */

/** Canonical slot order, with the names EU4 shows in Chinese. */
const INSTITUTIONS                                                         = [
  { key: 'feudalism', zh: '封建制度', en: 'Feudalism' },
  { key: 'renaissance', zh: '文艺复兴', en: 'Renaissance' },
  { key: 'new_world_i', zh: '殖民主义', en: 'Colonialism' },
  { key: 'printing_press', zh: '印刷术', en: 'Printing Press' },
  { key: 'global_trade', zh: '全球贸易', en: 'Global Trade' },
  { key: 'manufactories', zh: '工场手工业', en: 'Manufactories' },
  { key: 'enlightenment', zh: '启蒙运动', en: 'Enlightenment' },
  { key: 'industrialization', zh: '工业化', en: 'Industrialization' },
];

const INSTITUTION_COUNT = INSTITUTIONS.length;

                                      
                                                                              
                   
     
                                                                              
                                                                       
     
                    
                                                                       
                            
 

/**
 * Interpret one province's eight embracement percentages.
 *
 * Values are treated with a small tolerance so the game's `100.000` parses
 * cleanly, and a slot counts as complete only at (or above) 100.
 */
function readInstitutionProgress(
  institutions                               ,
)                      {
  if (!institutions || institutions.length === 0) {
    return { embraced: 0, embracing: -1, embracingProgress: 0 };
  }
  let embraced = 0;
  while (embraced < institutions.length && (institutions[embraced]          ) >= 100) {
    embraced += 1;
  }
  const next = institutions[embraced];
  if (
    embraced < INSTITUTION_COUNT &&
    next !== undefined &&
    next > 0 &&
    next < 100
  ) {
    return { embraced, embracing: embraced, embracingProgress: next };
  }
  // Nothing in progress: either everything up to the end is done, or the next
  // slot has not started at all.
  return { embraced, embracing: -1, embracingProgress: 0 };
}

/**
 * Countries store eight 0/1 flags instead of percentages. Some saves also have
 * gaps, so the leading run of 1s is what counts.
 */
function readEmbracedCount(flags                               )         {
  if (!flags) return 0;
  let count = 0;
  while (count < flags.length && (flags[count]          ) >= 1) count += 1;
  return count;
}

/** Human-readable label for a slot index, for tables and legends. */
function institutionLabel(index        , language              = 'zh')         {
  const entry = INSTITUTIONS[index];
  if (!entry) return language === 'zh' ? '无' : 'none';
  return language === 'zh' ? entry.zh : entry.en;
}

/** The institution a province is working towards, as a label. */
function embracingLabel(index        , language              = 'zh')         {
  return index < 0 ? (language === 'zh' ? '—' : '—') : institutionLabel(index, language);
}


//# sourceURL=institutions.ts

// ---- details.ts ----
/**
 * The detail tables: the province extras and the country panel's wave-1 scalars.
 *
 * Both data planes (`scripts/render-timeline.ts` offline and
 * `apps/site/public/viewer-build.js` in the browser) call this one module, and it is
 * bundled into `apps/site/public/eu4-parser.js` by `scripts/build-browser-parser.ts`.
 * The rest of the two planes is deliberately written twice; these ~800 lines of frozen
 * schema (省份国家界面阶段任务书 §2) are not, because the province panel and the
 * country panel are their only readers and a second hand-maintained copy would only be
 * a place for the two planes to disagree.
 *
 * Everything here is derived from the save plus three *static* tables published by the
 * game-file conversation (`apps/site/public/assets/ui/*.json`). Those arrive as raw
 * JSON **text** so the offline `readFileSync` path and the browser `fetch` path
 * normalise them through exactly the same code. A missing table is not an error: the
 * matching key is simply empty and the panel falls back to the raw game key.
 *
 * Rules the panels depend on:
 *
 *  1. **Never invent a value.** A field the save does not record is `0` / `''` / `[]` /
 *     `null`, never a guess (see `absolutism` and `cultureStats.group`).
 *  2. **Every table is ordered deterministically** — dictionaries sorted, rows by
 *     province id, `countryDetail` keys by tag — because the two planes are compared
 *     with `JSON.stringify`.
 *  3. **Tag indices come from the caller's registry** (`tagId`), so a tag mentioned
 *     only here (a claim holder, a trade-company investor) still gets a colour entry in
 *     the plane's tag table. This therefore has to run *before* each plane freezes
 *     `tagColors`, which both planes do right after packing their event rows.
 */



const DATE_KEY__m11 = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/;

// --------------------------------------------------------------------- types ---

/** Raw JSON text of the static tables; any of them may be absent. */
                                   
                                                            
                   
                                                            
                           
                                                        
                
     
                                                                                  
                                                                                     
                                                                      
                        
     
                      
                                                                                    
                       
                                                                         
                     
 

/** One ledger / mana slot: the machine key plus its baked Chinese name. */
                           
              
               
 

/** One budget interval, arrays already padded to the frozen 19 / 38 slots. */
                               
                                                                                      
                 
                                                                 
                   
                            
                    
                      
                       
                                      
              
 

                                
                          
                                                                                        
                         
                                                                                      
                          
                           
 

                                   
                                                                       
                
                
                
 

                                         
                 
                  
                                                                        
                   
                                                                                  
                       
 

                                       
                                                                                    
                 
                   
 

                                     
                 
                  
                   
 

                                     
                 
                  
                                                          
                 
 

                                  
                                                                      
                                                        
                                                                                 
                                                          
 

                                    
               
                  
               
               
               
                  
                   
 

                                 
               
                  
              
              
              
              
                  
                   
                      
                                                                                     
                          
     
                                                                          
                                                                                       
                                                                                     
                                        
     
                  
 

                               
               
                
              
                 
                          
                                    
                  
              
              
              
 

                                    
               
                
                          
                                    
                  
              
              
              
 

                                
               
               
                  
                     
               
                
                   
                
 

                                   
                
                   
                
 

                                     
                  
                                                                                    
                
                    
              
                          
                    
 

                                      
                   
                   
               
                    
                   
                    
                          
                         
                     
                                 
                             
                     
                         
                              
                      
                         
                          
                 
                        
                         
                            
                       
                   
                 
                                                                                            
                   
                         
                                                                            
                                                                              
                          
                             
                   
                   
                     
                  
                   
                         
                  
                    
                              
                 
                              
                 
                   
                                                            
                    
                      
                                                                           
                            
                             
                          
                        
                        
                            
                                 
                         
                                   
                           
                                    
                                    
                                      
                                     
                               
                                   
                                                                                  
                                                                
                 
                                           
                 
                                    
                 
                          
                
                          
                       
                                                                                           
                           
                        
     
                  
       
                                                                                       
                                                                              
       
                 
                    
                      
                    
                                                                           
                                                       
                                                                                          
                                                                        
     
                                                                     
                    
                                             
                                                              
                          
     
                                  
                                                                   
     
                        
                                                  
                              
 

// ---------------------------------------------- the two rankings (第四对话任务书 §3.4) ---

/** One general on the 历史十五个最优秀将军 board. */
                                 
                                                                        
              
               
                                                             
               
               
                
                   
                
                                                   
                
                                                  
                  
               
                                
                  
                                                                 
                
                              
                
                         
              
                             
                
                                                                        
                                                     
 

/** One monarch on the 十五个最优秀君主 board. */
                                 
              
               
              
              
              
                                   
                
                
                                                     
              
                 
                                                                                 
                   
                 
                                              
                  
                                   
                     
                                                                     
                        
                
                                                                           
 

                               
                                                                                     
                      
                                                           
                           
                                                                               
                      
            
                                                         
                                                                               
    
                                                         
                                                                             
             
                                              
                           
                                                                         
                        
                                                            
                         
                                                               
                            
    
 

                           
                     
                                          
                             
                                          
                             
 

                                 
                                            
                                               
                                      
                                       
                                            
                                                                
                                                           
                                                                 
                                        
                                      
                                   
                                
                                 
 

                                                      
     
                                                                                
                                                                                   
                                                                      
     
                                              
                                                     
     
                                                                                    
                                                                                    
                                                                                     
                                                                                     
                                                                  
     
                                                  
     
                                                                                
                                                                             
                                                                                    
                                                 
     
                                                           
                        
     
                                                                  
                                                                                       
                                                                   
     
                     
 

                              
                    
                                         
                                                                        
                                 
                                           
                   
                                                                  
                     
                                                                              
                        
                                   
     
                                                                                    
                                                                                      
                                                                                   
                                                    
     
                          
 

// ------------------------------------------------------------ static tables ---

                            
                                        
                                            
                                       
                                   
                        
                                
                                    
                     
 

function jsonObject(text                    )                          {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text)           ;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed                           ;
    }
  } catch {
    // A half-written table must not take the whole build down.
  }
  return {};
}

function stringMap(value         )                         {
  const out                         = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value                           )) {
      if (typeof item === 'string') out[key] = item;
    }
  }
  return out;
}

/** `{ key: name }`, or a `names` array aligned with the table's own `dict`. */
function namesAlignedWithDict(raw                         )                         {
  const out = stringMap(raw['names']);
  const dict = stringArray(raw['dict']);
  const aligned = stringArray(raw['names']);
  for (let i = 0; i < dict.length && i < aligned.length; i += 1) {
    const key = dict[i];
    const name = aligned[i];
    if (key && name) out[key] = name;
  }
  return out;
}

function stringArray(value         )           {
  return Array.isArray(value)
    ? value.filter((item)                 => typeof item === 'string')
    : [];
}

/** `{ byId: { "1": key } }`, or the flat `{ "1": key }` form. */
function provinceKeyMap(raw                         , name        )                      {
  const nested = raw[name];
  const flat =
    Object.keys(raw).length > 0 && Object.keys(raw).every((key) => /^\d+$/.test(key)) ? raw : {};
  const source =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested                           )
      : flat;
  const out = new Map                ();
  for (const [key, value] of Object.entries(source)) {
    const id = Number(key);
    if (!Number.isInteger(id) || typeof value !== 'string' || value === '') continue;
    out.set(id, value);
  }
  return out;
}

/** A dictionary built from the table's own `dict`, extended with anything missing. */
function withExtras(dict                   , used                  )           {
  const out = [...dict];
  const seen = new Set(out);
  const extras           = [];
  for (const value of used) if (!seen.has(value)) extras.push(value);
  extras.sort();
  for (const value of extras) out.push(value);
  return out;
}

function normaliseTables(tables                                     )                   {
  const names = jsonObject(tables?.uiNames);
  const terrainRaw = jsonObject(tables?.provinceTerrain);
  const areaRaw = jsonObject(tables?.area);

  const terrainById = provinceKeyMap(terrainRaw, 'byId');
  const areaById = provinceKeyMap(areaRaw, 'byId');

  return {
    buildingNames: stringMap(names['buildings']),
    greatProjectNames: stringMap(names['greatProjects']),
    terrainNames: stringMap(names['terrain']),
    terrainById,
    terrainDict: withExtras(stringArray(terrainRaw['dict']), terrainById.values()),
    areaById,
    areaNames: { ...namesAlignedWithDict(areaRaw), ...stringMap(areaRaw['areaNames']) },
    areaDict: withExtras(stringArray(areaRaw['dict']), areaById.values()),
  };
}

// ---------------------------------------------------------- province extras ---

function provinceTables(
  provinces                             ,
  tagId                         ,
  tables                  ,
)                 {
  const ids = [...provinces.keys()];
  let maxId = 0;
  for (const id of ids) if (id > maxId) maxId = id;
  const size = maxId + 1;

  // Pass 1: the dictionaries. Tag indices are allocated here, in province-id order,
  // so both planes hand out the same numbers.
  const buildingKeys = new Set        ();
  const greatProjectKeys = new Set        ();
  const tradeGoodKeys = new Set        ();
  const latentKeys = new Set        ();
  const coreTags = new Set        ();
  const claimTags = new Set        ();
  const improveTags = new Set        ();
  for (const id of ids) {
    const record = provinces.get(id)                  ;
    for (const key of record.buildings) buildingKeys.add(key);
    for (const key of record.greatProjects) greatProjectKeys.add(key);
    for (const key of record.latentTradeGoods) latentKeys.add(key);
    if (record.tradeGoods) tradeGoodKeys.add(record.tradeGoods);
    for (const tag of record.cores) if (tag && tag !== '---') coreTags.add(tagId(tag));
    for (const tag of record.claims) if (tag && tag !== '---') claimTags.add(tagId(tag));
    for (const entry of record.countryImprove) if (entry.tag) improveTags.add(tagId(entry.tag));
  }
  const buildingDict = [...buildingKeys].sort();
  const buildingIndex = new Map(buildingDict.map((key, i) => [key, i]));
  const greatProjectDict = [...greatProjectKeys].sort();
  const greatProjectIndex = new Map(greatProjectDict.map((key, i) => [key, i]));
  const latentDict = [...latentKeys].sort();
  const latentIndex = new Map(latentDict.map((key, i) => [key, i]));
  const tradeGoodDict = [...tradeGoodKeys].sort();
  const tradeGoodIndex = new Map(tradeGoodDict.map((key, i) => [key, i]));
  const terrainIndex = new Map(tables.terrainDict.map((key, i) => [key, i]));
  const areaIndex = new Map(tables.areaDict.map((key, i) => [key, i]));

  // Pass 2: the rows, in province-id order.
  const buildingRows             = [];
  const buildingBuilders             = [];
  const coreRows             = [];
  const claimRows             = [];
  const greatProjectRows             = [];
  const tradeGoodRows             = [];
  const latentRows             = [];
  const improveRows             = [];
  const devastation           = new Array(size).fill(0)            ;
  const tradeCompany           = new Array(size).fill(0)            ;
  const terrainById           = new Array(size).fill(-1)            ;
  const areaById           = new Array(size).fill(-1)            ;

  for (const id of ids) {
    const record = provinces.get(id)                  ;
    if (record.buildings.length > 0) {
      const keys = [...new Set(record.buildings)].sort();
      buildingRows.push([id, ...keys.map((key) => buildingIndex.get(key) ?? 0)]);
      buildingBuilders.push(keys.map((key) => record.buildingBuilders[key] ?? ''));
    }
    if (record.cores.length > 0) {
      const tags = [...new Set(record.cores)].filter((tag) => tag && tag !== '---').sort();
      if (tags.length > 0) coreRows.push([id, ...tags.map((tag) => tagId(tag))]);
    }
    if (record.claims.length > 0) {
      const tags = [...new Set(record.claims)].filter((tag) => tag && tag !== '---').sort();
      if (tags.length > 0) claimRows.push([id, ...tags.map((tag) => tagId(tag))]);
    }
    if (record.greatProjects.length > 0) {
      const keys = [...new Set(record.greatProjects)].sort();
      greatProjectRows.push([id, ...keys.map((key) => greatProjectIndex.get(key) ?? 0)]);
    }
    if (record.tradeGoods && tradeGoodIndex.has(record.tradeGoods)) {
      tradeGoodRows.push([id, tradeGoodIndex.get(record.tradeGoods)          ]);
    }
    if (record.latentTradeGoods.length > 0) {
      const keys = [...new Set(record.latentTradeGoods)].sort();
      latentRows.push([id, ...keys.map((key) => latentIndex.get(key) ?? 0)]);
    }
    for (const entry of record.countryImprove) {
      if (!entry.tag) continue;
      improveRows.push([id, tagId(entry.tag), entry.count]);
    }
    if (record.devastation !== undefined) devastation[id] = record.devastation;
    if (record.activeTradeCompany) tradeCompany[id] = 1;
    const terrain = tables.terrainById.get(id);
    if (terrain !== undefined) terrainById[id] = terrainIndex.get(terrain) ?? -1;
    const area = tables.areaById.get(id);
    if (area !== undefined) areaById[id] = areaIndex.get(area) ?? -1;
  }

  return {
    provinceBuildings: {
      dict: buildingDict,
      names: buildingDict.map((key) => tables.buildingNames[key] ?? ''),
      rows: buildingRows,
      builders: buildingBuilders,
    },
    provinceClaims: { dict: [...claimTags].sort((a, b) => a - b), rows: claimRows },
    provinceCores: { dict: [...coreTags].sort((a, b) => a - b), rows: coreRows },
    provinceGreatProjects: {
      dict: greatProjectDict,
      names: greatProjectDict.map((key) => tables.greatProjectNames[key] ?? ''),
      rows: greatProjectRows,
    },
    provinceTradeGoods: { dict: tradeGoodDict, rows: tradeGoodRows },
    provinceLatentTradeGoods: { dict: latentDict, rows: latentRows },
    provinceImprove: { dict: [...improveTags].sort((a, b) => a - b), rows: improveRows },
    provinceTerrain: {
      dict: tables.terrainDict,
      names: tables.terrainDict.map((key) => tables.terrainNames[key] ?? ''),
      byId: terrainById,
    },
    provinceArea: {
      dict: tables.areaDict,
      names: tables.areaDict.map((key) => tables.areaNames[key] ?? ''),
      byId: areaById,
    },
    provinceDevastation: devastation,
    provinceTradeCompany: tradeCompany,
  };
}

// -------------------------------------------------------------- area detail ---

                    
                                          
                                                                            
                                        
                                                                                         
                                                    
 

function areaDetails(doc              , tagId                         )           {
  const detail                                  = {};
  const statedAreas = new Map                     ();
  const stateProsperity = new Map                             ();
  const ref = doc.section('map_area_data');
  if (!ref) return { detail, statedAreas, stateProsperity };
  const reader = new ClausewitzReader(doc.gamestate, ref.start + 1, ref.end - 1);
  for (;;) {
    const area = reader.nextMember();
    if (!area) break;
    if (area.kind !== 'block' || area.key === null) continue;
    const body = reader.enter(area);
    const areaKey = area.key;
    const states                            = [];
    const investments                                 = [];
    const assignments                                              = [];
    for (;;) {
      const item = body.nextMember();
      if (!item) break;
      if (item.kind !== 'block') continue;
      if (item.key === 'state') {
        const state = body.enter(item);
        let stateArea = areaKey;
        for (;;) {
          const member = state.nextMember();
          if (!member) break;
          if (member.key === 'area') {
            const value = textOf(state, member);
            if (value) stateArea = value;
            continue;
          }
          if (member.key !== 'country_state' || member.kind !== 'block') {
            if (member.kind === 'block') state.enter(member);
            continue;
          }
          const countryState = state.enter(member);
          let country = '';
          let prosperity = 0;
          for (;;) {
            const field = countryState.nextMember();
            if (!field) break;
            if (field.kind === 'block') {
              countryState.enter(field);
              continue;
            }
            if (field.key === 'country') country = textOf(countryState, field);
            else if (field.key === 'prosperity') prosperity = toNumber(textOf(countryState, field)) ?? 0;
          }
          if (!country) continue;
          states.push({ tagIdx: tagId(country), prosperity });
          assignments.push({ country, areaKey: stateArea });
          const byTag = stateProsperity.get(areaKey) ?? new Map                ();
          byTag.set(country, prosperity);
          stateProsperity.set(areaKey, byTag);
        }
        continue;
      }
      if (item.key === 'investments') {
        const invest = body.enter(item);
        let company = '';
        const icons           = [];
        for (;;) {
          const field = invest.nextMember();
          if (!field) break;
          if (field.key === 'tag') {
            company = textOf(invest, field);
          } else if (field.key === 'investments' && field.kind === 'block') {
            const list = invest.enter(field);
            for (;;) {
              const icon = list.nextMember();
              if (!icon) break;
              const value = textOf(list, icon);
              if (value) icons.push(value);
            }
          } else if (field.kind === 'block') {
            invest.enter(field);
          }
        }
        if (company) investments.push({ tagIdx: tagId(company), icons });
        continue;
      }
      body.enter(item);
    }
    if (states.length > 0 || investments.length > 0) detail[areaKey] = { states, investments };
    for (const assignment of assignments) {
      const set = statedAreas.get(assignment.country) ?? new Set        ();
      set.add(assignment.areaKey);
      statedAreas.set(assignment.country, set);
    }
  }

  // Key order is part of the JSON both planes compare, so it is pinned here.
  const sorted                                  = {};
  for (const key of Object.keys(detail).sort()) sorted[key] = detail[key]                   ;
  return { detail: sorted, statedAreas, stateProsperity };
}

// ------------------------------------------------------------------ people ----

                  
             
               
                  
              
              
              
                  
                   
                    
                    
                     
               
               
                
                   
                
                                                
                          
                                                                                   
                  
                     
 

function emptyPerson()         {
  return {
    id: 0,
    name: '',
    dynasty: '',
    adm: 0,
    dip: 0,
    mil: 0,
    culture: '',
    religion: '',
    birthDate: '',
    deathDate: '',
    activation: '',
    kind: '',
    fire: 0,
    shock: 0,
    maneuver: 0,
    siege: 0,
    personalities: [],
    flags: [],
    succeeded: false,
  };
}

function textOf(reader                  , member        )         {
  if (member.kind === 'string') return reader.stringValue(member);
  if (member.kind === 'scalar') return reader.rawValue(member);
  return '';
}

/** Read one character/leader block (`monarch`, `heir`, `leader`, …). */
function readPerson(reader                  )         {
  const person = emptyPerson();
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    if (item.kind === 'block') {
      if (item.key === 'id' || item.key === 'monarch_id' || item.key === 'leader_id') {
        const inner = reader.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key !== 'id') continue;
          const value = toNumber(textOf(inner, field));
          if (value !== undefined) person.id = value;
        }
        continue;
      }
      if (item.key === 'personalities' || item.key === 'ruler_flags') {
        // Two separate blocks with two different meanings: `personalities` carries the
        // character's real traits (the panel's 性格 column), `ruler_flags` carries event
        // and decision markers. Merging them is what put English event keys in the
        // 性格 column (第四对话任务书 §2.2), so they are kept apart.
        const target = item.key === 'personalities' ? person.personalities : person.flags;
        const inner = reader.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key !== null) target.push(field.key);
        }
        continue;
      }
      if (item.key === 'leader') {
        // A monarch who also commands: this nested block carries the pip stats.
        const inner = reader.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind === 'block') {
            inner.enter(field);
            continue;
          }
          const value = textOf(inner, field);
          if (field.key === 'type') person.kind = value;
          else if (field.key === 'fire') person.fire = toNumber(value) ?? 0;
          else if (field.key === 'shock') person.shock = toNumber(value) ?? 0;
          else if (field.key === 'maneuver') person.maneuver = toNumber(value) ?? 0;
          else if (field.key === 'siege') person.siege = toNumber(value) ?? 0;
          else if (field.key === 'activation' && !person.activation) person.activation = value;
        }
        continue;
      }
      reader.enter(item);
      continue;
    }
    const value = textOf(reader, item);
    switch (item.key) {
      case 'id':
        person.id = toNumber(value) ?? person.id;
        break;
      case 'name':
        person.name = value;
        break;
      case 'dynasty':
        person.dynasty = value;
        break;
      case 'ADM':
        person.adm = toNumber(value) ?? 0;
        break;
      case 'DIP':
        person.dip = toNumber(value) ?? 0;
        break;
      case 'MIL':
        person.mil = toNumber(value) ?? 0;
        break;
      case 'culture':
        person.culture = value;
        break;
      case 'religion':
        person.religion = value;
        break;
      case 'birth_date':
        person.birthDate = value;
        break;
      case 'death_date':
        person.deathDate = value;
        break;
      case 'activation':
        person.activation = value;
        break;
      case 'type':
        person.kind = value;
        break;
      case 'fire':
        person.fire = toNumber(value) ?? 0;
        break;
      case 'shock':
        person.shock = toNumber(value) ?? 0;
        break;
      case 'maneuver':
        person.maneuver = toNumber(value) ?? 0;
        break;
      case 'siege':
        person.siege = toNumber(value) ?? 0;
        break;
      case 'succeeded':
        person.succeeded = value === 'yes';
        break;
      default:
        break;
    }
  }
  return person;
}

const LEADER_KINDS                         = {
  general: '将军',
  admiral: '海军上将',
  explorer: '探险家',
  conquistador: '征服者',
};

function kindLabel(kind        )         {
  return LEADER_KINDS[kind] ?? (kind || '将领');
}

function ordinalOf(date        )         {
  return parseGameDate(date)?.ordinal ?? 0;
}

function monthsBetween(from        , to        )         {
  const a = parseGameDate(from);
  const b = parseGameDate(to);
  if (!a || !b) return 0;
  return b.year * 12 + b.month - (a.year * 12 + a.month);
}

function ageAt(birthDate        , saveDate        )         {
  const birth = parseGameDate(birthDate);
  const now = parseGameDate(saveDate);
  if (!birth || !now || birth.year <= 1) return 0;
  return Math.max(0, now.year - birth.year);
}

// --------------------------------------------------------------- the country ---

/** One monarch-ish history entry, kept raw until the id sets are complete. */
                        
               
                  
              
                 
 

/** Everything one `countries/{TAG}` walk collects before it is shaped. */
                          
                       
              
                               
                   
                 
                              
                            
                                     
                                     
                        
                       
                     
                      
                                                                                            
               
                   
                   
                     
                  
                             
                    
                      
                               
                                                                            
                    
                        
                                                                         
                                                                            
                                     
                                
                               
                      
                                                                      
                             
                                                                 
                  
                 
                    
                      
                    
                                                       
                                                                        
     
                                                                                 
           
                      
                       
                               
                                
                                  
                                   
                              
                               
                            
                             
                              
    
                                                                                         
                                                        
 

function emptyScratch(tag        , countryIndex        )                 {
  return {
    countryIndex,
    tag,
    scalars: new Map(),
    powers: [0, 0, 0],
    tech: [0, 0, 0],
    governmentReforms: [],
    ideas: [],
    landCounts: {},
    navyCounts: {},
    landRegiments: 0,
    landStrength: 0,
    landMorale: 0,
    navalMorale: 0,
    envoys: { merchants: 0, colonists: 0, diplomats: 0, missionaries: 0 },
    debt: 0,
    rivals: [],
    allies: [],
    subjects: [],
    atWar: [],
    acceptedCultures: [],
    monarchId: 0,
    leaderIds: [],
    previousMonarchIds: [],
    armyIds: [],
    armyMercIds: [],
    mercenaryCompanies: [],
    leaderHistory: new Map(),
    monarchEvents: [],
    history: [],
    hasInitial: false,
    flags: new Map(),
    estates: [],
    ledger: {},
    mana: { adm: [], dip: [], mil: [] },
  };
}

/** Read an `id={ id=… type=… }` or flat `id=…` member. */
function readId(reader                  , member        )         {
  if (member.kind !== 'block') return toNumber(textOf(reader, member)) ?? 0;
  const inner = reader.enter(member);
  for (;;) {
    const field = inner.nextMember();
    if (!field) break;
    if (field.key !== 'id') continue;
    const value = toNumber(textOf(inner, field));
    if (value !== undefined) return value;
  }
  return 0;
}

/** Count land regiments (`regiment`) and sum their strength/morale. */
function readRegiments(reader                  , depth        , scratch                )       {
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.kind !== 'block') continue;
    if (item.key === 'regiment') {
      scratch.landRegiments += 1;
      let strength = 1;
      const regiment = reader.enter(item);
      for (;;) {
        const field = regiment.nextMember();
        if (!field) break;
        if (field.key === null) continue;
        const value = textOf(regiment, field);
        if (field.key === 'strength') strength = toNumber(value) ?? 1;
        else if (field.key === 'morale') {
          const morale = toNumber(value);
          if (morale !== undefined && morale > scratch.landMorale) scratch.landMorale = morale;
        }
      }
      scratch.landStrength += strength;
      continue;
    }
    if (
      depth < 2 &&
      (item.key === 'mercenary_company' || item.key === 'subunit' || item.key === 'army')
    ) {
      readRegiments(reader.enter(item), depth + 1, scratch);
    } else {
      reader.enter(item);
    }
  }
}

/** The save's only clue at naval morale: the morale it keeps on each ship. */
function readShips(reader                  , scratch                )       {
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.kind !== 'block') continue;
    if (item.key === 'ship') {
      const ship = reader.enter(item);
      for (;;) {
        const field = ship.nextMember();
        if (!field) break;
        if (field.key !== 'morale') continue;
        const morale = toNumber(textOf(ship, field));
        if (morale !== undefined && morale > scratch.navalMorale) scratch.navalMorale = morale;
      }
      continue;
    }
    reader.enter(item);
  }
}

/** `num_subunits_type_and_cat`: category -> unit-type name -> count. */
function readSubunitCounts(
  reader                  ,
  land                        ,
  navy                        ,
)       {
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.key === null || item.kind !== 'block') {
      if (item.kind === 'block') reader.enter(item);
      continue;
    }
    const naval =
      item.key === 'heavy_ship' ||
      item.key === 'light_ship' ||
      item.key === 'galley' ||
      item.key === 'transport';
    const target = naval ? navy : land;
    const category = reader.enter(item);
    let total = 0;
    for (;;) {
      const field = category.nextMember();
      if (!field) break;
      if (field.key === null) continue;
      if (field.kind !== 'block') {
        // `infantry={ normal=56 mercenary=10 streltsy=55 }`: the inner keys are unit
        // type names, and `mercenary` is the one the panel shows as 雇佣.
        const count = toNumber(textOf(category, field)) ?? 0;
        total += count;
        if (field.key === 'mercenary') target['mercenary'] = (target['mercenary'] ?? 0) + count;
        continue;
      }
      const name = field.key;
      const inner = category.enter(field);
      for (;;) {
        const leaf = inner.nextMember();
        if (!leaf) break;
        if (leaf.key === null) continue;
        const count = toNumber(textOf(inner, leaf)) ?? 0;
        total += count;
        if (name === 'mercenary' || leaf.key === 'mercenary') {
          target['mercenary'] = (target['mercenary'] ?? 0) + count;
        }
      }
    }
    target[item.key] = (target[item.key] ?? 0) + total;
  }
}

/** A `{ TAG TAG … }` or `{ { tag=X } … }` block as a list of tags. */
function readTagList(reader                  , member        )           {
  const out           = [];
  const inner = reader.enter(member);
  for (;;) {
    const item = inner.nextMember();
    if (!item) break;
    if (item.kind !== 'block') {
      const value = textOf(inner, item);
      if (value) out.push(value);
      continue;
    }
    const body = inner.enter(item);
    for (;;) {
      const field = body.nextMember();
      if (!field) break;
      if (field.key === 'tag' || field.key === 'country' || field.key === 'value') {
        const value = textOf(body, field);
        if (value) out.push(value);
      } else if (field.kind === 'block') {
        body.enter(field);
      }
    }
  }
  return out;
}

/** Read a `{ key=value … }` group into a plain map (first value wins). */
function readFlatGroup(reader                  )                      {
  const out = new Map                ();
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.key === null) continue;
    if (item.kind === 'block') {
      reader.enter(item);
      continue;
    }
    if (!out.has(item.key)) out.set(item.key, textOf(reader, item));
  }
  return out;
}

/** Pull the fields of one `countries/{TAG}` block into a scratch record. */
function readCountry(
  reader                  ,
  member        ,
  tag        ,
  countryIndex        ,
  names              ,
)                 {
  const scratch = emptyScratch(tag, countryIndex);
  const body = reader.enter(member);
  for (;;) {
    const item = body.nextMember();
    if (!item) break;
    if (item.key === null) continue;

    if (item.kind !== 'block') {
      const value = textOf(body, item);
      // `enemy` and `accepted_culture` repeat, so they are collected rather than
      // stored under a single (first-wins) scalar.
      if (item.key === 'enemy') {
        if (value) scratch.atWar.push(value);
        continue;
      }
      if (item.key === 'accepted_culture') {
        if (value) scratch.acceptedCultures.push(value);
        continue;
      }
      if (!scratch.scalars.has(item.key)) scratch.scalars.set(item.key, value);
      continue;
    }

    switch (item.key) {
      case 'rival': {
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.kind === 'block') {
            inner.enter(field);
            continue;
          }
          if (field.key === 'country') {
            const value = textOf(inner, field);
            if (value) scratch.rivals.push(value);
          }
        }
        break;
      }
      case 'allies':
        scratch.allies.push(...readTagList(body, item));
        break;
      case 'subjects':
        scratch.subjects.push(...readTagList(body, item));
        break;
      case 'powers': {
        let index = 0;
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (index < 3) scratch.powers[index] = toNumber(textOf(inner, field)) ?? 0;
          index += 1;
        }
        break;
      }
      case 'technology': {
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          const value = toNumber(textOf(inner, field)) ?? 0;
          if (field.key === 'adm_tech') scratch.tech[0] = value;
          else if (field.key === 'dip_tech') scratch.tech[1] = value;
          else if (field.key === 'mil_tech') scratch.tech[2] = value;
        }
        break;
      }
      case 'government': {
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key !== 'reform_stack' || field.kind !== 'block') {
            if (field.kind === 'block') inner.enter(field);
            continue;
          }
          const stack = inner.enter(field);
          for (;;) {
            const child = stack.nextMember();
            if (!child) break;
            if (child.key !== 'reforms' || child.kind !== 'block') {
              if (child.kind === 'block') stack.enter(child);
              continue;
            }
            const reforms = stack.enter(child);
            for (;;) {
              const reform = reforms.nextMember();
              if (!reform) break;
              const value = textOf(reforms, reform);
              if (value) scratch.governmentReforms.push(value);
            }
          }
        }
        break;
      }
      case 'active_idea_groups': {
        for (const [group, value] of readFlatGroup(body.enter(item))) {
          const unlocked = Math.round(toNumber(value) ?? 0);
          scratch.ideas.push({ group, unlocked, total: Math.max(7, unlocked) });
        }
        break;
      }
      case 'num_subunits_type_and_cat':
        readSubunitCounts(body.enter(item), scratch.landCounts, scratch.navyCounts);
        break;
      case 'army': {
        readRegiments(body.enter(item), 0, scratch);
        // A second, independent reader over the same member: the army's own id and
        // the mercenary company it has hired, both needed to know which companies
        // are actually on the map ("BEST LEADERS").
        const army = body.enter(item);
        for (;;) {
          const field = army.nextMember();
          if (!field) break;
          if (field.key === 'id' && field.kind === 'block') {
            const id = readId(army, field);
            if (id) scratch.armyIds.push(id);
          } else if (field.key === 'mercenary_company' && field.kind === 'block') {
            const id = readId(army, field);
            if (id) scratch.armyMercIds.push(id);
          } else if (field.kind === 'block') {
            army.enter(field);
          }
        }
        break;
      }
      case 'navy':
        readShips(body.enter(item), scratch);
        break;
      case 'merchants':
      case 'diplomats':
      case 'colonists':
      case 'missionaries': {
        const inner = body.enter(item);
        let count = 0;
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === 'envoy') count += 1;
          else if (field.kind === 'block') inner.enter(field);
        }
        if (item.key === 'merchants') scratch.envoys.merchants += count;
        else if (item.key === 'diplomats') scratch.envoys.diplomats += count;
        else if (item.key === 'colonists') scratch.envoys.colonists += count;
        else scratch.envoys.missionaries += count;
        break;
      }
      case 'monarch':
      case 'previous_monarch': {
        const inner = body.enter(item);
        let id = 0;
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === 'id') id = toNumber(textOf(inner, field)) ?? 0;
        }
        if (item.key === 'monarch') scratch.monarchId = id;
        else if (id) scratch.previousMonarchIds.push(id);
        break;
      }
      case 'leader': {
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key !== 'id') continue;
          const id = toNumber(textOf(inner, field));
          if (id !== undefined) scratch.leaderIds.push(id);
        }
        break;
      }
      case 'mercenary_company': {
        // A company names its own general, and points at the army unit carrying its
        // regiments; both are needed for "BEST LEADERS".
        let companyId = 0;
        let unitId = 0;
        let leader                    ;
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.key === 'id') {
            companyId = readId(inner, field);
          } else if (field.key === 'unit' && field.kind === 'block') {
            unitId = readId(inner, field);
          } else if (field.key === 'leader' && field.kind === 'block') {
            leader = readPerson(inner.enter(field));
          } else if (field.kind === 'block') {
            inner.enter(field);
          }
        }
        if (leader) scratch.mercenaryCompanies.push({ id: companyId, unitId, leader });
        break;
      }
      case 'flags': {
        // `{ some_flag=1512.8.17 … }` — the great-advisor triggers live here.
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind === 'block') {
            inner.enter(field);
            continue;
          }
          const value = textOf(inner, field);
          if (value && !scratch.flags.has(field.key)) scratch.flags.set(field.key, value);
        }
        break;
      }
      case 'estate': {
        const inner = body.enter(item);
        let kind = '';
        let loyalty = 0;
        let territory = 0;
        let agendas = 0;
        const privileges                                         = [];
        const influences                                                          = [];
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind !== 'block') {
            const value = textOf(inner, field);
            if (field.key === 'type') kind = value;
            else if (field.key === 'loyalty') loyalty = toNumber(value) ?? 0;
            else if (field.key === 'territory') territory = toNumber(value) ?? 0;
            else if (field.key === 'num_of_estate_agendas_completed') agendas = toNumber(value) ?? 0;
            continue;
          }
          if (field.key === 'granted_privileges') {
            // `{ { estate_church_land_rights 1478.9.3 } … }` — each inner block is a
            // bare (name, date) pair, so it is read positionally.
            const list = inner.enter(field);
            for (;;) {
              const entry = list.nextMember();
              if (!entry) break;
              if (entry.kind !== 'block') continue;
              const pair = list.enter(entry);
              let name = '';
              let since = '';
              for (;;) {
                const value = pair.nextMember();
                if (!value) break;
                const text = textOf(pair, value);
                if (!name && text && !DATE_KEY__m11.test(text)) name = text;
                else if (!since && DATE_KEY__m11.test(text)) since = text;
              }
              if (name) privileges.push({ name, since });
            }
            continue;
          }
          if (field.key === 'influence_modifier') {
            // `{ value=5.000 desc="EST_VAL_DIET_SUMMONED" date=1581.1.2 }`, may repeat.
            const modifier = inner.enter(field);
            let value = '';
            let name = '';
            let expires = '';
            for (;;) {
              const x = modifier.nextMember();
              if (!x) break;
              if (x.key === null) continue;
              if (x.kind === 'block') {
                modifier.enter(x);
                continue;
              }
              const text = textOf(modifier, x);
              if (x.key === 'value') value = text;
              else if (x.key === 'desc') name = text;
              else if (x.key === 'date') expires = text;
            }
            if (name || value) influences.push({ name, value, expires });
            continue;
          }
          inner.enter(field);
        }
        if (kind) {
          privileges.sort((a, b) => a.name.localeCompare(b.name) || a.since.localeCompare(b.since));
          influences.sort((a, b) => a.expires.localeCompare(b.expires) || a.name.localeCompare(b.name));
          scratch.estates.push({
            // The raw `estate_…` type on purpose: that is how `uiNames.estates` is keyed.
            kind,
            loyalty,
            territory,
            agendas,
            privileges,
            influences,
          });
        }
        break;
      }
      case 'ledger': {
        // 三个区间各自的收入/支出数组（19 / 38 槽，按槽位下标排列）＋全时段支出表。
        // `thismonth*` 是"本月到现在"，与三个区间的口径不同，不进数据面。
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind !== 'block') {
            const value = toNumber(textOf(inner, field)) ?? 0;
            if (field.key === 'lastmonthincome') scratch.ledger.lastMonthIncomeTotal = value;
            else if (field.key === 'lastmonthexpense') scratch.ledger.lastMonthExpenseTotal = value;
            else if (field.key === 'last_months_recurring_income') scratch.ledger.recurringIncome = value;
            else if (field.key === 'last_months_recurring_expenses') scratch.ledger.recurringExpense = value;
            continue;
          }
          const values           = [];
          const list = inner.enter(field);
          for (;;) {
            const x = list.nextMember();
            if (!x) break;
            if (x.key === null && x.kind === 'block') {
              list.enter(x);
              values.push(0);
              continue;
            }
            values.push(toNumber(textOf(list, x)) ?? 0);
          }
          if (field.key === 'income') scratch.ledger.income = values;
          else if (field.key === 'expense') scratch.ledger.expense = values;
          else if (field.key === 'lastmonthincometable') scratch.ledger.lastMonthIncome = values;
          else if (field.key === 'lastmonthexpensetable') scratch.ledger.lastMonthExpense = values;
          else if (field.key === 'lastyearincome') scratch.ledger.lastYearIncome = values;
          else if (field.key === 'lastyearexpense') scratch.ledger.lastYearExpense = values;
          else if (field.key === 'totalexpensetable') scratch.ledger.totalExpense = values;
        }
        break;
      }
      case 'adm_spent_indexed':
      case 'dip_spent_indexed':
      case 'mil_spent_indexed': {
        // `{ 0=5775 1=4463 … }`：稀疏的"槽位下标 -> 点数"，缺的槽位就是 0。
        const inner = body.enter(item);
        const target =
          item.key === 'adm_spent_indexed'
            ? scratch.mana.adm
            : item.key === 'dip_spent_indexed'
              ? scratch.mana.dip
              : scratch.mana.mil;
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === null) continue;
          if (field.kind === 'block') {
            inner.enter(field);
            continue;
          }
          const index = Number(field.key);
          if (!Number.isInteger(index) || index < 0) continue;
          target[index] = toNumber(textOf(inner, field)) ?? 0;
        }
        break;
      }
      case 'loan': {
        // `loan` repeats; the panel only needs the outstanding amount.
        const inner = body.enter(item);
        for (;;) {
          const field = inner.nextMember();
          if (!field) break;
          if (field.key === 'amount') scratch.debt += toNumber(textOf(inner, field)) ?? 0;
          else if (field.kind === 'block') inner.enter(field);
        }
        break;
      }
      case 'history':
        readCountryHistory(body.enter(item), scratch, names);
        break;
      default:
        // Estates, diplomacy, missions, ai … belong to later waves; skip the block
        // without materialising it.
        body.enter(item);
        break;
    }
  }
  return scratch;
}

/**
 * The name tables the dated history log needs to turn a raw game key into a name
 * (第四对话任务书 §2.5). Values are already the baked `uiNames` families; an absent
 * family is `{}` and every lookup falls back to the key it was given.
 */
                        
                                    
                                                                               
                                                                                      
                                                                                 
                                   
                                     
                                    
 

/** `table[key] || key` — never throws, never invents a name. */
function rkName(table                                    , key        )         {
  return table?.[key] || key;
}

/** The four national-focus keys the save writes in Latin capitals. */
const RK_FOCUS_LABELS                         = {
  ADM: '行政',
  DIP: '外交',
  MIL: '军事',
  none: '无',
};

function rkFocus(value        )         {
  return RK_FOCUS_LABELS[value] ?? value;
}

/**
 * `2nd 俄罗斯征服波洛茨克之战` -> `第二次 俄罗斯征服波洛茨克之战` (第四对话任务书 §2.5
 * 第 6 行, optional). The save stores the ordinal as an English suffix; the acceptance
 * list expects the Chinese numeral, so 1–10 are spelled out and anything larger keeps
 * its digits. A name without the ordinal prefix is returned untouched.
 */
const RK_CN_NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const RK_WAR_ORDINAL = /^(\d+)(st|nd|rd|th) /;

function rkWarName(name        )         {
  const match = RK_WAR_ORDINAL.exec(name);
  if (!match) return name;
  const value = Number(match[1]);
  const label = value >= 1 && value <= 10 ? (RK_CN_NUMERALS[value]          ) : match[1];
  return `第${label}次 ${name.slice(match[0].length)}`;
}

/** Read a country's dated history log into accessions, leaders and timeline rows. */
function readCountryHistory(
  history                  ,
  scratch                ,
  names              ,
)       {
  for (;;) {
    const entry = history.nextMember();
    if (!entry) break;
    if (entry.key === null) continue;
    const match = DATE_KEY__m11.exec(entry.key);
    if (!match) {
      // An undated key at the head of the block is the state at the campaign start.
      if (entry.kind === 'block') history.enter(entry);
      scratch.hasInitial = true;
      continue;
    }
    if (entry.kind !== 'block') continue;
    const date = entry.key;
    const ordinal = Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]);
    const body = history.enter(entry);
    for (;;) {
      const field = body.nextMember();
      if (!field) break;
      if (field.key === null) continue;
      const key = field.key;

      if (field.kind === 'block') {
        if (
          key === 'monarch' ||
          key === 'monarch_heir' ||
          key === 'monarch_consort' ||
          key === 'heir' ||
          key === 'queen'
        ) {
          // Which of these count as a reign is decided once the whole block has been
          // read: the `monarch`/`previous_monarch` id sets come *after* `history`.
          scratch.monarchEvents.push({ date, ordinal, key, person: readPerson(body.enter(field)) });
          continue;
        }
        if (key === 'leader') {
          const person = readPerson(body.enter(field));
          if (person.id && !scratch.leaderHistory.has(person.id)) {
            scratch.leaderHistory.set(person.id, person);
          }
          scratch.history.push({
            date,
            ordinal,
            kind: 'leader',
            text: `${kindLabel(person.kind)}：${person.name}`,
            payload: person.fire + person.shock + person.maneuver + person.siege,
          });
          continue;
        }
        body.enter(field);
        continue;
      }

      const value = textOf(body, field);
      switch (key) {
        case 'changed_tag_from':
          scratch.history.push({ date, ordinal, kind: 'tagSwitch', text: `改国号：${value}`, tag: value });
          break;
        // The five `value` kinds below print a **name**, not the raw game key
        // (第四对话任务书 §2.5). A table that is missing or has no entry for the key
        // falls back to the key itself: the name families `government` / `decisions`
        // are built by task B, and the data plane must not depend on their arrival.
        case 'religion':
          scratch.history.push({
            date,
            ordinal,
            kind: 'religion',
            text: `国教改为 ${rkName(names.religions, value)}`,
          });
          break;
        case 'primary_culture':
          scratch.history.push({
            date,
            ordinal,
            kind: 'primaryCulture',
            text: `主文化改为 ${rkName(names.cultures, value)}`,
          });
          break;
        case 'add_accepted_culture':
          scratch.history.push({
            date,
            ordinal,
            kind: 'addAcceptedCulture',
            text: `接受文化：${rkName(names.cultures, value)}`,
          });
          break;
        case 'remove_accepted_culture':
          scratch.history.push({
            date,
            ordinal,
            kind: 'removeAcceptedCulture',
            text: `取消接受文化：${rkName(names.cultures, value)}`,
          });
          break;
        case 'add_government_reform':
          scratch.history.push({
            date,
            ordinal,
            kind: 'governmentReform',
            text: `政体改革：${value}`,
            tag: value,
          });
          break;
        case 'government':
          scratch.history.push({
            date,
            ordinal,
            kind: 'government',
            text: `政体改为 ${rkName(names.government, value)}`,
            tag: value,
          });
          break;
        case 'government_rank':
          scratch.history.push({
            date,
            ordinal,
            kind: 'governmentRank',
            text: `政体等级 ${value}`,
            ...(toNumber(value) !== undefined ? { payload: toNumber(value)           } : {}),
          });
          break;
        case 'national_focus':
          scratch.history.push({
            date,
            ordinal,
            kind: 'focus',
            text: `国家焦点：${rkFocus(value)}`,
            tag: value,
          });
          break;
        case 'capital': {
          const provinceId = toNumber(value);
          scratch.history.push({
            date,
            ordinal,
            kind: 'capital',
            text: '迁都',
            ...(provinceId !== undefined ? { provId: provinceId } : {}),
          });
          break;
        }
        case 'decision':
          scratch.history.push({
            date,
            ordinal,
            kind: 'decision',
            text: rkName(names.decisions, value),
            tag: value,
          });
          break;
        default:
          break;
      }
    }
  }
}

// --------------------------------------------------------------- the shapes ---

/** Everything wave 2 needs that is aggregated across provinces or read from a table. */
                      
                                                                         
                                                   
                                                                                         
                                                                                                    
                                
                                    
                                                                                     
                                                    
                                                  
                                                  
 

/** Wave 3's inputs: the two baked slot-name tables (their lengths are the slot counts). */
                      
                                                           
                        
 

/** Turn one walked country into the frozen wave-1 record. */
function shapeCountry(
  scratch                ,
  religionDev                        ,
  cultures                                                                                             ,
  warRows                     ,
  saveDate        ,
  startDate                    ,
  wave2            ,
  wave3            ,
)                      {
  const scalar = (key        )         => scratch.scalars.get(key) ?? '';
  const number = (key        )         => toNumber(scalar(key)) ?? 0;
  const optionalNumber = (key        )                =>
    scratch.scalars.has(key) ? (toNumber(scalar(key)) ?? null) : null;

  // Government strength: the first of these five the save actually records.
  const strengthSources                          = [
    ['legitimacy', number('legitimacy')],
    ['republican_tradition', number('republican_tradition')],
    ['devotion', number('devotion')],
    ['meritocracy', number('meritocracy')],
    ['horde_unity', number('horde_unity')],
  ];
  const strength = strengthSources.find(([, value]) => value > 0);

  // ---- rulers, failed heirs and the monarch cards ---------------------------
  // `monarchIds` is what the save itself calls a ruler: the `previous_monarch` list
  // plus the current `monarch`. Heirs and queens are *not* rulers until one of the
  // monarch-ish events names them, which is exactly the test for a failed heir.
  const monarchIds = new Set        ([scratch.monarchId, ...scratch.previousMonarchIds]);

  const history = [...scratch.history];
  const accessions                 = [];
  const failedHeirs                      = [];
  // Collected up front: an heir entry is written before the accession that proves the
  // character reigned, so a single pass would miscount them as failed.
  const reigned = new Set        ();
  for (const event of scratch.monarchEvents) {
    const isAccession =
      event.key === 'monarch' || event.key === 'monarch_heir' || event.key === 'monarch_consort';
    if (isAccession && event.person.id !== 0 && monarchIds.has(event.person.id)) {
      reigned.add(event.person.id);
    }
  }
  for (const event of scratch.monarchEvents) {
    const person = event.person;
    const isRuler = person.id !== 0 && monarchIds.has(person.id);
    if (
      isRuler &&
      (event.key === 'monarch' || event.key === 'monarch_heir' || event.key === 'monarch_consort')
    ) {
      accessions.push(event);
      history.push({ date: event.date, ordinal: event.ordinal, kind: 'monarch', text: `即位：${person.name}` });
      continue;
    }
    if (event.key === 'heir' || event.key === 'queen') {
      // A failed heir is an `heir` who never shows up as a ruler. pdx-tools tests the
      // save's own ruler id set (`previous_monarch` + `monarch`); this also drops an
      // heir who does have an accession event, because that list is capped and can be
      // missing an older ruler.
      if (event.key === 'heir' && person.id !== 0 && !monarchIds.has(person.id) && !reigned.has(person.id)) {
        failedHeirs.push({
          name: person.name,
          birth: person.birthDate,
          personalities: person.personalities,
          flags: person.flags,
          adm: person.adm,
          dip: person.dip,
          mil: person.mil,
        });
      }
      const label = event.key === 'heir' ? '立储' : '联姻';
      history.push({ date: event.date, ordinal: event.ordinal, kind: event.key, text: `${label}：${person.name}` });
      continue;
    }
    // A consort/heir who never ruled still belongs in the timeline.
    history.push({ date: event.date, ordinal: event.ordinal, kind: 'monarch', text: `册立：${person.name}` });
  }

  // A re-stated accession (`monarch` right after its own `monarch_heir`) is the same
  // reign, not a new one.
  const deduped                 = [];
  for (const event of accessions) {
    const last = deduped[deduped.length - 1];
    if (last && event.person.id !== 0 && last.person.id === event.person.id) continue;
    deduped.push(event);
  }
  const campaignStart = startDate ? ordinalOf(startDate) : 0;
  const rulers                 = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const event = deduped[i]                ;
    const next = deduped[i + 1];
    if (next && next.ordinal <= campaignStart) continue;
    const endDate = next ? next.date : '';
    const startOrdinal = Math.max(event.ordinal, campaignStart);
    rulers.push({
      name: event.person.name,
      start: ordinalToDate(startOrdinal),
      end: endDate,
      months: Math.max(0, monthsBetween(event.date, endDate || saveDate)),
      personalities: event.person.personalities,
      flags: event.person.flags,
      adm: event.person.adm,
      dip: event.person.dip,
      mil: event.person.mil,
    });
  }

  // ---- the current monarch --------------------------------------------------
  let monarch                        = null;
  let currentPerson                    ;
  for (const event of scratch.monarchEvents) {
    if (event.person.id !== 0 && event.person.id === scratch.monarchId) currentPerson = event.person;
  }
  if (currentPerson) {
    monarch = {
      name: currentPerson.name,
      dynasty: currentPerson.dynasty,
      adm: currentPerson.adm,
      dip: currentPerson.dip,
      mil: currentPerson.mil,
      age: ageAt(currentPerson.birthDate, saveDate),
      culture: currentPerson.culture,
      religion: currentPerson.religion,
      inaugurated: scalar('inauguration'),
      personalities: currentPerson.personalities,
      flags: currentPerson.flags,
    };
  }

  // ---- leaders --------------------------------------------------------------
  // The history log keyed by character id (later entries win), plus the generals of
  // mercenary companies this country has actually hired.
  const attachedCompanies = new Set        ([...scratch.armyMercIds]);
  const armyIds = new Set        ([...scratch.armyIds]);
  const activeIds = new Set(scratch.leaderIds);
  const leaderById = new Map                (scratch.leaderHistory);
  const mercenaryLeaders           = [];
  for (const company of scratch.mercenaryCompanies) {
    if (!company.leader.id) continue;
    if (!attachedCompanies.has(company.id) && !(company.unitId && armyIds.has(company.unitId))) continue;
    leaderById.set(company.leader.id, company.leader);
    mercenaryLeaders.push(company.leader);
  }
  const leaders                  = [];
  for (const person of leaderById.values()) {
    leaders.push({
      name: person.name,
      kind: person.kind,
      active: activeIds.has(person.id) || mercenaryLeaders.includes(person),
      activation: person.activation,
      fire: person.fire,
      shock: person.shock,
      maneuver: person.maneuver,
      siege: person.siege,
    });
  }
  leaders.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      b.activation.localeCompare(a.activation) ||
      a.name.localeCompare(b.name),
  );

  const score = (leader               )         =>
    leader.fire + leader.shock + leader.maneuver + leader.siege;
  let bestGeneral                       = null;
  let bestAdmiral                       = null;
  const consider = (leader               )       => {
    if (leader.kind === 'general' || leader.kind === 'conquistador') {
      if (!bestGeneral || score(leader) > score(bestGeneral)) bestGeneral = leader;
    } else if (leader.kind === 'admiral' || leader.kind === 'explorer') {
      if (!bestAdmiral || score(leader) > score(bestAdmiral)) bestAdmiral = leader;
    }
  };
  for (const leader of leaders) if (leader.active) consider(leader);

  // ---- the timeline ---------------------------------------------------------
  if (scratch.hasInitial && startDate) {
    history.push({ date: startDate, ordinal: campaignStart, kind: 'initial', text: `开局：${scratch.tag}` });
  }
  history.push(...warRows);
  history.sort(
    (a, b) => a.ordinal - b.ordinal || a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text),
  );

  const land = (category        )         => scratch.landCounts[category] ?? 0;
  const ship = (category        )         => scratch.navyCounts[category] ?? 0;

  // ---- 波 2：建筑 / 州 / 阶级 / 顾问 ------------------------------------------
  const buildingCount = [...(wave2.buildingCounts.get(scratch.tag) ?? new Map                ())]
    .map(([building, provinces]) => ({ building, provinces }))
    .filter((entry) => entry.provinces > 0)
    // A bar chart reads best tallest-first; the key breaks ties so both planes agree.
    .sort((a, b) => b.provinces - a.provinces || a.building.localeCompare(b.building));

  const capitalId = number('capital');
  const capitalArea = capitalId > 0 ? wave2.areaById.get(capitalId) : undefined;
  const stability = number('stability');
  const states = [...(wave2.stateAgg.get(scratch.tag) ?? new Map                                                                       ())]
    .map(([area, agg]) => {
      const prosperity = wave2.stateProsperity.get(area)?.get(scratch.tag);
      const isState = prosperity !== undefined;
      const value = prosperity ?? 0;
      // pdx-tools' own three-way rule: it can prosper, it can be declining, or the
      // question does not apply (not a state at all, or already at 100).
      const prosperityMode = !isState
        ? ''
        : stability > 0 && !agg.hasDevastation && value < 100
          ? 'prospering'
          : stability < 0 || agg.hasDevastation
            ? 'declining'
            : '';
      return {
        area,
        name: wave2.areaNames[area] ?? '',
        dev: Math.round(agg.dev * 1000) / 1000,
        capitalState: capitalArea === area,
        prosperity: value,
        prosperityMode,
        stateHouse: agg.stateHouse,
      };
    })
    .sort((a, b) => a.area.localeCompare(b.area));

  // 王室领地：存档里没有这个标量，pdx-tools 也是算出来的（100 − Σ 阶级领地占比）。
  const crownland = Math.round((100 - scratch.estates.reduce((total, estate) => total + estate.territory, 0)) * 100) / 100;

  // 名臣顾问：只列该国有对应 flag 的类型（没有名臣的国家给空数组，面板只显示一行文字）。
  const advisors                                                    = [];
  for (const advisor of wave2.advisorIds) {
    const date = scratch.flags.get(advisor.id);
    if (!date) continue;
    advisors.push({
      id: advisor.id,
      name: wave2.uiNames['advisors']?.[advisor.id] ?? advisor.name,
      date,
    });
  }
  advisors.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // ---- 波 3：财政 / 点数 ------------------------------------------------------
  const ledger = scratch.ledger;
  const round3 = (value        )         => Math.round(value * 1000) / 1000;
  /** The save's arrays are positional; pad/truncate to the frozen slot count. */
  const padded = (values                      , count        )           => {
    const out           = new Array(count).fill(0)            ;
    // `?? 0` matters: the mana maps are *sparse* (built by `target[index] = …`), so an
    // unused slot reads back as `undefined` and would poison every total with NaN.
    if (values) for (let i = 0; i < Math.min(values.length, count); i += 1) out[i] = values[i] ?? 0;
    return out;
  };
  const budgetPeriod = (
    period        ,
    income                      ,
    expense                      ,
    incomeTotalFallback = 0,
    expenseTotalFallback = 0,
  )               => {
    const incomeSlots = padded(income, wave3.ledgerSlots.income.length);
    const expenseSlots = padded(expense, wave3.ledgerSlots.expense.length);
    // The breakdown is the authority (the panel adds the rows up); the save's own
    // scalar total only stands in when the array is missing (5 countries in this save
    // keep no last-year table at all).
    const incomeTotal = round3(income && income.length > 0 ? incomeSlots.reduce((total, value) => total + value, 0) : incomeTotalFallback);
    const expenseTotal = round3(expense && expense.length > 0 ? expenseSlots.reduce((total, value) => total + value, 0) : expenseTotalFallback);
    return {
      period,
      income: incomeSlots.map(round3),
      expense: expenseSlots.map(round3),
      incomeTotal,
      expenseTotal,
      net: round3(incomeTotal - expenseTotal),
    };
  };
  const budget                = {
    periods: [
      budgetPeriod('last-month', ledger.lastMonthIncome, ledger.lastMonthExpense, ledger.lastMonthIncomeTotal, ledger.lastMonthExpenseTotal),
      budgetPeriod('ytd', ledger.income, ledger.expense),
      budgetPeriod('last-year', ledger.lastYearIncome, ledger.lastYearExpense),
    ],
    totalExpense: padded(ledger.totalExpense, wave3.ledgerSlots.expense.length).map(round3),
    recurringIncome: round3(ledger.recurringIncome ?? 0),
    recurringExpense: round3(ledger.recurringExpense ?? 0),
  };
  const manaSpent                   = {
    adm: padded(scratch.mana.adm, wave3.manaSlots.length),
    dip: padded(scratch.mana.dip, wave3.manaSlots.length),
    mil: padded(scratch.mana.mil, wave3.manaSlots.length),
  };

  return {
    powers: [...scratch.powers],
    treasury: number('treasury'),
    debt: Math.round(scratch.debt * 1000) / 1000,
    inflation: number('inflation'),
    prestige: number('prestige'),
    stability: number('stability'),
    powerProjection: number('current_power_projection'),
    innovativeness: number('innovativeness'),
    corruption: number('corruption'),
    governmentStrengthKind: strength ? (strength[0]          ) : 'native',
    governmentStrength: strength ? (strength[1]          ) : 0,
    government: scalar('government_name'),
    governmentRank: number('government_rank'),
    governmentReforms: scratch.governmentReforms,
    development: number('development'),
    rawDevelopment: number('raw_development'),
    autonomyPercent: number('average_autonomy'),
    cities: number('num_of_cities'),
    overextension: number('overextension_percentage'),
    religiousUnity: number('religious_unity'),
    // The save never writes `absolutism` (0 occurrences in the sample save), so this
    // stays `null` and the panel prints `—` with "存档未记录" instead of a fake 0.
    absolutism: optionalNumber('absolutism'),
    mercantilism: number('mercantilism'),
    splendor: number('splendor'),
    tech: [...scratch.tech],
    envoys: { ...scratch.envoys },
    religion: scalar('religion'),
    primaryCulture: scalar('primary_culture'),
    dominantCulture: scalar('dominant_culture'),
    acceptedCultures: scratch.acceptedCultures,
    rivals: scratch.rivals,
    allies: scratch.allies,
    subjects: scratch.subjects,
    atWar: scratch.atWar,
    overlord: scalar('overlord'),
    colonialParent: scalar('colonial_parent'),
    sailors: number('sailors'),
    countryId: scratch.countryIndex,
    army: [land('infantry'), land('cavalry'), land('artillery'), land('mercenary')],
    navy: [ship('heavy_ship'), ship('light_ship'), ship('galley'), ship('transport')],
    manpower: number('manpower'),
    reinforce: Math.round(Math.max(0, scratch.landRegiments - scratch.landStrength) * 1000) / 1000,
    maxManpower: number('max_manpower'),
    landMorale: scratch.landMorale > 0.52 ? Math.round(scratch.landMorale * 1000) / 1000 : null,
    navalMorale: scratch.navalMorale > 0.52 ? Math.round(scratch.navalMorale * 1000) / 1000 : null,
    professionalism: number('army_professionalism'),
    armyTradition: number('army_tradition'),
    navyTradition: number('navy_tradition'),
    ideas: scratch.ideas,
    monarch,
    rulers,
    failedHeirs,
    leaders,
    bestGeneral,
    bestAdmiral,
    religionDev,
    cultureStats: [...cultures.entries()]
      .map(([culture, tally]) => ({
        culture,
        // Culture groups live in `common/cultures/*.txt`, which the data plane cannot
        // read; the panel falls back to the raw culture name.
        group: '',
        provinces: tally.provinces,
        dev: tally.dev,
        statedProvinces: tally.statedProvinces,
        statedDev: tally.statedDev,
      }))
      .sort((a, b) => b.dev - a.dev || a.culture.localeCompare(b.culture)),
    history,
    buildingCount,
    states,
    estates: scratch.estates,
    crownland,
    advisors,
    budget,
    manaSpent,
  };
}

// ------------------------------------------------------------------ names -----

/**
 * The name families 省份国家界面阶段任务书 §6.8.2 asks S2 to publish.
 *
 * They are listed here rather than read from the file so the baked object always has
 * the same keys in the same order — the two data planes are compared with
 * `JSON.stringify`. A family the file does not define yet is `{}`; a family it grows
 * beyond this list is passed through as well, so a new name table needs no data-plane
 * change.
 */
const UI_NAME_FAMILIES = [
  'cultures',
  'personalities',
  'governmentReforms',
  'buildings',
  'greatProjects',
  'terrain',
  'religions',
  'institutions',
  'ideaGroups',
  'advisors',
  'areas',
  'units',
  'technologies',
  // The 阶级 family set, published in 阶段 2 and keyed exactly like the save writes it
  // (`estate_church` / `estate_church_land_rights` / `EST_VAL_DIET_SUMMONED`).
  'estates',
  'estatePrivileges',
  'estateInfluenceModifiers',
  'estateAgendas',
  'stateEdicts',
  'parliamentIssues',
  'parliamentBribes',
]         ;

/**
 * Bake the raw `uiNames.json` text into the plane.
 *
 * Deliberately **no fallback chain of its own**: religion names already have
 * `RELIGION_FALLBACK` in `game-localisation.js` / `scripts/lib/localisation.ts`, and a
 * missing key is simply absent here — the panel prints the raw key (or `—`), which is
 * the same floor the rest of the project uses.
 */
function bakeUiNames(text                    )                                         {
  const raw = jsonObject(text);
  const out                                         = {};
  for (const family of UI_NAME_FAMILIES) out[family] = stringMap(raw[family]);
  for (const family of Object.keys(raw).sort()) {
    if (family in out) continue;
    out[family] = stringMap(raw[family]);
  }
  return out;
}

/**
 * One `{ index, key, name }` slot list, placed at its own `index` and padded to
 * `count` so the result can be zipped with the save's positional arrays.
 *
 * S2's tables carry `{ slots: [...] }` (ledger) or are that list directly (mana); an
 * absent or half-written table yields `count` empty slots rather than a wrong name.
 */
function slotNames(value         , count        )             {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value                           ) : undefined;
  const list = Array.isArray(value)
    ? value
    : Array.isArray(raw?.['slots'])
      ? (raw?.['slots']             )
      : [];
  const placed             = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const slot = entry                           ;
    const index = Number(slot['index']);
    if (!Number.isInteger(index) || index < 0) continue;
    placed[index] = {
      key: typeof slot['key'] === 'string' ? slot['key'] : '',
      name: typeof slot['name'] === 'string' ? slot['name'] : '',
    };
  }
  const out             = [];
  for (let i = 0; i < count; i += 1) out.push(placed[i] ?? { key: '', name: '' });
  return out;
}

/** The frozen contract's slot counts, used when S2's table does not state one. */
const LEDGER_SLOTS = { income: 19, expense: 38 };
const MANA_SLOTS = 46;

function bakeLedgerSlots(text                    )                                              {
  const raw = jsonObject(text);
  const income = raw['income'] && typeof raw['income'] === 'object' ? (raw['income']                           ) : {};
  const expense = raw['expense'] && typeof raw['expense'] === 'object' ? (raw['expense']                           ) : {};
  return {
    income: slotNames(income, Number(income['count']) || LEDGER_SLOTS.income),
    expense: slotNames(expense, Number(expense['count']) || LEDGER_SLOTS.expense),
  };
}

function bakeManaSlots(text                    )             {
  const raw = jsonObject(text);
  return slotNames(raw, Number(raw['count']) || MANA_SLOTS);
}

// ------------------------------------------------------------- the rankings ---

/**
 * 第四对话任务书 §3.5: the frozen weights, floors and board size. Every tunable lives
 * here so the formula is never re-derived inside the scoring loop.
 */
const RK_GENERAL_WEIGHTS = { skill: 0.45, war: 0.4, win: 0.15 }         ;
const RK_MONARCH_WEIGHTS = { ability: 0.35, tenure: 0.15, growth: 0.35, pace: 0.15 }         ;
const RK_MIN_GENERAL_BATTLES = 3;
/** 5 years. A shorter reign sends the per-year pace component to the ceiling. */
const RK_MIN_REIGN_MONTHS = 60;
const RK_BOARD_SIZE = 15;

                            
                                                              
              
               
               
               
                
                   
                
                     
                  
               
                
                
 

                        
                    
                                         
                                                     
                       
                         
                   
 

/** `round(value, digits)` — the file's own house style (`round3` inside `shapeCountry`). */
function rkRound(value        , digits        )         {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** §3.5's `norm()`. `max === min` hands every candidate 1, never NaN. */
function rkNorm(value        , min        , max        )         {
  if (max === min) return 1;
  const ratio = (value - min) / (max - min);
  return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

function rkMinMax(values                   )                               {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
}

/**
 * The `leader` blocks of one `countries/{TAG}` block, for the tags the panel has no
 * record of (§3.5's extended pool). `reader` must be positioned inside the country.
 */
function rkHistoryLeaders(reader                  )                     {
  const out                     = [];
  for (;;) {
    const item = reader.nextMember();
    if (!item) break;
    if (item.key !== 'history' || item.kind !== 'block') continue;
    const history = reader.enter(item);
    for (;;) {
      const entry = history.nextMember();
      if (!entry) break;
      if (entry.key === null || entry.kind !== 'block') continue;
      const body = history.enter(entry);
      for (;;) {
        const field = body.nextMember();
        if (!field) break;
        if (field.key !== 'leader' || field.kind !== 'block') continue;
        const person = readPerson(body.enter(field));
        if (!person.name) continue;
        out.push({
          // Filled with the owning tag by the caller; the key here is the person.
          tag: '',
          name: person.name,
          kind: person.kind,
          fire: person.fire,
          shock: person.shock,
          maneuver: person.maneuver,
          siege: person.siege,
          activation: person.activation,
          battles: 0,
          wins: 0,
          kills: 0,
          taken: 0,
        });
      }
    }
  }
  return out;
}

                        
                                                                                       
                   
                       
                     
 

/**
 * The monthly ownership / development replay the monarch board needs (§3.5).
 *
 * One forward sweep shared by every candidate: the province blocks hold the campaign's
 * *final* values, so the undated initial overlay rewinds to 1444 first, then the dated
 * events are applied once, in order. Readings are taken only at the ordinals a candidate
 * asks for — **no per-month series is published** (that would be megabytes). Same
 * algorithm, same `resolveTagLatest` identity merge and same dev definition as
 * `curves` in both data planes, so a monarch's `devGain` is the 兴衰曲线's own delta.
 */
function rkDevelopmentReplay(
  timeline              ,
  provinces                             ,
  aliases                     ,
  requests                         ,
)                                                                     {
  let maxId = 0;
  for (const id of provinces.keys()) if (id > maxId) maxId = id;
  const size = maxId + 1;

  const tax = new Float64Array(size);
  const production = new Float64Array(size);
  const manpower = new Float64Array(size);
  const ownerOf = new Array                    (size);
  for (const province of provinces.values()) {
    tax[province.id] = province.baseTax ?? 0;
    production[province.id] = province.baseProduction ?? 0;
    manpower[province.id] = province.baseManpower ?? 0;
    if (province.owner && province.owner !== '---' && province.owner !== 'REB') {
      ownerOf[province.id] = province.owner;
    }
  }

  const dev = new Map                ();
  const count = new Map                ();
  const devAt = (id        )         => tax[id]  + production[id]  + manpower[id] ;
  const shift = (identity        , delta        , deltaCount        )       => {
    dev.set(identity, (dev.get(identity) ?? 0) + delta);
    count.set(identity, (count.get(identity) ?? 0) + deltaCount);
  };
  const setOwner = (id        , raw        )       => {
    const next = raw === '---' || raw === 'REB' ? undefined : raw;
    const previous = ownerOf[id];
    if (previous === next) return;
    if (previous) shift(resolveTagLatest(aliases, previous), -devAt(id), -1);
    if (next) shift(resolveTagLatest(aliases, next), devAt(id), 1);
    ownerOf[id] = next;
  };
  const setDevelopment = (id        , field        , raw        )       => {
    const before = devAt(id);
    const value = Number(raw) || 0;
    if (field === 'base_tax') tax[id] = value;
    else if (field === 'base_production') production[id] = value;
    else manpower[id] = value;
    const after = devAt(id);
    const owner = ownerOf[id];
    if (owner && after !== before) shift(resolveTagLatest(aliases, owner), after - before, 0);
  };
  const apply = (id        , field        , value        )       => {
    if (field === 'owner') setOwner(id, value);
    else if (field === 'base_tax' || field === 'base_production' || field === 'base_manpower') {
      setDevelopment(id, field, value);
    }
  };

  // Seed the running tally with the save-date state, which is what the province records
  // hold. Without this the first owner change of every province would subtract
  // development that had never been added, and the total would go negative. (The curves
  // in both planes re-sum every province each month instead, so they need no seeding —
  // the totals are the same, which is what the probe cross-checks.)
  for (const province of provinces.values()) {
    const owner = ownerOf[province.id];
    if (owner) shift(resolveTagLatest(aliases, owner), devAt(province.id), 1);
  }

  for (const history of timeline.provinces.values()) {
    for (const change of history.initial) apply(history.id, change.field, change.value);
  }

  const results = requests.map(() => ({ devStart: 0, devEnd: 0, provincesGain: 0 }));
  const pending = new Map                                                          ();
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]                ;
    const points                                   = [
      ['start', request.startOrdinal],
      ['end', request.endOrdinal],
    ];
    for (const [field, ordinal] of points) {
      const list = pending.get(ordinal) ?? [];
      list.push({ index, field });
      pending.set(ordinal, list);
    }
  }

  const ordinals = [...pending.keys()].sort((a, b) => a - b);
  const events = timeline.events;
  let cursor = 0;
  for (const ordinal of ordinals) {
    while (cursor < events.length) {
      const event = events[cursor]                                  ;
      if (event.ordinal > ordinal) break;
      cursor += 1;
      for (const change of event.changes) apply(event.provinceId, change.field, change.value);
    }
    for (const request of pending.get(ordinal) ?? []) {
      const identity = (requests[request.index]                ).identity;
      const owned = count.get(identity) ?? 0;
      const record = results[request.index]                                                               ;
      if (request.field === 'start') {
        record.devStart = dev.get(identity) ?? 0;
        record.provincesGain = -owned;
      } else {
        record.devEnd = dev.get(identity) ?? 0;
        record.provincesGain += owned;
      }
    }
  }
  return results;
}

/** Build `rankings` (§3.4 shape, §3.5 formula) from the assembled country panel. */
function buildRankings(input              )           {
  const { doc, provinces, countryDetail, wars, timeline, saveDate } = input;
  const aliases = buildTagAliases(doc);

  // ---- the general candidate pool ------------------------------------------
  // `(最终国号, 姓名)` -> the people carrying that name. §3.5 keeps the list: two rulers
  // of the same name are two people, and a battle goes to the closer `activation`.
  const byKey = new Map                            ();
  const candidateTags = new Set        ();
  const addCandidate = (tag        , leader                                                                        )       => {
    if (!tag || !leader.name) return;
    const key = `${tag}\u0000${leader.name}`;
    const list = byKey.get(key) ?? [];
    // The two sources cannot normally overlap (② is read only for tags ① does not
    // know), but an exact duplicate is still dropped rather than counted twice.
    for (const existing of list) {
      if (
        existing.activation === leader.activation &&
        existing.kind === leader.kind &&
        existing.fire === leader.fire &&
        existing.shock === leader.shock &&
        existing.maneuver === leader.maneuver &&
        existing.siege === leader.siege
      ) {
        return;
      }
    }
    list.push({
      tag,
      name: leader.name,
      kind: leader.kind,
      fire: leader.fire,
      shock: leader.shock,
      maneuver: leader.maneuver,
      siege: leader.siege,
      activation: leader.activation,
      battles: 0,
      wins: 0,
      kills: 0,
      taken: 0,
    });
    byKey.set(key, list);
    candidateTags.add(tag);
  };

  // ① every leader the country panel already carries.
  for (const tag of Object.keys(countryDetail)) {
    const identity = resolveTagLatest(aliases, tag);
    for (const leader of (countryDetail[tag]                       ).leaders) {
      addCandidate(identity, leader);
    }
  }

  // ---- the battles ---------------------------------------------------------
  const resolvedTags = new Set        ();
  const commanderSides                                                                                                    = [];
  for (const war of wars) {
    for (const battle of war.battles) {
      const ordinal = ordinalOf(battle.date);
      const sides                                           = [
        [battle.attacker, battle.defender, battle.attackerWon],
        [battle.defender, battle.attacker, !battle.attackerWon],
      ];
      for (const [side, opponent, won] of sides) {
        if (!side.country) continue;
        const tag = resolveTagLatest(aliases, side.country);
        resolvedTags.add(tag);
        if (!side.commander) continue;
        commanderSides.push({
          tag,
          name: side.commander,
          ordinal,
          kills: opponent.losses ?? 0,
          taken: side.losses ?? 0,
          won,
        });
      }
    }
  }

  // ② the tags the country panel has no entry for (they no longer own a province), read
  // from `countries/{tag}/history` directly. A tag with no `history` block at all cannot
  // be read — the coverage block reports that rather than pretending otherwise.
  const missingTags = new Set        ();
  for (const tag of resolvedTags) if (!(tag in countryDetail)) missingTags.add(tag);
  if (missingTags.size > 0) {
    const countryRef = doc.section('countries');
    if (countryRef) {
      const reader = new ClausewitzReader(doc.gamestate, countryRef.start + 1, countryRef.end - 1);
      for (;;) {
        const member = reader.nextMember();
        if (!member) break;
        if (member.kind !== 'block' || member.key === null) continue;
        if (!missingTags.has(member.key)) continue;
        for (const leader of rkHistoryLeaders(reader.enter(member))) {
          addCandidate(member.key, leader);
        }
      }
    }
  }

  // ---- attribute the battles ----------------------------------------------
  let joinedSides = 0;
  for (const side of commanderSides) {
    const list = byKey.get(`${side.tag}\u0000${side.name}`);
    if (!list || list.length === 0) continue;
    joinedSides += 1;
    let target = list[0]                    ;
    if (list.length > 1) {
      // 同名多人 (§3.5): the battle goes to the person whose `activation` is closest to
      // the battle date. Counted by `tmp/a4-rankings-check.ts`, not published — `meta`'s
      // shape is frozen and this number is a report figure.
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of list) {
        const distance = Math.abs(ordinalOf(candidate.activation) - side.ordinal);
        if (distance < best) {
          best = distance;
          target = candidate;
        }
      }
    }
    target.battles += 1;
    if (side.won) target.wins += 1;
    target.kills += side.kills;
    target.taken += side.taken;
  }

  // ---- score the generals --------------------------------------------------
  const generalSkill = (candidate                  )         =>
    candidate.fire + candidate.shock + candidate.maneuver + candidate.siege;
  const generalWar = (candidate                  )         => candidate.kills - candidate.taken;

  const generalPool = [...byKey.values()].flat().filter((candidate) => candidate.battles >= 1);
  const skillRange = rkMinMax(generalPool.map(generalSkill));
  const warRange = rkMinMax(generalPool.map(generalWar));
  const generalScores = generalPool.map((candidate) => {
    const skill = rkNorm(generalSkill(candidate), skillRange.min, skillRange.max);
    const war = rkNorm(generalWar(candidate), warRange.min, warRange.max);
    const win = candidate.battles > 0 ? candidate.wins / candidate.battles : 0;
    return {
      candidate,
      skill,
      war,
      win,
      score: rkRound(
        100 *
          (RK_GENERAL_WEIGHTS.skill * skill + RK_GENERAL_WEIGHTS.war * war + RK_GENERAL_WEIGHTS.win * win),
        1,
      ),
    };
  });
  const qualifiedGenerals = generalScores.filter(
    (entry) => entry.candidate.battles >= RK_MIN_GENERAL_BATTLES,
  );
  // score ↓ → battles ↓ → skill ↓ → name ↑ (§3.5). `Array.prototype.sort` is stable, so
  // exact ties keep the deterministic pool order and the two planes agree.
  qualifiedGenerals.sort(
    (a, b) =>
      b.score - a.score ||
      b.candidate.battles - a.candidate.battles ||
      generalSkill(b.candidate) - generalSkill(a.candidate) ||
      a.candidate.name.localeCompare(b.candidate.name),
  );
  const generals                   = qualifiedGenerals.slice(0, RK_BOARD_SIZE).map((entry) => {
    const candidate = entry.candidate;
    return {
      tag: candidate.tag,
      name: candidate.name,
      kind: candidate.kind,
      fire: candidate.fire,
      shock: candidate.shock,
      maneuver: candidate.maneuver,
      siege: candidate.siege,
      skill: generalSkill(candidate),
      battles: candidate.battles,
      wins: candidate.wins,
      winRate: candidate.battles > 0 ? candidate.wins / candidate.battles : 0,
      kills: candidate.kills,
      taken: candidate.taken,
      net: candidate.kills - candidate.taken,
      score: entry.score,
      parts: { skill: entry.skill, war: entry.war, win: entry.win },
    };
  });

  // ---- the monarch candidate pool ------------------------------------------
  // Three exclusion rules (§3.5), all applied to the normalisation pool: a nameless
  // placeholder, a country whose whole record is one still-ruling entry (a reign that
  // spans the campaign), and a reign shorter than five years.
  const monarchCandidates         
                
                     
                        
                         
                       
     = [];
  for (const tag of Object.keys(countryDetail)) {
    const rulers = (countryDetail[tag]                       ).rulers;
    const identity = resolveTagLatest(aliases, tag);
    for (const ruler of rulers) {
      if (!ruler.name) continue;
      if (rulers.length === 1 && ruler.end === '') continue;
      if (ruler.months < RK_MIN_REIGN_MONTHS) continue;
      monarchCandidates.push({
        tag,
        identity,
        ruler,
        startOrdinal: ordinalOf(ruler.start),
        endOrdinal: ruler.end ? ordinalOf(ruler.end) : ordinalOf(saveDate),
      });
    }
  }

  const devResults = rkDevelopmentReplay(
    timeline,
    provinces,
    aliases,
    monarchCandidates.map((candidate) => ({
      identity: candidate.identity,
      startOrdinal: candidate.startOrdinal,
      endOrdinal: candidate.endOrdinal,
    })),
  );

  const monarchEntries = monarchCandidates.map((candidate, index) => {
    const dev = devResults[index]                                                               ;
    const devStart = rkRound(dev.devStart, 3);
    const devEnd = rkRound(dev.devEnd, 3);
    const growth = rkRound(devEnd - devStart, 3);
    const months = candidate.ruler.months;
    const pace = months > 0 ? rkRound(growth / (months / 12), 3) : 0;
    return {
      candidate,
      ability: candidate.ruler.adm + candidate.ruler.dip + candidate.ruler.mil,
      tenure: months,
      growth,
      pace,
      devStart,
      devEnd,
      provincesGain: dev.provincesGain,
    };
  });

  const abilityRange = rkMinMax(monarchEntries.map((entry) => entry.ability));
  const tenureRange = rkMinMax(monarchEntries.map((entry) => entry.tenure));
  const growthRange = rkMinMax(monarchEntries.map((entry) => entry.growth));
  const paceRange = rkMinMax(monarchEntries.map((entry) => entry.pace));
  const monarchScores = monarchEntries.map((entry) => {
    const ability = rkNorm(entry.ability, abilityRange.min, abilityRange.max);
    const tenure = rkNorm(entry.tenure, tenureRange.min, tenureRange.max);
    const growth = rkNorm(entry.growth, growthRange.min, growthRange.max);
    const pace = rkNorm(entry.pace, paceRange.min, paceRange.max);
    return {
      ...entry,
      parts: { ability, tenure, growth, pace },
      score: rkRound(
        100 *
          (RK_MONARCH_WEIGHTS.ability * ability +
            RK_MONARCH_WEIGHTS.tenure * tenure +
            RK_MONARCH_WEIGHTS.growth * growth +
            RK_MONARCH_WEIGHTS.pace * pace),
        1,
      ),
    };
  });
  // score ↓ → devGain ↓ → months ↓ → name ↑ (§3.5).
  monarchScores.sort(
    (a, b) =>
      b.score - a.score ||
      b.growth - a.growth ||
      b.tenure - a.tenure ||
      a.candidate.ruler.name.localeCompare(b.candidate.ruler.name),
  );
  const monarchs                   = monarchScores.slice(0, RK_BOARD_SIZE).map((entry) => ({
    tag: entry.candidate.tag,
    name: entry.candidate.ruler.name,
    adm: entry.candidate.ruler.adm,
    dip: entry.candidate.ruler.dip,
    mil: entry.candidate.ruler.mil,
    stats: entry.ability,
    start: entry.candidate.ruler.start,
    end: entry.candidate.ruler.end,
    months: entry.tenure,
    devStart: entry.devStart,
    devEnd: entry.devEnd,
    devGain: entry.growth,
    devPerYear: entry.pace,
    provincesGain: entry.provincesGain,
    score: entry.score,
    parts: entry.parts,
  }));

  let tagsWithLeaders = 0;
  for (const tag of resolvedTags) if (candidateTags.has(tag)) tagsWithLeaders += 1;

  return {
    meta: {
      generalPool: generalPool.length,
      generalQualified: qualifiedGenerals.length,
      monarchPool: monarchEntries.length,
      weights: {
        general: {
          skill: RK_GENERAL_WEIGHTS.skill,
          war: RK_GENERAL_WEIGHTS.war,
          win: RK_GENERAL_WEIGHTS.win,
        },
        monarch: {
          ability: RK_MONARCH_WEIGHTS.ability,
          tenure: RK_MONARCH_WEIGHTS.tenure,
          growth: RK_MONARCH_WEIGHTS.growth,
          pace: RK_MONARCH_WEIGHTS.pace,
        },
      },
      floors: { minBattles: RK_MIN_GENERAL_BATTLES, minReignMonths: RK_MIN_REIGN_MONTHS },
      coverage: {
        commandedSides: commanderSides.length,
        joinedSides,
        resolvedTags: resolvedTags.size,
        tagsWithLeaders,
      },
    },
    generals,
    monarchs,
  };
}

// --------------------------------------------------------------- entry point ---
function buildDetailTables(input             )               {
  const { doc, provinces, tagId, saveDate } = input;
  const tables = normaliseTables(input.tables);
  const province = provinceTables(provinces, tagId, tables);
  const areaWalk = areaDetails(doc, tagId);

  // `areaDetail` is keyed by the area's **index into `provinceArea.dict`** rendered as
  // a string: that is what the client has after `provinceArea.byId[provId]`, and it is
  // what 阶段任务书 §2 freezes (`{ [areaIdx: string]: … }`).
  const areaIndex = new Map(province.provinceArea.dict.map((key, i) => [key, i]));
  const areaDetail                                  = {};
  for (const [key, entry] of Object.entries(areaWalk.detail)) {
    const index = areaIndex.get(key);
    if (index === undefined) continue;
    areaDetail[String(index)] = entry;
  }

  // Province owners: only these get a country panel entry. In the sample save that is
  // 273 tags — exactly the number of countries the save gives `development`.
  const landed = new Set        ();
  for (const record of provinces.values()) {
    if (record.owner && record.owner !== '---' && record.owner !== 'REB') landed.add(record.owner);
  }

  // Owned-province aggregation: religion development, the culture table, and the two
  // wave-2 roll-ups (buildings per country, and each country's areas).
  const religionDev = new Map                                ();
  const cultureStats = new Map 
           
                                                                                               
   ();
  const buildingCounts = new Map                             ();
  const stateAgg = new Map 
           
                                                                              
   ();
  for (const record of provinces.values()) {
    const owner = record.owner;
    if (!owner || owner === '---' || owner === 'REB' || !landed.has(owner)) continue;
    const dev = (record.baseTax ?? 0) + (record.baseProduction ?? 0) + (record.baseManpower ?? 0);
    const religion = record.religion ?? '';
    const byReligion = religionDev.get(owner) ?? {};
    byReligion[religion] = (byReligion[religion] ?? 0) + dev;
    religionDev.set(owner, byReligion);

    const culture = record.culture ?? '';
    const byCulture = cultureStats.get(owner) ?? new Map();
    const tally = byCulture.get(culture) ?? { provinces: 0, dev: 0, statedProvinces: 0, statedDev: 0 };
    tally.provinces += 1;
    tally.dev += dev;
    const stated = areaWalk.statedAreas.get(owner);
    const recordArea = tables.areaById.get(record.id);
    if (stated && recordArea !== undefined && stated.has(recordArea)) {
      tally.statedProvinces += 1;
      tally.statedDev += dev;
    }
    byCulture.set(culture, tally);
    cultureStats.set(owner, byCulture);

    // 建筑统计：从各省 `buildings` 现算（契约明说不要用 `num_of_buildings_indexed`）。
    const byBuilding = buildingCounts.get(owner) ?? new Map                ();
    for (const building of record.buildings) {
      byBuilding.set(building, (byBuilding.get(building) ?? 0) + 1);
    }
    buildingCounts.set(owner, byBuilding);

    // 州：本国拥有的省按地区归拢（地区 key 来自 S2 的 area.json）。
    if (recordArea !== undefined) {
      const byArea = stateAgg.get(owner) ?? new Map();
      const agg = byArea.get(recordArea) ?? { dev: 0, stateHouse: false, hasDevastation: false };
      agg.dev += dev;
      if (record.buildings.includes('state_house')) agg.stateHouse = true;
      if ((record.devastation ?? 0) > 0) agg.hasDevastation = true;
      byArea.set(recordArea, agg);
      stateAgg.set(owner, byArea);
    }
  }

  // Baked once: the panels, the history log's value lookups and the returned `uiNames`
  // all read this one object (the two planes are compared with `JSON.stringify`).
  const bakedNames = bakeUiNames(input.tables?.uiNames);

  // The 21 base-game advisor type keys：顾问网格只列这些，某类型出现在 `countries/{TAG}/flags`
  // 里才算「已触发」（pdx-tools 同款语义）；名字优先取 `uiNames.advisors`（含 mod 的 1315 条）。
  const advisorTable = stringMap(jsonObject(input.tables?.advisorIds));
  const advisorIds = Object.keys(advisorTable)
    .sort()
    .map((id) => ({ id, name: advisorTable[id]           }));
  const wave2             = {
    buildingCounts,
    stateAgg,
    areaById: tables.areaById,
    areaNames: tables.areaNames,
    stateProsperity: areaWalk.stateProsperity,
    advisorIds,
    uiNames: bakedNames,
  };
  const wave3             = {
    ledgerSlots: bakeLedgerSlots(input.tables?.ledgerSlots),
    manaSlots: bakeManaSlots(input.tables?.manaSlots),
  };

  // The four families the dated history log prints as values, taken from the same baked
  // object the panels read (第四对话任务书 §2.5 第 2/3 项). `government` / `decisions`
  // belong to task B and are `{}` until it lands — `rkName` then returns the raw key.
  const historyNames               = {
    religions: bakedNames['religions'] ?? {},
    cultures: bakedNames['cultures'] ?? {},
    government: bakedNames['government'] ?? {},
    decisions: bakedNames['decisions'] ?? {},
  };

  // War rows for the History tab. Both planes already extracted the wars, so they are
  // handed in rather than parsed a second time.
  const warRows = new Map                             ();
  const campaignStart = input.startDate ? ordinalOf(input.startDate) : 0;
  for (const war of input.wars ?? []) {
    const joined = new Map                ();
    const left = new Map                ();
    for (const event of war.events) {
      const tags = event.tags.length > 0 ? event.tags : [];
      if (event.kind === 'add_attacker' || event.kind === 'add_defender') {
        for (const tag of tags) if (!joined.has(tag)) joined.set(tag, event.date);
      } else if (event.kind === 'rem_attacker' || event.kind === 'rem_defender') {
        for (const tag of tags) if (!left.has(tag)) left.set(tag, event.date);
      }
    }
    const participants = new Set        ([...war.attackers, ...war.defenders, ...joined.keys(), ...left.keys()]);
    const warLabel = rkWarName(war.name);
    for (const tag of participants) {
      if (!landed.has(tag)) continue;
      const rows = warRows.get(tag) ?? [];
      const start = joined.get(tag) ?? war.startDate;
      if (start && ordinalOf(start) > campaignStart) {
        rows.push({ date: start, ordinal: ordinalOf(start), kind: 'warStart', text: warLabel });
      }
      const end = left.get(tag) ?? (war.ongoing ? undefined : war.endDate);
      if (end && end !== start) {
        rows.push({ date: end, ordinal: ordinalOf(end), kind: 'warEnd', text: `退出：${warLabel}` });
      }
      warRows.set(tag, rows);
    }
  }

  const countryDetail                                      = {};
  const countryRef = doc.section('countries');
  if (countryRef) {
    const reader = new ClausewitzReader(doc.gamestate, countryRef.start + 1, countryRef.end - 1);
    let index = 0;
    for (;;) {
      const member = reader.nextMember();
      if (!member) break;
      if (member.kind !== 'block' || member.key === null) continue;
      const tag = member.key;
      const countryIndex = index;
      index += 1;
      if (!landed.has(tag)) continue;
      const scratch = readCountry(reader, member, tag, countryIndex, historyNames);
      countryDetail[tag] = shapeCountry(
        scratch,
        religionDev.get(tag) ?? {},
        cultureStats.get(tag) ?? new Map(),
        warRows.get(tag) ?? [],
        saveDate,
        input.startDate,
        wave2,
        wave3,
      );
    }
  }

  // The keys are sorted, not in walk order: it is part of the JSON both planes compare.
  const sortedCountries                                      = {};
  for (const tag of Object.keys(countryDetail).sort()) {
    sortedCountries[tag] = countryDetail[tag]                       ;
  }

  // 两张排行榜 (第四对话任务书 §3.4/§3.5). Built here, once, so the two data planes share
  // the formula; the planes only hand in the timeline they already built.
  const rankings = buildRankings({
    doc,
    provinces,
    countryDetail: sortedCountries,
    wars: input.wars ?? [],
    timeline: input.timeline ?? buildTimeline(doc),
    saveDate,
  });

  return {
    ...province,
    areaDetail,
    countryDetail: sortedCountries,
    uiNames: bakedNames,
    ledgerSlots: bakeLedgerSlots(input.tables?.ledgerSlots),
    manaSlots: bakeManaSlots(input.tables?.manaSlots),
    rankings,
  };
}


//# sourceURL=details.ts

export { SaveDocument, SaveArchive, BlockView, ClausewitzReader, readZipEntries, extractEntry, decodeEu4String, decodeSaveString, buildTimeline, buildCountryTimeline, CountryTimelinePlayer, TimelinePlayer, timelineStats, buildTagAliases, resolveTag, resolveTagLatest, readSubjectLedger, isSubjectType, NON_SUBJECT_TYPES, provincesEverMatching, frameMonths, extractWars, warStats, INSTITUTIONS, readInstitutionProgress, parseGameDate, countryScalar, countryScalarList, countryGroup, SUBJECT_SHADE, isPlaceholderColour, shadeRgb, familyTargets, foreignTintFlags, buildDetailTables };
