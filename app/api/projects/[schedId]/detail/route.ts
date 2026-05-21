import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
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
  if (cfg.prompt && existsSync(/*turbopackIgnore: true*/ cfg.prompt)) {
    try { promptContent = readFileSync(/*turbopackIgnore: true*/ cfg.prompt, 'utf-8'); } catch {}
  }

  const memoryFilename = cfg.scheduler
    ? `${cfg.project}-${cfg.scheduler}.md`
    : `${cfg.project}.md`;
  const memoryPath = join(/*turbopackIgnore: true*/ homedir(), '.claude', 'memory', memoryFilename);
  let memoryContent: string | null = null;
  if (existsSync(/*turbopackIgnore: true*/ memoryPath)) {
    try { memoryContent = readFileSync(/*turbopackIgnore: true*/ memoryPath, 'utf-8'); } catch {}
  }

  // Source run history from the in-memory jobs cache. The previous
  // implementation read `~/.cache/tamtam/schedule-runs.jsonl`, but the
  // companion writer (`recordRunStart`/`recordRunEnd` in
  // `lib/jobs/run-history.ts`) is no longer called from production code,
  // so that file is never populated. The `jobs` table absorbed this
  // responsibility when CLAUDE.md's "Runtime state lives in DB" rule
  // landed — we just hadn't migrated this consumer yet.
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
