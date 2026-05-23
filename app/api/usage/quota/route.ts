import { NextRequest, NextResponse } from 'next/server';
import { getQuotaForProvider, clearQuotaCache, peekQuotaCacheForProvider, type QuotaProvider } from '@/lib/usage/quota';
import { ProviderNotConfiguredError, type QuotaSnapshot } from '@/lib/usage/quota-types';
import { getSettings } from '@/lib/shared/config';
import {
  peekEnabledProviderSnapshots,
  scheduledBurnRateBlockedAcrossProviders,
  warmEnabledProviderSnapshots,
} from '@/lib/shared/job-control';
import { computeSnapshotPace, computeGlobalPace } from '@/lib/usage/quota-pace';

function gateEnabled(): boolean {
  try { return getSettings()?.budget_block_runs_enabled === true; } catch { return false; }
}

function providerFromRequest(request: NextRequest): QuotaProvider {
  const provider = request.nextUrl.searchParams.get('provider');
  return provider === 'claude' || provider === 'codex' ? provider : 'active';
}

function quotaErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('Anthropic usage API rate-limited') || msg.includes('backing off after Anthropic usage API rate limit')) {
    return 'Claude quota temporarily unavailable: Anthropic usage API is rate-limited and no cached snapshot exists yet.';
  }
  return msg;
}

function unavailableReason(e: unknown): 'not_configured' | 'rate_limited' | 'unavailable' {
  if (e instanceof ProviderNotConfiguredError) return 'not_configured';
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('rate-limited') || msg.includes('backing off')) return 'rate_limited';
  return 'unavailable';
}

function quotaPayload(snapshot: object) {
  const throttle = scheduledBurnRateBlockedAcrossProviders();
  // Per-CLI pace for this snapshot's windows + cross-provider ("global") pace
  // so callers can see, without re-deriving, how much room is left to the
  // fair-share pace line (or by how much it's exceeded), per provider and overall.
  const pace = computeSnapshotPace(snapshot as QuotaSnapshot);
  const globalPace = computeGlobalPace(peekEnabledProviderSnapshots());
  return {
    ...snapshot,
    available: true,
    gateEnabled: gateEnabled(),
    schedulerThrottle: throttle,
    pace,
    globalPace,
  };
}

function unavailablePayload(provider: QuotaProvider, e: unknown) {
  const cached = peekQuotaCacheForProvider(provider);
  if (cached) {
    return quotaPayload({ ...cached, stale: true });
  }
  return {
    available: false,
    configured: !(e instanceof ProviderNotConfiguredError),
    provider: provider === 'active' ? undefined : provider,
    reason: unavailableReason(e),
    error: quotaErrorMessage(e),
    gateEnabled: gateEnabled(),
    schedulerThrottle: scheduledBurnRateBlockedAcrossProviders(),
  };
}

export async function GET(request: NextRequest) {
  const provider = providerFromRequest(request);
  try {
    const snapshot = await getQuotaForProvider(provider);
    await warmEnabledProviderSnapshots();
    return NextResponse.json(quotaPayload(snapshot));
  } catch (e) {
    return NextResponse.json(unavailablePayload(provider, e));
  }
}

export async function POST(request: NextRequest) {
  const provider = providerFromRequest(request);
  clearQuotaCache();
  try {
    const snapshot = await getQuotaForProvider(provider, { force: true });
    await warmEnabledProviderSnapshots({ force: true });
    return NextResponse.json(quotaPayload(snapshot));
  } catch (e) {
    return NextResponse.json(unavailablePayload(provider, e));
  }
}
