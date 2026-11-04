/**
 * Tests for the Telerik RadGrid extractor.
 *
 * Self-contained — no DB, no network. Run via:
 *
 *   npx tsx --test src/lib/adapters/county-clerk/__tests__/platform-telerik-radgrid.test.ts
 *
 * Mirrors the test harness used by `municipal/__tests__/base.test.ts`
 * (node:test + node:assert) so it composes with the rest of the project's
 * `tsx --test` runs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TelerikRadGridScraper } from '../platform-telerik-radgrid';

describe('TelerikRadGridScraper', () => {
  it('extracts rows from a populated RadGrid', () => {
    const html = `
      <html><body>
        <div class="RadGrid">
          <table class="rgMasterTable" border="0">
            <thead>
              <tr class="rgHeader">
                <th class="rgHeader">Candidate</th>
                <th class="rgHeader">Party</th>
                <th class="rgHeader">Office</th>
                <th class="rgHeader">District</th>
                <th class="rgHeader">Email</th>
              </tr>
            </thead>
            <tbody>
              <tr class="rgRow">
                <td>Jane DOE</td>
                <td>R</td>
                <td>County Commissioner</td>
                <td>District&nbsp;3</td>
                <td>jane@example.org</td>
              </tr>
              <tr class="rgAltRow">
                <td>John Smith</td>
                <td>D</td>
                <td>County Commissioner</td>
                <td>District 3</td>
                <td>john@example.org</td>
              </tr>
            </tbody>
          </table>
        </div>
      </body></html>
    `;

    const rows = new TelerikRadGridScraper().extractRows(html, {
      Candidate: 'canonical_name',
      Party: 'party',
      Office: 'office_canonical_name',
      District: 'district',
      Email: 'contact_email',
    });

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      canonical_name: 'Jane DOE',
      party: 'R',
      office_canonical_name: 'County Commissioner',
      district: 'District 3',
      contact_email: 'jane@example.org',
    });
    assert.equal(rows[1].canonical_name, 'John Smith');
    assert.equal(rows[1].district, 'District 3');
  });

  it('returns [] for an empty grid (rgNoRecords placeholder)', () => {
    const html = `
      <table class="rgMasterTable">
        <thead>
          <tr class="rgHeader">
            <th>Candidate</th><th>Party</th>
          </tr>
        </thead>
        <tbody>
          <tr class="rgNoRecords"><td colspan="2">No records to display.</td></tr>
        </tbody>
      </table>
    `;

    const rows = new TelerikRadGridScraper().extractRows(html, {
      Candidate: 'canonical_name',
      Party: 'party',
    });

    assert.deepEqual(rows, []);
  });

  it('returns [] when no RadGrid is present in the HTML', () => {
    const rows = new TelerikRadGridScraper().extractRows(
      '<html><body><p>No grid here.</p></body></html>',
      { Candidate: 'canonical_name' },
    );
    assert.deepEqual(rows, []);
  });
});
