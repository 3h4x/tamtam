export type AutomationQueueItem = {
  id: string;
  project: string;
  kind: 'pending_release' | 'queued_agent_run';
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

async function parseJsonError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { detail?: string };
  return new Error(body.detail || `HTTP ${response.status}`);
}

export async function fetchAutomationQueue(project?: string): Promise<{ items: AutomationQueueItem[] }> {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`/api/automation-queue${suffix}`);
  if (!response.ok) throw await parseJsonError(response);
  return response.json();
}

export async function retryAutomationQueue(project: string): Promise<RetryAutomationQueueResult> {
  const response = await fetch('/api/automation-queue/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  });
  if (!response.ok) throw await parseJsonError(response);
  return response.json();
}

export async function cancelAutomationQueueItem(item: Pick<AutomationQueueItem, 'kind' | 'project' | 'id'>): Promise<{ status: string }> {
  const response = await fetch('/api/automation-queue/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: item.kind,
      project: item.project,
      id: item.kind === 'queued_agent_run' ? item.id.replace(/^queued_agent_run:/, '') : item.id,
    }),
  });
  if (!response.ok) throw await parseJsonError(response);
  return response.json();
}
