import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/session';

// Headline metric is ballot comprehension (`understood`). `voted`/`changed` are
// optional secondary internal signals the voter can skip (nullable). See MESSAGING.md.
const FeedbackSchema = z.object({
  understood: z.enum(['yes', 'somewhat', 'no']),
  voted: z.boolean().nullable().optional(),
  changed: z.enum(['yes', 'no', 'not_sure']).nullable().optional(),
  raceCount: z.number().int().min(0).nullable().optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Optionally attach user_id if session exists (anonymous submissions allowed)
    const user = await getSessionUser().catch(() => null);

    // Parse and validate body
    const body = await request.json();
    const parsed = FeedbackSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { understood, voted, changed, raceCount } = parsed.data;

    // Insert feedback, mapping to DB column names. understood_ballot is the
    // headline metric; did_vote/changed_vote are optional secondary signals.
    const supabase = await createClient();
    const { error } = await supabase.from('feedback_responses').insert({
      user_id: user?.id ?? null,
      understood_ballot: understood,
      did_vote: voted ?? null,
      changed_vote: changed ?? null,
      races_changed: changed === 'yes' ? (raceCount ?? null) : null,
    });

    if (error) {
      console.error('Failed to insert feedback:', error);
      return NextResponse.json(
        { error: 'Failed to submit feedback.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Feedback error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred.' },
      { status: 500 },
    );
  }
}
