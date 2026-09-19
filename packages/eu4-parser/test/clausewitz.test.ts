/**
 * Tests for the Clausewitz text reader.
 *
 * The fixtures are hand-written but mirror the exact shapes real saves use,
 * including the two spellings of a keyed block (`key = { ... }` and `key{ ... }`)
 * and escape letters whose payload bytes collide with `"` and `\`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClausewitzReader, scanStringEnd } from '../src/clausewitz.ts';
import { readNode, toPlain } from '../src/value.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Parse a document body (no wrapping braces) into a plain object. */
function parseBody(source: string): Record<string, unknown> {
  const buf = utf8(source);
  const reader = new ClausewitzReader(buf, 0, buf.length);
  const out: Record<string, unknown> = {};
  for (;;) {
    const member = reader.nextMember();
    if (!member) break;
    if (member.key === null) continue;
    out[member.key] = toPlain(readNode(reader, member));
  }
  return out;
}

test('parses the flat `EU4txt` header form', () => {
  const parsed = parseBody('EU4txt\ndate=1574.11.12\nsave_game="a.eu4"\n');
  assert.deepEqual(parsed, { date: '1574.11.12', save_game: 'a.eu4' });
});

test('parses key = { ... } blocks', () => {
  const parsed = parseBody('countries={\n\tRUS={\n\t\treligion=orthodox\n\t}\n}\n');
  assert.deepEqual(parsed, { countries: { RUS: { religion: 'orthodox' } } });
});

test('parses key{ ... } blocks that omit the equals sign', () => {
  // Real saves write `map_area_data{` with no `=`.
  const parsed = parseBody('map_area_data{\n\tbrittany_area={\n\t\tstate={\n\t\t\tcountry="FRA"\n\t\t}\n\t}\n}\n');
  assert.deepEqual(parsed, {
    map_area_data: { brittany_area: { state: { country: 'FRA' } } },
  });
});

test('parses bare (unkeyed) list items into an array', () => {
  const parsed = parseBody('id_counters={ 36372 17356 29899 }\ncores={ SWE RUS }\n');
  assert.deepEqual(parsed, {
    id_counters: [36372, 17356, 29899],
    cores: ['SWE', 'RUS'],
  });
});

test('treats a token followed by neither = nor { as a bare value', () => {
  const parsed = parseBody('list={ alpha beta }\n');
  assert.deepEqual(parsed, { list: ['alpha', 'beta'] });
});

test('handles a block with no key inside a list', () => {
  const parsed = parseBody('mods={\n\t{\n\t\tfilename="mod/a.mod"\n\t}\n\t{\n\t\tfilename="mod/b.mod"\n\t}\n}\n');
  assert.deepEqual(parsed, {
    mods: [{ filename: 'mod/a.mod' }, { filename: 'mod/b.mod' }],
  });
});

test('converts negative and negative-looking keys verbatim', () => {
  const parsed = parseBody('provinces={\n\t-1={\n\t\towner="RUS"\n\t}\n\t---={\n\t\tx=1\n\t}\n}\n');
  assert.deepEqual(parsed, { provinces: { '-1': { owner: 'RUS' }, '---': { x: 1 } } });
});

test('decodes escape letters whose payload collides with " and \\', () => {
  const buf = Uint8Array.from([
    // name="\x10\x22N" -> 丢 U+4E22 (payload low byte IS the quote byte)
    0x6e, 0x61, 0x6d, 0x65, 0x3d, 0x22,
    0x10, 0x22, 0x4e,
    0x22, 0x0a,
    // other="\x10\x5c\x51" -> a payload byte equal to backslash
    0x6f, 0x74, 0x68, 0x65, 0x72, 0x3d, 0x22,
    0x10, 0x5c, 0x51,
    0x22, 0x0a,
  ]);
  const reader = new ClausewitzReader(buf, 0, buf.length);
  const out: Record<string, unknown> = {};
  for (;;) {
    const member = reader.nextMember();
    if (!member) break;
    if (member.key === null) continue;
    out[member.key] = reader.stringValue(member);
  }
  assert.equal(out['name'], '丢');
  assert.equal(out['other'], '兜');
});

test('a complete escape still ends the string at the delimiter', () => {
  // Simulates the truncated province names EU4 writes: `...\x10\xAF` then `"`.
  const buf = Uint8Array.from([0x22, 0x10, 0xaf, 0x65, 0x10, 0xaf, 0x22, 0x0a, 0x41]);
  const end = scanStringEnd(buf, 0, buf.length);
  assert.equal(end, 7, 'closing quote must be the first byte after the truncated escape');
});

test('skipBlock balances nested braces while respecting strings', () => {
  const source = 'a={ b={ c="}" d={} } e={ "{" } }\n';
  const buf = utf8(source);
  const reader = new ClausewitzReader(buf, 0, buf.length);
  const member = reader.nextMember();
  assert.ok(member);
  assert.equal(member!.key, 'a');
  assert.equal(member!.kind, 'block');
  assert.equal(reader.pos, source.length - 1, 'stops right after the closing brace');
});

test('peekMembers reports key, kind and size', async () => {
  const { peekMembers } = await import('../src/clausewitz.ts');
  const source = 'a=1\nbb={ x=1 }\nccc="hello"\n';
  const buf = utf8(source);
  const rows = peekMembers(new ClausewitzReader(buf, 0, buf.length), 10);
  assert.deepEqual(
    rows.map((r) => [r.key, r.kind]),
    [
      ['a', 'scalar'],
      ['bb', 'block'],
      ['ccc', 'string'],
    ],
  );
});
