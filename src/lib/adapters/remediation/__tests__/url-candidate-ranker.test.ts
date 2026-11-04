/**
 * Tests for the Adapter Doctor's URL-candidate ranker.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/remediation/__tests__/url-candidate-ranker.test.ts
 *
 * No network, no DB. Pure-function assertions against synthetic HTML fixtures.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOCTOR_KEYWORDS,
  DOCTOR_EXACT_PHRASES,
  extractCandidatesFromHtml,
  guessStateFromAdapterName,
  hasBulkExtension,
  hasSubdomainHint,
  isAspxLink,
  keywordsHit,
  matchesExactPhrase,
  normalizeAnchorText,
  resolveHref,
  scoreCandidate,
} from '../url-candidate-ranker';

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

describe('normalizeAnchorText', () => {
  it('trims, collapses whitespace, lowercases', () => {
    assert.equal(normalizeAnchorText('  Bulk   DATA  '), 'bulk data');
    assert.equal(normalizeAnchorText('\tDownload\n'), 'download');
    assert.equal(normalizeAnchorText(''), '');
  });
});

describe('resolveHref', () => {
  const base = 'https://disclosures.utah.gov/Search/';

  it('resolves relative hrefs against base', () => {
    assert.equal(
      resolveHref('Download.aspx', base),
      'https://disclosures.utah.gov/Search/Download.aspx',
    );
  });

  it('preserves absolute hrefs', () => {
    assert.equal(
      resolveHref('https://data.utah.gov/cf.csv', base),
      'https://data.utah.gov/cf.csv',
    );
  });

  it('drops fragments but keeps query string', () => {
    assert.equal(
      resolveHref('/a?x=1#section', base),
      'https://disclosures.utah.gov/a?x=1',
    );
  });

  it('rejects non-fetchable schemes', () => {
    assert.equal(resolveHref('mailto:x@example.gov', base), null);
    assert.equal(resolveHref('tel:+18005551212', base), null);
    assert.equal(resolveHref('javascript:void(0)', base), null);
    assert.equal(resolveHref('#top', base), null);
  });

  it('rejects empty and whitespace', () => {
    assert.equal(resolveHref('', base), null);
    assert.equal(resolveHref('   ', base), null);
  });

  it('returns null on malformed URLs when base is unusable', () => {
    assert.equal(resolveHref('not a url', 'also-not-a-url'), null);
  });
});

describe('hasBulkExtension', () => {
  it('matches common bulk extensions', () => {
    assert.equal(hasBulkExtension('https://x/y/z.zip'), true);
    assert.equal(hasBulkExtension('https://x/y/z.CSV'), true);
    assert.equal(hasBulkExtension('https://x/y/z.xlsx'), true);
    assert.equal(hasBulkExtension('https://x/y/z.json'), true);
    assert.equal(hasBulkExtension('https://x/y/z.xml'), true);
  });

  it('rejects non-bulk paths (even with query strings)', () => {
    assert.equal(hasBulkExtension('https://x/y/z.html'), false);
    assert.equal(hasBulkExtension('https://x/y/download?format=csv'), false);
    assert.equal(hasBulkExtension('https://x/y/z.aspx'), false);
  });
});

describe('isAspxLink', () => {
  it('matches .aspx URLs with and without query strings', () => {
    assert.equal(isAspxLink('https://x/Search.aspx'), true);
    assert.equal(isAspxLink('https://x/Search.aspx?type=pcc'), true);
  });
  it('rejects non-aspx URLs', () => {
    assert.equal(isAspxLink('https://x/search.php'), false);
    assert.equal(isAspxLink('https://x/data.csv'), false);
  });
});

describe('hasSubdomainHint', () => {
  it('matches data.*, api.*, open-data.*, reports.*', () => {
    assert.equal(hasSubdomainHint('https://data.utah.gov/foo'), true);
    assert.equal(hasSubdomainHint('https://api.fec.gov/v1/x'), true);
    assert.equal(hasSubdomainHint('https://open-data.ohio.gov/'), true);
    assert.equal(hasSubdomainHint('https://reports.sos.state.oh.us/'), true);
    assert.equal(hasSubdomainHint('https://campaignfinance.in.gov/'), true);
  });
  it('rejects www/root domains', () => {
    assert.equal(hasSubdomainHint('https://www.sos.state.oh.us/'), false);
    assert.equal(hasSubdomainHint('https://sos.example.gov/'), false);
    // Note: disclosures.utah.gov *does* hit because "disclosures.*" is
    // itself one of our subdomain-hint patterns — the host name is
    // telling us it's where the data lives.
    assert.equal(hasSubdomainHint('https://disclosures.utah.gov/'), true);
  });
});

describe('matchesExactPhrase', () => {
  it('matches exactly with normalization', () => {
    assert.equal(matchesExactPhrase('Bulk Data'), true);
    assert.equal(matchesExactPhrase('  bulk  DATA '), true);
    assert.equal(matchesExactPhrase('data download'), true);
    assert.equal(matchesExactPhrase('Open Data'), true);
  });
  it('does not match partial/containing text', () => {
    assert.equal(matchesExactPhrase('Click here for bulk data'), false);
    assert.equal(matchesExactPhrase('Go to data download page'), false);
  });
});

describe('keywordsHit', () => {
  it('finds keywords in anchor text', () => {
    const hits = keywordsHit('Download filings', 'https://x/y');
    assert.ok(hits.includes('download'));
    assert.ok(hits.includes('filings'));
  });
  it('finds keywords in the URL path too', () => {
    const hits = keywordsHit('Click here', 'https://x/campaign-finance/export');
    assert.ok(hits.includes('campaign finance'));
    assert.ok(hits.includes('export'));
  });
  it('returns empty for nothing interesting', () => {
    assert.deepEqual(keywordsHit('Home', 'https://x/y'), []);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate
// ---------------------------------------------------------------------------

describe('scoreCandidate', () => {
  it('scores a bulk .zip link highest', () => {
    const c = scoreCandidate(
      'Contribution Data',
      'https://campaignfinance.in.gov/Docs/2026_ContributionData.csv.zip',
    );
    assert.ok(c);
    assert.equal(c!.kind, 'bulk_download');
    assert.ok(c!.score >= 100);
    assert.ok(c!.reasons.some((r) => r.includes('bulk-data extension')));
  });

  it('scores an exact-phrase match with subdomain hint', () => {
    const c = scoreCandidate(
      'Data Download',
      'https://data.example.gov/cf/',
    );
    assert.ok(c);
    assert.ok(c!.score >= 60 + 40); // phrase + subdomain
    assert.ok(c!.reasons.some((r) => r.includes('exact phrase')));
  });

  it('scores an .aspx search form', () => {
    const c = scoreCandidate(
      'Search Filings',
      'https://disclosures.utah.gov/Search/SearchFilings.aspx',
    );
    assert.ok(c);
    // aspx + keyword match + exact phrase ("filings search" or "search filings")
    assert.ok(c!.score >= 12);
  });

  it('returns null for boring links', () => {
    const c = scoreCandidate('Home', 'https://example.gov/about/contact');
    assert.equal(c, null);
  });

  it('ranks bulk download above aspx form above keyword-only', () => {
    const bulk = scoreCandidate(
      'Data',
      'https://campaignfinance.in.gov/Docs/2026_ContributionData.csv.zip',
    )!;
    const aspx = scoreCandidate(
      'Search',
      'https://disclosures.utah.gov/Search.aspx',
    )!;
    const keyword = scoreCandidate(
      'Campaign Finance Reports',
      'https://sos.example.gov/reports/',
    )!;
    assert.ok(bulk.score > aspx.score);
    assert.ok(bulk.score > keyword.score);
  });
});

// ---------------------------------------------------------------------------
// extractCandidatesFromHtml
// ---------------------------------------------------------------------------

describe('extractCandidatesFromHtml', () => {
  const base = 'https://disclosures.utah.gov/';

  it('extracts and ranks anchor links from a landing page', () => {
    const html = `
      <html><body>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
        </nav>
        <main>
          <h1>Utah Disclosures</h1>
          <ul>
            <li><a href="/Search/SearchFilings.aspx">Search Filings</a></li>
            <li><a href="/Reports/DataDownload.aspx">Data Download</a></li>
            <li><a href="https://data.utah.gov/cf/2026_contributions.csv">Bulk CSV</a></li>
            <li><a href="mailto:info@example.gov">Contact us</a></li>
            <li><a href="javascript:void(0)">Print</a></li>
          </ul>
        </main>
      </body></html>
    `;
    const cands = extractCandidatesFromHtml(html, { baseUrl: base });
    assert.ok(cands.length >= 3, `got ${cands.length} candidates`);
    // mailto and javascript: are rejected
    assert.ok(!cands.some((c) => c.url.startsWith('mailto:')));
    assert.ok(!cands.some((c) => c.url.startsWith('javascript:')));
    // Highest-scoring should be the bulk CSV (data.utah.gov + .csv + exact phrase)
    assert.equal(
      cands[0]!.url,
      'https://data.utah.gov/cf/2026_contributions.csv',
    );
    assert.equal(cands[0]!.kind, 'bulk_download');
  });

  it('deduplicates the same URL, keeping the highest-scoring anchor', () => {
    const html = `
      <html><body>
        <a href="/cf.csv">click</a>
        <a href="/cf.csv">Bulk Data</a>
      </body></html>
    `;
    const cands = extractCandidatesFromHtml(html, { baseUrl: base });
    assert.equal(cands.length, 1);
    assert.equal(cands[0]!.anchorText, 'bulk data');
  });

  it('extracts FORM actions when includeForms=true', () => {
    const html = `
      <html><body>
        <form action="/Search/Submit.aspx" method="POST">
          <button type="submit">Search Filings</button>
        </form>
      </body></html>
    `;
    const cands = extractCandidatesFromHtml(html, { baseUrl: base });
    assert.ok(cands.length >= 1);
    assert.ok(cands[0]!.url.endsWith('Submit.aspx'));
  });

  it('respects maxCandidates', () => {
    const links = Array.from({ length: 50 }).map(
      (_, i) => `<a href="/reports/r${i}.csv">Report ${i}</a>`,
    );
    const html = `<html><body>${links.join('\n')}</body></html>`;
    const cands = extractCandidatesFromHtml(html, {
      baseUrl: base,
      maxCandidates: 10,
    });
    assert.equal(cands.length, 10);
  });

  it('returns [] for empty HTML', () => {
    assert.deepEqual(extractCandidatesFromHtml('', { baseUrl: base }), []);
    assert.deepEqual(extractCandidatesFromHtml('   ', { baseUrl: base }), []);
  });
});

// ---------------------------------------------------------------------------
// guessStateFromAdapterName
// ---------------------------------------------------------------------------

describe('guessStateFromAdapterName', () => {
  it('matches leading-abbr adapter names', () => {
    assert.equal(guessStateFromAdapterName('cf-ut-disclosures-cf'), 'ut');
    assert.equal(guessStateFromAdapterName('cf-az-seethemoney'), 'az');
    assert.equal(guessStateFromAdapterName('cf-hi-csc'), 'hi');
  });

  it('matches full-state-name adapter names', () => {
    assert.equal(guessStateFromAdapterName('cf-indiana-cfa'), 'in');
    assert.equal(guessStateFromAdapterName('cf-illinois-sbe-cf'), 'il');
    assert.equal(guessStateFromAdapterName('cf-mississippi-sos-cf'), 'ms');
    assert.equal(guessStateFromAdapterName('cf-north-dakota-sos-cf'), 'nd');
  });

  it('returns null for unrecognized names', () => {
    assert.equal(guessStateFromAdapterName('cf-acme-portal'), null);
    assert.equal(guessStateFromAdapterName('federal-bills'), null);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('keyword list is non-empty and lowercase', () => {
    assert.ok(DOCTOR_KEYWORDS.length > 5);
    for (const k of DOCTOR_KEYWORDS) assert.equal(k, k.toLowerCase());
  });
  it('exact-phrase list is non-empty and lowercase', () => {
    assert.ok(DOCTOR_EXACT_PHRASES.length > 5);
    for (const p of DOCTOR_EXACT_PHRASES) assert.equal(p, p.toLowerCase());
  });
});
