import { NextRequest, NextResponse } from 'next/server';
import { sendTestNotification } from '@/lib/shared/notifications';

export async function POST(request: NextRequest) {
  try {
    const { webhook_url, webhook_secret } = await request.json();

    if (!webhook_url) {
      return NextResponse.json(
        { ok: false, error: 'Webhook URL is required' },
        { status: 400 }
      );
    }

    const result = await sendTestNotification(webhook_url, webhook_secret || '');
    return NextResponse.json(result);
  } catch (error) {
    console.error('[test-notification] error:', error);
    return NextResponse.json(
      { ok: false, error: 'Failed to send test notification' },
      { status: 500 }
    );
  }
}
