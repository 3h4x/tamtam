import type { Skill } from './types'

export async function fetchSkills(): Promise<{ skills: Skill[] }> {
  const response = await fetch('/api/skills')
  if (!response.ok) return { skills: [] }
  return response.json()
}

export async function createSkill(skill: { name: string; description: string; content: string }): Promise<{ skill: Skill }> {
  const response = await fetch('/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(skill),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to create skill')
  }
  return response.json()
}

export async function updateSkill(skillId: string, updates: Partial<{ name: string; description: string; content: string }>): Promise<{ skill: Skill }> {
  const response = await fetch(`/api/skills/${skillId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to update skill')
  }
  return response.json()
}

export async function deleteSkill(skillId: string): Promise<void> {
  const response = await fetch(`/api/skills/${skillId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('Failed to delete skill')
}
