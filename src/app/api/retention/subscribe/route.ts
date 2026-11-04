import { NextRequest, NextResponse } from 'next/server';
import { subscribe } from '@/lib/retention/subscribe';

/**
 * Programmatic subscribe endpoint — alternative to the server action for
 * B2B integrations and non-browser clients.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const result = await subscribe({
    email: typeof body.email === 'string' ? body.email : null,
    phone: typeof body.phone === 'string' ? body.phone : null,
    state: typeof body.state === 'string' ? body.state : '',
    interest_tags: Array.isArray(body.interest_tags) ? body.interest_tags : [],
    match_id: typeof body.match_id === 'string' ? body.match_id : null,
    digest_frequency: body.digest_frequency ?? 'monthly',
    spi_consent: body.spi_consent === true,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({
    subscriberId: result.subscriberId,
    alreadySubscribed: result.alreadySubscribed,
  });
}
