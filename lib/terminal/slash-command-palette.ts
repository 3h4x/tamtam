import type { Agent, CustomAction, GhIssue } from '@/lib/client-api'
import type { SkillItem, DocItem } from '@/lib/terminal/terminal-session-store'

export type SlashCommandKind = 'skill' | 'doc' | 'agent' | 'action' | 'builtin'

export interface SlashCommand {
  id: string
  kind: SlashCommandKind
  command: string
  title: string
  detail: string
  insertText?: string
}

export interface SlashCommandCatalog {
  skills: SkillItem[]
  docs: DocItem[]
  agents: Pick<Agent, 'id' | 'name' | 'model' | 'source'>[]
  customActions: Pick<CustomAction, 'name' | 'command'>[]
}

export interface SuggestedPrompt {
  id: string
  title: string
  prompt: string
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    id: 'builtin:release',
    kind: 'builtin',
    command: '/release',
    title: 'Release',
    detail: 'start the release pipeline',
  },
  {
    id: 'builtin:test',
    kind: 'builtin',
    command: '/test',
    title: 'Run tests',
    detail: 'start the project test job',
  },
  {
    id: 'builtin:changes',
    kind: 'builtin',
    command: '/changes',
    title: 'Review changes',
    detail: 'ask for a working tree summary',
    insertText: 'Summarize the current working tree changes and call out risks.',
  },
  {
    id: 'builtin:clear',
    kind: 'builtin',
    command: '/clear',
    title: 'Clear',
    detail: 'start a fresh terminal session',
  },
]

function matchesQuery(command: SlashCommand, query: string): boolean {
  if (!query) return true
  const haystack = `${command.command} ${command.title} ${command.detail}`.toLowerCase()
  return haystack.includes(query.toLowerCase())
}

export function resolveSlashCommands(catalog: SlashCommandCatalog, query: string, limit = 10): SlashCommand[] {
  const commands: SlashCommand[] = [
    ...BUILTIN_COMMANDS,
    ...catalog.skills.map((skill) => ({
      id: `skill:${skill.id}`,
      kind: 'skill' as const,
      command: `/skill ${skill.name}`,
      title: skill.name,
      detail: skill.description || (skill.source === 'file' ? 'file skill' : 'db skill'),
    })),
    ...catalog.docs.map((doc) => ({
      id: `doc:${doc.name}`,
      kind: 'doc' as const,
      command: `/docs ${doc.name}`,
      title: doc.name,
      detail: 'attach project doc',
    })),
    ...catalog.agents.map((agent) => ({
      id: `agent:${agent.id}`,
      kind: 'agent' as const,
      command: `/agent ${agent.name}`,
      title: agent.name,
      detail: `agent${agent.model ? ` · ${agent.model}` : ''}`,
      insertText: `Run the ${agent.name} agent for this project and summarize the result.`,
    })),
    ...catalog.customActions.map((action) => ({
      id: `action:${action.name}`,
      kind: 'action' as const,
      command: `/action ${action.name}`,
      title: action.name,
      detail: action.command,
    })),
  ]

  return commands.filter((command) => matchesQuery(command, query)).slice(0, limit)
}

export function suggestedPromptsFromIssues(issues: Pick<GhIssue, 'number' | 'title'>[], limit = 4): SuggestedPrompt[] {
  const issuePrompts = issues.slice(0, limit).map((issue) => ({
    id: `issue:${issue.number}`,
    title: `Fix #${issue.number}`,
    prompt: `Fix #${issue.number} — ${issue.title}`,
  }))
  const fallback: SuggestedPrompt[] = [
    {
      id: 'changes',
      title: 'Review changes',
      prompt: 'Summarize the current working tree changes and call out risks.',
    },
    {
      id: 'tests',
      title: 'Run tests',
      prompt: 'Run the project test command and fix any failures.',
    },
    {
      id: 'release',
      title: 'Prepare release',
      prompt: 'Check whether this project is ready to release and list any blockers.',
    },
  ]
  return [...issuePrompts, ...fallback].slice(0, Math.max(3, limit))
}
