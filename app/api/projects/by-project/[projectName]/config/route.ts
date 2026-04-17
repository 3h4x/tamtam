import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'fs';
import { join } from 'path';
import { checkAuth } from '@/lib/auth';
import { getImproveConfig, writeProjectFieldYaml, getProjectTestConfig } from '@/lib/scheduling';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/project-data';
import { reloadConfig } from '@/lib/config';
import { installTestSchedule, uninstallTestSchedule, parseTestScheduleToCron } from '@/lib/test-scheduler';

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
  const testCfg = getProjectTestConfig(projectName);

  return NextResponse.json({
    project: projectName,
    test_command: configuredTestCmd ?? '',
    detected_test_command: detectedTestCmd ?? '',
    effective_test_command: configuredTestCmd || detectedTestCmd || '',
    test_cron_enabled: testCfg?.testCronEnabled ?? false,
    test_cron_schedule: testCfg?.testCronSchedule ?? '',
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
  let touched = false;

  if (body.test_command !== undefined) {
    touched = true;
    const value = body.test_command?.trim() || null;
    const ok = writeProjectFieldYaml(projectName, 'test_command', value);
    if (!ok) {
      return NextResponse.json({ detail: `Project '${projectName}' not found` }, { status: 404 });
    }
  }

  if (body.test_cron_schedule !== undefined) {
    touched = true;
    const value = body.test_cron_schedule?.trim() || null;
    if (value) {
      try {
        parseTestScheduleToCron(value);
      } catch (err) {
        return NextResponse.json(
          { detail: err instanceof Error ? err.message : 'invalid schedule' },
          { status: 400 }
        );
      }
    }
    const ok = writeProjectFieldYaml(projectName, 'test_cron_schedule', value);
    if (!ok) {
      return NextResponse.json({ detail: `Project '${projectName}' not found` }, { status: 404 });
    }
  }

  if (body.test_cron_enabled !== undefined) {
    touched = true;
    const value = body.test_cron_enabled ? '1' : '0';
    const ok = writeProjectFieldYaml(projectName, 'test_cron_enabled', value);
    if (!ok) {
      return NextResponse.json({ detail: `Project '${projectName}' not found` }, { status: 404 });
    }
  }

  // If any cron field changed, reconcile the PM2 cron entry.
  if (body.test_cron_schedule !== undefined || body.test_cron_enabled !== undefined) {
    const cfg = getProjectTestConfig(projectName);
    if (cfg && cfg.testCronEnabled && cfg.testCronSchedule) {
      try {
        await installTestSchedule(projectName, cfg.testCronSchedule);
      } catch (err) {
        return NextResponse.json(
          { detail: err instanceof Error ? err.message : 'failed to install schedule' },
          { status: 500 }
        );
      }
    } else {
      await uninstallTestSchedule(projectName);
    }
  }

  if (touched) {
    reloadConfig();
    clearProjectDataCache();
  }

  return NextResponse.json({ status: 'ok' });
}
