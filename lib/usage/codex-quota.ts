import { homedir } from 'os';
import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import type { QuotaSnapshot, QuotaWindow } from '@/lib/usage/quota-types';

interface CacheState {
  snapshot: QuotaSnapshot | null;
  fetchedAt: number;
  inFlight: Promise<QuotaSnapshot> | null;
}

interface CodexLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface CodexRateLimits {
  limit_id?: string | null;
  primary?: CodexLimitWindow | null;
  secondary?: CodexLimitWindow | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | number | null;
  } | null;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
}

const TTL_MS = 30_000;
const MAX_FILES_TO_SCAN = 20;
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;

const globalAny = globalThis as unknown as { __tamtamCodexQuota?: CacheState };

function getCache(): CacheState {
  if (!globalAny.__tamtamCodexQuota) {
    globalAny.__tamtamCodexQuota = { snapshot: null, fetchedAt: 0, inFlight: null };
  }
  return globalAny.__tamtamCodexQuota;
}

function toWindow(raw: CodexLimitWindow | null | undefined, now: number): QuotaWindow {
  const utilization = typeof raw?.used_percent === 'number' ? raw.used_percent : 0;
  const resetMs = typeof raw?.resets_at === 'number' ? raw.resets_at * 1000 : null;
  const resetsAt = resetMs ? new Date(resetMs).toISOString() : null;
  return {
    utilization,
    resetsAt,
    msUntilReset: resetMs ? Math.max(0, resetMs - now) : null,
  };
}

function creditsExhausted(rateLimits: CodexRateLimits): boolean {
  const credits = rateLimits.credits;
  if (!credits) return false;
  if (credits.unlimited === true) return false;
  if (credits.has_credits === false) return true;
  const balance = credits.balance;
  if (typeof balance === 'number') return balance <= 0;
  if (typeof balance === 'string') return Number(balance) <= 0;
  return false;
}

function rateLimitReached(rateLimits: CodexRateLimits): boolean {
  return !!rateLimits.rate_limit_reached_type || creditsExhausted(rateLimits);
}

function hasRollingWindow(rateLimits: CodexRateLimits): boolean {
  return !!(rateLimits.primary || rateLimits.secondary);
}

function shouldExposeCredits(rateLimits: CodexRateLimits): boolean {
  return !!rateLimits.credits && !hasRollingWindow(rateLimits);
}

function classifyLimitWindows(rateLimits: CodexRateLimits): {
  fiveHour: CodexLimitWindow | null;
  sevenDay: CodexLimitWindow | null;
} {
  let fiveHour: CodexLimitWindow | null = null;
  let sevenDay: CodexLimitWindow | null = null;

  for (const win of [rateLimits.primary, rateLimits.secondary]) {
    if (!win) continue;
    if (win.window_minutes === FIVE_HOUR_WINDOW_MINUTES && !fiveHour) {
      fiveHour = win;
    } else if (win.window_minutes === SEVEN_DAY_WINDOW_MINUTES && !sevenDay) {
      sevenDay = win;
    }
  }

  // Older or malformed events may omit window_minutes. Preserve the legacy
  // primary/secondary interpretation only for windows we could not classify.
  if (!fiveHour && rateLimits.primary && rateLimits.primary.window_minutes == null) fiveHour = rateLimits.primary;
  if (!sevenDay && rateLimits.secondary && rateLimits.secondary.window_minutes == null) sevenDay = rateLimits.secondary;

  return { fiveHour, sevenDay };
}

async function listSessionFiles(root: string): Promise<string[]> {
  const out: { path: string; mtimeMs: number }[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const s = await stat(path);
          out.push({ path, mtimeMs: s.mtimeMs });
        } catch {
          /* ignore files removed during scan */
        }
      }
    }));
  }

  await walk(root);
  return out
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_TO_SCAN)
    .map((f) => f.path);
}

function selectEffectiveRateLimits(samples: CodexRateLimits[]): CodexRateLimits | null {
  return samples[0] ?? null;
}

function newestRateLimitsFromContent(content: string): CodexRateLimits | null {
  let latest: CodexRateLimits | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const parsed = JSON.parse(line);
      const payload = parsed?.payload ?? parsed;
      const rateLimits = payload?.rate_limits;
      if (payload?.type === 'token_count' && rateLimits) latest = rateLimits as CodexRateLimits;
    } catch {
      /* skip malformed session lines */
    }
  }
  return latest;
}

async function readLatestRateLimits(): Promise<CodexRateLimits | null> {
  const sessionsDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const files = await listSessionFiles(sessionsDir);
  const samples: CodexRateLimits[] = [];
  for (const file of files) {
    try {
      const rateLimits = newestRateLimitsFromContent(await readFile(file, 'utf8'));
      if (!rateLimits) continue;
      samples.push(rateLimits);
    } catch {
      /* try the next recent session */
    }
  }
  return selectEffectiveRateLimits(samples);
}

function buildSnapshot(rateLimits: CodexRateLimits, now: number, stale: boolean): QuotaSnapshot {
  const windows = classifyLimitWindows(rateLimits);
  if (rateLimitReached(rateLimits) && !hasRollingWindow(rateLimits)) {
    return {
      provider: 'codex',
      planType: rateLimits.plan_type ?? rateLimits.limit_id ?? null,
      fiveHour: {
        utilization: 100,
        resetsAt: null,
        msUntilReset: null,
      },
      sevenDay: toWindow(windows.sevenDay, now),
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extra: shouldExposeCredits(rateLimits)
        ? {
            isEnabled: true,
            monthlyLimit: null,
            usedCredits: null,
            utilization: creditsExhausted(rateLimits) ? 100 : null,
            currency: null,
          }
        : undefined,
      fetchedAt: now,
      stale,
    };
  }
  const exhaustedCredits = creditsExhausted(rateLimits);
  return {
    provider: 'codex',
    planType: rateLimits.plan_type ?? rateLimits.limit_id ?? null,
    fiveHour: toWindow(windows.fiveHour, now),
    sevenDay: toWindow(windows.sevenDay, now),
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extra: shouldExposeCredits(rateLimits)
      ? {
          isEnabled: true,
          monthlyLimit: null,
          usedCredits: null,
          utilization: exhaustedCredits ? 100 : null,
          currency: null,
        }
      : undefined,
    fetchedAt: now,
    stale,
  };
}

export async function getCodexQuota(options: { force?: boolean } = {}): Promise<QuotaSnapshot> {
  const cache = getCache();
  const now = Date.now();
  if (!options.force && cache.snapshot && now - cache.fetchedAt < TTL_MS) return cache.snapshot;
  if (cache.inFlight) return cache.inFlight;

  cache.inFlight = (async () => {
    try {
      const rateLimits = await readLatestRateLimits();
      if (!rateLimits) {
        if (cache.snapshot) return { ...cache.snapshot, stale: true };
        throw new Error('No Codex rate-limit snapshot found in ~/.codex/sessions yet');
      }
      const snapshot = buildSnapshot(rateLimits, Date.now(), false);
      cache.snapshot = snapshot;
      cache.fetchedAt = snapshot.fetchedAt;
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

export function clearCodexQuotaCache(): void {
  const cache = getCache();
  cache.snapshot = null;
  cache.fetchedAt = 0;
  cache.inFlight = null;
}

export function peekCodexQuotaCache(): QuotaSnapshot | null {
  return getCache().snapshot;
}

export function prefetchCodexQuota(): void {
  void getCodexQuota().catch(() => {
    /* fail open when no local Codex status has been recorded yet */
  });
}

export const __private__ = {
  newestRateLimitsFromContent,
  selectEffectiveRateLimits,
  classifyLimitWindows,
  buildSnapshot,
  creditsExhausted,
};
