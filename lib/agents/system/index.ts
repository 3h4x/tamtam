// Compatibility facade — the system-agent surface is now derived from
// the unified `lib/agents/catalog.ts`. New auto-seeded internal agents
// go in the catalog with `dispatch: 'internal'` + `autoSeed: true`;
// this module only exists so existing call sites keep compiling.

import type { AgentInput } from '@/lib/scheduling/agent-types';
import { autoSeededCatalogEntries, findCatalogEntry, type AgentCatalogEntry } from '@/lib/agents/catalog';

export interface SystemAgentSeedConfig {
  name: string;
  prompt: string;
  defaultSchedule: string;
  model: string;
}

export interface SystemAgentHandler {
  seed: SystemAgentSeedConfig;
  run: (agent: AgentInput) => Promise<{ jobId: string }>;
}

type SystemAgentRun = SystemAgentHandler['run'];

function toSeedConfig(entry: AgentCatalogEntry): SystemAgentSeedConfig {
  return {
    name: entry.name,
    prompt: entry.prompt,
    defaultSchedule: entry.defaultSchedule,
    model: entry.defaultModel,
  };
}

function toHandler(entry: AgentCatalogEntry): SystemAgentHandler {
  const run = resolveSystemAgentRun(entry);
  if (!run) {
    throw new Error(`catalog entry '${entry.name}' is autoSeed=true but has no handler`);
  }
  return { seed: toSeedConfig(entry), run };
}

function resolveSystemAgentRun(entry: AgentCatalogEntry): SystemAgentRun | null {
  if (entry.handlerKey === 'documentation-reindex-vectors') {
    return async (agent) => {
      const { runRetrievalMaintenance } = await import('@/lib/agents/system/retrieval-maintenance');
      return runRetrievalMaintenance(agent);
    };
  }
  return null;
}

export const SYSTEM_AGENTS: Record<string, SystemAgentHandler> = Object.fromEntries(
  autoSeededCatalogEntries().map((entry) => [entry.name, toHandler(entry)]),
);

export function getSystemAgentHandler(name: string): SystemAgentHandler | null {
  const entry = findCatalogEntry(name);
  if (!entry || !entry.autoSeed || entry.dispatch !== 'internal' || !entry.handlerKey) return null;
  return toHandler(entry);
}

export function listSystemAgentSeedConfigs(): SystemAgentSeedConfig[] {
  return autoSeededCatalogEntries().map(toSeedConfig);
}
