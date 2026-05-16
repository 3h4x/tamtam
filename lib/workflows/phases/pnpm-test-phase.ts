// Plain test phase workflow. Runs the project's detected test command
// directly via exec (no Claude agent) and writes the output to a job log
// for the orchestrator + fix phase to consume. Replaces the
// `releaseTestPhaseWorkflow` Claude-driven test step when
// `plain_test_phase_enabled` is on.
//
// Trade-off vs the Claude-driven phase:
//   + ~0 token cost, deterministic, fast
//   - no written summary of failures (the fix phase already reads the
//     test job's log so it still has the raw output to work from)
//
// Failure-analysis polish (spawn a cheap-model analyze agent on non-zero
// exit) is a planned follow-up; the raw log alone is sufficient for fix.

export interface PnpmTestPhaseResult {
  ok: boolean;
  jobId: string | null;
  exitCode: number | null;
  reason: 'finished' | 'start_failed' | 'no_command';
  detail?: string;
}

export async function pnpmTestPhaseWorkflow(
  projectName: string,
  releaseJobId?: string,
): Promise<PnpmTestPhaseResult> {
  'use workflow';
  const result = await runPlainTestStep(projectName, releaseJobId);
  if (result.ok && result.jobId && releaseJobId) {
    await dispatchOrchestratorTickStep(result.jobId, projectName, releaseJobId);
  }
  return result;
}

async function runPlainTestStep(
  projectName: string,
  releaseJobId?: string,
): Promise<PnpmTestPhaseResult> {
  'use step';
  const { detectTestCommand } = await import('@/lib/pipeline/start-test');
  const { resolveProjectPath } = await import('@/lib/shared/project-data');
  const { exec } = await import('@/lib/shared/shell');
  const { createJob, updateJob, markDone } = await import('@/lib/jobs/job-storage');
  const { getImproveConfig } = await import('@/lib/scheduling/scheduling');
  const { runWithParent } = await import('@/lib/jobs/parent-context');
  const { join } = await import('path');
  const { writeFileSync, mkdirSync, appendFileSync } = await import('fs');

  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return { ok: false, jobId: null, exitCode: null, reason: 'start_failed', detail: `project '${projectName}' not found` };
  }
  const cmd = await detectTestCommand(projPath, projectName);
  if (!cmd) {
    return { ok: false, jobId: null, exitCode: null, reason: 'no_command', detail: 'no test command detected and tests not explicitly disabled' };
  }

  const { logDir } = getImproveConfig();
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  // pid=0 marks this as an in-process inline kind — same convention as
  // mark-dod / pr-wait / commit. probeJobStatus treats pid=0 as "owned by
  // the server" and won't reap it as a dead subprocess.
  const job = releaseJobId
    ? await Promise.resolve(runWithParent(releaseJobId, () => createJob(projectName, 'test', 0, '', cmd, undefined, cmd)))
    : createJob(projectName, 'test', 0, '', cmd, undefined, cmd);
  job.logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  updateJob(job);

  try {
    writeFileSync(/*turbopackIgnore: true*/ job.logPath, `# plain-test phase — ${new Date().toISOString()}\n# $ ${cmd}\n\n`);
  } catch {}

  // Split into argv. The test command is operator-controlled (project
  // config), but `sh -c` lets multi-token forms ("pnpm test --filter foo")
  // work the same way they do in the legacy Claude-driven phase.
  let exitCode = -1;
  try {
    const r = await exec('sh', ['-c', cmd], { cwd: projPath, timeout: 30 * 60 * 1000 });
    exitCode = r.exitCode ?? -1;
    try {
      appendFileSync(/*turbopackIgnore: true*/ job.logPath, r.stdout || '');
      if (r.stderr) appendFileSync(/*turbopackIgnore: true*/ job.logPath, `\n--- stderr ---\n${r.stderr}`);
      appendFileSync(/*turbopackIgnore: true*/ job.logPath, `\n# exit ${exitCode}\n`);
    } catch {}
  } catch (err) {
    try {
      appendFileSync(/*turbopackIgnore: true*/ job.logPath, `\n# exec threw: ${(err as Error).message}\n`);
    } catch {}
  }

  await markDone(job, exitCode);
  return { ok: true, jobId: job.id, exitCode, reason: 'finished' };
}

async function dispatchOrchestratorTickStep(
  jobId: string,
  projectName: string,
  releaseJobId: string,
): Promise<void> {
  'use step';
  const { safeStartOrchestrator } = await import('@/lib/workflows/safe-start-orchestrator');
  await safeStartOrchestrator(jobId, projectName, releaseJobId, 'pnpm-test-phase');
}
