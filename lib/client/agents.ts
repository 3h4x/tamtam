import type { Agent } from './types'

export type RunAgentResult =
  | { status: 'started'; job_id: string; pid: number; agent?: string }
  | { status: 'queued'; detail?: string; agent?: string; blockingJobId?: string; code?: string }

export async function fetchAgents(project?: string): Promise<{ agents: Agent[] }> {
  const url = project ? `/api/agents?project=${encodeURIComponent(project)}` : '/api/agents'
  const response = await fetch(url)
  if (!response.ok) return { agents: [] }
  const data = await response.json()
  return { agents: data.agents }
}

export async function createAgent(agent: { name: string; project: string; skillIds: string[]; docPaths?: string[]; model: string; prompt?: string; schedule?: string | null; runner?: string; enabled?: boolean; prerequisiteCommand?: string | null }): Promise<{ agent: Agent }> {
  const response = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to create agent')
  }
  return response.json()
}

export async function updateAgent(agentId: string, updates: Partial<{ name: string; skillIds: string[]; docPaths: string[]; model: string; prompt: string; schedule: string | null; runner: string; enabled: boolean; prerequisiteCommand: string | null }>): Promise<{ agent: Agent }> {
  const response = await fetch(`/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to update agent')
  }
  return response.json()
}

export async function deleteAgent(agentId: string): Promise<void> {
  const response = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('Failed to delete agent')
}

export async function runAgent(agentId: string, prompt: string): Promise<RunAgentResult> {
  const response = await fetch(`/api/agents/${agentId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to run agent')
  }
  return response.json()
}
