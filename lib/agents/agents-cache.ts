import { db, schema } from '@/lib/db';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { resolveAgentPrerequisiteCommandWithFileSkills } from '@/lib/agents/file-skill-prerequisites';

export type AgentRow = typeof schema.agents.$inferSelect;
export type NormalizedAgent = Omit<AgentRow, 'skillIds' | 'docPaths'> & { skillIds: string[]; docPaths: string[] };

export function normalizeAgent(row: AgentRow): NormalizedAgent {
  const skillIds = JSON.parse(row.skillIds || '[]');
  return {
    ...row,
    model: normalizeModelInput(row.model, 'normal'),
    skillIds,
    docPaths: JSON.parse(row.docPaths || '[]'),
    prerequisiteCommand: resolveAgentPrerequisiteCommandWithFileSkills({
      project: row.project,
      skillIds,
      prerequisiteCommand: row.prerequisiteCommand,
    }),
  };
}

const AGENTS_CACHE_TTL = 10; // seconds
let _agentsCache: { agents: AgentRow[]; time: number } | null = null;
// Track the in-flight refresh as a Promise (not a boolean) so concurrent
// callers can await the same fetch instead of returning immediately and
// reading still-stale (or empty-on-cold-start) cache state. A boolean guard
// deduplicates the DB call but leaks the freshness signal — async
// callers would receive whatever was cached at the moment they called,
// not the post-refresh value.
let _agentsRefreshPromise: Promise<void> | null = null;

function _doAgentsRefresh(): Promise<void> {
  if (_agentsRefreshPromise) return _agentsRefreshPromise;
  _agentsRefreshPromise = (async () => {
    try {
      const agents = await db.select().from(schema.agents);
      _agentsCache = { agents, time: Date.now() / 1000 };
    } catch (e) {
      console.error('[agents-cache] refresh failed:', e);
    } finally {
      _agentsRefreshPromise = null;
    }
  })();
  return _agentsRefreshPromise;
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
