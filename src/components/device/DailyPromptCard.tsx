'use client';

/**
 * "Today's question" card (work-order Phase 2A - device-side prompt experience).
 *
 * Surfaced on /guide. It fetches the server's server-blind candidate LIST
 * (/api/daily-prompt), then picks the question to show ENTIRELY on the device
 * (first unanswered, else the oldest-answered stance for a "still you?"
 * refresh). Answering writes the stance to the device profile via
 * setAnswer(..., 'daily-prompt') + recordPromptShown, and because /guide
 * recomputes its scores from the device profile, the match chips update live the
 * moment the answer lands.
 *
 * PRIVACY (invariant 1): the ONLY network call is a GET for the public
 * candidate list. No opinion is ever sent. The pick, the answer, the streak, and
 * the one-per-day cap all live on the device.
 *
 * Frequency: one ANSWER per calendar day (device-tracked via promptHistory).
 * After answering, the card shows a done/streak state for the rest of the day.
 * Dismissible: "Not today" hides it for the session without spending the cap.
 *
 * BetaChip carried because the underlying classifier + question bank are
 * AI-touched, per the project's every-AI-surface-carries-Beta rule.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useVoterProfile } from '@/lib/device/useVoterProfile';
import {
  pickDailyPromptQuestion,
  hasAnsweredPromptToday,
  computeStreak,
  type DailyPromptPickReason,
} from '@/lib/device/daily-prompt';
import { BetaChip, CivicButton, Eyebrow } from '@/components/guide/primitives';
import type {
  DailyPromptQuestion,
  DailyPromptResponse,
} from '@/types/daily-prompt';

const DAILY_PROMPT_PATH = '/api/daily-prompt';

/** Module cache so a re-mount (route change back to /guide) does not refetch. */
let listPromise: Promise<DailyPromptResponse | null> | null = null;
function fetchDailyPromptList(): Promise<DailyPromptResponse | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (listPromise) return listPromise;
  listPromise = fetch(DAILY_PROMPT_PATH, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
    .then((r) => (r.ok ? (r.json() as Promise<DailyPromptResponse>) : null))
    .catch(() => null);
  return listPromise;
}

const REASON_EYEBROW: Record<Exclude<DailyPromptPickReason, 'none'>, string> = {
  unanswered: "Today's question",
  refresh: 'Still you?',
};

export default function DailyPromptCard() {
  const { profile, loading: profileLoading, setAnswer, recordPromptShown } =
    useVoterProfile();
  const [list, setList] = useState<DailyPromptResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [justAnswered, setJustAnswered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDailyPromptList().then((r) => {
      if (cancelled) return;
      setList(r);
      setListLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Device-side pick among the server's candidate list.
  const pick = useMemo(() => {
    if (!list || list.questions.length === 0) {
      return { candidate: null, reason: 'none' as DailyPromptPickReason };
    }
    return pickDailyPromptQuestion(list.questions, profile);
  }, [list, profile]);

  const answeredToday = useMemo(
    () => hasAnsweredPromptToday(profile),
    [profile],
  );
  const streak = useMemo(() => computeStreak(profile), [profile]);

  // The full question content for the chosen candidate.
  const question: DailyPromptQuestion | null = useMemo(() => {
    if (!pick.candidate || !list) return null;
    return (
      list.questions.find((q) => q.questionId === pick.candidate!.questionId) ??
      null
    );
  }, [pick, list]);

  // Reset the selected option when the shown question changes.
  useEffect(() => {
    setSelected(null);
  }, [question?.questionId]);

  const loading = profileLoading || listLoading;

  // Nothing to show: still loading, dismissed, no candidate, or the once-per-day
  // answer cap is already spent (and we did not just answer in this render pass).
  if (loading) return null;
  if (dismissed) return null;

  // Post-answer / cap-spent state: a gentle "done for today" with the streak.
  if ((answeredToday || justAnswered) && streak > 0) {
    return (
      <section
        className="civic-card"
        aria-label="Daily question answered"
        style={{ borderColor: 'var(--civic-border-strong)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            aria-hidden="true"
            style={{
              flexShrink: 0,
              display: 'inline-grid',
              placeItems: 'center',
              width: 34,
              height: 34,
              borderRadius: '50%',
              background: 'var(--state-success-bg)',
              color: 'var(--state-success-fg)',
              fontSize: 16,
              fontWeight: 700,
            }}
          >
            ✓
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p
              style={{
                fontFamily: 'var(--font-serif)',
                fontWeight: 700,
                fontSize: 15,
                color: 'var(--civic-text)',
              }}
            >
              Answered today. {streakLabel(streak)}
            </p>
            <p
              style={{
                marginTop: 2,
                fontSize: 13,
                color: 'var(--civic-text-secondary)',
                lineHeight: 1.5,
              }}
            >
              Come back tomorrow to keep your stance current with the news.
            </p>
          </div>
        </div>
      </section>
    );
  }

  // No candidate to show (empty bank, no ballot, or fully answered and nothing
  // stale enough to refresh). Stay quiet rather than nag.
  if (!question || pick.reason === 'none') return null;

  const eyebrow =
    pick.reason === 'refresh'
      ? REASON_EYEBROW.refresh
      : REASON_EYEBROW.unanswered;

  async function handleSubmit() {
    if (selected === null || !question || saving) return;
    setSaving(true);
    try {
      // Write the stance to the device (source 'daily-prompt'), then record the
      // prompt in history so the streak + cap + never-re-ask logic all update.
      await setAnswer(question.subDimensionId, selected, 'daily-prompt');
      await recordPromptShown({
        questionId: question.questionId,
        subDimensionId: question.subDimensionId,
        answered: true,
        score: selected,
      });
      setJustAnswered(true);
    } catch {
      // Device-storage failure (private mode / quota): do not strand the voter.
      // The card simply will not advance; the guide keeps working.
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="civic-card"
      aria-label="Daily question"
      style={{ borderColor: 'var(--civic-border-strong)' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <Eyebrow>{eyebrow}</Eyebrow>
          {question.onBallot && (
            <span
              className="civic-mono"
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--civic-primary)',
                background: 'var(--civic-primary-soft)',
                borderRadius: 'var(--r-pill)',
                padding: '1px 7px',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              On your ballot
            </span>
          )}
        </span>
        <BetaChip small />
      </div>

      {pick.reason === 'refresh' && (
        <p
          style={{
            fontSize: 13,
            color: 'var(--civic-text-secondary)',
            lineHeight: 1.5,
            marginBottom: 10,
          }}
        >
          You answered this a while ago. Is it still where you stand?
        </p>
      )}

      <h3
        className="civic-serif"
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--civic-text)',
          lineHeight: 1.25,
          marginBottom: 14,
        }}
      >
        {question.prompt}
      </h3>

      <div role="radiogroup" aria-label={question.prompt} style={{ display: 'grid', gap: 8 }}>
        {question.options.map((opt) => {
          const active = selected === opt.score;
          return (
            <button
              key={`${opt.label}-${opt.score}`}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSelected(opt.score)}
              style={{
                textAlign: 'left',
                padding: '12px 14px',
                borderRadius: 'var(--r-md)',
                border: active
                  ? '2px solid var(--civic-primary)'
                  : '1.5px solid var(--civic-border)',
                background: active
                  ? 'var(--civic-primary-soft)'
                  : 'var(--civic-surface)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                minHeight: 44,
                transition: 'border-color var(--t-fast) var(--ease-standard)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  marginTop: 2,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  flexShrink: 0,
                  border: active
                    ? '5px solid var(--civic-primary)'
                    : '2px solid var(--civic-border-strong)',
                  background: 'var(--civic-surface)',
                }}
              />
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontWeight: 600,
                    fontSize: 14,
                    color: 'var(--civic-text)',
                  }}
                >
                  {opt.label}
                </span>
                {opt.description && (
                  <span
                    style={{
                      display: 'block',
                      fontSize: 13,
                      color: 'var(--civic-text-secondary)',
                      marginTop: 2,
                      lineHeight: 1.45,
                    }}
                  >
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <CivicButton
          variant="primary"
          size="md"
          onClick={handleSubmit}
          disabled={selected === null || saving}
        >
          {saving ? 'Saving…' : 'Save answer'}
        </CivicButton>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="civic-btn civic-btn-tertiary civic-btn-sm"
          aria-label="Dismiss today's question"
        >
          Not today
        </button>
        {streak > 0 && (
          <span
            className="civic-mono"
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              color: 'var(--civic-text-muted)',
            }}
            aria-label={`Current streak: ${streak} day${streak === 1 ? '' : 's'}`}
          >
            🔥 {streak}-day streak
          </span>
        )}
      </div>

      <p
        style={{
          marginTop: 12,
          fontSize: 12,
          color: 'var(--civic-text-muted)',
          lineHeight: 1.5,
        }}
      >
        Saved only on this device.{' '}
        <Link
          href="/privacy"
          style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}
        >
          How this works
        </Link>
      </p>
    </section>
  );
}

function streakLabel(streak: number): string {
  if (streak <= 1) return 'Nice start.';
  return `${streak}-day streak going.`;
}
