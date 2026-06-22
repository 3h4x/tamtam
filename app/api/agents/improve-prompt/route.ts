import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { getSettings, getPermissionModeFlag } from '@/lib/shared/config';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { composeAgentSkills } from '@/lib/agents/compose-skills';
import { WAND_PRIMER } from '@/lib/agents/wand-primer';
import { errMsg } from '@/lib/shared/types';
import { buildChildEnv } from '@/lib/shared/child-env';
import { loadRecentRunOutcomes, formatRunFeedbackBlock } from '@/lib/agents/run-feedback';

const IMPROVE_TIMEOUT_MS = 120_000;
const IMPROVE_KILL_GRACE_MS = 5_000;
const MAX_DRAFT_BYTES = 32 * 1024;

function readClaudeMd(projPath: string): string | null {
  const p = join(projPath, 'CLAUDE.md');
  // No existsSync precheck — readFileSync throws ENOENT and the catch handles
  // it identically. One fewer syscall, no TOCTOU between check and read.
  try {
    return readFileSync(/*turbopackIgnore: true*/ p, 'utf-8');
  } catch {
    return null;
  }
}

function stripFences(s: string): string {
  let out = s.trim();
  // Drop a single leading ```<lang>\n and matching trailing ``` if Claude wraps
  // the rewritten prompt in a code fence despite being told not to.
  const fence = out.match(/^```(?:[a-zA-Z0-9_-]*)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) out = fence[1].trim();
  return out;
}

function splitPermissionArgs(permissionFlag: string): string[] {
  return permissionFlag.trim().split(/\s+/).filter(Boolean);
}

async function runClaudePrint(
  binary: string,
  promptStdin: string,
  env: Record<string, string>,
  permissionFlag: string,
  modelTier: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const args = ['--print', '--model', modelTier];
    args.push(...splitPermissionArgs(permissionFlag));
    const child = spawn(binary, args, {
      env: buildChildEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const readOutput = () => ({
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    });
    const finish = (result: { stdout: string; stderr: string; exitCode: number }, clearKillTimer = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (clearKillTimer && killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, IMPROVE_KILL_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      const { stdout, stderr } = readOutput();
      finish({
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}claude timed out after ${IMPROVE_TIMEOUT_MS}ms`,
        exitCode: 124,
      }, false);
    }, IMPROVE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const stdin = child.stdin;
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdin || !stdoutStream || !stderrStream) {
      const { stdout } = readOutput();
      finish({
        stdout,
        stderr: 'failed to open claude stdio pipes',
        exitCode: -1,
      });
      return;
    }
    stdoutStream.on('data', (chunk) => { stdoutChunks.push(Buffer.from(chunk)); });
    stderrStream.on('data', (chunk) => { stderrChunks.push(Buffer.from(chunk)); });
    child.on('error', (err) => {
      const { stdout, stderr } = readOutput();
      finish({ stdout, stderr: stderr + '\n' + (err?.message ?? String(err)), exitCode: -1 });
    });
    child.on('close', (code) => {
      const { stdout, stderr } = readOutput();
      finish({ stdout, stderr, exitCode: code ?? -1 });
    });
    try {
      stdin.write(promptStdin);
      stdin.end();
    } catch {
      if (!settled) {
        // child died before stdin write — close handler should resolve
      }
    }
  });
}

export async function POST(request: NextRequest) {
  let body: { project?: string; draftPrompt?: string; skillIds?: string[]; docPaths?: string[]; agentId?: string; agentName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: 'invalid JSON body' }, { status: 400 });
  }

  const project = (body.project || '').trim();
  const draftPrompt = (body.draftPrompt || '').trim();
  const skillIds = Array.isArray(body.skillIds) ? body.skillIds.filter((s): s is string => typeof s === 'string') : [];
  const docPaths = Array.isArray(body.docPaths) ? body.docPaths.filter((s): s is string => typeof s === 'string') : [];
  const agentId = typeof body.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : null;
  const agentName = typeof body.agentName === 'string' && body.agentName.trim() ? body.agentName.trim() : null;

  if (!project) return NextResponse.json({ detail: 'project is required' }, { status: 400 });
  if (!draftPrompt) return NextResponse.json({ detail: 'draftPrompt is required' }, { status: 400 });
  if (Buffer.byteLength(draftPrompt, 'utf8') > MAX_DRAFT_BYTES) {
    return NextResponse.json({ detail: `draftPrompt exceeds ${MAX_DRAFT_BYTES} bytes` }, { status: 413 });
  }

  const projPath = resolveProjectPath(project);
  if (!projPath) return NextResponse.json({ detail: `project '${project}' not found` }, { status: 404 });

  const gate = await checkCliStartGate('improve agent prompt', {
    preferred: null,
    requestedModel: 'fast',
    respectJobsPaused: false,
  });
  if (!gate.ok) {
    const code = gate.status === 429 ? 'providers_over_budget' : undefined;
    return NextResponse.json(
      code ? { code, detail: gate.detail } : { detail: gate.detail },
      { status: gate.status },
    );
  }

  const settings = getSettings();
  const claudeBin = resolveCliBin(gate.provider, settings);
  const cliEnv = resolveCliEnv(gate.provider, settings);

  // Compose context: TamTam primer + CLAUDE.md + selected skills + selected docs.
  const composed = await composeAgentSkills(projPath, skillIds, docPaths);
  const claudeMd = readClaudeMd(projPath);
  const contextSections: string[] = [WAND_PRIMER];
  if (claudeMd) contextSections.push(`## Project CLAUDE.md\n${claudeMd}`);
  contextSections.push(...composed.docParts);
  contextSections.push(...composed.parts);

  // When improving an existing agent, fold in its recent run outcomes so the
  // rewrite can target *why* the agent has been unproductive rather than just
  // polishing prose. Best-effort: a DB hiccup here must not block the rewrite.
  if (agentId || agentName) {
    try {
      const outcomes = await loadRecentRunOutcomes({ project, agentId, agentName });
      const feedback = formatRunFeedbackBlock(outcomes);
      if (feedback) contextSections.push(feedback);
    } catch (e) {
      console.error('[improve-prompt] failed to load run feedback:', errMsg(e));
    }
  }

  const metaInstruction = `You are rewriting a TamTam agent prompt. Read the project context and the agent's selected skills/docs above, then rewrite the user's draft below into a precise, concrete prompt that this agent will execute.

Output ONLY the rewritten prompt — no preamble, no explanation, no markdown fences, no leading "Prompt:" header. Plain text. Keep imperative voice. Do not invent files or commands that the project context does not support.

--- USER DRAFT ---
${draftPrompt}
--- END USER DRAFT ---

Rewritten prompt:`;

  const fullPrompt = [...contextSections, metaInstruction].filter(Boolean).join('\n\n---\n\n');

  try {
    const result = await runClaudePrint(claudeBin, fullPrompt, cliEnv, getPermissionModeFlag(), 'fast');
    if (result.exitCode !== 0) {
      return NextResponse.json(
        { detail: `claude exited ${result.exitCode}: ${result.stderr.slice(0, 500) || result.stdout.slice(0, 500)}` },
        { status: 502 },
      );
    }
    const improvedPrompt = stripFences(result.stdout);
    if (!improvedPrompt) {
      return NextResponse.json({ detail: 'claude returned empty output' }, { status: 502 });
    }
    return NextResponse.json({ improvedPrompt });
  } catch (e) {
    return NextResponse.json({ detail: `Failed to invoke claude: ${errMsg(e)}` }, { status: 500 });
  }
}
