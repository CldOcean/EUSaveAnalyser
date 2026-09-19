/**
 * Tests for the EU4 letter-stream string encoding.
 *
 * The byte sequences used here are taken verbatim from real save files and mod
 * localisation, and were cross-checked against plain-UTF-8 sources.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_DELTAS,
  decodeEu4String,
  decodeSaveString,
  encodeEu4String,
  escapeLengthAt,
  looksLikeLetterStream,
} from '../src/encoding.ts';

const b = (...values: number[]): Uint8Array => Uint8Array.from(values);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

test('decodes pure ASCII unchanged', () => {
  assert.equal(decodeEu4String(utf8('RUS')), 'RUS');
  assert.equal(decodeEu4String(utf8('heckel ')), 'heckel ');
});

test('marker 0x10 carries a plain BMP code unit (俄罗斯)', () => {
  // meta/displayed_country_name
  const raw = b(
    0x10, 0xc4, 0x4f, // 俄 U+4FC4
    0x10, 0x57, 0x7f, // 罗 U+7F57
    0x10, 0xaf, 0x65, // 斯 U+65AF
  );
  assert.equal(decodeEu4String(raw), '俄罗斯');
});

test('marker 0x12 shifts the code unit by +0x900 (斯德哥尔摩)', () => {
  // gamestate/provinces/-1/name
  const raw = b(
    0x10, 0xaf, 0x65, // 斯 U+65AF
    0x12, 0xb7, 0x56, // stored U+56B7 -> 德 U+5FB7
    0x10, 0xe5, 0x54, // 哥 U+54E5
    0x12, 0x14, 0x53, // stored U+5314 -> 尔 U+5C14
    0x10, 0x69, 0x64, // 摩 U+6469
  );
  assert.equal(decodeEu4String(raw), '斯德哥尔摩');
});

test('marker 0x11 shifts the code unit by -14 (符腾堡)', () => {
  const raw = b(
    0x12, 0x26, 0x72, // stored U+7226 -> 符 U+7B26
    0x11, 0x8c, 0x81, // stored U+818C -> 腾 U+817E
    0x10, 0x21, 0x58, // 堡 U+5821
  );
  assert.equal(decodeEu4String(raw), '符腾堡');
});

test('marker 0x13 applies both flag bits at once', () => {
  assert.equal(MARKER_DELTAS[0x13], MARKER_DELTAS[0x12] + MARKER_DELTAS[0x11]);
  // 腾 U+817E stored under 0x13: 0x817E - 0x8F2 = 0x788C
  const raw = b(0x13, 0x8c, 0x78);
  assert.equal(decodeEu4String(raw), '腾');
});

test('single high bytes are Latin-1 code points (· U+00B7)', () => {
  const raw = b(0x10, 0x65, 0x59, 0xb7, 0x10, 0x69, 0x4f);
  assert.equal(decodeEu4String(raw), '奥·佩');
});

test('mix of CJK and ASCII inside one string', () => {
  const raw = b(
    0x10, 0x41, 0x53, // 十 U+5341
    0x10, 0x09, 0x4e, // 三 U+4E09  (payload 0x09 < 0x20)
    0x10, 0x96, 0x6b, // 殖 U+6B96
    0x10, 0x11, 0x6c, // 民 U+6C11  (payload 0x11 looks like a marker)
    0x10, 0x30, 0x57, // 地 U+5730
  );
  assert.equal(decodeEu4String(raw), '十三殖民地');
});

test('escapeLengthAt only accepts a complete, non-colliding letter', () => {
  assert.equal(escapeLengthAt(b(0x10, 0xaf, 0x65), 0), 3);
  assert.equal(escapeLengthAt(b(0x10, 0xaf), 0), 1, 'escape cut off by end of buffer');
  assert.equal(
    escapeLengthAt(b(0x10, 0xaf, 0x22), 0),
    1,
    'second payload byte would be the closing quote',
  );
  assert.equal(escapeLengthAt(b(0x41, 0x42, 0x43), 0), 1, 'ordinary ASCII byte');
  assert.equal(escapeLengthAt(b(0x09, 0x41, 0x42), 0), 1, 'tab is not a marker');
});

test('truncated escapes degrade to U+FFFD and are reported', () => {
  const offsets: number[] = [];
  const raw = b(0x10, 0xaf, 0x65, 0x10, 0xc4); // 斯 + a half-written escape
  const text = decodeEu4String(raw, 0, raw.length, {
    onTruncatedEscape: (offset) => offsets.push(offset),
  });
  // The orphaned marker becomes U+FFFD; its lone payload byte decodes normally.
  assert.equal(text, '斯\uFFFD\u00C4');
  assert.deepEqual(offsets, [3]);
});

test('unknown control bytes are reported and preserved', () => {
  const seen: number[] = [];
  const text = decodeEu4String(b(0x41, 0x02, 0x42), 0, 3, {
    onUnknownMarker: (marker) => seen.push(marker),
  });
  assert.equal(text, 'A\u0002B');
  assert.deepEqual(seen, [0x02]);
});

test('encode -> decode round-trips a CJK + ASCII corpus', () => {
  const samples = [
    '俄罗斯',
    '斯德哥尔摩',
    '符腾堡',
    '十三殖民地',
    '南方大陆',
    '萨伏依',
    'RUS',
    '卡斯蒂利亚·巴西',
    '奥凯奥温盛',
  ];
  for (const sample of samples) {
    assert.equal(decodeEu4String(encodeEu4String(sample)), sample, sample);
  }
});

test('decodeSaveString distinguishes UTF-8 from the letter stream', () => {
  // meta/save_game is plain UTF-8 in real saves.
  const utf8Samples = ['撒丁-皮埃蒙特1555_07_27.eu4', '更好的字体（我最喜欢的筑紫圆体）'];
  for (const sample of utf8Samples) {
    assert.equal(decodeSaveString(utf8(sample)), sample, sample);
    assert.equal(looksLikeLetterStream(utf8(sample)), false, sample);
  }
  // province names go through the letter stream.
  const letterStream = b(0x10, 0xc4, 0x4f, 0x10, 0x57, 0x7f, 0x10, 0xaf, 0x65);
  assert.equal(looksLikeLetterStream(letterStream), true);
  assert.equal(decodeSaveString(letterStream), '俄罗斯');
});

test('all four markers agree on a 0x100 stride relationship', () => {
  // 0x11 is the low flag bit, 0x12 the high one; 0x13 is both.
  assert.deepEqual(
    [MARKER_DELTAS[0x10], MARKER_DELTAS[0x11], MARKER_DELTAS[0x12], MARKER_DELTAS[0x13]],
    [0, -14, 2304, 2290],
  );
});
