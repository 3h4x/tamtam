import { test, expect } from '@playwright/test';
import { join } from 'path';
import { CLAUDE_SHIM } from './global-setup';
import {
  writeScenario,
  resetShimState,
  readShimCalls,
  enableProject,
  waitForPipelineCompletion,
  assertGitCallOnce,
} from './helpers';

const PROJECT = 'codex-shim';
const CODEX_SHIM = join(process.cwd(), 'scripts', 'codex-shim.js');

test.describe('Codex shim pipeline', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, [
      { label: 'review', text: 'The implementation looks good.\n\nVerdict: LGTM' },
      { label: 'commit-message', text: 'feat: add codex shim e2e coverage' },
    ]);
    resetShimState(PROJECT);

    await request.patch('/api/settings', {
      data: {
        claude_provider: 'codex',
        claude_bin: CODEX_SHIM,
      },
    });

    await enableProject(request, PROJECT, { testsDisabled: true });
  });

  test.afterAll(async ({ request }) => {
    await request.patch('/api/settings', {
      data: {
        claude_provider: 'claude',
        claude_bin: CLAUDE_SHIM,
      },
    });
  });

  test('release parses Codex item.completed review output and completes commit + push', async ({ request }) => {
    const releaseResp = await request.post(
      `/api/projects/by-project/${PROJECT}/release`,
    );
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const result = await waitForPipelineCompletion(request, PROJECT, 90_000);
    expect(result.status, 'pipeline timed out').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    const jobsResp = await request.get(`/api/jobs?project=${PROJECT}`);
    expect(jobsResp.ok()).toBe(true);
    const { jobs } = await jobsResp.json() as {
      jobs: Array<{
        id: string;
        kind: string;
        exit_code: number | null;
        verdict?: string | null;
        output_tokens?: number | null;
      }>;
    };

    const reviewJob = jobs.find(j => j.kind === 'review');
    expect(reviewJob?.exit_code, 'review exit_code').toBe(0);
    expect(reviewJob?.verdict, 'review verdict').toBe('LGTM');
    expect(reviewJob?.output_tokens, 'review output tokens').toBeGreaterThan(0);

    const reviewResp = await request.get(`/api/jobs/${reviewJob?.id}`);
    expect(reviewResp.ok()).toBe(true);
    const reviewDetail = await reviewResp.json() as { log?: string };
    const reviewLog = reviewDetail.log ?? '';
    expect(reviewLog).toContain('Verdict: LGTM');
    expect(reviewLog).not.toContain('prompt text must not be echoed');

    const calls = readShimCalls(PROJECT);
    assertGitCallOnce(calls, 'add', 'add -A');
    assertGitCallOnce(calls, 'push', 'push');
  });
});
