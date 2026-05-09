import { NextRequest, NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { db, schema } from '@/lib/db';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { checkIssueBranchBlock } from '@/lib/pipeline/start-release';
import { isLockOwnedByActiveRelease, getLock } from '@/lib/pipeline/pipeline-lock';
import { getPendingRelease, drainPendingRelease } from '@/lib/pipeline/pending-release';
import { enqueueQueuedAgentRun } from '@/lib/agents/queued-agent-runs';
import { SKILLS_DIR, DATA_SKILLS_DIR } from '@/lib/skills/skills';
import { createJob, updateJob, listJobs, probeJobStatus } from '@/lib/jobs/job-storage';
import { startJob } from '@/lib/jobs/pm2-jobs';
import { getJobKind, isAgentJobKind } from '@/lib/jobs/kinds';
import { withBasePrompt, getPermissionModeFlag } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { exec } from '@/lib/shared/shell';
import { getDirtyFileCount } from '@/lib/git/dirty-worktree';
import { parseFileAgentId, loadFileAgent } from '@/lib/agents/tamtam-file-agents';
import { getAgentMemoryDir, getAgentMemoryPath, readAgentMemory, ensureAgentMemoryDir, buildMemoryBlock } from '@/lib/agents/agent-memory';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { enqueueAgentRun, tryClaimAgentStartSlot, releaseAgentStartSlot, drainNextAgentRun } from '@/lib/agents/pending-agent-run';
import { getSettings } from '@/lib/shared/config';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  // Resolve agent — either a DB row or a file-based agent
  let agent: { id: string; name: string; project: string; skillIds: string; docPaths: string; model: string; prompt: string; schedule: string | null; runner: string; enabled: boolean; provider?: string | null; prerequisiteCommand?: string | null } | null = null;

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
    return NextResponse.json({ code: 'agent_disabled', detail: `Agent '${agent.name}' is disabled — ignoring scheduled trigger` }, { status: 409 });
  }
  if (!agent.schedule && isScheduled) {
    return NextResponse.json({ code: 'no_schedule', detail: `Agent '${agent.name}' has no schedule — ignoring scheduled trigger` }, { status: 409 });
  }

  const body = await request.json();
  const taskPrompt = body.prompt?.trim() ?? '';
  const hasSkills = JSON.parse(agent.skillIds || '[]').length > 0;
  if (!taskPrompt && !hasSkills) {
    return NextResponse.json({ detail: 'agent has no prompt and no skills to run' }, { status: 400 });
  }

  // Block agent runs while a release pipeline holds the project lock.
  // Queue in DB (not in-memory) so the pending run survives a server restart.
  // The lock is released when the pipeline finishes, which drains this queue.
  if (isLockOwnedByActiveRelease(agent.project)) {
    const lock = getLock(agent.project);
    try {
      enqueueQueuedAgentRun(agent.project, {
        project: agent.project,
        agentId: agent.id,
        agentName: agent.name,
        triggeredBy,
        prompt: taskPrompt,
        enqueuedAt: Date.now(),
      });
    } catch (err) {
      console.error('[agent-run-route] failed to persist release-lock queue entry:', err);
      return NextResponse.json(
        { detail: `Failed to queue agent '${agent.name}' while the release pipeline is running` },
        { status: 500 },
      );
    }
    return NextResponse.json(
      {
        status: 'queued',
        code: 'pipeline_lock',
        detail: `Agent '${agent.name}' queued — release pipeline is running for ${agent.project} (job ${lock?.lockedByJobId ?? 'unknown'})`,
        blockingJobId: lock?.lockedByJobId,
        agent: agent.name,
      },
      { status: 202 },
    );
  }

  const blockingJob = await findBlockingRunningJob(
    agent.project,
    (job) => !isAgentJobKind(job.kind),
  );
  if (blockingJob) {
    return NextResponse.json(
      {
        code: 'project_busy',
        detail: `Job '${blockingJob.kind}' is already running for ${agent.project} (job ${blockingJob.id})`,
        blockingJobId: blockingJob.id,
      },
      { status: 409 },
    );
  }

  // Only one agent runs at a time per project — concurrent agents racing on
  // the same git worktree clobber each other's commits and branch state.
  //   - Same agent already running → reject (true duplicate, scheduler retries
  //     on the next tick; queueing would just recurse).
  //   - Different agent running on this project → enqueue this fire and return
  //     202 queued. Drained when the running agent finishes.
  const kindKey = `agent:${agent.name}`;
  const runningAgents = listJobs().filter(
    (j) => j.project === agent.project && isAgentJobKind(j.kind) && j.finishedAt === null
  );
  for (const j of runningAgents) {
    if ((await probeJobStatus(j)) !== 'running') continue;
    if (getJobKind(j.kind) === kindKey) {
      return NextResponse.json(
        { code: 'already_running', detail: `Agent '${agent.name}' is already running (job ${j.id})` },
        { status: 409 }
      );
    }
    enqueueAgentRun(agent.project, {
      agentId: agent.id,
      agentName: agent.name,
      triggeredBy,
      prompt: taskPrompt,
      enqueuedAt: Date.now(),
    });
    return NextResponse.json(
      {
        status: 'queued',
        detail: `Agent '${agent.name}' queued — '${j.kind}' is running for ${agent.project} (job ${j.id})`,
        blockingJobId: j.id,
        agent: agent.name,
      },
      { status: 202 }
    );
  }

  // Closes the TOCTOU between the listJobs check above and createJob below.
  // Concurrent fires would otherwise both observe an empty running-agent
  // list, then both pass through the awaits (issue-branch check, git exec,
  // CLI gate) to createJob, producing two simultaneous agent runs for the
  // same project.
  const slot = tryClaimAgentStartSlot(agent.project, agent.name);
  if (!slot.ok) {
    if (slot.runningAgent === agent.name) {
      return NextResponse.json(
        { code: 'already_starting', detail: `Agent '${agent.name}' is already starting for ${agent.project}` },
        { status: 409 }
      );
    }
    enqueueAgentRun(agent.project, {
      agentId: agent.id,
      agentName: agent.name,
      triggeredBy,
      prompt: taskPrompt,
      enqueuedAt: Date.now(),
    });
    return NextResponse.json(
      {
        status: 'queued',
        detail: `Agent '${agent.name}' queued — '${slot.runningAgent}' is starting for ${agent.project}`,
        agent: agent.name,
      },
      { status: 202 }
    );
  }

  try {
    // A previously-queued release must get first chance to reacquire the lock
    // before any newer agent work starts on the same project. Check only once
    // we know no other agent on the project is running or starting.
    if (getPendingRelease(agent.project)) {
      await drainPendingRelease(agent.project);
      const lock = getLock(agent.project);
      if (isLockOwnedByActiveRelease(agent.project) || getPendingRelease(agent.project)) {
        try {
          enqueueQueuedAgentRun(agent.project, {
            project: agent.project,
            agentId: agent.id,
            agentName: agent.name,
            triggeredBy,
            prompt: taskPrompt,
            enqueuedAt: Date.now(),
          });
        } catch (err) {
          console.error('[agent-run-route] failed to persist pending-release queue entry:', err);
          return NextResponse.json(
            { detail: `Failed to queue agent '${agent.name}' while the pending release is recovering` },
            { status: 500 },
          );
        }
        return NextResponse.json(
          {
            status: 'queued',
            code: lock ? 'pipeline_lock' : 'pending_release',
            detail: lock
              ? `Agent '${agent.name}' queued — release pipeline is running for ${agent.project} (job ${lock.lockedByJobId})`
              : `Agent '${agent.name}' queued — pending release for ${agent.project} will run before new agent work`,
            blockingJobId: lock?.lockedByJobId,
            agent: agent.name,
          },
          { status: 202 },
        );
      }
    }

    // Don't start an agent on top of a large pile of uncommitted changes.
    // Agent edits would tangle with WIP and either get committed by mistake
    // (auto-commit pipelines) or trigger noisy review/fix loops over code the
    // user is mid-refactor. Threshold of 0 disables the gate.
    const settings = getSettings();
    const dirtyThreshold = settings.dirty_worktree_block_threshold;
    if (dirtyThreshold > 0) {
      const projPath = resolveProjectPath(agent.project);
      if (projPath) {
        const dirtyCount = await getDirtyFileCount(projPath);
        if (dirtyCount >= dirtyThreshold) {
          return NextResponse.json(
            {
              code: 'dirty_worktree',
              detail: `Agent '${agent.name}' skipped — ${dirtyCount} uncommitted files exceed threshold (${dirtyThreshold}). Commit, stash, or discard changes first.`,
            },
            { status: 409 },
          );
        }
      }
    }

    const result = await runAgentStart(agent, taskPrompt, triggeredBy);
    return result.response;
  } finally {
    releaseAgentStartSlot(agent.project);
    // Always re-check the queue after releasing the synchronous start slot.
    // Fast-finishing agents can complete and trigger a lifecycle drain before
    // this route unwinds; that drain now no-ops while the slot is held, so the
    // post-release route drain is the handoff that guarantees queued work
    // keeps moving whether startup succeeded or failed.
    await drainNextAgentRun(agent.project);
  }
}

const PREREQUISITE_TIMEOUT_MS = 10 * 60 * 1000;
const PREREQUISITE_OUTPUT_MAX = 64 * 1024;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[…truncated ${s.length - max} bytes]`;
}

async function runAgentStart(
  agent: { id: string; name: string; project: string; skillIds: string; docPaths: string; model: string; prompt: string; schedule: string | null; runner: string; enabled: boolean; provider?: string | null; prerequisiteCommand?: string | null },
  taskPrompt: string,
  triggeredBy: string,
): Promise<{ response: NextResponse; startedJob: boolean }> {

  const projPath = resolveProjectPath(agent.project);
  if (!projPath) {
    return {
      response: NextResponse.json({ detail: `project '${agent.project}' not found` }, { status: 404 }),
      startedJob: false,
    };
  }

  // In Direct Branch mode, block agent runs while a fix/issue-* branch is
  // checked out. Scheduled agents committing to an issue branch would mix
  // unrelated work into the issue and push to the wrong branch.
  const blockedBranch = await checkIssueBranchBlock(agent.project, projPath);
  if (blockedBranch) {
    return {
      response: NextResponse.json(
        { code: 'issue_branch', detail: `Cannot run agent in Direct Branch mode while on issue branch '${blockedBranch}' — finish or abandon issue work first`, branch: blockedBranch },
        { status: 409 }
      ),
      startedJob: false,
    };
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
  const reportContract = `## TamTam Run Report

At the end of your run, include a short final section exactly named "TamTam Run Report" with:
- Summary: one sentence describing what happened
- Files changed: comma-separated repo-relative paths, or "none"
- Actionable work: "yes" or "no"
- Schedule recommendation: optional; only suggest a less frequent schedule when this run found no actionable work`;
  const [headR, statusR] = await Promise.all([
    exec('git', ['-C', projPath, 'rev-parse', 'HEAD'], { timeout: 5000 }),
    exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 }),
  ]);

  const requestedModel = agent.model ? normalizeModelInput(agent.model, 'normal') : null;
  const { logDir } = getImproveConfig();
  const gate = await checkCliStartGate('start an agent run', {
    preferred: agent.provider ?? null,
    requestedModel,
    respectJobsPaused: triggeredBy === 'schedule',
  });
  if (!gate.ok) {
    const gateCode =
      gate.status === 409 ? 'jobs_paused' :
      gate.status === 429 ? 'providers_over_budget' :
      undefined;
    return {
      response: NextResponse.json(
        gateCode ? { code: gateCode, detail: gate.detail } : { detail: gate.detail },
        { status: gate.status },
      ),
      startedJob: false,
    };
  }
  const provider = gate.provider;
  const settings = getSettings();
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);

  // Create the job record now so the prerequisite step (run before the
  // agent CLI is spawned) can write its artifact at <logDir>/<jobId>.prereq.txt.
  const initialContextMeta = JSON.stringify({
    skills: metaSkills,
    docs: metaDocs,
    agent: { id: agent.id, name: agent.name, schedule: agent.schedule, triggeredBy },
    baseline: {
      head: headR.exitCode === 0 ? headR.stdout.trim() : null,
      status: statusR.exitCode === 0 ? statusR.stdout : null,
      dirty: statusR.exitCode === 0 ? statusR.stdout.trim().length > 0 : null,
    },
  });
  const job = createJob(agent.project, `agent:${agent.name}`, 0, '', taskPrompt, initialContextMeta, taskPrompt);
  job.provider = provider;
  const logPath = join(logDir, `${job.id}.log`);

  // Run the agent's optional prerequisite shell command before the CLI spawn,
  // capture stdout/stderr to <logDir>/<jobId>.prereq.txt, and prepend a
  // summary block to the system prompt so the agent sees command + duration
  // + exit code + output. We continue regardless of exit code — the agent
  // may need to react to a failing run (e.g. analyze why tests failed).
  let prerequisiteBlock = '';
  let prerequisiteMeta: { command: string; exitCode: number; durationMs: number; artifactPath: string } | null = null;
  const prereqCmd = agent.prerequisiteCommand?.trim();
  if (prereqCmd) {
    const startedAt = Date.now();
    const result = await exec('bash', ['-c', prereqCmd], {
      cwd: projPath,
      timeout: PREREQUISITE_TIMEOUT_MS,
    });
    const durationMs = Date.now() - startedAt;
    const artifactPath = join(logDir, `${job.id}.prereq.txt`);
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const artifactBody =
      `# TamTam prerequisite artifact\n` +
      `command: ${prereqCmd}\n` +
      `exit_code: ${result.exitCode}\n` +
      `duration_ms: ${durationMs}\n` +
      `cwd: ${projPath}\n` +
      `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
    try {
      writeFileSync(/*turbopackIgnore: true*/ artifactPath, artifactBody);
    } catch (e) {
      console.error('[agent-run] failed to write prereq artifact:', errMsg(e));
    }
    const truncatedStdout = truncate(stdout, PREREQUISITE_OUTPUT_MAX);
    const truncatedStderr = truncate(stderr, PREREQUISITE_OUTPUT_MAX);
    prerequisiteBlock =
      `## Prerequisite Output\n` +
      `Command: \`${prereqCmd}\`\n` +
      `Exit code: ${result.exitCode}\n` +
      `Duration: ${durationMs} ms\n` +
      `Artifact: ${artifactPath}\n\n` +
      `--- stdout ---\n${truncatedStdout}\n\n` +
      `--- stderr ---\n${truncatedStderr}`;
    prerequisiteMeta = {
      command: prereqCmd,
      exitCode: result.exitCode,
      durationMs,
      artifactPath,
    };
  }

  const systemPrompt = [...allParts, prerequisiteBlock, reportContract].filter(Boolean).join('\n\n---\n\n');

  if (prerequisiteMeta) {
    try {
      const merged = { ...JSON.parse(initialContextMeta), prerequisite: prerequisiteMeta };
      job.contextMeta = JSON.stringify(merged);
    } catch {
      job.contextMeta = initialContextMeta;
    }
  }

  // Inject agent memory so it can track state across runs.
  const memDir = getAgentMemoryDir();
  ensureAgentMemoryDir(memDir, agent.project);
  const memoryPath = getAgentMemoryPath(memDir, agent.project, agent.name);
  const currentMemory = readAgentMemory(memDir, agent.project, agent.name);
  const memoryBlock = buildMemoryBlock(memoryPath, currentMemory);

  // Build command. We prepend the composed skills directly to the prompt
  // (stdin) rather than using --append-system-prompt, which requires a value
  // argument and would need escaping for multi-line content.
  const modelFlag = requestedModel ? `--model ${requestedModel}` : '';
  const cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose ${getPermissionModeFlag()} ${modelFlag}`;

  const corePrompt = systemPrompt && taskPrompt
    ? `${systemPrompt}\n\n---\n\n${taskPrompt}`
    : (systemPrompt || taskPrompt);
  const fullPrompt = withBasePrompt(`${corePrompt}\n\n---\n\n${memoryBlock}`, { projectPath: projPath, provider });
  job.logPath = logPath;

  try {
    const pid = await startJob(job.id, cmd, fullPrompt, projPath, { env: cliEnv });
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    return {
      response: NextResponse.json({ detail: `Failed to start: ${errMsg(e)}` }, { status: 500 }),
      startedJob: false,
    };
  }

  updateJob(job);

  return {
    response: NextResponse.json({
      status: 'started',
      job_id: job.id,
      pid: job.pid,
      agent: agent.name,
    }),
    startedJob: true,
  };
}
