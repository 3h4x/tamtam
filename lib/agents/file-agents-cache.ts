import { listEnabledProjects } from '@/lib/shared/enabled-projects';
import { scanFileAgents, type FileAgent } from '@/lib/agents/tamtam-file-agents';

const ALL_FILE_AGENTS_TTL_MS = 10_000;

// Pin to globalThis: Next.js can duplicate modules across route bundle realms,
// so a module-level TTL cache would fragment into multiple per-realm copies.
declare global {
  var __tamtamAllFileAgentsCache: { agents: FileAgent[]; time: number } | null | undefined;
}

export function getAllFileAgentsCached(): FileAgent[] {
  const now = Date.now();
  const cached = globalThis.__tamtamAllFileAgentsCache;
  if (cached && now - cached.time < ALL_FILE_AGENTS_TTL_MS) {
    return cached.agents;
  }
  const out: FileAgent[] = [];
  for (const p of listEnabledProjects()) {
    try {
      for (const fa of scanFileAgents(p.path, p.name)) out.push(fa);
    } catch {
      // Ignore one broken project scan; list the rest.
    }
  }
  globalThis.__tamtamAllFileAgentsCache = { agents: out, time: now };
  return out;
}

export function clearFileAgentsCache(): void {
  globalThis.__tamtamAllFileAgentsCache = null;
}
