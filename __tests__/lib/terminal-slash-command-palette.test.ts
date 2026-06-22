import { describe, expect, it } from 'vitest'
import { resolveSlashCommands, suggestedPromptsFromIssues } from '@/lib/terminal/slash-command-palette'

describe('terminal slash command palette', () => {
  it('resolves builtins, skills, docs, agents, and custom actions', () => {
    const commands = resolveSlashCommands({
      skills: [{ id: 'reviewer', name: 'reviewer', description: 'review code', source: 'db' }],
      docs: [{ name: 'README.md', content: '# readme' }],
      agents: [{ id: 'qa', name: 'QA', model: 'smart', source: 'file' }],
      customActions: [{ name: 'Deploy', command: 'pnpm deploy' }],
    }, '')

    expect(commands.map((command) => command.id)).toEqual(expect.arrayContaining([
      'builtin:release',
      'skill:reviewer',
      'doc:README.md',
      'agent:qa',
      'action:Deploy',
    ]))
  })

  it('filters commands by typed query', () => {
    const commands = resolveSlashCommands({
      skills: [{ id: 'security', name: 'security', description: 'audit auth', source: 'db' }],
      docs: [{ name: 'README.md', content: '' }],
      agents: [],
      customActions: [],
    }, 'readme')

    expect(commands).toHaveLength(1)
    expect(commands[0].id).toBe('doc:README.md')
  })

  it('derives suggested prompts from open issues with fallbacks', () => {
    const prompts = suggestedPromptsFromIssues([
      { number: 48, title: 'Make Terminal feel like a real chat' },
    ])

    expect(prompts[0]).toEqual({
      id: 'issue:48',
      title: 'Fix #48',
      prompt: 'Fix #48 — Make Terminal feel like a real chat',
    })
    expect(prompts.length).toBeGreaterThanOrEqual(3)
  })
})
