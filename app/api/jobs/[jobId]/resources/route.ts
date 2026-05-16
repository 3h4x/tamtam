// GET /api/jobs/:jobId/resources — return the CPU%/RSS time series collected
// by the probe-sweep resource-sampler. Cheap read on the
// `job_resource_samples_job_sampled` btree.
//
// Query params:
//   ?since=<unix_seconds>  optional lower bound (samples with sampled_at >= since)
//   ?limit=<n>             optional cap (default 1000, max 5000)

import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, gte } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { errMsg } from '@/lib/shared/types';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

function parseLimit(raw: string | null): { ok: true; value: number } | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true, value: DEFAULT_LIMIT };
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'limit must be a positive integer' };
  }
  return { ok: true, value: Math.min(value, MAX_LIMIT) };
}

function parseSince(raw: string | null): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true, value: null };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'since must be a non-negative Unix timestamp in seconds' };
  }
  return { ok: true, value };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params;
  const { searchParams } = new URL(request.url);
  const parsedSince = parseSince(searchParams.get('since'));
  if (!parsedSince.ok) {
    return NextResponse.json({ detail: parsedSince.error }, { status: 400 });
  }
  const parsedLimit = parseLimit(searchParams.get('limit'));
  if (!parsedLimit.ok) {
    return NextResponse.json({ detail: parsedLimit.error }, { status: 400 });
  }
  const since = parsedSince.value;
  const limit = parsedLimit.value;

  try {
    const where = since != null && Number.isFinite(since)
      ? and(eq(schema.jobResourceSamples.jobId, jobId), gte(schema.jobResourceSamples.sampledAt, since))
      : eq(schema.jobResourceSamples.jobId, jobId);

    const rows = await db.select({
      sampledAt: schema.jobResourceSamples.sampledAt,
      cpuPct: schema.jobResourceSamples.cpuPct,
      rssKb: schema.jobResourceSamples.rssKb,
    })
      .from(schema.jobResourceSamples)
      .where(where)
      .orderBy(asc(schema.jobResourceSamples.sampledAt))
      .limit(limit);

    return NextResponse.json({
      jobId,
      samples: rows.map((r) => ({
        t: r.sampledAt,
        cpu: r.cpuPct,
        rss: r.rssKb,
      })),
    });
  } catch (err) {
    console.error(`[api/jobs/${jobId}/resources] query failed:`, err);
    return NextResponse.json({ detail: `resource query failed: ${errMsg(err)}` }, { status: 500 });
  }
}
