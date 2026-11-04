/**
 * Shared PWA route constants (1C).
 *
 * The positions bundle endpoint itself is built by the 1A agent under
 * `src/app/api/positions-bundle/`. 1C only needs its PATH so the service
 * worker's runtime-cache rule and any client precache warm-up can reference
 * it without importing 1A's route handler. Keep this string in sync with the
 * route 1A ships; it is the single integration point between 1C and 1A here.
 */
export const POSITIONS_BUNDLE_PATH = '/api/positions-bundle';

/**
 * The app-shell entry the PWA launches into (matches manifest start_url,
 * minus the query string). Return-visit continuity lands here.
 */
export const APP_SHELL_START = '/guide';

/** Offline fallback document served by the SW when a navigation fails. */
export const OFFLINE_FALLBACK_PATH = '/offline';
