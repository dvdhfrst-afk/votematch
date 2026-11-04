/**
 * Frequency-cap policy for the "Add Havesay to your home screen" prompt.
 *
 * Pure + dependency-free so it can be unit-tested without a browser or React.
 * The state itself is persisted in localStorage by InstallPrompt.tsx (device
 * storage only, never the server, per the on-device invariant).
 */

export const INSTALL_PROMPT_STORAGE_KEY = 'havesay.pwa.install-prompt.v1';
export const INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const INSTALL_MAX_DISMISSALS = 2;

export interface InstallPromptState {
  dismissCount: number;
  lastDismissedAt: number | null;
  installed: boolean;
}

export const EMPTY_INSTALL_STATE: InstallPromptState = {
  dismissCount: 0,
  lastDismissedAt: null,
  installed: false,
};

/**
 * Whether the install prompt may be shown given prior device history.
 *   - hidden forever once installed or dismissed INSTALL_MAX_DISMISSALS times
 *   - snoozed for INSTALL_SNOOZE_MS after a single dismissal
 */
export function shouldShowByPolicy(
  state: InstallPromptState,
  now: number,
): boolean {
  if (state.installed) return false;
  if (state.dismissCount >= INSTALL_MAX_DISMISSALS) return false;
  if (
    state.dismissCount > 0 &&
    state.lastDismissedAt !== null &&
    now - state.lastDismissedAt < INSTALL_SNOOZE_MS
  ) {
    return false;
  }
  return true;
}
