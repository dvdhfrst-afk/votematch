/**
 * Daily-reminder policy (work-order Phase 2B - PWA notification path).
 *
 * THE HONEST VERSION. True background push (a reminder that fires when the app
 * is CLOSED) requires a push service and a server-stored push subscription,
 * which is a device-linked token we deliberately do NOT build here (see the
 * privacy note in the work-order report and below). What we DO ship is a
 * permission-gated, device-scheduled reminder that fires while the app is open
 * (or was opened at least once that day): the Notification API via the service
 * worker's registration.showNotification, scheduled with a timer, never touching
 * a server.
 *
 * PRIVACY NOTE (why no subscription storage): a Web Push subscription endpoint
 * is a stable, device-linked identifier. Storing one server-side would create
 * exactly the kind of device-to-server link the on-device invariant forbids, and
 * it must NEVER be joinable to opinions. We defer real push until that isolation
 * is designed (store it like the subscriber table: separate, opinion-free,
 * behind its own opt-in). This module keeps everything local, so there is no
 * server identifier at all.
 *
 * All logic here is pure + browser-agnostic so it unit-tests without a SW. No
 * em-dashes or en-dashes per the project formatting rule.
 */

export const DAILY_REMINDER_STORAGE_KEY = 'havesay.daily-reminder.v1';

export interface DailyReminderState {
  /** Voter turned reminders on (implies notification permission granted). */
  enabled: boolean;
  /** Local day key (YYYY-MM-DD) a reminder was last shown, to cap at one/day. */
  lastShownDay: string | null;
  /** Preferred local hour (0-23) to remind. Default 18 (early evening). */
  hour: number;
}

export const EMPTY_REMINDER_STATE: DailyReminderState = {
  enabled: false,
  lastShownDay: null,
  hour: 18,
};

/** Local calendar day key (matches daily-prompt.localDayKey). */
export function localDayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Decide whether to fire a reminder right now. Fires when:
 *   - reminders are enabled,
 *   - we have not already shown one today, and
 *   - the local time is at or past the preferred hour.
 *
 * The "at or past the hour" rule means a voter who opens the app in the evening
 * still gets today's nudge even if the exact scheduled instant passed while the
 * app was closed. Pure: caller supplies `now`.
 */
export function shouldFireReminder(
  state: DailyReminderState,
  now: Date = new Date(),
): boolean {
  if (!state.enabled) return false;
  if (state.lastShownDay === localDayKey(now)) return false;
  return now.getHours() >= state.hour;
}

/**
 * Milliseconds until the next reminder instant (today's preferred hour if still
 * ahead, else tomorrow's). Used to arm an in-app timer so a voter who leaves the
 * tab open crosses the hour boundary and gets the nudge without a reload.
 * Returns null when reminders are disabled.
 */
export function msUntilNextReminder(
  state: DailyReminderState,
  now: Date = new Date(),
): number | null {
  if (!state.enabled) return null;
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    state.hour,
    0,
    0,
    0,
  );
  if (target.getTime() <= now.getTime()) {
    // Preferred hour already passed today.
    if (state.lastShownDay !== localDayKey(now)) {
      // Not shown yet today -> fire ~immediately.
      return 0;
    }
    // Shown already today -> aim for tomorrow.
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}
