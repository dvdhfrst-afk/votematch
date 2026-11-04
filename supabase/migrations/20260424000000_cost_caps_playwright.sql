-- Cost cap for the Playwright fallback fetcher.
--
-- playwrightFetch launches a headless Chromium, which costs roughly
-- $0.01–0.02 per call on Vercel Fluid Compute (runtime time + memory).
-- A misconfigured loop could run up $10+ / day quickly, so we put a
-- conservative cap in cost_caps and let adapters call
-- cost_cap_check_and_consume('playwright', 0.02) before each fetch.
--
-- Default cap is $10/day — covers ~500 launches, which is plenty for
-- CF-walled SoS portals (OH candidacies ~1/day, OH CF ~1/day, each
-- state ballot measure ~1/day during filing windows). Bump it from the
-- dashboard if a legitimate burst (e.g. post-primary canvass re-scrape)
-- needs more.

INSERT INTO cost_caps (service, date, daily_usd_cap) VALUES
  ('playwright',      CURRENT_DATE, 10.00)
ON CONFLICT (service, date) DO NOTHING;

COMMENT ON COLUMN cost_caps.service IS
  'External service id. Known values: claude_api, claude_batch, census_geocoder, '
  'nominatim, wayback_cdx, resend, openfec, congress_gov, regulations_gov, '
  'scraperapi, playwright.';
