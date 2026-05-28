import { describe, it, expect, afterAll } from 'vitest';
import { ensureBrokerRunning, stopBroker } from '@/lib/browser-broker/container-lifecycle';
import { exec as runShell } from '@/lib/shared/shell';

const dockerAvailable = await (async () => {
  try {
    const r = await runShell('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5_000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerAvailable)('browser-broker smoke', () => {
  afterAll(async () => {
    await stopBroker();
  });

  it('starts a broker, exposes loopback MCP, stops cleanly', async () => {
    const handle = await ensureBrokerRunning();
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/(?:mcp|sse)$/);

    const probe = await fetch(handle.mcpUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    expect(probe).not.toBeNull();
    expect(probe!.status).toBeLessThan(500);
  }, 180_000);
});
