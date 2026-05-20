import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { canonicalAgentNameKey } from '@/lib/agents/agent-name';
import { scanFileAgents } from '@/lib/agents/tamtam-file-agents';
import { resolveProjectPath } from '@/lib/shared/project-data';

export interface AgentNameConflict {
  kind: 'db' | 'file';
  name: string;
  agentId?: string;
}

export async function findAgentNameConflict(
  project: string,
  name: string,
  options: {
    excludeDbAgentId?: string;
    excludeFileAgentName?: string;
    projectPath?: string | null;
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

  const projectPath = options.projectPath ?? resolveProjectPath(project);
  if (!projectPath) return null;

  for (const agent of scanFileAgents(projectPath, project)) {
    if (options.excludeFileAgentName && canonicalAgentNameKey(agent.name) === canonicalAgentNameKey(options.excludeFileAgentName)) {
      continue;
    }
    if (canonicalAgentNameKey(agent.name) === targetKey) {
      return { kind: 'file', name: agent.name, agentId: agent.id };
    }
  }

  return null;
}
