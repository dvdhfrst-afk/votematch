import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// DEPRECATED — /api/match (work-order 1B, on-device migration)
// ---------------------------------------------------------------------------
// This endpoint used to READ the voter's quick_match_answers, DERIVE weights,
// COMPUTE matches server-side, and PERSIST all of it to the operational DB:
// users.quick_match_answers, users.weights, the `matches` table, and
// match_result_snapshots. That write path violated the on-device voter-data
// architecture (memory: voter-data-architecture-ondevice): the voter's
// opinions must never land on the operational database.
//
// The voter flow now scores entirely client-side. The device store + client
// matcher live in src/lib/device/* (src/lib/device/match-client.ts), fed by the
// candidate/position data served from /api/positions-bundle. Nothing about a
// voter's opinions is sent to or stored on the server.
//
// This route is kept (rather than deleted) and returns HTTP 410 Gone so any
// external or bookmarked caller that still POSTs here gets an explicit,
// honest "this moved on-device" response instead of a 404 or a silent success.
// ---------------------------------------------------------------------------

export async function POST() {
  return NextResponse.json(
    {
      error: 'gone',
      message:
        'Matching now runs on your device. This endpoint is deprecated.',
    },
    { status: 410 },
  );
}
