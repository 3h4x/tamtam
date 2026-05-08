import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { APIRequestContext } from '@playwright/test';
import { SHIM_DIR, WORKSPACE_DIR } from './global-setup';

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
  writeFileSync(join(dir, 'timing.json'), JSON.stringify({}));
}

export function writeGitTiming(
  project: string,
  timings: Partial<Record<'add' | 'commit' | 'push', number>>,
): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'timing.json'), JSON.stringify(timings));
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
  // Step 1: register (or update) the project in the DB with its path.
  // PATCH /api/config/projects expects { name, path, enabled } — must include path or
  // SQLite rejects the insert due to the NOT NULL constraint.
  await request.patch('/api/config/projects', {
    data: {
      projects: [{ name: project, path: join(WORKSPACE_DIR, project), enabled: true }],
    },
  });

  // Step 2: set per-project pipeline flags via the project config endpoint.
  await request.patch(`/api/projects/by-project/${encodeURIComponent(project)}/config`, {
    data: {
      tests_disabled: opts.testsDisabled ?? true,
      auto_push_enabled: opts.autoPushEnabled ?? false,
      review_disabled: false,
      auto_commit_enabled: false,
      pr_workflow_enabled: false,
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

/**
 * Polls until a job of the given kind is running (finishedAt == null) for the
 * given project, or the timeout expires. Returns the job record or null.
 */
export async function waitForJobRunning(
  request: APIRequestContext,
  project: string,
  kind: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await request.get(`/api/jobs?project=${encodeURIComponent(project)}`);
    if (resp.ok()) {
      const body = await resp.json() as { jobs: Array<Record<string, unknown>> };
      const job = body.jobs?.find(
        j => j['kind'] === kind && j['project'] === project && j['finished_at'] == null,
      );
      if (job) return job;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

/**
 * Polls a specific job ID until it has a non-null finished_at, or times out.
 */
export async function waitForJobCompletion(
  request: APIRequestContext,
  jobId: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await request.get(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (resp.ok()) {
      // GET /api/jobs/[jobId] returns the job dict directly (not wrapped).
      const job = await resp.json() as Record<string, unknown>;
      if (job['finished_at'] != null) return job;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

/**
 * Polls a specific job ID until it is running (finished_at == null), or times out.
 */
export async function waitForJobByIdRunning(
  request: APIRequestContext,
  jobId: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await request.get(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (resp.ok()) {
      const job = await resp.json() as Record<string, unknown>;
      if (job['finished_at'] == null) return job;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
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
