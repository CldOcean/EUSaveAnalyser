/**
 * Religion colour table reader.
 *
 * EU4 defines `color = { R G B }` per religion in `common/religions/*.txt`,
 * nested inside a religion *group*:
 *
 *   christian = {                 # group
 *       catholic  = { color = { 204 204 0 } ... }
 *       orthodox  = { color = { 178 127 0 } ... }
 *   }
 *
 * These config files use `#` comments, which save files never do, so this is a
 * small line-based reader rather than the save parser.
 */
import { readFileSync } from 'node:fs';

export type RGB = [number, number, number];

export interface ReligionColor {
  religion: string;
  group: string;
  rgb: RGB;
  /** File it came from, so conflicts between base game and mods are visible. */
  source: string;
}

export interface ReligionTable {
  /** religion -> colour, later sources winning. */
  colors: Map<string, RGB>;
  /** group name -> colour, when the group itself declares one. */
  groups: Map<string, RGB>;
  /** Every definition seen, including overridden ones. */
  all: ReligionColor[];
}

const BLOCK = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{/;
const COLOR = /\bcolor\s*=\s*\{\s*(\d+)\s+(\d+)\s+(\d+)\s*\}/;

/**
 * Parse one religions file.
 *
 * @param source label recorded on every entry (e.g. `base`, `mod 2935149060`)
 */
export function parseReligionFile(path: string, source: string): ReligionColor[] {
  const text = readFileSync(path, 'latin1');
  const out: ReligionColor[] = [];
  const stack: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    const colorMatch = COLOR.exec(line);
    if (colorMatch) {
      const rgb: RGB = [
        Number(colorMatch[1]),
        Number(colorMatch[2]),
        Number(colorMatch[3]),
      ];
      const owner = stack[stack.length - 1];
      if (owner) {
        out.push({
          religion: owner,
          group: stack[stack.length - 2] ?? '',
          rgb,
          source,
        });
      }
    }
    // Track nesting. A line may open a block; closers are counted per line.
    const open = BLOCK.exec(line);
    if (open) stack.push(open[1] as string);
    const closes = (line.match(/\}/g) ?? []).length;
    // `color = { r g b }` closes on the same line, so discount it.
    const sameLine = colorMatch ? 1 : 0;
    for (let i = 0; i < closes - sameLine; i += 1) stack.pop();
  }
  return out;
}

/** Merge a base file with mod overrides, later entries winning. */
export function loadReligionTable(
  sources: ReadonlyArray<{ path: string; source: string }>,
): ReligionTable {
  const all: ReligionColor[] = [];
  for (const { path, source } of sources) {
    try {
      all.push(...parseReligionFile(path, source));
    } catch {
      // A missing or unreadable override is not fatal.
    }
  }
  const colors = new Map<string, RGB>();
  const groups = new Map<string, RGB>();
  for (const entry of all) {
    colors.set(entry.religion, entry.rgb);
    if (entry.group) groups.set(entry.group, entry.rgb);
  }
  return { colors, groups, all };
}

export function toHex(rgb: RGB): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
