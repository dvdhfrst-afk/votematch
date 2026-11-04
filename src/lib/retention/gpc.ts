/**
 * Global Privacy Control (GPC) handler.
 *
 * Required by 12 US states as of 2026-01-01 (CA, CO, CT, MT, NE, NH, NJ, MN, MD, DE, OR, TX)
 * per coordinated CPPA/CO AG/CT AG sweep launched 2025-09. GPC is sent as the
 * `Sec-GPC: 1` HTTP header, per https://globalprivacycontrol.org/.
 *
 * Our obligations when GPC is detected:
 *   - Treat as opt-out of sale/share (CCPA/CPRA)
 *   - Treat as opt-out of targeted advertising
 *   - Surface "Opt-out preference honored" to the user (Jan 2026 CCPA reg amendment)
 *
 * Current Havesay stack has no ad tech and does not sell/share — so GPC is
 * effectively no-op today. This module exists so that if/when we add anything
 * that WOULD trigger "share," the handler is already wired.
 */
import type { NextRequest } from 'next/server';

/**
 * Read GPC signal from an incoming request. Returns true if the user has
 * expressed an opt-out preference.
 */
export function hasGpcOptOut(request: Request | NextRequest): boolean {
  const header = request.headers.get('sec-gpc');
  return header === '1';
}

/**
 * Set a cookie indicating we honored the GPC signal on this request.
 * The cookie is read client-side to show "Opt-out preference honored" indicator.
 */
export function gpcHonoredCookie(): string {
  return 'bb_gpc_honored=1; Path=/; Max-Age=3600; SameSite=Lax';
}
