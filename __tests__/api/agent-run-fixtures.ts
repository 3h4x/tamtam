import { vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

// ------------------------------------------------------------------
// Hoisted mock state — shared across all tests; replaces the per-test
// `vi.resetModules()` + `vi.doMock()` pattern that previously rebuilt the
// whole module graph (and re-spawned git) for every test (~50ms each).
// ------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  return {
    db: null as unknown,
    startJob: vi.fn(),
    resolveProjectPath: vi.fn(),
    createJob: vi.fn(),
    updateJob: vi.fn(),
    listJobs: vi.fn(),
    probeJobStatus: vi.fn(),
    markDone: vi.fn(),
    getJob: vi.fn(),
    shellRun: vi.fn(),
    runGates: vi.fn(),
    enqueueAgentRun: vi.fn(),
    enqueueQueuedAgentRun: vi.fn(),
    drainNextAgentRun: vi.fn(),
    tryClaimAgentStartSlot: vi.fn(),
    checkCliStartGate: vi.fn(),
    findBlockingRunningJob: vi.fn(),
    getLock: vi.fn(),
    isLockOwnedByActiveRelease: vi.fn(),
    getPendingRelease: vi.fn(),
    drainPendingRelease: vi.fn(),
    drainProjectRecoveryWork: vi.fn(),
    isProjectPaused: vi.fn(),
    retrieveAgentContextDetailed: vi.fn(),
    runSystemAgent: vi.fn(),
    ensureDevServerRunning: vi.fn(),
    getDirtyFileCount: vi.fn(),
    getQuotaSnapshots: vi.fn(),
    getSettings: vi.fn(),
    getImproveConfig: vi.fn(),
    getProjectTestConfig: vi.fn(),
    checkDailySpendCap: vi.fn(async (_projectName?: string) => ({ ok: true })),
    notify: vi.fn(async (_payload?: unknown) => undefined),
    skillsDir: '',
    dataSkillsDir: '',
    // The first describe block fully mocks `checkCliStartGate`, but the
    // second describe ("weekly quota gating") must let the *real*
    // `resolve-provider` module branch off `getQuotaSnapshots`. This flag
    // toggles between the two.
    useRealResolveProvider: false,
  };
});

export { mocks };

// ------------------------------------------------------------------
// Top-level mocks (resolved at module-graph load time, ONCE per worker).
// ------------------------------------------------------------------
vi.mock('@/lib/db', () => ({
  get db() { return mocks.db; },
  schema,
}));

vi.mock('workflow/api', () => ({
  start: async (fn: (p: unknown) => Promise<void>, args: unknown[]) => {
    await fn(args[0]);
    return { runId: 'mock-run-id' };
  },
}));

vi.mock('@/lib/agents/pending-agent-run', () => ({
  enqueueAgentRun: (...a: unknown[]) => mocks.enqueueAgentRun(...a),
  tryClaimAgentStartSlot: (...a: unknown[]) => mocks.tryClaimAgentStartSlot(...a),
  releaseAgentStartSlot: vi.fn(),
  drainNextAgentRun: (...a: unknown[]) => mocks.drainNextAgentRun(...a),
}));

vi.mock('@/lib/agents/queued-agent-runs', () => ({
  enqueueQueuedAgentRun: (...a: unknown[]) => mocks.enqueueQueuedAgentRun(...a),
}));

vi.mock('@/lib/pipeline/pipeline-lock', () => ({
  getLock: (...a: unknown[]) => mocks.getLock(...a),
  isLockOwnedByActiveRelease: (...a: unknown[]) => mocks.isLockOwnedByActiveRelease(...a),
}));

vi.mock('@/lib/pipeline/pending-release', () => ({
  getPendingRelease: (...a: unknown[]) => mocks.getPendingRelease(...a),
  drainPendingRelease: (...a: unknown[]) => mocks.drainPendingRelease(...a),
}));

vi.mock('@/lib/pipeline/recovery-drain', () => ({
  drainProjectRecoveryWork: (...a: unknown[]) => mocks.drainProjectRecoveryWork(...a),
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: (...a: unknown[]) => mocks.resolveProjectPath(...a),
}));

vi.mock('@/lib/shared/shell', () => ({
  exec: (...a: unknown[]) => mocks.shellRun(...a),
}));

vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: (...a: unknown[]) => mocks.getImproveConfig(...a),
  getProjectTestConfig: (...a: unknown[]) => mocks.getProjectTestConfig(...a),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: (...a: unknown[]) => mocks.createJob(...a),
  updateJob: (...a: unknown[]) => mocks.updateJob(...a),
  listJobs: (...a: unknown[]) => mocks.listJobs(...a),
  probeJobStatus: (...a: unknown[]) => mocks.probeJobStatus(...a),
  markDone: (...a: unknown[]) => mocks.markDone(...a),
  getJob: (...a: unknown[]) => mocks.getJob(...a),
}));

vi.mock('@/lib/jobs/project-active-job', () => ({
  findBlockingRunningJob: (...a: unknown[]) => mocks.findBlockingRunningJob(...a),
}));


// startAgentStep inside lib/agents/intake-workflow now spawns the CLI in
// process via startInProcessAgentJob. Same call shape as startJob — route
// tests still observe via mocks.startJob.
vi.mock('@/lib/jobs/inline-agent', () => ({
  startInProcessAgentJob: (...a: unknown[]) => mocks.startJob(...a),
}));

vi.mock('@/lib/dev-server/lifecycle', () => ({
  ensureDevServerRunning: (...a: unknown[]) => mocks.ensureDevServerRunning(...a),
}));

vi.mock('@/lib/skills/skills', () => ({
  get SKILLS_DIR() { return mocks.skillsDir; },
  get DATA_SKILLS_DIR() { return mocks.dataSkillsDir; },
}));

vi.mock('@/lib/agents/agent-memory', () => ({
  getAgentMemoryDir: vi.fn().mockReturnValue('/tmp/tamtam-memory'),
  ensureAgentMemoryDir: vi.fn(),
  getAgentMemoryPath: vi.fn().mockReturnValue('/tmp/tamtam-memory/proj1/Test Agent.md'),
  readAgentMemory: vi.fn().mockReturnValue(null),
  readAgentMemoryDetailed: vi.fn().mockReturnValue(null),
  buildMemoryBlock: vi.fn().mockReturnValue(''),
}));

vi.mock('@/lib/shared/config', () => ({
  withBasePrompt: (p: string) => p,
  getPermissionModeFlag: () => '--dangerously-skip-permissions',
  getSettings: (...a: unknown[]) => mocks.getSettings(...a),
}));

vi.mock('@/lib/shared/job-control', () => ({
  runGates: (...a: unknown[]) => mocks.runGates(...a),
  jobsPausedResult: (...a: unknown[]) => mocks.runGates(...a),
}));

// `checkCliStartGate` toggles between the explicit mock (first describe) and
// the real implementation (second describe — to exercise the quota path).
vi.mock('@/lib/usage/resolve-provider', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/usage/resolve-provider')>();
  return {
    ...real,
    checkCliStartGate: (...a: Parameters<typeof real.checkCliStartGate>) =>
      mocks.useRealResolveProvider
        ? real.checkCliStartGate(...a)
        : (mocks.checkCliStartGate as typeof real.checkCliStartGate)(...a),
  };
});

vi.mock('@/lib/agents/retrieval/retriever', () => ({
  retrieveAgentContextDetailed: (...a: unknown[]) => mocks.retrieveAgentContextDetailed(...a),
}));

vi.mock('@/lib/agents/system', () => ({
  getSystemAgentHandler: (name: string) => name === 'documentation-reindex-vectors'
    ? { seed: { name, prompt: '', defaultSchedule: '16h', model: 'normal' }, run: (...a: unknown[]) => mocks.runSystemAgent(...a) }
    : null,
}));

vi.mock('@/lib/git/dirty-worktree', () => ({
  getDirtyFileCount: (...a: unknown[]) => mocks.getDirtyFileCount(...a),
}));

vi.mock('@/lib/shared/enabled-projects', () => ({
  isProjectArchived: vi.fn().mockReturnValue(false),
  isProjectPaused: (...a: unknown[]) => mocks.isProjectPaused(...a),
}));

// Avoid spawning real `git` for file-agent loading on every test (~10–30ms).
vi.mock('@/lib/git/git-branch', () => ({
  getBranchContext: vi.fn().mockReturnValue({
    isDefaultBranch: true,
    currentBranch: 'master',
    defaultBranch: 'master',
  }),
  getDefaultBranchSync: vi.fn().mockReturnValue('master'),
  gitLsTreeSync: vi.fn().mockReturnValue([]),
  gitShowSync: vi.fn().mockReturnValue(null),
}));

// `getQuotaSnapshots` is only consulted by the real `resolve-provider` path
// in the second describe; route-import time still reads it but the value
// doesn't matter unless `useRealResolveProvider` is true.
vi.mock('@/lib/usage/quota', () => ({
  getQuotaSnapshots: (...a: unknown[]) => mocks.getQuotaSnapshots(...a),
}));

vi.mock('@/lib/pipeline/spend-guard', () => ({
  checkDailySpendCap: (projectName: string) => mocks.checkDailySpendCap(projectName),
}));

vi.mock('@/lib/shared/notifications', () => ({
  notify: (payload: unknown) => mocks.notify(payload),
}));

// Top-level imports are safe now that mocks are module-scope.
export let POST: typeof import('@/app/api/agents/[agentId]/run/route').POST;

export async function loadAgentRunRoute(): Promise<typeof POST> {
  const mod = await import('@/app/api/agents/[agentId]/run/route');
  POST = mod.POST;
  return POST;
}

export async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      skill_ids text NOT NULL DEFAULT '[]',
      doc_paths text NOT NULL DEFAULT '[]',
      model text NOT NULL DEFAULT 'normal',
      prompt text NOT NULL DEFAULT '',
      schedule text,
      enabled boolean NOT NULL DEFAULT true,
      boostable boolean NOT NULL DEFAULT true,
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
      permission_mode text,
      kind text NOT NULL DEFAULT 'user',
      role text NOT NULL DEFAULT 'producer',
      autopilot_state text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS projects (
      name text PRIMARY KEY,
      path text NOT NULL,
      enabled boolean DEFAULT false,
      github text,
      priority text,
      custom_actions text,
      test_command text,
      tests_disabled boolean DEFAULT false,
      review_disabled boolean DEFAULT false,
      test_cron_enabled boolean DEFAULT false,
      test_cron_schedule text,
      auto_commit_enabled boolean DEFAULT false,
      auto_push_enabled boolean DEFAULT false,
      auto_pr_merge_enabled boolean DEFAULT false,
      post_merge_watch_minutes integer DEFAULT 0,
      auto_revert_enabled boolean DEFAULT false,
      release_after_run boolean DEFAULT false,
      issue_auto_branch boolean DEFAULT true,
      last_push_error text,
      last_push_at double precision,
      review_prompt_addendum text,
      review_prerequisite_command text,
      fix_prompt_addendum text,
      website text,
      qa_url text,
      dev_server_start_command text,
      dev_server_stop_command text,
      dev_server_ready_url text,
      daily_spend_cap_usd double precision,
      release_spend_cap_usd double precision,
      setup_complete boolean NOT NULL DEFAULT false,
      setup_state text NOT NULL DEFAULT '{}',
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS skills (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      content text NOT NULL DEFAULT '',
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS maintenance_status (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
}

export async function resetAgentRunTables(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries; a single CTE keeps the
  // per-test cleanup to one round-trip.
  await handle.db.execute(sql.raw(
    'TRUNCATE agents, skills, projects, maintenance_status'
  ));
}

export function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-job-id',
    project: 'proj1',
    kind: 'agent:Test Agent',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}
