import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter: max 10 corrections per hour per IP
// LIMITATION: On Vercel (serverless), this Map resets on cold starts and
// doesn't share state across instances. For production, migrate to
// Supabase-backed or Upstash Redis rate limiting. Acceptable for MVP
// since corrections volume is expected to be low.
// ---------------------------------------------------------------------------

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Periodically clean up stale entries (prevent memory leak)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const CorrectionSchema = z.object({
  candidate_id: z.string().uuid('candidate_id must be a valid UUID'),
  position_id: z.string().uuid('position_id must be a valid UUID'),
  submitted_by: z.string().min(1, 'submitted_by is required'),
  evidence: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      'unknown';

    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Maximum 10 corrections per hour.' },
        { status: 429 },
      );
    }

    // Parse and validate body
    const body = await request.json();
    const parsed = CorrectionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { candidate_id, position_id, submitted_by, evidence } = parsed.data;

    // Insert correction
    const supabase = await createClient();
    const { data: correction, error } = await supabase
      .from('corrections')
      .insert({
        candidate_id,
        position_id,
        submitted_by,
        evidence: evidence ?? null,
        status: 'submitted',
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to insert correction:', error);
      return NextResponse.json(
        { error: 'Failed to submit correction.' },
        { status: 500 },
      );
    }

    return NextResponse.json(correction, { status: 201 });
  } catch (err) {
    console.error('Corrections error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred.' },
      { status: 500 },
    );
  }
}
