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

import { decodeSaveString, escapeLengthAt } from './encoding.ts';

/** Bytes treated as whitespace by the format. */
function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

const CHAR_LBRACE = 0x7b;
const CHAR_RBRACE = 0x7d;
const CHAR_QUOTE = 0x22;
const CHAR_EQUALS = 0x3d;
const CHAR_BACKSLASH = 0x5c;

export type ValueKind = 'block' | 'string' | 'scalar';

/** One parsed member header; the payload is still in the buffer. */
export interface Member {
  /** `null` for a bare (unkeyed) item inside a list block. */
  key: string | null;
  kind: ValueKind;
  /** First byte of the value: the `{`, the opening quote, or the bareword. */
  valueStart: number;
  /** One past the last byte of the value. */
  valueEnd: number;
  /**
   * For `kind === 'string'` only: range of the string *contents*, without the
   * surrounding quotes. Identical to `valueStart`/`valueEnd` otherwise.
   */
  contentStart: number;
  contentEnd: number;
}

export class ClausewitzError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
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
export function scanStringEnd(
  buf: Uint8Array,
  quoteIndex: number,
  end: number,
): number {
  let i = quoteIndex + 1;
  while (i < end) {
    const byte = buf[i] as number;
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
export class ClausewitzReader {
  readonly buf: Uint8Array;
  readonly end: number;
  pos: number;

  constructor(buf: Uint8Array, start = 0, end: number = buf.length) {
    this.buf = buf;
    this.end = end;
    this.pos = start;
  }

  atEnd(): boolean {
    return this.pos >= this.end;
  }

  peek(): number {
    return this.pos < this.end ? (this.buf[this.pos] as number) : -1;
  }

  skipWhitespace(): void {
    while (this.pos < this.end && isWhitespace(this.buf[this.pos] as number)) {
      this.pos += 1;
    }
  }

  /** Read one key or bareword token, without decoding escapes. */
  #readBareword(): { start: number; end: number } {
    const start = this.pos;
    while (this.pos < this.end) {
      const byte = this.buf[this.pos] as number;
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
  nextMember(): Member | null {
    this.skipWhitespace();
    if (this.pos >= this.end) return null;
    const lead = this.buf[this.pos] as number;
    if (lead === CHAR_RBRACE) return null;

    // --- a block with no key at all, e.g. `mods_enabled_names={ { ... } { ... } }` ---
    if (lead === CHAR_LBRACE) {
      return this.#readValue(null);
    }

    // --- read the leading token (key, or a bare value) ---
    let tokenStart: number;
    let tokenEnd: number;
    let contentStart: number;
    let contentEnd: number;
    let tokenKind: ValueKind;

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

  #decodeKey(kind: ValueKind, contentStart: number, contentEnd: number): string {
    return kind === 'string'
      ? decodeSaveString(this.buf, contentStart, contentEnd)
      : latin1(this.buf, contentStart, contentEnd);
  }

  /** Read the value at the cursor (block, string, or bareword). */
  #readValue(key: string | null): Member {
    const start = this.pos;
    const byte = this.buf[start] as number;
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
  skipBlock(): number {
    if (this.buf[this.pos] !== CHAR_LBRACE) {
      throw new ClausewitzError('expected "{"', this.pos);
    }
    let depth = 0;
    let i = this.pos;
    const end = this.end;
    while (i < end) {
      const byte = this.buf[i] as number;
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
  stringValue(member: Member): string {
    if (member.kind !== 'string') {
      throw new ClausewitzError('member is not a string', member.valueStart);
    }
    return decodeSaveString(this.buf, member.contentStart, member.contentEnd);
  }

  /** Raw (undecoded) text of a scalar or string member. */
  rawValue(member: Member): string {
    return latin1(this.buf, member.contentStart, member.contentEnd);
  }

  /** A reader positioned inside a block member, covering only its members. */
  enter(member: Member): ClausewitzReader {
    if (member.kind !== 'block') {
      throw new ClausewitzError('member is not a block', member.valueStart);
    }
    return new ClausewitzReader(this.buf, member.valueStart + 1, member.valueEnd - 1);
  }

  /** Collect every member of this region into an array. */
  readAll(): Member[] {
    const out: Member[] = [];
    for (;;) {
      const member = this.nextMember();
      if (member === null) return out;
      out.push(member);
    }
  }
}

/** Decode a run of bytes as Latin-1 (used for keys and barewords). */
export function latin1(buf: Uint8Array, start: number, end: number): string {
  let out = '';
  const chunk = 4096;
  for (let i = start; i < end; i += chunk) {
    const stop = Math.min(i + chunk, end);
    out += String.fromCharCode(...buf.subarray(i, stop));
  }
  return out;
}

/** Convenience: read the first `limit` members of a region. */
export function peekMembers(
  reader: ClausewitzReader,
  limit: number,
): Array<{ key: string | null; kind: ValueKind; size: number }> {
  const out: Array<{ key: string | null; kind: ValueKind; size: number }> = [];
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
