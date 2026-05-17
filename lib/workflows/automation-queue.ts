import { db, schema } from '@/lib/db';
import { listQueuedAgentRunsForProject, listQueuedAgentRunProjects } from '@/lib/agents/queued-agent-runs';
import { deletePendingRelease, getPendingRelease, listPendingReleases } from '@/lib/pipeline/pending-release';
import { drainProjectRecoveryWork } from '@/lib/pipeline/recovery-drain';
import { getLock } from '@/lib/pipeline/pipeline-lock';
import { and, eq } from 'drizzle-orm';

export type AutomationQueueKind = 'pending_release' | 'queued_agent_run';

export type AutomationQueueItem = {
  id: string;
  project: string;
  kind: AutomationQueueKind;
  label: string;
  reason: string;
  code: string;
  queuedAt: number | null;
  blockingJobId: string | null;
  nextRetryState: 'ready' | 'blocked' | 'waiting';
  retryAllowed: boolean;
  cancelAllowed: boolean;
  agentId?: string;
  agentName?: string;
  triggeredBy?: string;
};

export type RetryAutomationQueueResult = {
  status: 'started' | 'stayed_queued' | 'empty';
  items: AutomationQueueItem[];
};

function pendingReleaseId(project: string): string {
  return `pending_release:${project}`;
}

function queuedAgentRunId(id: number): string {
  return `queued_agent_run:${id}`;
}

async function itemState(project: string): Promise<Pick<AutomationQueueItem, 'blockingJobId' | 'nextRetryState' | 'retryAllowed'>> {
  const lock = await getLock(project);
  if (lock) {
    return {
      blockingJobId: lock.lockedByJobId,
      nextRetryState: 'blocked',
      retryAllowed: true,
    };
  }
  return {
    blockingJobId: null,
    nextRetryState: 'ready',
    retryAllowed: true,
  };
}

async function listPendingReleaseItems(projectFilter?: string): Promise<AutomationQueueItem[]> {
  const pending = await listPendingReleases();
  const filtered = projectFilter ? pending.filter((entry) => entry.project === projectFilter) : pending;
  const items: AutomationQueueItem[] = [];
  for (const entry of filtered) {
    const state = await itemState(entry.project);
    items.push({
      id: pendingReleaseId(entry.project),
      project: entry.project,
      kind: 'pending_release',
      label: 'Queued release',
      reason: state.blockingJobId ? 'Release is waiting for the pipeline lock' : 'Release is waiting for recovery drain',
      code: state.blockingJobId ? 'pipeline_lock' : 'pending_release',
      queuedAt: entry.queuedAt,
      cancelAllowed: true,
      ...state,
    });
  }
  return items;
}

async function listQueuedAgentItems(projectFilter?: string): Promise<AutomationQueueItem[]> {
  const projects = projectFilter ? [projectFilter] : await listQueuedAgentRunProjects();
  const items: AutomationQueueItem[] = [];
  for (const project of projects) {
    const [queued, pending, state] = await Promise.all([
      listQueuedAgentRunsForProject(project),
      listPendingReleases(),
      itemState(project),
    ]);
    const hasPendingRelease = pending.some((entry) => entry.project === project);
    for (const entry of queued) {
      items.push({
        id: queuedAgentRunId(entry.id),
        project,
        kind: 'queued_agent_run',
        label: `Queued agent: ${entry.agentName}`,
        reason: hasPendingRelease
          ? 'Agent is waiting behind an older queued release'
          : state.blockingJobId
            ? 'Agent is waiting for the release pipeline lock'
            : 'Agent is ready for recovery drain',
        code: hasPendingRelease ? 'pending_release' : state.blockingJobId ? 'pipeline_lock' : 'queued_agent_run',
        queuedAt: entry.enqueuedAt,
        cancelAllowed: true,
        agentId: entry.agentId,
        agentName: entry.agentName,
        triggeredBy: entry.triggeredBy,
        ...state,
        nextRetryState: hasPendingRelease ? 'waiting' : state.nextRetryState,
      });
    }
  }
  return items;
}

export async function listAutomationQueue(project?: string): Promise<AutomationQueueItem[]> {
  const [pendingReleases, queuedAgents] = await Promise.all([
    listPendingReleaseItems(project),
    listQueuedAgentItems(project),
  ]);
  return [...pendingReleases, ...queuedAgents]
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0) || a.id.localeCompare(b.id));
}

export async function cancelAutomationQueueItem(input: { kind: AutomationQueueKind; project: string; id?: string | number }): Promise<boolean> {
  if (input.kind === 'pending_release') {
    if (!(await getPendingRelease(input.project))) return false;
    await deletePendingRelease(input.project);
    return true;
  }
  const id = typeof input.id === 'number' ? input.id : Number(input.id);
  if (!Number.isInteger(id) || id <= 0) return false;
  const existing = await db
    .select({ id: schema.queuedAgentRuns.id })
    .from(schema.queuedAgentRuns)
    .where(and(eq(schema.queuedAgentRuns.id, id), eq(schema.queuedAgentRuns.project, input.project)))
    .limit(1);
  if (!existing[0]) return false;
  await db
    .delete(schema.queuedAgentRuns)
    .where(and(eq(schema.queuedAgentRuns.id, id), eq(schema.queuedAgentRuns.project, input.project)))
    .execute();
  return true;
}

export async function retryAutomationQueueProject(project: string): Promise<RetryAutomationQueueResult> {
  const before = await listAutomationQueue(project);
  if (before.length === 0) return { status: 'empty', items: [] };
  await drainProjectRecoveryWork(project, '[automation-queue]');
  const after = await listAutomationQueue(project);
  return {
    status: after.length < before.length ? 'started' : 'stayed_queued',
    items: after,
  };
}
