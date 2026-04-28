import { NextRequest, NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { db, schema } from '@/lib/db';
import { resolveProjectPath } from '@/lib/project-data';
import { getImproveConfig } from '@/lib/scheduling';
import { checkIssueBranchBlock } from '@/lib/start-release';
import { SKILLS_DIR, DATA_SKILLS_DIR } from '@/lib/skills';
import { createJob, updateJob, listJobs, probeJobStatus } from '@/lib/job-storage';
import { startJob } from '@/lib/pm2-jobs';
import { withBasePrompt, getPermissionModeFlag } from '@/lib/config';
import { errMsg } from '@/lib/types';
import { parseFileAgentId, loadFileAgent } from '@/lib/tamtam-file-agents';
import { getAgentMemoryDir, getAgentMemoryPath, readAgentMemory, ensureAgentMemoryDir, buildMemoryBlock } from '@/lib/agent-memory';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  // Resolve agent — either a DB row or a file-based agent
  let agent: { id: string; name: string; project: string; skillIds: string; docPaths: string; model: string; prompt: string; schedule: string | null; runner: string; enabled: boolean } | null = null;

  const parsedFileId = parseFileAgentId(agentId);
  if (parsedFileId) {
    const projPath = resolveProjectPath(parsedFileId.project);
    if (!projPath) return NextResponse.json({ detail: 'agent not found' }, { status: 404 });
    const fa = loadFileAgent(projPath, parsedFileId.project, parsedFileId.name);
    if (!fa) return NextResponse.json({ detail: 'agent not found' }, { status: 404 });
    agent = { ...fa, skillIds: JSON.stringify(fa.skillIds), docPaths: JSON.stringify(fa.docPaths) };
  } else {
    const row = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (row) agent = row;
  }

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
  const taskPrompt = body.prompt?.trim() ?? '';
  const hasSkills = JSON.parse(agent.skillIds || '[]').length > 0;
  if (!taskPrompt && !hasSkills) {
    return NextResponse.json({ detail: 'agent has no prompt and no skills to run' }, { status: 400 });
  }

  const projPath = resolveProjectPath(agent.project);
  if (!projPath) {
    return NextResponse.json({ detail: `project '${agent.project}' not found` }, { status: 404 });
  }

  // In Direct Branch mode, block agent runs while a fix/issue-* branch is
  // checked out. Scheduled agents committing to an issue branch would mix
  // unrelated work into the issue and push to the wrong branch.
  const blockedBranch = await checkIssueBranchBlock(agent.project, projPath);
  if (blockedBranch) {
    return NextResponse.json(
      { detail: `Cannot run agent in Direct Branch mode while on issue branch '${blockedBranch}' — finish or abandon issue work first`, branch: blockedBranch },
      { status: 409 }
    );
  }

  // Compose skills into system prompt. Agent skillIds can be:
  //   - DB skill UUIDs  -> read content from `skills` table
  //   - `persona:<path>` -> read file from `skills/docs/skills/<path>.md`
  const allSkillIds: string[] = JSON.parse(agent.skillIds);
  const dbSkillIds = allSkillIds.filter((id) => !id.startsWith('persona:'));
  const personaPaths = allSkillIds
    .filter((id) => id.startsWith('persona:'))
    .map((id) => id.slice('persona:'.length));

  // Load project docs first — they are prepended before skills so skills can reference them.
  const docPaths: string[] = JSON.parse(agent.docPaths || '[]');
  const docParts: string[] = [];
  const metaDocs: Array<{ name: string; path: string }> = [];
  for (const docPath of docPaths) {
    const fullPath = join(projPath, docPath);
    if (!fullPath.startsWith(projPath + '/')) continue;
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        docParts.push(`## ${basename(docPath)}\n${content}`);
        metaDocs.push({ name: basename(docPath), path: docPath });
      } catch {}
    }
  }

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
  const allParts = [...docParts, ...parts];
  const systemPrompt = allParts.join('\n\n---\n\n');
  const contextMeta = JSON.stringify({ skills: metaSkills, docs: metaDocs });

  const { claudeBin, logDir } = getImproveConfig();

  // Inject agent memory so it can track state across runs.
  const memDir = getAgentMemoryDir();
  ensureAgentMemoryDir(memDir, agent.project);
  const memoryPath = getAgentMemoryPath(memDir, agent.project, agent.name);
  const currentMemory = readAgentMemory(memDir, agent.project, agent.name);
  const memoryBlock = buildMemoryBlock(memoryPath, currentMemory);

  // Build command. We prepend the composed skills directly to the prompt
  // (stdin) rather than using --append-system-prompt, which requires a value
  // argument and would need escaping for multi-line content.
  const modelFlag = agent.model ? `--model ${agent.model}` : '';
  const cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose ${getPermissionModeFlag()} ${modelFlag}`;

  const corePrompt = systemPrompt && taskPrompt
    ? `${systemPrompt}\n\n---\n\n${taskPrompt}`
    : (systemPrompt || taskPrompt);
  const fullPrompt = withBasePrompt(`${corePrompt}\n\n---\n\n${memoryBlock}`);

  const job = createJob(agent.project, `agent:${agent.name}`, 0, '', taskPrompt, contextMeta, taskPrompt);
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(job.id, cmd, fullPrompt, projPath);
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
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
