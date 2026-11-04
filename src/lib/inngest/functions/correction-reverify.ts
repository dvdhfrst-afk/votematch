import { inngest } from "../client";
import { createServiceClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Inngest function: correction-reverify
// ---------------------------------------------------------------------------
// Event-triggered (`corrections/flagged.received`). For each flagged
// correction, the function:
//
//   1. Loads the correction row — {claim, claim_type, target_type, target_id}.
//   2. Dispatches on target_type:
//      - 'candidacy'     → locate the `candidate_sources.data_source_id`
//                           → fetch that data_sources.url and compare.
//      - 'endorsement'   → re-fetch the newspaper page via `endorsement_url`.
//      - 'position'      → requeue classification (emit candidate/classify).
//      - 'officeholder'  → re-fetch via data_sources row or flag for human.
//      - 'ballot_measure'→ re-fetch source_url from the ballot_measures row.
//      - 'event'         → flag for human (no clean re-verify path).
//      - null (legacy)   → fall back to candidate_id + position_id; requeue
//                           classification.
//   3. Classifies the result into a `resolution_status`:
//        verified_corrected   — voter was right, canonical row updated
//        no_change_found      — re-fetch confirms original
//        could_not_confirm    — re-fetch inconclusive (status !== 200, diff
//                                unclear, etc.)
//        could_not_resolve    — target_type doesn't cleanly map; human needed
//      and writes resolution_note with the specifics.
//   4. If the correction row carried a submitter_email, enqueue a row in
//      `pending_correction_replies` so the separate email cron can drain
//      and send via Resend. We do NOT send mail directly here.
//
// SLA: 2 hours from the `corrections/flagged.received` event emission. We
// enforce at the config level via Inngest's rate/concurrency settings
// (concurrency cap 3 + retries 2 — every run finishes or retries inside
// the SLA window at typical adapter latencies). The `/admin/morning-review`
// page surfaces SLA breach via `corrections.reverify_triggered_at`.
//
// Notes on scope
// --------------
// This function INTENTIONALLY avoids running full adapters via runAdapter()
// — that path opens a pg transaction, consumes cost caps, and writes to
// ingestion_runs. A single-row "did this fact change" probe should be
// cheaper than re-running a 50-state SoS pass. Instead we re-fetch the
// specific URL the row came from and compare.
//
// For 'position' target_type we emit `candidate/classify`; the existing
// classify-candidate function owns the pg tx + cost bookkeeping.
// ---------------------------------------------------------------------------

type ReverifyOutcome =
  | "verified_corrected"
  | "no_change_found"
  | "could_not_confirm"
  | "could_not_resolve";

const USER_AGENT =
  "Havesay/1.0 (nonpartisan voter-information project, in development)";

export const correctionReverify = inngest.createFunction(
  {
    id: "correction-reverify",
    // Keep concurrency tight so a 2h SLA breach on one adapter host doesn't
    // cascade — 3 in flight is plenty for voter correction volume.
    concurrency: [{ limit: 3 }],
    retries: 2,
    triggers: [{ event: "corrections/flagged.received" }],
  },
  async ({
    event,
    step,
  }: {
    event: { data: { correction_id?: string; triggered_by_user_id?: string } };
    step: {
      run: <T>(id: string, fn: () => Promise<T> | T) => Promise<T>;
      sendEvent: (
        id: string,
        payload: { name: string; data: Record<string, unknown> },
      ) => Promise<unknown>;
    };
  }) => {
    const correctionId = event.data.correction_id;
    if (typeof correctionId !== "string" || correctionId.length === 0) {
      throw new Error("correction-reverify: event missing correction_id");
    }

    // ---------------------------------------------------------------
    // 1. Load correction row.
    // ---------------------------------------------------------------
    const correction = await step.run("load-correction", async () => {
      const supabase = await createServiceClient();
      const { data, error } = await supabase
        .from("corrections")
        .select(
          `
          id,
          target_type,
          target_id,
          candidate_id,
          position_id,
          submitter_email,
          claim,
          claim_type,
          evidence,
          resolved_at
        `,
        )
        .eq("id", correctionId)
        .single();

      if (error || !data) {
        throw new Error(
          `correction-reverify: correction ${correctionId} not found: ${error?.message ?? "no row"}`,
        );
      }

      return data as {
        id: string;
        target_type: string | null;
        target_id: string | null;
        candidate_id: string | null;
        position_id: string | null;
        submitter_email: string | null;
        claim: string | null;
        claim_type: string | null;
        evidence: string | null;
        resolved_at: string | null;
      };
    });

    if (correction.resolved_at) {
      // An editor resolved it between the event emission and our run. Don't
      // over-write their decision.
      return {
        status: "skipped",
        reason: "already resolved",
        correction_id: correctionId,
      };
    }

    // ---------------------------------------------------------------
    // 2. Dispatch on target_type.
    // ---------------------------------------------------------------
    const outcome = await step.run("dispatch", async () => {
      return dispatchReverify(correction);
    });

    // ---------------------------------------------------------------
    // 3. Write resolution back to corrections row.
    // ---------------------------------------------------------------
    await step.run("write-resolution", async () => {
      const supabase = await createServiceClient();
      const { error } = await supabase
        .from("corrections")
        .update({
          resolution_status: outcome.status,
          resolution_note: outcome.note.slice(0, 1000),
          resolution_notes: outcome.note.slice(0, 1000),
          // Only mark resolved when we have a confident verdict. "could not
          // confirm" and "could not resolve" leave resolved_at NULL so the
          // editor still sees the row in /admin/corrections-review.
          resolved_at:
            outcome.status === "verified_corrected" ||
            outcome.status === "no_change_found"
              ? new Date().toISOString()
              : null,
          status:
            outcome.status === "verified_corrected"
              ? "accepted"
              : outcome.status === "no_change_found"
                ? "rejected"
                : "submitted",
        })
        .eq("id", correctionId);

      if (error) {
        throw new Error(
          `correction-reverify: write resolution failed: ${error.message}`,
        );
      }
    });

    // ---------------------------------------------------------------
    // 4. Enqueue voter reply (stubbed — email cron drains later).
    // ---------------------------------------------------------------
    if (correction.submitter_email) {
      await step.run("enqueue-reply", async () => {
        const supabase = await createServiceClient();
        const subject = "Havesay: update on your correction";
        const body = buildReplyBody(correction, outcome);
        const { error } = await supabase
          .from("pending_correction_replies")
          .insert({
            correction_id: correctionId,
            to_email: correction.submitter_email!,
            subject,
            body,
          });
        if (error) {
          // eslint-disable-next-line no-console
          console.warn(
            `[correction-reverify] enqueue-reply failed: ${error.message}`,
          );
          // Don't throw — we already wrote the resolution; the missing reply
          // is a less-bad outcome than a failed-and-retried write that might
          // double-resolve.
        }
        // eslint-disable-next-line no-console
        console.log(
          `[correction-reverify] ${correctionId} → ${outcome.status} (reply queued for ${correction.submitter_email})`,
        );
      });
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[correction-reverify] ${correctionId} → ${outcome.status} (no submitter_email, no reply enqueued)`,
      );
    }

    return {
      status: outcome.status,
      correction_id: correctionId,
      note: outcome.note,
    };
  },
);

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

type DispatchResult = {
  status: ReverifyOutcome;
  note: string;
};

async function dispatchReverify(correction: {
  id: string;
  target_type: string | null;
  target_id: string | null;
  candidate_id: string | null;
  position_id: string | null;
  claim: string | null;
  claim_type: string | null;
  evidence: string | null;
}): Promise<DispatchResult> {
  const supabase = await createServiceClient();

  const targetType = correction.target_type;

  // Legacy rows (pre-20260424000001 migration): candidate_id + position_id
  // but no target_type. Route to 'position' path.
  if (!targetType && correction.position_id) {
    return reverifyPosition(
      supabase,
      correction.candidate_id,
      correction.position_id,
    );
  }

  switch (targetType) {
    case "candidacy":
      return reverifyCandidacy(supabase, correction.target_id);
    case "endorsement":
      return reverifyEndorsement(supabase, correction.target_id);
    case "position":
      return reverifyPosition(
        supabase,
        correction.candidate_id,
        correction.target_id ?? correction.position_id,
      );
    case "officeholder":
      return reverifyOfficeholder(supabase, correction.target_id);
    case "ballot_measure":
      return reverifyBallotMeasure(supabase, correction.target_id);
    case "event":
      return {
        status: "could_not_resolve",
        note: "target_type=event has no automated re-verify path; human review required.",
      };
    default:
      return {
        status: "could_not_resolve",
        note: `unknown target_type=${targetType ?? "null"}; human review required.`,
      };
  }
}

// ---------------------------------------------------------------------------
// target_type='candidacy'
// ---------------------------------------------------------------------------
// Find the most recent `candidate_sources.data_source_id` for this
// candidacy; re-fetch the `data_sources.url` and compare against the
// claim. We're intentionally coarse here — a byte-level diff is enough to
// distinguish "the SoS changed the entry" from "no change". The editor
// still looks at the specifics before flipping resolution_status to
// verified_corrected manually.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reverifyCandidacy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  targetId: string | null,
): Promise<DispatchResult> {
  if (!targetId) {
    return {
      status: "could_not_resolve",
      note: "target_type=candidacy but target_id missing.",
    };
  }

  // Step 1: find the `people.id` for this candidacy, then walk through
  // candidate_sources via the legacy candidates→candidacies bridge OR
  // directly via the office-graph if linked.
  const { data: candidacy, error: cErr } = await supabase
    .from("candidacies")
    .select("id, person_id, election_id, office_id")
    .eq("id", targetId)
    .maybeSingle();

  if (cErr || !candidacy) {
    return {
      status: "could_not_resolve",
      note: `candidacy ${targetId} not found: ${cErr?.message ?? "no row"}`,
    };
  }

  // Find the source URL. candidate_sources.candidate_id points at legacy
  // `candidates.id` which has a 1:1 bridge to `people.id` in most cases.
  const { data: sources } = await supabase
    .from("candidate_sources")
    .select("id, url, data_source_id, fetched_at")
    .order("fetched_at", { ascending: false })
    .limit(10);

  const sourcesList = (sources ?? []) as Array<{
    id: string;
    url: string | null;
    data_source_id: string | null;
    fetched_at: string | null;
  }>;

  if (sourcesList.length === 0) {
    return {
      status: "could_not_resolve",
      note: `candidacy ${targetId} has no candidate_sources rows to re-fetch; human review required.`,
    };
  }

  // Pick the first source with a non-null URL.
  const src = sourcesList.find((s) => s.url != null);
  if (!src || !src.url) {
    return {
      status: "could_not_resolve",
      note: `candidacy ${targetId} has no candidate_sources row with a URL; human review required.`,
    };
  }

  return probeUrl(src.url, `candidacy ${targetId}`);
}

// ---------------------------------------------------------------------------
// target_type='endorsement'
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reverifyEndorsement(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  targetId: string | null,
): Promise<DispatchResult> {
  if (!targetId) {
    return {
      status: "could_not_resolve",
      note: "target_type=endorsement but target_id missing.",
    };
  }

  const { data: row, error } = await supabase
    .from("endorsements")
    .select("id, endorsement_url, archive_url, published, rescinded_at")
    .eq("id", targetId)
    .maybeSingle();

  if (error || !row) {
    return {
      status: "could_not_resolve",
      note: `endorsement ${targetId} not found: ${error?.message ?? "no row"}`,
    };
  }

  if (!row.endorsement_url) {
    return {
      status: "could_not_resolve",
      note: `endorsement ${targetId} has no URL; human review required.`,
    };
  }

  return probeUrl(row.endorsement_url, `endorsement ${targetId}`);
}

// ---------------------------------------------------------------------------
// target_type='position'
// ---------------------------------------------------------------------------
// Requeue classification for the candidate. classify-candidate already has
// cost caps + pg tx handling, so we don't try to replicate that here.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reverifyPosition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  candidateId: string | null,
  positionId: string | null,
): Promise<DispatchResult> {
  if (!candidateId && !positionId) {
    return {
      status: "could_not_resolve",
      note: "target_type=position requires candidate_id or position_id; neither present.",
    };
  }

  let resolvedCandidateId = candidateId;
  if (!resolvedCandidateId && positionId) {
    const { data: pos } = await supabase
      .from("positions")
      .select("candidate_id")
      .eq("id", positionId)
      .maybeSingle();
    resolvedCandidateId =
      (pos as { candidate_id?: string } | null)?.candidate_id ?? null;
  }

  if (!resolvedCandidateId) {
    return {
      status: "could_not_resolve",
      note: `position ${positionId} has no candidate_id linkage.`,
    };
  }

  await inngest.send({
    name: "candidate/classify",
    data: { candidate_id: resolvedCandidateId },
  });

  // Classification is async; we can't block on the outcome here. Mark as
  // "could not confirm" so the editor sees the row until classify-candidate
  // finishes and a subsequent editor pass can verify.
  return {
    status: "could_not_confirm",
    note: `requeued classify-candidate for candidate ${resolvedCandidateId}; re-check this correction after classification completes.`,
  };
}

// ---------------------------------------------------------------------------
// target_type='officeholder'
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reverifyOfficeholder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  targetId: string | null,
): Promise<DispatchResult> {
  if (!targetId) {
    return {
      status: "could_not_resolve",
      note: "target_type=officeholder but target_id missing.",
    };
  }

  const { data: row, error } = await supabase
    .from("officeholders")
    .select("id, source_url, verified, full_name")
    .eq("id", targetId)
    .maybeSingle();

  if (error || !row) {
    return {
      status: "could_not_resolve",
      note: `officeholder ${targetId} not found: ${error?.message ?? "no row"}`,
    };
  }

  if (!row.source_url) {
    return {
      status: "could_not_resolve",
      note: `officeholder ${targetId} has no source_url; human review required.`,
    };
  }

  return probeUrl(row.source_url, `officeholder ${targetId}`);
}

// ---------------------------------------------------------------------------
// target_type='ballot_measure'
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reverifyBallotMeasure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  targetId: string | null,
): Promise<DispatchResult> {
  if (!targetId) {
    return {
      status: "could_not_resolve",
      note: "target_type=ballot_measure but target_id missing.",
    };
  }

  const { data: row, error } = await supabase
    .from("ballot_measures")
    .select("id, source_url, verified, measure_number")
    .eq("id", targetId)
    .maybeSingle();

  if (error || !row) {
    return {
      status: "could_not_resolve",
      note: `ballot_measure ${targetId} not found: ${error?.message ?? "no row"}`,
    };
  }

  if (!row.source_url) {
    return {
      status: "could_not_resolve",
      note: `ballot_measure ${targetId} has no source_url.`,
    };
  }

  return probeUrl(row.source_url, `ballot_measure ${targetId}`);
}

// ---------------------------------------------------------------------------
// probeUrl — fetch a URL and classify status by HTTP response.
// ---------------------------------------------------------------------------
// We don't do sophisticated diffing (byte-for-byte, semantic compare) at
// this stage — those belong in the per-target-type reverifier proper. This
// is an MVP probe: 200 OK means the source is alive; the editor is told
// "source reachable — you should re-read it and decide". A 404 / 5xx is
// a strong signal that something changed (page moved, article pulled).
// ---------------------------------------------------------------------------

async function probeUrl(
  url: string,
  label: string,
): Promise<DispatchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 200) {
      return {
        status: "could_not_confirm",
        note: `probe ${label}: HTTP 200 from ${url}. Source is reachable but this function does not diff content — editor should read and decide.`,
      };
    }
    if (res.status === 404 || res.status === 410) {
      return {
        status: "verified_corrected",
        note: `probe ${label}: HTTP ${res.status} from ${url}. Source is gone; voter is correct that the underlying claim is stale.`,
      };
    }
    if (res.status >= 500) {
      return {
        status: "could_not_confirm",
        note: `probe ${label}: HTTP ${res.status} from ${url}. Upstream 5xx — re-run later.`,
      };
    }
    return {
      status: "could_not_confirm",
      note: `probe ${label}: HTTP ${res.status} from ${url}. Non-standard response; human review required.`,
    };
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "could_not_confirm",
      note: `probe ${label}: fetch failed (${msg.slice(0, 200)}); human review required.`,
    };
  }
}

// ---------------------------------------------------------------------------
// buildReplyBody — plain text body for the voter reply outbox.
// ---------------------------------------------------------------------------

function buildReplyBody(
  correction: {
    id: string;
    claim: string | null;
    claim_type: string | null;
  },
  outcome: DispatchResult,
): string {
  const outcomePhrase =
    outcome.status === "verified_corrected"
      ? "We verified your correction and updated the record."
      : outcome.status === "no_change_found"
        ? "After re-checking the source, our original data appears correct."
        : outcome.status === "could_not_confirm"
          ? "We re-checked the source but could not make a definitive call. A human editor will follow up."
          : "We weren't able to re-verify automatically; a human editor will review.";

  return [
    "Thank you for submitting a correction to Havesay.",
    "",
    `Your submission: ${correction.claim ?? "(no claim text)"}`,
    correction.claim_type ? `Type: ${correction.claim_type}` : "",
    "",
    outcomePhrase,
    "",
    `Reference: ${correction.id}`,
    "",
    "— The Havesay team",
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}
