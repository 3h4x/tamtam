import { test, expect } from '@playwright/test'
import type { BrowserContext, Route } from '@playwright/test'

// Exercises two RunRow context_meta-driven chips that previously had zero e2e
// coverage (components/project-runs/RunRow.tsx):
//
//  1. gemmaVerdictBadge — the local-LLM outcome classification chip. It only
//     renders on completed run/agent rows. The three verdicts map to:
//       done           -> "✓ done"        (success tone)
//       asked_question -> "? asked"        (info tone)
//       needs_continue -> "↻ unfinished"  (warning tone)
//     title is `Local-LLM outcome verdict: <verdict with _ -> space>`.
//
//  2. followupIssueBadge — the audit chip linking to a follow-up GitHub issue
//     filed for a review's findings. Renders an anchor "↗ filed[ #N]" whenever
//     context_meta carries followupIssueUrl; the "#N" suffix is present only
//     when followupIssueNumber is set.
//
// Both are derived in components/project-runs/utils.ts from the job's
// context_meta JSON (outcomeVerdictFromContext / followupIssueFromContext).

const PROJECT = 'run-outcome-verdict-chip'

const now = () => Math.floor(Date.now() / 1000)

const DONE_PROMPT = 'Done run — classifier marked it finished.'
const ASKED_PROMPT = 'Asked run — classifier flagged a clarifying question.'
const UNFINISHED_PROMPT = 'Unfinished run — classifier wants a continue.'
const FILED_PROMPT = 'Filed run — a follow-up issue with a number was filed.'
const FILED_NONUM_PROMPT = 'Filed run — a follow-up issue without a number was filed.'

function outcomeMeta(verdict: string) {
  return JSON.stringify({ outcomeClassification: { verdict } })
}

function followupMeta(url: string, num: number | null) {
  return JSON.stringify(
    num != null ? { followupIssueUrl: url, followupIssueNumber: num } : { followupIssueUrl: url },
  )
}

function runJob(id: string, prompt: string, contextMeta: string | null) {
  return {
    id,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: 0,
    started_at: now() - 120,
    finished_at: now() - 90,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: id,
    user_prompt: prompt,
    prompt,
    context_meta: contextMeta,
    provider: 'claude',
    work_summary: null,
    prompt_bytes: 1_000,
  }
}

function jobs() {
  return [
    runJob('outcome-done', DONE_PROMPT, outcomeMeta('done')),
    runJob('outcome-asked', ASKED_PROMPT, outcomeMeta('asked_question')),
    runJob('outcome-unfinished', UNFINISHED_PROMPT, outcomeMeta('needs_continue')),
    runJob('followup-numbered', FILED_PROMPT, followupMeta('https://example.test/issues/42', 42)),
    runJob('followup-nonumber', FILED_NONUM_PROMPT, followupMeta('https://example.test/issues/x', null)),
  ]
}

function makeTask() {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${PROJECT}`,
    fires_at: '',
    sync: true,
    changes: 0,
    unpushed: 0,
    reviewed: true,
    last_run: null,
    last_run_ago: null,
    last_run_duration_s: null,
    last_run_exit: null,
    release_tag: null,
    ci: null,
    ci_failed_url: null,
    github: null,
  }
}

function makeProjectConfig() {
  return {
    project: PROJECT,
    test_command: '',
    release_timeout_minutes: null,
    detected_test_command: '',
    effective_test_command: '',
    test_cron_enabled: false,
    test_cron_schedule: '',
    auto_push_enabled: false,
    auto_commit_enabled: false,
    auto_pr_merge_enabled: false,
    pr_workflow_enabled: false,
    release_after_run: false,
    tests_disabled: true,
    review_disabled: false,
    issue_auto_branch: false,
    website: '',
    qa_url: '',
  }
}

async function stubRoutes(context: BrowserContext): Promise<void> {
  await context.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  )
  await context.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await context.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  )
  await context.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  )
  await context.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await context.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  )
  await context.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') === '1',
    (route: Route) =>
      route.fulfill({
        json: {
          repo: '',
          prCount: 0,
          issueCount: 0,
          openPrBranches: [],
          error: null,
          cached: false,
          cachedAt: now(),
        },
      }),
  )
  await context.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') !== '1',
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  )
  await context.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await context.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: jobs(), total: jobs().length, pendingReleaseProjects: [] } }),
  )
  await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          total: 5,
          byKind: { run: 5 },
          byStatus: { running: 0, done: 5, aborted: 0, failed: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
  )
}

test.describe('RunRow outcome-verdict + followup-issue chips', () => {
  test('renders each outcome verdict tone and the audit follow-up issue link', async ({ page }) => {
    await stubRoutes(page.context())
    await page.goto(`/project/${PROJECT}/history`)

    const doneRow = page.getByRole('button').filter({ hasText: DONE_PROMPT }).first()
    const askedRow = page.getByRole('button').filter({ hasText: ASKED_PROMPT }).first()
    const unfinishedRow = page.getByRole('button').filter({ hasText: UNFINISHED_PROMPT }).first()
    const filedRow = page.getByRole('button').filter({ hasText: FILED_PROMPT }).first()
    const filedNoNumRow = page.getByRole('button').filter({ hasText: FILED_NONUM_PROMPT }).first()

    await expect(doneRow).toBeVisible({ timeout: 8_000 })
    await expect(askedRow).toBeVisible({ timeout: 8_000 })
    await expect(unfinishedRow).toBeVisible({ timeout: 8_000 })
    await expect(filedRow).toBeVisible({ timeout: 8_000 })
    await expect(filedNoNumRow).toBeVisible({ timeout: 8_000 })

    // done -> "✓ done", success tone, title reflects the raw verdict.
    const doneChip = doneRow.getByText('✓ done', { exact: true })
    await expect(doneChip).toBeVisible({ timeout: 8_000 })
    await expect(doneChip).toHaveAttribute('title', 'Local-LLM outcome verdict: done')

    // asked_question -> "? asked", title underscores collapse to a space.
    const askedChip = askedRow.getByText('? asked', { exact: true })
    await expect(askedChip).toBeVisible({ timeout: 8_000 })
    await expect(askedChip).toHaveAttribute('title', 'Local-LLM outcome verdict: asked question')

    // needs_continue -> "↻ unfinished".
    const unfinishedChip = unfinishedRow.getByText('↻ unfinished', { exact: true })
    await expect(unfinishedChip).toBeVisible({ timeout: 8_000 })
    await expect(unfinishedChip).toHaveAttribute('title', 'Local-LLM outcome verdict: needs continue')

    // The outcome chip is exclusive to its own row — done's chip never bleeds
    // into the asked row, proving per-row context_meta wiring.
    await expect(askedRow.getByText('✓ done', { exact: true })).toHaveCount(0)
    await expect(doneRow.getByText('? asked', { exact: true })).toHaveCount(0)

    // followup with a number -> anchor "↗ filed #42" pointing at the issue.
    const filedLink = filedRow.getByRole('link', { name: /↗ filed #42/ })
    await expect(filedLink).toBeVisible({ timeout: 8_000 })
    await expect(filedLink).toHaveAttribute('href', 'https://example.test/issues/42')
    await expect(filedLink).toHaveAttribute('target', '_blank')

    // followup without a number -> "↗ filed" with no "#N" suffix.
    const filedNoNumLink = filedNoNumRow.getByRole('link', { name: /↗ filed/ })
    await expect(filedNoNumLink).toBeVisible({ timeout: 8_000 })
    await expect(filedNoNumLink).toHaveAttribute('href', 'https://example.test/issues/x')
    await expect(filedNoNumRow.getByText(/↗ filed #/)).toHaveCount(0)
  })
})
