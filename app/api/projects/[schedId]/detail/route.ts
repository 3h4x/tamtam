import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { readRunHistory } from '@/lib/jobs/run-history';

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
  if (cfg.prompt && existsSync(cfg.prompt)) {
    try { promptContent = readFileSync(cfg.prompt, 'utf-8'); } catch {}
  }

  const memoryFilename = cfg.scheduler
    ? `${cfg.project}-${cfg.scheduler}.md`
    : `${cfg.project}.md`;
  const memoryPath = join(homedir(), '.claude', 'memory', memoryFilename);
  let memoryContent: string | null = null;
  if (existsSync(memoryPath)) {
    try { memoryContent = readFileSync(memoryPath, 'utf-8'); } catch {}
  }

  const history = readRunHistory(schedId, 20);
  const runHistory = history.map((run) => ({
    started: run.started,
    ended: run.ended,
    duration_s: run.durationS,
    exit_code: run.exitCode,
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
