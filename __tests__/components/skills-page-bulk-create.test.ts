import { describe, it, expect } from 'vitest'
import { partitionSkillsForBulkCreate } from '../../components/SkillsPage'
import type { Skill } from '../../lib/client-api'

function skill(id: string, name: string): Skill {
  return {
    id,
    name,
    description: '',
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as Skill
}

describe('partitionSkillsForBulkCreate', () => {
  it('skips skills whose display name matches an existing agent', () => {
    const skills = [
      skill('agent-ci-monitor', 'agent:ci-monitor'),
      skill('agent-blog', 'agent:blog'),
      skill('custom-1', 'my-skill'),
    ]
    const existing = new Set(['ci-monitor', 'my-skill'])
    const { toCreate, toSkip } = partitionSkillsForBulkCreate(skills, existing)
    expect(toCreate.map(s => s.id)).toEqual(['agent-blog'])
    expect(toSkip.map(s => s.id).sort()).toEqual(['agent-ci-monitor', 'custom-1'])
  })

  it('returns all as toCreate when no existing agents', () => {
    const skills = [skill('a', 'agent:a'), skill('b', 'b')]
    const { toCreate, toSkip } = partitionSkillsForBulkCreate(skills, new Set())
    expect(toCreate).toHaveLength(2)
    expect(toSkip).toHaveLength(0)
  })

  it('strips agent: prefix when comparing against existing names', () => {
    const skills = [skill('agent-security-review', 'agent:security-review')]
    const existing = new Set(['security-review'])
    const { toCreate, toSkip } = partitionSkillsForBulkCreate(skills, existing)
    expect(toCreate).toHaveLength(0)
    expect(toSkip).toHaveLength(1)
  })

  it('does not match when only the prefixed name exists', () => {
    const skills = [skill('agent-blog', 'agent:blog')]
    const existing = new Set(['agent:blog'])
    const { toCreate } = partitionSkillsForBulkCreate(skills, existing)
    expect(toCreate).toHaveLength(1)
  })
})
