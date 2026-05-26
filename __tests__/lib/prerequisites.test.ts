import { describe, expect, it } from 'vitest'
import {
  IMPROVE_SKILL_ID,
  ISSUE_CRUNCHER_SKILL_ID,
  buildImprovePrerequisiteCommand,
  buildIssueCruncherPrerequisiteCommand,
  hasImproveSkill,
  hasIssueCruncherSkill,
  normalizeStoredPrerequisiteCommand,
  parsePrerequisiteCommandInput,
  resolveAgentPrerequisiteCommand,
} from '@/lib/agents/prerequisites'

describe('prerequisite helpers', () => {
  it('detects whether the issue-cruncher skill is enabled', () => {
    expect(hasIssueCruncherSkill([ISSUE_CRUNCHER_SKILL_ID])).toBe(true)
    expect(hasIssueCruncherSkill(['other-skill'])).toBe(false)
    expect(hasIssueCruncherSkill(null)).toBe(false)
    expect(hasIssueCruncherSkill(undefined)).toBe(false)
  })

  it('normalizes stored prerequisite commands without re-injecting cleared values', () => {
    expect(normalizeStoredPrerequisiteCommand(undefined)).toBeUndefined()
    expect(normalizeStoredPrerequisiteCommand(null)).toBeNull()
    expect(normalizeStoredPrerequisiteCommand('  pnpm test  ')).toBe('pnpm test')
    expect(normalizeStoredPrerequisiteCommand('   ')).toBe('')
  })

  it('parses user input into an optional prerequisite command string', () => {
    expect(parsePrerequisiteCommandInput(undefined)).toBeUndefined()
    expect(parsePrerequisiteCommandInput('  pnpm lint  ')).toBe('pnpm lint')
    expect(parsePrerequisiteCommandInput('   ')).toBe('')
    expect(parsePrerequisiteCommandInput(42)).toBe('')
  })

  it('builds the pick-top issues endpoint with URL-encoded project names', () => {
    expect(buildIssueCruncherPrerequisiteCommand('repo name/with space')).toBe(
      'curl -fsS "http://localhost:1337/api/projects/by-project/repo%20name%2Fwith%20space/issues?pick_top=1"',
    )
  })

  it('resolves stored prerequisites before considering the issue-cruncher default', () => {
    expect(resolveAgentPrerequisiteCommand({
      project: 'proj',
      skillIds: [ISSUE_CRUNCHER_SKILL_ID],
      prerequisiteCommand: '  pnpm test  ',
    })).toBe('pnpm test')

    expect(resolveAgentPrerequisiteCommand({
      project: 'proj',
      skillIds: [ISSUE_CRUNCHER_SKILL_ID],
      prerequisiteCommand: '   ',
    })).toBeNull()
  })

  it('injects the default trusted issues fetch only for issue-cruncher agents', () => {
    expect(resolveAgentPrerequisiteCommand({
      project: 'proj',
      skillIds: [ISSUE_CRUNCHER_SKILL_ID],
      prerequisiteCommand: undefined,
    })).toBe(buildIssueCruncherPrerequisiteCommand('proj'))

    expect(resolveAgentPrerequisiteCommand({
      project: 'proj',
      skillIds: ['other-skill'],
      prerequisiteCommand: undefined,
    })).toBeNull()
  })

  it('detects whether the improve skill is enabled', () => {
    expect(hasImproveSkill([IMPROVE_SKILL_ID])).toBe(true)
    expect(hasImproveSkill(['other-skill'])).toBe(false)
    expect(hasImproveSkill(null)).toBe(false)
  })

  it('builds the improve prereq with project-source dirs and .tamtam excluded', () => {
    const cmd = buildImprovePrerequisiteCommand()
    expect(cmd).toMatch(/find app components lib hooks scripts docs/)
    expect(cmd).toMatch(/-not -path '\*\/\.tamtam\/\*'/)
    expect(cmd).toMatch(/-not -path '\*\/node_modules\/\*'/)
    expect(cmd).toMatch(/-not -name '\*\.d\.ts'/)
    expect(cmd).toMatch(/\\\( -name '\*\.ts'/)
    expect(cmd).toMatch(/sort \| head -5/)
    expect(cmd).toMatch(/\.tamtam\/cache\/audits\/improve\.md/)
  })

  it('auto-attaches improve prereq when the agent has the improve skill and no stored command', () => {
    expect(resolveAgentPrerequisiteCommand({
      project: 'proj',
      skillIds: [IMPROVE_SKILL_ID],
      prerequisiteCommand: undefined,
    })).toBe(buildImprovePrerequisiteCommand())
  })

  it('prefers a stored prerequisite over both defaults', () => {
    expect(resolveAgentPrerequisiteCommand({
      project: 'proj',
      skillIds: [IMPROVE_SKILL_ID],
      prerequisiteCommand: 'echo hi',
    })).toBe('echo hi')
  })

  it('issue-cruncher takes precedence when an agent somehow has both skills', () => {
    expect(resolveAgentPrerequisiteCommand({
      project: 'proj',
      skillIds: [ISSUE_CRUNCHER_SKILL_ID, IMPROVE_SKILL_ID],
      prerequisiteCommand: undefined,
    })).toBe(buildIssueCruncherPrerequisiteCommand('proj'))
  })
})
