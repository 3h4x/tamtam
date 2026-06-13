import { test, expect } from '@playwright/test'
import {
  PROJECT,
  mockProjectShell,
  standaloneParentChainJobs,
  activeReleaseWithStandaloneRunningJob,
  releaseFixLoopJobs,
  releaseUnknownReviewJobs,
  releaseDoNotShipJobs,
  releasePartialDodJobs,
  releaseSoakRunningJobs,
  releaseSoakFailedJobs,
} from './pipeline-strip-fixtures'

test.describe('PipelineStrip visibility', () => {
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

  test('terminal tab shows soak phase running with CI-watching hint', async ({ page }) => {
    await mockProjectShell(page, releaseSoakRunningJobs())
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: soak running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('watching default-branch CI on the merge commit — click to open terminal')).toBeVisible()
    await expect(page.getByLabel(/soak: running\./i)).toBeVisible()
    await expect(page.getByTitle('View unified release trace')).toBeVisible()
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible()
  })

  test('terminal tab shows soak phase failed state', async ({ page }) => {
    await mockProjectShell(page, releaseSoakFailedJobs())
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: soak failed/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel(/soak: failed\./i)).toBeVisible()
    await expect(page.getByTitle('soak failed — click to view log')).toBeVisible()
    await expect(page.getByTitle('View unified release trace')).toBeVisible()
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible()
  })
})
