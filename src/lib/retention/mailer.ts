/**
 * Resend email sender for retention-engine messages.
 *
 * All templates go through a common layout with unsubscribe footer (CAN-SPAM).
 * sendId is the digest_sends.id that ties back to a send-log row — used as the
 * Resend idempotency key and for webhook correlation.
 */
import { Resend } from 'resend';
import { createToken } from './tokens';

let _resend: Resend | null = null;
function resendClient(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key || key.startsWith('your-') || key === 'placeholder') return null;
  _resend = new Resend(key);
  return _resend;
}

export function isMailerConfigured(): boolean {
  return resendClient() !== null;
}

const FROM = process.env.RESEND_FROM ?? 'Havesay <no-reply@example.org>';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://ballotbridge.org';

function layout(bodyHtml: string, subscriberId: string, title: string): string {
  const unsubscribeToken = createToken('unsubscribe', subscriberId);
  const unsubscribeUrl = `${APP_URL}/api/retention/unsubscribe/${unsubscribeToken}`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #fafafa; color: #1a1a1a; line-height: 1.5;">
    <div style="background: #fff; padding: 32px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
      <div style="margin-bottom: 24px;">
        <a href="${APP_URL}" style="text-decoration: none; color: #1a1a1a; font-weight: 600; font-size: 18px;">Havesay</a>
      </div>
      ${bodyHtml}
    </div>
    <div style="font-size: 12px; color: #666; margin-top: 24px; text-align: center;">
      <p>You're receiving this because you subscribed to Havesay civic updates.</p>
      <p><a href="${unsubscribeUrl}" style="color: #666;">Unsubscribe instantly</a> · <a href="${APP_URL}/subscriber/preferences" style="color: #666;">Update preferences</a></p>
      <p style="margin-top: 12px;">Havesay · Nonpartisan voter information · <a href="${APP_URL}/corrections" style="color: #666;">Corrections</a></p>
    </div>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  bodyHtml: string;
  subscriberId: string;
}): Promise<{ id: string }> {
  const html = layout(opts.bodyHtml, opts.subscriberId, opts.subject);
  const client = resendClient();
  if (!client) {
    // Mailer not configured — log and return a synthetic ID so the caller
    // can still record the digest_send. Subscribers won't get email until
    // RESEND_API_KEY is set, but the rest of the pipeline keeps moving.
    console.warn(
      `[mailer] RESEND_API_KEY not configured — skipping send to ${opts.to.replace(/(.{2}).*(@.*)/, '$1***$2')}`,
    );
    return { id: 'mailer-not-configured' };
  }
  const result = await client.emails.send({
    from: FROM,
    to: opts.to,
    subject: opts.subject,
    html,
  });
  if (result.error) throw new Error(`Resend error: ${result.error.message}`);
  return { id: result.data?.id ?? 'unknown' };
}

// Verification email (double opt-in)
export async function sendVerificationEmail(opts: {
  to: string;
  subscriberId: string;
}): Promise<{ id: string }> {
  const verifyToken = createToken('verify', opts.subscriberId);
  const verifyUrl = `${APP_URL}/api/retention/verify/${verifyToken}`;
  const body = `
    <h1 style="font-size: 24px; margin-bottom: 16px;">One more step</h1>
    <p>Thanks for signing up for Havesay civic updates. Confirm your email to activate your subscription — you'll get a monthly digest with federal votes, public-comment windows, and election reminders for your state.</p>
    <p style="margin: 24px 0;">
      <a href="${verifyUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">Confirm subscription</a>
    </p>
    <p style="color: #666; font-size: 14px;">If you didn't sign up, ignore this email — we won't send anything else.</p>
  `;
  return sendEmail({
    to: opts.to,
    subject: 'Confirm your Havesay subscription',
    bodyHtml: body,
    subscriberId: opts.subscriberId,
  });
}
