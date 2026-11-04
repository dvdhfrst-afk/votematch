import { NextRequest } from 'next/server';
import { ImageResponse } from '@vercel/og';
import { getSessionUser } from '@/lib/session';
import { getParticipationRanks } from '@/app/invite-actions';

export const runtime = 'nodejs';

/**
 * Participation-rank badge — per-user OG image.
 *
 * Position-agnostic by design: NO candidate, NO party, NO match score, NO
 * domain. Just the user's rank in three scopes (national / state / district)
 * + the Havesay brand. Replaces the cut ballot-card share path as the
 * shareable surface (the operator's 2026-05-02 design amendment).
 *
 * Privacy: the rank is computed server-side from the requesting session;
 * the image embeds only numbers and the brand. There is no link back to
 * the user's actual ballot, and no way to derive the user_id from the
 * image content.
 */
export async function GET(_request: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return new Response('No active session', { status: 401 });
    }

    const ranks = await getParticipationRanks();
    if (!ranks.completed_at) {
      return new Response(
        'Complete your ballot match first to generate a participation badge.',
        { status: 404 },
      );
    }

    const cycleYear = new Date(ranks.completed_at).getUTCFullYear();

    return new ImageResponse(
      (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '1200px',
            height: '630px',
            backgroundColor: '#0f172a',
            color: '#f8fafc',
            fontFamily: 'sans-serif',
            padding: '64px',
            justifyContent: 'space-between',
          }}
        >
          {/* Brand bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: '32px',
              fontWeight: 700,
              color: '#38bdf8',
            }}
          >
            Havesay
          </div>

          {/* Rank block */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: '20px',
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: '28px',
                color: '#94a3b8',
              }}
            >
              I finished my ballot match for the {cycleYear} cycle.
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              {ranks.national && (
                <div style={{ display: 'flex', fontSize: '46px', fontWeight: 700 }}>
                  #{formatRank(ranks.national.rank)} nationally
                </div>
              )}
              {ranks.state && (
                <div
                  style={{
                    display: 'flex',
                    fontSize: '36px',
                    color: '#cbd5e1',
                  }}
                >
                  #{formatRank(ranks.state.rank)} in {ranks.state.state}
                </div>
              )}
              {ranks.district && (
                <div
                  style={{
                    display: 'flex',
                    fontSize: '32px',
                    color: '#94a3b8',
                  }}
                >
                  #{formatRank(ranks.district.rank)} in {ranks.district.state}-
                  {ranks.district.district}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div style={{ display: 'flex', fontSize: '22px', color: '#64748b' }}>
              ballotbridge.org — your whole ballot, explained.
            </div>
            <div style={{ display: 'flex', fontSize: '18px', color: '#475569' }}>
              Position-agnostic participation badge. No match results shown.
            </div>
          </div>
        </div>
      ),
      { width: 1200, height: 630 },
    );
  } catch (err) {
    console.error('Badge OG generation error:', err);
    return new Response('Failed to generate participation badge', {
      status: 500,
    });
  }
}

function formatRank(n: number): string {
  return n.toLocaleString('en-US');
}
