'use client';

/**
 * CtaCapture - the Booth Mode handoff plus opt-in email capture, shown after the
 * match summary (V2 pillar 5b).
 *
 * The embed lives in an iframe on a partner page, usually opened on a desktop
 * reader. The destination of the flow is the voter's PHONE in the voting booth,
 * so the primary CTA is "open this on your phone": a client-rendered QR code that
 * points at the full app's Booth Mode. The voter's issue answers ride along in
 * the URL FRAGMENT (compact, encoded), so their picks transfer WITHOUT ever
 * touching a server (browsers never send the hash). If the ballot is large enough
 * that the encoded picks would not fit a scannable code, we drop the picks and
 * link to a bare booth URL (the voter re-answers on the phone), stated honestly.
 *
 * Email capture reuses the existing retention double-opt-in path (captureEmbedLead).
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { useMemo, useState, useSyncExternalStore, useTransition, type FormEvent } from 'react';
import { PRODUCT_NAME } from '@/lib/brand';
import QrCode from '@/components/ui/QrCode';
import { encodeHandoff, type HandoffAnswer } from '@/lib/device/handoff';
import { captureEmbedLead } from './actions';
import type { SwipeAnswer } from './embed-match';

interface CtaCaptureProps {
  partner: string | null;
  /** Booth Mode URL (absolute or relative); resolved absolute for the QR. */
  boothUrl: string;
  /** The voter's swipe answers, carried to the phone in the URL fragment. */
  answers: SwipeAnswer[];
}

export default function CtaCapture({ partner, boothUrl, answers }: CtaCaptureProps) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Build the compact handoff once per answer change. Skips are dropped inside
  // encodeHandoff; domain rides along so the phone rebuilds the same emphasis.
  const encoded = useMemo(() => {
    const handoff: HandoffAnswer[] = answers
      .filter((a) => a.choice !== 'skip')
      .map((a) => ({
        issueId: a.issueId,
        choice: a.choice as 'agree' | 'disagree',
        important: a.important,
        domain: a.domain,
      }));
    return encodeHandoff(handoff);
  }, [answers]);

  // Whether the picks fit inside a scannable code (else re-answer on the phone).
  const picksCarried = encoded !== null;

  // Resolve the booth URL to an absolute one (against our iframe origin) for the
  // QR + link, and attach the fragment. `mounted` is false during SSR (server
  // snapshot) and true on the client, so the window-dependent resolution happens
  // only in the browser without a setState-in-effect and without a hydration
  // mismatch (the pre-mount value is the plain relative/absolute booth URL).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const boothLink = useMemo(() => {
    const withFragment = (base: string) => (encoded ? `${base}#hs=${encoded}` : base);
    if (!mounted || typeof window === 'undefined') return withFragment(boothUrl);
    try {
      const base = new URL(boothUrl, window.location.href).toString().replace(/#.*$/, '');
      return withFragment(base);
    } catch {
      return withFragment(boothUrl);
    }
  }, [mounted, boothUrl, encoded]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('idle');
    setMessage(null);
    const fd = new FormData();
    fd.set('email', email);
    if (partner) fd.set('partner', partner);
    startTransition(async () => {
      const res = await captureEmbedLead(fd);
      if (res.ok) {
        setStatus('ok');
        setMessage(
          res.alreadySubscribed
            ? 'You are already on the list. Thanks for coming back.'
            : 'Check your inbox to confirm your email. We only send ballot reminders and updates.',
        );
        setEmail('');
      } else {
        setStatus('error');
        setMessage(res.error ?? 'Something went wrong. Please try again.');
      }
    });
  }

  return (
    <div className="civic-card civic-card-emphasized" style={{ background: 'var(--civic-primary-soft)' }}>
      <h3 style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 700, color: 'var(--civic-text)' }}>
        Take your ballot into the booth
      </h3>
      <p style={{ fontSize: 14, color: 'var(--civic-text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
        Scan this with your phone to open your big-type checklist, then bring it
        with you when you vote. It works offline, and your answers stay on your
        device.
      </p>

      <div className="mt-4 flex flex-col items-center gap-3">
        <QrCode value={boothLink} size={200} label="Scan to open your booth checklist on your phone" />
        <p style={{ fontSize: 12.5, color: 'var(--civic-text-muted)', textAlign: 'center' }}>
          {picksCarried
            ? 'Point your phone camera at the code. Your picks come with you.'
            : 'Point your phone camera at the code. You will finish a couple of quick answers on your phone.'}
        </p>
      </div>

      <a
        href={boothLink}
        target="_blank"
        rel="noopener noreferrer"
        className="civic-btn civic-btn-secondary mt-2"
        style={{ width: '100%' }}
      >
        Already on your phone? Open it here &rarr;
      </a>

      <form onSubmit={onSubmit} className="mt-5">
        <label htmlFor="embed-email" style={{ fontSize: 13, fontWeight: 600, color: 'var(--civic-text)' }}>
          Or get a reminder before election day
        </label>
        <div className="flex flex-col sm:flex-row gap-2 mt-2">
          <input
            id="embed-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={{
              flex: 1,
              minHeight: 44,
              padding: '0 12px',
              borderRadius: 'var(--r-md)',
              border: '1.5px solid var(--civic-border)',
              background: 'var(--civic-surface)',
              color: 'var(--civic-text)',
              fontSize: 15,
            }}
          />
          <button type="submit" className="civic-btn civic-btn-secondary" disabled={pending} aria-disabled={pending}>
            {pending ? 'Sending...' : 'Email me'}
          </button>
        </div>
        {message && (
          <p
            role="status"
            style={{
              fontSize: 12.5,
              marginTop: 8,
              color: status === 'error' ? 'var(--state-error-fg)' : 'var(--state-success-fg)',
            }}
          >
            {message}
          </p>
        )}
        <p style={{ fontSize: 11, color: 'var(--civic-text-muted)', marginTop: 8 }}>
          Opt-in only. We never sell your email. Powered by {PRODUCT_NAME}.
        </p>
      </form>
    </div>
  );
}
