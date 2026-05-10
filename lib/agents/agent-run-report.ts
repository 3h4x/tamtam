import { parseStreamLines } from '@/lib/jobs/claude-stream-parser';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { upsertRecommendation } from '@/lib/recommendations/recommendations';
import { isAgentJobKind } from '@/lib/jobs/kinds';
import type { JobData } from '@/lib/jobs/types';

interface AgentContextMeta {
  agent?: { id?: string; name?: string; schedule?: string | null; triggeredBy?: string };
  baseline?: { head?: string | null; status?: string | null; dirty?: boolean | null };
}

interface ModifiedFile {
  path: string;
  status: string;
  confidence?: 'high' | 'low';
}

function parseContextMeta(raw: string | null | undefined): AgentContextMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AgentContextMeta;
  } catch {
    return {};
  }
}

function assistantText(rawLog: string): string {
  return parseStreamLines(rawLog)
    .filter((e) => e.type === 'text')
    .map((e) => e.type === 'text' ? e.text : '')
    .join('')
    .trim();
}

function compact(s: string, max = 280): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

function reportField(text: string, label: string): string | null {
  const re = new RegExp(`^\\s*[-*]?\\s*${label}:\\s*(.+)$`, 'im');
  return text.match(re)?.[1]?.trim() ?? null;
}

function extractSummary(text: string): { summary: string | null; actionable: boolean | null } {
  const reportIdx = text.toLowerCase().lastIndexOf('tamtam run report');
  const report = reportIdx >= 0 ? text.slice(reportIdx) : text;
  const summary = reportField(report, 'Summary');
  const actionableRaw = reportField(report, 'Actionable work');
  const actionable = actionableRaw
    ? /^yes\b/i.test(actionableRaw) ? true : /^no\b/i.test(actionableRaw) ? false : null
    : null;
  if (summary) return { summary: compact(summary), actionable };

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/tamtam run report/i.test(p));
  return { summary: paragraphs.length ? compact(paragraphs[paragraphs.length - 1]) : null, actionable };
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

async function modifiedFiles(job: JobData, ctx: AgentContextMeta): Promise<ModifiedFile[]> {
  const projPath = resolveProjectPath(job.project);
  if (!projPath) return [];
  const confidence: 'high' | 'low' = ctx.baseline?.dirty ? 'low' : 'high';
  const files = new Map<string, ModifiedFile>();

  if (ctx.baseline?.head) {
    const diffR = await exec('git', ['-C', projPath, 'diff', '--name-status', `${ctx.baseline.head}..HEAD`], { timeout: 10000 });
    if (diffR.exitCode === 0) {
      for (const file of parseNameStatus(diffR.stdout, confidence)) files.set(file.path, file);
    }
  }

  const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
  if (statusR.exitCode === 0 && (ctx.baseline?.dirty || statusR.stdout !== (ctx.baseline?.status ?? ''))) {
    for (const file of parsePorcelain(statusR.stdout, confidence)) files.set(file.path, file);
  }

  return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function scheduleHours(schedule: string | null | undefined): number | null {
  if (!schedule) return null;
  const m = schedule.trim().match(/^(\d+)([mh])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].toLowerCase() === 'm' ? n / 60 : n;
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

  upsertRecommendation({
    project: job.project,
    sourceKind: job.kind,
    sourceId: job.id,
    agentId: ctx.agent?.id ?? null,
    agentName,
    type: 'agent_schedule_backoff',
    title: `Run ${agentName} less often`,
    detail: `Recent run found no actionable work. Current schedule is ${currentSchedule}; consider 8h.`,
    payload: {
      currentSchedule,
      recommendedSchedule: '8h',
      reason: 'recent run found no actionable work',
      confidence: actionable === false ? 'high' : 'medium',
    },
  });
}

export async function finalizeAgentRunReport(job: JobData, rawLog: string): Promise<void> {
  const isAgent = isAgentJobKind(job.kind);
  const isIssueRun = job.kind === 'run' && job.ghIssueNumber != null;
  if (!isAgent && !isIssueRun) return;
  const ctx = parseContextMeta(job.contextMeta);
  const text = assistantText(rawLog);
  const { summary, actionable } = extractSummary(text);
  const files = await modifiedFiles(job, ctx);
  job.workSummary = summary;
  job.modifiedFiles = JSON.stringify(files);
  if (isAgent) maybeRecommendSchedule(job, ctx, files, actionable);
}
