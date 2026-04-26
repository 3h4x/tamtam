import { NextRequest, NextResponse } from 'next/server';
import { getImproveConfig, writeProjectFieldYaml, getProjectTestConfig, getProjectPushResult } from '@/lib/scheduling';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/project-data';
import { reloadConfig } from '@/lib/config';
import { installTestSchedule, uninstallTestSchedule, parseTestScheduleToCron } from '@/lib/test-scheduler';
import { detectTestCommand } from '@/lib/start-test';
import { loadFileConfig } from '@/lib/tamtam-file-config';

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
  const pushResult = getProjectPushResult(projectName);
  const fileConfig = loadFileConfig(projPath);

  return NextResponse.json({
    project: projectName,
    test_command: fileConfig?.test_command ?? configuredTestCmd ?? '',
    detected_test_command: detectedTestCmd ?? '',
    effective_test_command: fileConfig?.test_command ?? configuredTestCmd ?? detectedTestCmd ?? '',
    test_cron_enabled: testCfg?.testCronEnabled ?? false,
    test_cron_schedule: testCfg?.testCronSchedule ?? '',
    auto_commit_enabled: fileConfig?.auto_commit_enabled ?? testCfg?.autoCommitEnabled ?? false,
    auto_push_enabled: fileConfig?.auto_push_enabled ?? testCfg?.autoPushEnabled ?? false,
    auto_pr_merge_enabled: fileConfig?.auto_pr_merge_enabled ?? testCfg?.autoPrMergeEnabled ?? false,
    release_after_run: testCfg?.releaseAfterRun ?? false,
    pr_workflow_enabled: fileConfig?.pr_workflow_enabled ?? testCfg?.prWorkflowEnabled ?? false,
    issue_auto_branch: fileConfig?.issue_auto_branch ?? testCfg?.issueAutoBranch ?? true,
    tests_disabled: fileConfig?.tests_disabled ?? testCfg?.testsDisabled ?? false,
    review_disabled: fileConfig?.review_disabled ?? testCfg?.reviewDisabled ?? false,
    last_push_error: pushResult?.lastPushError ?? null,
    last_push_at: pushResult?.lastPushAt ?? null,
    file_config: fileConfig ? Object.keys(fileConfig) : [],
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json();
  let touched = false;
  const notFound = () =>
    NextResponse.json({ detail: `Project '${projectName}' not found` }, { status: 404 });

  if (body.test_command !== undefined) {
    touched = true;
    const value = body.test_command?.trim() || null;
    if (!writeProjectFieldYaml(projectName, 'test_command', value)) return notFound();
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
    if (!writeProjectFieldYaml(projectName, 'test_cron_schedule', value)) return notFound();
  }

  const booleanFields = [
    'test_cron_enabled', 'auto_commit_enabled', 'auto_push_enabled',
    'auto_pr_merge_enabled', 'release_after_run', 'pr_workflow_enabled',
    'tests_disabled', 'review_disabled', 'issue_auto_branch',
  ] as const;

  for (const field of booleanFields) {
    if (body[field] !== undefined) {
      touched = true;
      if (!writeProjectFieldYaml(projectName, field, body[field] ? '1' : '0')) return notFound();
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
