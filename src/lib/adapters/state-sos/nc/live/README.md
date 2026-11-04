# NC live election-night results — TODO

Council finding #24 (2026-04-25) — scaffolded but NOT implemented.

## Source
- Landing: https://er.ncsbe.gov/
- Live feed: NC State Board of Elections publishes a NIST 1500-100 XML stream + per-county breakdowns. URL pattern: `https://er.ncsbe.gov/downloads.html?election_dt=<YYYY-MM-DD>` exposes the current-election XML.
- Vendor: in-house.

## Why this is needed
NC primary is Tue 03 Mar 2026 (Super Tuesday). Early-voting + same-day reporting roll in over ~4 hours after 7:30pm ET poll close; live coverage requires the live XML feed.

## To implement
1. Reuse `src/lib/adapters/state-sos/nist-xml-parser.ts`.
2. Create `src/lib/adapters/state-sos/nc/live-results.ts` exporting `createNcLiveResultsAdapter`.
3. Wire it into `scripts/ingest-state-results.ts` `LIVE_ADAPTERS` map.
4. Add a smoke test under `src/lib/adapters/state-sos/nc/__tests__/`.
