import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'fs';
import { join } from 'path';
import { checkAuth } from '@/lib/auth';
import { getImproveConfig, writeProjectFieldYaml } from '@/lib/scheduling';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/project-data';
import { reloadConfig } from '@/lib/config';

function detectTestCommand(projPath: string, projectName?: string): string | null {
  if (projectName) {
    const { projects } = getImproveConfig();
    for (const cfg of Object.values(projects)) {
      if (cfg.project === projectName && cfg.test_command) return cfg.test_command;
    }
  }
  if (existsSync(join(projPath, 'pyproject.toml')) || existsSync(join(projPath, 'requirements.txt'))) {
    return 'python -m pytest';
  }
  const pkgJson = join(projPath, 'package.json');
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(require('fs').readFileSync(pkgJson, 'utf-8'));
      if (pkg.scripts?.test) {
        return existsSync(join(projPath, 'pnpm-lock.yaml')) ? 'pnpm test' : 'npm test';
      }
    } catch {}
  }
  if (existsSync(join(projPath, 'foundry.toml'))) return 'forge test';
  return null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const { projects } = getImproveConfig();
  let configuredTestCmd: string | null = null;
  for (const cfg of Object.values(projects)) {
    if (cfg.project === projectName) {
      configuredTestCmd = cfg.test_command;
      break;
    }
  }
  const detectedTestCmd = detectTestCommand(projPath);

  return NextResponse.json({
    project: projectName,
    test_command: configuredTestCmd ?? '',
    detected_test_command: detectedTestCmd ?? '',
    effective_test_command: configuredTestCmd || detectedTestCmd || '',
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { projectName } = await params;
  const body = await request.json();

  if (body.test_command !== undefined) {
    const value = body.test_command?.trim() || null;
    const ok = writeProjectFieldYaml(projectName, 'test_command', value);
    if (!ok) {
      return NextResponse.json({ detail: `Project '${projectName}' not found` }, { status: 404 });
    }
    reloadConfig();
    clearProjectDataCache();
  }

  return NextResponse.json({ status: 'ok' });
}
