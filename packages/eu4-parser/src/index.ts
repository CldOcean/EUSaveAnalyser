/**
 * `@eu4/parser` — a Europa Universalis IV `.eu4` save game parser.
 *
 * The `.eu4` file is a ZIP archive holding `meta` (small header) and `gamestate`
 * (the full simulation state as Clausewitz text). See `encoding.ts` for the
 * non-obvious string encoding and `clausewitz.ts` for the text grammar.
 */

export {
  decodeEu4String,
  decodeSaveString,
  encodeEu4String,
  escapeLengthAt,
  isEscapeMarker,
  looksLikeLetterStream,
  MARKER_DELTAS,
  Eu4DecodeError,
  type DecodeOptions,
} from './encoding.ts';

export {
  ClausewitzReader,
  ClausewitzError,
  scanStringEnd,
  latin1,
  peekMembers,
  type Member,
  type ValueKind,
} from './clausewitz.ts';

export {
  SaveArchive,
  readZipEntries,
  extractEntry,
  ZipError,
  type ZipEntry,
  type InflateRaw,
} from './zip.ts';

export {
  SaveDocument,
  BlockView,
  parseMeta,
  provinceIdFromKey,
  countryScalar,
  countryScalarList,
  countryGroup,
  DEFAULT_SNAPSHOT_SECTIONS,
  type ExtractOptions,
  type LoadOptions,
} from './document.ts';

export {
  readNode,
  readAllNodes,
  toPlain,
  coerceScalar,
  toNumber,
  toBoolean,
  parseGameDate,
  formatGameDate,
  type CwNode,
  type CwBlockNode,
  type CwListNode,
  type CwScalarNode,
  type CwStringNode,
  type CwEntry,
  type GameDate,
} from './value.ts';

export {
  buildTimeline,
  timelineStats,
  TimelinePlayer,
  provincesEverMatching,
  frameDates,
  type GameTimeline,
  type ProvinceChange,
  type ProvinceHistory,
  type ProvinceHistoryEvent,
  type TimelineStats,
} from './timeline.ts';

export {
  extractWars,
  warStats,
  type Battle,
  type BattleSide,
  type PeaceTerm,
  type War,
  type WarEvent,
  type WarEventKind,
  type WarParticipant,
  type WarStats,
} from './wars.ts';

export {
  INSTITUTIONS,
  INSTITUTION_COUNT,
  readInstitutionProgress,
  readEmbracedCount,
  institutionLabel,
  embracingLabel,
  type InstitutionProgress,
} from './institutions.ts';

export {
  buildDetailTables,
  UI_NAME_FAMILIES,
  type AreaDetailEntry,
  type CountryCultureStat,
  type CountryDetailRecord,
  type CountryFailedHeir,
  type CountryHistoryRow,
  type CountryIdeaGroup,
  type CountryLeader,
  type CountryMonarch,
  type CountryRuler,
  type DetailInput,
  type DetailTableTexts,
  type DetailTables,
  type ProvinceBuildingsTable,
  type ProvinceIndexTable,
  type ProvinceNamesTable,
  type ProvinceTables,
  type ProvinceTagRowsTable,
  type RankingGeneral,
  type RankingMonarch,
  type Rankings,
  type RankingsMeta,
} from './details.ts';

export {
  SUBJECT_SHADE,
  isPlaceholderColour,
  luminance,
  toLab,
  deltaE,
  shadeRgb,
  familyTargets,
  foreignTintFlags,
  type Rgb,
} from './colours.ts';

export type {
  BlockSummary,
  CampaignStat,
  CountryRecord,
  ModInfo,
  ProvinceRecord,
  SaveMeta,
  SaveSnapshot,
  SaveVersion,
  SectionRef,
  SnapshotStats,
} from './types.ts';
