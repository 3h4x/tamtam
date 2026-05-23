import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TamTamConfig } from '@/lib/shared/config';
import { ProviderNotConfiguredError } from '@/lib/usage/quota-types';

const mocks = vi.hoisted(() => ({
  dbExecuteMock: vi.fn(),
  dbSelectMock: vi.fn(),
  execMock: vi.fn(),
  getSettingsMock: vi.fn(),
  resolveCliBinMock: vi.fn(),
  resolveCliEnvMock: vi.fn(),
  listEnabledProjectsMock: vi.fn(),
  getQuotaForProviderMock: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    execute: mocks.dbExecuteMock,
    select: mocks.dbSelectMock,
  },
  schema: {
    projects: {
      autoPushEnabled: 'auto_push_enabled',
      archived: 'archived',
      enabled: 'enabled',
    },
  },
}));

vi.mock('@/lib/shared/shell', () => ({ exec: mocks.execMock }));
vi.mock('@/lib/shared/config', () => ({ getSettings: mocks.getSettingsMock }));
vi.mock('@/lib/shared/cli-bin', () => ({
  resolveCliBin: mocks.resolveCliBinMock,
  resolveCliEnv: mocks.resolveCliEnvMock,
}));
vi.mock('@/lib/shared/enabled-projects', () => ({
  listEnabledProjects: mocks.listEnabledProjectsMock,
}));
vi.mock('@/lib/usage/quota', () => ({
  getQuotaForProvider: mocks.getQuotaForProviderMock,
}));

function settings(tempDir: string, overrides: Partial<TamTamConfig> = {}): TamTamConfig {
  return {
    workspace_path: tempDir,
    cli_enabled_providers: ['claude'],
    budget_block_runs_enabled: false,
    ...overrides,
  } as TamTamConfig;
}

function makeExecutable(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}

function makeNonExecutable(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(file, 0o644);
  return file;
}

describe('readiness checks', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-readiness-'));
    mocks.dbExecuteMock.mockReset();
    mocks.dbExecuteMock.mockResolvedValue([]);
    mocks.dbSelectMock.mockReset();
    mocks.dbSelectMock.mockReturnValue({ from: vi.fn().mockResolvedValue([]) });
    mocks.execMock.mockReset();
    mocks.execMock.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });
    mocks.getSettingsMock.mockReset();
    mocks.getSettingsMock.mockReturnValue(settings(tempDir));
    mocks.resolveCliBinMock.mockReset();
    mocks.resolveCliBinMock.mockReturnValue(makeExecutable(tempDir, 'claude-shim'));
    mocks.resolveCliEnvMock.mockReset();
    mocks.resolveCliEnvMock.mockReturnValue({ CLAUDE_BIN: makeExecutable(tempDir, 'claude') });
    mocks.listEnabledProjectsMock.mockReset();
    mocks.listEnabledProjectsMock.mockReturnValue([{ name: 'proj', path: tempDir }]);
    mocks.getQuotaForProviderMock.mockReset();
    mocks.getQuotaForProviderMock.mockResolvedValue({
      provider: 'claude',
      fiveHour: { utilization: 1, resetsAt: null, msUntilReset: null },
      sevenDay: { utilization: 1, resetsAt: null, msUntilReset: null },
      fetchedAt: 1,
      stale: false,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails when the configured provider binary is missing', async () => {
    mocks.resolveCliEnvMock.mockReturnValue({ CLAUDE_BIN: join(tempDir, 'missing-claude') });
    const { getReadinessReport } = await import('@/lib/shared/readiness');

    const report = await getReadinessReport({ projectName: 'proj', provider: 'claude', includeQuota: false });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'provider:claude',
      ok: false,
      severity: 'error',
    }));
  });

  it('fails when the provider shim exists but is not executable', async () => {
    const shim = makeNonExecutable(tempDir, 'claude-shim-not-executable');
    mocks.resolveCliBinMock.mockReturnValue(shim);
    const { getReadinessReport } = await import('@/lib/shared/readiness');

    const report = await getReadinessReport({ projectName: 'proj', provider: 'claude', includeQuota: false });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'provider:claude',
      ok: false,
      severity: 'error',
      message: `Configured claude shim is not executable: ${shim}`,
    }));
  });

  it('reports quota unavailability as a warning without failing unrelated checks', async () => {
    mocks.getSettingsMock.mockReturnValue(settings(tempDir, { budget_block_runs_enabled: true }));
    mocks.getQuotaForProviderMock.mockRejectedValue(new ProviderNotConfiguredError('claude', 'No Claude OAuth token found'));
    const { getReadinessReport } = await import('@/lib/shared/readiness');

    const report = await getReadinessReport({ projectName: 'proj', provider: 'claude' });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'quota:claude',
      ok: false,
      severity: 'warn',
      message: 'No Claude OAuth token found',
    }));
  });
});
