import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import type { BudgetSubscriptionProvider } from '@/lib/usage/subscription-providers';

export type ClientQuotaProvider = 'active' | BudgetSubscriptionProvider;

export interface ClientQuotaSnapshot extends QuotaSnapshot {
  available?: true;
  gateEnabled?: boolean;
  schedulerThrottle?: {
    reason: string;
    projectedPct: number;
    worstProvider: string;
    resumesAtMs: number | null;
  } | null;
}

type ClientSchedulerThrottle = NonNullable<ClientQuotaSnapshot['schedulerThrottle']>;

export type ClientQuotaResult =
  | { available: true; snapshot: ClientQuotaSnapshot; error: null }
  | {
      available: false;
      snapshot: null;
      error: string;
      reason?: string;
      gateEnabled?: boolean;
      schedulerThrottle?: ClientSchedulerThrottle | null;
    };

function readSchedulerThrottle(body: Record<string, unknown>): ClientSchedulerThrottle | null | undefined {
  if (!('schedulerThrottle' in body)) return undefined;
  const throttle = body.schedulerThrottle;
  if (throttle == null) return null;
  if (typeof throttle !== 'object') return undefined;
  return throttle as ClientSchedulerThrottle;
}

export async function loadQuotaSnapshot(provider: ClientQuotaProvider = 'active'): Promise<ClientQuotaResult> {
  const query = provider === 'active' ? '' : `?provider=${provider}`;
  try {
    const res = await fetch(`/api/usage/quota${query}`);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok && body.available !== false && body.fiveHour && body.sevenDay) {
      return { available: true, snapshot: body as unknown as ClientQuotaSnapshot, error: null };
    }
    return {
      available: false,
      snapshot: null,
      error: String(body.error ?? body.message ?? `Quota unavailable${res.ok ? '' : ` (HTTP ${res.status})`}`),
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      gateEnabled: typeof body.gateEnabled === 'boolean' ? body.gateEnabled : undefined,
      schedulerThrottle: readSchedulerThrottle(body),
    };
  } catch (err) {
    return {
      available: false,
      snapshot: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
