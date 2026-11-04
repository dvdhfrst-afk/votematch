-- SPI (Sensitive Personal Information) consent tracking for quick-match.
--
-- Context (see 15-council/00-initial-review-2026-04-20.md, Legal Lens #4):
-- Political preferences submitted through the quick-match flow are Sensitive
-- Personal Information in 15+ states (CO, VA, CT, MT, OR, DE, TX, NJ, NH, MD,
-- MN, KY, IN, RI, plus UT via HB 491 — state + locality). The subscribe path
-- already gates on explicit opt-in; quick-match did not. This migration adds
-- the audit column so we can prove, per-user, when consent was given.
--
-- The timestamp is the source of truth for "has this user consented?" — if
-- NULL, the match API refuses to persist quick_match_answers. A session
-- cookie mirrors this value for fast client-side checks, but the DB column
-- is the legal-grade record.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS spi_consent_at TIMESTAMPTZ;

COMMENT ON COLUMN users.spi_consent_at IS
  'Timestamp of explicit opt-in to process political preferences as SPI. '
  'NULL means no consent on file; quick-match answers MUST NOT be persisted '
  'until this is set. See 15-council/00-initial-review-2026-04-20.md.';
