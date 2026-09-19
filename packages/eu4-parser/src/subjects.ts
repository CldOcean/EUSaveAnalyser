/**
 * Who was whose subject, and since when.
 *
 * The save keeps a `diplomacy/dependency` ledger: one entry per relation that still
 * exists, each carrying the overlord (`first`), the subject (`second`), the date it
 * began (`start_date`) and its `subject_type`. Three consequences matter for the
 * colour modes:
 *
 *   1. The date a subjection began **is** recorded, so a recoloured subject can start
 *      exactly then instead of from the campaign start.
 *   2. A relation that already ended is **not** recorded anywhere — there is no
 *      "became independent on X" to be found. That is fine in practice: the mod hands
 *      a country its own colour back when the relation ends, so a country that is
 *      independent now already carries its own colour in the save.
 *   3. A dependency is not automatically a subjection. The user's rule, and what the
 *      recolouring mod actually did in the sample save, is that 朝贡国 (tributaries)
 *      do **not** count. Trade leagues and alliances are not dependencies at all —
 *      they live in their own diplomacy blocks — so they are excluded by construction.
 */
import type { SaveDocument } from './document.ts';
import { BlockView } from './document.ts';
import { parseGameDate } from './value.ts';

export interface SubjectRelation {
  /** The senior partner, i.e. the country that ends up colouring the subject. */
  overlord: string;
  subject: string;
  /** `vassal`, `personal_union`, `crown_colony`, `tributary_state`, … */
  type: string;
  /** The date the relation began, as written in the save (may be absent). */
  date?: string;
  /** The same date as a game ordinal, for comparing against the timeline. */
  ordinal?: number;
}

/**
 * Dependency types that are **not** subjection.
 *
 * 朝贡国 pay tribute and keep their own colour, so the user's colour modes must not
 * treat them as subjects. The sample saves carry `tributary_state` and also the
 * religious ones (`nahuatl_tributary`, and by the same pattern `mayan_tributary` /
 * `inti_tributary`), which is why the check is on the name rather than one exact
 * string. Trade leagues are not dependencies at all — they live in their own
 * diplomacy block — so they are excluded by construction.
 */
export const NON_SUBJECT_TYPES = new Set(['tributary_state', 'trade_league']);

/** Whether a `subject_type` counts as 属国. */
export function isSubjectType(type: string | undefined): boolean {
  if (!type) return false;
  const lower = type.toLowerCase();
  if (NON_SUBJECT_TYPES.has(lower)) return false;
  return !lower.includes('tributary');
}

export interface SubjectLedger {
  /** subject tag -> its relation, keyed by the subject because that is what is looked up. */
  relations: Map<string, SubjectRelation>;
  /** Every `subject_type` in the ledger, with how many of each. */
  types: Map<string, number>;
  /** Relation types that are not counted as subjection. */
  excluded: SubjectRelation[];
}

/**
 * Read the dependency ledger.
 *
 * @param doc a parsed save
 */
export function readSubjectLedger(doc: SaveDocument): SubjectLedger {
  const relations = new Map<string, SubjectRelation>();
  const types = new Map<string, number>();
  const excluded: SubjectRelation[] = [];

  const diplomacy = doc.readSectionView('diplomacy');
  for (const node of diplomacy?.all('dependency') ?? []) {
    const view = BlockView.from(node);
    if (!view) continue;
    const overlord = view.string('first');
    const subject = view.string('second');
    if (!overlord || !subject) continue;
    const type = view.string('subject_type') ?? '';
    const date = view.string('start_date');
    const ordinal = date === undefined ? undefined : parseGameDate(date)?.ordinal;
    types.set(type, (types.get(type) ?? 0) + 1);
    const relation: SubjectRelation = { overlord, subject, type, date, ordinal };
    if (!isSubjectType(type)) {
      excluded.push(relation);
      continue;
    }
    relations.set(subject, relation);
  }

  return { relations, types, excluded };
}
