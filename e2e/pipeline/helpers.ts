import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { APIRequestContext } from '@playwright/test';
import { SHIM_DIR, WORKSPACE_DIR } from './global-setup';

// ---------------------------------------------------------------------------
// Scenario + state management
// ---------------------------------------------------------------------------

export function writeScenario(
  project: string,
  steps: Array<{
    label?: string;
    sleep_ms?: number;
    text: string;
    write_files?: Array<{ path: string; content: string }>;
    prompt_assert_contains?: string[];
    prompt_assert_not_contains?: string[];
    prompt_capture?: Array<{ label: string; regex: string; flags?: string; group?: number }>;
  }>,
): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps }));
}

export function resetShimState(project: string): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git-state.json'), JSON.stringify({ committed: false, pushed: false }));
  writeFileSync(join(dir, 'git-branch'), 'master');
  writeFileSync(join(dir, 'git-merged-branches.json'), JSON.stringify([]));
  writeFileSync(join(dir, 'git-calls.jsonl'), '');
  writeFileSync(join(dir, 'counter'), '0');
  writeFileSync(join(dir, 'timing.json'), JSON.stringify({}));
  writeFileSync(join(dir, 'git-failures.json'), JSON.stringify({}));
  writeFileSync(join(dir, 'gh-open-pr.json'), JSON.stringify(null));
  writeFileSync(join(dir, 'gh-pr-statuses.json'), JSON.stringify([]));
  writeFileSync(join(dir, 'gh-pr-status-index'), '0');
}

export function writeGitTiming(
  project: string,
  timings: Partial<Record<'add' | 'commit' | 'push', number>>,
): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'timing.json'), JSON.stringify(timings));
}

export function writeGitFailures(
  project: string,
  failures: Partial<Record<
    'add' | 'checkout' | 'commit' | 'push',
    { exitCode?: number; stderr?: string; stdout?: string; matchArgs?: string[]; once?: boolean }
  >>,
): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git-failures.json'), JSON.stringify(failures));
}

export function writeGitBranch(project: string, branch: string): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git-branch'), branch);
}

export function readGitBranch(project: string): string {
  const branchFile = join(SHIM_DIR, project, 'git-branch');
  try {
    return readFileSync(branchFile, 'utf-8').trim() || 'master';
  } catch {
    return 'master';
  }
}

export function writeGitMergedBranches(project: string, branches: string[]): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git-merged-branches.json'), JSON.stringify(branches));
}

export function writeGhPrStatuses(
  project: string,
  statuses: Array<{
    state: string;
    mergeable: string;
    statusCheckRollup: Array<Record<string, unknown>>;
  }>,
): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gh-pr-statuses.json'), JSON.stringify(statuses));
  writeFileSync(join(dir, 'gh-pr-status-index'), '0');
}

export function writeGhOpenPr(
  project: string,
  pr: {
    url: string;
    number?: number;
    headBranch?: string;
    title?: string;
    body?: string;
    state?: string;
    author?: { login: string };
  } | null,
): void {
  const dir = join(SHIM_DIR, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gh-open-pr.json'), JSON.stringify(pr));
}

// ---------------------------------------------------------------------------
// Calls log
// ---------------------------------------------------------------------------

export interface ShimCall {
  args: string[];
  ts: number;
  cmd?: string;
  result?: string;
}

export interface ShimState {
  committed: boolean;
  pushed: boolean;
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

export function readShimState(project: string): ShimState {
  const stateFile = join(SHIM_DIR, project, 'git-state.json');
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8')) as ShimState;
  } catch {
    return { committed: false, pushed: false };
  }
}

// ---------------------------------------------------------------------------
// Project configuration
// ---------------------------------------------------------------------------

export async function enableProject(
  request: APIRequestContext,
  project: string,
  opts: { testsDisabled?: boolean; autoPushEnabled?: boolean; autoPrMergeEnabled?: boolean } = {},
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
      auto_pr_merge_enabled: opts.autoPrMergeEnabled ?? false,
      review_disabled: false,
      auto_commit_enabled: false,
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
