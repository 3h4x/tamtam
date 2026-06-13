import { test, expect } from '@playwright/test'
import {
  PROJECT,
  now,
  type MockJob,
  mockProjectShell,
  releaseBackedJobs,
  releaseSoakRunningJobs,
} from './pipeline-strip-fixtures'

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

  test('idle terminal page picks up a newly-started pipeline strip and clears it after completion', async ({ page }) => {
    let phase: 'idle' | 'test' | 'review' | 'done' = 'idle'
    const releaseId = 'strip-idle-start-release'

    await mockProjectShell(page, () => {
      if (phase === 'idle' || phase === 'done') return []

      const jobs: MockJob[] = [
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
          work_summary: `${phase} is running.`,
        },
      ]

      if (phase === 'test') {
        jobs.push({
          id: 'strip-idle-start-test',
          project: PROJECT,
          kind: 'test',
          status: 'running',
          exit_code: null,
          started_at: now() - 5,
          finished_at: null,
          pid: 0,
          log_path: '',
          seen: true,
          session_id: 'strip-idle-start-test-session',
          parent_job_id: releaseId,
          release_id: null,
          context_meta: null,
          provider: 'claude',
          work_summary: 'Tests are running.',
        })
        return jobs
      }

      jobs.push({
        id: 'strip-idle-start-test',
        project: PROJECT,
        kind: 'test',
        status: 'done',
        exit_code: 0,
        started_at: now() - 20,
        finished_at: now() - 15,
        pid: 0,
        log_path: '',
        seen: true,
        session_id: 'strip-idle-start-test-session',
        parent_job_id: releaseId,
        release_id: null,
        context_meta: null,
        provider: 'claude',
        work_summary: 'Tests passed.',
      })
      jobs.push({
        id: 'strip-idle-start-review',
        project: PROJECT,
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 5,
        finished_at: null,
        pid: 0,
        log_path: '',
        seen: true,
        session_id: 'strip-idle-start-review-session',
        parent_job_id: 'strip-idle-start-test',
        release_id: null,
        context_meta: null,
        provider: 'claude',
        work_summary: 'Review is running.',
      })
      return jobs
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0)
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0)

    phase = 'test'

    await expect(page.getByLabel(/pipeline summary: test running/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('tests running — click to open terminal')).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible({ timeout: 12_000 })

    phase = 'review'

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('test completed — click to view log')).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible({
      timeout: 12_000,
    })

    phase = 'done'

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, { timeout: 12_000 })
  })

  test('terminal tab clears the strip after soak phase completes successfully via poll', async ({ page }) => {
    let phase: 'soak-running' | 'done' = 'soak-running'

    await mockProjectShell(page, () => (phase === 'soak-running' ? releaseSoakRunningJobs() : []))

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: soak running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel(/soak: running\./i)).toBeVisible()
    await expect(page.getByTitle('watching default-branch CI on the merge commit — click to open terminal')).toBeVisible()
    await expect(page.getByTitle('View unified release trace')).toBeVisible()
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible()

    phase = 'done'

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, { timeout: 12_000 })
  })

  test('terminal tab transitions from pr-wait to soak running via poll', async ({ page }) => {
    let phase: 'pr-wait' | 'soak' = 'pr-wait'
    const releaseId = 'strip-prwait-soak-release'

    function prWaitJobs(): MockJob[] {
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
        base('strip-prwait-soak-test', 'test', 110, 100),
        { ...base('strip-prwait-soak-review', 'review', 90, 80), verdict: 'LGTM', session_id: 'strip-prwait-soak-review-session' },
        base('strip-prwait-soak-commit', 'commit', 70, 60),
        base('strip-prwait-soak-push', 'push', 50, 40),
        base('strip-prwait-soak-dod', 'mark-dod', 35, 25),
        base('strip-prwait-soak-prwait', 'pr-wait', 10, null),
      ]
    }

    function soakJobs(): MockJob[] {
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
        base('strip-prwait-soak-test', 'test', 110, 100),
        { ...base('strip-prwait-soak-review', 'review', 90, 80), verdict: 'LGTM', session_id: 'strip-prwait-soak-review-session' },
        base('strip-prwait-soak-commit', 'commit', 70, 60),
        base('strip-prwait-soak-push', 'push', 50, 40),
        base('strip-prwait-soak-dod', 'mark-dod', 35, 25),
        base('strip-prwait-soak-prwait', 'pr-wait', 15, 5),
        { ...base('strip-prwait-soak-soak', 'soak', 3, null), session_id: 'strip-prwait-soak-session' },
      ]
    }

    await mockProjectShell(page, () => (phase === 'pr-wait' ? prWaitJobs() : soakJobs()))

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: merge running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('waiting for CI checks and auto-merge — click to open terminal')).toBeVisible()
    await expect(page.getByLabel(/merge: running\./i)).toBeVisible()
    await expect(page.getByTitle('watching default-branch CI on the merge commit')).toHaveCount(0)

    phase = 'soak'

    await expect(page.getByLabel(/pipeline summary: soak running/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('watching default-branch CI on the merge commit — click to open terminal')).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel(/soak: running\./i)).toBeVisible()
    await expect(page.getByLabel(/merge: running\./i)).toHaveCount(0)
  })

  test('terminal tab surfaces a failed test as the pipeline summary in the gap before fix starts, then flips to fix running', async ({
    page,
  }) => {
    // Covers the attentionStep fallback in the summary: while a release is
    // running but no pipeline child is running (the transient gap right after a
    // test fails and before the fix job is dispatched), the strip must promote
    // the failed test to the summary line — "pipeline summary: test failed" —
    // rather than falling back to the bare release row. The real harness can't
    // hold this state because the backend dispatches the fix immediately; only a
    // deterministic mock can pin the in-between frame.
    let phase: 'test-running' | 'test-failed' | 'fix-running' = 'test-running'
    const releaseId = 'strip-test-fail-gap-release'

    const releaseRow: MockJob = {
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
      work_summary: 'Release is recovering from a test failure.',
    }

    await mockProjectShell(page, () => {
      if (phase === 'test-running') {
        return [
          releaseRow,
          {
            id: 'strip-test-fail-gap-test',
            project: PROJECT,
            kind: 'test',
            status: 'running',
            exit_code: null,
            started_at: now() - 10,
            finished_at: null,
            pid: 0,
            log_path: '',
            seen: true,
            session_id: 'strip-test-fail-gap-test-session',
            release_id: releaseId,
            context_meta: null,
            provider: 'claude',
            work_summary: 'Tests are running.',
          },
        ]
      }

      const failedTest: MockJob = {
        id: 'strip-test-fail-gap-test',
        project: PROJECT,
        kind: 'test',
        status: 'done',
        exit_code: 1,
        started_at: now() - 30,
        finished_at: now() - 20,
        pid: 0,
        log_path: '',
        seen: true,
        session_id: 'strip-test-fail-gap-test-session',
        release_id: releaseId,
        context_meta: null,
        provider: 'claude',
        work_summary: 'Tests failed.',
      }

      if (phase === 'test-failed') {
        // No fix job yet — only the release (running) and the failed test exist.
        return [releaseRow, failedTest]
      }

      return [
        releaseRow,
        failedTest,
        {
          id: 'strip-test-fail-gap-fix',
          project: PROJECT,
          kind: 'fix',
          status: 'running',
          exit_code: null,
          started_at: now() - 5,
          finished_at: null,
          pid: 0,
          log_path: '',
          seen: true,
          session_id: 'strip-test-fail-gap-fix-session',
          release_id: releaseId,
          context_meta: null,
          provider: 'claude',
          work_summary: 'Fix is running.',
        },
      ]
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: test running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('tests running — click to open terminal')).toBeVisible()

    phase = 'test-failed'

    // The failed test is promoted to the summary even though it is no longer
    // running and no other child is running.
    await expect(page.getByLabel(/pipeline summary: test failed/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('test failed — click to view log')).toBeVisible()
    await expect(page.getByLabel(/test: failed\. test failed/i)).toBeVisible()
    // Release controls stay available while the release is still running.
    await expect(page.getByTitle('View unified release trace')).toBeVisible()
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible()

    phase = 'fix-running'

    // Once the fix starts it becomes the running summary; the test row stays failed.
    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('fix in progress — click to open terminal')).toBeVisible()
    await expect(page.getByLabel(/test: failed\./i)).toBeVisible()
    await expect(page.getByLabel(/pipeline summary: test failed/i)).toHaveCount(0)
  })
})
