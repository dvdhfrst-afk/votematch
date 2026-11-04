# `adapters/county-clerk/`

County-clerk **candidate-filing** adapters — the people who actually appear on
the local ballot. Distinct from `adapters/municipal/`, which targets
meeting-platforms (Granicus, Legistar) for council/committee/board agendas.

## Why this namespace exists

State Secretary-of-State portals only carry federal + state offices for most
states. Sub-state offices (county commissioner, sheriff, school board,
municipal court, justice of the peace, etc.) — which dominate ballot length —
live with the **county clerk / county election office**. There is no national
feed; each county publishes filings differently.

Without filing-direct coverage we mark these offices as "inferred from SoS
roster" — which is wrong for most local races. The `offices.sourcing_tier`
column (added in `supabase/migrations/20260427000001_office_ballot_coverage.sql`)
flips from `roster_only` to `filing_direct` once a county-clerk adapter
populates the candidacy.

## Sourcing-tier marker

Rows produced by adapters in this namespace MUST set
`offices.sourcing_tier = 'filing_direct'` on upsert. The
`office_ballot_coverage` view rolls this up so the UI can show a per-county
"we read the actual filing" badge vs. an "inferred" warning.

## Licensing

Candidate filings are public record under every state's election code — so
they ingest as `license = 'public_domain'` on the `data_sources` row. They
are **not** subject to the CC-BY-SA share-alike concern that bars
OpenStates / Wikipedia / Ballotpedia in this codebase
(see `feedback_no_share_alike_licenses` in user memory).

## Contents

```
base.ts                       # CountyClerkAdapter interface + BaseCountyClerkAdapter
platform-telerik-radgrid.ts   # Reusable RadGrid HTML extractor (Montana pattern)
platform-pdf.ts               # PDF skeleton — throws "not yet implemented"
registry.ts                   # ${state}-${fips_county} → adapter factory
__tests__/                    # node:test suites
```

## Adding a new county adapter

1. Create `<state-lower>/<county-key>.ts` (e.g. `tx/harris.ts`).
2. Extend `BaseCountyClerkAdapter` from `./base`.
3. Choose a platform helper:
   - **Telerik RadGrid?** Use `TelerikRadGridScraper` from `platform-telerik-radgrid.ts`.
   - **PDF roster?** Use `PdfFilingExtractor` from `platform-pdf.ts`
     (currently throws — implement first if you're the canary county).
   - **Bespoke HTML?** Reuse `state-sos/html-table.ts` for plain `<table>`s.
4. Implement `fetchFilings(election_year)` — fetch + parse only.
5. Implement `run()` and `insert()` — wrap `fetchFilings()`, attach a
   `DataSourceDescriptor`, then route through
   `state-sos/candidacies-shared.ts#insertGenericCandidacies` so person
   resolution / candidacy upsert / party-line attachment all reuse the
   tested pipeline.
6. Register in `registry.ts` with `'TX-201': () => new HarrisCountyAdapter()`.
7. Add a `__tests__/<county>.test.ts` that runs against a saved HTML/PDF
   fixture in `__tests__/fixtures/`.

## Priority — which counties first?

Rank by **registered voter population**, since one county adapter fills the
ballot for every voter in that county. Top 5 (US Census 2020 + 2024 voter file
estimates):

| Rank | State-FIPS | County                        | Voters (~M) | Likely platform           |
|------|------------|-------------------------------|-------------|----------------------------|
| 1    | CA-037     | Los Angeles County, CA        | 6.0         | Bespoke HTML / CSV (LAVote) |
| 2    | IL-031     | Cook County, IL               | 3.3         | ASP.NET / Telerik          |
| 3    | TX-201     | Harris County, TX             | 2.5         | Bespoke HTML (HarrisVotes) |
| 4    | AZ-013     | Maricopa County, AZ           | 2.5         | Bespoke HTML / PDF         |
| 5    | CA-073     | San Diego County, CA          | 1.9         | Bespoke HTML / PDF         |

Filling these five alone covers ~16M voters' down-ballot races — roughly
8% of the national electorate.
