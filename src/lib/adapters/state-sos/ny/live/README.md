# NY live election-night results — TODO

Council finding #24 (2026-04-25) — scaffolded but NOT implemented.

## Source
- Landing: https://www.elections.ny.gov/
- Live feed: NIST 1500-100 XML published on election night (URL pattern published per-cycle by the NY State Board of Elections; recent cycles have used `https://elections.ny.gov/.../<election-date>/...xml`).
- Vendor: NY runs election night in-house (no Clarity/Enr.com vendor URL).

## Why this is needed
On primary night (Tue 23 Jun 2026 for NY) the default `results.ts` adapter scrapes the SoS landing page, which only updates after the morning canvass. A live adapter consuming the NIST XML stream is needed for actual minute-by-minute reporting.

## To implement
1. Mirror `src/lib/adapters/state-sos/oh/live-results.ts` — it is the reference implementation using the shared NIST 1500-100 parser at `src/lib/adapters/state-sos/nist-xml-parser.ts`.
2. Create `src/lib/adapters/state-sos/ny/live-results.ts` exporting `createNyLiveResultsAdapter`.
3. Wire it into `scripts/ingest-state-results.ts` `LIVE_ADAPTERS` map.
4. Add a smoke test under `src/lib/adapters/state-sos/ny/__tests__/`.

## Open questions
- NY publishes per-county results in addition to statewide. The OH adapter is statewide-only — county breakdown can come in a follow-up.
