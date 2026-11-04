'use client';

/**
 * Print-a-paper-copy link (V2 pillar 5b: print is a demoted accessibility-only
 * fallback, never a primary CTA). Small text link, not a button; triggers the
 * booth-ready print stylesheet (globals.css @media print) on the same checklist.
 */
export default function PrintPlanButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="civic-print-hide"
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        color: 'var(--civic-link)',
        textDecoration: 'underline',
        textUnderlineOffset: 2,
        fontSize: 13,
        cursor: 'pointer',
        minHeight: 44,
      }}
    >
      Print a paper copy (accessibility)
    </button>
  );
}
