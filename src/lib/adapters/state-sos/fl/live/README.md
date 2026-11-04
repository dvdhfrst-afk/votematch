# FL live election-night results — TODO

Council finding #24 (2026-04-25) — scaffolded but NOT implemented.

## Source
- Landing: https://results.elections.myflorida.com/
- Live feed: FL Division of Elections publishes both an XML feed and tab-delimited dumps on election night under `dos.elections.myflorida.com/...`. Per-cycle URLs vary; the index page at the landing URL exposes the live snapshot link.
- Vendor: in-house (no third-party vendor URL).

## Why this is needed
The default `results.ts` adapter scrapes the canvass-day landing page. FL's primary is Tue 18 Aug 2026 (general); the August primary tends to update at 7pm/8pm rolling closes, and a live adapter is needed to track precinct-level reporting in real time.

## To implement
1. The FL feed is NOT NIST 1500-100 — it is a state-specific XML schema. Do not use `nist-xml-parser.ts`.
2. Mirror `src/lib/adapters/state-sos/fl/results.ts` for the URL discovery pattern; replace the parser with a custom one for the live XML.
3. Create `src/lib/adapters/state-sos/fl/live-results.ts` exporting `createFlLiveResultsAdapter`.
4. Wire it into `scripts/ingest-state-results.ts` `LIVE_ADAPTERS` map.
5. Add a smoke test under `src/lib/adapters/state-sos/fl/__tests__/`.
