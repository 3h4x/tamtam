// Per-project last-mine timestamps. On globalThis because Next.js duplicates
// module realms (same rationale as the other __tamtam* singletons — see
// CLAUDE.md). In-memory only: a restart just gives every project a fresh mine,
// which is safe.
declare global {
  var __tamtamInitiativeLastMine: Map<string, number> | undefined;
}

export function getLastMineMap(): Map<string, number> {
  if (!globalThis.__tamtamInitiativeLastMine) {
    globalThis.__tamtamInitiativeLastMine = new Map<string, number>();
  }
  return globalThis.__tamtamInitiativeLastMine;
}

export function shouldMineProject(
  project: string, nowMs: number, lastMineByProject: Map<string, number>, intervalMs: number,
): boolean {
  const last = lastMineByProject.get(project);
  if (last == null) return true;
  return nowMs - last >= intervalMs;
}

export function markProjectMined(project: string, nowMs: number, lastMineByProject: Map<string, number>): void {
  lastMineByProject.set(project, nowMs);
}
