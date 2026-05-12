import { describe, it, expect } from 'vitest'
import { buildSkillListItems, partitionSkillItemsForBulkCreate } from '@/components/skills-page/skill-items'
import type { Persona, Skill } from '@/lib/client-api'

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

function persona(path: string, name: string): Persona {
  return {
    path,
    category: path.split('/')[0] || 'custom',
    name,
    description: '',
    emoji: '',
  }
}

describe('partitionSkillItemsForBulkCreate', () => {
  it('skips items whose agent name matches an existing agent', () => {
    const skills = [
      skill('agent-ci-monitor', 'agent:ci-monitor'),
      skill('agent-blog', 'agent:blog'),
      skill('custom-1', 'my-skill'),
    ]
    const personas = [
      persona('engineering/code-reviewer', 'Code Reviewer'),
      persona('custom/project-writer', 'Project Writer'),
    ]
    const { dbAgentItems, dbCustomItems, personaItems } = buildSkillListItems(skills, personas)
    const items = [...dbAgentItems, ...dbCustomItems, ...personaItems]
    const existing = new Set(['ci-monitor', 'my-skill'])
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate(items, existing)
    expect(toCreate.map(s => s.id)).toEqual(['agent-blog', 'persona:engineering/code-reviewer', 'persona:custom/project-writer'])
    expect(toSkip.map(s => s.id).sort()).toEqual(['agent-ci-monitor', 'custom-1'])
  })

  it('returns all as toCreate when no existing agents', () => {
    const { dbAgentItems, dbCustomItems, personaItems } = buildSkillListItems(
      [skill('agent-a', 'agent:a'), skill('b', 'b')],
      [persona('engineering/reviewer', 'Reviewer')],
    )
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate([...dbAgentItems, ...dbCustomItems, ...personaItems], new Set())
    expect(toCreate).toHaveLength(3)
    expect(toCreate.map(item => item.id)).toContain('persona:engineering/reviewer')
    expect(toSkip).toHaveLength(0)
  })

  it('strips agent: prefix when comparing against existing names', () => {
    const { dbAgentItems } = buildSkillListItems([skill('agent-security-review', 'agent:security-review')], [])
    const existing = new Set(['security-review'])
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate(dbAgentItems, existing)
    expect(toCreate).toHaveLength(0)
    expect(toSkip).toHaveLength(1)
  })

  it('does not match when only the prefixed name exists', () => {
    const { dbAgentItems } = buildSkillListItems([skill('agent-blog', 'agent:blog')], [])
    const existing = new Set(['agent:blog'])
    const { toCreate } = partitionSkillItemsForBulkCreate(dbAgentItems, existing)
    expect(toCreate).toHaveLength(1)
  })

  it('skips persona items by persona name', () => {
    const { personaItems } = buildSkillListItems([], [persona('engineering/code-reviewer', 'Code Reviewer')])
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate(personaItems, new Set(['Code Reviewer']))
    expect(toCreate).toHaveLength(0)
    expect(toSkip.map(item => item.id)).toEqual(['persona:engineering/code-reviewer'])
  })

  it('skips duplicate names inside the same selected batch', () => {
    const { dbAgentItems, personaItems } = buildSkillListItems(
      [skill('agent-review', 'agent:review')],
      [persona('engineering/reviewer', 'review')],
    )
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate([...dbAgentItems, ...personaItems], new Set())
    expect(toCreate).toHaveLength(1)
    expect(toSkip).toHaveLength(1)
    expect(toSkip[0].id).toBe('persona:engineering/reviewer')
  })

  it('compares existing names using the canonical trimmed form', () => {
    const { dbAgentItems } = buildSkillListItems([skill('agent-blog', 'agent:blog')], [])
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate(dbAgentItems, new Set([' blog ']))
    expect(toCreate).toHaveLength(0)
    expect(toSkip).toHaveLength(1)
  })

  it('compares existing names case-insensitively', () => {
    const { dbAgentItems } = buildSkillListItems([skill('agent-blog', 'agent:Blog')], [])
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate(dbAgentItems, new Set(['blog']))
    expect(toCreate).toHaveLength(0)
    expect(toSkip).toHaveLength(1)
  })

  it('returns empty arrays when item list is empty', () => {
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate([], new Set(['foo', 'bar']))
    expect(toCreate).toHaveLength(0)
    expect(toSkip).toHaveLength(0)
  })

  it('only skips items whose names match existing agents', () => {
    const { dbAgentItems, personaItems } = buildSkillListItems(
      [skill('agent-cto', 'agent:cto'), skill('agent-blog', 'agent:blog')],
      [persona('leadership/cfo', 'CFO')],
    )
    const existing = new Set(['cto', 'blog'])
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate([...dbAgentItems, ...personaItems], existing)
    expect(toCreate).toHaveLength(1)
    expect(toCreate[0].id).toBe('persona:leadership/cfo')
    expect(toSkip).toHaveLength(2)
  })

  it('puts all DB and persona items in toSkip when all names match existing agents', () => {
    const { dbAgentItems, personaItems } = buildSkillListItems(
      [skill('agent-cto', 'agent:cto'), skill('agent-blog', 'agent:blog')],
      [persona('leadership/cfo', 'CFO')],
    )
    const existing = new Set(['cto', 'blog', 'CFO'])
    const { toCreate, toSkip } = partitionSkillItemsForBulkCreate([...dbAgentItems, ...personaItems], existing)
    expect(toCreate).toHaveLength(0)
    expect(toSkip).toHaveLength(3)
  })
})
