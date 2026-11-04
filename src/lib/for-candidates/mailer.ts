/**
 * Email sender for /for-candidates magic links.
 *
 * Mirrors lib/retention/mailer.ts. Dev-mode fallback: if RESEND_API_KEY is
 * unset, log the link and return { sent: false, devLink } so the API route
 * can echo the link back in JSON. This is what makes local development
 * tractable — no Resend account needed for happy-path testing.
 */
import { Resend } from 'resend';

let _resend: Resend | null = null;
function resendClient(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key || key.startsWith('your-') || key === 'placeholder') return null;
  _resend = new Resend(key);
  return _resend;
}

const FROM = process.env.RESEND_FROM ?? 'Havesay <no-reply@example.org>';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:4000';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type SendCandidatePortalLinkResult = {
  sent: boolean;
  link: string;
  // When sent=false (mailer not configured), this is the same as `link` and
  // the API route may surface it in the response body for dev convenience.
  devLink?: string;
};

export async function sendCandidatePortalLink(opts: {
  to: string;
  token: string;
  candidateName: string | null;
  // Optional context to make the email feel less generic.
  office?: string | null;
}): Promise<SendCandidatePortalLinkResult> {
  const link = `${APP_URL}/for-candidates/profile/${opts.token}`;
  const client = resendClient();

  if (!client) {
    console.warn(
      `[for-candidates mailer] RESEND_API_KEY not configured — magic link for ${opts.to.replace(
        /(.{2}).*(@.*)/,
        '$1***$2',
      )} : ${link}`,
    );
    return { sent: false, link, devLink: link };
  }

  const greeting = opts.candidateName
    ? `Hi ${escapeHtml(opts.candidateName)},`
    : 'Hi,';
  const context = opts.office
    ? `<p>We have you down as a candidate for <strong>${escapeHtml(opts.office)}</strong>.</p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Your Havesay candidate link</title></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #fafafa; color: #1a1a1a; line-height: 1.5;">
    <div style="background: #fff; padding: 32px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
      <p style="font-weight: 600; font-size: 18px; margin-bottom: 16px;">Havesay</p>
      <h1 style="font-size: 22px; margin-bottom: 16px;">${greeting}</h1>
      <p>You can claim your candidate profile on Havesay and tell voters where you stand on 19 issues — directly, in your own words.</p>
      ${context}
      <p style="margin: 24px 0;">
        <a href="${link}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">Open my profile</a>
      </p>
      <p style="color: #666; font-size: 13px;">This link is valid for 7 days. It's tied to your email — don't forward it.</p>
      <p style="color: #666; font-size: 13px;">If you didn't request this, ignore the email; nothing changes on your profile until you affirm it.</p>
    </div>
    <div style="font-size: 12px; color: #666; margin-top: 24px; text-align: center;">
      Havesay · Nonpartisan voter information
    </div>
  </body>
</html>`;

  const result = await client.emails.send({
    from: FROM,
    to: opts.to,
    subject: 'Claim your Havesay candidate profile',
    html,
  });
  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }
  return { sent: true, link };
}
