import { describe, expect, it } from 'vitest'
import { isBuiltInRecommendedAgent, RECOMMENDED_AGENTS } from '@/lib/agents/recommended-agents'

describe('RECOMMENDED_AGENTS', () => {
  it('uses unique names case-insensitively', () => {
    const names = RECOMMENDED_AGENTS.map(agent => agent.name.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps the renamed test agent addressable by its legacy name', () => {
    const agent = RECOMMENDED_AGENTS.find(entry => entry.name === 'test-add')
    expect(agent).toMatchObject({
      aliases: ['tests'],
      skillIds: ['agent-tests'],
    })
    expect(isBuiltInRecommendedAgent('test-add')).toBe(true)
    expect(isBuiltInRecommendedAgent('tests')).toBe(true)
  })

  it('keeps issue-cruncher as a featured manual-only template', () => {
    const agent = RECOMMENDED_AGENTS.find(entry => entry.name === 'issue-cruncher')
    expect(agent).toMatchObject({
      model: 'normal',
      schedule: '',

      featured: true,
      skillIds: ['agent-issue-cruncher'],
    })
    expect(agent?.description).toMatch(/closes stale or unverifiable issues by default/i)
    expect(agent?.description).toMatch(/needs-info only for recently active authors/i)
    expect(agent?.description).not.toMatch(/needs-info instead of guessing/i)
  })

  it('marks docs-claude as essential', () => {
    const agent = RECOMMENDED_AGENTS.find(entry => entry.name === 'docs-claude')
    expect(agent?.essential).toBe(true)
  })

  it('keeps qa as a featured scheduled template backed by agent-qa', () => {
    const agent = RECOMMENDED_AGENTS.find(entry => entry.name === 'qa')
    expect(agent).toMatchObject({
      model: 'normal',
      schedule: '24h',

      featured: true,
      skillIds: ['agent-qa'],
    })
    expect(agent?.description).toMatch(/fixes 1-2 small safe issues/i)
    expect(agent?.description).toMatch(/reports the rest/i)
    expect(agent?.description).not.toMatch(/cto|hand.?off|GitHub issue/i)
  })

  it('keeps refactor-split as a featured scheduled template backed by agent-refactor-split', () => {
    const agent = RECOMMENDED_AGENTS.find(entry => entry.name === 'refactor-split')
    expect(agent).toMatchObject({
      model: 'smart',
      schedule: '48h',
      featured: true,
      fallbackEnabled: true,
      skillIds: ['agent-refactor-split'],
    })
    expect(isBuiltInRecommendedAgent('refactor-split')).toBe(true)
    expect(agent?.description).toMatch(/F6 oversized-file flags/i)
  })
})
