import { mineCandidates, type ProbeResults } from '@/lib/orchestrator/initiative-miner';
import * as store from '@/lib/orchestrator/initiatives-store';

export async function admitProject(
  project: string, results: ProbeResults, maxBacklog: number, nowMs: number = Date.now(),
): Promise<void> {
  const candidates = mineCandidates(results);
  for (const c of candidates) {
    await store.upsertCandidate(c, nowMs);
  }
  const queued = await store.listByStatus(project, 'queued');
  let room = Math.max(0, maxBacklog - queued.length);
  if (room === 0) return;
  const proposed = (await store.listByStatus(project, 'proposed'))
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const row of proposed) {
    if (room === 0) break;
    await store.setStatus(row.id, 'queued', undefined, nowMs);
    room--;
  }
}
