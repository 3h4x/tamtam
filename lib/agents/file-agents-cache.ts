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

// Per-project cache. A project-tab request (`/api/agents?project=X`) only needs
// one project's file agents, but previously reused the all-projects cache —
// every cold miss re-scanned ALL enabled projects' filesystems just to filter
// down to one. Scanning a single project is cheaper, and caching it per project
// (same 10s TTL) keeps the project-tab poll from re-scanning the tree every few
// seconds (synchronous fs work that blocks the event loop on each poll).
declare global {
  var __tamtamFileAgentsByProject: Map<string, { agents: FileAgent[]; time: number }> | undefined;
}

export function getFileAgentsForProjectCached(projectPath: string, projectName: string): FileAgent[] {
  const now = Date.now();
  const cache = (globalThis.__tamtamFileAgentsByProject ??= new Map());
  const hit = cache.get(projectName);
  if (hit && now - hit.time < ALL_FILE_AGENTS_TTL_MS) return hit.agents;
  let agents: FileAgent[];
  try {
    agents = scanFileAgents(projectPath, projectName);
  } catch {
    agents = [];
  }
  cache.set(projectName, { agents, time: now });
  return agents;
}

export function clearFileAgentsCache(): void {
  globalThis.__tamtamAllFileAgentsCache = null;
  globalThis.__tamtamFileAgentsByProject = undefined;
}
