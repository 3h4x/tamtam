import { homedir } from 'os';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { exec } from '@/lib/shared/shell';

export interface QuotaWindow {
  utilization: number;
  resetsAt: string | null;
  msUntilReset: number | null;
}

export interface QuotaSnapshot {
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  sevenDaySonnet?: QuotaWindow | null;
  sevenDayOpus?: QuotaWindow | null;
  extra?: {
    isEnabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
    utilization: number | null;
    currency: string | null;
  };
  fetchedAt: number;
  stale: boolean;
}

interface CacheState {
  snapshot: QuotaSnapshot | null;
  fetchedAt: number;
  retryAfterMs: number;
  inFlight: Promise<QuotaSnapshot> | null;
}

const TTL_MS = 180_000;
const FETCH_TIMEOUT_MS = 5_000;

const globalAny = globalThis as unknown as { __tamtamQuota?: CacheState };
function getCache(): CacheState {
  if (!globalAny.__tamtamQuota) {
    globalAny.__tamtamQuota = { snapshot: null, fetchedAt: 0, retryAfterMs: 0, inFlight: null };
  }
  return globalAny.__tamtamQuota;
}

export async function readOauthToken(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout, exitCode } = await exec(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 3000 }
      );
      if (exitCode === 0 && stdout.trim()) {
        const tok = parseTokenFromCredentials(stdout.trim());
        if (tok) return tok;
      }
    } catch {
      /* fall through to file fallback */
    }
  }

  const candidates = [
    join(homedir(), '.claude', '.credentials.json'),
    join(homedir(), '.claude', 'config', '.credentials.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      const tok = parseTokenFromCredentials(raw);
      if (tok) return tok;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

function parseTokenFromCredentials(raw: string): string | null {
  try {
    const json = JSON.parse(raw);
    const tok = json?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok.length > 0 ? tok : null;
  } catch {
    return null;
  }
}

interface RawWindow {
  utilization?: number;
  resets_at?: string | null;
}

interface RawUsageResponse {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  seven_day_sonnet?: RawWindow | null;
  seven_day_opus?: RawWindow | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    utilization?: number | null;
    currency?: string | null;
  };
}

function toWindow(raw: RawWindow | null | undefined, now: number): QuotaWindow {
  const utilization = typeof raw?.utilization === 'number' ? raw.utilization : 0;
  const resetsAt = raw?.resets_at ?? null;
  let msUntilReset: number | null = null;
  if (resetsAt) {
    const ts = Date.parse(resetsAt);
    if (!Number.isNaN(ts)) msUntilReset = Math.max(0, ts - now);
  }
  return { utilization, resetsAt, msUntilReset };
}

function toOptionalWindow(raw: RawWindow | null | undefined, now: number): QuotaWindow | null {
  if (!raw) return null;
  return toWindow(raw, now);
}

function buildSnapshot(raw: RawUsageResponse, now: number, stale: boolean): QuotaSnapshot {
  return {
    fiveHour: toWindow(raw.five_hour, now),
    sevenDay: toWindow(raw.seven_day, now),
    sevenDaySonnet: toOptionalWindow(raw.seven_day_sonnet, now),
    sevenDayOpus: toOptionalWindow(raw.seven_day_opus, now),
    extra: raw.extra_usage
      ? {
          isEnabled: !!raw.extra_usage.is_enabled,
          monthlyLimit: raw.extra_usage.monthly_limit ?? null,
          usedCredits: raw.extra_usage.used_credits ?? null,
          utilization: raw.extra_usage.utilization ?? null,
          currency: raw.extra_usage.currency ?? null,
        }
      : undefined,
    fetchedAt: now,
    stale,
  };
}

export async function getClaudeQuota(options: { force?: boolean } = {}): Promise<QuotaSnapshot> {
  const cache = getCache();
  const now = Date.now();

  if (!options.force) {
    if (cache.snapshot && now - cache.fetchedAt < TTL_MS) return cache.snapshot;
    if (cache.snapshot && cache.retryAfterMs > now) {
      return { ...cache.snapshot, stale: true };
    }
  }

  if (cache.inFlight) return cache.inFlight;

  cache.inFlight = (async () => {
    try {
      const token = await readOauthToken();
      if (!token) {
        if (cache.snapshot) return { ...cache.snapshot, stale: true };
        throw new Error('No Claude OAuth token available (keychain + ~/.claude/.credentials.json both missing)');
      }

      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get('retry-after') ?? 300);
        cache.retryAfterMs = Date.now() + retryAfter * 1000;
        if (cache.snapshot) return { ...cache.snapshot, stale: true };
        throw new Error(`Anthropic usage API rate-limited (${res.status}); no cached value to return`);
      }

      if (!res.ok) {
        if (cache.snapshot) return { ...cache.snapshot, stale: true };
        throw new Error(`Anthropic usage API returned HTTP ${res.status}`);
      }

      const raw = (await res.json()) as RawUsageResponse;
      const snapshot = buildSnapshot(raw, Date.now(), false);
      cache.snapshot = snapshot;
      cache.fetchedAt = snapshot.fetchedAt;
      cache.retryAfterMs = 0;
      return snapshot;
    } catch (e) {
      if (cache.snapshot) return { ...cache.snapshot, stale: true };
      throw e;
    } finally {
      cache.inFlight = null;
    }
  })();

  return cache.inFlight;
}

export function clearQuotaCache(): void {
  const cache = getCache();
  cache.snapshot = null;
  cache.fetchedAt = 0;
  cache.retryAfterMs = 0;
  cache.inFlight = null;
}

/**
 * Synchronous read of the in-memory cache. Never fetches. Returns null when no
 * snapshot has been cached yet (callers should treat this as "quota unknown"
 * and fail OPEN).
 */
export function peekQuotaCache(): QuotaSnapshot | null {
  return getCache().snapshot;
}

/**
 * Kick off a background refresh without awaiting. Used at startup and on a
 * timer to keep the cache fresh enough for synchronous gate checks.
 */
export function prefetchQuota(): void {
  void getClaudeQuota().catch(() => {
    /* swallow; the gate fails open when cache is empty */
  });
}
