import type { Page, Route } from '@playwright/test'

export const PROJECT = 'pipeline-strip-ui'

export const now = () => Math.floor(Date.now() / 1000)

export interface MockJob {
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

export function releaseBackedJobs(): MockJob[] {
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

export function standaloneParentChainJobs(): MockJob[] {
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

export function activeReleaseWithStandaloneRunningJob(): MockJob[] {
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

export function releaseFixLoopJobs(): MockJob[] {
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

export function releasePushFailureJobs(): MockJob[] {
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

export function releaseUnknownReviewJobs(): MockJob[] {
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

export function releaseDoNotShipJobs(): MockJob[] {
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

export function releasePartialDodJobs(): MockJob[] {
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

export function releaseSoakRunningJobs(): MockJob[] {
  const releaseId = 'strip-soak-release'
  const base = (id: string, kind: string, startOffset: number, endOffset: number | null, extra: Partial<MockJob> = {}): MockJob => ({
    id,
    project: PROJECT,
    kind,
    status: endOffset !== null ? 'done' : 'running',
    exit_code: endOffset !== null ? 0 : null,
    started_at: now() - startOffset,
    finished_at: endOffset !== null ? now() - endOffset : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: '',
    ...extra,
  })
  return [
    { ...base(releaseId, 'release', 120, null), release_id: null },
    base('strip-soak-test', 'test', 110, 100),
    { ...base('strip-soak-review', 'review', 90, 80), verdict: 'LGTM', session_id: 'strip-soak-review-session' },
    base('strip-soak-commit', 'commit', 70, 60),
    base('strip-soak-push', 'push', 50, 40),
    base('strip-soak-dod', 'mark-dod', 35, 25),
    base('strip-soak-pr-wait', 'pr-wait', 20, 10),
    { ...base('strip-soak-soak', 'soak', 5, null), session_id: 'strip-soak-soak-session' },
  ]
}

export function releaseSoakFailedJobs(): MockJob[] {
  const releaseId = 'strip-soak-fail-release'
  const base = (id: string, kind: string, startOffset: number, endOffset: number | null, exitCode = 0, extra: Partial<MockJob> = {}): MockJob => ({
    id,
    project: PROJECT,
    kind,
    status: endOffset !== null ? 'done' : 'running',
    exit_code: endOffset !== null ? exitCode : null,
    started_at: now() - startOffset,
    finished_at: endOffset !== null ? now() - endOffset : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: '',
    ...extra,
  })
  return [
    { ...base(releaseId, 'release', 120, null), release_id: null },
    base('strip-soak-fail-test', 'test', 110, 100),
    { ...base('strip-soak-fail-review', 'review', 90, 80, 0), verdict: 'LGTM', session_id: 'strip-soak-fail-review-session' },
    base('strip-soak-fail-commit', 'commit', 70, 60),
    base('strip-soak-fail-push', 'push', 50, 40),
    base('strip-soak-fail-dod', 'mark-dod', 35, 25),
    base('strip-soak-fail-pr-wait', 'pr-wait', 20, 10),
    base('strip-soak-fail-soak', 'soak', 5, 1, 1),
  ]
}

export async function mockProjectShell(
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
