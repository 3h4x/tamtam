export interface ProjectOriginInput {
  qaUrl?: string | null;
  devServerReadyUrl?: string | null;
  website?: string | null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

function toOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function dockerInternalSwap(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (!LOOPBACK_HOSTS.has(u.hostname)) return null;
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol}//host.docker.internal${port}`;
  } catch {
    return null;
  }
}

// The broker, running inside docker, cannot reach `localhost`/`127.0.0.1` of
// the host directly. Every loopback origin gets a `host.docker.internal` twin
// appended so the agent can request `http://localhost:3000` (the natural URL)
// while the broker actually navigates to `http://host.docker.internal:3000`.
export function computeAllowedOrigins(input: ProjectOriginInput): string[] {
  const out = new Set<string>();
  for (const raw of [input.qaUrl, input.devServerReadyUrl, input.website]) {
    const origin = toOrigin(raw);
    if (!origin) continue;
    out.add(origin);
    const twin = dockerInternalSwap(origin);
    if (twin) out.add(twin);
  }
  return [...out];
}
