import { NextRequest, NextResponse } from 'next/server';
import { writeProjectFieldYaml, getProjectTestConfig, getProjectPushResult, getProjectPipelinePrompts, setProjectQuarantinedTests } from '@/lib/scheduling/scheduling';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { reloadConfig } from '@/lib/shared/config';
import { installTestSchedule, uninstallTestSchedule, parseTestScheduleToCron } from '@/lib/scheduling/test-scheduler';
import { detectTestCommand } from '@/lib/pipeline/start-test';
import { loadFileConfig, writeFileConfig, getBranchContext } from '@/lib/skills/tamtam-file-config';
import { getProjectDailySpendUsd } from '@/lib/pipeline/spend-guard';
import {
  type ConfigResponse,
  CONFIG_TTL_MS,
  configCache,
  configInflight,
  clearConfigCache,
} from '@/lib/shared/project-config-cache';
import { swrGet, swrRefresh, type SwrStore } from '@/lib/shared/swr-cache';

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

function readOptionalPositiveInteger(
  body: Record<string, unknown>,
  field: string,
): number | null | Response {
  const raw = body[field];
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return badRequest(`${field} must be a positive integer`);
  }
  const value = typeof raw === 'number' ? String(raw) : raw.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    return badRequest(`${field} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return badRequest(`${field} must be a positive integer`);
  }
  return parsed;
}

function readOptionalNonNegativeUsd(
  body: Record<string, unknown>,
  field: string,
): number | null | Response {
  const raw = body[field];
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return badRequest(`${field} must be a non-negative number`);
  }
  const value = typeof raw === 'number' ? String(raw) : raw.trim();
  if (!value) return null;
  if (!/^\d+(?:\.\d{1,4})?$/.test(value)) {
    return badRequest(`${field} must be a non-negative number`);
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return badRequest(`${field} must be a non-negative number`);
  }
  return parsed;
}

async function computeConfig(projectName: string, projPath: string): Promise<ConfigResponse> {
  const [detectedTestCmd, testCfg, pushResult, pipelinePrompts] = await Promise.all([
    detectTestCommand(projPath),
    getProjectTestConfig(projectName),
    getProjectPushResult(projectName),
    getProjectPipelinePrompts(projectName),
  ]);
  const fileConfig = loadFileConfig(projPath);
  const branchCtx = getBranchContext(projPath);
  const projectRows = await db.select().from(schema.projects).where(eq(schema.projects.name, projectName)).limit(1);
  const projectRow = projectRows[0] ?? null;

  return {
    project: projectName,
    // File-backed team-contract pipeline values override the DB on read;
    // the remaining pipeline toggles are DB-only so each developer can opt in
    // independently of teammates' .tamtam/config.yml. Legacy
    // `pr_workflow_enabled` is gone; branch-derived push/PR behavior now
    // decides that at runtime.
    test_command: fileConfig?.test_command ?? testCfg?.testCommand ?? '',
    release_timeout_minutes: fileConfig?.release_timeout_minutes ?? null,
    detected_test_command: detectedTestCmd ?? '',
    effective_test_command: fileConfig?.test_command ?? testCfg?.testCommand ?? detectedTestCmd ?? '',
    test_cron_enabled: testCfg?.testCronEnabled ?? false,
    test_cron_schedule: testCfg?.testCronSchedule ?? '',
    quarantined_tests: testCfg?.quarantinedTests ?? [],
    auto_commit_enabled: testCfg?.autoCommitEnabled ?? false,
    auto_push_enabled: testCfg?.autoPushEnabled ?? false,
    auto_pr_merge_enabled: testCfg?.autoPrMergeEnabled ?? false,
    post_merge_watch_minutes: testCfg?.postMergeWatchMinutes ?? 0,
    auto_revert_enabled: testCfg?.autoRevertEnabled ?? false,
    release_after_run: testCfg?.releaseAfterRun ?? false,
    issue_auto_branch: testCfg?.issueAutoBranch ?? true,
    tests_disabled: testCfg?.testsDisabled ?? false,
    review_disabled: testCfg?.reviewDisabled ?? false,
    review_prompt_addendum: pipelinePrompts.reviewPromptAddendum ?? '',
    review_prerequisite_command: fileConfig?.review_prerequisite_command ?? pipelinePrompts.reviewPrerequisiteCommand ?? '',
    fix_prompt_addendum: pipelinePrompts.fixPromptAddendum ?? '',
    website: projectRow?.website ?? '',
    qa_url: projectRow?.qaUrl ?? '',
    dev_server_start_command: projectRow?.devServerStartCommand ?? '',
    dev_server_stop_command: projectRow?.devServerStopCommand ?? '',
    dev_server_ready_url: projectRow?.devServerReadyUrl ?? '',
    daily_spend_cap_usd: projectRow?.dailySpendCapUsd ?? null,
    release_spend_cap_usd: projectRow?.releaseSpendCapUsd ?? null,
    last_24h_spend_usd: await getProjectDailySpendUsd(projectName),
    setup_complete: !!projectRow?.setupComplete,
    setup_state: (() => {
      try {
        return projectRow?.setupState ? JSON.parse(projectRow.setupState) : {};
      } catch {
        return {};
      }
    })(),
    paused: !!projectRow?.paused,
    // Per-project commit style. File-only (team contract); empty string means
    // fall back to the global `commit_style` setting at commit-generation time.
    commit_style: fileConfig?.commit_style ?? '',
    last_push_error: pushResult?.lastPushError ?? null,
    last_push_at: pushResult?.lastPushAt ?? null,
    // Keys whose values currently come from .tamtam/config.yml.
    file_config: fileConfig ? Object.keys(fileConfig) : [],
    // Branch the file config was read from (may differ from working tree on PRs)
    file_config_branch: branchCtx.isDefaultBranch ? branchCtx.currentBranch : branchCtx.defaultBranch,
    file_config_is_default_branch: branchCtx.isDefaultBranch,
    current_branch: branchCtx.currentBranch,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const store: SwrStore<ConfigResponse> = { cache: configCache(), inflight: configInflight() };
  const compute = () => computeConfig(projectName, projPath);

  // A forced refresh (the client's post-mutation refetch) must reflect the
  // just-written state, so it recomputes synchronously and rewarms. Otherwise
  // stale-while-revalidate: return the last value immediately (only the
  // first-ever load per project pays the fs probe + DB reads) and refresh in the
  // background; concurrent mounts single-flight one compute.
  const value = request.headers.get('x-tamtam-refresh') === '1'
    ? await swrRefresh(store, projectName, compute)
    : await swrGet(store, projectName, CONFIG_TTL_MS, compute);
  return NextResponse.json(value);
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

  if (body.release_timeout_minutes !== undefined) {
    const value = readOptionalPositiveInteger(body, 'release_timeout_minutes');
    if (value instanceof Response) return value;
    touched = true;
    fileUpdates.release_timeout_minutes = value;
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

  if (body.quarantined_tests !== undefined) {
    if (!Array.isArray(body.quarantined_tests) || body.quarantined_tests.some((value) => typeof value !== 'string')) {
      return badRequest('quarantined_tests must be an array of strings');
    }
    touched = true;
    const normalized = body.quarantined_tests
      .map((value) => value.trim())
      .filter(Boolean);
    await setProjectQuarantinedTests(projectName, normalized);
  }

  // Workflow flags are intentionally DB-only — each developer opts in
  // independently. We persist to the DB but skip the file write so teammates'
  // `.tamtam/config.yml` doesn't change underneath them.
  const booleanFields = [
    'test_cron_enabled', 'auto_commit_enabled', 'auto_push_enabled',
    'auto_pr_merge_enabled', 'auto_revert_enabled', 'release_after_run',
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

  // Soak window minutes — 0 disables the watcher, positive integers enable.
  if (body.post_merge_watch_minutes !== undefined) {
    const raw = body.post_merge_watch_minutes;
    let parsed: number | null = null;
    if (typeof raw === 'number' && Number.isFinite(raw)) parsed = Math.trunc(raw);
    else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed === '') parsed = 0;
      else if (/^\d+$/.test(trimmed)) parsed = Number.parseInt(trimmed, 10);
    }
    if (parsed === null || parsed < 0) {
      return badRequest('post_merge_watch_minutes must be a non-negative integer');
    }
    touched = true;
    dbUpdates.push({ field: 'post_merge_watch_minutes', value: String(parsed) });
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
  const promptFields = ['review_prompt_addendum', 'review_prerequisite_command', 'fix_prompt_addendum'] as const;
  for (const field of promptFields) {
    if (body[field] !== undefined) {
      const value = readOptionalTrimmedString(body, field);
      if (value instanceof Response) return value;
      touched = true;
      dbUpdates.push({ field, value });
    }
  }

  // Dev server lifecycle commands — DB-only. Each developer can pick a
  // different dev port / runner without affecting teammates.
  // dev_server_ready_url is validated as a URL when non-empty.
  const devServerCmdFields = ['dev_server_start_command', 'dev_server_stop_command'] as const;
  for (const field of devServerCmdFields) {
    if (body[field] !== undefined) {
      const value = readOptionalTrimmedString(body, field);
      if (value instanceof Response) return value;
      touched = true;
      dbUpdates.push({ field, value });
    }
  }
  if (body.dev_server_ready_url !== undefined) {
    if (typeof body.dev_server_ready_url !== 'string') {
      return badRequest('dev_server_ready_url must be a string URL');
    }
    const raw = body.dev_server_ready_url.trim();
    if (raw) {
      try {
        const u = new URL(raw);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return badRequest('dev_server_ready_url must be http(s)');
        }
      } catch {
        return badRequest('dev_server_ready_url must be a valid URL');
      }
    }
    touched = true;
    dbUpdates.push({ field: 'dev_server_ready_url', value: raw || null });
  }

  for (const field of ['daily_spend_cap_usd', 'release_spend_cap_usd'] as const) {
    if (body[field] === undefined) continue;
    const value = readOptionalNonNegativeUsd(body, field);
    if (value instanceof Response) return value;
    touched = true;
    dbUpdates.push({ field, value: value == null || value === 0 ? null : String(value) });
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

  const writeResults = await Promise.all(
    dbUpdates.map((u) => writeProjectFieldYaml(projectName, u.field, u.value)),
  );
  if (writeResults.some((ok) => !ok)) return notFound();

  // If any cron field changed, reconcile the in-process test schedule.
  if (body.test_cron_schedule !== undefined || body.test_cron_enabled !== undefined) {
    const cfg = await getProjectTestConfig(projectName);
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
    clearConfigCache(projectName);
  }

  return NextResponse.json({ status: 'ok' });
}
