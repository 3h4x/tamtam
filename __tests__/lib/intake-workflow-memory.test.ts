import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeParams(readOnly: boolean) {
  return {
    jobId: 'job-1',
    agentId: 'agent-1',
    agentName: 'cto',
    project: 'proj1',
    projPath: '/tmp/proj1',
    skillIds: [],
    docPaths: [],
    model: null,
    taskPrompt: 'plan the issue',
    triggeredBy: 'manual',
    provider: 'claude',
    fallbackEnabled: false,
    logPath: '/tmp/logs/job-1.log',
    logDir: '/tmp/logs',
    baseContextMeta: JSON.stringify({ agent: { id: 'agent-1', name: 'cto' } }),
    prereqCmd: null,
    readOnly,
  };
}

describe('runAgentIntakeWorkflow memory composition', () => {
  let ensureAgentMemoryDirMock: ReturnType<typeof vi.fn>;
  let getAgentMemoryPathMock: ReturnType<typeof vi.fn>;
  let readAgentMemoryMock: ReturnType<typeof vi.fn>;
  let buildMemoryBlockMock: ReturnType<typeof vi.fn>;
  let startInProcessAgentJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let prepareBrokerRunMock: ReturnType<typeof vi.fn>;
  let brokerCleanupMock: ReturnType<typeof vi.fn>;

  async function importWorkflow() {
    const mod = await import('@/lib/agents/intake-workflow');
    return mod.runAgentIntakeWorkflow;
  }

  beforeEach(() => {
    vi.resetModules();
    ensureAgentMemoryDirMock = vi.fn();
    getAgentMemoryPathMock = vi.fn().mockReturnValue('/tmp/proj1/.tamtam/cache/agent-memory/cto.md');
    readAgentMemoryMock = vi.fn().mockReturnValue({ content: 'prior memory', truncated: false, rawChars: 12 });
    buildMemoryBlockMock = vi.fn().mockReturnValue('## Your Persistent Memory\nprior memory');
    startInProcessAgentJobMock = vi.fn().mockResolvedValue(12345);
    updateJobMock = vi.fn();
    brokerCleanupMock = vi.fn();
    prepareBrokerRunMock = vi.fn().mockResolvedValue({
      env: { TAMTAM_BROKER_URL: 'http://127.0.0.1:9000' },
      runDir: '/tmp/tamtam-runs/job-1',
      cleanup: brokerCleanupMock,
    });
    startInProcessAgentJobMock = vi.fn().mockImplementation(async (_jobId: string, _cmd: string, _prompt: string, _cwd: string, options?: { cleanup?: () => void }) => {
      options?.cleanup?.();
      return 12345;
    });

    vi.doMock('@/lib/agents/compose-skills', () => ({
      composeAgentSkills: vi.fn().mockResolvedValue({ docParts: [], parts: [], metaSkills: [], metaDocs: [] }),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ stdout: 'HEAD\n', stderr: '', exitCode: 0 }),
    }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({
      loadFileConfig: vi.fn().mockReturnValue({}),
    }));
    vi.doMock('@/lib/skills/auto-attach-docs', () => ({
      resolveAutoAttachedDocs: vi.fn().mockReturnValue([]),
      formatAutoAttachedDocsBlock: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/agents/agent-memory', () => ({
      ensureAgentMemoryDir: ensureAgentMemoryDirMock,
      getAgentMemoryPath: getAgentMemoryPathMock,
      readAgentMemoryDetailed: readAgentMemoryMock,
      buildMemoryBlock: buildMemoryBlockMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      withBasePrompt: (prompt: string) => prompt,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getSettings: vi.fn().mockReturnValue({
        retrieval_enabled: false,
        permission_mode: 'bypassPermissions',
        browser_broker_enabled: true,
        cli_bin_claude: '',
        cli_bin_codex: '',
        cli_bin_gemini: '',
        cli_bin_lmstudio: '',
        claude_bin: 'claude',
        base_prompt: '',
      }),
    }));
    vi.doMock('@/lib/shared/cli-bin', () => ({
      resolveCliBin: vi.fn().mockReturnValue('claude'),
      resolveCliEnv: vi.fn().mockReturnValue({}),
    }));
    vi.doMock('@/lib/browser-broker/prepare-run', () => ({
      prepareBrokerRun: prepareBrokerRunMock,
    }));
    vi.doMock('@/lib/agents/issue-cruncher', () => ({
      hasIssueCruncherSkill: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: vi.fn().mockReturnValue({
        id: 'job-1',
        project: 'proj1',
        kind: 'agent:cto',
        contextMeta: '{}',
        finishedAt: null,
        exitCode: null,
        logPath: '/tmp/logs/job-1.log',
      }),
      updateJob: updateJobMock,
      markDone: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/jobs/inline-agent', () => ({
      startInProcessAgentJob: startInProcessAgentJobMock,
    }));
    vi.doMock('@/lib/db', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      },
      schema: { projects: { name: 'name' } },
    }));
    vi.doMock('drizzle-orm', () => ({
      eq: vi.fn(),
    }));
  });

  it('does not create or inject agent memory for read-only runs', async () => {
    const runAgentIntakeWorkflow = await importWorkflow();

    await runAgentIntakeWorkflow(makeParams(true));

    expect(ensureAgentMemoryDirMock).not.toHaveBeenCalled();
    expect(getAgentMemoryPathMock).not.toHaveBeenCalled();
    expect(readAgentMemoryMock).not.toHaveBeenCalled();
    expect(buildMemoryBlockMock).not.toHaveBeenCalled();
    expect(startInProcessAgentJobMock).toHaveBeenCalledOnce();
    const fullPrompt = startInProcessAgentJobMock.mock.calls[0]?.[2] as string;
    expect(fullPrompt).not.toContain('Your Persistent Memory');
  });

  it('creates and injects agent memory for writable runs', async () => {
    const runAgentIntakeWorkflow = await importWorkflow();

    await runAgentIntakeWorkflow(makeParams(false));

    expect(ensureAgentMemoryDirMock).toHaveBeenCalledWith('/tmp/proj1');
    expect(getAgentMemoryPathMock).toHaveBeenCalledWith('/tmp/proj1', 'cto');
    expect(readAgentMemoryMock).toHaveBeenCalledWith('/tmp/proj1', 'cto');
    expect(buildMemoryBlockMock).toHaveBeenCalledWith(
      '/tmp/proj1/.tamtam/cache/agent-memory/cto.md',
      'prior memory',
      { truncated: false, rawChars: 12 },
    );
    expect(startInProcessAgentJobMock).toHaveBeenCalledOnce();
    const fullPrompt = startInProcessAgentJobMock.mock.calls[0]?.[2] as string;
    expect(fullPrompt).toContain('Your Persistent Memory');
    expect(brokerCleanupMock).toHaveBeenCalledOnce();
  });

  it('continues without broker injection when broker prep fails', async () => {
    prepareBrokerRunMock.mockRejectedValueOnce(new Error('boom'));
    const runAgentIntakeWorkflow = await importWorkflow();

    await runAgentIntakeWorkflow(makeParams(false));

    expect(startInProcessAgentJobMock).toHaveBeenCalledOnce();
    const options = startInProcessAgentJobMock.mock.calls[0]?.[4] as { env?: Record<string, string> } | undefined;
    expect(options?.env?.TAMTAM_BROKER_URL).toBeUndefined();
    expect(brokerCleanupMock).not.toHaveBeenCalled();
  });
});
