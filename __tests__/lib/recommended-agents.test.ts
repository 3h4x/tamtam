import { describe, expect, it } from 'vitest'
import { RECOMMENDED_AGENTS } from '@/lib/agents/recommended-agents'

describe('RECOMMENDED_AGENTS', () => {
  it('uses unique names case-insensitively', () => {
    const names = RECOMMENDED_AGENTS.map(agent => agent.name.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps issue-cruncher as a featured manual-only template', () => {
    const agent = RECOMMENDED_AGENTS.find(entry => entry.name === 'issue-cruncher')
    expect(agent).toMatchObject({
      model: 'normal',
      schedule: '',
      runner: 'pm2',
      featured: true,
      skillIds: ['agent-issue-cruncher'],
    })
  })

  it('marks docs-claude as essential', () => {
    const agent = RECOMMENDED_AGENTS.find(entry => entry.name === 'docs-claude')
    expect(agent?.essential).toBe(true)
  })
})
