import { NextRequest, NextResponse } from 'next/server';
import { getQuotaForProvider, clearQuotaCache, peekQuotaCacheForProvider, readPersistedSnapshotForProvider, type QuotaProvider } from '@/lib/usage/quota';
import { ProviderNotConfiguredError, type QuotaSnapshot } from '@/lib/usage/quota-types';
import { getSettings } from '@/lib/shared/config';
import {
  readEnabledProviderSnapshots,
  scheduledBurnRateBlockedAcrossProviders,
  warmEnabledProviderSnapshots,
} from '@/lib/shared/job-control';
import { computeSnapshotPace, computeGlobalPace, type GlobalPace } from '@/lib/usage/quota-pace';

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

// Cross-provider ("global") pace, resilient to cold/rate-limited providers:
// reads in-memory snapshots and falls back to the DB-persisted last-known
// snapshot per enabled provider, so e.g. a rate-limited Claude still appears.
async function resilientGlobalPace(): Promise<GlobalPace> {
  try {
    return computeGlobalPace(await readEnabledProviderSnapshots());
  } catch {
    return computeGlobalPace([]);
  }
}

function quotaPayload(snapshot: object, globalPace: GlobalPace) {
  const throttle = scheduledBurnRateBlockedAcrossProviders();
  // Per-CLI pace for this snapshot's windows + cross-provider ("global") pace
  // so callers can see, without re-deriving, how much room is left to the
  // fair-share pace line (or by how much it's exceeded), per provider and overall.
  const pace = computeSnapshotPace(snapshot as QuotaSnapshot);
  return {
    ...snapshot,
    available: true,
    gateEnabled: gateEnabled(),
    schedulerThrottle: throttle,
    pace,
    globalPace,
  };
}

async function unavailablePayload(provider: QuotaProvider, e: unknown, globalPace: GlobalPace) {
  // 1) in-memory cache (warm) → serve last value, marked stale.
  const cached = peekQuotaCacheForProvider(provider);
  if (cached) return quotaPayload({ ...cached, stale: true }, globalPace);
  // 2) DB-persisted last-known snapshot → survives restart / upstream rate-limit.
  const persisted = await readPersistedSnapshotForProvider(provider);
  if (persisted) return quotaPayload({ ...persisted, stale: true }, globalPace);
  // 3) genuinely nothing on record — error shape (still carries globalPace so
  //    sibling providers remain visible).
  return {
    available: false,
    configured: !(e instanceof ProviderNotConfiguredError),
    provider: provider === 'active' ? undefined : provider,
    reason: unavailableReason(e),
    error: quotaErrorMessage(e),
    gateEnabled: gateEnabled(),
    schedulerThrottle: scheduledBurnRateBlockedAcrossProviders(),
    globalPace,
  };
}

export async function GET(request: NextRequest) {
  const provider = providerFromRequest(request);
  try {
    const snapshot = await getQuotaForProvider(provider);
    await warmEnabledProviderSnapshots();
    return NextResponse.json(quotaPayload(snapshot, await resilientGlobalPace()));
  } catch (e) {
    return NextResponse.json(await unavailablePayload(provider, e, await resilientGlobalPace()));
  }
}

export async function POST(request: NextRequest) {
  const provider = providerFromRequest(request);
  clearQuotaCache();
  try {
    const snapshot = await getQuotaForProvider(provider, { force: true });
    await warmEnabledProviderSnapshots({ force: true });
    return NextResponse.json(quotaPayload(snapshot, await resilientGlobalPace()));
  } catch (e) {
    return NextResponse.json(await unavailablePayload(provider, e, await resilientGlobalPace()));
  }
}
