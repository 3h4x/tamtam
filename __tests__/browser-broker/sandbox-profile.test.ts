import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { ensureBrokerRunning, stopBroker } from '@/lib/browser-broker/container-lifecycle';
import { exec as runShell } from '@/lib/shared/shell';

const isMac = process.platform === 'darwin';
const profilePath = join(process.cwd(), 'scripts', 'sandbox-profiles', 'tamtam-loopback.sb');

async function sandboxedShell(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; stderr: string; stdout: string; exitCode: number }> {
  const runDir = join(tmpdir(), 'tamtam-runs', 'sandbox-test');
  mkdirSync(runDir, { recursive: true });
  const sandboxArgs = [
    '-D', `WORKSPACE=${cwd}`,
    '-D', `HOME_DIR=${homedir()}`,
    '-D', `RUN_DIR=${runDir}`,
    '-f', profilePath,
    cmd, ...args,
  ];
  const r = await runShell('sandbox-exec', sandboxArgs, { cwd, timeout: 10_000 });
  return { ok: r.exitCode === 0, stderr: r.stderr, stdout: r.stdout, exitCode: r.exitCode };
}

const dockerAvailable = await (async () => {
  try {
    const r = await runShell('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5_000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!isMac || !dockerAvailable || !existsSync(profilePath))('sandbox profile', () => {
  afterAll(async () => {
    await stopBroker();
  });

  it('allows loopback to the broker, blocks external network, blocks docker socket', async () => {
    const broker = await ensureBrokerRunning();

    // 1. Loopback to broker must succeed. The MCP endpoint may return a
    //    normal response or hold a long-lived stream open; either way the
    //    printed HTTP status code proves the connection happened. A blocked
    //    connection prints code=000 with exit 7 (couldn't connect).
    const loopback = await sandboxedShell('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', '3',
      broker.mcpUrl,
    ], process.cwd());
    expect(loopback.stdout.trim(), `loopback stderr: ${loopback.stderr}`).toMatch(/^[2345]\d\d$/);

    // 2. External IP must be blocked. curl exits non-zero (network unreachable
    //    or operation timed out — either is acceptable proof of block).
    const external = await sandboxedShell('curl', [
      '-s', '-o', '/dev/null',
      '--max-time', '2',
      'http://1.1.1.1',
    ], process.cwd());
    expect(external.exitCode).not.toBe(0);

    // 3. Docker socket access must be blocked.
    const dockerSock = await sandboxedShell('ls', ['/var/run/docker.sock'], process.cwd());
    expect(dockerSock.exitCode).not.toBe(0);
  }, 180_000);
});
