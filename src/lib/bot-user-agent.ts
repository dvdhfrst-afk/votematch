/**
 * The single, honest User-Agent every outbound Havesay request sends. It names
 * the client and links to a page describing it, so site operators can
 * recognize, rate-limit or block it. No code path impersonates a browser.
 */
export const POLITE_USER_AGENT = 'HavesayBot/0.1 (+https://example.org/havesay-bot)';
