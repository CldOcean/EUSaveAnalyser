/*
 * Game colour tables, read in the browser.
 *
 * EU4 defines a colour per religion in `common/religions/*.txt`, nested inside a
 * religion *group*:
 *
 *   christian = {                 # group
 *       catholic  = { color = { 204 204 0 } ... }
 *       orthodox  = { color = { 178 127 0 } ... }
 *   }
 *
 * Mods ship files with the same names that override the base game, and the save
 * lists which mods were enabled in which order - so the page merges the files in
 * that order, later winning, exactly like `scripts/lib/religions.ts` does
 * offline. The two must agree; apps/site/test/game-tables.test.ts checks them
 * against each other on the real files.
 */

const BLOCK = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{/;
const COLOR = /\bcolor\s*=\s*\{\s*(\d+)\s+(\d+)\s+(\d+)\s*\}/;

/**
 * Parse one religions file.
 * @param {string} text the file's contents (latin1)
 * @param {string} source label recorded on every entry (e.g. `base`, `mod 123`)
 */
export function parseReligionText(text, source) {
  const out = [];
  const stack = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    const colorMatch = COLOR.exec(line);
    if (colorMatch) {
      const owner = stack[stack.length - 1];
      if (owner) {
        out.push({
          religion: owner,
          group: stack[stack.length - 2] ?? '',
          rgb: [Number(colorMatch[1]), Number(colorMatch[2]), Number(colorMatch[3])],
          source,
        });
      }
    }
    // Track nesting. A line may open a block; closers are counted per line.
    const open = BLOCK.exec(line);
    if (open) stack.push(open[1]);
    const closes = (line.match(/\}/g) ?? []).length;
    // `color = { r g b }` closes on the same line, so discount it.
    const sameLine = colorMatch ? 1 : 0;
    for (let i = 0; i < closes - sameLine; i += 1) stack.pop();
  }
  return out;
}

/**
 * Merge base + mod files, later entries winning.
 *
 * The group colour quirk is preserved on purpose: the offline reader maps every
 * entry's colour onto its group as it goes, so a group ends up with the colour of
 * its last religion. Odd, but the two implementations must not disagree.
 *
 * @param {Array<{text: string, source: string}>} sources in load order
 */
export function loadReligionTable(sources) {
  const all = [];
  for (const { text, source } of sources) {
    try {
      all.push(...parseReligionText(text, source));
    } catch {
      // A missing or unreadable override is not fatal.
    }
  }
  const colors = new Map();
  const groups = new Map();
  for (const entry of all) {
    colors.set(entry.religion, entry.rgb);
    if (entry.group) groups.set(entry.group, entry.rgb);
  }
  return { colors, groups, all };
}

/** [r,g,b] -> `#rrggbb`. */
export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}
