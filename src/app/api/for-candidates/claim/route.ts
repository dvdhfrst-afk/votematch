import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { createForCandidatesToken } from "@/lib/for-candidates/tokens";
import { sendCandidatePortalLink } from "@/lib/for-candidates/mailer";

/**
 * POST /api/for-candidates/claim
 *
 * Body: { email: string, name?: string, office?: string, state?: string }
 *
 * Behavior:
 *   1. Look for a candidate with this email (legacy candidate_contacts table
 *      OR people.contact_email then bridge to legacy candidates by name match —
 *      we use candidate_contacts as the simple-and-correct path because that's
 *      what the existing `apply-2026-candidates.ts` populates and what the
 *      existing `/candidate/questionnaire/[id]` flow keys on).
 *   2. If matched, issue a token tied to candidates.id.
 *   3. If not matched, create a candidate_pending_claims row and issue a token
 *      tied to that row. Admin verifies later — out of scope this cycle.
 *   4. Send the magic-link email. If Resend isn't configured, log + echo the
 *      link back in the JSON response so dev/local-test still works.
 *
 * Returns: { ok, matched, devLink? }
 */

const ClaimSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(200).optional(),
  office: z.string().min(1).max(200).optional(),
  state: z.string().length(2).optional(),
});

type MatchedCandidacy = {
  candidacyId: string;
  personId: string;
  name: string | null;
};

// Statuses that mean a candidacy is no longer a live ballot contender. We still
// match on them (a withdrawn candidate may want to manage their record) but rank
// them below active ones.
const INACTIVE_STATUSES = new Set([
  "withdrew",
  "disqualified",
  "lost_primary",
  "lost_general",
  "pending_verification",
]);

/**
 * Find the best office-graph candidacy for an email. Checks
 * candidacies.campaign_email first, then people.contact_email -> that person's
 * candidacies. When a person has several candidacies, prefer an active one, then
 * a 2026 election, then the most recent election date.
 *
 * Returns null when no office-graph match exists (caller falls back to legacy).
 */
async function findBestCandidacyByEmail(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  email: string,
): Promise<MatchedCandidacy | null> {
  type Row = {
    id: string;
    person_id: string;
    status: string | null;
    election: { election_date: string | null } | { election_date: string | null }[] | null;
    person: { canonical_name: string | null } | { canonical_name: string | null }[] | null;
  };
  const select =
    "id, person_id, status, election:elections(election_date), person:people(canonical_name)";

  const collected: Row[] = [];

  // 1. Direct campaign-email match on the candidacy.
  const { data: byCampaign } = await supabase
    .from("candidacies")
    .select(select)
    .ilike("campaign_email", email)
    .limit(20);
  if (byCampaign) collected.push(...(byCampaign as Row[]));

  // 2. Person contact-email match -> all of that person's candidacies.
  if (collected.length === 0) {
    const { data: ppl } = await supabase
      .from("people")
      .select("id")
      .ilike("contact_email", email)
      .limit(10);
    const personIds = (ppl ?? []).map((p) => p.id as string);
    if (personIds.length > 0) {
      const { data: byPerson } = await supabase
        .from("candidacies")
        .select(select)
        .in("person_id", personIds)
        .limit(50);
      if (byPerson) collected.push(...(byPerson as Row[]));
    }
  }

  if (collected.length === 0) return null;

  const one = <T>(v: T | T[] | null): T | null =>
    v == null ? null : Array.isArray(v) ? (v[0] ?? null) : v;

  const scored = collected.map((r) => {
    const election = one(r.election);
    const dateStr = election?.election_date ?? null;
    const year = dateStr ? Number(dateStr.slice(0, 4)) : 0;
    const active = !INACTIVE_STATUSES.has((r.status ?? "").toLowerCase());
    // Composite rank: active beats inactive; 2026 beats other years; newer beats older.
    const rank =
      (active ? 1_000_000 : 0) +
      (year === 2026 ? 100_000 : 0) +
      year; // year acts as the recency tiebreaker
    return {
      rank,
      row: r,
      name: (one(r.person)?.canonical_name as string | null) ?? null,
    };
  });
  scored.sort((a, b) => b.rank - a.rank);
  const best = scored[0];
  return {
    candidacyId: best.row.id,
    personId: best.row.person_id,
    name: best.name,
  };
}

// ---------------------------------------------------------------------------
// Per-IP rate limit (in-memory)
// ---------------------------------------------------------------------------
//
// Crude but effective: cap each IP to 5 attempts per 15min window. This stops
// trivial enumeration of which emails map to candidates (the JSON response
// distinguishes `matched: true|false`) and basic claim spam.
//
// Limitations of an in-memory Map:
//   - Vercel serverless functions are ephemeral; a cold start resets the
//     window. That's acceptable: cold starts cap the attacker to ~5 attempts
//     per warm-instance lifetime, which is still much better than no limit.
//     A production-grade fix uses an upstash/redis bucket — out of scope here.
//   - A null/missing X-Forwarded-For collapses to a single 'unknown' bucket.
//     Documented; behind Vercel/CF the header is always set.

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 5;

type RateBucket = { count: number; windowStartedAt: number };
const rateBuckets = new Map<string, RateBucket>();

function ipFromRequest(req: NextRequest): string {
  // X-Forwarded-For may contain a comma-separated chain; the first entry
  // is the original client. When absent (direct local hit, or a runtime
  // that hasn't set it), fall back to a single 'unknown' bucket so we
  // still rate-limit *something*.
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return "unknown";
  const first = xff.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

/** Returns true when the request is over the limit. */
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStartedAt: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

export async function POST(req: NextRequest) {
  // Rate-limit BEFORE parsing the body so a flood of malformed POSTs
  // can't bypass the cap.
  const ip = ipFromRequest(req);
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many claim attempts. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
        },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const email = parsed.data.email.trim().toLowerCase();
  const name = parsed.data.name?.trim();
  const office = parsed.data.office?.trim();
  const state = parsed.data.state?.trim().toUpperCase();

  const supabase = await createServiceClient();

  // ---- 1. Match an existing candidacy/candidate by email ----
  // Office-graph FIRST (current 2026 data lives in people/candidacies):
  // candidacies.campaign_email, then people.contact_email -> that person's
  // best candidacy. Legacy candidate_contacts/candidates is the fallback for
  // pre-office-graph rows only.
  const matchedCandidacy = await findBestCandidacyByEmail(supabase, email);

  type MatchedCandidate = { id: string; name: string | null };
  let matchedCandidate: MatchedCandidate | null = null;
  if (!matchedCandidacy) {
    const { data: contact, error: contactErr } = await supabase
      .from("candidate_contacts")
      .select("candidate_id, email, candidates:candidates(id, name)")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    if (contactErr) {
      console.error("[claim] candidate_contacts lookup failed:", contactErr);
      // Non-fatal — treat as no legacy match.
    }
    if (contact?.candidate_id) {
      const c = Array.isArray(contact.candidates)
        ? contact.candidates[0]
        : contact.candidates;
      matchedCandidate = c
        ? { id: c.id as string, name: (c.name as string | null) ?? null }
        : { id: contact.candidate_id as string, name: null };
    }
  }

  const matched = Boolean(matchedCandidacy || matchedCandidate);
  const matchedName =
    matchedCandidacy?.name ?? matchedCandidate?.name ?? name ?? null;

  // ---- 2/3. Issue token tied to the candidacy, the legacy candidate, or a
  // pending claim. The cqt_one_target_only CHECK requires exactly one target. ---
  const tokenRowId = crypto.randomUUID();
  const { token, fingerprint, expiresAt } = createForCandidatesToken(tokenRowId);

  let pendingClaimId: string | null = null;
  if (!matched) {
    // Create a pending claim. Require at least a name so admin verification
    // has something to work with — if the user didn't fill the optional
    // fields, fall back to "(unspecified)" rather than rejecting.
    const { data: claim, error: claimErr } = await supabase
      .from("candidate_pending_claims")
      .insert({
        email,
        claimed_name: name ?? "(unspecified)",
        claimed_office: office ?? null,
        claimed_state: state ?? null,
        status: "pending",
      })
      .select("id")
      .single();

    if (claimErr || !claim) {
      console.error("[claim] failed to insert pending claim:", claimErr);
      return NextResponse.json(
        { ok: false, error: "Could not record claim" },
        { status: 500 },
      );
    }
    pendingClaimId = claim.id as string;
  }

  const { error: tokenInsertErr } = await supabase
    .from("candidate_questionnaire_tokens")
    .insert({
      id: tokenRowId,
      candidate_id: matchedCandidate?.id ?? null,
      candidacy_id: matchedCandidacy?.candidacyId ?? null,
      pending_claim_id: pendingClaimId,
      flow_type: "for-candidates",
      token_fingerprint: fingerprint,
      sent_to_email: email,
      expires_at: expiresAt.toISOString(),
    });

  if (tokenInsertErr) {
    console.error("[claim] failed to insert token row:", tokenInsertErr);
    return NextResponse.json(
      { ok: false, error: "Could not issue token" },
      { status: 500 },
    );
  }

  // ---- 4. Send the email (or log it in dev) ----
  let devLink: string | null = null;
  try {
    const send = await sendCandidatePortalLink({
      to: email,
      token,
      candidateName: matchedName,
      office: office ?? null,
    });
    if (!send.sent && send.devLink) {
      devLink = send.devLink;
    }
  } catch (err) {
    console.error("[claim] sendCandidatePortalLink threw:", err);
    // Token is already in the DB — surface the link in dev so the test still
    // proceeds. In production this branch shouldn't fire (Resend errors are
    // usually transient and not exceptions).
    devLink = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:4000"}/for-candidates/profile/${token}`;
  }

  // Hard-gate devLink on non-production. Even if the mailer falls back
  // (Resend mis-config, transient throw), we MUST NOT echo a working
  // candidate-portal token in a production response — that's a free
  // account-takeover vector for anyone who can hit the endpoint.
  // Operators investigating prod failures should read the token from the
  // candidate_questionnaire_tokens row + console logs instead.
  const exposeDevLink = process.env.NODE_ENV !== "production";

  return NextResponse.json({
    ok: true,
    matched,
    // Only echo the dev link when we know the mailer didn't actually send
    // AND we're not in production. In production with Resend configured,
    // devLink is always null.
    devLink: exposeDevLink ? devLink : null,
  });
}
