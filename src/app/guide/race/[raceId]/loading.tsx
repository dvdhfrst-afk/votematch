import { SkelLine, SkelCircle } from '@/components/guide/primitives';

/**
 * Loading skeleton for the race drill-down (DD1). Matches the ranked-candidate
 * list shape so the match rows do not jump when scores resolve.
 * Frame ref: round1-frames.jsx DD1l_Loading.
 */
export default function GuideRaceLoading() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Scoring candidates…</span>

      {/* Office header + scope band */}
      <SkelLine width="55%" height={22} />
      <div style={{ height: 8 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <SkelLine width={140} height={16} />
        <SkelLine width={70} height={10} />
      </div>

      {/* Ranked candidate rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="civic-card"
            style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}
          >
            <SkelLine width={16} height={16} />
            <SkelCircle size={42} />
            <div style={{ flex: 1 }}>
              <SkelLine width={120} height={14} />
              <div style={{ height: 6 }} />
              <SkelLine width={60} height={10} />
            </div>
            <div style={{ textAlign: 'right' }}>
              <SkelLine width={42} height={20} />
              <div style={{ height: 5 }} />
              <SkelLine width={30} height={8} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
