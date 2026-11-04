/**
 * Daily-reminder policy tests (work-order Phase 2B, PWA path).
 *
 * Pure timing logic only - no SW, no Notification API. Covers the fire decision
 * and the next-reminder scheduling math.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldFireReminder,
  msUntilNextReminder,
  localDayKey,
  EMPTY_REMINDER_STATE,
  type DailyReminderState,
} from '@/lib/pwa/daily-reminder';

const HOUR = 60 * 60 * 1000;

function state(over: Partial<DailyReminderState> = {}): DailyReminderState {
  return { ...EMPTY_REMINDER_STATE, ...over };
}

describe('shouldFireReminder', () => {
  it('never fires when disabled', () => {
    const now = new Date('2026-07-04T20:00:00');
    expect(shouldFireReminder(state({ enabled: false, hour: 18 }), now)).toBe(false);
  });

  it('fires when enabled, past the hour, and not yet shown today', () => {
    const now = new Date('2026-07-04T19:00:00');
    expect(
      shouldFireReminder(state({ enabled: true, hour: 18, lastShownDay: null }), now),
    ).toBe(true);
  });

  it('does not fire before the preferred hour', () => {
    const now = new Date('2026-07-04T09:00:00');
    expect(
      shouldFireReminder(state({ enabled: true, hour: 18 }), now),
    ).toBe(false);
  });

  it('does not fire twice on the same day', () => {
    const now = new Date('2026-07-04T20:00:00');
    expect(
      shouldFireReminder(
        state({ enabled: true, hour: 18, lastShownDay: localDayKey(now) }),
        now,
      ),
    ).toBe(false);
  });
});

describe('msUntilNextReminder', () => {
  it('is null when disabled', () => {
    expect(msUntilNextReminder(state({ enabled: false }), new Date())).toBeNull();
  });

  it('counts down to today’s hour when it is still ahead', () => {
    const now = new Date('2026-07-04T16:00:00');
    const ms = msUntilNextReminder(state({ enabled: true, hour: 18 }), now);
    expect(ms).toBe(2 * HOUR);
  });

  it('fires ~immediately when past the hour and not shown today', () => {
    const now = new Date('2026-07-04T19:00:00');
    const ms = msUntilNextReminder(
      state({ enabled: true, hour: 18, lastShownDay: null }),
      now,
    );
    expect(ms).toBe(0);
  });

  it('aims for tomorrow when past the hour and already shown today', () => {
    const now = new Date('2026-07-04T19:00:00');
    const ms = msUntilNextReminder(
      state({ enabled: true, hour: 18, lastShownDay: localDayKey(now) }),
      now,
    );
    // 23 hours to tomorrow 18:00 from today 19:00.
    expect(ms).toBe(23 * HOUR);
  });
});
