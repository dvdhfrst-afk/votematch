import { SkelLine, SkelBlock } from '@/components/guide/primitives';

/**
 * Loading skeleton for the domain page (DD2) and its issue list (DD3).
 * Matches the "score header + stacked issue rows" shape so positions can render
 * before sources finish loading without a layout jump.
 * Frame ref: round1-frames.jsx DD2l_Loading / DD3l_Loading.
 */
export default function GuideDomainLoading() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading positions…</span>

      {/* Domain score header */}
      <div className="civic-card" style={{ padding: 16 }}>
        <SkelLine width={80} height={9} />
        <div style={{ height: 8 }} />
        <SkelLine width={60} height={26} />
        <div style={{ height: 8 }} />
        <SkelLine width="90%" height={10} />
      </div>

      {/* Issue rows */}
      <div style={{ marginTop: 16 }}>
        <SkelLine width={140} height={9} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {[0, 1, 2, 3].map((i) => (
            <SkelBlock key={i} height={54} />
          ))}
        </div>
      </div>
    </div>
  );
}
