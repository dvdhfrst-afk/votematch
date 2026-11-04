/**
 * parser-registry.ts -- canonical PARSER_REGISTRY + parserFor for the Phase 0
 * source-centric harvest engine.
 *
 * WHY a separate file: source-harvest-runner.ts defines the SourceParser
 * interface; each of the five parser files imports ONLY types from the runner
 * (import type {...}), so there is no runtime circular dependency. However,
 * importing the five concrete parser consts INTO the runner would create a
 * potential static import cycle. Keeping the wiring here is the cleaner
 * layering: runner defines contracts, parsers implement them, this registry
 * binds them, the CLI imports from here.
 *
 * Mapping (source_type -> parser), covering all five constrained types that
 * have parsers. 'party_slate' has no Build-5 parser yet; parserFor returns
 * null for it and the CLI already handles that case.
 *
 * source_type CHECK values (from the migration):
 *   'forum_video' | 'news_guide' | 'endorsement_org' |
 *   'party_slate'  | 'finance_bulk' | 'legislative_record'
 */

import { manualTextParser, type SourceParser } from './source-harvest-runner';
import { forumVideoParser } from './parsers/forum-video';
import { endorsementParser } from './parsers/endorsement';
import { newsQaParser } from './parsers/news-qa';
import { legislativeRecordParser } from './parsers/legislative-record';
import { financeParser } from './parsers/finance';

/** Complete registry of all Phase 0 parsers, keyed by source_type. */
export const PARSER_REGISTRY: Record<string, SourceParser> = {
  manual_text: manualTextParser,
  forum_video: forumVideoParser,
  endorsement_org: endorsementParser,
  news_guide: newsQaParser,
  legislative_record: legislativeRecordParser,
  finance_bulk: financeParser,
};

/**
 * Look up the parser for a source_type.
 * Returns null (not undefined) when no parser is registered for that type
 * (e.g. 'party_slate' which has no Build yet).
 */
export function parserFor(sourceType: string): SourceParser | null {
  return PARSER_REGISTRY[sourceType] ?? null;
}
