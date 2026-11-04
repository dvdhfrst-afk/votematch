import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveForCandidatesToken } from "@/lib/for-candidates/session";
import RelatedCandidatesList from "./RelatedCandidatesList";

/**
 * /for-candidates/profile/[token]/related
 *
 * Lists other `candidates` rows that appear to be the same human as the
 * logged-in candidate (same canonical_key on the linked people row, OR same
 * canonicalized name for ingestion paths that haven't promoted to people yet).
 *
 * For each candidate the page surfaces:
 *  - Pending claims at the top (already attested, awaiting downstream merge).
 *  - Suggested matches with "Yes, also me" / "No, different person" buttons.
 *  - Already-dismissed pairs hidden by default.
 *
 * "Yes" calls claimAdditionalCandidateAction (requires name retype +
 * confirmation checkbox). "No" calls dismissCandidateClaimAction
 * (lightweight — just records a dismissal so we stop prompting).
 */
export default async function RelatedCandidatesPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveForCandidatesToken(token);

  if (!resolved.ok) {
    return (
      <Unavailable
        message={
          resolved.status === 410
            ? "This sign-in link has expired. Request a fresh one from /for-candidates."
            : resolved.error
        }
      />
    );
  }
  if (resolved.target.kind === "candidacy") {
    return (
      <Unavailable
        message="Merging duplicate records isn't available for office-graph profiles yet. If you see a duplicate listing, email support@example.org and we'll consolidate it."
        backHref={`/for-candidates/profile/${token}`}
      />
    );
  }
  if (resolved.target.kind !== "candidate") {
    return (
      <Unavailable
        message="Identity claims are disabled while we verify your candidacy. Save your draft and we'll email you when it's ready."
        backHref={`/for-candidates/profile/${token}`}
      />
    );
  }

  const supabase = await createServiceClient();
  const primaryCandidateId = resolved.target.candidateId;

  // Resolve primary candidate (name + race for display).
  const { data: primaryCand } = await supabase
    .from("candidates")
    .select("id, name, race:races(name)")
    .eq("id", primaryCandidateId)
    .maybeSingle();

  if (!primaryCand) {
    return <Unavailable message="Candidate record not found." />;
  }

  const primaryName = primaryCand.name as string;
  const primaryRace = arrayOrSingle(primaryCand.race);
  const primaryRaceLabel = (primaryRace?.name as string | null) ?? null;

  // Strategy: find candidates that share identity signals.
  // 1. Find the people row(s) linked to this candidate (legacy_candidate_ids GIN).
  // 2. For each people row with a canonical_key, find other people rows with
  //    the same canonical_key, then their legacy_candidate_ids[] → other candidates.
  // 3. Fallback for ingestion paths that haven't been promoted to people:
  //    name-equality on the candidates table.
  const { data: ownPeopleRaw } = await supabase
    .from("people")
    .select("id, canonical_key")
    .contains("legacy_candidate_ids", [primaryCandidateId]);

  const ownPeople = (ownPeopleRaw ?? []) as Array<{
    id: string;
    canonical_key: string | null;
  }>;
  const sharedKeys = [
    ...new Set(
      ownPeople
        .map((p) => p.canonical_key)
        .filter((k): k is string => Boolean(k)),
    ),
  ];

  // Candidate ids gathered from people-graph signal.
  const candidateIdSet = new Set<string>();

  if (sharedKeys.length > 0) {
    const { data: siblingPeople } = await supabase
      .from("people")
      .select("id, legacy_candidate_ids")
      .in("canonical_key", sharedKeys);
    for (const p of siblingPeople ?? []) {
      const ids = (p.legacy_candidate_ids ?? []) as string[];
      for (const id of ids) {
        if (id !== primaryCandidateId) candidateIdSet.add(id);
      }
    }
  }

  // Fallback: same canonicalized name (case-insensitive). Useful when
  // legacy_candidate_ids hasn't been backfilled yet for this candidate.
  // We use ilike on the raw name to catch Unicode-case variants and then
  // post-filter in JS by canonicalize() to prune punctuation differences.
  const { data: nameMatches } = await supabase
    .from("candidates")
    .select("id, name")
    .ilike("name", primaryName)
    .neq("id", primaryCandidateId)
    .limit(50);
  for (const c of nameMatches ?? []) {
    if (
      canonicalizeName(c.name as string) === canonicalizeName(primaryName)
    ) {
      candidateIdSet.add(c.id as string);
    }
  }

  const candidateIds = [...candidateIdSet];

  // Pull the candidate detail for everyone we found.
  type CandRow = {
    id: string;
    name: string;
    party: string | null;
    photo_url: string | null;
    race_label: string | null;
    state_or_district: string | null;
  };
  let candidateRows: CandRow[] = [];
  if (candidateIds.length > 0) {
    const { data: cands } = await supabase
      .from("candidates")
      .select("id, name, party, photo_url, race:races(name, district, level, election_date)")
      .in("id", candidateIds)
      .limit(100);
    candidateRows = (cands ?? []).map((c) => {
      const race = arrayOrSingle(c.race);
      return {
        id: c.id as string,
        name: (c.name as string) ?? "",
        party: (c.party as string | null) ?? null,
        photo_url: (c.photo_url as string | null) ?? null,
        race_label: (race?.name as string | null) ?? null,
        state_or_district:
          (race?.district as string | null) ??
          (race?.level as string | null) ??
          null,
      };
    });
  }

  // Pull existing identity claims (any status) to render the right state.
  const { data: existingClaims } = await supabase
    .from("candidate_identity_claims")
    .select("claimed_candidate_id, status, attested_at")
    .eq("primary_candidate_id", primaryCandidateId);
  const claimsByCandidate = new Map<
    string,
    { status: string; attested_at: string | null }
  >();
  for (const c of existingClaims ?? []) {
    claimsByCandidate.set(c.claimed_candidate_id as string, {
      status: c.status as string,
      attested_at: (c.attested_at as string | null) ?? null,
    });
  }

  // Filter + bucket.
  const dismissed = new Set<string>();
  const pending: typeof candidateRows = [];
  const merged: typeof candidateRows = [];
  const suggestions: typeof candidateRows = [];

  for (const row of candidateRows) {
    const claim = claimsByCandidate.get(row.id);
    if (!claim) {
      suggestions.push(row);
      continue;
    }
    if (claim.status === "dismissed" || claim.status === "rejected") {
      dismissed.add(row.id);
      continue;
    }
    if (claim.status === "merged") {
      merged.push(row);
      continue;
    }
    // pending
    pending.push(row);
  }

  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)]">
      <header className="bg-white border-b border-[var(--color-border)]">
        <div className="civic-container py-4 flex items-center justify-between">
          <Link
            href="/"
            className="text-xl font-bold text-[var(--color-primary)]"
          >
            Havesay
          </Link>
          <Link
            href={`/for-candidates/profile/${token}`}
            className="text-sm text-[var(--color-text-secondary)] underline"
          >
            ← Back to editor
          </Link>
        </div>
      </header>

      <div className="civic-container py-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[var(--color-primary)] mb-1">
            Other candidates with your name
          </h1>
          <p className="text-[var(--color-text-secondary)] mb-2">
            You are signed in as <strong>{primaryName}</strong>
            {primaryRaceLabel && <> — {primaryRaceLabel}</>}.
          </p>
          <p className="text-sm text-[var(--color-text-muted)] mb-6">
            We sometimes have multiple records for the same person (a prior
            run, a different state feed, a name spelling). Tell us which of
            these are also you. Confirmed pairs will be merged so voters see
            one consolidated profile. Records you dismiss won&apos;t be
            shown here again.
          </p>

          {pending.length === 0 &&
            merged.length === 0 &&
            suggestions.length === 0 && (
              <div className="civic-card">
                <p className="text-sm text-[var(--color-text-secondary)]">
                  No other candidate records found that share your name or
                  identity. If you believe a duplicate exists, email{" "}
                  <a
                    href="mailto:support@example.org"
                    className="underline text-[var(--color-primary)]"
                  >
                    support@example.org
                  </a>
                  .
                </p>
                <Link
                  href={`/for-candidates/profile/${token}`}
                  className="civic-btn-secondary inline-block mt-4 px-5 py-2"
                >
                  Back to editor
                </Link>
              </div>
            )}

          {pending.length > 0 && (
            <section className="mb-6">
              <h2 className="text-lg font-bold text-[var(--color-primary)] mb-2">
                Pending — awaiting merge
              </h2>
              <ul className="space-y-2">
                {pending.map((row) => (
                  <li
                    key={row.id}
                    className="civic-card border-amber-300 bg-amber-50"
                  >
                    <p className="font-semibold text-[var(--color-text)]">
                      {row.name}
                    </p>
                    {row.race_label && (
                      <p className="text-sm text-[var(--color-text-secondary)]">
                        {row.race_label}
                      </p>
                    )}
                    <p className="text-xs text-amber-900 mt-2">
                      You&apos;ve confirmed this is also you. A Ballot
                      Bridge volunteer will merge the records into your
                      primary profile.
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {merged.length > 0 && (
            <section className="mb-6">
              <h2 className="text-lg font-bold text-[var(--color-primary)] mb-2">
                Merged
              </h2>
              <ul className="space-y-2">
                {merged.map((row) => (
                  <li key={row.id} className="civic-card">
                    <p className="font-semibold text-[var(--color-text)]">
                      {row.name}
                    </p>
                    {row.race_label && (
                      <p className="text-sm text-[var(--color-text-secondary)]">
                        {row.race_label}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {suggestions.length > 0 && (
            <section>
              <h2 className="text-lg font-bold text-[var(--color-primary)] mb-2">
                Possible matches ({suggestions.length})
              </h2>
              <RelatedCandidatesList
                token={token}
                primaryName={primaryName}
                suggestions={suggestions}
              />
            </section>
          )}

          {dismissed.size > 0 && (
            <p className="text-xs text-[var(--color-text-muted)] mt-6">
              {dismissed.size} previously dismissed match
              {dismissed.size === 1 ? "" : "es"} hidden.
            </p>
          )}

          <div className="mt-8">
            <Link
              href={`/for-candidates/profile/${token}`}
              className="civic-btn-secondary inline-block px-5 py-2"
            >
              Back to editor
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

function arrayOrSingle<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function canonicalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function Unavailable({
  message,
  backHref,
}: {
  message: string;
  backHref?: string;
}) {
  return (
    <main className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white border border-[var(--color-border)] rounded-xl p-6 text-center">
        <h1 className="text-2xl font-bold text-[var(--color-primary)] mb-3">
          Unavailable
        </h1>
        <p className="text-[var(--color-text-secondary)] mb-5">{message}</p>
        <Link
          href={backHref ?? "/for-candidates"}
          className="civic-btn-primary inline-block px-6 py-2"
        >
          {backHref ? "Back to editor" : "Get a fresh link"}
        </Link>
      </div>
    </main>
  );
}
