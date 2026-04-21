import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Settings = {
  notification_webhook_url: string;
  notification_webhook_secret: string;
  notification_on_release_success: boolean;
  notification_on_release_fail: boolean;
  notification_on_fix_loop_exhausted: boolean;
  notification_on_review_do_not_ship: boolean;
  notification_on_agent_run_fail: boolean;
};

function defaultSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    notification_webhook_url: '',
    notification_webhook_secret: '',
    notification_on_release_success: false,
    notification_on_release_fail: false,
    notification_on_fix_loop_exhausted: false,
    notification_on_review_do_not_ship: false,
    notification_on_agent_run_fail: false,
    ...overrides,
  };
}

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/xxx';
const DISCORD_URL = 'https://discord.com/api/webhooks/123/abc';
const GENERIC_URL = 'https://ntfy.sh/my-topic';

describe('lib/notifications', () => {
  let mockGetSettings: ReturnType<typeof vi.fn>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockGetSettings = vi.fn().mockReturnValue(defaultSettings());
    vi.doMock('@/lib/config', () => ({ getSettings: mockGetSettings }));
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Helper to flush the microtask / promise queue so fire-and-forget calls land
  async function flush() {
    await new Promise<void>((r) => setTimeout(r, 10));
  }

  describe('notify()', () => {
    it('is a no-op when event is disabled', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_release_success: false }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('is a no-op when webhook URL is blank even if event enabled', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: '', notification_on_release_success: true }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('calls fetch when event is enabled and URL is set', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_release_success: true }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'release_success', project: 'myapp', job_id: 'job-1', status: 'success', timestamp: Date.now() });
      await flush();
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(GENERIC_URL);
    });

    it('posts raw JSON payload to generic webhooks', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_release_fail: true }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'release_fail', project: 'p', job_id: 'j', status: 'failed', timestamp: 1000 });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.event).toBe('release_fail');
      expect(body.project).toBe('p');
      expect(body.status).toBe('failed');
    });

    it('posts Slack block-kit format for hooks.slack.com URLs', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: SLACK_URL, notification_on_release_success: true }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body).toHaveProperty('blocks');
      expect(Array.isArray(body.blocks)).toBe(true);
    });

    it('posts Discord embed format for discord.com webhook URLs', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: DISCORD_URL, notification_on_release_fail: true }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'release_fail', project: 'p', job_id: 'j', status: 'failed', timestamp: Date.now() });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body).toHaveProperty('embeds');
      expect(Array.isArray(body.embeds)).toBe(true);
    });

    it('adds X-TamTam-Signature header when secret is configured', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_webhook_secret: 'mysecret',
          notification_on_agent_run_fail: true,
        }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'agent_run_fail', project: 'p', job_id: 'j', status: 'failed', timestamp: Date.now() });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['X-TamTam-Signature']).toBeDefined();
      expect(typeof opts.headers['X-TamTam-Signature']).toBe('string');
      expect(opts.headers['X-TamTam-Signature']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('omits X-TamTam-Signature header when no secret configured', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_review_do_not_ship: true }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'review_do_not_ship', project: 'p', job_id: 'j', status: 'failed', timestamp: Date.now() });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['X-TamTam-Signature']).toBeUndefined();
    });

    it('fills in timestamp automatically if not provided', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_release_success: true }),
      );
      const { notify } = await import('@/lib/notifications');
      const before = Date.now();
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: 0 });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  describe('adapter selection (detectWebhookType)', () => {
    it('uses slack format for hooks.slack.com', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: SLACK_URL, notification_on_release_success: true }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('blocks');
      expect(body).not.toHaveProperty('embeds');
      expect(body).not.toHaveProperty('event');
    });

    it('uses discord format for discord.com/api/webhooks', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: DISCORD_URL, notification_on_release_success: true }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('embeds');
      expect(body).not.toHaveProperty('blocks');
    });

    it('uses raw JSON for generic URLs', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: 'https://ntfy.sh/topic', notification_on_release_success: true }),
      );
      const { notify } = await import('@/lib/notifications');
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('event', 'release_success');
    });
  });

  describe('HMAC signing', () => {
    it('produces consistent signatures for same payload + secret', async () => {
      mockGetSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_webhook_secret: 'testsecret',
          notification_on_release_success: true,
        }),
      );
      const { notify } = await import('@/lib/notifications');
      const payload = { event: 'release_success' as const, project: 'p', job_id: 'j', status: 'success' as const, timestamp: 42 };

      await notify({ ...payload });
      await flush();
      const sig1 = mockFetch.mock.calls[0][1].headers['X-TamTam-Signature'];

      mockFetch.mockClear();
      await notify({ ...payload });
      await flush();
      const sig2 = mockFetch.mock.calls[0][1].headers['X-TamTam-Signature'];

      expect(sig1).toBe(sig2);
    });

    it('produces different signatures for different secrets', async () => {
      const { notify } = await import('@/lib/notifications');
      const payload = { event: 'release_success' as const, project: 'p', job_id: 'j', status: 'success' as const, timestamp: 42 };

      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_webhook_secret: 'secret1', notification_on_release_success: true }),
      );
      await notify({ ...payload });
      await flush();
      const sig1 = mockFetch.mock.calls[0][1].headers['X-TamTam-Signature'];

      mockFetch.mockClear();
      mockGetSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_webhook_secret: 'secret2', notification_on_release_success: true }),
      );
      await notify({ ...payload });
      await flush();
      const sig2 = mockFetch.mock.calls[0][1].headers['X-TamTam-Signature'];

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('retry and backoff (via sendTestNotification)', () => {
    it('returns { ok: true } on first successful fetch', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const { sendTestNotification } = await import('@/lib/notifications');
      const result = await sendTestNotification(GENERIC_URL, '');
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('returns { ok: false } when URL is blank', async () => {
      const { sendTestNotification } = await import('@/lib/notifications');
      const result = await sendTestNotification('', '');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/required/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('retries up to maxRetries (3) times on fetch failure and returns { ok: false }', async () => {
      vi.useFakeTimers();
      mockFetch.mockRejectedValue(new Error('network error'));

      const { sendTestNotification } = await import('@/lib/notifications');
      const promise = sendTestNotification(GENERIC_URL, '');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('retries on HTTP error status and succeeds on retry', async () => {
      vi.useFakeTimers();
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true });

      const { sendTestNotification } = await import('@/lib/notifications');
      const promise = sendTestNotification(GENERIC_URL, '');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('succeeds immediately without retrying on 200', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const { sendTestNotification } = await import('@/lib/notifications');
      const result = await sendTestNotification(GENERIC_URL, '');
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendTestNotification()', () => {
    it('sends a Slack-formatted body to Slack URLs', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const { sendTestNotification } = await import('@/lib/notifications');
      await sendTestNotification(SLACK_URL, '');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('blocks');
    });

    it('sends a Discord embed body to Discord URLs', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const { sendTestNotification } = await import('@/lib/notifications');
      await sendTestNotification(DISCORD_URL, '');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('embeds');
    });

    it('sends signature header when secret is provided', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const { sendTestNotification } = await import('@/lib/notifications');
      await sendTestNotification(GENERIC_URL, 'myverysecretkey');

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-TamTam-Signature']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('omits signature header when no secret provided', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const { sendTestNotification } = await import('@/lib/notifications');
      await sendTestNotification(GENERIC_URL, '');

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-TamTam-Signature']).toBeUndefined();
    });
  });
});
