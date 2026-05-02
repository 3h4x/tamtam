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

export async function GET(request: NextRequest) {
  try {
    const snapshot = await getQuotaForProvider(providerFromRequest(request));
    return NextResponse.json({ ...snapshot, gateEnabled: gateEnabled() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
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
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
