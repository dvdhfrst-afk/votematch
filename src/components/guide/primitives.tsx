/**
 * Havesay civic primitives.
 *
 * Display-only (server-safe) building blocks that consume design tokens from
 * globals.css. Source of truth:
 *   .design-bundles/ballot-bridge/project/design-system/{tokens.json, ds-ui.jsx}
 *
 * Every primitive here:
 *   · uses only CSS custom properties (no hard-coded hex)
 *   · pairs color with shape + text (accessibility + print + nation-theme safe)
 *   · meets 44×44 tap-target minimum at its smallest variant
 *
 * Interactive behaviors (tooltips, bottom sheets, scope recalc) live in
 * dedicated client components — NOT here.
 */

import Link from 'next/link';
import type { ReactNode, CSSProperties } from 'react';
import type { Confidence, CoverageTier as CoverageTierT } from '@/lib/guide/contract';

// ═══════════════════════════════════════════════════════════════════════════
// Button
// ═══════════════════════════════════════════════════════════════════════════

type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';
type ButtonSize = 'sm' | 'md' | 'lg';

interface CivicButtonBase {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  style?: CSSProperties;
  fullWidth?: boolean;
}

interface CivicButtonProps extends CivicButtonBase {
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  onClick?: () => void;
}

interface ButtonClassOpts {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}

function buttonClasses({ variant = 'primary', size = 'md', fullWidth, className = '' }: ButtonClassOpts): string {
  const parts = ['civic-btn', `civic-btn-${variant}`];
  if (size === 'sm') parts.push('civic-btn-sm');
  if (size === 'lg') parts.push('civic-btn-lg');
  if (fullWidth) parts.push('w-full');
  if (className) parts.push(className);
  return parts.join(' ');
}

export function CivicButton({
  children,
  variant = 'primary',
  size = 'md',
  className,
  style,
  fullWidth,
  type = 'button',
  disabled,
  onClick,
}: CivicButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={style}
      className={buttonClasses({ variant, size, fullWidth, className })}
    >
      {children}
    </button>
  );
}

interface CivicLinkButtonProps extends CivicButtonBase {
  href: string;
  prefetch?: boolean;
  ariaLabel?: string;
}

export function CivicLinkButton({
  href,
  children,
  variant = 'primary',
  size = 'md',
  className,
  style,
  fullWidth,
  prefetch,
  ariaLabel,
}: CivicLinkButtonProps) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      aria-label={ariaLabel}
      style={style}
      className={buttonClasses({ variant, size, fullWidth, className })}
    >
      {children}
    </Link>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Score chip & score bar
// ═══════════════════════════════════════════════════════════════════════════

type ScoreTier = 'high' | 'mid' | 'low';

function tierFromPct(pct: number): ScoreTier {
  if (pct >= 75) return 'high';
  if (pct >= 50) return 'mid';
  return 'low';
}

const TIER_LABEL: Record<ScoreTier, string> = {
  high: 'strong match',
  mid: 'partial match',
  low: 'weak match',
};

interface ScoreChipProps {
  pct: number;
  showTier?: boolean;
  tier?: ScoreTier;
}

export function ScoreChip({ pct, showTier = true, tier }: ScoreChipProps) {
  const t = tier ?? tierFromPct(pct);
  return (
    <span
      className="civic-tabular"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 'var(--r-pill)',
        background: `var(--score-${t}-bg)`,
        color: `var(--score-${t}-fg)`,
        border: `1px solid var(--score-${t}-bd)`,
        fontSize: 13,
        fontWeight: 700,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {Math.round(pct)}%
      {showTier && (
        <>
          <span
            aria-hidden="true"
            style={{ width: 1, height: 12, background: 'currentColor', opacity: 0.25 }}
          />
          <span style={{ fontSize: 11, fontWeight: 500 }}>{TIER_LABEL[t]}</span>
        </>
      )}
    </span>
  );
}

interface ScoreBarProps {
  pct: number;
  tier?: ScoreTier;
  label?: string;
}

export function ScoreBar({ pct, tier, label = 'Match' }: ScoreBarProps) {
  const t = tier ?? tierFromPct(pct);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span
          className="civic-mono"
          style={{
            fontSize: 12,
            color: 'var(--civic-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {label}
        </span>
        <span
          className="civic-serif civic-tabular"
          style={{ fontSize: 28, fontWeight: 700, color: 'var(--civic-text)', lineHeight: 1 }}
        >
          {Math.round(pct)}%
        </span>
      </div>
      <div
        style={{
          height: 10,
          background: 'var(--civic-surface-sunken)',
          borderRadius: 'var(--r-pill)',
          overflow: 'hidden',
          border: '1px solid var(--civic-border)',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: `${Math.max(2, Math.min(100, pct))}%`,
            height: '100%',
            background: `var(--score-${t}-bar)`,
            borderRadius: 'var(--r-pill)',
            transition: 'width var(--t-slow) var(--ease-standard)',
          }}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Spectrum bar — voter = circle, candidate = diamond (shape disambiguation)
// ═══════════════════════════════════════════════════════════════════════════

interface SpectrumBarProps {
  low: string;
  high: string;
  /** 0–1 (not 0–100) */
  voterScore: number | null;
  /** 0–1 (not 0–100) */
  candidateScore: number | null;
  candidateName?: string;
  disabled?: boolean;
}

export function SpectrumBar({
  low,
  high,
  voterScore,
  candidateScore,
  candidateName = 'Candidate',
  disabled = false,
}: SpectrumBarProps) {
  const voterPct = voterScore !== null ? Math.round(voterScore * 100) : null;
  const candPct = candidateScore !== null ? Math.round(candidateScore * 100) : null;

  return (
    <div style={{ opacity: disabled ? 0.5 : 1 }}>
      <div style={{ position: 'relative', height: 30 }}>
        {/* Rail */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            height: 4,
            transform: 'translateY(-50%)',
            background: 'var(--civic-surface-sunken)',
            borderRadius: 'var(--r-pill)',
            border: '1px solid var(--civic-border)',
          }}
        />
        {/* Voter pin — CIRCLE, primary outline */}
        {voterPct !== null && (
          <div
            aria-label={`Your position: ${voterPct}%`}
            role="img"
            style={{
              position: 'absolute',
              left: `${voterPct}%`,
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: 'var(--civic-surface)',
              border: '2.5px solid var(--civic-primary)',
              boxShadow: 'var(--shadow-card)',
              zIndex: 2,
            }}
          />
        )}
        {/* Candidate pin — DIAMOND (ink fill, rotated square) */}
        {candPct !== null && (
          <div
            aria-label={`${candidateName} position: ${candPct}%`}
            role="img"
            style={{
              position: 'absolute',
              left: `${candPct}%`,
              top: '50%',
              transform: 'translate(-50%, -50%) rotate(45deg)',
              width: 14,
              height: 14,
              background: 'var(--civic-text)',
              border: '2px solid var(--civic-surface)',
              boxShadow: 'var(--shadow-card)',
              zIndex: 1,
            }}
          />
        )}
      </div>
      <div
        className="civic-mono"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          color: 'var(--civic-text-muted)',
          marginTop: 4,
          gap: 8,
        }}
      >
        <span style={{ maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{low}</span>
        <span
          style={{
            maxWidth: '45%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textAlign: 'right',
          }}
        >
          {high}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 16,
          marginTop: 6,
          fontSize: 11,
          color: 'var(--civic-text-muted)',
          flexWrap: 'wrap',
        }}
      >
        {voterPct !== null && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: 'var(--civic-surface)',
                border: '2px solid var(--civic-primary)',
              }}
            />
            You
          </span>
        )}
        {candPct !== null && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                background: 'var(--civic-text)',
                transform: 'rotate(45deg)',
              }}
            />
            {candidateName}
          </span>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Caveat — inline disclosure, state-colored. NEVER uses --civic-accent (flag red)
// ═══════════════════════════════════════════════════════════════════════════

type CaveatKind = 'info' | 'warn' | 'error' | 'success';

const CAVEAT_GLYPH: Record<CaveatKind, string> = {
  info: 'ℹ',
  warn: '⚠',
  error: '✕',
  success: '✓',
};

export function Caveat({
  kind = 'warn',
  children,
}: {
  kind?: CaveatKind;
  children: ReactNode;
}) {
  return (
    <div
      role="note"
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '10px 14px',
        borderRadius: 'var(--r-md)',
        background: `var(--state-${kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'}-bg)`,
        color: `var(--state-${kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'}-fg)`,
        border: `1px solid var(--state-${kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'}-bd)`,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1, marginTop: 2 }}>
        {CAVEAT_GLYPH[kind]}
      </span>
      <div>{children}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Confidence badge — uses state-color family; VISUALLY DISTINCT from score chip
// ═══════════════════════════════════════════════════════════════════════════

const CONF_DISPLAY: Record<
  Exclude<Confidence, 'no_data'>,
  { bg: string; fg: string; dot: string; label: string }
> = {
  high: {
    bg: 'var(--conf-high-bg)',
    fg: 'var(--conf-high-fg)',
    dot: 'var(--conf-high-dot)',
    label: 'High confidence',
  },
  medium: {
    bg: 'var(--conf-med-bg)',
    fg: 'var(--conf-med-fg)',
    dot: 'var(--conf-med-dot)',
    label: 'Medium confidence',
  },
  low: {
    bg: 'var(--conf-low-bg)',
    fg: 'var(--conf-low-fg)',
    dot: 'var(--conf-low-dot)',
    label: 'Low confidence',
  },
};

export function ConfidenceBadge({ level }: { level: Confidence }) {
  if (level === 'no_data') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 10px',
          borderRadius: 'var(--r-pill)',
          background: 'var(--civic-surface-muted)',
          color: 'var(--civic-text-muted)',
          fontSize: 12,
          fontWeight: 600,
          border: '1px solid var(--civic-border)',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--civic-border-strong)',
          }}
        />
        No data
      </span>
    );
  }
  const s = CONF_DISPLAY[level];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 'var(--r-pill)',
        background: s.bg,
        color: s.fg,
        fontSize: 12,
        fontWeight: 600,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: `color-mix(in srgb, ${s.fg} 40%, transparent)`,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: s.dot }}
      />
      {s.label}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Coverage tier — A / B / C. "Under-covered" framing, never "failing"
// ═══════════════════════════════════════════════════════════════════════════

const TIER_DISPLAY: Record<CoverageTierT, { bg: string; fg: string; label: string }> = {
  A: { bg: 'var(--tier-a-bg)', fg: 'var(--tier-a-fg)', label: 'Tier A · well-documented' },
  B: { bg: 'var(--tier-b-bg)', fg: 'var(--tier-b-fg)', label: 'Tier B · partial record' },
  C: { bg: 'var(--tier-c-bg)', fg: 'var(--tier-c-fg)', label: 'Tier C · limited data' },
};

export function CoverageTier({ tier }: { tier: CoverageTierT }) {
  const s = TIER_DISPLAY[tier];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 'var(--r-pill)',
        background: s.bg,
        color: s.fg,
        fontSize: 12,
        fontWeight: 600,
        border: '1px solid var(--civic-border)',
      }}
    >
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: s.fg }} />
      {s.label}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MatchChip — F2 verdict pill. Triple signal: LABEL + GLYPH + FILL.
// Any one of the three alone reads correctly — grayscale-safe, print-safe,
// nation-theme-safe. Delta is 0–1 (IssueDiff.delta).
// ═══════════════════════════════════════════════════════════════════════════

export type MatchVerdict =
  | 'strong-agree'
  | 'agree'
  | 'partial'
  | 'disagree'
  | 'strong-disagree'
  | 'unknown';

const MATCH_SPEC: Record<
  MatchVerdict,
  { label: string; glyph: string; fill: number; weight: number }
> = {
  'strong-agree':    { label: 'Strong agree',    glyph: '✓✓', fill: 1.0,  weight: 700 },
  'agree':           { label: 'Agree',           glyph: '✓',  fill: 0.8,  weight: 700 },
  'partial':         { label: 'Partial match',   glyph: '~',  fill: 0.5,  weight: 500 },
  'disagree':        { label: 'Disagree',        glyph: '✕',  fill: 0.25, weight: 500 },
  'strong-disagree': { label: 'Strong disagree', glyph: '✕✕', fill: 0.05, weight: 500 },
  'unknown':         { label: 'No data',         glyph: '?',  fill: 0.0,  weight: 400 },
};

export function verdictFromDelta(delta: number | null): MatchVerdict {
  if (delta === null) return 'unknown';
  if (delta <= 0.1) return 'strong-agree';
  if (delta <= 0.25) return 'agree';
  if (delta <= 0.45) return 'partial';
  if (delta <= 0.7) return 'disagree';
  return 'strong-disagree';
}

interface MatchChipProps {
  verdict: MatchVerdict;
  small?: boolean;
  /** When true, renders a subtle ⓘ hint. Pair with a client wrapper for the F3 sentence tooltip. */
  interactive?: boolean;
}

export function MatchChip({ verdict, small = false, interactive = false }: MatchChipProps) {
  const m = MATCH_SPEC[verdict];
  const fillPct = m.fill * 100;
  const textOnFill = m.fill > 0.5;

  return (
    <span
      role={interactive ? 'button' : 'img'}
      aria-label={`Match: ${m.label}${interactive ? ' — tap for explanation' : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: small ? '2px 8px 2px 6px' : '4px 10px 4px 8px',
        border: '1.5px solid var(--score-high-bar)',
        borderRadius: 'var(--r-pill)',
        fontSize: small ? 11 : 12,
        fontFamily: 'var(--font-sans)',
        fontWeight: m.weight,
        background: `linear-gradient(90deg, var(--score-high-bar) 0%, var(--score-high-bar) ${fillPct}%, var(--civic-surface) ${fillPct}%, var(--civic-surface) 100%)`,
        color: textOnFill ? 'var(--civic-on-primary)' : 'var(--civic-text)',
        cursor: interactive ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}
    >
      <span
        aria-hidden="true"
        className="civic-mono"
        style={{
          display: 'inline-grid',
          placeItems: 'center',
          width: small ? 14 : 16,
          height: small ? 14 : 16,
          borderRadius: 3,
          background: textOnFill ? 'rgba(255,255,255,0.18)' : 'var(--civic-surface-muted)',
          border: '1px solid currentColor',
          fontSize: small ? 9 : 10,
          fontWeight: 700,
          letterSpacing: -1,
          lineHeight: 1,
        }}
      >
        {m.glyph}
      </span>
      {m.label}
      {interactive && (
        <span aria-hidden="true" style={{ fontSize: 9, opacity: 0.7, marginLeft: 2 }}>
          ⓘ
        </span>
      )}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Candidate avatar — initials fallback, consistent treatment across surfaces
// ═══════════════════════════════════════════════════════════════════════════

export function CandidateAvatar({
  name,
  photoUrl,
  size = 48,
}: {
  name: string;
  photoUrl: string | null;
  size?: number;
}) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  if (photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoUrl}
        alt={name}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          border: '1px solid var(--civic-border)',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--civic-primary-soft)',
        color: 'var(--civic-primary)',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--font-serif)',
        fontWeight: 700,
        fontSize: size * 0.4,
        flexShrink: 0,
        border: '1px solid var(--civic-border)',
      }}
    >
      {initials}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Section heading pair (eyebrow + serif heading)
// ═══════════════════════════════════════════════════════════════════════════

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div
      className="civic-mono"
      style={{
        fontSize: 11,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--civic-text-muted)',
        fontWeight: 500,
      }}
    >
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ScopeChip — persistent "N issues selected" chip (D9 / drilldown-frames).
// READ-ONLY for the pilot: shows the count with a static "change" affordance.
// Live recalc + the scope BottomSheet are WAVE-2C; this display half is safe to
// ship now. When interactivity lands, wrap this in a client component that owns
// the sheet — do not add onClick here (keeps the primitive server-safe).
// Frame ref: drilldown-frames.jsx ScopeChip (lines 15-27).
// ═══════════════════════════════════════════════════════════════════════════

interface ScopeChipProps {
  /** Number of issues currently counted toward the score. */
  count: number;
  /** Optional href for the "change" affordance (defaults to a non-link span). */
  changeHref?: string;
}

export function ScopeChip({ count, changeHref }: ScopeChipProps) {
  const label = `${count} issue${count === 1 ? '' : 's'}`;
  const changeEl = changeHref ? (
    <Link
      href={changeHref}
      style={{ color: 'var(--civic-link)', textDecoration: 'underline', textUnderlineOffset: 2 }}
    >
      change
    </Link>
  ) : (
    <span style={{ textDecoration: 'underline', textUnderlineOffset: 2, opacity: 0.85 }}>change</span>
  );

  return (
    <span
      role="status"
      aria-label={`Scoring on ${label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 32,
        padding: '6px 12px',
        borderRadius: 'var(--r-pill)',
        background: 'var(--civic-surface)',
        border: '1px solid var(--civic-border-strong)',
        fontSize: 12,
        fontFamily: 'var(--font-sans)',
        color: 'var(--civic-text)',
        whiteSpace: 'nowrap',
      }}
    >
      {/* Checkbox-like glyph — signals "selection", not a candidate/party color */}
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          border: '1.5px solid var(--civic-border-strong)',
          display: 'inline-grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        <span style={{ width: 6, height: 6, background: 'var(--civic-primary)', borderRadius: 1 }} />
      </span>
      <span>
        <b style={{ fontWeight: 700 }}>{label}</b>
        <span aria-hidden="true" style={{ margin: '0 6px', color: 'var(--civic-text-muted)' }}>
          ·
        </span>
        {changeEl}
      </span>
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FreshnessChip — inferred-position TTL signal (Round-2 freshness decay).
// fresh (<=6mo) · aging (6-18mo, confidence drops a tier) · stale (>18mo).
// Triple signal (glyph + word + state color) so it reads grayscale/print.
// Uses the state-color family (NOT score tints, NOT the flag-red accent).
// Frame ref: round2-3-frames.jsx FreshnessChip (lines 8-25).
// ═══════════════════════════════════════════════════════════════════════════

export type FreshnessState = 'fresh' | 'aging' | 'stale';

const FRESH_SPEC: Record<
  FreshnessState,
  { word: string; glyph: string; fg: string; bg: string; bd: string }
> = {
  fresh: {
    word: 'fresh',
    glyph: '●',
    fg: 'var(--civic-text-secondary)',
    bg: 'var(--civic-surface-muted)',
    bd: 'var(--civic-border-strong)',
  },
  aging: {
    word: 'aging',
    glyph: '◐',
    fg: 'var(--state-warn-fg)',
    bg: 'var(--state-warn-bg)',
    bd: 'var(--state-warn-bd)',
  },
  stale: {
    word: 'stale',
    glyph: '○',
    fg: 'var(--state-warn-fg)',
    bg: 'var(--state-warn-bg)',
    bd: 'var(--state-warn-bd)',
  },
};

/**
 * Derive the freshness state from the age (in months) of the most recent
 * supporting signal. Pure — unit-tested in guide/__tests__/primitives-logic.
 *   <=6mo  → fresh
 *   6-18mo → aging (confidence should drop a tier upstream)
 *   >18mo  → stale (needs refresh)
 */
export function freshnessFromMonths(months: number): FreshnessState {
  if (months <= 6) return 'fresh';
  if (months <= 18) return 'aging';
  return 'stale';
}

interface FreshnessChipProps {
  /** Age in months of the most recent supporting signal. */
  months: number;
  /** Override the derived state (rarely needed). */
  state?: FreshnessState;
  small?: boolean;
}

export function FreshnessChip({ months, state, small = false }: FreshnessChipProps) {
  const s = state ?? freshnessFromMonths(months);
  const spec = FRESH_SPEC[s];
  return (
    <span
      role="img"
      aria-label={`Source freshness: ${spec.word}, ${months} months old`}
      className="civic-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: small ? '1px 7px' : '2px 8px',
        borderRadius: 'var(--r-pill)',
        background: spec.bg,
        color: spec.fg,
        border: `1px solid ${spec.bd}`,
        fontSize: small ? 10 : 11,
        fontWeight: 700,
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true">{spec.glyph}</span>
      {spec.word} · {months}mo
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BetaChip — "Beta · AI" pill. Per design decision, EVERY AI-touched surface
// carries this so voters know the classifier output is in testing. Uses the
// info/warn state family, never the flag-red accent.
// Frame ref: new-features.jsx BetaChip (lines 9-13).
// ═══════════════════════════════════════════════════════════════════════════

export function BetaChip({ small = false }: { small?: boolean }) {
  return (
    <span
      role="img"
      aria-label="Beta feature, AI-assisted, still in testing"
      className="civic-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: small ? '1px 6px' : '2px 8px',
        borderRadius: 'var(--r-pill)',
        background: 'var(--state-warn-bg)',
        color: 'var(--state-warn-fg)',
        border: '1px solid var(--state-warn-bd)',
        fontSize: small ? 9 : 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true">◐</span>
      Beta · AI
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Skeleton loaders — match the SHAPE of the loaded content so there is no
// layout jump when data arrives (round1-frames SkelLine/SkelBlock/SkelCircle).
// Production styling uses the civic shimmer (.civic-skeleton in globals.css),
// NOT the wireframe hatch. Honors prefers-reduced-motion (handled in CSS).
// ═══════════════════════════════════════════════════════════════════════════

export function SkelLine({
  width = '100%',
  height = 12,
  className = '',
}: {
  width?: number | string;
  height?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`civic-skeleton ${className}`.trim()}
      style={{ display: 'block', width, height, borderRadius: 'var(--r-sm)' }}
    />
  );
}

export function SkelBlock({
  height = 40,
  className = '',
}: {
  height?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`civic-skeleton ${className}`.trim()}
      style={{ display: 'block', width: '100%', height, borderRadius: 'var(--r-md)' }}
    />
  );
}

export function SkelCircle({ size = 42, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`civic-skeleton ${className}`.trim()}
      style={{ display: 'block', width: size, height: size, borderRadius: '50%', flexShrink: 0 }}
    />
  );
}
