import { createHmac } from 'crypto';
import { getSettings } from './config';

export type NotificationEvent =
  | 'release_success'
  | 'release_fail'
  | 'release_aborted'
  | 'fix_loop_exhausted'
  | 'review_do_not_ship'
  | 'agent_run_fail';

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
  timestamp: number;
}

interface NotificationConfig {
  webhook_url: string;
  webhook_secret: string;
  enabled: boolean;
}

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

  const webhookType = detectWebhookType(config.webhook_url);
  let body: Record<string, unknown>;

  if (webhookType === 'slack') {
    body = formatSlackMessage(payload);
  } else if (webhookType === 'discord') {
    body = formatDiscordMessage(payload);
  } else {
    body = payload as unknown as Record<string, unknown>;
  }

  const bodyJson = JSON.stringify(body);
  const signature = config.webhook_secret ? signPayload(bodyJson, config.webhook_secret) : undefined;

  // Never block pipeline progress — fire and forget
  postWebhook(config.webhook_url, body, signature).catch((e) => {
    console.error(`[notifications] failed to send ${payload.event} notification:`, e);
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
    body = payload as unknown as Record<string, unknown>;
  }

  const bodyJson = JSON.stringify(body);
  const signature = webhookSecret ? signPayload(bodyJson, webhookSecret) : undefined;

  const success = await postWebhook(webhookUrl, body, signature);
  return success ? { ok: true } : { ok: false, error: 'Webhook request failed' };
}
