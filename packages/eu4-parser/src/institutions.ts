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
export const INSTITUTIONS: ReadonlyArray<{ key: string; zh: string; en: string }> = [
  { key: 'feudalism', zh: '封建制度', en: 'Feudalism' },
  { key: 'renaissance', zh: '文艺复兴', en: 'Renaissance' },
  { key: 'new_world_i', zh: '殖民主义', en: 'Colonialism' },
  { key: 'printing_press', zh: '印刷术', en: 'Printing Press' },
  { key: 'global_trade', zh: '全球贸易', en: 'Global Trade' },
  { key: 'manufactories', zh: '工场手工业', en: 'Manufactories' },
  { key: 'enlightenment', zh: '启蒙运动', en: 'Enlightenment' },
  { key: 'industrialization', zh: '工业化', en: 'Industrialization' },
];

export const INSTITUTION_COUNT = INSTITUTIONS.length;

export interface InstitutionProgress {
  /** How many institutions the province has fully embraced (leading 100s). */
  embraced: number;
  /**
   * Index of the institution being embraced right now, or -1. Always equal to
   * `embraced` when set: the slot right after the leading run of 100s.
   */
  embracing: number;
  /** Embracement percentage of the in-progress institution, if any. */
  embracingProgress: number;
}

/**
 * Interpret one province's eight embracement percentages.
 *
 * Values are treated with a small tolerance so the game's `100.000` parses
 * cleanly, and a slot counts as complete only at (or above) 100.
 */
export function readInstitutionProgress(
  institutions: readonly number[] | undefined,
): InstitutionProgress {
  if (!institutions || institutions.length === 0) {
    return { embraced: 0, embracing: -1, embracingProgress: 0 };
  }
  let embraced = 0;
  while (embraced < institutions.length && (institutions[embraced] as number) >= 100) {
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
export function readEmbracedCount(flags: readonly number[] | undefined): number {
  if (!flags) return 0;
  let count = 0;
  while (count < flags.length && (flags[count] as number) >= 1) count += 1;
  return count;
}

/** Human-readable label for a slot index, for tables and legends. */
export function institutionLabel(index: number, language: 'zh' | 'en' = 'zh'): string {
  const entry = INSTITUTIONS[index];
  if (!entry) return language === 'zh' ? '无' : 'none';
  return language === 'zh' ? entry.zh : entry.en;
}

/** The institution a province is working towards, as a label. */
export function embracingLabel(index: number, language: 'zh' | 'en' = 'zh'): string {
  return index < 0 ? (language === 'zh' ? '—' : '—') : institutionLabel(index, language);
}
