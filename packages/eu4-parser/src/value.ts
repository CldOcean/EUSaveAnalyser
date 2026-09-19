/**
 * Generic (materialising) Clausewitz value tree.
 *
 * The streaming reader in `clausewitz.ts` is what big sections should use; this
 * module is for small documents such as the `meta` member of a save, and for
 * exploratory tooling where convenience matters more than memory.
 */

import { ClausewitzReader, type Member, type ValueKind } from './clausewitz.ts';

export type CwNode = CwScalarNode | CwStringNode | CwBlockNode | CwListNode;

export interface CwScalarNode {
  type: 'scalar';
  /** Raw text as written in the file, e.g. `1444.11.11`, `yes`, `27.000`. */
  value: string;
}

export interface CwStringNode {
  type: 'string';
  value: string;
}

export interface CwBlockNode {
  type: 'block';
  entries: CwEntry[];
}

/** A block whose members are all unkeyed, e.g. `cores={ SWE RUS }`. */
export interface CwListNode {
  type: 'list';
  items: CwNode[];
}

export interface CwEntry {
  key: string;
  value: CwNode;
}

/** Parse the value described by `member`. */
export function readNode(reader: ClausewitzReader, member: Member): CwNode {
  switch (member.kind) {
    case 'string':
      return { type: 'string', value: reader.stringValue(member) };
    case 'scalar':
      return { type: 'scalar', value: reader.rawValue(member) };
    case 'block':
      return readBlock(reader.enter(member));
  }
}

function readBlock(inner: ClausewitzReader): CwBlockNode | CwListNode {
  const entries: CwEntry[] = [];
  const items: CwNode[] = [];
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
export function readAllNodes(reader: ClausewitzReader): CwBlockNode | CwListNode {
  return readBlock(reader);
}

/** Convert a node tree into plain JSON-friendly data. */
export function toPlain(node: CwNode): unknown {
  switch (node.type) {
    case 'scalar':
      return coerceScalar(node.value);
    case 'string':
      return node.value;
    case 'list':
      return node.items.map(toPlain);
    case 'block': {
      const out: Record<string, unknown> = {};
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
export function coerceScalar(raw: string): string | number | boolean {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  if (NUMERIC.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

/** Numeric interpretation of a raw scalar, or `undefined`. */
export function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!NUMERIC.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function toBoolean(raw: string | undefined): boolean | undefined {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  return undefined;
}

export interface GameDate {
  year: number;
  month: number;
  day: number;
  /** Day counter compatible with `Date.UTC` ordering; handy for sorting. */
  ordinal: number;
}

/** Parse an EU4 date such as `1444.11.11`. */
export function parseGameDate(raw: string | undefined): GameDate | undefined {
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

export function formatGameDate(date: GameDate): string {
  return `${date.year}.${date.month}.${date.day}`;
}

export type { ValueKind };
