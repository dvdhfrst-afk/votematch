import { SkelLine, SkelCircle, SkelBlock } from '@/components/guide/primitives';

/**
 * Loading skeleton for the candidate profile. Matches the "hero (avatar + name
 * + coverage) then stacked position blocks" shape.
 */
export default function GuideCandidateLoading() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading candidate profile…</span>

      {/* Hero */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <SkelCircle size={72} />
        <div style={{ flex: 1 }}>
          <SkelLine width="60%" height={24} />
          <div style={{ height: 8 }} />
          <SkelLine width="80%" height={12} />
          <div style={{ height: 10 }} />
          <SkelLine width={130} height={20} />
        </div>
      </div>

      {/* Position blocks */}
      <div style={{ marginTop: 24 }}>
        <SkelLine width={160} height={9} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {[0, 1, 2, 3].map((i) => (
            <SkelBlock key={i} height={64} />
          ))}
        </div>
      </div>
    </div>
  );
}
