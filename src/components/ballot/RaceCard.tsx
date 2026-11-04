"use client";

import { useState } from "react";
import type { Confidence, RaceLevel } from "@/types/database";
import type { RaceDataQuality, DataQualityTier } from "@/lib/data-quality";
import type { BallotRace, BallotCandidate } from "@/lib/ballot-lookup/ballot-loader";
import CandidateRow from "./CandidateRow";

const LEVEL_STYLES: Record<RaceLevel, string> = {
  federal: "bg-[var(--color-primary)] text-white",
  state: "bg-[var(--color-accent)] text-[var(--color-primary-dark)]",
  county: "bg-[var(--color-bg-muted)] text-[var(--color-text-secondary)]",
  judicial: "bg-[var(--color-bg-muted)] text-[var(--color-text-secondary)]",
  municipal: "bg-[var(--color-bg-muted)] text-[var(--color-text-secondary)]",
  school: "bg-[var(--color-bg-muted)] text-[var(--color-text-secondary)]",
  special: "bg-[var(--color-bg-muted)] text-[var(--color-text-secondary)]",
};

const LEVEL_LABELS: Record<RaceLevel, string> = {
  federal: "Federal",
  state: "State",
  county: "County",
  judicial: "Judicial",
  municipal: "Municipal",
  school: "School",
  special: "Special District",
};

const TIER_STYLES: Record<DataQualityTier, string> = {
  A: "bg-emerald-100 text-emerald-900 border-emerald-300",
  B: "bg-amber-100 text-amber-900 border-amber-300",
  C: "bg-orange-100 text-orange-900 border-orange-300",
  D: "bg-slate-100 text-slate-700 border-slate-300",
};

const TIER_LABELS: Record<DataQualityTier, string> = {
  A: "Strong data",
  B: "Partial data",
  C: "Thin data",
  D: "Pending",
};

/**
 * Format an ISO date string as e.g. "Tuesday, June 23, 2026". Used for the
 * primary-date prominence treatment per Issue C. We deliberately include the
 * day-of-week — voters often plan around it.
 */
function formatHumanDate(iso: string): string {
  // Treat the date as a calendar date (no TZ) by parsing the YYYY-MM-DD parts
  // directly. `new Date(iso)` would interpret as UTC midnight which can shift
  // the displayed weekday by one in negative TZ offsets.
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Normalize party labels so legacy "Democratic" and new-graph "Democratic
 * Party" land in the same bucket. We strip a trailing " Party" and unify
 * "Democrat"/"Democratic" to a single canonical form. Returned name is
 * what the user sees in the section header.
 */
function canonicalParty(raw: string): string {
  let p = raw.trim().replace(/\s+Party$/i, "").trim();
  // Common stylistic variants — collapse to the most-recognizable label.
  const lower = p.toLowerCase();
  if (lower === "democrat" || lower === "democratic") return "Democratic";
  if (lower === "republican") return "Republican";
  if (lower === "libertarian") return "Libertarian";
  if (lower === "green") return "Green";
  if (lower === "independent american") return "Independent American";
  if (lower === "independent" || lower === "unaffiliated") {
    return "Independent / Unaffiliated";
  }
  return p;
}

/**
 * Group candidates by party for partisan primaries. Independents and missing
 * party cluster into a "No party / unaffiliated" bucket so they're still
 * visible without polluting the R/D groupings.
 */
function groupByParty(
  candidates: BallotCandidate[],
): Array<{ party: string; candidates: BallotCandidate[] }> {
  const buckets = new Map<string, BallotCandidate[]>();
  for (const c of candidates) {
    const key =
      c.party && c.party.trim()
        ? canonicalParty(c.party)
        : "No party / unaffiliated";
    const arr = buckets.get(key) ?? [];
    arr.push(c);
    buckets.set(key, arr);
  }
  // Stable, predictable order: alpha by party name; the "No party" bucket
  // sinks to the bottom so the major parties read first.
  const entries = [...buckets.entries()].map(([party, candidates]) => ({
    party,
    candidates,
  }));
  entries.sort((a, b) => {
    const noA = a.party === "No party / unaffiliated";
    const noB = b.party === "No party / unaffiliated";
    if (noA !== noB) return noA ? 1 : -1;
    return a.party.localeCompare(b.party);
  });
  return entries;
}

export default function RaceCard({
  race,
  matchScores,
  dataQuality,
}: {
  race: BallotRace;
  matchScores?: Record<string, { score: number; confidence: Confidence }>;
  dataQuality?: RaceDataQuality;
}) {
  const [expanded, setExpanded] = useState(true);

  const isPrimary = race.type === "primary";
  const days = race.daysUntilElection;

  /**
   * Per-party primary chip copy — "Republican primary in N days" /
   * "Democratic primary tomorrow" etc. Lives at the party-section header
   * (not the race header) because each party is technically running its
   * own primary contest. Per-party dates are surfaced via
   * candidate.partyPrimaryDate (see migration 20260502000005); when
   * absent we fall back to the race-level date.
   */
  function partyPrimaryWhen(party: string, n: number): string {
    if (n < 0) return `${party} primary already held`;
    if (n === 0) return `${party} primary today`;
    if (n === 1) return `${party} primary tomorrow`;
    return `${party} primary in ${n} days`;
  }

  /**
   * Compute calendar-day delta from `today` (local) to an ISO date,
   * matching the server-side computation in voterRowsToBallotShape().
   * We parse the date as a calendar date (not UTC) for the same reason
   * as formatHumanDate.
   */
  function daysFromIso(iso: string): number {
    const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
    if (!y || !m || !d) return 0;
    const target = new Date(y, m - 1, d);
    const now = new Date();
    const todayMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    return Math.ceil(
      (target.getTime() - todayMidnight.getTime()) / (1000 * 60 * 60 * 24),
    );
  }

  /**
   * For a party subsection, pick the date+countdown to show. Prefer any
   * candidate's partyPrimaryDate (they should all match within a single
   * party subsection — same election + same canonical party = same row).
   * Fall back to the race-level date when no override exists.
   */
  function partyDateAndDays(
    candidates: BallotCandidate[],
  ): { iso: string | null; days: number } {
    const override = candidates.find((c) => c.partyPrimaryDate)?.partyPrimaryDate;
    if (override) return { iso: override, days: daysFromIso(override) };
    return { iso: race.election_date ?? null, days };
  }

  return (
    <div className="civic-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={`text-xs font-bold uppercase tracking-wide px-2.5 py-1 rounded-md shrink-0 ${LEVEL_STYLES[race.level]}`}
          >
            {LEVEL_LABELS[race.level]}
          </span>
          <h3 className="text-lg font-bold text-[var(--color-text)] truncate">
            {race.name}
          </h3>
        </div>
        <svg
          className={`w-5 h-5 text-[var(--color-text-muted)] shrink-0 transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
          />
        </svg>
      </button>

      {/*
        Primary-date prominence: per user testing on 2026-05-02 we moved
        the date+countdown chip from the race header DOWN to each party
        subsection header (see the party loop below). General-election
        cards keep the race-level treatment unchanged.
      */}

      {dataQuality && (
        <div
          className={`mt-2 inline-flex items-start gap-2 border rounded-md px-2.5 py-1.5 text-xs ${TIER_STYLES[dataQuality.tier]}`}
          title={dataQuality.blurb}
        >
          <span className="font-bold shrink-0">
            {TIER_LABELS[dataQuality.tier]}
          </span>
          <span className="opacity-90">
            {dataQuality.wellCovered} of {dataQuality.candidateCount} candidates
            well-documented
          </span>
        </div>
      )}

      {expanded && (
        <div className="mt-3">
          {/* Zero / one candidate notes. A race with no candidate rows or a
              single uncontested candidate would otherwise render as an empty
              or lonely list that reads like a loading bug. Name the situation
              plainly instead. These are display notes only: we do not assert
              "unopposed" as a fact (filings may still be incomplete), we say
              what we currently have on file. */}
          {race.candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
              <p className="font-medium text-[var(--color-text)]">
                No candidates on file yet for this race.
              </p>
              <p className="mt-1">
                We are still adding candidates for this contest. Check back, or
                let us know if someone is missing.
              </p>
            </div>
          ) : race.candidates.length === 1 ? (
            <>
              <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
                <p className="font-medium text-[var(--color-text)]">
                  Only one candidate on file so far.
                </p>
                <p className="mt-1">
                  This may be an uncontested race, or other candidates may not
                  be added yet. We show what we have on file now.
                </p>
              </div>
              <div className="divide-y divide-[var(--color-border)]">
                {race.candidates.map((candidate) => {
                  const match = matchScores?.[candidate.id];
                  return (
                    <CandidateRow
                      key={candidate.id}
                      candidate={candidate}
                      matchScore={match?.score}
                      matchConfidence={match?.confidence}
                    />
                  );
                })}
              </div>
            </>
          ) : isPrimary ? (
            // Issue C: party-grouped subsections for partisan primaries.
            // Each party is technically running its own primary so we
            // separate them visually instead of mixing the lists.
            <div className="space-y-4">
              {groupByParty(race.candidates).map(({ party, candidates }) => {
                // Per-party date: candidate.partyPrimaryDate when present
                // (override row in `party_primaries`), else the race-level
                // date. Days-until is recomputed from the per-party date
                // when applicable so the chip stays in sync with the
                // displayed date.
                const { iso: partyIso, days: partyDays } =
                  partyDateAndDays(candidates);
                return (
                <section key={party}>
                  <div className="mb-2 pb-1 border-b border-[var(--color-border)]">
                    <h4 className="text-sm font-bold text-[var(--color-text)]">
                      {party}
                      <span className="font-normal text-[var(--color-text-muted)] ml-1">
                        primary
                      </span>
                    </h4>
                    {/*
                      Per-party countdown chip. Only renders when there's
                      a date to show (either the party-specific override
                      from party_primaries, or the race-level date as
                      fallback). When `party_primaries` has no row for
                      this (election_id, party) combo, every candidate
                      in this subsection has partyPrimaryDate=undefined
                      and we fall back to race.election_date.
                    */}
                    {partyIso && (
                      <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md bg-[var(--color-primary)] text-white">
                          {partyPrimaryWhen(party, partyDays)}
                        </span>
                        <span className="text-sm text-[var(--color-text-secondary)]">
                          on {formatHumanDate(partyIso)}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="divide-y divide-[var(--color-border)]">
                    {candidates.map((candidate) => {
                      const match = matchScores?.[candidate.id];
                      return (
                        <CandidateRow
                          key={candidate.id}
                          candidate={candidate}
                          matchScore={match?.score}
                          matchConfidence={match?.confidence}
                        />
                      );
                    })}
                  </div>
                </section>
                );
              })}
            </div>
          ) : (
            // General election: keep the flat list — every candidate runs
            // against every other candidate.
            <div className="divide-y divide-[var(--color-border)]">
              {race.candidates.map((candidate) => {
                const match = matchScores?.[candidate.id];
                return (
                  <CandidateRow
                    key={candidate.id}
                    candidate={candidate}
                    matchScore={match?.score}
                    matchConfidence={match?.confidence}
                  />
                );
              })}
            </div>
          )}

          {dataQuality && dataQuality.tier !== "A" && (
            <div className="pt-3 mt-3 border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)] italic">
              {dataQuality.blurb}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
