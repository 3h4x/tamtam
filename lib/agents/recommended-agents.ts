// Compatibility facade — the recommended-agents surface is now derived
// from the unified `lib/agents/catalog.ts`. New built-in agents go in
// the catalog; this module only exists so existing call sites keep
// compiling. Prefer the catalog API in new code.

import { AGENT_CATALOG, catalogNameKey, catalogNameKeys, findCatalogEntry, isInCatalog, type AgentCatalogEntry } from '@/lib/agents/catalog';

export interface RecommendedAgentTemplate {
  name: string;
  aliases?: string[];
  description: string;
  model: string;
  schedule: string;
  prompt: string;
  skillIds: string[];
  essential?: boolean;
  featured?: boolean;
  fallbackEnabled?: boolean;
}

function toTemplate(entry: AgentCatalogEntry): RecommendedAgentTemplate {
  return {
    name: entry.name,
    aliases: entry.aliases,
    description: entry.description,
    model: entry.defaultModel,
    schedule: entry.defaultSchedule,
    prompt: entry.prompt,
    skillIds: entry.skillIds,
    essential: entry.tier === 'essential',
    featured: entry.tier === 'featured',
    fallbackEnabled: entry.fallbackEnabled,
  };
}

// Surfaced templates are the CLI-dispatch catalog entries that are NOT
// auto-seeded. Internal (`documentation-reindex-vectors`) and auto-seeded
// CLI agents (`health`) are materialized per project by the seeder, so they
// must not also appear as manual "Add agent" templates (would be a duplicate).
export const RECOMMENDED_AGENTS: RecommendedAgentTemplate[] = AGENT_CATALOG
  .filter((e) => e.dispatch === 'cli' && !e.autoSeed)
  .map(toTemplate);

export function recommendedAgentNameKey(name: string): string {
  return catalogNameKey(name);
}

export function recommendedAgentNameKeys(agent: Pick<RecommendedAgentTemplate, 'name' | 'aliases'>): string[] {
  return catalogNameKeys(agent);
}

export function recommendedAgentMatchesName(
  agent: Pick<RecommendedAgentTemplate, 'name' | 'aliases'>,
  name: string,
): boolean {
  const key = catalogNameKey(name);
  return key !== '' && catalogNameKeys(agent).includes(key);
}

export function isBuiltInRecommendedAgent(name: string): boolean {
  if (!name) return false;
  const entry = findCatalogEntry(name);
  return entry !== null && entry.dispatch === 'cli';
}

// Re-export so callers that previously imported the catalog helper through
// this module's surface keep working.
export { isInCatalog };
