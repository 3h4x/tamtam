import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  IMPROVE_SKILL_ID,
  ISSUE_CRUNCHER_SKILL_ID,
  QA_SKILL_ID,
  buildImprovePrerequisiteCommand,
  buildIssueCruncherPrerequisiteCommand,
  buildQaPrerequisiteCommand,
  hasImproveSkill,
  hasIssueCruncherSkill,
  normalizeStoredPrerequisiteCommand,
  parsePrerequisiteCommandInput,
  resolveAgentPrerequisiteCommand,
  substitutePrerequisiteProjectPlaceholder,
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
    // null preserves "inherit the default" — it must NOT collapse to ''.
    // Coercing null→'' persisted an explicit empty override that dirtied the
    // committed .md frontmatter and suppressed the skill's default prereq when
    // an unrelated field (e.g. permission mode) was edited.
    expect(parsePrerequisiteCommandInput(null)).toBeNull()
  })

  it('substitutes the URL-encoded project placeholder in default prerequisites', () => {
    expect(substitutePrerequisiteProjectPlaceholder('echo {{project}}', 'repo name/with space')).toBe(
      'echo repo%20name%2Fwith%20space',
    )

    expect(resolveAgentPrerequisiteCommand({
      project: 'repo name/with space',
      skillIds: ['agent-custom'],
      prerequisiteCommand: undefined,
      defaultPrerequisiteCommand: 'curl "http://localhost:1337/api/projects/by-project/{{project}}/config"',
    })).toBe('curl "http://localhost:1337/api/projects/by-project/repo%20name%2Fwith%20space/config"')
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

  it('builds the improve prereq with git blob hashes, ledger filtering, and audit-log tailing', () => {
    const cmd = buildImprovePrerequisiteCommand()
    expect(cmd).toMatch(/git ls-files/)
    expect(cmd).not.toMatch(/git ls-files -s/)
    expect(cmd).toMatch(/git ls-files --others --exclude-standard/)
    expect(cmd).toMatch(/git hash-object/)
    expect(cmd).toMatch(/improve-ledger\.txt/)
    expect(cmd).toMatch(/grep -qxF "\$sha"/)
    expect(cmd).toContain('*__snapshots__/*|*__fixtures__/*|*/fixtures/*')
    expect(cmd).toContain('*/test-results/*|*/playwright-report/*')
    expect(cmd).toContain('CHANGELOG.md|LICENSE|LICENSE.md')
    expect(cmd).toMatch(/docs\/superpowers\/plans\//)
    expect(cmd).toContain('*.gen.*|*.generated.*')
    expect(cmd).not.toMatch(/stat --version/)
    expect(cmd).not.toMatch(/stat -f/)
    expect(cmd).not.toMatch(/stat -c/)
    expect(cmd).toMatch(/sort -n \| head -5/)
    expect(cmd).toMatch(/\.tamtam\/cache\/audits\/improve\.md/)
    expect(cmd).not.toMatch(/\bfind app components lib hooks\b/)
  })

  it('surfaces tracked and non-ignored untracked files, then suppresses recorded blob hashes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tamtam-improve-prereq-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      writeFileSync(join(repo, 'old.ts'), 'export const oldFile = true\n')
      writeFileSync(join(repo, 'new.ts'), 'export const newFile = true\n')
      writeFileSync(join(repo, 'untracked.ts'), 'export const untrackedFile = true\n')
      mkdirSync(join(repo, 'packages/foo/node_modules'), { recursive: true })
      mkdirSync(join(repo, 'packages/foo/.tamtam/cache'), { recursive: true })
      writeFileSync(join(repo, 'packages/foo/node_modules/bar.ts'), 'export const vendored = true\n')
      writeFileSync(join(repo, 'packages/foo/.tamtam/cache/a.md'), '# cached\n')
      execFileSync('git', [
        'add',
        '-f',
        'old.ts',
        'new.ts',
        'packages/foo/node_modules/bar.ts',
        'packages/foo/.tamtam/cache/a.md',
      ], { cwd: repo })

      const output = execFileSync('bash', ['-c', buildImprovePrerequisiteCommand()], {
        cwd: repo,
        encoding: 'utf8',
      })

      const oldSha = execFileSync('git', ['hash-object', '--', 'old.ts'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim()
      const untrackedSha = execFileSync('git', ['hash-object', '--', 'untracked.ts'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim()

      expect(output).toContain(`old.ts  (blob ${oldSha})`)
      expect(output).toContain('new.ts  (blob ')
      expect(output).toContain(`untracked.ts  (blob ${untrackedSha})`)
      expect(output).not.toContain('packages/foo/node_modules/bar.ts')
      expect(output).not.toContain('packages/foo/.tamtam/cache/a.md')

      writeFileSync(join(repo, '.tamtam/cache/audits/improve-ledger.txt'), `${oldSha}\n${untrackedSha}\n`)

      const afterLedger = execFileSync('bash', ['-c', buildImprovePrerequisiteCommand()], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(afterLedger).not.toContain('old.ts  (blob ')
      expect(afterLedger).not.toContain('untracked.ts  (blob ')
      expect(afterLedger).toContain('new.ts  (blob ')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('hashes dirty tracked files from the working tree instead of the index', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tamtam-improve-prereq-dirty-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      writeFileSync(join(repo, 'dirty.ts'), 'export const dirtyFile = "indexed"\n')
      execFileSync('git', ['add', 'dirty.ts'], { cwd: repo })

      const indexedSha = execFileSync('git', ['hash-object', '--', 'dirty.ts'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim()
      writeFileSync(join(repo, 'dirty.ts'), 'export const dirtyFile = "working-tree"\n')
      const workingTreeSha = execFileSync('git', ['hash-object', '--', 'dirty.ts'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim()
      mkdirSync(join(repo, '.tamtam/cache/audits'), { recursive: true })
      writeFileSync(join(repo, '.tamtam/cache/audits/improve-ledger.txt'), `${indexedSha}\n`)

      const output = execFileSync('bash', ['-c', buildImprovePrerequisiteCommand()], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(output).toContain(`dirty.ts  (blob ${workingTreeSha})`)
      expect(output).not.toContain(`dirty.ts  (blob ${indexedSha})`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
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

  it('builds the qa prereq to fetch project config from the host loopback', () => {
    const cmd = buildQaPrerequisiteCommand('repo name/with space')
    expect(cmd).toContain('curl -fsS "http://localhost:1337/api/projects/by-project/repo%20name%2Fwith%20space/config"')
    expect(cmd).toMatch(/QA target config/)
    expect(cmd).toContain('tamtam config service unreachable')
  })

  it('auto-attaches the qa prereq for qa-skilled agents with no stored command', () => {
    expect(resolveAgentPrerequisiteCommand({
      project: 'proj',
      skillIds: [QA_SKILL_ID],
      prerequisiteCommand: undefined,
    })).toBe(buildQaPrerequisiteCommand('proj'))
  })

  it('issue-cruncher still wins over qa when both skills are present', () => {
    expect(resolveAgentPrerequisiteCommand({
      project: 'proj',
      skillIds: [ISSUE_CRUNCHER_SKILL_ID, QA_SKILL_ID],
      prerequisiteCommand: undefined,
    })).toBe(buildIssueCruncherPrerequisiteCommand('proj'))
  })
})
