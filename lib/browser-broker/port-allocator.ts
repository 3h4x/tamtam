import { createServer } from 'net';

const EPHEMERAL_RANGE_START = 49152;
const EPHEMERAL_RANGE_END = 65535;
const MAX_ATTEMPTS = 8;

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

function randomEphemeral(): number {
  const span = EPHEMERAL_RANGE_END - EPHEMERAL_RANGE_START + 1;
  return EPHEMERAL_RANGE_START + Math.floor(Math.random() * span);
}

export async function allocatePort(): Promise<number> {
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const candidate = randomEphemeral();
    if (await probePort(candidate)) return candidate;
  }
  throw new Error('allocatePort: could not find a free loopback port after multiple attempts');
}
