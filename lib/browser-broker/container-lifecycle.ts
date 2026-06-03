import { exec as runShell } from '@/lib/shared/shell';
import { BROKER_IMAGE, BROKER_INTERNAL_PORT, BROKER_MCP_ENDPOINT_PATHS, BROKER_MCP_PACKAGE } from './image';
import { allocatePort } from './port-allocator';

interface BrokerHandle {
  containerId: string;
  containerName: string;
  hostPort: number;
  url: string;
  mcpUrl: string;
  startedAt: number;
}

declare global {
  var __tamtamBrowserBroker: BrokerHandle | undefined;
  var __tamtamBrowserBrokerStarting: Promise<BrokerHandle> | undefined;
}

// First-run is slow: docker may need to pull the Playwright image. Cached
// follow-ups settle in ~5–10 s. Keep the ceiling generous so parallel vitest
// runs that compete with each other for docker resources still pass.
const HEALTH_PROBE_TIMEOUT_MS = 120_000;
const HEALTH_PROBE_INTERVAL_MS = 500;
const LOG_TAIL_LINES = 80;
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
let brokerShutdownHookInstalled = false;

function installBrokerShutdownHook(): void {
  if (brokerShutdownHookInstalled) return;
  brokerShutdownHookInstalled = true;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void stopBroker().catch((err) => console.error('[browser-broker] shutdown cleanup failed', err));
    });
  }
}

async function dockerAvailable(): Promise<boolean> {
  const res = await runShell('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5_000 });
  return res.exitCode === 0;
}

function brokerMcpUrl(baseUrl: string, endpointPath: string): string {
  return `${baseUrl}${endpointPath}`;
}

function healthyMcpProbeStatus(status: number): boolean {
  return status >= 200 && status < 500 && status !== 404;
}

async function probeBrokerMcpEndpoint(mcpUrl: string): Promise<boolean> {
  try {
    const r = await fetch(mcpUrl, { method: 'GET', signal: AbortSignal.timeout(1_000) });
    return healthyMcpProbeStatus(r.status);
  } catch {
    return false;
  }
}

async function probeBrokerHealth(url: string, endpointPaths: readonly string[] = BROKER_MCP_ENDPOINT_PATHS): Promise<string | null> {
  for (const endpointPath of endpointPaths) {
    const mcpUrl = brokerMcpUrl(url, endpointPath);
    if (await probeBrokerMcpEndpoint(mcpUrl)) return mcpUrl;
  }
  return null;
}

async function containerExitReason(containerName: string): Promise<string | null> {
  const inspect = await runShell(
    'docker',
    ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}} {{.State.Error}}', containerName],
    { timeout: 5_000 },
  );
  if (inspect.exitCode !== 0) return null;

  const [running, exitCode, ...errorParts] = inspect.stdout.trim().split(/\s+/);
  if (running === 'true') return null;

  const error = errorParts.join(' ').trim();
  return `container exited with code ${exitCode || 'unknown'}${error ? ` (${error})` : ''}`;
}

async function containerLogs(containerName: string): Promise<string> {
  const logs = await runShell('docker', ['logs', '--tail', String(LOG_TAIL_LINES), containerName], { timeout: 10_000 });
  if (logs.exitCode !== 0) return logs.stderr.trim() || logs.stdout.trim();
  return [logs.stdout.trim(), logs.stderr.trim()].filter(Boolean).join('\n');
}

async function brokerStartError(message: string, containerName: string): Promise<Error> {
  const logs = await containerLogs(containerName);
  const detail = logs ? `\n--- docker logs ${containerName} (tail ${LOG_TAIL_LINES}) ---\n${logs}` : '';
  return new Error(`browser-broker: ${message}${detail}`);
}

async function waitForHealth(url: string, containerName: string, timeoutMs = HEALTH_PROBE_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mcpUrl = await probeBrokerHealth(url);
    if (mcpUrl) return mcpUrl;
    const exitReason = await containerExitReason(containerName);
    if (exitReason) {
      throw await brokerStartError(exitReason, containerName);
    }
    await new Promise((r) => setTimeout(r, HEALTH_PROBE_INTERVAL_MS));
  }
  throw await brokerStartError(`health probe timed out after ${timeoutMs}ms`, containerName);
}

async function pullImageIfNeeded(image: string): Promise<void> {
  const present = await runShell('docker', ['image', 'inspect', image], { timeout: 5_000 });
  if (present.exitCode === 0) return;
  const pull = await runShell('docker', ['pull', image], { timeout: 300_000 });
  if (pull.exitCode !== 0) {
    throw new Error(`browser-broker: docker pull ${image} failed: ${pull.stderr.trim() || pull.stdout.trim()}`);
  }
}

async function runContainer(hostPort: number, image: string): Promise<{ id: string; name: string }> {
  const name = `tamtam-playwright-broker-${hostPort}`;
  await runShell('docker', ['rm', '-f', name], { timeout: 10_000 });

  const baseArgs = [
    'run', '-d', '-i', '--init',
    '--name', name,
    '-p', `127.0.0.1:${hostPort}:${BROKER_INTERNAL_PORT}`,
    '--add-host', 'host.docker.internal:host-gateway',
  ];
  const serviceArgs = [
    '--port', String(BROKER_INTERNAL_PORT),
    '--host', '0.0.0.0',
    '--browser', 'chromium',
    '--headless',
    '--no-sandbox',
    // Concurrent agent runs collide on the shared chromium profile and the
    // second one errors with `Browser is already in use`. --isolated gives
    // each MCP session its own profile/context.
    '--isolated',
  ];
  const cmd = image === BROKER_IMAGE ? [
    ...baseArgs,
    '--entrypoint', 'node',
    image,
    '/app/cli.js',
    ...serviceArgs,
  ] : [
    ...baseArgs,
    image,
    'sh', '-c',
    `npx -y ${BROKER_MCP_PACKAGE} --port ${BROKER_INTERNAL_PORT} --host 0.0.0.0 --browser chromium --headless --no-sandbox --isolated`,
  ];
  const res = await runShell('docker', cmd, { timeout: 30_000 });
  if (res.exitCode !== 0) {
    throw new Error(`browser-broker: docker run failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return { id: res.stdout.trim(), name };
}

export interface EnsureOptions {
  // Pass nothing in production; tests can override.
  image?: string;
  healthTimeoutMs?: number;
}

export async function ensureBrokerRunning(_opts?: EnsureOptions): Promise<BrokerHandle> {
  const image = _opts?.image?.trim() || BROKER_IMAGE;
  if (globalThis.__tamtamBrowserBroker) {
    const cachedMcpUrl = globalThis.__tamtamBrowserBroker.mcpUrl;
    const mcpUrl = await probeBrokerHealth(globalThis.__tamtamBrowserBroker.url, [
      cachedMcpUrl ? new URL(cachedMcpUrl).pathname : BROKER_MCP_ENDPOINT_PATHS[0],
    ]);
    if (mcpUrl) {
      return globalThis.__tamtamBrowserBroker;
    }
    globalThis.__tamtamBrowserBroker = undefined;
  }
  if (globalThis.__tamtamBrowserBrokerStarting) {
    return globalThis.__tamtamBrowserBrokerStarting;
  }

  const starting = (async () => {
    if (!(await dockerAvailable())) {
      throw new Error('browser-broker: docker is not running or not accessible');
    }
    await pullImageIfNeeded(image);
    const hostPort = await allocatePort();
    const { id, name } = await runContainer(hostPort, image);
    const url = `http://127.0.0.1:${hostPort}`;
    let mcpUrl: string;
    try {
      mcpUrl = await waitForHealth(url, name, _opts?.healthTimeoutMs);
    } catch (err) {
      await runShell('docker', ['rm', '-f', name], { timeout: 10_000 });
      throw err;
    }
    const handle: BrokerHandle = {
      containerId: id,
      containerName: name,
      hostPort,
      url,
      mcpUrl,
      startedAt: Date.now(),
    };
    globalThis.__tamtamBrowserBroker = handle;
    installBrokerShutdownHook();
    return handle;
  })();

  globalThis.__tamtamBrowserBrokerStarting = starting;
  try {
    return await starting;
  } finally {
    globalThis.__tamtamBrowserBrokerStarting = undefined;
  }
}

export async function stopBroker(): Promise<void> {
  const handle = globalThis.__tamtamBrowserBroker;
  if (!handle) return;
  globalThis.__tamtamBrowserBroker = undefined;
  await runShell('docker', ['rm', '-f', handle.containerName], { timeout: 10_000 });
}

export function brokerEndpoint(): string | null {
  return globalThis.__tamtamBrowserBroker?.url ?? null;
}
