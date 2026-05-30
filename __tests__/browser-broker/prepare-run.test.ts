import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

describe('prepareBrokerRun', () => {
  let ensureBrokerRunningMock: ReturnType<typeof vi.fn>;
  let writeRunMcpConfigMock: ReturnType<typeof vi.fn>;
  let cleanupRunMcpConfigMock: ReturnType<typeof vi.fn>;
  let stopBrokerMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    ensureBrokerRunningMock = vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:9000',
      mcpUrl: 'http://127.0.0.1:9000/mcp',
    });
    writeRunMcpConfigMock = vi.fn().mockReturnValue({
      runDir: '/tmp/tamtam-runs/job-1',
      claudeConfigPath: '/tmp/tamtam-runs/job-1/mcp.json',
      env: { TAMTAM_MCP_CONFIG_PATH: '/tmp/tamtam-runs/job-1/mcp.json' },
    });
    cleanupRunMcpConfigMock = vi.fn();
    stopBrokerMock = vi.fn().mockResolvedValue(undefined);
    getSettingsMock = vi.fn().mockReturnValue({
      browser_broker_enabled: true,
      browser_broker_image: 'custom/broker:2',
    });

    vi.doMock('@/lib/shared/config', () => ({
      getSettings: getSettingsMock,
    }));
    vi.doMock('@/lib/browser-broker/container-lifecycle', () => ({
      ensureBrokerRunning: ensureBrokerRunningMock,
      stopBroker: stopBrokerMock,
    }));
    vi.doMock('@/lib/browser-broker/origin-allowlist', () => ({
      computeAllowedOrigins: vi.fn().mockReturnValue(['http://localhost:3000']),
    }));
    vi.doMock('@/lib/browser-broker/mcp-config-writer', () => ({
      writeRunMcpConfig: writeRunMcpConfigMock,
      cleanupRunMcpConfig: cleanupRunMcpConfigMock,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the configured broker image through to startup', async () => {
    const { prepareBrokerRun } = await import('@/lib/browser-broker/prepare-run');

    const result = await prepareBrokerRun({
      jobId: 'job-1',
      projectOrigins: { qaUrl: 'http://localhost:3000', devServerReadyUrl: null, website: null },
      provider: 'claude',
    });

    expect(ensureBrokerRunningMock).toHaveBeenCalledWith({ image: 'custom/broker:2' });
    expect(writeRunMcpConfigMock).toHaveBeenCalledWith(expect.objectContaining({
      brokerUrl: 'http://127.0.0.1:9000',
      brokerMcpUrl: 'http://127.0.0.1:9000/mcp',
    }));
    expect(result).toEqual(expect.objectContaining({
      env: { TAMTAM_MCP_CONFIG_PATH: '/tmp/tamtam-runs/job-1/mcp.json' },
      runDir: '/tmp/tamtam-runs/job-1',
    }));
  });

  it('cleans only per-run config so concurrent runs keep the shared broker alive', async () => {
    writeRunMcpConfigMock.mockImplementation(({ jobId }: { jobId: string }) => ({
      runDir: `/tmp/tamtam-runs/${jobId}`,
      claudeConfigPath: `/tmp/tamtam-runs/${jobId}/mcp.json`,
      env: { TAMTAM_MCP_CONFIG_PATH: `/tmp/tamtam-runs/${jobId}/mcp.json` },
    }));
    const { prepareBrokerRun } = await import('@/lib/browser-broker/prepare-run');

    const first = await prepareBrokerRun({
      jobId: 'job-1',
      projectOrigins: { qaUrl: 'http://localhost:3000', devServerReadyUrl: null, website: null },
      provider: 'claude',
    });
    const second = await prepareBrokerRun({
      jobId: 'job-2',
      projectOrigins: { qaUrl: 'http://localhost:3000', devServerReadyUrl: null, website: null },
      provider: 'codex',
    });

    first?.cleanup();
    expect(cleanupRunMcpConfigMock).toHaveBeenCalledWith('job-1');
    expect(stopBrokerMock).not.toHaveBeenCalled();

    second?.cleanup();
    expect(cleanupRunMcpConfigMock).toHaveBeenCalledWith('job-2');
    expect(stopBrokerMock).not.toHaveBeenCalled();
  });
});
