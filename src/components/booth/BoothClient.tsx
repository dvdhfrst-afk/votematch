'use client';

/**
 * Booth Mode (V2 pillar 5b) — the product's destination moment.
 *
 * The voter's phone goes INTO the voting booth. This view is a big-type,
 * high-contrast, race-by-race checklist of their picks, readable at arm's length,
 * that each race can be tapped to check off as they fill in the paper ballot.
 *
 * ON-DEVICE + OFFLINE (the hard requirements):
 *   - Picks come from the device profile (IndexedDB via useVoterProfile) and, for
 *     races the voter did not explicitly pick, from the client matcher over the
 *     positions bundle. NO opinion is ever sent to a server here.
 *   - The positions bundle (public race/candidate display data) is fetched via
 *     the shared, service-worker-cached path, so a voter who opened this once
 *     online sees it again with no network at the polling place. The route itself
 *     is precached in the service worker shell (public/sw.js).
 *   - Check-off state persists to localStorage (on-device, survives a reload,
 *     zero network).
 *   - The screen is kept awake with the Screen Wake Lock API where supported.
 *   - Nothing here requires auth or a server round-trip.
 *
 * A cross-device handoff (#hs=...) imported from the embed's QR is applied to the
 * device profile on arrival, once, only when this device has no answers yet.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { MatchResult, RaceLevel } from '@/types/database';
import { useVoterProfile } from '@/lib/device/useVoterProfile';
import { fetchPositionsBundle } from '@/lib/device/guide-scores';
import { computeMatchesFromBundle } from '@/lib/device/match-client';
import { useWakeLock } from '@/lib/device/useWakeLock';
import { decodeHandoff } from '@/lib/device/handoff';
import { applyHandoffToProfile } from '@/lib/device/handoff-apply';
import type { PositionsBundle } from '@/lib/device/bundle';
import { ScoreChip } from '@/components/guide/primitives';

// Ballot reading order, top to bottom, mirrors /ballot LEVEL_ORDER.
const LEVEL_ORDER: RaceLevel[] = [
  'federal',
  'state',
  'county',
  'municipal',
  'school',
  'special',
  'judicial',
];

const LEVEL_LABEL: Record<RaceLevel, string> = {
  federal: 'Federal',
  state: 'State',
  county: 'County',
  municipal: 'City & town',
  school: 'School board',
  special: 'Special district',
  judicial: 'Judicial',
};

const CHECKED_KEY = 'havesay-booth-checked-v1';

interface BoothRow {
  raceId: string;
  raceName: string;
  level: RaceLevel;
  candidateName: string | null;
  score: number | null;
}

function loadChecked(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(CHECKED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveChecked(set: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHECKED_KEY, JSON.stringify([...set]));
  } catch {
    /* private mode / quota: check-off degrades to in-memory only */
  }
}

// Online status as an external store (avoids setState-in-effect; hydration-safe).
function subscribeOnline(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}
function getOnlineSnapshot(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

export default function BoothClient() {
  const { profile, loading: profileLoading, reload } = useVoterProfile();
  const [bundle, setBundle] = useState<PositionsBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(true);
  // Persisted check-off state. Lazy init reads localStorage on the client only
  // (loadChecked is SSR-guarded); the checklist itself does not render until the
  // bundle loads client-side, so there is no hydration mismatch.
  const [checked, setChecked] = useState<Set<string>>(loadChecked);
  const { supported: wakeSupported, active: wakeActive } = useWakeLock(true);
  const importedRef = useRef(false);

  // Connectivity indicator (honest: "your picks are on this device" when offline).
  // useSyncExternalStore keeps this off the effect path and hydration-safe (server
  // snapshot = online).
  const online = useSyncExternalStore(subscribeOnline, getOnlineSnapshot, () => true);

  // Fetch the SW-cached public bundle (race + candidate display data).
  useEffect(() => {
    let cancelled = false;
    fetchPositionsBundle().then((b) => {
      if (cancelled) return;
      setBundle(b);
      setBundleLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cross-device handoff: import the embed's answers from the URL fragment ONCE,
  // only when this device has no answers yet. Then scrub the fragment so opinions
  // never linger in the address bar and a refresh cannot re-import.
  useEffect(() => {
    if (profileLoading || importedRef.current) return;
    importedRef.current = true;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const value = params.get('hs');
    if (!value) return;
    const answers = decodeHandoff(value);
    // Always scrub the fragment (it carries opinions), regardless of outcome.
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!answers) return;
    const hasAnswers = profile && Object.keys(profile.answers).length > 0;
    if (hasAnswers) return; // respect an existing on-device profile
    applyHandoffToProfile(answers)
      .then(() => reload())
      .catch(() => {});
  }, [profileLoading, profile, reload]);

  const hasProfile = useMemo(
    () => !!profile && Object.keys(profile.answers).length > 0 && !!profile.emphasis,
    [profile],
  );

  const rows: BoothRow[] = useMemo(() => {
    if (!bundle) return [];
    const results: MatchResult[] = hasProfile && profile
      ? computeMatchesFromBundle(profile, bundle)
      : [];
    const resultByRace = new Map(results.map((r) => [r.race.id, r]));

    const out = bundle.races.map((race) => {
      const result = resultByRace.get(race.id);
      const explicitId = profile?.picks[race.id]?.candidateId ?? null;

      let candidateId: string | null = null;
      let score: number | null = null;
      if (explicitId) {
        candidateId = explicitId;
        score = result?.candidates.find((c) => c.candidate.id === explicitId)?.score ?? null;
      } else if (result) {
        const top = result.candidates.find((c) => c.score !== null) ?? null;
        candidateId = top?.candidate.id ?? null;
        score = top?.score ?? null;
      }

      const candidateName = candidateId
        ? race.candidates.find((c) => c.id === candidateId)?.name ?? null
        : null;

      return { raceId: race.id, raceName: race.name, level: race.level, candidateName, score };
    });

    return out.sort((a, b) => {
      const la = LEVEL_ORDER.indexOf(a.level);
      const lb = LEVEL_ORDER.indexOf(b.level);
      if (la !== lb) return (la < 0 ? 99 : la) - (lb < 0 ? 99 : lb);
      return a.raceName.localeCompare(b.raceName);
    });
  }, [bundle, profile, hasProfile]);

  const decidedCount = rows.filter((r) => r.candidateName !== null).length;

  function toggle(raceId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(raceId)) next.delete(raceId);
      else next.add(raceId);
      saveChecked(next);
      return next;
    });
  }

  const loading = profileLoading || bundleLoading;

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--civic-surface)',
        color: 'var(--civic-text)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 24px)',
      }}
    >
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px 0' }}>
        {/* Header */}
        <header style={{ marginBottom: 16 }}>
          <p
            className="civic-mono"
            style={{
              fontSize: 12,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--civic-text-muted)',
              fontWeight: 600,
            }}
          >
            Booth mode
          </p>
          <h1
            style={{
              fontFamily: 'var(--font-serif)',
              fontWeight: 700,
              fontSize: 'clamp(28px, 1.6rem + 1.4vw, 40px)',
              lineHeight: 1.1,
              marginTop: 4,
            }}
          >
            Your ballot checklist
          </h1>
          {!loading && rows.length > 0 && (
            <p style={{ marginTop: 8, fontSize: 16, color: 'var(--civic-text-secondary)', lineHeight: 1.4 }}>
              {decidedCount} of {rows.length} races decided. Check each one off as you
              fill in your ballot.
            </p>
          )}
        </header>

        {/* Status line (screen-only) */}
        <div
          className="civic-print-hide"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 16,
            fontSize: 12.5,
            color: 'var(--civic-text-muted)',
          }}
        >
          <StatusPill
            label={online ? 'Online' : 'Offline: saved on this device'}
            tone={online ? 'ok' : 'muted'}
          />
          {wakeSupported && (
            <StatusPill label={wakeActive ? 'Screen staying on' : 'Screen may dim'} tone="muted" />
          )}
        </div>

        {loading && (
          <p style={{ fontSize: 16, color: 'var(--civic-text-muted)' }}>Loading your checklist...</p>
        )}

        {/* No ballot resolved on this device yet (e.g. arrived via QR on a fresh phone). */}
        {!loading && bundle === null && (
          <EmptyState
            title="Load your ballot to finish"
            body={
              hasProfile
                ? 'Your answers are saved on this phone. Enter your home address once to pull up your exact races, then come back here.'
                : 'Enter your home address to see every race on your ballot, then answer a few quick questions.'
            }
            ctaHref="/"
            ctaLabel="Look up my ballot"
          />
        )}

        {/* Ballot resolved but the voter has not built a profile yet. */}
        {!loading && bundle !== null && !hasProfile && (
          <EmptyState
            title="Answer a few questions first"
            body="Your picks come from your own answers, saved only on this device. Take the quick match, then your checklist fills in here."
            ctaHref="/quick-match"
            ctaLabel="Answer a few questions"
          />
        )}

        {/* The checklist. */}
        {!loading && bundle !== null && hasProfile && rows.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.map((row) => (
              <BoothItem
                key={row.raceId}
                row={row}
                checked={checked.has(row.raceId)}
                onToggle={() => toggle(row.raceId)}
              />
            ))}
          </ul>
        )}

        {/* Footer actions (screen-only). */}
        {!loading && (
          <footer className="civic-print-hide" style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Link
              href="/guide"
              className="text-sm font-medium"
              style={{ color: 'var(--civic-primary)', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
            >
              &larr; Back to my ballot
            </Link>
            <div style={{ borderTop: '1px solid var(--civic-border)', paddingTop: 14 }}>
              <button
                type="button"
                onClick={() => window.print()}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--civic-link)',
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                  fontSize: 13,
                  cursor: 'pointer',
                  minHeight: 44,
                }}
              >
                Print a paper copy (accessibility)
              </button>
              <p style={{ fontSize: 12, color: 'var(--civic-text-muted)', marginTop: 4 }}>
                Your checklist lives on this device. Havesay never stores who you chose.
              </p>
            </div>
          </footer>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function BoothItem({
  row,
  checked,
  onToggle,
}: {
  row: BoothRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const decided = row.candidateName !== null;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={checked}
        aria-label={`${row.raceName}: ${decided ? row.candidateName : 'decide at the booth'}. ${checked ? 'Checked off' : 'Tap to check off'}`}
        className="civic-card"
        style={{
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '16px 18px',
          cursor: 'pointer',
          background: checked ? 'var(--civic-surface-muted)' : 'var(--civic-surface)',
          opacity: checked ? 0.72 : 1,
          borderColor: checked ? 'var(--civic-border)' : 'var(--civic-border-strong)',
        }}
      >
        {/* Checkbox */}
        <span
          aria-hidden="true"
          className="booth-checkbox"
          style={{
            flexShrink: 0,
            width: 40,
            height: 40,
            borderRadius: 10,
            border: `2.5px solid ${checked ? 'var(--civic-primary)' : 'var(--civic-border-strong)'}`,
            background: checked ? 'var(--civic-primary)' : 'transparent',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <span
            className="booth-check-glyph civic-print-hide"
            style={{
              color: 'var(--civic-on-primary)',
              fontSize: 24,
              fontWeight: 700,
              lineHeight: 1,
              visibility: checked ? 'visible' : 'hidden',
            }}
          >
            &#10003;
          </span>
        </span>

        {/* Race + pick */}
        <span style={{ minWidth: 0, flex: 1 }}>
          <span
            className="civic-mono"
            style={{
              display: 'block',
              fontSize: 12.5,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--civic-text-muted)',
              fontWeight: 600,
            }}
          >
            {LEVEL_LABEL[row.level]} &middot; {row.raceName}
          </span>
          {decided ? (
            <span
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                flexWrap: 'wrap',
                marginTop: 4,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontWeight: 700,
                  fontSize: 'clamp(22px, 1.1rem + 1.6vw, 30px)',
                  lineHeight: 1.15,
                  color: 'var(--civic-text)',
                  textDecoration: checked ? 'line-through' : 'none',
                }}
              >
                {row.candidateName}
              </span>
              {row.score !== null && (
                <span className="civic-print-hide">
                  <ScoreChip pct={row.score} showTier={false} />
                </span>
              )}
            </span>
          ) : (
            <span
              className="civic-print-unfilled"
              style={{
                display: 'block',
                marginTop: 4,
                fontSize: 18,
                fontStyle: 'italic',
                fontWeight: 600,
                color: 'var(--state-warn-fg)',
              }}
            >
              Decide at the booth
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function StatusPill({ label, tone }: { label: string; tone: 'ok' | 'muted' }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 'var(--r-pill)',
        border: '1px solid var(--civic-border)',
        background: 'var(--civic-surface-muted)',
        color: 'var(--civic-text-muted)',
        fontWeight: 600,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: tone === 'ok' ? 'var(--state-success-fg)' : 'var(--civic-border-strong)',
        }}
      />
      {label}
    </span>
  );
}

function EmptyState({
  title,
  body,
  ctaHref,
  ctaLabel,
}: {
  title: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
}) {
  return (
    <div className="civic-card" style={{ textAlign: 'center', padding: '28px 20px' }}>
      <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 700, color: 'var(--civic-text)' }}>
        {title}
      </h2>
      <p style={{ marginTop: 10, fontSize: 15, lineHeight: 1.5, color: 'var(--civic-text-secondary)' }}>{body}</p>
      <Link href={ctaHref} className="civic-btn civic-btn-primary civic-btn-lg mt-5 inline-flex">
        {ctaLabel}
      </Link>
    </div>
  );
}
