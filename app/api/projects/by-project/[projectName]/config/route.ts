import { NextRequest, NextResponse } from 'next/server';
import { writeProjectFieldYaml, getProjectTestConfig, getProjectPushResult, getProjectPipelinePrompts } from '@/lib/scheduling/scheduling';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { reloadConfig } from '@/lib/shared/config';
import { installTestSchedule, uninstallTestSchedule, parseTestScheduleToCron } from '@/lib/scheduling/test-scheduler';
import { detectTestCommand } from '@/lib/pipeline/start-test';
import { loadFileConfig, writeFileConfig, getBranchContext } from '@/lib/skills/tamtam-file-config';

function badRequest(detail: string) {
  return NextResponse.json({ detail }, { status: 400 });
}

function readOptionalTrimmedString(
  body: Record<string, unknown>,
  field: string,
): string | null | Response {
  if (typeof body[field] !== 'string') {
    return badRequest(`${field} must be a string`);
  }
  const value = body[field].trim();
  return value || null;
}

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
  const pipelinePrompts = getProjectPipelinePrompts(projectName);
  const projectRows = await db.select().from(schema.projects).where(eq(schema.projects.name, projectName)).limit(1);
  const projectRow = projectRows[0] ?? null;

  return NextResponse.json({
    project: projectName,
    // test_command is the only value the file is allowed to override on read;
    // the remaining pipeline toggles are DB-only so each developer can opt in
    // independently of teammates' .tamtam/config.yml. Legacy
    // `pr_workflow_enabled` is gone; branch-derived push/PR behavior now
    // decides that at runtime.
    test_command: fileConfig?.test_command ?? testCfg?.testCommand ?? '',
    detected_test_command: detectedTestCmd ?? '',
    effective_test_command: fileConfig?.test_command ?? testCfg?.testCommand ?? detectedTestCmd ?? '',
    test_cron_enabled: testCfg?.testCronEnabled ?? false,
    test_cron_schedule: testCfg?.testCronSchedule ?? '',
    auto_commit_enabled: testCfg?.autoCommitEnabled ?? false,
    auto_push_enabled: testCfg?.autoPushEnabled ?? false,
    auto_pr_merge_enabled: testCfg?.autoPrMergeEnabled ?? false,
    release_after_run: testCfg?.releaseAfterRun ?? false,
    issue_auto_branch: testCfg?.issueAutoBranch ?? true,
    tests_disabled: testCfg?.testsDisabled ?? false,
    review_disabled: testCfg?.reviewDisabled ?? false,
    review_prompt_addendum: pipelinePrompts.reviewPromptAddendum ?? '',
    fix_prompt_addendum: pipelinePrompts.fixPromptAddendum ?? '',
    website: projectRow?.website ?? '',
    qa_url: projectRow?.qaUrl ?? '',
    paused: !!projectRow?.paused,
    // Per-project commit style. File-only (team contract); empty string means
    // fall back to the global `commit_style` setting at commit-generation time.
    commit_style: fileConfig?.commit_style ?? '',
    last_push_error: pushResult?.lastPushError ?? null,
    last_push_at: pushResult?.lastPushAt ?? null,
    // Keys whose values currently come from .tamtam/config.yml — limited to the
    // team-contract surface (test_command, custom_actions, safe_users).
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

  const body = await request.json() as Record<string, unknown>;
  let touched = false;
  const notFound = () =>
    NextResponse.json({ detail: `Project '${projectName}' not found` }, { status: 404 });

  // Collect all changes for a single file write
  const fileUpdates: Parameters<typeof writeFileConfig>[1] = {};
  const dbUpdates: { field: string; value: string | null }[] = [];

  // test_command is the team contract — write it to BOTH the DB (for cache
  // performance) and `.tamtam/config.yml` (so teammates pick it up on pull).
  if (body.test_command !== undefined) {
    const value = readOptionalTrimmedString(body, 'test_command');
    if (value instanceof Response) return value;
    touched = true;
    dbUpdates.push({ field: 'test_command', value });
    fileUpdates.test_command = value;
  }

  // commit_style is file-only (team contract). No DB column — every read goes
  // through loadFileConfig at commit-generation time so a checkout swap picks
  // up the new style immediately.
  if (body.commit_style !== undefined) {
    const value = readOptionalTrimmedString(body, 'commit_style');
    if (value instanceof Response) return value;
    touched = true;
    fileUpdates.commit_style = value;
  }

  if (body.test_cron_schedule !== undefined) {
    const value = readOptionalTrimmedString(body, 'test_cron_schedule');
    if (value instanceof Response) return value;
    touched = true;
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
    dbUpdates.push({ field: 'test_cron_schedule', value });
  }

  // Workflow flags are intentionally DB-only — each developer opts in
  // independently. We persist to the DB but skip the file write so teammates'
  // `.tamtam/config.yml` doesn't change underneath them.
  const booleanFields = [
    'test_cron_enabled', 'auto_commit_enabled', 'auto_push_enabled',
    'auto_pr_merge_enabled', 'release_after_run',
    'tests_disabled', 'review_disabled', 'issue_auto_branch',
  ] as const;

  for (const field of booleanFields) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'boolean') {
        return badRequest(`${field} must be a boolean`);
      }
      touched = true;
      dbUpdates.push({ field, value: body[field] ? '1' : '0' });
    }
  }

  // Per-project website URL the QA agent browses. DB-only metadata.
  // `website` = public/production URL. `qa_url` = explicit QA target that
  // takes precedence (e.g. a locally-spun docker stack on localhost:1338).
  // The QA skill reads qa_url first, falls back to website, stops if both
  // are empty.
  for (const field of ['website', 'qa_url'] as const) {
    if (body[field] === undefined) continue;
    touched = true;
    if (typeof body[field] !== 'string') {
      return NextResponse.json({ detail: `${field} must be a string URL` }, { status: 400 });
    }
    const raw = (body[field] as string).trim();
    if (raw) {
      try {
        const u = new URL(raw);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return NextResponse.json({ detail: `${field} must be http(s)` }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ detail: `${field} must be a valid URL` }, { status: 400 });
      }
    }
    dbUpdates.push({ field, value: raw || null });
  }

  // Pipeline prompt addenda — DB-only. Each developer tunes locally; not
  // synced to .tamtam/config.yml.
  const promptFields = ['review_prompt_addendum', 'fix_prompt_addendum'] as const;
  for (const field of promptFields) {
    if (body[field] !== undefined) {
      const value = readOptionalTrimmedString(body, field);
      if (value instanceof Response) return value;
      touched = true;
      dbUpdates.push({ field, value });
    }
  }

  // Write file-backed fields before DB-backed fields so a .tamtam/config.yml
  // failure cannot leave a mixed PATCH partially applied in the DB.
  if (Object.keys(fileUpdates).length > 0) {
    try {
      writeFileConfig(projPath, fileUpdates);
    } catch (err) {
      console.error('Failed to write .tamtam/config.yml', err);
      return NextResponse.json(
        { detail: 'failed to write .tamtam/config.yml' },
        { status: 500 }
      );
    }
  }

  for (const update of dbUpdates) {
    if (!writeProjectFieldYaml(projectName, update.field, update.value)) return notFound();
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
