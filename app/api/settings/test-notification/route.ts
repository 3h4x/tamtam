import { NextRequest, NextResponse } from 'next/server';
import { sendTestNotification } from '@/lib/shared/notifications';

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const { webhook_url, webhook_secret } =
    (body && typeof body === 'object' ? body : {}) as { webhook_url?: unknown; webhook_secret?: unknown };

  if (typeof webhook_url !== 'string' || webhook_url.trim() === '') {
    return NextResponse.json(
      { ok: false, error: 'Webhook URL is required' },
      { status: 400 },
    );
  }
  const secret = typeof webhook_secret === 'string' ? webhook_secret : '';

  try {
    const result = await sendTestNotification(webhook_url, secret);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[test-notification] error:', error);
    return NextResponse.json(
      { ok: false, error: 'Failed to send test notification' },
      { status: 500 },
    );
  }
}
