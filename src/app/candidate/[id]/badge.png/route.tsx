import { NextRequest } from 'next/server';
import { ImageResponse } from '@vercel/og';
import { createServiceClient } from '@/lib/supabase/server';

// -----------------------------------------------------------------------------
// /candidate/{id}/badge.png — OG image rendered via @vercel/og.
//
// Drop-in image the candidate can embed on their campaign site:
//   <img src="https://ballotbridge.org/candidate/{id}/badge.png" ... />
//
// Content: candidate name, race name, "See where I stand on Havesay",
// tier/confidence indicator if the candidate has any positions on file yet.
//
// Runtime: nodejs. @vercel/og runs on nodejs in this project.
// -----------------------------------------------------------------------------

export const runtime = 'nodejs';

const WIDTH = 960;
const HEIGHT = 360;

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  try {
    const supabase = await createServiceClient();

    const { data: candidate } = await supabase
      .from('candidates')
      .select('id, name, party, race:races(name)')
      .eq('id', id)
      .maybeSingle();

    if (!candidate) {
      return renderBadge({
        title: 'Candidate not found',
        subtitle: 'This Havesay badge link is invalid.',
        cta: 'ballotbridge.org',
      });
    }

    const race = Array.isArray(candidate.race)
      ? candidate.race[0]
      : candidate.race;

    return renderBadge({
      title: candidate.name,
      subtitle: [candidate.party, race?.name].filter(Boolean).join(', '),
      cta: 'See where I stand on Havesay',
    });
  } catch (err) {
    console.error('Badge render error:', err);
    return renderBadge({
      title: 'Havesay',
      subtitle: 'Your whole ballot, explained.',
      cta: 'ballotbridge.org',
    });
  }
}

function renderBadge({
  title,
  subtitle,
  cta,
}: {
  title: string;
  subtitle: string;
  cta: string;
}) {
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          width: `${WIDTH}px`,
          height: `${HEIGHT}px`,
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
          color: '#f8fafc',
          fontFamily: 'sans-serif',
          padding: '48px 56px',
          borderRadius: '24px',
          position: 'relative',
        }}
      >
        {/* Left rail */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            flex: 1,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                fontSize: '22px',
                color: '#38bdf8',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                fontWeight: 700,
              }}
            >
              Havesay
            </div>
            <div
              style={{
                fontSize: '52px',
                fontWeight: 800,
                lineHeight: 1.05,
                maxWidth: '620px',
              }}
            >
              {title}
            </div>
            {subtitle && (
              <div
                style={{
                  fontSize: '26px',
                  color: '#94a3b8',
                  marginTop: '6px',
                  maxWidth: '620px',
                }}
              >
                {subtitle}
              </div>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
            }}
          >
            <div
              style={{
                display: 'flex',
                padding: '10px 18px',
                background: '#38bdf8',
                color: '#0f172a',
                fontSize: '22px',
                fontWeight: 700,
                borderRadius: '10px',
              }}
            >
              {cta}
            </div>
            <div
              style={{
                fontSize: '20px',
                color: '#64748b',
              }}
            >
              ballotbridge.org
            </div>
          </div>
        </div>

        {/* Right mark */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            width: '160px',
            borderLeft: '2px solid #334155',
            paddingLeft: '40px',
            gap: '6px',
          }}
        >
          <div
            style={{
              fontSize: '18px',
              color: '#94a3b8',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            Nonpartisan
          </div>
          <div
            style={{
              fontSize: '18px',
              color: '#94a3b8',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            Utah 2026
          </div>
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      headers: {
        // Cache on the CDN for an hour. Profile updates re-render the badge
        // lazily; a stale image for up to an hour is acceptable and keeps the
        // OG service from being hammered by embed hotlink traffic.
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    },
  );
}
