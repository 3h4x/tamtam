import { resolveProjectPath } from '@/lib/shared/project-data';
// exec wraps child_process.execFile safely — args are arrays, no shell injection risk
import { exec } from '@/lib/shared/shell';
import { upsertRecommendation } from '@/lib/recommendations/recommendations';
import { isAgentJobKind } from '@/lib/jobs/kinds';
import type { JobData } from '@/lib/jobs/types';
import { extractAssistantTextFromRawLog, extractWorkSummary } from '@/lib/agents/work-summary-extractor.mjs';
import { getSettings } from '@/lib/shared/config';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { PgvectorBackend } from '@/lib/agents/retrieval/pgvector-backend';
import { ingestAgentRun } from '@/lib/agents/retrieval/ingestion';
import {
  computeFruitfulness,
  jobToSample,
  loadRecentAgentSamples,
  type FruitfulnessSample,
} from '@/lib/agents/fruitfulness';

interface AgentContextMeta {
  agent?: { id?: string; name?: string; schedule?: string | null; triggeredBy?: string };
  baseline?: { head?: string | null; status?: string | null; dirty?: boolean | null };
}

interface ModifiedFile {
  path: string;
  status: string;
  confidence?: 'high' | 'low';
}

interface LinesDelta {
  added: number;
  removed: number;
}

function parseContextMeta(raw: string | null | undefined): AgentContextMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AgentContextMeta;
  } catch {
    return {};
  }
}

function parseNameStatus(stdout: string, confidence: 'high' | 'low'): ModifiedFile[] {
  return stdout.split('\n').flatMap((line) => {
    const parts = line.trim().split('\t').filter(Boolean);
    if (parts.length < 2) return [];
    const status = parts[0];
    const path = parts[parts.length - 1];
    return [{ path, status, confidence }];
  });
}

function parsePorcelain(stdout: string, confidence: 'high' | 'low'): ModifiedFile[] {
  return stdout.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    const status = line.slice(0, 2).trim() || 'M';
    const rawPath = line.slice(3).trim();
    const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() || rawPath : rawPath;
    return path ? [{ path, status, confidence }] : [];
  });
}

// `git diff --numstat` rows are `<added>\t<removed>\t<path>` with `-` for
// binary files. We treat `-` as 0 (the file changed but we don't know how
// many text lines moved, so it counts toward "this agent did something"
// only via the modified_files count, not the LOC total).
function parseNumstat(stdout: string): LinesDelta {
  let added = 0;
  let removed = 0;
  for (const raw of stdout.split('\n')) {
    const parts = raw.split('\t');
    if (parts.length < 3) continue;
    const a = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10);
    const r = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10);
    if (Number.isFinite(a)) added += a;
    if (Number.isFinite(r)) removed += r;
  }
  return { added, removed };
}

interface WorktreeDelta {
  files: ModifiedFile[];
  lines: LinesDelta;
}

async function worktreeDelta(job: JobData, ctx: AgentContextMeta): Promise<WorktreeDelta> {
  const empty: WorktreeDelta = { files: [], lines: { added: 0, removed: 0 } };
  const projPath = resolveProjectPath(job.project);
  if (!projPath) return empty;
  const confidence: 'high' | 'low' = ctx.baseline?.dirty ? 'low' : 'high';
  const files = new Map<string, ModifiedFile>();
  let added = 0;
  let removed = 0;

  // All four git reads target the same worktree and are independent — fire
  // them in one Promise.all to keep the per-run overhead to one round-trip.
  // When the run started dirty, file names are kept as low-confidence context,
  // but LOC is not attributed: BASE..HEAD and HEAD diffs can include operator
  // edits that predate the agent run.
  const baselineHead = ctx.baseline?.head;
  const [diffR, diffNumR, statusR, dirtyNumR] = await Promise.all([
    baselineHead
      ? exec('git', ['-C', projPath, 'diff', '--name-status', `${baselineHead}..HEAD`], { timeout: 10000 })
      : Promise.resolve(null),
    baselineHead
      ? exec('git', ['-C', projPath, 'diff', '--numstat', `${baselineHead}..HEAD`], { timeout: 10000 })
      : Promise.resolve(null),
    exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 }),
    // `HEAD` includes staged + unstaged changes. Only count it when the run
    // started clean; on a dirty baseline it would also include pre-existing
    // operator edits we cannot attribute to this agent.
    exec('git', ['-C', projPath, 'diff', '--numstat', 'HEAD'], { timeout: 10000 }),
  ]);

  if (diffR && diffR.exitCode === 0) {
    for (const file of parseNameStatus(diffR.stdout, confidence)) files.set(file.path, file);
  }
  const dirtyChanged = statusR?.exitCode === 0
    && (ctx.baseline?.dirty || statusR.stdout !== (ctx.baseline?.status ?? ''));
  if (dirtyChanged) {
    for (const file of parsePorcelain(statusR.stdout, confidence)) files.set(file.path, file);
  }
  if (!ctx.baseline?.dirty && diffNumR && diffNumR.exitCode === 0) {
    const d = parseNumstat(diffNumR.stdout);
    added += d.added;
    removed += d.removed;
  }
  if (!ctx.baseline?.dirty && dirtyChanged && dirtyNumR?.exitCode === 0) {
    const d = parseNumstat(dirtyNumR.stdout);
    added += d.added;
    removed += d.removed;
  }

  return {
    files: Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path)),
    lines: { added, removed },
  };
}

function scheduleHours(schedule: string | null | undefined): number | null {
  if (!schedule) return null;
  const m = schedule.trim().match(/^(\d+)([mh])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].toLowerCase() === 'm' ? n / 60 : n;
}

// Fruitfulness thresholds, mirrored from the orchestrator allocator. Kept in
// sync there as `UNFRUITFUL_MIN_SAMPLE` / `UNFRUITFUL_RATE_THRESHOLD`. The
// recommendation only fires once the orchestrator would actually demote the
// agent — otherwise we'd be telling the user "this agent is unfruitful" while
// the orchestrator was still boosting it normally, which is confusing.
const UNFRUITFUL_MIN_SAMPLE = 5;
const UNFRUITFUL_RATE_THRESHOLD = 0.2;
const UNFRUITFUL_SAMPLE_LIMIT = 10;

async function maybeRecommendFruitfulness(job: JobData, ctx: AgentContextMeta): Promise<void> {
  const agentId = ctx.agent?.id ?? null;
  const agentName = ctx.agent?.name ?? job.kind.replace(/^agent:/, '');
  // Manual triggers shouldn't push the running average toward "deprioritize" —
  // an operator firing an agent on demand is a different signal than a
  // scheduled run that found nothing.
  if (ctx.agent?.triggeredBy !== 'schedule') return;

  // Include this just-finished run in the window so the recommendation reacts
  // immediately to a streak of empties (otherwise the Nth empty run would
  // only flip the bit on the N+1th run's finalize, lagging by one fire).
  const thisSample = jobToSample(job);
  const prior: FruitfulnessSample[] = await loadRecentAgentSamples({
    project: job.project,
    agentId,
    agentName,
    limit: UNFRUITFUL_SAMPLE_LIMIT,
  }).catch(() => []);
  const samples: FruitfulnessSample[] = thisSample
    ? [thisSample, ...prior.filter((s) => s.jobId !== thisSample.jobId)].slice(0, UNFRUITFUL_SAMPLE_LIMIT)
    : prior;

  const stats = computeFruitfulness(samples);
  if (stats.runs < UNFRUITFUL_MIN_SAMPLE) return;
  if (stats.rate >= UNFRUITFUL_RATE_THRESHOLD) return;

  const currentSchedule = ctx.agent?.schedule ?? null;
  const fruitfulPct = Math.round(stats.rate * 100);
  await upsertRecommendation({
    project: job.project,
    sourceKind: job.kind,
    sourceId: job.id,
    agentId,
    agentName,
    type: 'agent_unfruitful',
    title: `${agentName} isn't producing changes`,
    detail:
      `Across the last ${stats.runs} scheduled runs, ${agentName} changed files ${stats.fruitfulRuns} times (${fruitfulPct}%) ` +
      `and moved ${stats.totalLinesChanged} lines total. ` +
      `The orchestrator will deprioritize boosting this agent until it starts producing again. ` +
      `Consider: (a) widen the prompt, (b) check the agent has actual work to do, or (c) lengthen the schedule to reduce noise.`,
    payload: {
      reason: 'agent produced no changes across recent scheduled runs',
      currentSchedule,
      window: stats.runs,
      fruitfulRuns: stats.fruitfulRuns,
      fruitfulRate: stats.rate,
      totalLinesChanged: stats.totalLinesChanged,
      totalFilesChanged: stats.totalFilesChanged,
      lastRunAt: stats.lastRunAt,
      sourceJobId: job.id,
    },
  });
}

function maybeRecommendSchedule(job: JobData, ctx: AgentContextMeta, files: ModifiedFile[], actionable: boolean | null): void {
  const agentName = ctx.agent?.name ?? job.kind.replace(/^agent:/, '');
  const currentSchedule = ctx.agent?.schedule ?? null;
  const hours = scheduleHours(currentSchedule);
  if (
    job.exitCode !== 0 ||
    ctx.agent?.triggeredBy !== 'schedule' ||
    ctx.baseline?.dirty ||
    actionable !== false ||
    files.length > 0 ||
    hours == null ||
    hours >= 8
  ) return;

  const confidence = actionable === false ? 'high' : 'medium';
  const suggestedSchedule = '8h';
  upsertRecommendation({
    project: job.project,
    sourceKind: job.kind,
    sourceId: job.id,
    agentId: ctx.agent?.id ?? null,
    agentName,
    type: 'agent_schedule_backoff',
    title: `Run ${agentName} less often`,
    detail: `Recent run reported no actionable work and changed 0 files. Current schedule is ${currentSchedule}; consider ${suggestedSchedule}.`,
    payload: {
      currentSchedule,
      recommendedSchedule: suggestedSchedule,
      reason: 'recent run found no actionable work',
      confidence,
      reasoning: {
        summary: job.workSummary ?? null,
        actionableWork: actionable,
        filesChangedCount: files.length,
        currentSchedule,
        recommendedSchedule: suggestedSchedule,
        confidence,
        sourceJobId: job.id,
      },
    },
  });
}

// agent:issue-cruncher reports the picked issue inline in its summary
// ("Worked issue `#70`, …"). Parsing it lets createIssuePR look up this job
// later — the agent itself never stamps gh_issue_number on its own row.
function parseIssueNumberFromSummary(summary: string | null | undefined): number | null {
  if (!summary) return null;
  const m = summary.match(/(?:issue\s+|#)(\d{1,6})\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function finalizeAgentRunReport(job: JobData, rawLog: string): Promise<void> {
  const isAgent = isAgentJobKind(job.kind);
  const isIssueRun = job.kind === 'run' && job.ghIssueNumber != null;
  if (!isAgent && !isIssueRun) return;
  const ctx = parseContextMeta(job.contextMeta);
  const text = extractAssistantTextFromRawLog(rawLog);
  const { summary, actionable } = extractWorkSummary(text);
  const { files, lines } = await worktreeDelta(job, ctx);
  job.workSummary = summary;
  job.modifiedFiles = JSON.stringify(files);
  job.linesAdded = lines.added;
  job.linesRemoved = lines.removed;
  if (job.kind === 'agent:issue-cruncher' && job.ghIssueNumber == null) {
    const parsed = parseIssueNumberFromSummary(summary);
    if (parsed != null) job.ghIssueNumber = parsed;
  }
  if (isAgent) {
    maybeRecommendSchedule(job, ctx, files, actionable);
    // Fire-and-forget — the recommendation surfaces in /recommendations on
    // the next render; a transient DB error must not fail the job finalize.
    void maybeRecommendFruitfulness(job, ctx).catch((e) => {
      console.warn('[agent-run-report] fruitfulness recommendation failed:', e);
    });
  }

  // Best-effort: index completed run for future retrieval (fire-and-forget)
  void (async () => {
    try {
      const cfg = getSettings();
      if (!cfg.retrieval_enabled || !job.workSummary) return;

      const recordId = `${job.project}:agent_run:${job.id}`;
      const existingRows = await db.select()
        .from(schema.retrievalRecords)
        .where(eq(schema.retrievalRecords.id, recordId))
        .limit(1);
      const existing = existingRows[0];

      const backend = new PgvectorBackend();
      const modFiles: string[] = job.modifiedFiles
        ? (JSON.parse(job.modifiedFiles) as { path: string }[]).map((f) => f.path)
        : [];

      const { contentHash, skipped, stored } = await ingestAgentRun({
        backend,
        project: job.project,
        jobId: job.id,
        agentId: ctx.agent?.id ?? job.id,
        agentName: ctx.agent?.name ?? job.kind.replace(/^agent:/, ''),
        workSummary: job.workSummary,
        modifiedFiles: modFiles,
        exitCode: job.exitCode ?? -1,
        completedAt: job.finishedAt ?? Date.now() / 1000,
        ollamaUrl: cfg.retrieval_ollama_url,
        embeddingModel: cfg.retrieval_embedding_model,
        existingHash: existing?.contentHash ?? null,
      });

      if (!skipped && stored) {
        void db.insert(schema.retrievalRecords)
          .values({
            id: recordId,
            project: job.project,
            sourceKind: 'agent_run',
            sourceId: job.id,
            chunkCount: 1,
            contentHash,
            indexedAt: Date.now() / 1000,
            embeddingModel: cfg.retrieval_embedding_model,
          })
          .onConflictDoUpdate({
            target: schema.retrievalRecords.id,
            set: {
              contentHash,
              indexedAt: Date.now() / 1000,
              chunkCount: 1,
              embeddingModel: cfg.retrieval_embedding_model,
            },
          })
          .execute()
          .catch((e) => console.warn('[retrieval] failed to upsert retrieval record:', e));
      }
    } catch (err) {
      console.warn('[retrieval] agent run ingestion failed:', err);
    }
  })();
}
