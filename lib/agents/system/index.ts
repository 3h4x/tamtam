// Registry of built-in "system" agents — auto-seeded per project, scheduled
// through the existing graphile-worker cron pipeline, but dispatched to
// internal handlers instead of spawning a CLI. Each entry maps an agent
// name to its handler function plus the default seed config used by the
// seeder.
//
// System agents share the agents table and the scheduled-agent cron
// pipeline, but kind='system' rows do NOT go through
// runAgentIntakeWorkflow. The cron task branches on agent.kind and looks
// up the handler here.

import type { AgentInput } from '@/lib/scheduling/agent-types';
import { runRetrievalMaintenance, RETRIEVAL_MAINTENANCE_AGENT_NAME } from './retrieval-maintenance';

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

export const SYSTEM_AGENTS: Record<string, SystemAgentHandler> = {
  [RETRIEVAL_MAINTENANCE_AGENT_NAME]: {
    seed: {
      name: RETRIEVAL_MAINTENANCE_AGENT_NAME,
      prompt:
        'Auto-managed: refreshes the pgvector retrieval corpus for this project, ' +
        'wipes stale embeddings when the embedding model changes, and verifies ' +
        'result quality with a small local LLM. Edit schedule or disable from ' +
        'the agents UI.',
      defaultSchedule: '1h',
      model: 'normal',
    },
    run: runRetrievalMaintenance,
  },
};

export function getSystemAgentHandler(name: string): SystemAgentHandler | null {
  return SYSTEM_AGENTS[name] ?? null;
}

export function listSystemAgentSeedConfigs(): SystemAgentSeedConfig[] {
  return Object.values(SYSTEM_AGENTS).map((h) => h.seed);
}
