import { NextRequest, NextResponse } from 'next/server';
import { unsubscribe } from '@/lib/retention/subscribe';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const result = await unsubscribe(token);

  if (!result.ok) {
    return new NextResponse(pageHtml(false, result.error), {
      status: 400,
      headers: { 'content-type': 'text/html' },
    });
  }
  return new NextResponse(pageHtml(true), {
    headers: { 'content-type': 'text/html' },
  });
}

function pageHtml(success: boolean, error?: string): string {
  const title = success ? 'Unsubscribed' : 'Unsubscribe failed';
  const message = success
    ? "You won't receive any more emails. If you change your mind, you can re-subscribe anytime."
    : `Something went wrong: ${error ?? 'Unknown error'}. If the link is old, paste it into your browser again — unsubscribe links don't expire.`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Havesay</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 64px auto; padding: 24px; color: #1a1a1a; }
    h1 { font-size: 28px; margin-bottom: 16px; }
    p { line-height: 1.6; color: #444; }
    a { color: #1a1a1a; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${message}</p>
  <p><a href="/">← Back to Havesay</a></p>
</body>
</html>`;
}
