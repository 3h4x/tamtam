import { NextResponse } from 'next/server';
import { AGENT_CATALOG } from '@/lib/agents/catalog';

// Static catalog read — the array lives in code, so this endpoint is
// cheap, idempotent, and safe to cache aggressively client-side. The
// shape mirrors `AgentCatalogEntry` minus the server-only `handlerKey`
// — the client doesn't need to know how internal agents dispatch.
export async function GET() {
  const entries = AGENT_CATALOG.map((entry) => ({
    name: entry.name,
    aliases: entry.aliases ?? [],
    description: entry.description,
    dispatch: entry.dispatch,
    defaultSchedule: entry.defaultSchedule,
    defaultModel: entry.defaultModel,
    prompt: entry.prompt,
    skillIds: entry.skillIds,
    autoSeed: entry.autoSeed === true,
    tier: entry.tier ?? null,
    fallbackEnabled: entry.fallbackEnabled === true,
    inspiration: entry.inspiration ?? [],
  }));
  return NextResponse.json({ entries });
}
