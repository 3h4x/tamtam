import type { Agent } from './types'

export type RunAgentResult =
  | { status: 'started'; job_id: string; pid: number; agent?: string; via?: 'workflow' | 'system' }
  | { status: 'queued'; detail?: string; agent?: string; blockingJobId?: string; code?: string }

export interface FetchAgentsOptions {
  /**
   * `summary` returns only the fields a list view renders (id, name, project,
   * schedule, enabled, model, provider, source, kind). Drops prompt /
   * prerequisiteCommand / skillIds / docPaths so polling stays cheap.
   */
  fields?: 'summary'
}

export async function fetchAgents(
  project?: string,
  opts: FetchAgentsOptions = {},
): Promise<{ agents: Agent[] }> {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  if (opts.fields === 'summary') params.set('fields', 'summary')
  const qs = params.toString()
  const url = qs ? `/api/agents?${qs}` : '/api/agents'
  const response = await fetch(url)
  if (!response.ok) return { agents: [] }
  const data = await response.json()
  return { agents: data.agents }
}

export async function createAgent(agent: { name: string; project: string; skillIds: string[]; docPaths?: string[]; model: string; prompt?: string; schedule?: string | null; enabled?: boolean; provider?: string | null; prerequisiteCommand?: string | null }): Promise<{ agent: Agent }> {
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

export async function updateAgent(agentId: string, updates: Partial<{ name: string; skillIds: string[]; docPaths: string[]; model: string; prompt: string; schedule: string | null; enabled: boolean; provider: string | null; prerequisiteCommand: string | null }>): Promise<{ agent: Agent }> {
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

export interface ImprovePromptInput {
  project: string
  draftPrompt: string
  skillIds: string[]
  docPaths: string[]
}

export async function improveAgentPrompt(input: ImprovePromptInput): Promise<{ improvedPrompt: string }> {
  const response = await fetch('/api/agents/improve-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to improve prompt')
  }
  return response.json()
}

export async function runAgent(agentId: string, prompt: string, opts?: { readOnly?: boolean }): Promise<RunAgentResult> {
  const response = await fetch(`/api/agents/${agentId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, readOnly: opts?.readOnly === true }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to run agent')
  }
  return response.json()
}
