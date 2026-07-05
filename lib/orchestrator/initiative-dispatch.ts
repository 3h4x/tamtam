// lib/orchestrator/initiative-dispatch.ts
import type { InitiativeRow, setStatus as SetStatus } from '@/lib/orchestrator/initiatives-store';
import { decayedScore } from '@/lib/orchestrator/initiative-score';
import type { InitiativeRunStartResult } from '@/lib/orchestrator/run-initiative';

const FAILURE_COOLDOWN_MS = 6 * 3600 * 1000;
const QUEUED_RETRY_COOLDOWN_MS = 60 * 1000;

export interface DispatchDeps {
  listQueued: (project: string, nowMs: number) => Promise<InitiativeRow[]>;
  setStatus: typeof SetStatus;
  gatesClear: () => boolean;
  projectBusy: (project: string) => boolean | Promise<boolean>;
  // Opt-in CI-red dispatch gate: when it resolves true, defer initiative
  // dispatch for this project until its default-branch CI goes green. Optional
  // so existing callers/tests that don't wire it default to "never blocked".
  ciRed?: (project: string) => boolean | Promise<boolean>;
  shipsToday: (project: string) => number;
  maxShipsPerDay: number;
  runInitiative: (row: InitiativeRow) => Promise<void | InitiativeRunStartResult>;
  now?: () => number;
}

export interface DispatchResult {
  dispatched: InitiativeRow | null;
  skipped: 'gates' | 'busy' | 'ci-red' | 'ships-cap' | 'empty' | 'queued' | null;
}

export async function dispatchTopInitiative(project: string, deps: DispatchDeps): Promise<DispatchResult> {
  const now = deps.now ?? Date.now;
  const nowMs = now();

  if (!deps.gatesClear()) return { dispatched: null, skipped: 'gates' };
  if (deps.maxShipsPerDay > 0 && deps.shipsToday(project) >= deps.maxShipsPerDay) {
    return { dispatched: null, skipped: 'ships-cap' };
  }
  if (await deps.projectBusy(project)) return { dispatched: null, skipped: 'busy' };

  const queued = await deps.listQueued(project, nowMs);
  if (queued.length === 0) return { dispatched: null, skipped: 'empty' };
  // CI-red gate AFTER the cheap empty-backlog check so its (up-to-8s) `gh`
  // call only fires when there is actually something to dispatch.
  if (deps.ciRed && (await deps.ciRed(project))) return { dispatched: null, skipped: 'ci-red' };

  const top = [...queued].sort((a, b) => {
    const pinDelta = (b.pinnedAt != null ? 1 : 0) - (a.pinnedAt != null ? 1 : 0);
    if (pinDelta !== 0) return pinDelta; // pinned first
    return decayedScore(b) - decayedScore(a);
  })[0];

  await deps.setStatus(top.id, 'running', { bumpAttempts: true }, nowMs);
  try {
    const result = await deps.runInitiative(top);
    if (result?.status === 'queued') {
      await deps.setStatus(top.id, 'queued', { cooldownUntil: nowMs + QUEUED_RETRY_COOLDOWN_MS }, nowMs);
      return { dispatched: null, skipped: 'queued' };
    }
    return { dispatched: top, skipped: null };
  } catch {
    await deps.setStatus(top.id, 'failed', { cooldownUntil: nowMs + FAILURE_COOLDOWN_MS }, nowMs);
    return { dispatched: null, skipped: null };
  }
}
