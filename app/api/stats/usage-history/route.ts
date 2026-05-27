// Hourly usage history powering the /stats chart. Reads
// `usage_hourly_snapshot` rows for the most recent N hours and returns
// per-provider time series plus the "expected" and "catch-up" derived rates
// so the client can plot three lines per provider without re-deriving them.

import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, gte, sql } from 'drizzle-orm';
import { USAGE_SNAPSHOT_BUCKET_MS } from '@/lib/workflows/cron/usage-snapshot-task';

const DEFAULT_HOURS = 48;
const MAX_HOURS = 24 * 14; // bound the response so a stray ?hours=99999 doesn't dump the table
const BUCKET_HOURS = USAGE_SNAPSHOT_BUCKET_MS / (60 * 60 * 1000);
const PER_HOUR_SCALE = 1 / BUCKET_HOURS; // 15-min buckets → multiply token total by 4 to get tokens/h

export const dynamic = 'force-dynamic';

export interface UsageHistoryBucket {
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
  /** Sum of input+output (the meaningful "tokens used" rate). */
  totalTokens: number | null;
  /**
   * Catch-up rate (tokens/h) at the time of this bucket: how fast the user
   * could keep burning tokens to land exactly on 100% by window end, given
   * the utilization and elapsed-time at that moment. Lets the chart show how
   * the catch-up headroom has *evolved* instead of one flat reference line.
   */
  catchUpTokensPerHour: number | null;
}

interface ProviderSeries {
  provider: string;
  windowKey: string;
  buckets: UsageHistoryBucket[];
  currentTokensPerHour: number | null;
  expectedTokensPerHour: number | null;
  catchUpTokensPerHour: number | null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const hoursParam = Number.parseInt(url.searchParams.get('hours') ?? '', 10);
  const hours = Number.isFinite(hoursParam) && hoursParam > 0
    ? Math.min(MAX_HOURS, hoursParam)
    : DEFAULT_HOURS;
  const sinceMs = Date.now() - hours * 60 * 60 * 1000;
  // Bucket timestamps are stored in milliseconds (Date#getTime). Filter on
  // bucket_ts so we keep at most `hours` buckets.
  const rows = await db
    .select()
    .from(schema.usageHourlySnapshot)
    .where(and(gte(schema.usageHourlySnapshot.bucketTs, sinceMs)))
    .orderBy(sql`${schema.usageHourlySnapshot.bucketTs} ASC`);

  // Group by (provider, windowKey) and decorate with derived per-hour rates.
  const grouped = new Map<string, ProviderSeries>();
  for (const r of rows) {
    const key = `${r.provider}|${r.windowKey}`;
    const input = r.inputTokens ?? null;
    const output = r.outputTokens ?? null;
    // Normalize all token counts to tokens/h so the chart Y axis stays
    // consistent if we ever change bucket granularity. Keep null distinct
    // from 0: null means no jobs ran in the bucket, while 0 means a job ran
    // and reported zero input/output tokens.
    const totalTokens = input !== null || output !== null
      ? (Number(input ?? 0) + Number(output ?? 0)) * PER_HOUR_SCALE
      : null;
    const bucket: UsageHistoryBucket = {
      bucketTs: r.bucketTs,
      provider: r.provider,
      windowKey: r.windowKey,
      utilizationPct: r.utilizationPct,
      elapsedPct: r.elapsedPct,
      projectedPct: r.projectedPct,
      paceMarginPct: r.paceMarginPct,
      status: r.status,
      inputTokens: input !== null ? Number(input) : null,
      outputTokens: output !== null ? Number(output) : null,
      cacheReadTokens: r.cacheReadTokens !== null ? Number(r.cacheReadTokens) : null,
      cacheCreateTokens: r.cacheCreateTokens !== null ? Number(r.cacheCreateTokens) : null,
      jobCount: r.jobCount,
      totalTokens,
      catchUpTokensPerHour: null,
    };
    let series = grouped.get(key);
    if (!series) {
      series = {
        provider: r.provider,
        windowKey: r.windowKey,
        buckets: [],
        currentTokensPerHour: null,
        expectedTokensPerHour: null,
        catchUpTokensPerHour: null,
      };
      grouped.set(key, series);
    }
    series.buckets.push(bucket);
  }

  // Derive the three reference rates per series from the most recent bucket:
  //   current  = avg total tokens/h over last 3 buckets (or fewer if new install)
  //   expected = elapsedPct extrapolated linearly across the window (steady pace)
  //   catchUp  = (100 - utilizationPct) / remaining-hours, in the same token units
  // The token counts are per-hour because each bucket represents one hour.
  for (const series of grouped.values()) {
    const last = series.buckets[series.buckets.length - 1];
    if (!last) continue;
    const recent = series.buckets
      .slice(-3)
      .map((b) => b.totalTokens)
      .filter((t): t is number => t !== null);
    // Average over the last 3 buckets with observed token data. Null buckets
    // mean no jobs ran and must stay out of the rate calculation.
    series.currentTokensPerHour = recent.length > 0
      ? recent.reduce((a, b) => a + b, 0) / recent.length
      : null;

    // Use the window length to derive the expected rate. For 5h, the steady
    // pace burns 100% over 5 hours. For 7d, 100% over 168 hours. We don't
    // have raw token caps from the provider, so we express expected/catch-up
    // as a ratio against the *observed* token throughput vs utilization.
    const windowHours = series.windowKey === '5h' ? 5 : 7 * 24;
    {
      const allRates = series.buckets
        .map((b) => b.totalTokens)
        .filter((t): t is number => t !== null);
      if (allRates.length === 0) continue;

      // Expected = steady rate equivalent to elapsedPct% of plan per the
      // window length. If we've used `utilizationPct` of plan in
      // `elapsedPct%` of the window, current_rate ≈ plan_total × utilization
      // / (elapsedPct/100 × windowHours). Solve for plan_total and divide
      // by windowHours to get expected_rate.
      const u = last.utilizationPct;
      const e = last.elapsedPct;
      if (u > 0 && e > 0) {
        // plan_total ≈ current_total / utilization × 100. Use the broadest
        // available throughput estimate: prefer the last-3-bucket average,
        // but fall back to the average across every observed bucket when
        // recent activity is idle (e.g. provider currently not in use but
        // has historical usage in the window).
        const avgRate = allRates.reduce((a, b) => a + b, 0) / allRates.length;
        const rateForPlan = series.currentTokensPerHour && series.currentTokensPerHour > 0
          ? series.currentTokensPerHour
          : avgRate;
        const elapsedHours = (e / 100) * windowHours;
        const currentTotal = rateForPlan * elapsedHours;
        const planTotal = currentTotal / (u / 100);
        const expectedRate = planTotal / windowHours;
        series.expectedTokensPerHour = Math.max(0, expectedRate);
        const remainingPct = Math.max(0, 100 - u);
        const remainingHours = Math.max(0.001, windowHours - elapsedHours);
        const catchUpTotal = (remainingPct / 100) * planTotal;
        series.catchUpTokensPerHour = catchUpTotal / remainingHours;

        // Fill per-bucket catch-up rate using the same plan_total proxy. Lets
        // the chart show how headroom has evolved instead of one flat line.
        for (const b of series.buckets) {
          const ub = b.utilizationPct;
          const eb = b.elapsedPct;
          if (ub == null || eb == null) continue;
          const elapsedHoursBucket = (eb / 100) * windowHours;
          const remainingHoursBucket = windowHours - elapsedHoursBucket;
          if (remainingHoursBucket <= 0.001) continue;
          const remainingPctBucket = Math.max(0, 100 - ub);
          const catchUpTotalBucket = (remainingPctBucket / 100) * planTotal;
          b.catchUpTokensPerHour = Math.max(0, catchUpTotalBucket / remainingHoursBucket);
        }
      } else {
        // Observed jobs with no usable quota pace cannot derive a plan, but
        // zero keeps the reference lines honest for a real zero-token series.
        series.expectedTokensPerHour = 0;
        series.catchUpTokensPerHour = 0;
      }
    }
  }

  return NextResponse.json({
    generatedAt: Date.now(),
    hours,
    series: Array.from(grouped.values()),
  });
}
