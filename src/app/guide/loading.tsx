import { SkelLine, SkelCircle } from '@/components/guide/primitives';

/**
 * Route-level loading skeleton for the guide index.
 * Matches the SHAPE of GuideIndexPage's race list so there is no layout jump
 * when the real ballot resolves (round1-frames DD1l pattern, civic styling).
 */
export default function GuideIndexLoading() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Building your ballot…</span>

      {/* Address / heading band */}
      <div className="mb-5">
        <SkelLine width={80} height={10} />
        <div style={{ height: 8 }} />
        <SkelLine width="70%" height={22} />
      </div>

      {/* Race cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="civic-card"
            style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}
          >
            <SkelCircle size={42} />
            <div style={{ flex: 1 }}>
              <SkelLine width="60%" height={14} />
              <div style={{ height: 6 }} />
              <SkelLine width={90} height={10} />
            </div>
            <div style={{ textAlign: 'right' }}>
              <SkelLine width={48} height={20} />
              <div style={{ height: 5 }} />
              <SkelLine width={32} height={8} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
