import { db, schema } from '@/lib/db';

export type AgentRow = typeof schema.agents.$inferSelect;
export type NormalizedAgent = Omit<AgentRow, 'skillIds' | 'docPaths'> & { skillIds: string[]; docPaths: string[] };

export function normalizeAgent(row: AgentRow): NormalizedAgent {
  return {
    ...row,
    skillIds: JSON.parse(row.skillIds || '[]'),
    docPaths: JSON.parse(row.docPaths || '[]'),
  };
}

const AGENTS_CACHE_TTL = 10; // seconds
let _agentsCache: { agents: AgentRow[]; time: number } | null = null;

export function getAllAgentsCached() {
  const now = Date.now() / 1000;
  if (_agentsCache && now - _agentsCache.time < AGENTS_CACHE_TTL) return _agentsCache.agents;
  const agents = db.select().from(schema.agents).all();
  _agentsCache = { agents, time: now };
  return agents;
}

export function clearAgentsCache() {
  _agentsCache = null;
}
