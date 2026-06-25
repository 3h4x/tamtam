import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import { mocks, applyDdl, resetAgentRunTables, makeJob, loadAgentRunRoute, POST } from './agent-run-fixtures';

describe('POST /api/agents/{agentId}/run weekly quota gating', () => {
  // Re-uses the module-scope mocks; flips `useRealResolveProvider` so the
  // genuine `checkCliStartGate` runs against our mocked `getQuotaSnapshots`.
  let sharedHandle: TestDbHandle;
  let tempSkillsDir: string;
  let snapshots: Map<CliProvider, QuotaSnapshot | null>;

  const now = Date.now() / 1000;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
    tempSkillsDir = mkdtempSync(join(tmpdir(), 'tamtam-agent-run-weekly-test-'));
    await loadAgentRunRoute();
  });

  afterAll(async () => {
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
    rmSync(tempSkillsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    mocks.useRealResolveProvider = true;
    mocks.db = sharedHandle.db;
    await resetAgentRunTables(sharedHandle);
    mocks.skillsDir = tempSkillsDir;
    mocks.dataSkillsDir = join(tempSkillsDir, 'data-skills');

    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-123',
      name: 'Test Agent',
      project: 'proj1',
      skillIds: '[]',
      model: 'sonnet',
      prompt: 'do something',
      schedule: null,
      enabled: true,
      provider: 'claude',
      createdAt: now,
      updatedAt: now,
    });

    snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 99, resetsAt: null, msUntilReset: null },
        sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
        sevenDayOpus: null,
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 97, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
    ]);

    mocks.startJob.mockReset().mockResolvedValue(12345);
    mocks.createJob.mockReset().mockImplementation(() => makeJob());
    mocks.updateJob.mockReset();
    mocks.listJobs.mockReset().mockReturnValue([]);
    mocks.probeJobStatus.mockReset().mockResolvedValue('done');
    mocks.markDone.mockReset().mockResolvedValue(undefined);
    mocks.getJob.mockReset().mockImplementation(() => makeJob());
    mocks.resolveProjectPath.mockReset().mockReturnValue('/path/to/proj');
    mocks.runGates.mockReset().mockReturnValue(null);
    mocks.enqueueAgentRun.mockReset();
    mocks.enqueueQueuedAgentRun.mockReset();
    mocks.drainNextAgentRun.mockReset().mockResolvedValue(undefined);
    mocks.tryClaimAgentStartSlot.mockReset().mockReturnValue({ ok: true });
    mocks.findBlockingRunningJob.mockReset().mockResolvedValue(null);
    mocks.getLock.mockReset().mockReturnValue(null);
    mocks.isLockOwnedByActiveRelease.mockReset().mockReturnValue(false);
    mocks.getPendingRelease.mockReset().mockReturnValue(false);
    mocks.drainPendingRelease.mockReset().mockResolvedValue(undefined);
    mocks.drainProjectRecoveryWork.mockReset().mockResolvedValue(undefined);
    mocks.isProjectPaused.mockReset().mockReturnValue(false);
    mocks.getDirtyFileCount.mockReset().mockResolvedValue(0);
    mocks.shellRun.mockReset().mockImplementation(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mocks.getQuotaSnapshots.mockReset().mockImplementation(() => Promise.resolve(snapshots));
    mocks.getSettings.mockReset().mockImplementation(() => ({
      workspace_path: '',
      github_owner: '',
      claude_bin: 'claude',
      log_dir: '/tmp/logs',
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
      cli_bin_claude: '',
      cli_bin_codex: '',
      cli_bin_gemini: '',
      cli_bin_lmstudio: '',
      frequency: '1h',
      daytime: false,
      weekends: false,
      launchagent_prefix: 'com.tamtam',
      base_prompt: '',
      permission_mode: 'bypassPermissions',
      dirty_worktree_block_threshold: 0,
    }));
    mocks.getImproveConfig.mockReset().mockImplementation(() => ({ claudeBin: 'claude', logDir: '/tmp/logs' }));
    mocks.getProjectTestConfig.mockReset().mockReturnValue(null);
    mocks.checkDailySpendCap.mockReset().mockResolvedValue({ ok: true });
    mocks.notify.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(join(tempSkillsDir, 'docs'), { recursive: true, force: true });
  });

  it('does not 429 a manual agent run when only weekly quota is hot', async () => {
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);
    expect(mocks.startJob).toHaveBeenCalledOnce();
    expect(mocks.createJob.mock.results[0]?.value.provider).toBe('claude');
  });

  it('returns 429 when a sibling quota-aware provider is missing and the known provider is over the hard cap', async () => {
    snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 99, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', null],
    ]);
    mocks.getQuotaSnapshots.mockImplementation(() => Promise.resolve(snapshots));
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();
    expect(res.status).toBe(429);
    expect(data.code).toBe('providers_over_budget');
    expect(data.detail).toContain("Selected provider 'claude' is over budget right now");
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('returns 429 for a scheduled pinned-provider agent projected over weekly pace', async () => {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    await sharedHandle.db.execute(sql.raw("UPDATE agents SET schedule = '1h' WHERE id = 'agent-123'"));
    mocks.getSettings.mockImplementation(() => ({
      workspace_path: '',
      github_owner: '',
      claude_bin: 'claude',
      log_dir: '/tmp/logs',
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
      budget_block_on_weekly_pace_enabled: true,
      cli_bin_claude: '',
      cli_bin_codex: '',
      cli_bin_gemini: '',
      cli_bin_lmstudio: '',
      frequency: '1h',
      daytime: false,
      weekends: false,
      launchagent_prefix: 'com.tamtam',
      base_prompt: '',
      permission_mode: 'bypassPermissions',
      dirty_worktree_block_threshold: 0,
    }));
    snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 11, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 40, resetsAt: null, msUntilReset: weekMs - 50 * 60 * 60 * 1000 },
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 5, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: weekMs - 50 * 60 * 60 * 1000 },
        fetchedAt: 0,
        stale: false,
      }],
    ]);
    mocks.getQuotaSnapshots.mockImplementation(() => Promise.resolve(snapshots));

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(429);
    expect(data.code).toBe('providers_over_budget');
    expect(data.detail).toContain("Selected provider 'claude' is over budget right now");
    expect(mocks.startJob).not.toHaveBeenCalled();
  });
});
