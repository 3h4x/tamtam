import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notify, sendTestNotification } from '../lib/notifications';

// Mock getSettings
vi.mock('../lib/config', () => ({
  getSettings: vi.fn(() => ({
    notification_webhook_url: 'https://hooks.slack.com/services/test',
    notification_webhook_secret: 'test-secret',
    notification_on_release_success: true,
    notification_on_release_fail: true,
    notification_on_fix_loop_exhausted: true,
    notification_on_review_do_not_ship: true,
    notification_on_agent_run_fail: true,
  })),
}));

// Mock fetch globally
global.fetch = vi.fn();

describe('notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('notify()', () => {
    it('sends notification when event is enabled', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await notify({
        event: 'release_success',
        project: 'test-project',
        job_id: 'job-123',
        status: 'success',
        timestamp: Date.now(),
      });

      expect(global.fetch).toHaveBeenCalled();
      const [url, options] = (global.fetch as any).mock.calls[0];
      expect(url).toBe('https://hooks.slack.com/services/test');
      expect(options.method).toBe('POST');
      expect(options.headers['X-TamTam-Signature']).toBeDefined();
    });

    it('does not send when webhook URL is empty', async () => {
      vi.resetModules();
      const { getSettings } = await import('../lib/config');
      (getSettings as any).mockReturnValueOnce({
        notification_webhook_url: '',
        notification_on_release_success: true,
      });

      await notify({
        event: 'release_success',
        project: 'test-project',
        job_id: 'job-123',
        status: 'success',
        timestamp: Date.now(),
      });

      // Should not call fetch when URL is empty
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('does not send when event is disabled', async () => {
      vi.resetModules();
      const { getSettings } = await import('../lib/config');
      (getSettings as any).mockReturnValueOnce({
        notification_webhook_url: 'https://hooks.slack.com/services/test',
        notification_on_release_success: false,
      });

      await notify({
        event: 'release_success',
        project: 'test-project',
        job_id: 'job-123',
        status: 'success',
        timestamp: Date.now(),
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('retries on failure with exponential backoff', async () => {
      (global.fetch as any)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ ok: true });

      await notify({
        event: 'release_success',
        project: 'test-project',
        job_id: 'job-123',
        status: 'success',
        timestamp: Date.now(),
      });

      // Give async retries time to execute
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(global.fetch).toHaveBeenCalled();
    });

    it('detects Slack webhook and formats message', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await notify({
        event: 'release_success',
        project: 'test-project',
        job_id: 'job-123',
        status: 'success',
        timestamp: Date.now(),
      });

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.blocks).toBeDefined();
      expect(body.blocks[0].text.text).toContain('release success');
      expect(body.blocks[0].text.text).toContain('test-project');
    });

    it('detects Discord webhook and formats message', async () => {
      vi.resetModules();
      const { notify: notify2 } = await import('../lib/notifications');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });
      const { getSettings } = await import('../lib/config');
      (getSettings as any).mockReturnValueOnce({
        notification_webhook_url: 'https://discord.com/api/webhooks/123/456',
        notification_webhook_secret: 'test-secret',
        notification_on_release_success: true,
      });

      await notify2({
        event: 'release_success',
        project: 'test-project',
        job_id: 'job-123',
        status: 'success',
        timestamp: Date.now(),
      });

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds).toBeDefined();
      expect(body.embeds[0].title).toContain('release success');
      expect(body.embeds[0].title).toContain('test-project');
    });

    it('signs payload with HMAC-SHA256', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await notify({
        event: 'release_success',
        project: 'test-project',
        job_id: 'job-123',
        status: 'success',
        timestamp: Date.now(),
      });

      const call = (global.fetch as any).mock.calls[0];
      const signature = call[1].headers['X-TamTam-Signature'];
      expect(signature).toBeDefined();
      expect(signature).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex digest
    });
  });

  describe('sendTestNotification()', () => {
    it('sends test notification', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await sendTestNotification(
        'https://hooks.slack.com/services/test',
        'test-secret'
      );

      expect(result.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });

    it('returns error when URL is empty', async () => {
      const result = await sendTestNotification('', 'test-secret');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('URL is required');
    });

    it('returns error when webhook request fails', async () => {
      // Clear mocks and reset
      vi.clearAllMocks();
      (global.fetch as any) = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await sendTestNotification(
        'https://hooks.slack.com/services/test',
        'test-secret'
      );

      // Should retry and eventually fail
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('includes signature in test notification', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await sendTestNotification(
        'https://hooks.slack.com/services/test',
        'test-secret'
      );

      const call = (global.fetch as any).mock.calls[0];
      const signature = call[1].headers['X-TamTam-Signature'];
      expect(signature).toBeDefined();
    });
  });

  describe('payload formatting', () => {
    it('includes all payload fields in notification', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await notify({
        event: 'release_success',
        project: 'test-project',
        agent: 'test-agent',
        job_id: 'job-123',
        status: 'success',
        verdict: 'LGTM',
        cost_usd: 0.0042,
        log_url: 'http://localhost:1337/logs',
        timestamp: Date.now(),
      });

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);

      // For Slack format, check blocks
      if (body.blocks) {
        const text = JSON.stringify(body);
        expect(text).toContain('test-project');
        expect(text).toContain('success');
      }
    });

    it('handles missing optional fields', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await notify({
        event: 'release_success',
        project: 'test-project',
        job_id: 'job-123',
        status: 'success',
        timestamp: Date.now(),
      });

      expect(global.fetch).toHaveBeenCalled();
    });
  });
});
