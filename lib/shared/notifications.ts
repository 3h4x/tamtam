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
  | 'budget_blocked';

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

function shouldSend(
  payload: NotificationPayload,
): { send: boolean; payload: NotificationPayload; state: ThrottleSendState | null } {
  const settings = getSettings();
  const windowMs = throttleWindowMs(payload, settings);
  if (windowMs <= 0) return { send: true, payload, state: null };

  const now = payload.timestamp || Date.now();
  const key = throttleKey(payload);
  const existing = db.select()
    .from(schema.notificationThrottle)
    .where(eq(schema.notificationThrottle.key, key))
    .get();

  if (!existing) {
    return {
      send: true,
      payload,
      state: { key, now, kind: 'insert' },
    };
  }

  if (now - existing.lastSentAt < windowMs) {
    db.update(schema.notificationThrottle)
      .set({ suppressedCount: existing.suppressedCount + 1 })
      .where(eq(schema.notificationThrottle.key, key))
      .run();
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
    db.insert(schema.notificationThrottle)
      .values({ key: state.key, lastSentAt: state.now, suppressedCount: 0 })
      .run();
    return;
  }
  db.update(schema.notificationThrottle)
    .set({ lastSentAt: state.now, suppressedCount: 0 })
    .where(eq(schema.notificationThrottle.key, state.key))
    .run();
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

async function postWebhook(
  url: string,
  body: Record<string, unknown>,
  signature?: string,
  maxRetries: number = 3,
): Promise<boolean> {
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
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        return true;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }

    if (attempt < maxRetries - 1) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.error(`[notifications] webhook POST failed after ${maxRetries} attempts:`, lastError?.message);
  return false;
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
    const throttle = shouldSend(queuedPayload);
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
      const delivered = await postWebhook(config.webhook_url, body, signature);
      if (delivered) {
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

  const success = await postWebhook(webhookUrl, body, signature);
  return success ? { ok: true } : { ok: false, error: 'Webhook request failed' };
}
