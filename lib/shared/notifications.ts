import { createHmac } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings } from '@/lib/shared/config';

export type NotificationEvent =
  | 'release_success'
  | 'release_fail'
  | 'release_aborted'
  | 'fix_loop_exhausted'
  | 'review_do_not_ship'
  | 'agent_run_fail'
  | 'budget_blocked'
  | 'budget_exceeded'
  | 'flaky_test_detected'
  | 'circuit_breaker_tripped'
  | 'post_merge_revert';

export interface NotificationPayload {
  event: NotificationEvent;
  project: string;
  agent?: string;
  job_id: string;
  status: 'success' | 'failed';
  verdict?: string;
  cost_usd?: number;
  log_url?: string;
  message?: string;
  reason?: string;
  suppressedSince?: number;
  throttleKeySuffix?: string;
  timestamp: number;
}

interface NotificationConfig {
  webhook_url: string;
  webhook_secret: string;
  enabled: boolean;
}

const notificationQueues = new Map<string, Promise<void>>();

function getNotificationConfig(event: NotificationEvent): NotificationConfig {
  const settings = getSettings();
  const webhookUrl = settings.notification_webhook_url || '';
  const webhookSecret = settings.notification_webhook_secret || '';

  let enabled = false;

  switch (event) {
    case 'release_success':
      enabled = settings.notification_on_release_success || false;
      break;
    case 'release_fail':
      enabled = settings.notification_on_release_fail || false;
      break;
    case 'release_aborted':
      enabled = settings.notification_on_release_aborted || false;
      break;
    case 'fix_loop_exhausted':
      enabled = settings.notification_on_fix_loop_exhausted || false;
      break;
    case 'review_do_not_ship':
      enabled = settings.notification_on_review_do_not_ship || false;
      break;
    case 'agent_run_fail':
      enabled = settings.notification_on_agent_run_fail || false;
      break;
    case 'budget_blocked':
      enabled = settings.notification_on_budget_blocked || false;
      break;
    case 'budget_exceeded':
      enabled = settings.notification_on_budget_exceeded || false;
      break;
    case 'flaky_test_detected':
      enabled = settings.notification_on_flaky_test_detected || false;
      break;
    case 'circuit_breaker_tripped':
      enabled = settings.notification_on_circuit_breaker_tripped || false;
      break;
    case 'post_merge_revert':
      enabled = settings.notification_on_post_merge_revert || false;
      break;
  }

  return { webhook_url: webhookUrl, webhook_secret: webhookSecret, enabled };
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function detectWebhookType(url: string): 'slack' | 'discord' | 'generic' {
  if (url.includes('hooks.slack.com')) return 'slack';
  if (url.includes('discord.com/api/webhooks')) return 'discord';
  return 'generic';
}

function throttleSubject(payload: NotificationPayload): string {
  if (payload.agent) return payload.agent;
  switch (payload.event) {
    case 'agent_run_fail': return 'agent';
    case 'review_do_not_ship': return 'review';
    case 'fix_loop_exhausted': return 'fix';
    case 'budget_blocked': return 'budget';
    case 'budget_exceeded': return 'spend';
    case 'flaky_test_detected': return 'test';
    case 'circuit_breaker_tripped': return 'circuit-breaker';
    case 'post_merge_revert': return 'soak';
    default: return 'release';
  }
}

function throttleKey(payload: NotificationPayload): string {
  if (payload.throttleKeySuffix) {
    return `${payload.event}:${payload.project}:${payload.throttleKeySuffix}`;
  }
  return `${payload.event}:${payload.project}:${throttleSubject(payload)}`;
}

function throttleWindowMs(payload: NotificationPayload, settings: ReturnType<typeof getSettings>): number {
  const override = settings.notification_throttle_overrides[payload.event];
  const seconds = override ?? settings.notification_throttle_window_seconds;
  return Math.max(0, seconds) * 1000;
}

function withSuppressedMessage(payload: NotificationPayload, suppressedSince: number): NotificationPayload {
  if (suppressedSince <= 0) return payload;
  const suffix = `${suppressedSince} more notification${suppressedSince === 1 ? '' : 's'} suppressed since the last alert.`;
  return {
    ...payload,
    suppressedSince,
    message: payload.message ? `${payload.message}\n\n${suffix}` : suffix,
  };
}

type ThrottleSendState =
  | {
      key: string;
      now: number;
      kind: 'insert';
    }
  | {
      key: string;
      now: number;
      kind: 'update';
    };

async function shouldSend(
  payload: NotificationPayload,
): Promise<{ send: boolean; payload: NotificationPayload; state: ThrottleSendState | null }> {
  const settings = getSettings();
  const windowMs = throttleWindowMs(payload, settings);
  if (windowMs <= 0) return { send: true, payload, state: null };

  const now = payload.timestamp || Date.now();
  const key = throttleKey(payload);
  const rows = await db.select()
    .from(schema.notificationThrottle)
    .where(eq(schema.notificationThrottle.key, key))
    .limit(1);
  const existing = rows[0] ?? null;

  if (!existing) {
    return {
      send: true,
      payload,
      state: { key, now, kind: 'insert' },
    };
  }

  if (now - existing.lastSentAt < windowMs) {
    void db.update(schema.notificationThrottle)
      .set({ suppressedCount: existing.suppressedCount + 1 })
      .where(eq(schema.notificationThrottle.key, key))
      .execute()
      .catch((e) => console.error('[notifications] throttle suppress update failed:', e));
    return { send: false, payload, state: null };
  }

  return {
    send: true,
    payload: withSuppressedMessage(payload, existing.suppressedCount),
    state: { key, now, kind: 'update' },
  };
}

function markThrottleDelivered(state: ThrottleSendState | null) {
  if (!state) return;
  if (state.kind === 'insert') {
    void db.insert(schema.notificationThrottle)
      .values({ key: state.key, lastSentAt: state.now, suppressedCount: 0 })
      .execute()
      .catch((e) => console.error('[notifications] throttle insert failed:', e));
    return;
  }
  void db.update(schema.notificationThrottle)
    .set({ lastSentAt: state.now, suppressedCount: 0 })
    .where(eq(schema.notificationThrottle.key, state.key))
    .execute()
    .catch((e) => console.error('[notifications] throttle update failed:', e));
}

function enqueueNotification(key: string, task: () => Promise<void>) {
  const previous = notificationQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (notificationQueues.get(key) === next) {
        notificationQueues.delete(key);
      }
    });
  notificationQueues.set(key, next);
}

function toGenericBody(payload: NotificationPayload): Record<string, unknown> {
  const { throttleKeySuffix: _throttleKeySuffix, ...body } = payload;
  return body as unknown as Record<string, unknown>;
}

function formatSlackMessage(payload: NotificationPayload): Record<string, unknown> {
  const emoji = payload.status === 'success' ? '✅' : '❌';

  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${payload.event.replace(/_/g, ' ')}* (${payload.project})`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Event*\n${payload.event}` },
          { type: 'mrkdwn', text: `*Project*\n${payload.project}` },
          { type: 'mrkdwn', text: `*Status*\n${payload.status}` },
          ...(payload.verdict ? [{ type: 'mrkdwn', text: `*Verdict*\n${payload.verdict}` }] : []),
          ...(payload.agent ? [{ type: 'mrkdwn', text: `*Agent*\n${payload.agent}` }] : []),
          ...(payload.cost_usd ? [{ type: 'mrkdwn', text: `*Cost*\n$${payload.cost_usd.toFixed(4)}` }] : []),
        ],
      },
      ...(payload.message ? [{ type: 'section', text: { type: 'mrkdwn', text: `_${payload.message}_` } }] : []),
      ...(payload.log_url ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Log' }, url: payload.log_url }] }] : []),
    ],
  };
}

function formatDiscordMessage(payload: NotificationPayload): Record<string, unknown> {
  const color = payload.status === 'success' ? 3_066_993 : 15_158_332;

  return {
    embeds: [
      {
        title: `${payload.event.replace(/_/g, ' ')} (${payload.project})`,
        color,
        fields: [
          { name: 'Status', value: payload.status, inline: true },
          ...(payload.verdict ? [{ name: 'Verdict', value: payload.verdict, inline: true }] : []),
          ...(payload.agent ? [{ name: 'Agent', value: payload.agent, inline: true }] : []),
          ...(payload.cost_usd ? [{ name: 'Cost', value: `$${payload.cost_usd.toFixed(4)}`, inline: true }] : []),
          ...(payload.message ? [{ name: 'Message', value: payload.message }] : []),
        ],
        ...(payload.log_url ? { url: payload.log_url } : {}),
        timestamp: new Date(payload.timestamp).toISOString(),
      },
    ],
  };
}

interface WebhookResult {
  ok: boolean;
  /** Set when `ok === false` — describes the last failure (HTTP status, network error, etc). */
  error?: string;
}

async function postWebhook(
  url: string,
  bodyJson: string,
  signature?: string,
  maxRetries: number = 3,
  perAttemptTimeoutMs: number = 10_000,
): Promise<WebhookResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'TamTam/1.0',
  };

  if (signature) {
    headers['X-TamTam-Signature'] = signature;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyJson,
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
      });

      if (response.ok) {
        return { ok: true };
      }

      lastError = new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }

    if (attempt < maxRetries - 1) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const message = lastError?.message ?? 'unknown error';
  console.error(`[notifications] webhook POST failed after ${maxRetries} attempts:`, message);
  return { ok: false, error: message };
}

export async function notify(payload: NotificationPayload): Promise<void> {
  if (!payload.timestamp) {
    payload.timestamp = Date.now();
  }

  const config = getNotificationConfig(payload.event);

  if (!config.enabled || !config.webhook_url) {
    return;
  }
  const queuedPayload = { ...payload };
  const queueKey = throttleKey(queuedPayload);

  // Never block pipeline progress — work is serialized per throttle key in the
  // background so the persisted throttle state still tracks delivered alerts.
  enqueueNotification(queueKey, async () => {
    const throttle = await shouldSend(queuedPayload);
    if (!throttle.send) return;
    const resolvedPayload = throttle.payload;
    const webhookType = detectWebhookType(config.webhook_url);
    let body: Record<string, unknown>;

    if (webhookType === 'slack') {
      body = formatSlackMessage(resolvedPayload);
    } else if (webhookType === 'discord') {
      body = formatDiscordMessage(resolvedPayload);
    } else {
      body = toGenericBody(resolvedPayload);
    }

    const bodyJson = JSON.stringify(body);
    const signature = config.webhook_secret ? signPayload(bodyJson, config.webhook_secret) : undefined;

    try {
      const delivered = await postWebhook(config.webhook_url, bodyJson, signature);
      if (delivered.ok) {
        markThrottleDelivered(throttle.state);
      }
    } catch (e) {
      console.error(`[notifications] failed to send ${resolvedPayload.event} notification:`, e);
    }
  });
}

export async function sendTestNotification(webhookUrl: string, webhookSecret: string): Promise<{ ok: boolean; error?: string }> {
  if (!webhookUrl) {
    return { ok: false, error: 'Webhook URL is required' };
  }

  const payload: NotificationPayload = {
    event: 'release_success',
    project: 'test-project',
    job_id: 'test-job-123',
    status: 'success',
    message: 'This is a test notification from TamTam',
    timestamp: Date.now(),
  };

  const webhookType = detectWebhookType(webhookUrl);
  let body: Record<string, unknown>;

  if (webhookType === 'slack') {
    body = formatSlackMessage(payload);
  } else if (webhookType === 'discord') {
    body = formatDiscordMessage(payload);
  } else {
    body = toGenericBody(payload);
  }

  const bodyJson = JSON.stringify(body);
  const signature = webhookSecret ? signPayload(bodyJson, webhookSecret) : undefined;

  // Test invocation: single attempt, shorter timeout. The 3× retry-with-
  // backoff that real notifications use would make a failing "Test" button
  // take ~33s before surfacing the error (10s timeout × 3 + 3s backoff),
  // which feels broken from the UI. One attempt with 5s timeout is the
  // right shape for "did I configure this correctly?".
  const result = await postWebhook(webhookUrl, bodyJson, signature, 1, 5_000);
  if (result.ok) return { ok: true };
  return { ok: false, error: `Webhook request failed: ${result.error ?? 'unknown error'}` };
}
