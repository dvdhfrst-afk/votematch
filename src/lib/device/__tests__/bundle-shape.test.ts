/**
 * Bundle-shape contract test (work-order 1A deliverable 3).
 *
 * The /api/positions-bundle route projects resolved candidates+positions into
 * the lean PositionsBundle. Standing up the full route needs a live DB + a
 * session cookie; instead we assert the SHAPE contract against the real bundle
 * the capture probe emitted (built by the same projection the route performs).
 * This locks the public-only, lean, no-citation-text guarantees the device and
 * the 1B/1C agents depend on.
 */
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/match-parity.json';
import {
  POSITIONS_BUNDLE_VERSION,
  type PositionsBundle,
} from '../bundle';

const bundle = fixture.bundle as unknown as PositionsBundle;

describe('positions bundle — shape contract', () => {
  it('carries version + generatedAt + races + subDimensions', () => {
    // v2 (work-order 1B item 3): POSITIONS_BUNDLE_VERSION was bumped 1 -> 2 when
    // matchingFlags was added, so this pins the current schema version (2).
    expect(bundle.version).toBe(POSITIONS_BUNDLE_VERSION);
    expect(typeof bundle.generatedAt).toBe('string');
    expect(Array.isArray(bundle.races)).toBe(true);
    expect(Array.isArray(bundle.subDimensions)).toBe(true);
    expect(bundle.subDimensions.length).toBeGreaterThan(0);
  });

  it('carries server-resolved matchingFlags (v2 flag-parity contract)', () => {
    // v2 adds matchingFlags so the client matcher runs the same office-dims /
    // multivariable branch the production server does. The device + 1B/1C agents
    // depend on this being present and boolean-typed.
    expect(bundle.matchingFlags).toBeDefined();
    expect(typeof bundle.matchingFlags?.respectOfficeDims).toBe('boolean');
    expect(typeof bundle.matchingFlags?.multivariable).toBe('boolean');
  });

  it('every race has the required public fields', () => {
    for (const r of bundle.races) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.name).toBe('string');
      expect(typeof r.level).toBe('string');
      expect(['primary', 'general']).toContain(r.type);
      // relevant_dimensions is string[] | null.
      expect(
        r.relevant_dimensions === null || Array.isArray(r.relevant_dimensions),
      ).toBe(true);
      expect(Array.isArray(r.candidates)).toBe(true);
    }
  });

  it('every candidate is public-only with a coverage tier', () => {
    for (const r of bundle.races) {
      for (const c of r.candidates) {
        expect(typeof c.id).toBe('string');
        expect(typeof c.name).toBe('string');
        expect(['A', 'B', 'C']).toContain(c.tier);
        // No voter data leaked onto the candidate.
        expect(c).not.toHaveProperty('quick_match_answers');
        expect(c).not.toHaveProperty('email');
      }
    }
  });

  it('positions are LEAN: citation COUNT only, no citation text/prose', () => {
    for (const r of bundle.races) {
      for (const c of r.candidates) {
        for (const p of c.positions) {
          expect(typeof p.sub_dimension_id).toBe('string');
          expect(typeof p.score).toBe('number');
          expect(['stated', 'inferred']).toContain(p.view_type);
          expect(typeof p.citationCount).toBe('number');
          expect(typeof p.hasCitationUrl).toBe('boolean');
          // The lean guarantee: NO citation prose, nuance, summary, or audit ids.
          expect(p).not.toHaveProperty('source_citations');
          expect(p).not.toHaveProperty('ai_summary');
          expect(p).not.toHaveProperty('nuance_notes');
          expect(p).not.toHaveProperty('extraction_audit_id');
        }
      }
    }
  });

  it('sub-dimension metadata carries scope_applicability for client scoping', () => {
    for (const sd of bundle.subDimensions) {
      expect(typeof sd.id).toBe('string');
      expect(typeof sd.domain).toBe('string');
      expect(typeof sd.name).toBe('string');
      expect(sd.scope_applicability).toBeTypeOf('object');
    }
  });

  it('no voter opinion data anywhere in the payload', () => {
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('quick_match_answers');
    expect(json).not.toContain('spi_consent');
    // The device profile's answered dims must not appear as a voter score set.
    expect(bundle).not.toHaveProperty('answers');
    expect(bundle).not.toHaveProperty('voter');
  });

  it('stays under the 300KB budget for the 11-race ballot', () => {
    const bytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
    expect(bytes).toBeLessThan(300 * 1024);
  });
});
