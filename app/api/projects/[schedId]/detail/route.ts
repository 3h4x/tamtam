import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { listJobs } from '@/lib/jobs/storage';

const HISTORY_LIMIT = 20;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ schedId: string }> }
) {
  const { schedId } = await params;
  const { projects } = getImproveConfig();
  const cfg = projects[schedId];
  if (!cfg) {
    return NextResponse.json({ detail: `task '${schedId}' not found` }, { status: 404 });
  }

  let promptContent: string | null = null;
  if (cfg.prompt) {
    try { promptContent = readFileSync(/*turbopackIgnore: true*/ cfg.prompt, 'utf-8'); } catch {}
  }

  const memoryFilename = cfg.scheduler
    ? `${cfg.project}-${cfg.scheduler}.md`
    : `${cfg.project}.md`;
  const memoryPath = join(/*turbopackIgnore: true*/ homedir(), '.claude', 'memory', memoryFilename);
  let memoryContent: string | null = null;
  try { memoryContent = readFileSync(/*turbopackIgnore: true*/ memoryPath, 'utf-8'); } catch {}

  const runHistory = listJobs()
    .filter((j) => j.project === schedId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, HISTORY_LIMIT)
    .map((j) => ({
      started: new Date(j.startedAt * 1000).toISOString(),
      ended: j.finishedAt != null ? new Date(j.finishedAt * 1000).toISOString() : null,
      duration_s: j.finishedAt != null ? Math.max(0, Math.floor(j.finishedAt - j.startedAt)) : null,
      exit_code: j.exitCode,
    }));

  return NextResponse.json({
    id: schedId,
    project: cfg.project,
    job: cfg.scheduler,
    prompt_path: cfg.prompt,
    prompt_content: promptContent,
    memory_path: memoryContent ? memoryPath : null,
    memory_content: memoryContent,
    persona: cfg.persona,
    run_history: runHistory,
  });
}
