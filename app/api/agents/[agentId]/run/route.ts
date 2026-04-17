import { NextRequest, NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { join } from 'path';
import { db, schema } from '@/lib/db';
import { checkAuth } from '@/lib/auth';
import { resolveProjectPath } from '@/lib/project-data';
import { getImproveConfig } from '@/lib/scheduling';
import { createJob, updateJob, listJobs, probeJobStatus } from '@/lib/job-storage';
import { startJob } from '@/lib/pm2-jobs';
import { withBasePrompt } from '@/lib/config';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { agentId } = await params;

  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!agent) return NextResponse.json({ detail: 'agent not found' }, { status: 404 });

  // Prevent duplicate runs: check if this agent is already running
  const kindKey = `agent:${agent.name}`;
  const candidates = listJobs().filter(
    (j) => j.project === agent.project && j.kind === kindKey && j.finishedAt === null
  );
  for (const j of candidates) {
    if ((await probeJobStatus(j)) === 'running') {
      return NextResponse.json(
        { detail: `Agent '${agent.name}' is already running (job ${j.id})` },
        { status: 409 }
      );
    }
  }

  const body = await request.json();
  const taskPrompt = body.prompt?.trim();
  if (!taskPrompt) {
    return NextResponse.json({ detail: 'prompt is required' }, { status: 400 });
  }

  const projPath = resolveProjectPath(agent.project);
  if (!projPath) {
    return NextResponse.json({ detail: `project '${agent.project}' not found` }, { status: 404 });
  }

  // Compose skills into system prompt
  const skillIds: string[] = JSON.parse(agent.skillIds);
  let systemPrompt = '';
  if (skillIds.length > 0) {
    const skills = db.select().from(schema.skills).where(inArray(schema.skills.id, skillIds)).all();
    const parts = skills.map(s => `## ${s.name}\n${s.content}`);
    systemPrompt = parts.join('\n\n---\n\n');
  }

  const { claudeBin, logDir } = getImproveConfig();

  // Build command with model and system prompt
  const modelFlag = agent.model ? `--model ${agent.model}` : '';
  let cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --dangerously-skip-permissions ${modelFlag}`;
  if (systemPrompt) {
    cmd += ` --append-system-prompt`;
  }

  // Combine base prompt + system prompt + task prompt
  const fullPrompt = withBasePrompt(
    systemPrompt ? `${systemPrompt}\n\n---\n\n${taskPrompt}` : taskPrompt
  );

  const job = createJob(agent.project, `agent:${agent.name}`, 0, '', taskPrompt);
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(job.id, cmd, fullPrompt, projPath);
    job.pid = pid;
  } catch (e: any) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    return NextResponse.json({ detail: `Failed to start: ${e.message}` }, { status: 500 });
  }

  updateJob(job);

  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    agent: agent.name,
  });
}
