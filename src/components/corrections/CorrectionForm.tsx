'use client';

import { useState } from 'react';
import Link from 'next/link';

interface Props {
  candidateId: string;
  candidateName: string;
  positions: { id: string; label: string }[];
}

export default function CorrectionForm({ candidateId, candidateName, positions }: Props) {
  const [positionId, setPositionId] = useState(positions[0]?.id ?? '');
  const [submittedBy, setSubmittedBy] = useState('');
  const [evidence, setEvidence] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!positionId) {
      setError('Pick which position is wrong.');
      return;
    }
    if (!submittedBy.trim()) {
      setError('Please tell us who you are (a name or email).');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidate_id: candidateId,
          position_id: positionId,
          submitted_by: submittedBy.trim(),
          evidence: evidence.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Submission failed (status ${res.status}).`);
        setSubmitting(false);
        return;
      }
      setSuccess(true);
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="rounded-md bg-emerald-50 border border-emerald-200 p-6">
        <h2 className="text-lg font-semibold text-emerald-900 mb-2">Thanks — we got it.</h2>
        <p className="text-sm text-emerald-900 mb-4">
          Your correction about {candidateName} is logged. You can see it (and its resolution)
          at{' '}
          <Link href="/corrections" className="underline">
            /corrections
          </Link>
          .
        </p>
        <Link
          href={`/candidate/${candidateId}`}
          className="text-sm underline text-emerald-900 hover:text-emerald-700"
        >
          ← Back to {candidateName}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] p-6">
      <div>
        <label htmlFor="position" className="block text-sm font-medium mb-1">
          Which position looks wrong?
        </label>
        <select
          id="position"
          value={positionId}
          onChange={(e) => setPositionId(e.target.value)}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
        >
          {positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="submitted_by" className="block text-sm font-medium mb-1">
          Your name or email <span className="text-red-600">*</span>
        </label>
        <input
          id="submitted_by"
          type="text"
          value={submittedBy}
          onChange={(e) => setSubmittedBy(e.target.value)}
          placeholder="Jane Voter, jane@example.com"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          required
        />
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          We may follow up for clarification. Required so we can credit the correction if it
          leads to a change.
        </p>
      </div>

      <div>
        <label htmlFor="evidence" className="block text-sm font-medium mb-1">
          Evidence (optional but strongly encouraged)
        </label>
        <textarea
          id="evidence"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          rows={5}
          placeholder="Paste a link, quote a statement, cite a vote. The more concrete, the faster we can verify."
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm font-mono"
        />
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-900">
          {error}
        </div>
      )}

      <div className="flex gap-3 items-center">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-[var(--color-primary)] text-white px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Submitting...' : 'Submit correction'}
        </button>
        <Link
          href={`/candidate/${candidateId}`}
          className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-primary)] underline"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
