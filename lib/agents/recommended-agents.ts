import { ISSUE_CRUNCHER_SKILL_ID } from '@/lib/agents/issue-cruncher';

export interface RecommendedAgentTemplate {
  name: string
  description: string
  model: string
  schedule: string
  runner: string
  prompt: string
  skillIds: string[]
  essential?: boolean
  featured?: boolean
  fallbackEnabled?: boolean
}

export function isBuiltInRecommendedAgent(name: string): boolean {
  return RECOMMENDED_AGENTS.some((agent) => agent.name.toLowerCase() === name.trim().toLowerCase());
}

// Built-in recommended agents are a product surface, not page-local UI data.
// They seed the "add an agent" experience with opinionated, maintained
// defaults that map directly to TamTam's core workflows.
export const RECOMMENDED_AGENTS: RecommendedAgentTemplate[] = [
  {
    name: 'issue-cruncher',
    description: 'Picks a ready-to-go GitHub issue, implements it, and hands off to the release pipeline. Closes stale or unverifiable issues by default, and uses needs-info only for recently active authors with a specific unblocker.',
    model: 'normal',
    schedule: '',
    runner: 'pm2',
    prompt: '',
    skillIds: [ISSUE_CRUNCHER_SKILL_ID],
    featured: true,
    fallbackEnabled: true,
  },
  {
    name: 'security-review',
    description: 'Scans uncommitted diffs for OWASP issues, secrets, and vulnerabilities.',
    model: 'normal',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-security-review'],
    fallbackEnabled: true,
  },
  {
    name: 'dependency-check',
    description: 'Scans for outdated or vulnerable dependencies and suggests updates.',
    model: 'normal',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-dependency-check'],
    fallbackEnabled: true,
  },
  {
    name: 'ci-monitor',
    description: 'Checks GitHub Actions status and applies fixes when the latest run fails.',
    model: 'normal',
    schedule: '30m',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-ci-monitor'],
    fallbackEnabled: true,
  },
  {
    name: 'release-ready',
    description: 'Pre-flight check: runs tests and surfaces whether the project is ready to ship.',
    model: 'normal',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-release-ready'],
    fallbackEnabled: true,
  },
  {
    name: 'tests',
    description: 'Adds missing tests for recently changed code and fills gaps in coverage.',
    model: 'normal',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-tests'],
    fallbackEnabled: true,
  },
  {
    name: 'cto',
    description: 'Thinks from a CTO perspective about product direction and creates prioritized GitHub issues for missing features, gaps, and strategic improvements.',
    model: 'smart',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-cto'],
    fallbackEnabled: true,
  },
  {
    name: 'gha-audit',
    description: 'Audits GitHub Actions workflows and creates missing ones for CI, release, and labels.',
    model: 'normal',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-gha-audit'],
    fallbackEnabled: true,
  },
  {
    name: 'readme-sync',
    description: 'Verifies README.md is accurate and updates it to reflect the current state of the project.',
    model: 'normal',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-readme-sync'],
    fallbackEnabled: true,
  },
  {
    name: 'docs-claude',
    description: 'Audits CLAUDE.md for completeness — adds missing guidance on security, coding conventions, testing rules, and best patterns so Claude behaves correctly on every run.',
    model: 'normal',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-docs-claude'],
    essential: true,
    fallbackEnabled: true,
  },
  {
    name: 'qa',
    description: 'Browses the configured QA target with Playwright, fixes 1-2 small safe issues directly, and reports the rest.',
    model: 'normal',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-qa'],
    featured: true,
    fallbackEnabled: true,
  },
  {
    name: 'manage-agents',
    description: 'Audits TamTam agents for this project and creates, updates, or removes them to match current project needs.',
    model: 'normal',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-manage-agents'],
    featured: true,
    fallbackEnabled: true,
  },
]
