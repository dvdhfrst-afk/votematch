import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase/server';

const EmailOptinSchema = z.object({
  email: z.string().email('Please provide a valid email address'),
  precinct_id: z.string().uuid().nullable().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = EmailOptinSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { email, precinct_id } = parsed.data;

    // Upsert needs SELECT + UPDATE privileges; email_optins only has a public
    // INSERT policy (by design — opt-ins aren't readable by anon).
    // Service client bypasses RLS for this write.
    const supabase = await createServiceClient();

    const { error } = await supabase
      .from('email_optins')
      .upsert(
        {
          email,
          precinct_id: precinct_id ?? null,
        },
        { onConflict: 'email' },
      );

    if (error) {
      console.error('Failed to save email opt-in:', error);
      return NextResponse.json(
        { error: 'Failed to save your email. Please try again.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Email opt-in error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred.' },
      { status: 500 },
    );
  }
}
