import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'pipeline-strip-ui'

const now = () => Math.floor(Date.now() / 1000)

interface MockJob {
  id: string
  project: string
  kind: string
  status: 'done' | 'running'
  exit_code: number | null
  started_at: number
  finished_at: number | null
  pid: number
  log_path: string
  seen: boolean
  session_id: string | null
  parent_job_id?: string | null
  release_id?: string | null
  context_meta: string | null
  provider: string
  work_summary: string
  verdict?: string
}

function releaseBackedJobs(): MockJob[] {
  const releaseId = 'strip-release-1'
  return [
    {
      id: releaseId,
      project: PROJECT,
      kind: 'release',
      status: 'running',
      exit_code: null,
      started_at: now() - 20,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review is running.',
    },
    {
      id: 'strip-test-1',
      project: PROJECT,
      kind: 'test',
      status: 'done',
      exit_code: 0,
      started_at: now() - 15,
      finished_at: now() - 12,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      parent_job_id: releaseId,
      release_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Tests passed.',
    },
    {
      id: 'strip-review-1',
      project: PROJECT,
      kind: 'review',
      status: 'running',
      exit_code: null,
      started_at: now() - 10,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-review-session',
      parent_job_id: 'strip-test-1',
      release_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review is running.',
    },
  ]
}

function standaloneParentChainJobs(): MockJob[] {
  return [
    {
      id: 'strip-standalone-test',
      project: PROJECT,
      kind: 'test',
      status: 'done',
      exit_code: 0,
      started_at: now() - 30,
      finished_at: now() - 25,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Tests passed.',
    },
    {
      id: 'strip-standalone-review',
      project: PROJECT,
      kind: 'review',
      status: 'done',
      exit_code: 0,
      started_at: now() - 20,
      finished_at: now() - 15,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-standalone-review-session',
      parent_job_id: 'strip-standalone-test',
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review needs attention.',
      verdict: 'NEEDS ATTENTION',
    },
    {
      id: 'strip-standalone-fix',
      project: PROJECT,
      kind: 'fix',
      status: 'running',
      exit_code: null,
      started_at: now() - 10,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-standalone-fix-session',
      parent_job_id: 'strip-standalone-review',
      context_meta: null,
      provider: 'claude',
      work_summary: 'Fix is running.',
    },
  ]
}

function activeReleaseWithStandaloneRunningJob(): MockJob[] {
  return [
    {
      id: 'strip-active-release-gap',
      project: PROJECT,
      kind: 'release',
      status: 'running',
      exit_code: null,
      started_at: now() - 20,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Release is between child steps.',
    },
    {
      id: 'strip-unrelated-standalone-test',
      project: PROJECT,
      kind: 'test',
      status: 'running',
      exit_code: null,
      started_at: now() - 10,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-unrelated-standalone-test-session',
      context_meta: null,
      provider: 'claude',
      work_summary: 'Standalone test is running.',
    },
  ]
}

function releaseFixLoopJobs(): MockJob[] {
  const releaseId = 'strip-loop-release'
  return [
    {
      id: releaseId,
      project: PROJECT,
      kind: 'release',
      status: 'running',
      exit_code: null,
      started_at: now() - 60,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Release is running.',
    },
    {
      id: 'strip-loop-test',
      project: PROJECT,
      kind: 'test',
      status: 'done',
      exit_code: 0,
      started_at: now() - 50,
      finished_at: now() - 45,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Tests passed.',
    },
    {
      id: 'strip-loop-review-old',
      project: PROJECT,
      kind: 'review',
      status: 'done',
      exit_code: 0,
      started_at: now() - 40,
      finished_at: now() - 35,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-loop-review-old-session',
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review needs attention.',
      verdict: 'NEEDS ATTENTION',
    },
    {
      id: 'strip-loop-fix',
      project: PROJECT,
      kind: 'fix',
      status: 'done',
      exit_code: 0,
      started_at: now() - 30,
      finished_at: now() - 20,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-loop-fix-session',
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Fix applied.',
    },
    {
      id: 'strip-loop-review-new',
      project: PROJECT,
      kind: 'review',
      status: 'running',
      exit_code: null,
      started_at: now() - 10,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-loop-review-new-session',
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review is running.',
    },
  ]
}

function releasePushFailureJobs(): MockJob[] {
  const releaseId = 'strip-push-fail-release'
  return [
    {
      id: releaseId,
      project: PROJECT,
      kind: 'release',
      status: 'running',
      exit_code: null,
      started_at: now() - 40,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Release is recovering from push failure.',
    },
    {
      id: 'strip-push-failed',
      project: PROJECT,
      kind: 'push',
      status: 'done',
      exit_code: 1,
      started_at: now() - 30,
      finished_at: now() - 20,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Push failed.',
    },
    {
      id: 'strip-push-fix-running',
      project: PROJECT,
      kind: 'fix',
      status: 'running',
      exit_code: null,
      started_at: now() - 10,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-push-fix-session',
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Fix is running.',
    },
  ]
}

function releaseUnknownReviewJobs(): MockJob[] {
  const releaseId = 'strip-unknown-review-release'
  return [
    {
      id: releaseId,
      project: PROJECT,
      kind: 'release',
      status: 'running',
      exit_code: null,
      started_at: now() - 40,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Release is recovering from an unknown review.',
    },
    {
      id: 'strip-unknown-review',
      project: PROJECT,
      kind: 'review',
      status: 'done',
      exit_code: 0,
      started_at: now() - 20,
      finished_at: now() - 15,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-unknown-review-session',
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review completed without a parsed verdict.',
    },
    {
      id: 'strip-unknown-fix',
      project: PROJECT,
      kind: 'fix',
      status: 'running',
      exit_code: null,
      started_at: now() - 10,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-unknown-fix-session',
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Fix is running.',
    },
  ]
}

function releaseDoNotShipJobs(): MockJob[] {
  const releaseId = 'strip-do-not-ship-release'
  return [
    {
      id: releaseId,
      project: PROJECT,
      kind: 'release',
      status: 'running',
      exit_code: null,
      started_at: now() - 40,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Release is blocked by review.',
    },
    {
      id: 'strip-do-not-ship-test',
      project: PROJECT,
      kind: 'test',
      status: 'done',
      exit_code: 0,
      started_at: now() - 30,
      finished_at: now() - 25,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Tests passed.',
    },
    {
      id: 'strip-do-not-ship-review',
      project: PROJECT,
      kind: 'review',
      status: 'done',
      exit_code: 0,
      started_at: now() - 20,
      finished_at: now() - 15,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-do-not-ship-review-session',
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review says do not ship.',
      verdict: 'DO NOT SHIP',
    },
    {
      id: 'strip-do-not-ship-fix',
      project: PROJECT,
      kind: 'fix',
      status: 'running',
      exit_code: null,
      started_at: now() - 10,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'strip-do-not-ship-fix-session',
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Fix is running.',
    },
  ]
}

function releasePartialDodJobs(): MockJob[] {
  const releaseId = 'strip-dod-release'
  return [
    {
      id: releaseId,
      project: PROJECT,
      kind: 'release',
      status: 'running',
      exit_code: null,
      started_at: now() - 40,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Release is waiting for merge.',
    },
    {
      id: 'strip-dod-partial',
      project: PROJECT,
      kind: 'mark-dod',
      status: 'done',
      exit_code: 0,
      started_at: now() - 30,
      finished_at: now() - 20,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: releaseId,
      context_meta: JSON.stringify({ verified: 2, total: 3 }),
      provider: 'claude',
      work_summary: 'DoD partially verified.',
    },
    {
      id: 'strip-pr-wait-running',
      project: PROJECT,
      kind: 'pr-wait',
      status: 'running',
      exit_code: null,
      started_at: now() - 10,
      finished_at: null,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: releaseId,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Waiting for merge.',
    },
  ]
}

async function mockProjectShell(
  page: Page,
  jobs: MockJob[] | (() => MockJob[]) = releaseBackedJobs(),
  options: { lastPushError?: string | null } = {},
): Promise<void> {
  const currentJobs = () => typeof jobs === 'function' ? jobs() : jobs

  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [{
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
        }],
        priorities: [],
        issueCounts: {},
      },
    }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: currentJobs(), pendingReleaseProjects: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({
      json: {
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
        release_after_run: false,
        tests_disabled: true,
        review_disabled: false,
        issue_auto_branch: false,
        last_push_error: options.lastPushError ?? null,
        last_push_at: options.lastPushError ? now() : null,
      },
    }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'main', defaultBranch: 'main', commitsAhead: null } }),
  )
  await page.route(
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
  await page.route('**/api/skills', (route: Route) => route.fulfill({ json: { skills: [] } }))
  await page.route('**/api/projects/personas', (route: Route) => route.fulfill({ json: { personas: [] } }))
  await page.route(`**/api/projects/by-project/${PROJECT}/release/abort`, (route: Route) =>
    route.fulfill({ json: { status: 'aborted' } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/push`, (route: Route) =>
    route.fulfill({ json: { status: 'started', job_id: 'strip-push-retry' } }),
  )
}

test.describe('PipelineStrip visibility', () => {
  test('terminal tab walks test review fix commit push in order and then clears the strip', async ({ page }) => {
    let phase: 'test' | 'review' | 'fix' | 'commit' | 'push' | 'done' = 'test'
    const releaseId = 'strip-full-sequence-release'

    await mockProjectShell(page, () => {
      if (phase === 'done') return []

      const jobs: MockJob[] = [
        {
          id: releaseId,
          project: PROJECT,
          kind: 'release',
          status: 'running',
          exit_code: null,
          started_at: now() - 120,
          finished_at: null,
          pid: 0,
          log_path: '',
          seen: true,
          session_id: null,
          context_meta: null,
          provider: 'claude',
          work_summary: `${phase} is running.`,
        },
      ]

      if (phase === 'test') {
        jobs.push({
          id: 'strip-full-test',
          project: PROJECT,
          kind: 'test',
          status: 'running',
          exit_code: null,
          started_at: now() - 10,
          finished_at: null,
          pid: 0,
          log_path: '',
          seen: true,
          session_id: 'strip-full-test-session',
          parent_job_id: releaseId,
          release_id: null,
          context_meta: null,
          provider: 'claude',
          work_summary: 'Tests are running.',
        })
        return jobs
      }

      jobs.push({
        id: 'strip-full-test',
        project: PROJECT,
        kind: 'test',
        status: 'done',
        exit_code: 0,
        started_at: now() - 90,
        finished_at: now() - 80,
        pid: 0,
        log_path: '',
        seen: true,
        session_id: 'strip-full-test-session',
        parent_job_id: releaseId,
        release_id: null,
        context_meta: null,
        provider: 'claude',
        work_summary: 'Tests passed.',
      })

      if (phase === 'review') {
        jobs.push({
          id: 'strip-full-review',
          project: PROJECT,
          kind: 'review',
          status: 'running',
          exit_code: null,
          started_at: now() - 10,
          finished_at: null,
          pid: 0,
          log_path: '',
          seen: true,
          session_id: 'strip-full-review-session',
          parent_job_id: 'strip-full-test',
          release_id: null,
          context_meta: null,
          provider: 'claude',
          work_summary: 'Review is running.',
        })
        return jobs
      }

      jobs.push({
        id: 'strip-full-review',
        project: PROJECT,
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 70,
        finished_at: now() - 60,
        pid: 0,
        log_path: '',
        seen: true,
        session_id: 'strip-full-review-session',
        parent_job_id: 'strip-full-test',
        release_id: null,
        context_meta: null,
        provider: 'claude',
        work_summary: 'Review asked for follow-up.',
        verdict: 'NEEDS ATTENTION',
      })

      if (phase === 'fix') {
        jobs.push({
          id: 'strip-full-fix',
          project: PROJECT,
          kind: 'fix',
          status: 'running',
          exit_code: null,
          started_at: now() - 10,
          finished_at: null,
          pid: 0,
          log_path: '',
          seen: true,
          session_id: 'strip-full-fix-session',
          parent_job_id: 'strip-full-review',
          release_id: null,
          context_meta: null,
          provider: 'claude',
          work_summary: 'Fix is running.',
        })
        return jobs
      }

      jobs.push({
        id: 'strip-full-fix',
        project: PROJECT,
        kind: 'fix',
        status: 'done',
        exit_code: 0,
        started_at: now() - 50,
        finished_at: now() - 40,
        pid: 0,
        log_path: '',
        seen: true,
        session_id: 'strip-full-fix-session',
        parent_job_id: 'strip-full-review',
        release_id: null,
        context_meta: null,
        provider: 'claude',
        work_summary: 'Fix completed.',
      })

      if (phase === 'commit') {
        jobs.push({
          id: 'strip-full-commit',
          project: PROJECT,
          kind: 'commit',
          status: 'running',
          exit_code: null,
          started_at: now() - 10,
          finished_at: null,
          pid: 0,
          log_path: '',
          seen: true,
          session_id: null,
          parent_job_id: 'strip-full-fix',
          release_id: null,
          context_meta: null,
          provider: 'claude',
          work_summary: 'Commit is running.',
        })
        return jobs
      }

      jobs.push({
        id: 'strip-full-commit',
        project: PROJECT,
        kind: 'commit',
        status: 'done',
        exit_code: 0,
        started_at: now() - 30,
        finished_at: now() - 20,
        pid: 0,
        log_path: '',
        seen: true,
        session_id: null,
        parent_job_id: 'strip-full-fix',
        release_id: null,
        context_meta: null,
        provider: 'claude',
        work_summary: 'Commit completed.',
      })

      jobs.push({
        id: 'strip-full-push',
        project: PROJECT,
        kind: 'push',
        status: 'running',
        exit_code: null,
        started_at: now() - 10,
        finished_at: null,
        pid: 0,
        log_path: '',
        seen: true,
        session_id: null,
        parent_job_id: 'strip-full-commit',
        release_id: null,
        context_meta: null,
        provider: 'claude',
        work_summary: 'Push is running.',
      })
      return jobs
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: test running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('tests running — click to open terminal')).toBeVisible()

    phase = 'review'

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('test completed — click to view log')).toBeVisible()
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible()

    phase = 'fix'

    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('verdict: NEEDS ATTENTION — click to view findings')).toBeVisible()
    await expect(page.getByTitle('fix in progress — click to open terminal')).toBeVisible()

    phase = 'commit'

    await expect(page.getByLabel(/pipeline summary: commit running/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('fix completed — click to view log')).toBeVisible()
    await expect(page.getByTitle('commit in progress — click to open terminal')).toBeVisible()

    phase = 'push'

    await expect(page.getByLabel(/pipeline summary: push running/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('commit completed — click to view log')).toBeVisible()
    await expect(page.getByTitle('push in progress — click to open terminal')).toBeVisible()

    phase = 'done'

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, { timeout: 12_000 })
  })

  test('terminal tab polls from review to commit and clears the strip after completion', async ({ page }) => {
    let phase: 'review' | 'commit' | 'done' = 'review'

    await mockProjectShell(page, () => {
      if (phase === 'review') return releaseBackedJobs()

      if (phase === 'commit') {
        const releaseId = 'strip-release-1'
        return [
          {
            id: releaseId,
            project: PROJECT,
            kind: 'release',
            status: 'running',
            exit_code: null,
            started_at: now() - 30,
            finished_at: null,
            pid: 0,
            log_path: '',
            seen: true,
            session_id: null,
            context_meta: null,
            provider: 'claude',
            work_summary: 'Commit is running.',
          },
          {
            id: 'strip-test-1',
            project: PROJECT,
            kind: 'test',
            status: 'done',
            exit_code: 0,
            started_at: now() - 25,
            finished_at: now() - 22,
            pid: 0,
            log_path: '',
            seen: true,
            session_id: null,
            parent_job_id: releaseId,
            release_id: null,
            context_meta: null,
            provider: 'claude',
            work_summary: 'Tests passed.',
          },
          {
            id: 'strip-review-1',
            project: PROJECT,
            kind: 'review',
            status: 'done',
            exit_code: 0,
            started_at: now() - 20,
            finished_at: now() - 15,
            pid: 0,
            log_path: '',
            seen: true,
            session_id: 'strip-review-session',
            parent_job_id: 'strip-test-1',
            release_id: null,
            context_meta: null,
            provider: 'claude',
            work_summary: 'Review passed.',
            verdict: 'LGTM',
          },
          {
            id: 'strip-commit-1',
            project: PROJECT,
            kind: 'commit',
            status: 'running',
            exit_code: null,
            started_at: now() - 5,
            finished_at: null,
            pid: 0,
            log_path: '',
            seen: true,
            session_id: null,
            parent_job_id: 'strip-review-1',
            release_id: null,
            context_meta: null,
            provider: 'claude',
            work_summary: 'Commit is running.',
          },
        ]
      }

      return []
    })
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible()
    await expect(page.getByTitle('commit in progress — click to open terminal')).toHaveCount(0)

    phase = 'commit'

    await expect(page.getByLabel(/pipeline summary: commit running/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('test completed — click to view log')).toBeVisible()
    await expect(page.getByTitle('verdict: LGTM — click to view findings')).toBeVisible()
    await expect(page.getByTitle('commit in progress — click to open terminal')).toBeVisible()
    await expect(page.getByTitle('review in progress — click to open terminal')).toHaveCount(0)

    phase = 'done'

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, { timeout: 12_000 })
  })

  test('terminal tab shows active pipeline status and release abort controls', async ({ page }) => {
    await mockProjectShell(page)
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('test completed — click to view log')).toBeVisible()
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible()
    await expect(page.getByTitle('View unified release trace')).toBeVisible()

    await page.getByRole('button', { name: 'abort' }).click()
    await expect(page.getByText('abort?')).toBeVisible()
    await page.getByRole('button', { name: 'yes', exact: true }).click()
  })

  test('terminal tab keeps standalone parent-linked pipeline context without release controls', async ({ page }) => {
    await mockProjectShell(page, standaloneParentChainJobs())
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('test completed — click to view log')).toBeVisible()
    await expect(page.getByTitle('verdict: NEEDS ATTENTION — click to view findings')).toBeVisible()
    await expect(page.getByTitle('fix in progress — click to open terminal')).toBeVisible()
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0)
  })

  test('terminal tab keeps active releases scoped away from unrelated standalone jobs', async ({ page }) => {
    await mockProjectShell(page, activeReleaseWithStandaloneRunningJob())
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: release running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel(/pipeline summary: test running/i)).toHaveCount(0)
    await expect(page.getByLabel(/test: running/i)).toHaveCount(0)
    await expect(page.getByTitle('View unified release trace')).toBeVisible()
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible()
  })

  test('terminal tab collapses repeated release loop steps to the latest job per kind', async ({ page }) => {
    await mockProjectShell(page, releaseFixLoopJobs())
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('button[aria-label^="review:"]')).toHaveCount(1)
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible()
    await expect(page.getByTitle('verdict: NEEDS ATTENTION — click to view findings')).toHaveCount(0)
    await expect(page.getByTitle('fix completed — click to view log')).toBeVisible()
    await expect(page.getByTitle('View unified release trace')).toBeVisible()
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible()
  })

  test('terminal tab surfaces push failure details during recovery', async ({ page }) => {
    await mockProjectShell(page, releasePushFailureJobs(), {
      lastPushError: 'Push failed: remote rejected: protected branch',
    })
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('Push failed: remote rejected: protected branch')).toBeVisible()
    await expect(page.getByTitle('fix in progress — click to open terminal')).toBeVisible()

    const retryRequest = page.waitForRequest((request) =>
      request.method() === 'POST' &&
      request.url().endsWith(`/api/projects/by-project/${PROJECT}/push`) &&
      request.postDataJSON()?.release_id === 'strip-push-fail-release',
    )
    await page.getByRole('button', { name: 'retry push' }).click()
    await retryRequest
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal\\?job=strip-push-retry$`))
  })

  test('terminal tab marks DO NOT SHIP reviews as failed during active releases', async ({ page }) => {
    await mockProjectShell(page, releaseDoNotShipJobs())
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel(/review: failed\. verdict: DO NOT SHIP/i)).toBeVisible()
    await expect(page.getByLabel(/review: done\. verdict: DO NOT SHIP/i)).toHaveCount(0)
    await expect(page.getByTitle('fix in progress — click to open terminal')).toBeVisible()
  })

  test('terminal tab marks verdictless completed reviews as failed unknown', async ({ page }) => {
    await mockProjectShell(page, releaseUnknownReviewJobs())
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel(/review: failed\. verdict: unknown/i)).toBeVisible()
    await expect(page.getByLabel(/review: done/i)).toHaveCount(0)
    await expect(page.getByTitle('fix in progress — click to open terminal')).toBeVisible()
  })

  test('terminal tab marks partial DoD verification as attention while merge waits', async ({ page }) => {
    await mockProjectShell(page, releasePartialDodJobs())
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: merge running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('DoD: 2 / 3 verified — 1 unticked — click to view log')).toBeVisible()
    await expect(page.getByLabel(/dod: attention/i)).toBeVisible()
    await expect(page.getByTitle('waiting for CI checks and auto-merge — click to open terminal')).toBeVisible()
  })
})
