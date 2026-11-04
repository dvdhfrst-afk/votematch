'use client';

/**
 * EmbedApp - the Utah embeddable widget's client flow:
 *   address entry -> ballot preview -> per-issue swipe cards -> match summary
 *   -> "open the full app" CTA + email capture.
 *
 * Brandable: reads a partner slug for the co-branding slot; the product label
 * comes from the single brand constant (lib/brand). On-device: the ballot payload
 * is public data (resolved from the typed address), and every voter answer stays
 * in this component's state, scored in the browser. Nothing the voter enters is
 * sent to the server.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 * Mobile-first; no entrance animations on load (content is visible immediately).
 */

import { useCallback, useMemo, useState, useTransition } from 'react';
import { PRODUCT_NAME } from '@/lib/brand';
import type { EmbedPayload } from '@/lib/embed/payload';
import { resolveEmbedBallot } from './actions';
import type { SwipeAnswer } from './embed-match';
import SwipeStep from './SwipeStep';
import SummaryStep from './SummaryStep';
import CtaCapture from './CtaCapture';
import EmbedHeightReporter from './EmbedHeightReporter';
import { formatBallotDate, levelLabel } from './ui';

type Phase = 'address' | 'ballot' | 'swipe' | 'summary';

interface EmbedAppProps {
  partner: string | null;
  /** Booth Mode URL (possibly relative); the QR handoff resolves it absolute. */
  boothUrl: string;
}

function prettyPartner(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export default function EmbedApp({ partner, boothUrl }: EmbedAppProps) {
  const [phase, setPhase] = useState<Phase>('address');
  const [address, setAddress] = useState('');
  const [payload, setPayload] = useState<EmbedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [answers, setAnswers] = useState<SwipeAnswer[]>([]);

  const submitAddress = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) {
        setError('Enter your home street address.');
        return;
      }
      setError(null);
      startTransition(async () => {
        const res = await resolveEmbedBallot(v);
        if (res.ok) {
          setPayload(res.payload);
          setAnswers([]);
          setPhase('ballot');
        } else {
          setError(res.message);
        }
      });
    },
    [],
  );

  const onAnswer = useCallback((answer: SwipeAnswer) => {
    setAnswers((prev) => {
      const next = prev.filter((a) => a.issueId !== answer.issueId);
      next.push(answer);
      return next;
    });
  }, []);

  return (
    <div style={{ background: 'var(--civic-surface)', color: 'var(--civic-text)', minHeight: '100%' }}>
      <EmbedHeightReporter />
      <span className="civic-header-stripe" aria-hidden="true" />
      <CoBrandHeader partner={partner} />

      <div className="civic-container" style={{ paddingBlock: 20, maxWidth: '44rem' }}>
        {phase === 'address' && (
          <AddressStep
            value={address}
            onChange={setAddress}
            onSubmit={submitAddress}
            pending={pending}
            error={error}
          />
        )}

        {phase === 'ballot' && payload && (
          <BallotStep payload={payload} onStart={() => setPhase('swipe')} onReset={() => setPhase('address')} />
        )}

        {phase === 'swipe' && payload && (
          <SwipeStep
            issues={payload.swipeIssues}
            answers={answers}
            onAnswer={onAnswer}
            onComplete={() => setPhase('summary')}
            onBack={() => setPhase('ballot')}
          />
        )}

        {phase === 'summary' && payload && (
          <div className="space-y-6">
            <SummaryStep payload={payload} answers={answers} onRefine={() => setPhase('swipe')} />
            <CtaCapture partner={partner} boothUrl={boothUrl} answers={answers} />
          </div>
        )}
      </div>

      <EmbedFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Co-brand header + footer
// ---------------------------------------------------------------------------

function CoBrandHeader({ partner }: { partner: string | null }) {
  return (
    <header
      className="civic-container"
      style={{ paddingBlock: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid var(--civic-border)' }}
    >
      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--civic-primary)' }}>
        Your ballot, explained
      </span>
      {partner ? (
        <span style={{ fontSize: 12, color: 'var(--civic-text-muted)', textAlign: 'right', lineHeight: 1.2 }}>
          in partnership with
          <br />
          <span style={{ fontWeight: 700, color: 'var(--civic-text-secondary)' }}>{prettyPartner(partner)}</span>
        </span>
      ) : (
        <span style={{ fontSize: 12, color: 'var(--civic-text-muted)' }}>Nonpartisan · Utah 2026</span>
      )}
    </header>
  );
}

function EmbedFooter() {
  return (
    <footer
      className="civic-container"
      style={{ paddingBlock: 16, marginTop: 8, borderTop: '1px solid var(--civic-border)', fontSize: 11.5, color: 'var(--civic-text-muted)', textAlign: 'center' }}
    >
      <p>
        Nonpartisan. Your answers stay on your device. Powered by {PRODUCT_NAME}.
      </p>
      <p style={{ marginTop: 4 }}>
        <a href="/methodology" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--civic-link)', textDecoration: 'underline' }}>
          How this works
        </a>
        <span style={{ margin: '0 6px' }}>·</span>
        <a href="/corrections" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--civic-link)', textDecoration: 'underline' }}>
          Report a correction
        </a>
        <span style={{ margin: '0 6px' }}>·</span>
        <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--civic-link)', textDecoration: 'underline' }}>
          Privacy
        </a>
      </p>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Step 1: address
// ---------------------------------------------------------------------------

function AddressStep({
  value,
  onChange,
  onSubmit,
  pending,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 'clamp(24px, 1.4rem + 1.2vw, 34px)', fontWeight: 700, color: 'var(--civic-text)', lineHeight: 1.12 }}>
        See your whole ballot, explained.
      </h1>
      <p style={{ fontSize: 15, color: 'var(--civic-text-secondary)', marginTop: 10, lineHeight: 1.5, maxWidth: '52ch' }}>
        Enter your home address to find every race on your Utah ballot. Then answer a few quick issue cards to
        see where you line up. We use your address only to look up your races, and we do not store it.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        className="mt-5"
      >
        <label htmlFor="embed-address" style={{ fontSize: 13, fontWeight: 600, color: 'var(--civic-text)' }}>
          Home street address
        </label>
        <input
          id="embed-address"
          type="text"
          autoComplete="street-address"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="123 Main St, Salt Lake City, UT 84101"
          style={{
            width: '100%',
            minHeight: 48,
            padding: '0 14px',
            marginTop: 6,
            borderRadius: 'var(--r-md)',
            border: '1.5px solid var(--civic-border)',
            background: 'var(--civic-surface)',
            color: 'var(--civic-text)',
            fontSize: 16,
          }}
        />
        {error && (
          <p role="alert" style={{ fontSize: 13, color: 'var(--state-error-fg)', marginTop: 8 }}>
            {error}
          </p>
        )}
        <button
          type="submit"
          className="civic-btn civic-btn-primary civic-btn-lg mt-4"
          style={{ width: '100%' }}
          disabled={pending}
          aria-disabled={pending}
        >
          {pending ? 'Looking up your ballot...' : 'Show my ballot'}
        </button>
      </form>

      <p style={{ fontSize: 11.5, color: 'var(--civic-text-muted)', marginTop: 12 }}>
        Use your home address, not a P.O. box or workplace. Utah pilot for the November 3, 2026 election.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: ballot preview
// ---------------------------------------------------------------------------

function BallotStep({
  payload,
  onStart,
  onReset,
}: {
  payload: EmbedPayload;
  onStart: () => void;
  onReset: () => void;
}) {
  const nextDate = useMemo(() => {
    const dates = payload.races.map((r) => r.electionDate).filter(Boolean).sort();
    return dates[0] ? formatBallotDate(dates[0]) : null;
  }, [payload]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 26, fontWeight: 700, color: 'var(--civic-text)' }}>
          Your ballot
        </h1>
        <button type="button" className="civic-btn civic-btn-tertiary civic-btn-sm" onClick={onReset}>
          Change address
        </button>
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--civic-text-secondary)' }}>{payload.address}</p>
      {nextDate && (
        <p style={{ fontSize: 13, color: 'var(--civic-primary)', fontWeight: 600, marginTop: 4 }}>
          Election day: {nextDate}
        </p>
      )}

      <p style={{ fontSize: 14, color: 'var(--civic-text-secondary)', marginTop: 14, lineHeight: 1.5 }}>
        We found <strong>{payload.counts.races}</strong> race{payload.counts.races === 1 ? '' : 's'} and{' '}
        <strong>{payload.counts.candidates}</strong> candidate{payload.counts.candidates === 1 ? '' : 's'} on your
        ballot. Next, answer a short set of issue cards scoped to these offices.
      </p>

      <ul className="mt-4 space-y-2">
        {payload.races.map((r) => (
          <li
            key={r.id}
            className="civic-card"
            style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
          >
            <div style={{ minWidth: 0 }}>
              <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--civic-text)' }}>{r.name}</span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--civic-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
              {levelLabel(r.level)}
            </span>
          </li>
        ))}
      </ul>

      <button type="button" className="civic-btn civic-btn-primary civic-btn-lg mt-6" style={{ width: '100%' }} onClick={onStart}>
        Start the quick match ({payload.swipeIssues.length} cards)
      </button>
    </div>
  );
}
