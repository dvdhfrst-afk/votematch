'use client';

/**
 * On-device data controls for the privacy page (work-order 1B item 5).
 *
 * Two controls, both wired to the device store via useVoterProfile:
 *   - Download my answers -> exportProfile() -> a JSON file download.
 *   - Delete everything on this device -> eraseProfile() (after confirm).
 *
 * These are the data-portability + right-to-delete controls the on-device
 * architecture promises. They never touch the server (opinions do not live
 * there). No em-dashes or en-dashes.
 */

import { useState } from 'react';
import { useVoterProfile } from '@/lib/device/useVoterProfile';
import { CivicButton } from '@/components/guide/primitives';

export default function DeviceDataControls() {
  const { profile, loading, available, exportProfile, eraseProfile } = useVoterProfile();
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const hasData =
    !!profile &&
    (Object.keys(profile.answers).length > 0 ||
      !!profile.emphasis ||
      Object.keys(profile.picks).length > 0);

  async function handleExport() {
    setBusy(true);
    setStatus(null);
    try {
      const data = await exportProfile();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `havesay-answers-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('Downloaded a copy of your answers.');
    } catch {
      setStatus('Could not export your answers on this device.');
    } finally {
      setBusy(false);
    }
  }

  async function handleErase() {
    setBusy(true);
    setStatus(null);
    try {
      await eraseProfile();
      setStatus('Everything on this device has been erased.');
      setConfirming(false);
    } catch {
      setStatus('Could not erase your data. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  return (
    <div
      style={{
        marginTop: 16,
        padding: '16px 18px',
        borderRadius: 12,
        border: '1px solid var(--civic-border, #e5e7eb)',
        background: 'var(--civic-surface-muted, #f8f9fa)',
      }}
    >
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
        Your answers on this device
      </h3>
      {!available ? (
        <p style={{ fontSize: 14, color: 'var(--civic-text-secondary, #555)' }}>
          This browser does not support on-device storage, so there is nothing
          saved here to export or erase.
        </p>
      ) : !hasData ? (
        <p style={{ fontSize: 14, color: 'var(--civic-text-secondary, #555)' }}>
          You have not saved any answers on this device yet. When you do, they
          stay here and you can download or erase them at any time.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 14, color: 'var(--civic-text-secondary, #555)', lineHeight: 1.5 }}>
            Your quick-match answers, priorities, and ballot picks are stored only
            on this device. Take a copy, or erase them completely.
          </p>
          <div className="mt-4 flex flex-col sm:flex-row gap-2">
            <CivicButton variant="secondary" size="md" onClick={handleExport} disabled={busy}>
              Download my answers
            </CivicButton>
            {!confirming ? (
              <CivicButton
                variant="destructive"
                size="md"
                onClick={() => setConfirming(true)}
                disabled={busy}
              >
                Delete everything on this device
              </CivicButton>
            ) : (
              <span className="flex gap-2">
                <CivicButton variant="destructive" size="md" onClick={handleErase} disabled={busy}>
                  {busy ? 'Erasing...' : 'Yes, erase it all'}
                </CivicButton>
                <CivicButton
                  variant="tertiary"
                  size="md"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  Cancel
                </CivicButton>
              </span>
            )}
          </div>
        </>
      )}
      {status && (
        <p
          role="status"
          aria-live="polite"
          style={{ marginTop: 12, fontSize: 13, color: 'var(--civic-text, #222)' }}
        >
          {status}
        </p>
      )}
    </div>
  );
}
