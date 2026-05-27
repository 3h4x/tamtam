// graphile-worker task: usage-snapshot
//
// Fires every 5 minutes (self-reenqueue). Reads the bridge's per-provider
// pace snapshot and writes one row per provider+window into
// `usage_hourly_snapshot`, bucketed to the start of the current hour. Re-
// upserts within the same hour so the row reflects the latest snapshot
// captured in that bucket (cheap, deterministic, idempotent on restart).

import type { JobHelpers, Task } from 'graphile-worker';

export const USAGE_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
export const USAGE_SNAPSHOT_JOB_KEY = 'usage-snapshot';
// Bucket granularity. 15 min trades a bit more storage for much faster
// "first data point" after a quiet provider starts spending, and a more
// readable chart at sub-hour resolution.
export const USAGE_SNAPSHOT_BUCKET_MS = 15 * 60 * 1000;

export interface UsageSnapshotRow {
  bucketTs: number;
  provider: string;
  windowKey: string;
  utilizationPct: number;
  elapsedPct: number;
  projectedPct: number | null;
  paceMarginPct: number;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreateTokens: number | null;
  jobCount: number | null;
}

export interface TokenAggregate {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  jobCount: number;
}

export interface UsageSnapshotDeps {
  loadBridge: () => Promise<{
    globalPace: {
      providers: Array<{
        provider: string;
        fiveHour: {
          utilizationPct: number;
          elapsedPct: number;
          projectedPct: number | null;
          paceMarginPct: number;
          status: string;
        };
        sevenDay: {
          utilizationPct: number;
          elapsedPct: number;
          projectedPct: number | null;
          paceMarginPct: number;
          status: string;
        };
      }>;
    };
  }>;
  upsertSnapshots: (rows: UsageSnapshotRow[]) => Promise<void>;
  /** Aggregate token sums from completed jobs whose `finished_at` falls in
   *  the given [bucketStart, bucketEnd) range, keyed by provider. Empty map
   *  when no jobs completed in the bucket — caller fills snapshot tokens
   *  with null. */
  loadTokenAggregates: (bucketStartMs: number, bucketEndMs: number) => Promise<Map<string, TokenAggregate>>;
  enqueueNextFire: (runAt: Date) => Promise<void>;
  now?: () => number;
}

export interface UsageSnapshotResult {
  written: number;
  bucketTs: number;
  error?: string;
  nextFireAt: Date;
}

function bucketStartMs(nowMs: number): number {
  return Math.floor(nowMs / USAGE_SNAPSHOT_BUCKET_MS) * USAGE_SNAPSHOT_BUCKET_MS;
}

export async function handleUsageSnapshot(
  deps: UsageSnapshotDeps,
): Promise<UsageSnapshotResult> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const bucketTs = bucketStartMs(nowMs);
  let written = 0;
  let error: string | undefined;
  try {
    const bridge = await deps.loadBridge();
    const bucketEndMs = bucketTs + USAGE_SNAPSHOT_BUCKET_MS;
    const tokensByProvider = await deps.loadTokenAggregates(bucketTs, bucketEndMs);
    const rows: UsageSnapshotRow[] = [];
    for (const p of bridge.globalPace.providers) {
      const tk = tokensByProvider.get(p.provider) ?? null;
      for (const [windowKey, w] of [
        ['5h', p.fiveHour] as const,
        ['7d', p.sevenDay] as const,
      ]) {
        rows.push({
          bucketTs,
          provider: p.provider,
          windowKey,
          utilizationPct: w.utilizationPct,
          elapsedPct: w.elapsedPct,
          projectedPct: w.projectedPct,
          paceMarginPct: w.paceMarginPct,
          status: w.status,
          inputTokens: tk ? tk.inputTokens : null,
          outputTokens: tk ? tk.outputTokens : null,
          cacheReadTokens: tk ? tk.cacheReadTokens : null,
          cacheCreateTokens: tk ? tk.cacheCreateTokens : null,
          jobCount: tk ? tk.jobCount : null,
        });
      }
    }
    if (rows.length > 0) {
      await deps.upsertSnapshots(rows);
      written = rows.length;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const nextFireAt = new Date(nowMs + USAGE_SNAPSHOT_INTERVAL_MS);
  await deps.enqueueNextFire(nextFireAt);
  return { written, bucketTs, error, nextFireAt };
}

export function createUsageSnapshotTask(deps: UsageSnapshotDeps): Task {
  return async (_payload, helpers: JobHelpers) => {
    const r = await handleUsageSnapshot(deps);
    if (r.error) {
      helpers.logger.error(`usage-snapshot: ${r.error}; next fire ${r.nextFireAt.toISOString()}`);
    } else {
      helpers.logger.info(`usage-snapshot: wrote ${r.written} rows for bucket ${new Date(r.bucketTs).toISOString()}, next fire ${r.nextFireAt.toISOString()}`);
    }
  };
}
