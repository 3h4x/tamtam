import type { Persona, Skill } from '@/lib/client-api'
import { canonicalAgentNameKey } from '@/lib/agents/agent-name'

export type SkillListItem =
  | { id: string; name: string; description: string; category: 'agents'; source: 'db'; skill: Skill }
  | { id: string; name: string; description: string; category: 'custom'; source: 'db'; skill: Skill }
  | { id: string; name: string; description: string; category: string; source: 'file'; persona: Persona }

export function isRecommendedSkill(skill: Skill) {
  return skill.id.startsWith('agent-')
}

export function displaySkillName(skill: Skill) {
  return skill.name.startsWith('agent:') ? skill.name.slice('agent:'.length) : skill.name
}

export function categoryLabel(category: string) {
  return category.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function itemSearchText(item: SkillListItem) {
  return `${item.name} ${item.description} ${item.category} ${item.id}`.toLowerCase()
}

export function toAgentName(item: SkillListItem) {
  return item.source === 'db' ? displaySkillName(item.skill) : item.name
}

export function buildSkillListItems(skills: Skill[], personas: Persona[]) {
  const dbAgentItems: SkillListItem[] = skills
    .filter(isRecommendedSkill)
    .map(skill => ({ id: skill.id, name: displaySkillName(skill), description: skill.description, category: 'agents', source: 'db' as const, skill }))
  const dbCustomItems: SkillListItem[] = skills
    .filter(s => !isRecommendedSkill(s))
    .map(skill => ({ id: skill.id, name: displaySkillName(skill), description: skill.description, category: 'custom', source: 'db' as const, skill }))
  const personaItems: SkillListItem[] = personas.map(persona => ({
    id: `persona:${persona.path}`,
    name: persona.name,
    description: persona.description,
    category: persona.category,
    source: 'file' as const,
    persona,
  }))

  return { dbAgentItems, dbCustomItems, personaItems }
}

export function partitionSkillItemsForBulkCreate(
  items: SkillListItem[],
  existingAgentNames: Set<string>,
): { toCreate: SkillListItem[]; toSkip: SkillListItem[] } {
  const toCreate: SkillListItem[] = []
  const toSkip: SkillListItem[] = []
  const seenNames = new Set(Array.from(existingAgentNames, canonicalAgentNameKey))
  for (const item of items) {
    const canonicalName = canonicalAgentNameKey(toAgentName(item))
    if (seenNames.has(canonicalName)) {
      toSkip.push(item)
      continue
    }
    seenNames.add(canonicalName)
    toCreate.push(item)
  }
  return { toCreate, toSkip }
}
