import { NextResponse } from 'next/server';
import { AGENT_CATALOG } from '@/lib/agents/catalog';
import { findFileBackedSkill } from '@/lib/agents/skills-from-files';

// Static catalog read — the array lives in code, so this endpoint is
// cheap, idempotent, and safe to cache aggressively client-side. The
// shape mirrors `AgentCatalogEntry` minus the server-only `handlerKey`
// — the client doesn't need to know how internal agents dispatch.
//
// When an entry's primary skill (skillIds[0]) is file-backed, we merge
// its frontmatter metadata (agent-defaults, references, requires, etc.)
// onto the response so the catalog UI gets the .md file as the source
// of truth for those fields. Inline catalog values act as fallbacks.
export async function GET() {
  const entries = AGENT_CATALOG.map((entry) => {
    const primarySkillId = entry.skillIds[0];
    const file = primarySkillId ? findFileBackedSkill(primarySkillId) : null;
    const fileDefaults = file?.agentDefaults;
    return {
      name: entry.name,
      aliases: fileDefaults?.aliases ?? entry.aliases ?? [],
      description: file?.description ?? entry.description,
      dispatch: entry.dispatch,
      defaultSchedule: fileDefaults?.defaultSchedule ?? entry.defaultSchedule,
      defaultModel: fileDefaults?.defaultModel ?? entry.defaultModel,
      prompt: entry.prompt,
      skillIds: entry.skillIds,
      autoSeed: entry.autoSeed === true,
      tier: fileDefaults?.tier ?? entry.tier ?? null,
      fallbackEnabled: fileDefaults?.fallbackEnabled ?? entry.fallbackEnabled === true,
      inspiration: file?.references ?? entry.inspiration ?? [],
      requires: file?.requires ?? [],
      outputs: file?.outputs ?? [],
      relatedAgents: file?.relatedAgents ?? [],
      version: file?.version ?? null,
    };
  });
  return NextResponse.json({ entries });
}
