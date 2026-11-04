/**
 * PDF candidate-filing extractor — skeleton.
 *
 * State of play
 * -------------
 * Many county clerks publish their candidate-filing roster as a single
 * PDF file (often a scan, sometimes text-extractable). We don't yet have
 * a real implementation — this module documents the contract so per-county
 * adapters can `import { PdfFilingExtractor }` without a circular
 * dependency once the implementation lands.
 *
 * Planned dependencies
 * --------------------
 *   - `pdfjs-dist`  — already a dep (package.json line 70). Preferred for
 *     text-extractable PDFs. Use `pdfjsLib.getDocument({ data: buffer })`,
 *     iterate pages via `getPage(n).getTextContent()`, group items by `y`
 *     coordinate to reconstruct rows.
 *   - `@sparticuz/chromium` + Playwright (already deps) for image-only
 *     scans — render each page to PNG and OCR via tesseract.js. Defer
 *     until we hit a county that actually needs it; ~80% of county PDFs
 *     are text-extractable.
 *
 * Planned flow
 * ------------
 *   1. Open the PDF buffer, extract text per page with bounding boxes.
 *   2. Group items by approximate y-coordinate to recover rows.
 *   3. Detect the column header row and build a `columnMap` (same idea as
 *      the Telerik scraper — translate "Candidate Name" → 'canonical_name').
 *   4. Emit one RawCandidacy per detected data row, with `contact_email`
 *      pulled out via a regex on the row text since most county PDFs
 *      don't have a strict email column.
 *
 * Why a skeleton today
 * --------------------
 * The framework needs the import surface stable so per-county adapters
 * can be sketched in parallel. Throwing here is preferred over a partial
 * implementation that silently returns `[]` — that would mask coverage
 * gaps in the office_ballot_coverage view.
 */

import type { RawCandidacy } from './base';

export class PdfFilingExtractor {
  /**
   * Parse a county candidate-filing PDF into RawCandidacy rows.
   *
   * @param buffer - Raw PDF bytes (typically `await fetch(url).arrayBuffer()`
   *   wrapped in `Buffer.from()`).
   * @throws Always — implementation pending. Adapters that depend on PDF
   *   ingestion should mark themselves `'pending'` in the registry until
   *   this lands rather than catching the throw and returning [].
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async extract(buffer: Buffer): Promise<RawCandidacy[]> {
    throw new Error(
      'PdfFilingExtractor.extract: not yet implemented. ' +
        'Use pdfjs-dist (already a dep) for text-layer extraction; ' +
        'see platform-pdf.ts header comment for the planned flow.',
    );
  }
}
