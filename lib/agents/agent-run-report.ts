import { resolveProjectPath } from '@/lib/shared/project-data';
// exec wraps child_process.execFile safely — args are arrays, no shell injection risk
import { exec } from '@/lib/shared/shell';
import { upsertRecommendation, resolveRecommendationIfOpen } from '@/lib/recommendations/recommendations';
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
import { parseAgentRole, valueIsDiffBased } from '@/lib/agents/roles';

interface AgentContextMeta {
  agent?: { id?: string; name?: string; schedule?: string | null; triggeredBy?: string; role?: string };
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
//
// `attributedPaths`, when non-null, restricts the LOC sum to those paths so
// pre-existing dirty files don't inflate the agent's apparent productivity.
// `null` means "count everything" (e.g. clean baseline — every line is new).
function parseNumstat(stdout: string, attributedPaths: Set<string> | null): LinesDelta {
  let added = 0;
  let removed = 0;
  for (const raw of stdout.split('\n')) {
    const parts = raw.split('\t');
    if (parts.length < 3) continue;
    const path = parts.slice(2).join('\t').trim();
    if (attributedPaths !== null && !attributedPaths.has(path)) continue;
    const a = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10);
    const r = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10);
    if (Number.isFinite(a)) added += a;
    if (Number.isFinite(r)) removed += r;
  }
  return { added, removed };
}

function parseReportedChangedPaths(text: string): Set<string> | null {
  const reportIdx = text.toLowerCase().lastIndexOf('tamtam run report');
  const report = reportIdx >= 0 ? text.slice(reportIdx) : text;
  const match = report.match(/^\s*[-*]?\s*Files changed:\s*(.+)$/im);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  if (/^(none|no|n\/a)$/i.test(raw)) return new Set();
  const paths = raw
    .split(',')
    .map((p) => p.trim().replace(/^`|`$/g, ''))
    .filter(Boolean);
  return new Set(paths);
}

interface WorktreeDelta {
  files: ModifiedFile[];
  lines: LinesDelta;
}

/** Extract the path component from one `git status --porcelain` line.
 *  Renames show as `XY old -> new`; we key on the *new* path because that's
 *  what's in the worktree post-rename. */
function porcelainPath(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const raw = line.slice(3).trim();
  if (!raw) return null;
  return raw.includes(' -> ') ? raw.split(' -> ').pop() || raw : raw;
}

/** Build the set of paths that were already dirty in the worktree when the
 *  agent started. Used for per-file confidence attribution: anything in this
 *  set is pre-existing and gets `confidence: 'low'`; anything outside it is
 *  attributable to this agent run. */
function parseBaselinePaths(baselineStatus: string | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!baselineStatus) return set;
  for (const line of baselineStatus.split('\n')) {
    const path = porcelainPath(line);
    if (path) set.add(path);
  }
  return set;
}

async function worktreeDelta(
  job: JobData,
  ctx: AgentContextMeta,
  reportedChangedPaths: Set<string> | null,
): Promise<WorktreeDelta> {
  const empty: WorktreeDelta = { files: [], lines: { added: 0, removed: 0 } };
  const projPath = resolveProjectPath(job.project);
  if (!projPath) return empty;
  const files = new Map<string, ModifiedFile>();
  let added = 0;
  let removed = 0;
  const baselineDirty = !!ctx.baseline?.dirty;

  // Per-file attribution: a path that was already in the porcelain baseline
  // when the agent started is pre-existing dirt (`low`). A path that appears
  // only in the post-run worktree is the agent's work (`high`). Without this,
  // a single stale untracked file from a previous cycle marks *every*
  // subsequent file low-confidence and the gate keeps skipping releases that
  // should fire — defeating autonomy.
  const baselinePaths = parseBaselinePaths(ctx.baseline?.status);

  // All four git reads target the same worktree and are independent — fire
  // them in one Promise.all to keep the per-run overhead to one round-trip.
  const baselineHead = ctx.baseline?.head;
  const [diffR, diffNumR, statusR, dirtyNumR] = await Promise.all([
    baselineHead
      ? exec('git', ['-C', projPath, 'diff', '--name-status', `${baselineHead}..HEAD`], { timeout: 10000 })
      : Promise.resolve(null),
    baselineHead
      ? exec('git', ['-C', projPath, 'diff', '--numstat', `${baselineHead}..HEAD`], { timeout: 10000 })
      : Promise.resolve(null),
    exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 }),
    exec('git', ['-C', projPath, 'diff', '--numstat', 'HEAD'], { timeout: 10000 }),
  ]);

  // Clean baseline: BASE..HEAD is attributable. Dirty baseline: require the
  // agent's report to corroborate the path so unrelated parallel commits do
  // not make a no-op scheduled run look shippable.
  if (diffR && diffR.exitCode === 0) {
    for (const file of parseNameStatus(diffR.stdout, 'high')) {
      const confidence: 'high' | 'low' = !baselineDirty || reportedChangedPaths?.has(file.path)
        ? 'high'
        : 'low';
      files.set(file.path, { ...file, confidence });
    }
  }

  // Uncommitted delta: per-file confidence based on baseline membership.
  if (statusR?.exitCode === 0) {
    for (const file of parsePorcelain(statusR.stdout, 'high')) {
      const confidence: 'high' | 'low' = baselinePaths.has(file.path) ? 'low' : 'high';
      const existing = files.get(file.path);
      if (existing?.confidence === 'high') continue;
      // The agent did NOT introduce this path; it was already dirty. Mark
      // low so the gate filters it but the path remains visible for telemetry.
      files.set(file.path, { ...file, confidence });
    }
  }

  // LOC attribution: only count lines on paths the agent is responsible for.
  // Build the set of high-confidence paths and scope both numstat sums to it.
  // On a dirty baseline, BASE..HEAD is scoped to high-confidence paths for the
  // same reason as uncommitted numstat: a parallel commit should not fire the
  // release-after-run gate for an idle agent.
  const attributedPaths = new Set<string>();
  for (const file of files.values()) {
    if (file.confidence !== 'low') attributedPaths.add(file.path);
  }

  if (diffNumR && diffNumR.exitCode === 0) {
    const d = parseNumstat(diffNumR.stdout, baselineDirty ? attributedPaths : null);
    added += d.added;
    removed += d.removed;
  }
  if (dirtyNumR?.exitCode === 0) {
    const dirtyAttributedPaths = baselineDirty
      ? new Set(Array.from(attributedPaths).filter((path) => !baselinePaths.has(path)))
      : attributedPaths;
    const d = parseNumstat(dirtyNumR.stdout, dirtyAttributedPaths);
    added += d.added;
    removed += d.removed;
  }

  // Untracked (`??`) files are invisible to `git diff`, so neither numstat above
  // counts their lines — a brand-new file (e.g. a docs-generate page) would
  // otherwise contribute 0 LOC despite landing in `modifiedFiles`, depressing
  // run_score and starving the reinforce-to-threshold release gate. Diff each
  // attributed untracked path against /dev/null to recover its added-line count.
  // We scope to high-confidence paths and exclude pre-existing baseline dirt,
  // mirroring the uncommitted-numstat attribution above. `git diff --no-index`
  // exits 1 when it finds a difference (the normal case here), so both 0 and 1
  // are success; binary files come back as `-`/`-` and count 0, as elsewhere.
  const untrackedAttributed = Array.from(files.values()).filter(
    (f) => f.status === '??' && f.confidence !== 'low' && !baselinePaths.has(f.path),
  );
  if (untrackedAttributed.length > 0) {
    const numstats = await Promise.all(
      untrackedAttributed.map((f) =>
        exec('git', ['-C', projPath, 'diff', '--numstat', '--no-index', '--', '/dev/null', f.path], { timeout: 10000 }),
      ),
    );
    for (const r of numstats) {
      if (r.exitCode === 0 || r.exitCode === 1) {
        const d = parseNumstat(r.stdout, null);
        added += d.added;
        removed += d.removed;
      }
    }
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

// Two very different situations both surface as "0 changes across N runs":
//   - idle: the agent keeps reporting "no actionable work" — there is genuinely
//     nothing to do, so the fix is a slower cadence (`agent_schedule_backoff`).
//   - unproductive: the agent reports it DID find work but lands no changes —
//     its prompt/approach is failing, so the fix is to improve the prompt.
// Conflating them sends the operator to the wrong lever. We disambiguate with
// the just-finished run's `actionable` signal (the freshest, zero-extra-query
// indicator of which pattern this streak is in).
type UnfruitfulCause = 'idle' | 'unproductive' | 'unknown';

function unfruitfulCause(actionable: boolean | null): UnfruitfulCause {
  if (actionable === false) return 'idle';
  if (actionable === true) return 'unproductive';
  return 'unknown';
}

async function maybeRecommendFruitfulness(
  job: JobData,
  ctx: AgentContextMeta,
  actionable: boolean | null,
): Promise<void> {
  const agentId = ctx.agent?.id ?? null;
  const agentName = ctx.agent?.name ?? job.kind.replace(/^agent:/, '');
  // Manual triggers shouldn't push the running average toward "deprioritize" —
  // an operator firing an agent on demand is a different signal than a
  // scheduled run that found nothing.
  if (ctx.agent?.triggeredBy !== 'schedule') return;
  // Fruitfulness (files/lines changed) is only a valid value proxy for a
  // producer. A monitor / reviewer / planner reporting no diff is doing its
  // job, so don't flag it as unfruitful — that's the noise this whole change
  // removes. See lib/agents/roles.ts.
  if (!valueIsDiffBased(parseAgentRole(ctx.agent?.role))) return;

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
  if (stats.rate >= UNFRUITFUL_RATE_THRESHOLD) {
    // The agent recovered — its scheduled runs are producing again. Retire any
    // open "isn't producing changes" recommendation so it doesn't linger as a
    // false flag (the row stays until something closes it).
    await resolveRecommendationIfOpen(job.project, 'agent_unfruitful', { agentId, agentName });
    return;
  }

  const cause = unfruitfulCause(actionable);
  // An agent that's idle by design (it reports no actionable work — e.g. the
  // improve agent with an empty queue) is not "unproductive" and needs no
  // "isn't producing changes" flag: that framing is a false alarm that clutters
  // the queue every cycle. The idle case is owned by `agent_schedule_backoff`
  // (raised separately when the cadence is tightenable). Retire any stale
  // unfruitful row and stop — boost deprioritization still happens live off the
  // fruitfulness stats, independent of this recommendation row.
  if (cause === 'idle') {
    await resolveRecommendationIfOpen(job.project, 'agent_unfruitful', { agentId, agentName });
    return;
  }

  const currentSchedule = ctx.agent?.schedule ?? null;
  const fruitfulPct = Math.round(stats.rate * 100);
  const factual =
    `Across the last ${stats.runs} scheduled runs, ${agentName} changed files ${stats.fruitfulRuns} times (${fruitfulPct}%) ` +
    `and moved ${stats.totalLinesChanged} lines total. ` +
    `The orchestrator will deprioritize boosting this agent until it starts producing again.`;
  // Point the operator at the right lever. The card also gates its
  // "Improve prompt" action on this signal. (cause === 'idle' returned above,
  // so only 'unproductive' and 'unknown' reach here.)
  const leverHint =
    cause === 'unproductive'
      ? ' The last run reported it found work but produced no changes — its prompt likely needs to target the work more concretely (try Improve prompt).'
      : '';
  await upsertRecommendation({
    project: job.project,
    sourceKind: job.kind,
    sourceId: job.id,
    agentId,
    agentName,
    type: 'agent_unfruitful',
    title: `${agentName} isn't producing changes`,
    detail: factual + leverHint,
    payload: {
      reason: 'agent produced no changes across recent scheduled runs',
      cause,
      lastRunActionable: actionable,
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
  const agentId = ctx.agent?.id ?? null;
  const currentSchedule = ctx.agent?.schedule ?? null;
  const hours = scheduleHours(currentSchedule);

  // Recovery: if a scheduled run found actionable work (or changed files), a
  // prior "run less often" recommendation is no longer valid — retire it.
  if (ctx.agent?.triggeredBy === 'schedule' && (files.length > 0 || actionable === true)) {
    void resolveRecommendationIfOpen(job.project, 'agent_schedule_backoff', { agentId, agentName });
  }
  if (
    job.exitCode !== 0 ||
    ctx.agent?.triggeredBy !== 'schedule' ||
    ctx.baseline?.dirty ||
    actionable !== false ||
    files.length > 0 ||
    hours == null ||
    hours >= 8 ||
    // Never suggest a slower cadence for non-producers — a monitor/reviewer
    // reporting "nothing to do" is a successful pass, not idleness to throttle.
    !valueIsDiffBased(parseAgentRole(ctx.agent?.role))
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
  const { files, lines } = await worktreeDelta(job, ctx, parseReportedChangedPaths(text));
  job.workSummary = summary;
  job.modifiedFiles = JSON.stringify(files);
  job.linesAdded = lines.added;
  job.linesRemoved = lines.removed;
  // run_score is computed centrally in lib/jobs/lifecycle.ts after this
  // returns, so every finalized job (agent + step) is scored from one place.
  if (job.kind === 'agent:issue-cruncher' && job.ghIssueNumber == null) {
    const parsed = parseIssueNumberFromSummary(summary);
    if (parsed != null) job.ghIssueNumber = parsed;
  }
  if (isAgent) {
    maybeRecommendSchedule(job, ctx, files, actionable);
    // Fire-and-forget — the recommendation surfaces in /recommendations on
    // the next render; a transient DB error must not fail the job finalize.
    void maybeRecommendFruitfulness(job, ctx, actionable).catch((e) => {
      console.warn('[agent-run-report] fruitfulness recommendation failed:', e);
    });
    if (job.kind === 'agent:health') {
      // The health monitor produces no diff by design; its signal is the
      // verdict, not a change. Persist it on the job and surface DEGRADED/DOWN.
      void (async () => {
        const { applyHealthVerdict } = await import('@/lib/agents/health-report');
        await applyHealthVerdict(job, text);
      })().catch((e) => console.warn('[agent-run-report] health verdict handling failed:', e));
    }
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
