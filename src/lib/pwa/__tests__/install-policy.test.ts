import { describe, it, expect } from 'vitest';
import { shouldShowByPolicy } from '@/lib/pwa/install-policy';

const NOW = 1_720_000_000_000; // fixed reference time
const DAY = 24 * 60 * 60 * 1000;

describe('InstallPrompt frequency cap (shouldShowByPolicy)', () => {
  it('shows for a fresh device', () => {
    expect(
      shouldShowByPolicy({ dismissCount: 0, lastDismissedAt: null, installed: false }, NOW),
    ).toBe(true);
  });

  it('never shows once installed', () => {
    expect(
      shouldShowByPolicy({ dismissCount: 0, lastDismissedAt: null, installed: true }, NOW),
    ).toBe(false);
  });

  it('snoozes for 7 days after a single dismissal', () => {
    const state = { dismissCount: 1, lastDismissedAt: NOW, installed: false };
    // 3 days later: still snoozed
    expect(shouldShowByPolicy(state, NOW + 3 * DAY)).toBe(false);
    // 8 days later: eligible again
    expect(shouldShowByPolicy(state, NOW + 8 * DAY)).toBe(true);
  });

  it('permanently hides after the max dismissal count', () => {
    const state = { dismissCount: 2, lastDismissedAt: NOW, installed: false };
    // even long after the snooze window, 2 dismissals means done nagging
    expect(shouldShowByPolicy(state, NOW + 365 * DAY)).toBe(false);
  });
});
