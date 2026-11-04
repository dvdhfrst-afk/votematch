# GA live election-night results — TODO

Council finding #24 (2026-04-25) — scaffolded but NOT implemented.

## Source
- Landing: https://results.enr.clarityelections.com/GA/
- Live feed: GA outsources election-night reporting to Clarity Elections (Scytl). The Clarity vendor publishes a JSON + XML feed at `https://results.enr.clarityelections.com/GA/<electionId>/<reportNum>/json/electionsettings.json` and `summary.json`. URL discovery: scrape the landing page for the current-cycle election ID.
- Vendor: Clarity Elections (used by GA, AR, KS, KY, NC partial, TN partial, others).

## Why this is needed
GA primary is Tue 19 May 2026. Clarity feeds update every ~30 seconds during election night with precinct-level reporting. The default `results.ts` adapter scrapes the canvass page; live coverage needs the Clarity JSON.

## To implement
1. Build a generic `clarity-elections-parser.ts` under `src/lib/adapters/state-sos/shared/` since this vendor is reused across many states.
2. Create `src/lib/adapters/state-sos/ga/live-results.ts` exporting `createGaLiveResultsAdapter`.
3. Wire it into `scripts/ingest-state-results.ts` `LIVE_ADAPTERS` map.
4. Add a smoke test under `src/lib/adapters/state-sos/ga/__tests__/`.

## Open questions
- Clarity returns sub-county precinct breakdowns; we may want to start statewide-only and add a precinct-level endpoint as a follow-up.
- License: Clarity is a private vendor. GA Open Records Act covers the underlying election results, but the exact endpoint TOS may restrict commercial scraping. Verify before production use.
