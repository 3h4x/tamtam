import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { existsSync } from 'fs';
import { join } from 'path';
import { db, schema } from '@/lib/db';
import { exec } from '@/lib/shared/shell';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { detectTestCommand } from '@/lib/pipeline/start-test';
import { detectMainBranch } from '@/lib/pipeline/start-commit';
import { writeFileConfig } from '@/lib/skills/tamtam-file-config';
import { getSettings } from '@/lib/shared/config';

const SETUP_STEPS = ['detect', 'pipeline', 'automation', 'notifications', 'file_config', 'smoke_test'] as const;
type SetupStep = (typeof SETUP_STEPS)[number];
type StepStatus = 'completed' | 'skipped';
type SetupState = Partial<Record<SetupStep, StepStatus>>;

function parseSetupState(raw: string | null | undefined): SetupState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state: SetupState = {};
    for (const step of SETUP_STEPS) {
      if (parsed[step] === 'completed' || parsed[step] === 'skipped') state[step] = parsed[step];
    }
    return state;
  } catch {
    return {};
  }
}

function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === 'string' && (SETUP_STEPS as readonly string[]).includes(value);
}

function inferGhRepo(remoteUrl: string | null, projectName: string): string | null {
  if (remoteUrl) {
    let url = remoteUrl.trim();
    if (url.startsWith('git@github.com:')) url = url.slice('git@github.com:'.length);
    else if (url.startsWith('https://github.com/')) url = url.slice('https://github.com/'.length);
    url = url.replace(/\.git$/, '');
    if (url.includes('/')) return url;
  }
  const { github_owner: dbGithubOwner } = getSettings();
  const owner = process.env.GITHUB_OWNER || dbGithubOwner;
  return owner ? `${owner}/${projectName}` : null;
}

async function detectGithubRemote(projPath: string): Promise<{ url: string | null }> {
  const remote = await exec('git', ['-C', projPath, 'remote', 'get-url', 'origin'], { timeout: 5000 });
  const url = remote.exitCode === 0 ? remote.stdout.trim() || null : null;
  return { url };
}

async function detectGhAuth(): Promise<{ available: boolean; detail: string | null }> {
  const result = await exec('gh', ['auth', 'status'], { timeout: 5000 });
  return {
    available: result.exitCode === 0,
    detail: result.exitCode === 0 ? null : (result.stderr.trim() || result.stdout.trim() || 'gh auth status failed'),
  };
}

async function detectCiWorkflow(projPath: string): Promise<boolean> {
  const workflowDir = join(projPath, '.github', 'workflows');
  return existsSync(/*turbopackIgnore: true*/ workflowDir);
}

async function loadProjectSetup(projectName: string) {
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.name, projectName)).limit(1);
  return rows[0] ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  const project = await loadProjectSetup(projectName);
  if (!project) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const [detectedTestCommand, defaultBranch, remote, ghAuth, hasCiWorkflow] = await Promise.all([
    detectTestCommand(projPath),
    detectMainBranch(projPath),
    detectGithubRemote(projPath),
    detectGhAuth(),
    detectCiWorkflow(projPath),
  ]);

  return NextResponse.json({
    project: projectName,
    setup_complete: !!project.setupComplete,
    setup_state: parseSetupState(project.setupState),
    detection: {
      test_command: detectedTestCommand ?? '',
      default_branch: defaultBranch,
      github_remote: remote.url,
      github_repo: inferGhRepo(remote.url, projectName),
      gh_auth: ghAuth,
      ci_workflow: hasCiWorkflow,
    },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  const project = await loadProjectSetup(projectName);
  if (!project) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const currentState = parseSetupState(project.setupState);
  const nextState: SetupState = { ...currentState };
  let touched = false;

  if (body.step !== undefined || body.status !== undefined) {
    if (!isSetupStep(body.step)) {
      return NextResponse.json({ detail: 'step must be a valid setup step' }, { status: 400 });
    }
    if (body.status !== 'completed' && body.status !== 'skipped') {
      return NextResponse.json({ detail: 'status must be completed or skipped' }, { status: 400 });
    }
    nextState[body.step] = body.status;
    touched = true;
  }

  if (body.write_file_config === true) {
    const updates: Parameters<typeof writeFileConfig>[1] = {};
    if (typeof body.test_command === 'string' && body.test_command.trim()) {
      updates.test_command = body.test_command.trim();
    }
    const safeUsers = Array.isArray(body.safe_users)
      ? body.safe_users.filter((u): u is string => typeof u === 'string' && u.trim().length > 0).map((u) => u.trim())
      : [];
    if (safeUsers.length > 0) {
      updates.safe_users = Array.from(new Set(safeUsers));
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ detail: 'write_file_config requires test_command or safe_users' }, { status: 400 });
    }
    writeFileConfig(projPath, updates);
    nextState.file_config = 'completed';
    touched = true;
  }

  let setupComplete = project.setupComplete;
  if (body.setup_complete !== undefined) {
    if (typeof body.setup_complete !== 'boolean') {
      return NextResponse.json({ detail: 'setup_complete must be a boolean' }, { status: 400 });
    }
    setupComplete = body.setup_complete;
    if (setupComplete) {
      for (const step of SETUP_STEPS) {
        nextState[step] = nextState[step] ?? 'skipped';
      }
    }
    touched = true;
  }

  if (!touched) return NextResponse.json({ detail: 'no setup changes provided' }, { status: 400 });

  await db.update(schema.projects)
    .set({ setupComplete, setupState: JSON.stringify(nextState) })
    .where(eq(schema.projects.name, projectName));
  clearProjectDataCache();

  return NextResponse.json({
    status: 'ok',
    project: projectName,
    setup_complete: setupComplete,
    setup_state: nextState,
  });
}
