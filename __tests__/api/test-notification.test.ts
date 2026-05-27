import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/settings/test-notification', () => {
  let POST: typeof import('@/app/api/settings/test-notification/route').POST;
  let sendTestNotificationMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    sendTestNotificationMock = vi.fn().mockResolvedValue({ ok: true });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.doMock('@/lib/shared/notifications', () => ({
      sendTestNotification: sendTestNotificationMock,
    }));

    const mod = await import('@/app/api/settings/test-notification/route');
    POST = mod.POST;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.resetModules();
  });

  function requestWithBody(body: string): NextRequest {
    return new NextRequest('http://localhost/api/settings/test-notification', {
      method: 'POST',
      body,
    });
  }

  it('sends a test notification with the provided URL and secret', async () => {
    sendTestNotificationMock.mockResolvedValue({
      ok: true,
      status: 204,
      attempts: 1,
    });

    const res = await POST(requestWithBody(JSON.stringify({
      webhook_url: 'https://example.com/hook',
      webhook_secret: 'secret',
    })));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, status: 204, attempts: 1 });
    expect(sendTestNotificationMock).toHaveBeenCalledWith('https://example.com/hook', 'secret');
  });

  it('rejects invalid JSON and missing webhook URLs without sending', async () => {
    const invalidJson = await POST(requestWithBody('{'));
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ ok: false, error: 'Invalid JSON body' });

    const missingUrl = await POST(requestWithBody(JSON.stringify({ webhook_url: '   ' })));
    expect(missingUrl.status).toBe(400);
    expect(await missingUrl.json()).toEqual({ ok: false, error: 'Webhook URL is required' });
    expect(sendTestNotificationMock).not.toHaveBeenCalled();
  });

  it('uses an empty secret for non-string secrets and returns 500 when sending throws', async () => {
    const nonStringSecret = await POST(requestWithBody(JSON.stringify({
      webhook_url: 'https://example.com/hook',
      webhook_secret: 123,
    })));
    expect(nonStringSecret.status).toBe(200);
    expect(sendTestNotificationMock).toHaveBeenLastCalledWith('https://example.com/hook', '');

    sendTestNotificationMock.mockRejectedValueOnce(new Error('network down'));
    const failed = await POST(requestWithBody(JSON.stringify({
      webhook_url: 'https://example.com/hook',
    })));

    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ ok: false, error: 'Failed to send test notification' });
    expect(consoleErrorSpy).toHaveBeenCalledWith('[test-notification] error:', expect.any(Error));
  });
});
