import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { APIRequestContext } from '@playwright/test';
import { SHIM_DIR } from './global-setup';

// ---------------------------------------------------------------------------
// Scenario + state management
// ---------------------------------------------------------------------------

export function writeScenario(project: string, steps: Array<{ label?: string; text: string }>): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps }));
}

export function resetShimState(project: string): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git-state.json'), JSON.stringify({ committed: false, pushed: false }));
  writeFileSync(join(dir, 'git-calls.jsonl'), '');
  writeFileSync(join(dir, 'counter'), '0');
}

// ---------------------------------------------------------------------------
// Calls log
// ---------------------------------------------------------------------------

export interface ShimCall {
  args: string[];
  ts: number;
  cmd?: string;
}

export function readShimCalls(project: string): ShimCall[] {
  const callsFile = join(SHIM_DIR, project, 'git-calls.jsonl');
  try {
    return readFileSync(callsFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as ShimCall);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Project configuration
// ---------------------------------------------------------------------------

export async function enableProject(
  request: APIRequestContext,
  project: string,
  opts: { testsDisabled?: boolean; autoPushEnabled?: boolean } = {},
): Promise<void> {
  // PATCH the project in the config API (enables it + sets flags)
  await request.patch('/api/config/projects', {
    data: {
      projects: [
        {
          project,
          enabled: true,
          tests_disabled: opts.testsDisabled ?? true,
          auto_push_enabled: opts.autoPushEnabled ?? false,
          review_disabled: false,
          auto_commit_enabled: false,
          pr_workflow_enabled: false,
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Pipeline completion polling
// ---------------------------------------------------------------------------

export interface PipelineResult {
  status: 'done' | 'timeout';
  releaseJob?: Record<string, unknown>;
}

/**
 * Polls the jobs API until the project's active release job reaches a
 * finished state (finishedAt != null) or the timeout expires.
 */
export async function waitForPipelineCompletion(
  request: APIRequestContext,
  project: string,
  timeoutMs = 60_000,
): Promise<PipelineResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await request.get(`/api/jobs?project=${encodeURIComponent(project)}`);
    if (resp.ok()) {
      const body = await resp.json() as { jobs: Array<Record<string, unknown>> };
      const releaseJob = body.jobs?.find(
        j => j['kind'] === 'release' && j['project'] === project,
      );
      if (releaseJob && releaseJob['finished_at'] != null) {
        return { status: 'done', releaseJob };
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { status: 'timeout' };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export function assertGitCallOnce(
  calls: ShimCall[],
  subcommand: string,
  description = subcommand,
): void {
  const matching = calls.filter(c => c.args.includes(subcommand));
  if (matching.length !== 1) {
    throw new Error(
      `Expected exactly 1 git ${description} call, got ${matching.length}.\n` +
      `All calls: ${calls.map(c => c.args.join(' ')).join(', ')}`,
    );
  }
}
