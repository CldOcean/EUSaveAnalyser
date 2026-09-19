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

import { inflateRawSync } from 'node:zlib';

const LOCAL_FILE_HEADER_SIG = 0x04_03_4b_50;
const CENTRAL_DIRECTORY_SIG = 0x02_01_4b_50;
const END_OF_CENTRAL_DIRECTORY_SIG = 0x06_05_4b_50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIG = 0x07_06_4b_50;

const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;

export interface ZipEntry {
  name: string;
  /** Compression method: 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Byte offset of the entry's local file header. */
  localHeaderOffset: number;
}

export type InflateRaw = (data: Uint8Array, uncompressedSize: number) => Uint8Array;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

function findEndOfCentralDirectory(buf: Uint8Array): number {
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
export function readZipEntries(buf: Uint8Array): ZipEntry[] {
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

  const entries: ZipEntry[] = [];
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
  buf: Uint8Array,
  sig: number,
  from: number,
): number {
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
export function extractEntry(
  buf: Uint8Array,
  entry: ZipEntry,
  inflateRaw: InflateRaw = defaultInflateRaw,
): Uint8Array {
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

function defaultInflateRaw(data: Uint8Array, uncompressedSize: number): Uint8Array {
  const out = inflateRawSync(data, {
    maxOutputLength: Math.max(uncompressedSize, 1) + 1024,
  });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** A `.eu4` save opened as an archive of named members. */
export class SaveArchive {
  readonly entries: readonly ZipEntry[];
  readonly #buffer: Uint8Array;
  readonly #byName: Map<string, ZipEntry>;
  /** Members supplied ready-inflated instead of read out of `#buffer`. */
  readonly #inflated: Map<string, Uint8Array>;

  constructor(buffer: Uint8Array) {
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
    meta: Uint8Array,
    gamestate: Uint8Array,
    names: readonly string[] = ['meta', 'gamestate'],
  ): SaveArchive {
    const archive = new SaveArchive(new Uint8Array(0));
    archive.#inflated.set('meta', meta);
    archive.#inflated.set('gamestate', gamestate);
    for (const name of names) {
      if (!archive.#inflated.has(name)) archive.#inflated.set(name, new Uint8Array(0));
    }
    return archive;
  }

  get names(): string[] {
    if (this.entries.length) return this.entries.map((e) => e.name);
    return [...this.#inflated.keys()];
  }

  has(name: string): boolean {
    return this.#byName.has(name) || this.#inflated.has(name);
  }

  /** Read a member, or `undefined` when it is absent. */
  read(name: string): Uint8Array | undefined {
    const pre = this.#inflated.get(name);
    if (pre) return pre;
    const entry = this.#byName.get(name);
    return entry ? extractEntry(this.#buffer, entry) : undefined;
  }
}
