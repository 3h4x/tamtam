import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { gte, sql } from 'drizzle-orm';

const WINDOWS = {
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
  all: Infinity,
} as const;

type Window = keyof typeof WINDOWS;
const VALID_WINDOWS = new Set<Window>(Object.keys(WINDOWS) as Window[]);

const CACHE_TTL_MS = 60_000;
const cache = new Map<Window, { body: OllamaStatsResponse; expiresAt: number }>();

export interface OllamaModelRow {
  model: string;
  calls: number;
  inputTokens: number;
  durationMs: number;
}

export interface OllamaSourceRow {
  sourceKind: string;
  calls: number;
  inputTokens: number;
  durationMs: number;
}

export interface OllamaProjectRow {
  project: string;
  calls: number;
  inputTokens: number;
  durationMs: number;
}

export interface OllamaStatsResponse {
  window: Window;
  generatedAt: number;
  totals: {
    calls: number;
    inputTokens: number;
    durationMs: number;
    lastCallAt: number | null;
  };
  models: OllamaModelRow[];
  sources: OllamaSourceRow[];
  projects: OllamaProjectRow[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const param = request.nextUrl.searchParams.get('window') ?? '24h';
  const window: Window = VALID_WINDOWS.has(param as Window)
    ? (param as Window)
    : '24h';

  const cached = cache.get(window);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.body);
  }

  const cutoff = window === 'all' ? 0 : Date.now() / 1000 - WINDOWS[window];
  const filter = gte(schema.ollamaUsage.ts, cutoff);

  const [byModel, bySource, byProject, totalsRows] = await Promise.all([
    db
      .select({
        model: schema.ollamaUsage.model,
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${schema.ollamaUsage.inputTokens}), 0)`,
        durationMs: sql<number>`coalesce(sum(${schema.ollamaUsage.durationMs}), 0)`,
      })
      .from(schema.ollamaUsage)
      .where(filter)
      .groupBy(schema.ollamaUsage.model),
    db
      .select({
        sourceKind: sql<string | null>`${schema.ollamaUsage.sourceKind}`,
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${schema.ollamaUsage.inputTokens}), 0)`,
        durationMs: sql<number>`coalesce(sum(${schema.ollamaUsage.durationMs}), 0)`,
      })
      .from(schema.ollamaUsage)
      .where(filter)
      .groupBy(schema.ollamaUsage.sourceKind),
    db
      .select({
        project: sql<string | null>`${schema.ollamaUsage.project}`,
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${schema.ollamaUsage.inputTokens}), 0)`,
        durationMs: sql<number>`coalesce(sum(${schema.ollamaUsage.durationMs}), 0)`,
      })
      .from(schema.ollamaUsage)
      .where(filter)
      .groupBy(schema.ollamaUsage.project),
    db
      .select({
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${schema.ollamaUsage.inputTokens}), 0)`,
        durationMs: sql<number>`coalesce(sum(${schema.ollamaUsage.durationMs}), 0)`,
        lastCallAt: sql<number | null>`max(${schema.ollamaUsage.ts})`,
      })
      .from(schema.ollamaUsage)
      .where(filter)
      .limit(1),
  ]);

  const totalsRow = totalsRows[0] ?? null;

  const body: OllamaStatsResponse = {
    window,
    generatedAt: Date.now(),
    totals: {
      calls: Number(totalsRow?.calls ?? 0),
      inputTokens: Number(totalsRow?.inputTokens ?? 0),
      durationMs: Number(totalsRow?.durationMs ?? 0),
      lastCallAt: totalsRow?.lastCallAt ?? null,
    },
    models: byModel
      .map((r) => ({ model: r.model, calls: Number(r.calls), inputTokens: Number(r.inputTokens), durationMs: Number(r.durationMs) }))
      .sort((a, b) => b.calls - a.calls),
    sources: bySource
      .map((r) => ({ sourceKind: r.sourceKind ?? 'unknown', calls: Number(r.calls), inputTokens: Number(r.inputTokens), durationMs: Number(r.durationMs) }))
      .sort((a, b) => b.calls - a.calls),
    projects: byProject
      .map((r) => ({ project: r.project ?? '(none)', calls: Number(r.calls), inputTokens: Number(r.inputTokens), durationMs: Number(r.durationMs) }))
      .sort((a, b) => b.calls - a.calls),
  };

  cache.set(window, { body, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(body);
}
