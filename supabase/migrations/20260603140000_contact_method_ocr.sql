-- Add 'ocr' to candidate_contact_fields.method (declaration harvester writes it).
-- (Forgotten in 20260603120000; surfaced when harvest-declarations.ts ran.)
alter table candidate_contact_fields drop constraint if exists candidate_contact_fields_method_check;
alter table candidate_contact_fields add constraint candidate_contact_fields_method_check
  check (method in ('bulk_parse','agent','candidate_self_report','legacy_backfill','manual','ocr'));
