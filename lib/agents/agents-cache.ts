import { db, schema } from '@/lib/db';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { resolveAgentPrerequisiteCommand } from '@/lib/agents/issue-cruncher';

export type AgentRow = typeof schema.agents.$inferSelect;
export type NormalizedAgent = Omit<AgentRow, 'skillIds' | 'docPaths'> & { skillIds: string[]; docPaths: string[] };

export function normalizeAgent(row: AgentRow): NormalizedAgent {
  const skillIds = JSON.parse(row.skillIds || '[]');
  return {
    ...row,
    model: normalizeModelInput(row.model, 'normal'),
    skillIds,
    docPaths: JSON.parse(row.docPaths || '[]'),
    prerequisiteCommand: resolveAgentPrerequisiteCommand({
      project: row.project,
      skillIds,
      prerequisiteCommand: row.prerequisiteCommand,
    }),
  };
}

const AGENTS_CACHE_TTL = 10; // seconds
let _agentsCache: { agents: AgentRow[]; time: number } | null = null;
let _agentsRefreshing = false;

async function _doAgentsRefresh(): Promise<void> {
  if (_agentsRefreshing) return;
  _agentsRefreshing = true;
  try {
    const agents = await db.select().from(schema.agents);
    _agentsCache = { agents, time: Date.now() / 1000 };
  } catch (e) {
    console.error('[agents-cache] refresh failed:', e);
  } finally {
    _agentsRefreshing = false;
  }
}

export function getAllAgentsCached(): AgentRow[] {
  const now = Date.now() / 1000;
  if (_agentsCache && now - _agentsCache.time < AGENTS_CACHE_TTL) return _agentsCache.agents;
  void _doAgentsRefresh();
  return _agentsCache?.agents ?? [];
}

export async function getAllAgentsCachedAsync(): Promise<AgentRow[]> {
  const now = Date.now() / 1000;
  if (_agentsCache && now - _agentsCache.time < AGENTS_CACHE_TTL) return _agentsCache.agents;
  await _doAgentsRefresh();
  return _agentsCache?.agents ?? [];
}

export function clearAgentsCache() {
  _agentsCache = null;
}
