# PA live election-night results — TODO

Council finding #24 (2026-04-25) — scaffolded but NOT implemented.

## Source
- Landing: https://www.electionreturns.pa.gov/
- Live feed: PA Department of State publishes NIST 1500-100 XML at `https://www.electionreturns.pa.gov/api/...` (per-cycle URL discovered via the landing page).
- Vendor: in-house.

## Why this is needed
PA primary is Tue 19 May 2026. PA closes polls at 8pm ET and the unofficial returns roll in over the next ~6 hours; precinct-level reporting needs a live feed, not the canvass-day scrape.

## To implement
1. Reuse `src/lib/adapters/state-sos/nist-xml-parser.ts`.
2. Create `src/lib/adapters/state-sos/pa/live-results.ts` exporting `createPaLiveResultsAdapter`.
3. Wire it into `scripts/ingest-state-results.ts` `LIVE_ADAPTERS` map.
4. Add a smoke test under `src/lib/adapters/state-sos/pa/__tests__/`.
