"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  getOrCreateInviteCode,
  getInviteStats,
} from "@/app/invite-actions";

/**
 * InvitePanel — compact "invite friends" surface on /results (and later
 * /dashboard).
 *
 * Per the operator's 2026-05-02 amendments: this is the ONLY voter-side share
 * surface. The cut ballot-card share path used to disclose match results,
 * which created peer-pressure risk. The invite link discloses nothing
 * about the inviter's positions — it's a one-way attribution token.
 *
 * Counters ("X visited / Y completed") come from getInviteStats(), which
 * soft-caps display values to discourage farming-style gaming.
 */

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://ballotbridge.org";

export default function InvitePanel() {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    visited: number;
    completed: number;
    visited_clamped: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const codeRes = await getOrCreateInviteCode();
      if ("error" in codeRes) {
        setError(codeRes.error);
        return;
      }
      setCode(codeRes.code);
      const statsRes = await getInviteStats();
      setStats(statsRes);
    });
  }, []);

  const inviteUrl = code ? `${APP_URL}/i/${code}` : "";

  const handleCopy = useCallback(async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fall back to selection
    }
  }, [inviteUrl]);

  const handleShare = useCallback(async () => {
    if (!inviteUrl) return;
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({
          title: "Havesay",
          text: "Help your neighbors get their ballot.",
          url: inviteUrl,
        });
      } else {
        await handleCopy();
      }
    } catch {
      // User cancelled — no-op
    }
  }, [inviteUrl, handleCopy]);

  if (error) {
    // Fail silent rather than showing scary error to voter.
    return null;
  }

  return (
    <section
      aria-label="Invite friends"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 sm:p-6"
    >
      <h2 className="text-lg font-bold text-[var(--color-primary)] mb-1">
        Help your neighbors get their ballot.
      </h2>
      <p className="text-sm text-[var(--color-text-secondary)] mb-4">
        We don&rsquo;t show them what you matched.
      </p>

      <div className="flex flex-col sm:flex-row items-stretch gap-2 mb-3">
        <input
          type="text"
          readOnly
          value={isPending && !inviteUrl ? "Generating link…" : inviteUrl}
          className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm font-mono"
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Your invite link"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!code}
            className="civic-btn-secondary px-4 py-2 text-sm disabled:opacity-50"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={handleShare}
            disabled={!code}
            className="civic-btn-primary px-4 py-2 text-sm disabled:opacity-50"
          >
            Share
          </button>
        </div>
      </div>

      {stats && (stats.visited > 0 || stats.completed > 0) && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {stats.visited} visited · {stats.completed} completed their match
          {stats.visited_clamped && " (showing clamped count)"}
        </p>
      )}
    </section>
  );
}
