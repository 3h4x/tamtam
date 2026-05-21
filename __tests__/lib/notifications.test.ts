import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

type Settings = {
  notification_webhook_url: string;
  notification_webhook_secret: string;
  notification_on_release_success: boolean;
  notification_on_release_fail: boolean;
  notification_on_fix_loop_exhausted: boolean;
  notification_on_review_do_not_ship: boolean;
  notification_on_agent_run_fail: boolean;
  notification_on_release_aborted: boolean;
  notification_on_budget_blocked: boolean;
  notification_throttle_window_seconds: number;
  notification_throttle_overrides: Record<string, number>;
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
    notification_on_release_aborted: false,
    notification_on_budget_blocked: false,
    notification_throttle_window_seconds: 900,
    notification_throttle_overrides: { release_fail: 0, release_aborted: 0 },
    ...overrides,
  };
}

async function applyThrottleSchema(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`CREATE TABLE notification_throttle (
    key text PRIMARY KEY,
    last_sent_at bigint NOT NULL,
    suppressed_count integer NOT NULL DEFAULT 0
  )`));
}

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/xxx';
const DISCORD_URL = 'https://discord.com/api/webhooks/123/abc';
const GENERIC_URL = 'https://ntfy.sh/my-topic';

// Hoisted shared mock state — mocks register at module load, but tests can mutate
// the underlying refs (db handle, settings return) per test without re-importing.
const mocks = vi.hoisted(() => {
  const dbRef: { current: unknown } = { current: null };
  const getSettings = vi.fn();
  return { dbRef, getSettings };
});

vi.mock('@/lib/shared/config', () => ({
  get getSettings() {
    return mocks.getSettings;
  },
}));

vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.dbRef.current;
  },
  schema,
}));

// Import the subject ONCE at module scope — the mocked `db` is resolved lazily
// via the getter above, so it works even though `handle` is created in beforeAll.
import { notify, sendTestNotification } from '@/lib/shared/notifications';

describe('lib/notifications', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let handle: TestDbHandle;

  async function getThrottleRow(key: string): Promise<{ key: string; lastSentAt: number; suppressedCount: number } | undefined> {
    const rows = await handle.db.select().from(schema.notificationThrottle).where(eq(schema.notificationThrottle.key, key));
    return rows[0];
  }

  async function getAllThrottleRows(): Promise<Array<{ key: string }>> {
    const rows = await handle.db.select().from(schema.notificationThrottle);
    return [...rows].sort((a, b) => a.key.localeCompare(b.key));
  }

  beforeAll(async () => {
    handle = await createTestPgDbEmpty();
    await applyThrottleSchema(handle);
    mocks.dbRef.current = handle.db;
  });

  afterAll(async () => {
    try {
      await handle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await handle.db.execute(sql.raw('TRUNCATE notification_throttle'));
    mocks.getSettings.mockReset();
    mocks.getSettings.mockReturnValue(defaultSettings());
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(async () => {
    // Always restore real timers — tests that opt into vi.useFakeTimers() can
    // throw before their explicit restore call, which would leak fake timers
    // into the next test and hang any setTimeout-based await.
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Helper to flush the microtask / promise queue so fire-and-forget calls land.
  // PGlite queries cross a WASM bridge and need a real timer tick to settle;
  // tests that use vi.useFakeTimers() must call vi.useRealTimers() (and tick
  // any pending fake timers via runAllTimersAsync) before awaiting flush().
  async function flush() {
    // Most code paths (mock fetch resolves synchronously, formatting is sync)
    // settle via microtasks; the `setImmediate` tick covers PGlite's WASM
    // bridge for tests that need to observe the throttle row right after.
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
    }
  }

  describe('notify()', () => {
    it('is a no-op when event is disabled', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_release_success: false }),
      );
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('is a no-op when webhook URL is blank even if event enabled', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: '', notification_on_release_success: true }),
      );
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('calls fetch when event is enabled and URL is set', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_release_success: true }),
      );
      await notify({ event: 'release_success', project: 'myapp', job_id: 'job-1', status: 'success', timestamp: Date.now() });
      await flush();
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(GENERIC_URL);
    });

    it('posts raw JSON payload to generic webhooks', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_release_fail: true }),
      );
      await notify({ event: 'release_fail', project: 'p', job_id: 'j', status: 'failed', timestamp: 1000 });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.event).toBe('release_fail');
      expect(body.project).toBe('p');
      expect(body.status).toBe('failed');
    });

    it('posts Slack block-kit format for hooks.slack.com URLs', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: SLACK_URL, notification_on_release_success: true }),
      );
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body).toHaveProperty('blocks');
      expect(Array.isArray(body.blocks)).toBe(true);
    });

    it('posts Discord embed format for discord.com webhook URLs', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: DISCORD_URL, notification_on_release_fail: true }),
      );
      await notify({ event: 'release_fail', project: 'p', job_id: 'j', status: 'failed', timestamp: Date.now() });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body).toHaveProperty('embeds');
      expect(Array.isArray(body.embeds)).toBe(true);
    });

    it('adds X-TamTam-Signature header when secret is configured', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_webhook_secret: 'mysecret',
          notification_on_agent_run_fail: true,
        }),
      );
      await notify({ event: 'agent_run_fail', project: 'p', job_id: 'j', status: 'failed', timestamp: Date.now() });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['X-TamTam-Signature']).toBeDefined();
      expect(typeof opts.headers['X-TamTam-Signature']).toBe('string');
      expect(opts.headers['X-TamTam-Signature']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('omits X-TamTam-Signature header when no secret configured', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_review_do_not_ship: true }),
      );
      await notify({ event: 'review_do_not_ship', project: 'p', job_id: 'j', status: 'failed', timestamp: Date.now() });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['X-TamTam-Signature']).toBeUndefined();
    });

    it('fills in timestamp automatically if not provided', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: GENERIC_URL, notification_on_release_success: true }),
      );
      const before = Date.now();
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: 0 });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.timestamp).toBeGreaterThanOrEqual(before);
    });

    it('suppresses duplicate agent failures with the same key inside the throttle window', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_on_agent_run_fail: true,
          notification_throttle_window_seconds: 900,
        }),
      );

      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j1', status: 'failed', timestamp: 1000 });
      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j2', status: 'failed', timestamp: 2000 });
      await flush();

      expect(mockFetch).toHaveBeenCalledOnce();
      await vi.waitFor(async () => {
        const row = await getThrottleRow('agent_run_fail:p:qa');
        expect(row?.suppressedCount).toBe(1);
      }, { interval: 1, timeout: 1000 });
    });

    it('always sends release_fail when the default override disables throttling', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_on_release_fail: true,
        }),
      );

      await notify({ event: 'release_fail', project: 'p', job_id: 'j1', status: 'failed', timestamp: 1000 });
      await notify({ event: 'release_fail', project: 'p', job_id: 'j2', status: 'failed', timestamp: 2000 });
      await flush();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not leak throttleKeySuffix in generic webhook payloads', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_on_budget_blocked: true,
        }),
      );

      await notify({
        event: 'budget_blocked',
        project: 'tamtam',
        job_id: '-',
        status: 'failed',
        message: 'quota blocked',
        throttleKeySuffix: 'budget:5h:2099-01-01T00:00:00Z',
        timestamp: 1000,
      });
      await flush();

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.throttleKeySuffix).toBeUndefined();
      expect(body.event).toBe('budget_blocked');
    });

    it('sends budget-blocked alerts for different throttle identities inside the same window', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_on_budget_blocked: true,
        }),
      );

      await notify({
        event: 'budget_blocked',
        project: 'tamtam',
        job_id: '-',
        status: 'failed',
        message: 'first window',
        throttleKeySuffix: 'budget:5h:2099-01-01T00:00:00Z',
        timestamp: 1000,
      });
      await notify({
        event: 'budget_blocked',
        project: 'tamtam',
        job_id: '-',
        status: 'failed',
        message: 'second window',
        throttleKeySuffix: 'budget:5h:2099-01-01T01:00:00Z',
        timestamp: 2000,
      });
      await flush();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.waitFor(async () => {
        const rows = await getAllThrottleRows();
        expect(rows.map((row) => row.key)).toEqual([
          'budget_blocked:tamtam:budget:5h:2099-01-01T00:00:00Z',
          'budget_blocked:tamtam:budget:5h:2099-01-01T01:00:00Z',
        ]);
      }, { interval: 1, timeout: 1000 });
    });

    it('still suppresses budget-blocked repeats for the same throttle identity', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_on_budget_blocked: true,
        }),
      );

      await notify({
        event: 'budget_blocked',
        project: 'tamtam',
        job_id: '-',
        status: 'failed',
        message: 'same window',
        throttleKeySuffix: 'budget:5h:2099-01-01T00:00:00Z',
        timestamp: 1000,
      });
      await notify({
        event: 'budget_blocked',
        project: 'tamtam',
        job_id: '-',
        status: 'failed',
        message: 'same window retry',
        throttleKeySuffix: 'budget:5h:2099-01-01T00:00:00Z',
        timestamp: 2000,
      });
      await flush();

      expect(mockFetch).toHaveBeenCalledOnce();
      await vi.waitFor(async () => {
        const row = await getThrottleRow('budget_blocked:tamtam:budget:5h:2099-01-01T00:00:00Z');
        expect(row?.suppressedCount).toBe(1);
      }, { interval: 1, timeout: 1000 });
    });

    it('includes suppressedSince when sending after the throttle window expires', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_on_agent_run_fail: true,
          notification_throttle_window_seconds: 10,
        }),
      );

      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j1', status: 'failed', timestamp: 1000 });
      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j2', status: 'failed', timestamp: 2000 });
      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j3', status: 'failed', timestamp: 12_000 });
      await flush();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [, opts] = mockFetch.mock.calls[1];
      const body = JSON.parse(opts.body);
      expect(body.suppressedSince).toBe(1);
      expect(body.message).toContain('1 more notification suppressed since the last alert.');
    });

    it('does not create a throttle row when the first throttled delivery fails', async () => {
      vi.useFakeTimers();
      mockFetch.mockRejectedValue(new Error('network down'));
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_on_release_success: true,
        }),
      );

      await notify({ event: 'release_success', project: 'p', job_id: 'j1', status: 'success', timestamp: 1000 });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await flush();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const row = await getThrottleRow('release_success:p:release');
      expect(row).toBeUndefined();
    });

    it('keeps the last delivered throttle state when a resend after the window fails', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_on_agent_run_fail: true,
          notification_throttle_window_seconds: 10,
        }),
      );

      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j1', status: 'failed', timestamp: 1000 });
      await flush();

      mockFetch.mockResolvedValue({ ok: true });
      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j2', status: 'failed', timestamp: 2000 });
      await flush();

      mockFetch.mockReset();
      mockFetch.mockRejectedValue(new Error('network down'));
      // Only fake timers around the retry loop — keeps flush() (real setTimeout)
      // working before and after.
      vi.useFakeTimers();
      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j3', status: 'failed', timestamp: 12_000 });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await flush();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      await vi.waitFor(async () => {
        const row = await getThrottleRow('agent_run_fail:p:qa');
        expect(row).toMatchObject({ key: 'agent_run_fail:p:qa', lastSentAt: 1000, suppressedCount: 1 });
      }, { interval: 1, timeout: 1000 });
    });

    it('retries with the accumulated suppressed count after a failed resend eventually succeeds', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_on_agent_run_fail: true,
          notification_throttle_window_seconds: 10,
        }),
      );

      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j1', status: 'failed', timestamp: 1000 });
      await flush();

      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j2', status: 'failed', timestamp: 2000 });
      await flush();

      mockFetch.mockReset();
      mockFetch.mockRejectedValue(new Error('network down'));
      vi.useFakeTimers();
      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j3', status: 'failed', timestamp: 12_000 });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await flush();

      mockFetch.mockReset();
      mockFetch.mockResolvedValue({ ok: true });
      await notify({ event: 'agent_run_fail', project: 'p', agent: 'qa', job_id: 'j4', status: 'failed', timestamp: 13_000 });
      await flush();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.suppressedSince).toBe(1);
      await vi.waitFor(async () => {
        const row = await getThrottleRow('agent_run_fail:p:qa');
        expect(row).toMatchObject({ key: 'agent_run_fail:p:qa', lastSentAt: 13_000, suppressedCount: 0 });
      }, { interval: 1, timeout: 1000 });
    });
  });

  describe('adapter selection (detectWebhookType)', () => {
    it('uses slack format for hooks.slack.com', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: SLACK_URL, notification_on_release_success: true }),
      );
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('blocks');
      expect(body).not.toHaveProperty('embeds');
      expect(body).not.toHaveProperty('event');
    });

    it('uses discord format for discord.com/api/webhooks', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: DISCORD_URL, notification_on_release_success: true }),
      );
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('embeds');
      expect(body).not.toHaveProperty('blocks');
    });

    it('uses raw JSON for generic URLs', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: 'https://ntfy.sh/topic', notification_on_release_success: true }),
      );
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: Date.now() });
      await flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('event', 'release_success');
    });
  });

  describe('HMAC signing', () => {
    it('produces consistent signatures for same payload + secret', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_webhook_secret: 'testsecret',
          notification_on_release_success: true,
          notification_throttle_overrides: { release_success: 0, release_fail: 0, release_aborted: 0 },
        }),
      );
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
      const payload = { event: 'release_success' as const, project: 'p', job_id: 'j', status: 'success' as const, timestamp: 42 };

      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_webhook_secret: 'secret1',
          notification_on_release_success: true,
          notification_throttle_overrides: { release_success: 0, release_fail: 0, release_aborted: 0 },
        }),
      );
      await notify({ ...payload });
      await flush();
      const sig1 = mockFetch.mock.calls[0][1].headers['X-TamTam-Signature'];

      mockFetch.mockClear();
      mocks.getSettings.mockReturnValue(
        defaultSettings({
          notification_webhook_url: GENERIC_URL,
          notification_webhook_secret: 'secret2',
          notification_on_release_success: true,
          notification_throttle_overrides: { release_success: 0, release_fail: 0, release_aborted: 0 },
        }),
      );
      await notify({ ...payload });
      await flush();
      const sig2 = mockFetch.mock.calls[0][1].headers['X-TamTam-Signature'];

      expect(sig1).not.toBe(sig2);
    });
  });

  // Test-button semantics: sendTestNotification is the "did I configure this
  // correctly?" entry point, not the real notification path. It deliberately
  // uses a single attempt with a short timeout so the UI doesn't hang for
  // ~30s on failures (3 retries × 10s = the old behavior). The retry+backoff
  // logic in `postWebhook` still applies to the production `notify()` path.
  describe('sendTestNotification — single-attempt semantics', () => {
    it('returns { ok: true } on first successful fetch', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const result = await sendTestNotification(GENERIC_URL, '');
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('returns { ok: false } when URL is blank', async () => {
      const result = await sendTestNotification('', '');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/required/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does NOT retry on fetch failure (single attempt for fast UI feedback)', async () => {
      mockFetch.mockRejectedValue(new Error('network error'));
      const result = await sendTestNotification(GENERIC_URL, '');
      expect(result.ok).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on HTTP error status (single attempt for fast UI feedback)', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
      const result = await sendTestNotification(GENERIC_URL, '');
      expect(result.ok).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces the underlying error message to the caller', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
      const result = await sendTestNotification(GENERIC_URL, '');
      expect(result.ok).toBe(false);
      // Error should include the HTTP status — operators need this to debug
      // misconfigured webhook URLs (e.g. wrong secret rejected as 401).
      expect(result.error).toContain('401');
    });

    it('surfaces network-error message to the caller', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:9999'));
      const result = await sendTestNotification(GENERIC_URL, '');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });
  });

  describe('sendTestNotification()', () => {
    it('sends a Slack-formatted body to Slack URLs', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      await sendTestNotification(SLACK_URL, '');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('blocks');
    });

    it('sends a Discord embed body to Discord URLs', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      await sendTestNotification(DISCORD_URL, '');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('embeds');
    });

    it('sends signature header when secret is provided', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      await sendTestNotification(GENERIC_URL, 'myverysecretkey');

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-TamTam-Signature']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('omits signature header when no secret provided', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      await sendTestNotification(GENERIC_URL, '');

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-TamTam-Signature']).toBeUndefined();
    });
  });

  describe('formatSlackMessage() shape', () => {
    async function slackBody(payload: Partial<Parameters<typeof notify>[0]> = {}) {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: SLACK_URL, notification_on_release_success: true, notification_on_release_fail: true }),
      );
      await notify({
        event: 'release_success',
        project: 'myapp',
        job_id: 'j1',
        status: 'success',
        timestamp: 1_000_000,
        ...payload,
      });
      await flush();
      return JSON.parse(mockFetch.mock.calls[0][1].body);
    }

    it('uses ✅ emoji for success status', async () => {
      const body = await slackBody({ status: 'success' });
      const headerText = body.blocks[0].text.text as string;
      expect(headerText).toMatch(/✅/);
    });

    it('uses ❌ emoji for failed status', async () => {
      const body = await slackBody({ status: 'failed', event: 'release_fail' });
      const headerText = body.blocks[0].text.text as string;
      expect(headerText).toMatch(/❌/);
    });

    it('replaces underscores with spaces in event name', async () => {
      const body = await slackBody();
      const headerText = body.blocks[0].text.text as string;
      expect(headerText).toContain('release success');
      expect(headerText).not.toContain('release_success');
    });

    it('always includes Event, Project, Status fields', async () => {
      const body = await slackBody();
      const fields: Array<{ text: string }> = body.blocks[1].fields;
      const texts = fields.map((f) => f.text);
      expect(texts.some((t) => t.includes('release_success'))).toBe(true);
      expect(texts.some((t) => t.includes('myapp'))).toBe(true);
      expect(texts.some((t) => t.includes('success'))).toBe(true);
    });

    it('omits verdict field when not provided', async () => {
      const body = await slackBody({ verdict: undefined });
      const fields: Array<{ text: string }> = body.blocks[1].fields;
      expect(fields.every((f) => !f.text.includes('Verdict'))).toBe(true);
    });

    it('includes verdict field when provided', async () => {
      const body = await slackBody({ verdict: 'LGTM' });
      const fields: Array<{ text: string }> = body.blocks[1].fields;
      expect(fields.some((f) => f.text.includes('Verdict') && f.text.includes('LGTM'))).toBe(true);
    });

    it('omits agent field when not provided', async () => {
      const body = await slackBody({ agent: undefined });
      const fields: Array<{ text: string }> = body.blocks[1].fields;
      expect(fields.every((f) => !f.text.includes('Agent'))).toBe(true);
    });

    it('includes agent field when provided', async () => {
      const body = await slackBody({ agent: 'my-agent' });
      const fields: Array<{ text: string }> = body.blocks[1].fields;
      expect(fields.some((f) => f.text.includes('Agent') && f.text.includes('my-agent'))).toBe(true);
    });

    it('omits cost field when cost_usd is not provided', async () => {
      const body = await slackBody({ cost_usd: undefined });
      const fields: Array<{ text: string }> = body.blocks[1].fields;
      expect(fields.every((f) => !f.text.includes('Cost'))).toBe(true);
    });

    it('formats cost_usd to 4 decimal places', async () => {
      const body = await slackBody({ cost_usd: 0.1 });
      const fields: Array<{ text: string }> = body.blocks[1].fields;
      expect(fields.some((f) => f.text.includes('$0.1000'))).toBe(true);
    });

    it('omits message block when message is not provided', async () => {
      const body = await slackBody({ message: undefined });
      const hasMessageBlock = body.blocks.some(
        (b: { type: string; text?: { text: string } }) => b.type === 'section' && b.text?.text?.startsWith('_'),
      );
      expect(hasMessageBlock).toBe(false);
    });

    it('adds italic message block when message is provided', async () => {
      const body = await slackBody({ message: 'deploy ok' });
      const msgBlock = body.blocks.find(
        (b: { type: string; text?: { text: string } }) => b.type === 'section' && b.text?.text?.includes('deploy ok'),
      );
      expect(msgBlock).toBeDefined();
      expect(msgBlock.text.text).toBe('_deploy ok_');
    });

    it('omits actions block when log_url is not provided', async () => {
      const body = await slackBody({ log_url: undefined });
      expect(body.blocks.every((b: { type: string }) => b.type !== 'actions')).toBe(true);
    });

    it('adds View Log button when log_url is provided', async () => {
      const body = await slackBody({ log_url: 'https://example.com/log/123' });
      const actionsBlock = body.blocks.find((b: { type: string }) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock.elements[0].url).toBe('https://example.com/log/123');
    });
  });

  describe('formatDiscordMessage() shape', () => {
    async function discordBody(payload: Partial<Parameters<typeof notify>[0]> = {}) {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: DISCORD_URL, notification_on_release_success: true, notification_on_release_fail: true }),
      );
      await notify({
        event: 'release_success',
        project: 'myapp',
        job_id: 'j1',
        status: 'success',
        timestamp: 1_000_000,
        ...payload,
      });
      await flush();
      return JSON.parse(mockFetch.mock.calls[0][1].body).embeds[0];
    }

    it('uses green color (3066993) for success', async () => {
      const embed = await discordBody({ status: 'success' });
      expect(embed.color).toBe(3_066_993);
    });

    it('uses red color (15158332) for failed', async () => {
      const embed = await discordBody({ status: 'failed', event: 'release_fail' });
      expect(embed.color).toBe(15_158_332);
    });

    it('replaces underscores with spaces in embed title', async () => {
      const embed = await discordBody();
      expect(embed.title).toContain('release success');
      expect(embed.title).not.toContain('release_success');
    });

    it('always includes Status field', async () => {
      const embed = await discordBody();
      expect(embed.fields.some((f: { name: string }) => f.name === 'Status')).toBe(true);
    });

    it('omits Verdict field when not provided', async () => {
      const embed = await discordBody({ verdict: undefined });
      expect(embed.fields.every((f: { name: string }) => f.name !== 'Verdict')).toBe(true);
    });

    it('includes Verdict field when provided', async () => {
      const embed = await discordBody({ verdict: 'NEEDS ATTENTION' });
      const f = embed.fields.find((f: { name: string }) => f.name === 'Verdict');
      expect(f?.value).toBe('NEEDS ATTENTION');
    });

    it('formats cost_usd to 4 decimal places', async () => {
      const embed = await discordBody({ cost_usd: 0.05 });
      const f = embed.fields.find((f: { name: string }) => f.name === 'Cost');
      expect(f?.value).toBe('$0.0500');
    });

    it('sets embed url when log_url is provided', async () => {
      const embed = await discordBody({ log_url: 'https://example.com/log/456' });
      expect(embed.url).toBe('https://example.com/log/456');
    });

    it('omits embed url when log_url is not provided', async () => {
      const embed = await discordBody({ log_url: undefined });
      expect(embed.url).toBeUndefined();
    });

    it('produces a valid ISO timestamp', async () => {
      const embed = await discordBody({ timestamp: 1_700_000_000_000 });
      expect(() => new Date(embed.timestamp)).not.toThrow();
      expect(embed.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
    });
  });

  describe('detectWebhookType() edge cases', () => {
    it('returns generic for an empty string URL', async () => {
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: 'https://ntfy.sh/t', notification_on_release_success: true }),
      );
      // Verify generic path (raw payload) is used for a plain URL — already covered,
      // but also verify an empty-string URL never reaches fetch (config guard)
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: '', notification_on_release_success: true }),
      );
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: 1 });
      await flush();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('slack takes precedence when URL contains both slack and discord substrings', async () => {
      // Constructed edge-case URL that contains both patterns
      const ambiguousUrl = 'https://hooks.slack.com/services/discord.com/api/webhooks/123';
      mocks.getSettings.mockReturnValue(
        defaultSettings({ notification_webhook_url: ambiguousUrl, notification_on_release_success: true }),
      );
      await notify({ event: 'release_success', project: 'p', job_id: 'j', status: 'success', timestamp: 1 });
      await flush();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('blocks');
      expect(body).not.toHaveProperty('embeds');
    });
  });
});
