import { NextRequest, NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { db, schema } from '@/lib/db';
import { resolveProjectPath } from '@/lib/project-data';
import { getImproveConfig } from '@/lib/scheduling';
import { SKILLS_DIR, DATA_SKILLS_DIR } from '@/lib/skills';
import { createJob, updateJob, listJobs, probeJobStatus } from '@/lib/job-storage';
import { startJob } from '@/lib/pm2-jobs';
import { withBasePrompt, getPermissionModeFlag } from '@/lib/config';
import { errMsg } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!agent) return NextResponse.json({ detail: 'agent not found' }, { status: 404 });

  // Reject scheduled triggers for disabled agents. PM2 may still hold stale
  // cron entries (e.g. after a rename or schedule clear) — this is the final
  // guard so disabled/unscheduled agents don't silently keep running.
  const triggeredBy = request.headers.get('x-tamtam-trigger') || 'manual';
  const isScheduled = triggeredBy === 'schedule';
  if (!agent.enabled && isScheduled) {
    return NextResponse.json({ detail: `Agent '${agent.name}' is disabled — ignoring scheduled trigger` }, { status: 409 });
  }
  if (!agent.schedule && isScheduled) {
    return NextResponse.json({ detail: `Agent '${agent.name}' has no schedule — ignoring scheduled trigger` }, { status: 409 });
  }

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

  // Compose skills into system prompt. Agent skillIds can be:
  //   - DB skill UUIDs  -> read content from `skills` table
  //   - `persona:<path>` -> read file from `skills/docs/skills/<path>.md`
  const allSkillIds: string[] = JSON.parse(agent.skillIds);
  const dbSkillIds = allSkillIds.filter((id) => !id.startsWith('persona:'));
  const personaPaths = allSkillIds
    .filter((id) => id.startsWith('persona:'))
    .map((id) => id.slice('persona:'.length));

  const parts: string[] = [];
  // contextMeta mirrors the terminal's snapshot so the UI can render toolbar
  // chips for the agent's configured skills when the run is opened.
  const metaSkills: Array<{ id: string; name: string; description: string; content?: string; source: 'db' | 'file' }> = [];
  if (dbSkillIds.length > 0) {
    const rows = db.select().from(schema.skills).where(inArray(schema.skills.id, dbSkillIds)).all();
    for (const s of rows) {
      parts.push(`## ${s.name}\n${s.content}`);
      metaSkills.push({ id: s.id, name: s.name, description: s.description ?? '', content: s.content, source: 'db' });
    }
  }
  const docsBase = join(SKILLS_DIR, 'docs', 'skills');
  for (const p of personaPaths) {
    const fallbackName = p.split('/').pop() ?? p;
    const file = existsSync(join(docsBase, `${p}.md`))
      ? join(docsBase, `${p}.md`)
      : join(DATA_SKILLS_DIR, `${p}.md`);
    if (existsSync(file)) {
      try {
        const body = readFileSync(file, 'utf-8');
        parts.push(body);
        // Try to pull a human-readable name from frontmatter `name:` or first heading.
        let display = fallbackName;
        const fm = body.match(/^---[\s\S]*?\nname:\s*(.+?)\s*\n[\s\S]*?---/);
        if (fm) display = fm[1].trim();
        else {
          const h = body.match(/^#\s+(.+)$/m);
          if (h) display = h[1].trim();
        }
        metaSkills.push({ id: `persona:${p}`, name: display, description: p, source: 'file' });
      } catch {}
    } else {
      metaSkills.push({ id: `persona:${p}`, name: fallbackName, description: p, source: 'file' });
    }
  }
  const systemPrompt = parts.join('\n\n---\n\n');
  const contextMeta = JSON.stringify({ skills: metaSkills, docs: [] });

  const { claudeBin, logDir } = getImproveConfig();

  // Build command. We prepend the composed skills directly to the prompt
  // (stdin) rather than using --append-system-prompt, which requires a value
  // argument and would need escaping for multi-line content.
  const modelFlag = agent.model ? `--model ${agent.model}` : '';
  const cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose ${getPermissionModeFlag()} ${modelFlag}`;

  const fullPrompt = withBasePrompt(
    systemPrompt ? `${systemPrompt}\n\n---\n\n${taskPrompt}` : taskPrompt
  );

  const job = createJob(agent.project, `agent:${agent.name}`, 0, '', taskPrompt, contextMeta, taskPrompt);
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(job.id, cmd, fullPrompt, projPath);
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    return NextResponse.json({ detail: `Failed to start: ${errMsg(e)}` }, { status: 500 });
  }

  updateJob(job);

  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    agent: agent.name,
  });
}
