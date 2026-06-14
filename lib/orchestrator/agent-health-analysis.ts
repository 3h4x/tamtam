// Orchestrator agent-health analysis.
//
// Beyond the boost decision (`budget-allocator.ts`) and the heuristic
// fruitfulness signal (`fruitfulness.ts`), this module asks an LLM the
// question those two can't: "looking at this agent's last few work summaries,
// does its output actually make sense — or is it looping, drifting off-prompt,
// producing noise, or making risky changes?"
//
// Called from the orchestrator tick (`orchestrator-tick-task.ts`) as a
// fire-and-forget phase. The tick decides *which* agents are eligible (new
// runs since last analysis, capped per tick); this module does the per-agent
// DB read + LLM call + recommendation write. Errors are swallowed per
// candidate so one bad analysis never blocks the tick or the others.
//
// The LLM call goes through the bundled Claude CLI shim in `--print` mode
// (subscription auth, budget-gated) — the same path `improve-prompt` uses —
// NOT a direct Anthropic API call, because TamTam's self-hosted model doesn't
// assume an ANTHROPIC_API_KEY is present. The runner is injectable so tests
// can supply a deterministic response without spawning a process.

import { spawn } from 'child_process';
import { and, desc, isNotNull, like, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { upsertRecommendation, resolveRecommendationIfOpen } from '@/lib/recommendations/recommendations';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { getSettings, getPermissionModeFlag } from '@/lib/shared/config';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { buildChildEnv } from '@/lib/shared/child-env';

export interface HealthCandidate {
  id: string;
  name: string;
  project: string;
}

export interface HealthAnalysisOutcome {
  agentId: string;
  analyzed: boolean;
  latestRunStartedAt: number | null;
  /** LLM verdict signals, surfaced so the autopilot can act on the same
   *  analysis pass without re-reading runs. `concern`/`concernType` drive
   *  producer cadence-throttle; `allIdle` (every analyzed run was idle-by-
   *  design) drives monitor model-downgrade; `anyFruitful` (a run changed
   *  files/lines) drives restore. Absent fields default to "no signal". */
  concern?: boolean;
  concernType?: HealthVerdict['concernType'];
  allIdle?: boolean;
  anyFruitful?: boolean;
}

/** Injectable LLM runner: takes a prompt, returns the model's raw text output
 *  or null when the call failed / was budget-gated. The default implementation
 *  spawns the Claude CLI shim in `--print` mode. */
export type HealthPrintRunner = (prompt: string) => Promise<string | null>;

export interface HealthAnalysisDeps {
  runPrint?: HealthPrintRunner;
}

interface RunRow {
  jobId: string;
  workSummary: string | null;
  runScore: number | null;
  modifiedFilesCount: number;
  linesChanged: number;
  startedAt: number;
}

interface AgentContextMeta {
  agent?: {
    id?: string;
    name?: string;
    triggeredBy?: string;
  };
}

interface HealthVerdict {
  concern: boolean;
  concernType: 'none' | 'loop' | 'drift' | 'noise' | 'quality';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  recommendation: string | null;
}

const PRINT_TIMEOUT_MS = 60_000;
const PRINT_KILL_GRACE_MS = 5_000;

// A run that changed nothing AND whose summary says there was nothing to do is
// idle-by-design, not a health problem. Matches the common "no actionable work"
// phrasings plus the improve agent's empty-queue sentinel. Used to (a) skip the
// LLM entirely when every analyzed run is idle and (b) annotate idle runs in the
// prompt so the model doesn't mistake a caught-up agent for loop/noise.
const IDLE_SUMMARY_RE =
  /no actionable|nothing to (do|change|fix|consolidate)|already (clean|audited)|queue (is )?empty|IMPROVE_QUEUE_ROTATED|idle until|no .{0,30}target|no (coverage |edits )?(gaps?|required)/i;

function runIndicatesIdle(run: RunRow): boolean {
  if (run.modifiedFilesCount > 0 || run.linesChanged > 0) return false;
  const summary = run.workSummary?.trim();
  if (!summary) return false;
  return IDLE_SUMMARY_RE.test(summary);
}

function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseAgentMeta(rawMeta: string | null): AgentContextMeta | null {
  if (!rawMeta) return null;
  try {
    return JSON.parse(rawMeta) as AgentContextMeta;
  } catch {
    return null;
  }
}

function scheduledRunContextPredicate(): SQL {
  return sql`(${schema.jobs.contextMeta} LIKE '%"triggeredBy":"schedule"%' OR ${schema.jobs.contextMeta} LIKE '%"triggeredBy": "schedule"%')`;
}

function jsonStringFieldPredicate(field: 'id', value: string): SQL {
  const encoded = escapeLike(JSON.stringify(value).slice(1, -1));
  return sql`(
    ${schema.jobs.contextMeta} LIKE ${`%"${field}":"${encoded}"%`} ESCAPE '\\'
    OR ${schema.jobs.contextMeta} LIKE ${`%"${field}": "${encoded}"%`} ESCAPE '\\'
  )`;
}

async function loadRecentRuns(candidate: HealthCandidate, limit: number): Promise<RunRow[]> {
  const rows = await db
    .select({
      id: schema.jobs.id,
      workSummary: schema.jobs.workSummary,
      runScore: schema.jobs.runScore,
      modifiedFiles: schema.jobs.modifiedFiles,
      linesAdded: schema.jobs.linesAdded,
      linesRemoved: schema.jobs.linesRemoved,
      startedAt: schema.jobs.startedAt,
      contextMeta: schema.jobs.contextMeta,
    })
    .from(schema.jobs)
    .where(
      and(
        isNotNull(schema.jobs.finishedAt),
        like(schema.jobs.kind, 'agent:%'),
        sql`${schema.jobs.project} = ${candidate.project}`,
        scheduledRunContextPredicate(),
        jsonStringFieldPredicate('id', candidate.id),
      ),
    )
    .orderBy(desc(schema.jobs.startedAt))
    .limit(limit);

  const runs: RunRow[] = [];
  for (const row of rows) {
    if (runs.length >= limit) break;
    const meta = parseAgentMeta(row.contextMeta);
    if (meta?.agent?.triggeredBy !== 'schedule') continue;
    if (meta.agent.id !== candidate.id) continue;
    let modifiedFilesCount = 0;
    if (row.modifiedFiles) {
      try {
        const arr = JSON.parse(row.modifiedFiles) as Array<{ confidence?: string }>;
        if (Array.isArray(arr)) {
          modifiedFilesCount = arr.filter((f) => f?.confidence !== 'low').length;
        }
      } catch {
        /* ignore malformed JSON */
      }
    }
    runs.push({
      jobId: row.id,
      workSummary: row.workSummary ?? null,
      runScore: row.runScore ?? null,
      modifiedFilesCount,
      linesChanged: (row.linesAdded ?? 0) + (row.linesRemoved ?? 0),
      startedAt: row.startedAt,
    });
  }
  return runs;
}

export async function loadLatestFinishedScheduledRunStartedAt(
  candidate: HealthCandidate,
): Promise<number | null> {
  const runs = await loadRecentRuns(candidate, 1);
  return runs[0]?.startedAt ?? null;
}

function buildPrompt(candidate: HealthCandidate, runs: RunRow[]): string {
  const runBlocks = runs
    .map((r, i) =>
      [
        `Run ${i + 1} (score: ${r.runScore ?? 'n/a'}/100, files: ${r.modifiedFilesCount}, lines: ${r.linesChanged})${runIndicatesIdle(r) ? ' [idle — reported no actionable work]' : ''}:`,
        r.workSummary?.trim() || '(no summary available)',
      ].join('\n'),
    )
    .join('\n\n');

  return `You are a code agent supervisor. Below are work summaries from the ${runs.length} most recent scheduled runs of agent "${candidate.name}" on project "${candidate.project}", newest first.

${runBlocks}

Assess the agent's recent output pattern. Return ONLY valid JSON with this exact shape — no markdown, no explanation:
{
  "concern": boolean,
  "concernType": "none" | "loop" | "drift" | "noise" | "quality",
  "severity": "low" | "medium" | "high",
  "summary": "one sentence describing what the agent has been doing",
  "recommendation": "one sentence for the operator, or null if no concern"
}

Definitions:
- loop: agent repeats similar small changes across runs without making progress
- drift: agent works on unrelated things or off-prompt
- noise: agent produces activity but no meaningful progress (reformatting, trivial tweaks)
- quality: agent changes look incorrect, risky, or counter-productive
- none: agent appears healthy and productive

IMPORTANT — idle is healthy, not a concern: many agents only act when there is
work to do (a queue, a coverage gap, a drifted doc). A run that made no changes
because it found no actionable work — including runs marked "[idle]" above, runs
reporting an empty queue, or "nothing to do" — is the correct, expected outcome,
NOT loop or noise. Do NOT raise a concern for an agent that is simply idle
because there is nothing to act on. Only flag loop/noise/quality when the agent
is actually making (or attempting) changes that repeat, drift, or look wrong.`;
}

/** Strip a leading ```json\n…\n``` fence if the model wraps its JSON despite
 *  the instruction, then JSON.parse. Returns null on any failure. */
function parseVerdict(text: string): HealthVerdict | null {
  let out = text.trim();
  const fence = out.match(/^```(?:[a-zA-Z0-9_-]*)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) out = fence[1].trim();
  // Tolerate leading prose before the JSON object by slicing from the first {.
  const firstBrace = out.indexOf('{');
  if (firstBrace > 0) out = out.slice(firstBrace);
  try {
    return JSON.parse(out) as HealthVerdict;
  } catch {
    return null;
  }
}

/** Default runner — spawns the Claude CLI shim in `--print` mode using the
 *  budget-gated provider. Returns stdout on exit 0, null otherwise. Scheduled
 *  (isScheduled) so the pace projection can skip it when over plan. */
async function defaultRunPrint(prompt: string): Promise<string | null> {
  const gate = await checkCliStartGate('orchestrator agent health analysis', {
    requestedModel: 'fast',
    isScheduled: true,
    respectJobsPaused: true,
  });
  if (!gate.ok) return null;

  const settings = getSettings();
  const bin = resolveCliBin(gate.provider, settings);
  const env = resolveCliEnv(gate.provider, settings);
  const permissionArgs = getPermissionModeFlag().trim().split(/\s+/).filter(Boolean);
  const args = ['--print', '--model', 'fast', ...permissionArgs];

  return new Promise<string | null>((resolve) => {
    const child = spawn(bin, args, { env: buildChildEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: string | null, clearKill = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (clearKill && killTimer) clearTimeout(killTimer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, PRINT_KILL_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      finish(null, false);
    }, PRINT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    const { stdin, stdout: out, stderr } = child;
    if (!stdin || !out || !stderr) {
      finish(null);
      return;
    }
    out.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
    stderr.on('data', () => { /* drain so the pipe never blocks */ });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(stdoutChunks).toString('utf8') : null));
    try {
      stdin.write(prompt);
      stdin.end();
    } catch {
      // child died before stdin write — close handler resolves
    }
  });
}

/** Analyze each candidate agent's recent output and write an
 *  `orchestrator_agent_health` recommendation when a concern is detected.
 *  Per-candidate failures are swallowed so the orchestrator tick never throws.
 *  The LLM runner is injectable for tests. */
export async function analyzeAgentHealth(
  candidates: HealthCandidate[],
  deps: HealthAnalysisDeps = {},
): Promise<HealthAnalysisOutcome[]> {
  const runPrint = deps.runPrint ?? defaultRunPrint;
  const outcomes: HealthAnalysisOutcome[] = [];

  for (const candidate of candidates) {
    try {
      const runs = await loadRecentRuns(candidate, 3);
      if (runs.length === 0) continue;
      const latestRunStartedAt = runs[0]?.startedAt ?? null;

      // Deterministic short-circuit: if every analyzed run is idle-by-design
      // (no changes, reported no actionable work), the agent is healthy and
      // simply caught up. Skip the LLM call entirely — it saves a budget-gated
      // spend and removes the chance of the model mislabeling idle as loop/noise.
      // Retire any stale health concern so a now-idle agent's card clears.
      if (runs.every(runIndicatesIdle)) {
        await resolveRecommendationIfOpen(candidate.project, 'orchestrator_agent_health', {
          agentId: candidate.id,
          agentName: candidate.name,
        });
        outcomes.push({
          agentId: candidate.id,
          analyzed: true,
          latestRunStartedAt,
          concern: false,
          concernType: 'none',
          allIdle: true,
          anyFruitful: false,
        });
        continue;
      }

      const anyFruitful = runs.some((r) => r.modifiedFilesCount > 0 || r.linesChanged > 0);
      const text = await runPrint(buildPrompt(candidate, runs));
      if (!text) continue;
      const verdict = parseVerdict(text);
      if (!verdict) continue;

      if (verdict.concern) {
        const scoresPresent = runs.filter((r) => r.runScore != null);
        const avgScore =
          scoresPresent.length > 0
            ? scoresPresent.reduce((s, r) => s + (r.runScore ?? 0), 0) / scoresPresent.length
            : null;

        await upsertRecommendation({
          project: candidate.project,
          sourceKind: 'orchestrator',
          sourceId: null,
          agentId: candidate.id,
          agentName: candidate.name,
          type: 'orchestrator_agent_health',
          title: `${candidate.name} — ${verdict.concernType} detected`,
          detail: verdict.summary + (verdict.recommendation ? ` ${verdict.recommendation}` : ''),
          payload: {
            concern: true,
            concernType: verdict.concernType,
            severity: verdict.severity,
            llmSummary: verdict.summary,
            llmRecommendation: verdict.recommendation,
            runsAnalyzed: runs.length,
            runIds: runs.map((r) => r.jobId),
            lastRunScore: runs[0]?.runScore ?? null,
            avgRunScore: avgScore,
          },
        });
      } else {
        // Latest analysis found no concern — retire any open health
        // recommendation for this agent so a resolved loop/noise trend doesn't
        // linger on the board.
        await resolveRecommendationIfOpen(candidate.project, 'orchestrator_agent_health', {
          agentId: candidate.id,
          agentName: candidate.name,
        });
      }
      outcomes.push({
        agentId: candidate.id,
        analyzed: true,
        latestRunStartedAt,
        concern: verdict.concern,
        concernType: verdict.concernType,
        allIdle: false,
        anyFruitful,
      });
    } catch {
      // Swallow per spec — analysis failure must not block the tick.
    }
  }
  return outcomes;
}
