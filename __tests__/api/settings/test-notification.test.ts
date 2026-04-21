import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/settings/test-notification', () => {
  let POST: (req: NextRequest) => Promise<Response>;
  let mockSendTestNotification: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockSendTestNotification = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('@/lib/notifications', () => ({
      sendTestNotification: mockSendTestNotification,
    }));

    const mod = await import('@/app/api/settings/test-notification/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 400 when webhook_url is missing', async () => {
    const req = new NextRequest('http://localhost/api/settings/test-notification', {
      method: 'POST',
      body: JSON.stringify({ webhook_secret: 'secret' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/required/i);
    expect(mockSendTestNotification).not.toHaveBeenCalled();
  });

  it('calls sendTestNotification with url and secret', async () => {
    const req = new NextRequest('http://localhost/api/settings/test-notification', {
      method: 'POST',
      body: JSON.stringify({ webhook_url: 'https://hooks.slack.com/x', webhook_secret: 'secret123' }),
    });
    await POST(req);
    expect(mockSendTestNotification).toHaveBeenCalledWith('https://hooks.slack.com/x', 'secret123');
  });

  it('calls sendTestNotification with empty string when secret is omitted', async () => {
    const req = new NextRequest('http://localhost/api/settings/test-notification', {
      method: 'POST',
      body: JSON.stringify({ webhook_url: 'https://ntfy.sh/topic' }),
    });
    await POST(req);
    expect(mockSendTestNotification).toHaveBeenCalledWith('https://ntfy.sh/topic', '');
  });

  it('returns { ok: true } on success', async () => {
    mockSendTestNotification.mockResolvedValue({ ok: true });
    const req = new NextRequest('http://localhost/api/settings/test-notification', {
      method: 'POST',
      body: JSON.stringify({ webhook_url: 'https://example.com/hook' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('forwards { ok: false, error } on delivery failure', async () => {
    mockSendTestNotification.mockResolvedValue({ ok: false, error: 'Webhook request failed' });
    const req = new NextRequest('http://localhost/api/settings/test-notification', {
      method: 'POST',
      body: JSON.stringify({ webhook_url: 'https://example.com/hook' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('Webhook request failed');
  });

  it('returns 500 when sendTestNotification throws', async () => {
    mockSendTestNotification.mockRejectedValue(new Error('unexpected crash'));
    const req = new NextRequest('http://localhost/api/settings/test-notification', {
      method: 'POST',
      body: JSON.stringify({ webhook_url: 'https://example.com/hook' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });
});
