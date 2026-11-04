import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/questions?kind=voter
 *
 * Returns active questions of the requested kind, joined with their
 * sub_dimension's domain. The voter quick-match uses these to render
 * the calibration questions dynamically instead of hardcoding them.
 *
 * Shape: [{ id, sub_dimension_id, domain, prompt, priority, options }]
 * Sorted by priority DESC so clients can pick the top question per domain.
 */
export async function GET(request: NextRequest) {
  const kind = request.nextUrl.searchParams.get('kind') ?? 'voter';
  if (kind !== 'voter' && kind !== 'candidate') {
    return NextResponse.json(
      { error: "kind must be 'voter' or 'candidate'" },
      { status: 400 },
    );
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('questions')
      .select(
        'id, sub_dimension_id, prompt, priority, options, sub_dimensions!inner(domain, name, active)',
      )
      .eq('kind', kind)
      .eq('active', true)
      .eq('sub_dimensions.active', true)
      .order('priority', { ascending: false });

    if (error) {
      console.error('questions fetch failed:', error);
      return NextResponse.json(
        { error: 'Failed to load questions.' },
        { status: 500 },
      );
    }

    // Flatten sub_dimensions.domain onto the row so the client doesn't
    // have to reach through a nested object. PostgREST may return the
    // joined relation as either an object or a one-element array depending
    // on how its relation-detection infers cardinality — handle both.
    type JoinedSubDim = { domain: string; name: string; active: boolean };
    const flattened = (data ?? []).map((row) => {
      const rel = row.sub_dimensions as unknown as
        | JoinedSubDim
        | JoinedSubDim[]
        | null;
      const sd = Array.isArray(rel) ? (rel[0] ?? null) : rel;
      return {
        id: row.id,
        sub_dimension_id: row.sub_dimension_id,
        sub_dimension_name: sd?.name ?? null,
        domain: sd?.domain ?? null,
        prompt: row.prompt,
        priority: row.priority,
        options: row.options,
      };
    });

    return NextResponse.json(flattened);
  } catch (err) {
    console.error('questions route error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred.' },
      { status: 500 },
    );
  }
}
