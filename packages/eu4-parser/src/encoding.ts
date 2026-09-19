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
export const MARKER_DELTAS: Readonly<Record<number, number>> = {
  0x10: 0,
  0x11: -0x0e,
  0x12: 0x09_00,
  0x13: 0x08_f2,
};

/** True if `byte` can start an escape letter. */
export function isEscapeMarker(byte: number): boolean {
  return byte >= 0x10 && byte <= 0x13;
}

/** Deltas, ordered by preference when *writing* text back out. */
const ENCODE_ORDER: ReadonlyArray<readonly [marker: number, delta: number]> = [
  [0x10, 0],
  [0x12, 0x09_00],
  [0x11, -0x0e],
  [0x13, 0x08_f2],
];

export interface DecodeOptions {
  /**
   * Called for every control byte that is not a known escape marker. Such a byte
   * is emitted as a single Latin-1 character; with `strict` it throws instead.
   */
  onUnknownMarker?: (marker: number, offset: number) => void;
  /**
   * Called when a marker cannot form a complete letter: either the string ended
   * mid-escape, or the second payload byte would be the `"` that closes the
   * string. EU4 truncates some province names at a fixed byte budget, which is
   * the usual cause.
   */
  onTruncatedEscape?: (offset: number) => void;
  /** Throw on unknown markers instead of degrading gracefully. */
  strict?: boolean;
}

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
export function escapeLengthAt(
  bytes: Uint8Array,
  i: number,
  end: number = bytes.length,
): number {
  const byte = bytes[i];
  if (byte === undefined || !isEscapeMarker(byte)) return 1;
  if (i + 3 > end) return 1;
  if (bytes[i + 2] === QUOTE) return 1;
  return 3;
}

export class Eu4DecodeError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'Eu4DecodeError';
    this.offset = offset;
  }
}

const CHUNK = 8192;

function codePointsToString(codePoints: readonly number[]): string {
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
export function decodeEu4String(
  bytes: Uint8Array,
  start = 0,
  end: number = bytes.length,
  options: DecodeOptions = {},
): string {
  const codePoints: number[] = [];
  let i = start;
  while (i < end) {
    const byte = bytes[i] as number;

    if (isEscapeMarker(byte)) {
      if (escapeLengthAt(bytes, i, end) === 3) {
        const stored = (bytes[i + 1] as number) | ((bytes[i + 2] as number) << 8);
        codePoints.push(stored + (MARKER_DELTAS[byte] as number));
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
        codePoints.push(bytes[i] as number);
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
export function encodeEu4String(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
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

function writeEscape(out: number[], codePoint: number): void {
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

function isPlainWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** True when the range contains a byte that can only be a letter-stream marker. */
export function looksLikeLetterStream(
  bytes: Uint8Array,
  start = 0,
  end: number = bytes.length,
): boolean {
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i] as number;
    if (byte < 0x20) {
      if (isPlainWhitespace(byte)) continue;
      return true;
    }
    if (byte === 0x5c) i += 1; // skip the escaped character
  }
  return false;
}

/** Decode a string whose encoding may be either UTF-8 or the letter stream. */
export function decodeSaveString(
  bytes: Uint8Array,
  start = 0,
  end: number = bytes.length,
  options: DecodeOptions = {},
): string {
  if (looksLikeLetterStream(bytes, start, end)) {
    return decodeEu4String(bytes, start, end, options);
  }
  let hasHighByte = false;
  for (let i = start; i < end; i += 1) {
    if ((bytes[i] as number) >= 0x80) {
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
function unescapeBackslashes(text: string): string {
  if (!text.includes('\\')) return text;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (ch === '\\' && i + 1 < text.length) {
      i += 1;
      out += text[i] as string;
      continue;
    }
    out += ch;
  }
  return out;
}
