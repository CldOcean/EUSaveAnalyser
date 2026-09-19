/*
 * Browser-side reader for .eu4 saves.
 *
 * Deliberately NOT the full parser: showing a save's date, player, version and
 * mod list only needs the `meta` member of the zip, which is about 3 KB. The
 * 57 MB `gamestate` member is what makes server-side parsing impossible on
 * Cloudflare (10 ms CPU / 128 MB memory), and nothing here touches it.
 *
 * Self-contained on purpose - no build step, no imports, no Node built-ins:
 *   * the zip central directory is walked by hand (same layout as the parser's
 *     own zip.ts, which cannot run in a browser),
 *   * raw deflate is handled by the browser's own DecompressionStream,
 *   * the "letter stream" string encoding is reimplemented from
 *     packages/eu4-parser/src/encoding.ts (markers 0x10-0x13 with their deltas).
 *
 * It is an ES module so the browser loads it directly and Node can import it for
 * tests - no bundler, no build step.
 */
const QUOTE = 0x22;
const MARKER_DELTAS = { 0x10: 0, 0x11: -14, 0x12: 0x900, 0x13: 0x8f2 };

/** One entry of the zip central directory. */
export function readZipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // End of central directory: scan backwards over the (at most 64 KB) comment.
    let eocd = -1;
    const lowest = Math.max(0, bytes.length - 66000);
    for (let i = bytes.length - 22; i >= lowest; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('这不是一个 zip 文件（没找到中央目录）');
    const count = view.getUint16(eocd + 10, true);
    let at = view.getUint32(eocd + 16, true);
    const entries = [];
    for (let n = 0; n < count; n += 1) {
      if (view.getUint32(at, true) !== 0x02014b50) break;
      const method = view.getUint16(at + 10, true);
      const compressedSize = view.getUint32(at + 20, true);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const offset = view.getUint32(at + 42, true);
      const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
      entries.push({
        name: new TextDecoder('utf-8').decode(nameBytes),
        method,
        compressedSize,
        size,
        offset,
      });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  /** Raw deflate -> bytes, using the browser's own decompressor. */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('这个浏览器不支持 DecompressionStream，无法解压存档');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Pull one member out of the archive (stored or deflated). */
  async function extractMember(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error('zip 本地头损坏');
    const nameLength = view.getUint16(entry.offset + 26, true);
    const extraLength = view.getUint16(entry.offset + 28, true);
    const start = entry.offset + 30 + nameLength + extraLength;
    const payload = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return payload;
    if (entry.method === 8) return inflateRaw(payload);
    throw new Error(`不支持的压缩方式 ${entry.method}`);
  }

  /**
   * EU4 "letter stream" -> string. A byte >= 0x20 is a Latin-1 character; the
   * markers 0x10-0x13 start a three-byte escape holding a shifted UTF-16 unit.
   * An escape is only three bytes when both payload bytes exist and the second
   * one is not the closing quote (EU4 truncates some strings mid-escape).
   */
  export function decodeLetterStream(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; ) {
      const byte = bytes[i];
      const delta = MARKER_DELTAS[byte];
      if (delta !== undefined && i + 3 <= bytes.length && bytes[i + 2] !== QUOTE) {
        out += String.fromCharCode((bytes[i + 1] | (bytes[i + 2] << 8)) + delta);
        i += 3;
      } else if (byte >= 0x20) {
        out += String.fromCharCode(byte);
        i += 1;
      } else {
        out += String.fromCharCode(byte);
        i += 1;
      }
    }
    return out;
  }

  const latin1 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  };
  const latin1ToBytes = (text) => {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  };
  const utf8 = (text) => new TextDecoder('utf-8').decode(latin1ToBytes(text));

  /**
   * The `meta` member is a flat `key=value` list with braced blocks, so it needs
   * only a tiny recursive reader rather than the full Clausewitz grammar: keys
   * keep their order, repeated keys become arrays, and bare items inside a block
   * collect into its `$list`.
   */
  export function parseMeta(text) {
    let at = 0;
    const skip = () => {
      while (at < text.length && /\s/.test(text[at])) at += 1;
    };
    const readValue = () => {
      skip();
      const ch = text[at];
      if (ch === '{') return readBlock();
      if (ch === '"') {
        at += 1;
        const start = at;
        while (at < text.length && text[at] !== '"') at += 1;
        const value = text.slice(start, at);
        at += 1;
        return value;
      }
      const start = at;
      while (at < text.length && !/[\s{}"]/.test(text[at])) at += 1;
      return text.slice(start, at);
    };
    const readBlock = () => {
      at += 1; // consume '{'
      const block = { $list: [] };
      for (;;) {
        skip();
        if (at >= text.length) break;
        if (text[at] === '}') {
          at += 1;
          break;
        }
        // `key = value` or a bare item (a string, or a whole nested block).
        const start = at;
        let key = null;
        if (text[at] === '"') {
          key = readValue();
          skip();
          if (text[at] !== '=') {
            block.$list.push(key);
            continue;
          }
          at += 1;
          block[key] = readValue();
          continue;
        }
        while (at < text.length && !/[\s{}=]/.test(text[at])) at += 1;
        const word = text.slice(start, at);
        skip();
        if (text[at] === '=') {
          at += 1;
          const value = readValue();
          if (key === null && Object.prototype.hasOwnProperty.call(block, word)) {
            if (!Array.isArray(block[word])) block[word] = [block[word]];
            block[word].push(value);
          } else {
            block[word] = value;
          }
          continue;
        }
        if (text[at] === '{') block.$list.push(readBlock());
        else if (word) block.$list.push(word);
      }
      return block;
    };

    const root = {};
    for (;;) {
      skip();
      if (at >= text.length) break;
      const start = at;
      while (at < text.length && !/[\s{}=]/.test(text[at])) at += 1;
      const key = text.slice(start, at);
      skip();
      if (text[at] !== '=') {
        if (!key) at += 1;
        continue;
      }
      at += 1;
      root[key] = readValue();
    }
    return root;
  }

  /**
   * Extract and inflate the members a *full* parse needs.
   *
   * The bundled parser (public/eu4-parser.js) cannot inflate synchronously, so
   * the page inflates here with the browser's own DecompressionStream and hands
   * the bytes to SaveDocument.fromMembers().
   */
  export async function readMembers(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const entries = readZipEntries(bytes);
    const members = { names: entries.map((entry) => entry.name) };
    for (const name of ['meta', 'gamestate']) {
      const entry = entries.find((candidate) => candidate.name === name);
      if (entry) members[name] = await extractMember(bytes, entry);
    }
    return members;
  }

  /**
   * Read the interesting fields out of a save file.
   * @param {ArrayBuffer|Uint8Array} input
   * @returns {Promise<object>} the SaveInfo shape the catalogue API stores
   */
export async function readSaveInfo(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const entries = readZipEntries(bytes);
    const metaEntry = entries.find((entry) => /(^|\/)meta$/.test(entry.name));
    if (!metaEntry) throw new Error('存档里没有 meta 成员，可能不是 EU4 存档');
    const raw = await extractMember(bytes, metaEntry);
    const meta = parseMeta(latin1(raw));

    // `player` is a tag; the Chinese name is stored letter-stream encoded.
    const playerTag = typeof meta.player === 'string' ? meta.player : undefined;
    let displayed = '';
    if (typeof meta.displayed_country_name === 'string') {
      displayed = decodeLetterStream(latin1ToBytes(meta.displayed_country_name));
    }
    const version = meta.savegame_version || {};
    const versionText = [version.first, version.second, version.third, version.forth]
      .filter((part) => part !== undefined && part !== '')
      .join('.');

    const modBlocks = meta.mods_enabled_names;
    const modNames = [];
    if (modBlocks && Array.isArray(modBlocks.$list)) {
      for (const block of modBlocks.$list) {
        if (block && typeof block === 'object' && typeof block.name === 'string') {
          modNames.push(utf8(block.name));
        }
      }
    }
    const dlc = meta.dlc_enabled;
    const dlcCount = dlc && Array.isArray(dlc.$list) ? dlc.$list.length : 0;

    return {
      campaignDate: typeof meta.date === 'string' ? meta.date : undefined,
      player: displayed || playerTag,
      playerTag,
      version: versionText || undefined,
      dlcCount,
      mods: modNames,
      saveGame: typeof meta.save_game === 'string' ? utf8(meta.save_game) : undefined,
      members: entries.map((entry) => entry.name),
    };
}
