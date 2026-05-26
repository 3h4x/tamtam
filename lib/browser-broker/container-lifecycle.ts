import { exec as runShell } from '@/lib/shared/shell';
import { BROKER_IMAGE, BROKER_MCP_PACKAGE, BROKER_INTERNAL_PORT } from './image';
import { allocatePort } from './port-allocator';

interface BrokerHandle {
  containerId: string;
  containerName: string;
  hostPort: number;
  url: string;
  startedAt: number;
}

declare global {
  var __tamtamBrowserBroker: BrokerHandle | undefined;
  var __tamtamBrowserBrokerStarting: Promise<BrokerHandle> | undefined;
}

// First-run is slow: docker may need to pull the Playwright image (~2GB) and
// `npx -y @playwright/mcp` fetches the package on container start. Cached
// follow-ups settle in ~5–10 s. Keep the ceiling generous so parallel vitest
// runs that compete with each other for docker resources still pass.
const HEALTH_PROBE_TIMEOUT_MS = 120_000;
const HEALTH_PROBE_INTERVAL_MS = 500;

async function dockerAvailable(): Promise<boolean> {
  const res = await runShell('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5_000 });
  return res.exitCode === 0;
}

async function probeBrokerHealth(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/sse`, { method: 'GET', signal: AbortSignal.timeout(1_000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + HEALTH_PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeBrokerHealth(url)) return;
    await new Promise((r) => setTimeout(r, HEALTH_PROBE_INTERVAL_MS));
  }
  throw new Error(`browser-broker: health probe timed out after ${HEALTH_PROBE_TIMEOUT_MS}ms`);
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

  const cmd = [
    'run', '-d', '--rm',
    '--name', name,
    '-p', `127.0.0.1:${hostPort}:${BROKER_INTERNAL_PORT}`,
    '--add-host', 'host.docker.internal:host-gateway',
    image,
    'sh', '-c',
    `npx -y ${BROKER_MCP_PACKAGE} --port ${BROKER_INTERNAL_PORT} --host 0.0.0.0 --headless`,
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
}

export async function ensureBrokerRunning(_opts?: EnsureOptions): Promise<BrokerHandle> {
  const image = _opts?.image?.trim() || BROKER_IMAGE;
  if (globalThis.__tamtamBrowserBroker) {
    if (await probeBrokerHealth(globalThis.__tamtamBrowserBroker.url)) {
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
    try {
      await waitForHealth(url);
    } catch (err) {
      await runShell('docker', ['rm', '-f', name], { timeout: 10_000 });
      throw err;
    }
    const handle: BrokerHandle = {
      containerId: id,
      containerName: name,
      hostPort,
      url,
      startedAt: Date.now(),
    };
    globalThis.__tamtamBrowserBroker = handle;
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
