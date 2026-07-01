import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { canonicalAgentNameKey } from '@/lib/agents/agent-name';

export interface AgentNameConflict {
  kind: 'db';
  name: string;
  agentId?: string;
}

export async function findAgentNameConflict(
  project: string,
  name: string,
  options: {
    excludeDbAgentId?: string;
  } = {},
): Promise<AgentNameConflict | null> {
  const targetKey = canonicalAgentNameKey(name);

  const dbAgents = await db.select().from(schema.agents).where(eq(schema.agents.project, project));
  for (const agent of dbAgents) {
    if (options.excludeDbAgentId && agent.id === options.excludeDbAgentId) continue;
    if (canonicalAgentNameKey(agent.name) === targetKey) {
      return { kind: 'db', name: agent.name, agentId: agent.id };
    }
  }

  return null;
}
