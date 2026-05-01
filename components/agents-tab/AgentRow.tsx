'use client'

import type { Agent, Skill } from '@/lib/client-api'
import { nextFireDisplay } from '@/lib/scheduling/fire-times'

interface AgentRowProps {
  agent: Agent
  skills: Skill[]
  editing: Agent | null
  runSubmitting: string | null
  runPromptAgent: string | null
  runPrompt: string
  agentRunsBlocked: boolean
  blockedReason: string
  lastRunAgo?: string | null
  lastRunFailed?: boolean
  onEdit: (agent: Agent) => void
  onToggleEnabled: (agent: Agent) => void
  onRun: (agent: Agent, customPrompt?: string) => void
  onToggleRunPrompt: (agentId: string) => void
  onRunPromptChange: (value: string) => void
}

export function AgentRow({
  agent,
  skills,
  editing,
  runSubmitting,
  runPromptAgent,
  runPrompt,
  agentRunsBlocked,
  blockedReason,
  lastRunAgo,
  lastRunFailed,
  onEdit,
  onToggleEnabled,
  onRun,
  onToggleRunPrompt,
  onRunPromptChange,
}: AgentRowProps) {
  const agentSkills = skills.filter(s => agent.skillIds.includes(s.id))

  return (
    <div
      className={`px-3 py-2.5 rounded-lg border transition-colors ${
        editing?.id === agent.id
          ? 'border-accent bg-accent-light'
          : 'border-border bg-bg-secondary'
      } ${!agent.enabled ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-medium text-sm text-text-primary">{agent.name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-secondary">{agent.model}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-secondary">{agent.runner}</span>
          {agent.schedule && (
            <>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${agent.enabled ? 'bg-status-success/10 text-status-success' : 'bg-bg-tertiary text-text-tertiary line-through'}`}>every {agent.schedule}</span>
              {agent.enabled && nextFireDisplay(agent.schedule, agent.id) && (
                <span className="text-[10px] text-text-tertiary font-mono">{nextFireDisplay(agent.schedule, agent.id)}</span>
              )}
            </>
          )}
          {agentSkills.map(s => (
            <span key={s.id} className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">{s.name}</span>
          ))}
          {agent.source === 'file' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary border border-border" title=".tamtam/agents/">file</span>
          )}
          {lastRunAgo && (
            <span
              className={`text-[10px] font-mono ${lastRunFailed ? 'text-status-error/70' : 'text-text-tertiary/70'}`}
              title={lastRunFailed ? `Last run failed · ${lastRunAgo}` : `Last ran ${lastRunAgo}`}
            >
              {lastRunFailed ? `✗ ${lastRunAgo}` : lastRunAgo}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {agent.schedule && (
            <button
              className={`px-2 py-1 text-xs border rounded-md cursor-pointer ${
                agent.enabled
                  ? 'border-status-success/30 text-status-success hover:bg-status-success/10'
                  : 'border-status-error/30 text-status-error hover:bg-status-error/10'
              }`}
              onClick={() => onToggleEnabled(agent)}
              title={agent.enabled ? 'Disable scheduled runs' : 'Enable scheduled runs'}
            >
              {agent.enabled ? 'On' : 'Off'}
            </button>
          )}
          <button
            className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
            onClick={() => onEdit(agent)}
          >
            Edit
          </button>
          <button
            className="px-2 py-1 text-xs bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => onRun(agent)}
            disabled={runSubmitting === agent.id || agentRunsBlocked}
            title={agentRunsBlocked ? blockedReason : undefined}
          >
            {runSubmitting === agent.id ? 'Starting…' : 'Run'}
          </button>
          <button
            className="px-2 py-1 text-xs border border-accent text-accent rounded-md hover:bg-accent/10 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => onToggleRunPrompt(agent.id)}
            disabled={agentRunsBlocked}
            title={agentRunsBlocked ? blockedReason : `Run ${agent.name} with a custom prompt`}
          >
            + prompt
          </button>
        </div>
      </div>

      {/* Custom prompt input */}
      {runPromptAgent === agent.id && (
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            className="flex-1 px-2.5 py-1.5 text-xs bg-bg-tertiary border border-border rounded-md text-text-primary font-mono"
            value={runPrompt}
            onChange={(e) => onRunPromptChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && runPrompt.trim()) onRun(agent, runPrompt.trim()) }}
            placeholder="e.g. write tests for the streaming endpoint"
            autoFocus
          />
          <button
            className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
            onClick={() => onRun(agent, runPrompt.trim())}
            disabled={!runPrompt.trim() || runSubmitting === agent.id || agentRunsBlocked}
            title={agentRunsBlocked ? blockedReason : undefined}
          >
            Go
          </button>
        </div>
      )}
    </div>
  )
}
