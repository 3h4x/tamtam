import { execFileSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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

  it('builds the improve prereq with git ls-files, excludes generated/fixture/archive paths, and tails the audit log', () => {
    const cmd = buildImprovePrerequisiteCommand()
    expect(cmd).toMatch(/git ls-files/)
    expect(cmd).toMatch(/git ls-files --others --exclude-standard/)
    expect(cmd).toMatch(/grep -Ev '\(\^\|\/\)\(\\\.tamtam\|node_modules\)\//)
    expect(cmd).toMatch(/grep -v '\\\.d\\\.ts\$'/)
    expect(cmd).toMatch(/grep -Ei '\\\.\(ts\|tsx\|js\|jsx\|sol\|py\|rs\|go\|md\|sh\)\$'/)
    expect(cmd).toMatch(/__snapshots__\|__fixtures__\|fixtures\|e2e-results\|test-results/)
    expect(cmd).toMatch(/CHANGELOG\|LICENSE/)
    expect(cmd).toMatch(/docs\/superpowers\/plans\//)
    expect(cmd).toMatch(/\\\.\(gen\|generated\)\\\./)
    expect(cmd).toMatch(/stat --version/)
    expect(cmd).toMatch(/stat_mode=.*gnu/)
    expect(cmd).toMatch(/if \[ "\$stat_mode" = gnu \]/)
    expect(cmd).toMatch(/stat -f '%m'/)
    expect(cmd).toMatch(/stat -c '%Y'/)
    expect(cmd).not.toMatch(/stat -f '%m' "\$f" 2>\/dev\/null \|\| stat -c '%Y'/)
    expect(cmd).not.toMatch(/stat -f '%Sm'/)
    expect(cmd).not.toMatch(/stat -c '%y'/)
    expect(cmd).toMatch(/sort -n \| head -5/)
    expect(cmd).toMatch(/\.tamtam\/cache\/audits\/improve\.md/)
    expect(cmd).not.toMatch(/\bfind app components lib hooks\b/)
  })

  it('uses the GNU stat mtime branch without probing BSD stat per file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tamtam-improve-prereq-'))
    const fakeBin = join(repo, 'fake-bin')
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
      mkdirSync(fakeBin)
      writeFileSync(join(fakeBin, 'stat'), [
        '#!/usr/bin/env bash',
        'if [ "$1" = "--version" ]; then echo "stat (GNU coreutils)"; exit 0; fi',
        'if [ "$1" = "-f" ]; then echo "9999999999"; exit 0; fi',
        'if [ "$1" = "-c" ]; then',
        '  case "$3" in',
        '    packages/foo/node_modules/bar.ts) echo "1" ;;',
        '    packages/foo/.tamtam/cache/a.md) echo "2" ;;',
        '    untracked.ts) echo "5" ;;',
        '    old.ts) echo "10" ;;',
        '    new.ts) echo "20" ;;',
        '    *) exit 1 ;;',
        '  esac',
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'))
      chmodSync(join(fakeBin, 'stat'), 0o755)

      const output = execFileSync('bash', ['-c', buildImprovePrerequisiteCommand()], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      })

      expect(output).toContain('10 old.ts')
      expect(output).toContain('20 new.ts')
      expect(output).toContain('5 untracked.ts')
      expect(output).not.toContain('1 packages/foo/node_modules/bar.ts')
      expect(output).not.toContain('2 packages/foo/.tamtam/cache/a.md')
      expect(output).not.toContain('9999999999')
      expect(output.indexOf('5 untracked.ts')).toBeLessThan(output.indexOf('10 old.ts'))
      expect(output.indexOf('10 old.ts')).toBeLessThan(output.indexOf('20 new.ts'))
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
