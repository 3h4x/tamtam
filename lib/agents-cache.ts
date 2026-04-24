import { db, schema } from '@/lib/db';

const AGENTS_CACHE_TTL = 10; // seconds
let _agentsCache: { agents: typeof schema.agents.$inferSelect[]; time: number } | null = null;

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
