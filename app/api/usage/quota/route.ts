import { NextRequest, NextResponse } from 'next/server';
import { getQuotaForProvider, clearQuotaCache } from '@/lib/usage/quota';
import { getSettings } from '@/lib/shared/config';

function gateEnabled(): boolean {
  try { return getSettings()?.budget_block_runs_enabled === true; } catch { return false; }
}

function providerFromRequest(request: NextRequest): 'active' | 'claude' | 'codex' {
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

export async function GET(request: NextRequest) {
  try {
    const snapshot = await getQuotaForProvider(providerFromRequest(request));
    return NextResponse.json({ ...snapshot, gateEnabled: gateEnabled() });
  } catch (e) {
    return NextResponse.json(
      { error: quotaErrorMessage(e) },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  clearQuotaCache();
  try {
    const snapshot = await getQuotaForProvider(providerFromRequest(request), { force: true });
    return NextResponse.json({ ...snapshot, gateEnabled: gateEnabled() });
  } catch (e) {
    return NextResponse.json(
      { error: quotaErrorMessage(e) },
      { status: 502 }
    );
  }
}
