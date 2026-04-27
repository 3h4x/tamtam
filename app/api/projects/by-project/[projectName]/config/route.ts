import { NextRequest, NextResponse } from 'next/server';
import { writeProjectFieldYaml, getProjectTestConfig, getProjectPushResult } from '@/lib/scheduling';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/project-data';
import { reloadConfig } from '@/lib/config';
import { installTestSchedule, uninstallTestSchedule, parseTestScheduleToCron } from '@/lib/test-scheduler';
import { detectTestCommand } from '@/lib/start-test';
import { loadFileConfig, writeFileConfig, getBranchContext } from '@/lib/tamtam-file-config';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const detectedTestCmd = detectTestCommand(projPath);
  const testCfg = getProjectTestConfig(projectName);
  const pushResult = getProjectPushResult(projectName);
  const fileConfig = loadFileConfig(projPath);
  const branchCtx = getBranchContext(projPath);

  return NextResponse.json({
    project: projectName,
    test_command: fileConfig?.test_command ?? testCfg?.testCommand ?? '',
    detected_test_command: detectedTestCmd ?? '',
    effective_test_command: fileConfig?.test_command ?? testCfg?.testCommand ?? detectedTestCmd ?? '',
    test_cron_enabled: fileConfig?.test_cron_enabled ?? testCfg?.testCronEnabled ?? false,
    test_cron_schedule: fileConfig?.test_cron_schedule ?? testCfg?.testCronSchedule ?? '',
    auto_commit_enabled: fileConfig?.auto_commit_enabled ?? testCfg?.autoCommitEnabled ?? false,
    auto_push_enabled: fileConfig?.auto_push_enabled ?? testCfg?.autoPushEnabled ?? false,
    auto_pr_merge_enabled: fileConfig?.auto_pr_merge_enabled ?? testCfg?.autoPrMergeEnabled ?? false,
    release_after_run: fileConfig?.release_after_run ?? testCfg?.releaseAfterRun ?? false,
    pr_workflow_enabled: fileConfig?.pr_workflow_enabled ?? testCfg?.prWorkflowEnabled ?? false,
    issue_auto_branch: fileConfig?.issue_auto_branch ?? testCfg?.issueAutoBranch ?? true,
    tests_disabled: fileConfig?.tests_disabled ?? testCfg?.testsDisabled ?? false,
    review_disabled: fileConfig?.review_disabled ?? testCfg?.reviewDisabled ?? false,
    last_push_error: pushResult?.lastPushError ?? null,
    last_push_at: pushResult?.lastPushAt ?? null,
    // Keys whose values currently come from .tamtam/config.yml
    file_config: fileConfig ? Object.keys(fileConfig) : [],
    // Branch the file config was read from (may differ from working tree on PRs)
    file_config_branch: branchCtx.isDefaultBranch ? branchCtx.currentBranch : branchCtx.defaultBranch,
    file_config_is_default_branch: branchCtx.isDefaultBranch,
    current_branch: branchCtx.currentBranch,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: `Project '${projectName}' not found` }, { status: 404 });
  }

  const body = await request.json();
  let touched = false;
  const notFound = () =>
    NextResponse.json({ detail: `Project '${projectName}' not found` }, { status: 404 });

  // Collect all changes for a single file write
  const fileUpdates: Parameters<typeof writeFileConfig>[1] = {};

  if (body.test_command !== undefined) {
    touched = true;
    const value = body.test_command?.trim() || null;
    if (!writeProjectFieldYaml(projectName, 'test_command', value)) return notFound();
    fileUpdates.test_command = value;
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
    fileUpdates.test_cron_schedule = value;
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
      fileUpdates[field] = !!body[field];
    }
  }

  // Write all changed fields to .tamtam/config.yml in one pass
  if (Object.keys(fileUpdates).length > 0) {
    try {
      writeFileConfig(projPath, fileUpdates);
    } catch {
      // Non-fatal: DB write already succeeded, file write is best-effort
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
