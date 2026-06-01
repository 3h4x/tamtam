import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  enableProject,
  writeGitTiming,
  waitForPipelineCompletion,
  waitForJobCompletion,
  waitForJobByIdRunning,
} from './helpers';

const START_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);

const HISTORY_PROJECT = 'start-detect-runs';
const TERMINAL_PROJECT = 'start-detect-terminal';
const TERMINAL_RUN_PROJECT = 'start-detect-run-idle';
const TERMINAL_AGENT_PROJECT = 'start-detect-agent-idle';
const DEFAULT_DIRTY_WORKTREE_BLOCK_THRESHOLD = 1;
const ACTIVE_PIPELINE_SUMMARY =
  /pipeline summary: (release|test|review|fix|commit|push|dod|merge|soak) running/i;

test.describe('Real idle-page job start detection', () => {
  test.afterEach(async ({ request }) => {
    await request.patch('/api/settings', {
      data: { dirty_worktree_block_threshold: DEFAULT_DIRTY_WORKTREE_BLOCK_THRESHOLD },
    });
  });

  test('history tab detects a newly-started release and clears the spinner after completion without reload', async ({
    page,
    request,
  }) => {
    writeScenario(HISTORY_PROJECT, START_SCENARIO.steps);
    resetShimState(HISTORY_PROJECT);
    writeGitTiming(HISTORY_PROJECT, { push: 6500 });
    await enableProject(request, HISTORY_PROJECT, { testsDisabled: true });

    await page.goto(`/project/${HISTORY_PROJECT}/history`);
    await expect(page.getByText('No runs yet').first()).toBeVisible({ timeout: 8_000 });

    const releaseResp = await request.post(`/api/projects/by-project/${HISTORY_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseRow = page.getByRole('button').filter({ hasText: 'Release pipeline' }).first();

    await expect(releaseRow).toBeVisible({
      timeout: 20_000,
    });
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No runs yet')).toHaveCount(0, { timeout: 20_000 });

    const result = await waitForPipelineCompletion(request, HISTORY_PROJECT, 90_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(releaseRow.getByLabel('done')).toBeVisible({ timeout: 15_000 });
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
  });

  test('terminal landing page auto-attaches to a newly-started release and clears live state after completion', async ({
    page,
    request,
  }) => {
    writeScenario(TERMINAL_PROJECT, START_SCENARIO.steps);
    resetShimState(TERMINAL_PROJECT);
    writeGitTiming(TERMINAL_PROJECT, { push: 6500 });
    await enableProject(request, TERMINAL_PROJECT, { testsDisabled: true });

    await page.goto(`/project/${TERMINAL_PROJECT}/terminal`);
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live run')).toHaveCount(0);

    const releaseResp = await request.post(`/api/projects/by-project/${TERMINAL_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    await expect(page).toHaveURL(
      new RegExp(`/project/${TERMINAL_PROJECT}/terminal\\?job=${encodeURIComponent(releaseBody.release_job_id)}`),
      { timeout: 20_000 },
    );
    await expect(page.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel(ACTIVE_PIPELINE_SUMMARY)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTitle('View unified release trace').first()).toBeVisible({
      timeout: 20_000,
    });

    const result = await waitForPipelineCompletion(request, TERMINAL_PROJECT, 90_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 15_000 });
  });

  test('terminal landing page does not auto-attach to a newly-started terminal run', async ({
    page,
    request,
  }) => {
    writeScenario(TERMINAL_RUN_PROJECT, START_SCENARIO.steps);
    resetShimState(TERMINAL_RUN_PROJECT);
    await enableProject(request, TERMINAL_RUN_PROJECT, { testsDisabled: true });

    await page.goto(`/project/${TERMINAL_RUN_PROJECT}/terminal`);
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live run')).toHaveCount(0);

    const runResp = await request.post(`/api/projects/by-project/${TERMINAL_RUN_PROJECT}/run`, {
      data: { prompt: 'Say hello from the background run.' },
    });
    expect(
      runResp.status(),
      `run POST failed: ${await runResp.text()}`,
    ).toBe(200);

    const runBody = await runResp.json() as { job_id: string };
    expect(runBody.job_id, 'run job_id in response').toBeTruthy();

    const runningRun = await waitForJobByIdRunning(request, runBody.job_id, 20_000);
    expect(runningRun, 'terminal run should actually be running').not.toBeNull();

    await expect(page).toHaveURL(`/project/${TERMINAL_RUN_PROJECT}/terminal`);
    await expect(page.getByText('live run')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible();

    const runJob = await waitForJobCompletion(request, runBody.job_id, 60_000);
    expect(runJob?.['exit_code'], 'run exit code').toBe(0);
  });

  test('terminal landing page does not auto-attach to a newly-started agent run', async ({
    page,
    request,
  }) => {
    writeScenario(TERMINAL_AGENT_PROJECT, START_SCENARIO.steps);
    resetShimState(TERMINAL_AGENT_PROJECT);
    await enableProject(request, TERMINAL_AGENT_PROJECT, { testsDisabled: true });
    await request.patch('/api/settings', {
      data: { dirty_worktree_block_threshold: 0 },
    });

    await page.goto(`/project/${TERMINAL_AGENT_PROJECT}/terminal`);
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live run')).toHaveCount(0);

    const createAgentResp = await request.post('/api/agents', {
      data: {
        name: 'Idle Watcher',
        project: TERMINAL_AGENT_PROJECT,
        prompt: 'Summarize the current state.',
        skillIds: [],
        enabled: true,
      },
    });
    expect(
      createAgentResp.status(),
      `agent POST failed: ${await createAgentResp.text()}`,
    ).toBe(201);

    const createAgentBody = await createAgentResp.json() as { agent: { id: string } };
    expect(createAgentBody.agent.id, 'agent id in response').toBeTruthy();

    const runAgentResp = await request.post(`/api/agents/${createAgentBody.agent.id}/run`, {
      data: { prompt: 'Run the background agent task.' },
    });
    expect(
      runAgentResp.status(),
      `agent run POST failed: ${await runAgentResp.text()}`,
    ).toBe(200);

    const runAgentBody = await runAgentResp.json() as { job_id: string };
    expect(runAgentBody.job_id, 'agent run job_id in response').toBeTruthy();

    const runningAgent = await waitForJobByIdRunning(request, runAgentBody.job_id, 20_000);
    expect(runningAgent, 'agent run should actually be running').not.toBeNull();

    await expect(page).toHaveURL(`/project/${TERMINAL_AGENT_PROJECT}/terminal`);
    await expect(page.getByText('live run')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible();

    const runJob = await waitForJobCompletion(request, runAgentBody.job_id, 60_000);
    expect(runJob?.['exit_code'], 'agent run exit code').toBe(0);
  });
});
